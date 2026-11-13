//! Real pinned updater HTTP and signature verification, without install or UI.
//! The public vectors use a disposable test key, never the production identity.

use serde::Deserialize;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Write},
    net::{SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{
    test::{mock_builder, mock_context, noop_assets},
    Manager,
};
use tauri_plugin_updater::{Error, UpdaterExt};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    payload: String,
    public_key: String,
    other_public_key: String,
    unversioned_signature: String,
    versioned_signature: String,
}

struct Server {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    manifest_reads: Arc<AtomicUsize>,
    payload_reads: Arc<AtomicUsize>,
    task: Option<JoinHandle<()>>,
}

impl Server {
    fn start(version: &str, signature: &str, payload: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let metadata = json!({
            "version": version,
            "platforms": {"windows-x86_64-nsis": {
                "url": format!("http://{address}/payload"), "signature": signature
            }}
        })
        .to_string()
        .into_bytes();
        let stop = Arc::new(AtomicBool::new(false));
        let manifest_reads = Arc::new(AtomicUsize::new(0));
        let payload_reads = Arc::new(AtomicUsize::new(0));
        let (stop_task, manifest_task, payload_task) =
            (stop.clone(), manifest_reads.clone(), payload_reads.clone());
        let task = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            while !stop_task.load(Ordering::SeqCst) {
                assert!(Instant::now() < deadline, "fixture server deadline elapsed");
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut request = String::new();
                assert!(reader.read_line(&mut request).unwrap() > 0);
                let path = request.split_whitespace().nth(1).unwrap().to_owned();
                let mut header_bytes = request.len();
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    header_bytes += line.len();
                    assert!(header_bytes < 16 * 1024);
                    if line == "\r\n" {
                        break;
                    }
                }
                let body = match path.as_str() {
                    "/manifest" => {
                        manifest_task.fetch_add(1, Ordering::SeqCst);
                        &metadata
                    }
                    "/payload" => {
                        payload_task.fetch_add(1, Ordering::SeqCst);
                        &payload
                    }
                    _ => panic!("unexpected fixture route"),
                };
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                socket.write_all(body).unwrap();
            }
        });
        Self {
            address,
            stop,
            manifest_reads,
            payload_reads,
            task: Some(task),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(task) = self.task.take() {
            let result = task.join();
            if !thread::panicking() {
                result.expect("fixture server failed");
            }
        }
    }
}

#[test]
fn smoke_pinned_updater_signed_version_migration_over_real_http() {
    let vectors: Vectors =
        serde_json::from_str(include_str!("fixtures/updater-public-vectors.json")).unwrap();
    let production: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_ne!(
        production["plugins"]["updater"]["pubkey"],
        vectors.public_key
    );

    for (name, strict, signature, announced, payload, key) in [
        (
            "legacy compatibility",
            false,
            &vectors.unversioned_signature,
            "2.0.0",
            vectors.payload.as_bytes(),
            &vectors.public_key,
        ),
        (
            "legacy strict refusal",
            true,
            &vectors.unversioned_signature,
            "2.0.0",
            vectors.payload.as_bytes(),
            &vectors.public_key,
        ),
        (
            "versioned strict success",
            true,
            &vectors.versioned_signature,
            "2.0.0",
            vectors.payload.as_bytes(),
            &vectors.public_key,
        ),
        (
            "announced version mismatch",
            false,
            &vectors.versioned_signature,
            "3.0.0",
            vectors.payload.as_bytes(),
            &vectors.public_key,
        ),
        (
            "payload tampering",
            true,
            &vectors.versioned_signature,
            "2.0.0",
            b"tampered".as_slice(),
            &vectors.public_key,
        ),
        (
            "different key",
            true,
            &vectors.versioned_signature,
            "2.0.0",
            vectors.payload.as_bytes(),
            &vectors.other_public_key,
        ),
    ] {
        let server = Server::start(announced, signature, payload.to_vec());
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({
                "pubkey": key, "requireSignedVersion": strict,
                "endpoints": [format!("http://{}/manifest", server.address)],
                "dangerousInsecureTransportProtocol": true
            }),
        );
        // MockRuntime has no OS window/event-loop. No install/extract method is called.
        let app = mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        assert!(app.webview_windows().is_empty());
        let updater = app
            .updater_builder()
            .target("windows-x86_64-nsis")
            .timeout(Duration::from_secs(5))
            .no_proxy()
            .build()
            .unwrap();
        let mut update = tauri::async_runtime::block_on(updater.check())
            .unwrap()
            .unwrap();
        assert_eq!(update.version, announced);
        update.timeout = Some(Duration::from_secs(5));
        let mut received = 0;
        let result =
            tauri::async_runtime::block_on(update.download(|size, _| received += size, || {}));
        assert_eq!(received, payload.len(), "{name}: payload path not reached");
        assert_eq!(server.manifest_reads.load(Ordering::SeqCst), 1, "{name}");
        assert_eq!(server.payload_reads.load(Ordering::SeqCst), 1, "{name}");
        match name {
            "legacy compatibility" => {
                assert_eq!(result.unwrap(), vectors.payload.as_bytes());
                let mut cached = update.raw_json.clone();
                cached["config"] = json!({"requireSignedVersion": false});
                let restored = updater.restore_update(cached).unwrap().unwrap();
                assert!(matches!(
                    restored.verify(payload),
                    Err(Error::MissingSignedVersion)
                ));
            }
            "versioned strict success" => {
                assert_eq!(result.unwrap(), vectors.payload.as_bytes());
                let mut cached = update.raw_json.clone();
                cached["config"] = json!({"pubkey": vectors.other_public_key});
                cached["extract_path"] = json!("untrusted-path-must-not-be-used");
                updater
                    .restore_update(cached)
                    .unwrap()
                    .unwrap()
                    .verify(payload)
                    .unwrap();
            }
            "legacy strict refusal" => assert!(
                matches!(result, Err(Error::MissingSignedVersion)),
                "{name}: {result:?}"
            ),
            "announced version mismatch" => assert!(
                matches!(result, Err(Error::SignedVersionMismatch { .. })),
                "{name}: {result:?}"
            ),
            "payload tampering" | "different key" => assert!(
                matches!(result, Err(Error::Minisign(_))),
                "{name}: {result:?}"
            ),
            _ => unreachable!(),
        }
    }
}
