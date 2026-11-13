//! Real pinned updater HTTP and signature verification, without install or UI.
//! The public vectors use a disposable test key, never the production identity.

use serde::Deserialize;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
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
    prehashed_public_key: String,
    prehashed_unversioned_signature: String,
    prehashed_versioned_signature: String,
}

struct Server {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    manifest_reads: Arc<AtomicUsize>,
    payload_reads: Arc<AtomicUsize>,
    accepted: Arc<AtomicUsize>,
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
        let accepted = Arc::new(AtomicUsize::new(0));
        let accepted_task = accepted.clone();
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
                // Winsock inherits the listener's nonblocking mode on accept.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                accepted_task.fetch_add(1, Ordering::SeqCst);
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
            accepted,
            task: Some(task),
        }
    }
}

#[test]
fn smoke_updater_http_fixture_accepts_delayed_headers() {
    let server = Server::start("2.0.0", "not-consumed-by-this-fixture-control", vec![1]);
    let mut client = TcpStream::connect(server.address).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    client
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while server.accepted.load(Ordering::SeqCst) == 0 {
        assert!(
            Instant::now() < deadline,
            "fixture never accepted connection"
        );
        thread::sleep(Duration::from_millis(1));
    }
    // Exercise an accepted connection with no bytes ready, then split headers.
    thread::sleep(Duration::from_millis(30));
    client.write_all(b"GET /manifest HTTP/1.1\r\n").unwrap();
    thread::sleep(Duration::from_millis(30));
    client.write_all(b"Host: localhost\r\n\r\n").unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).unwrap();
    assert!(response.starts_with(b"HTTP/1.1 200 OK\r\n"));
    assert_eq!(server.manifest_reads.load(Ordering::SeqCst), 1);
    assert_eq!(server.payload_reads.load(Ordering::SeqCst), 0);
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
    let deployed_key = production["plugins"]["updater"]["pubkey"]
        .as_str()
        .filter(|key| !key.is_empty())
        .expect("deployed updater public key required");
    assert_ne!(deployed_key, vectors.public_key);

    let mut executed = 0;
    for (key, unversioned, versioned) in [
        (
            &vectors.public_key,
            &vectors.unversioned_signature,
            &vectors.versioned_signature,
        ),
        (
            &vectors.prehashed_public_key,
            &vectors.prehashed_unversioned_signature,
            &vectors.prehashed_versioned_signature,
        ),
    ] {
        assert_ne!(deployed_key, key);
        for (name, strict, signature, announced, payload, key) in [
            (
                "legacy compatibility",
                false,
                unversioned,
                "2.0.0",
                vectors.payload.as_bytes(),
                key,
            ),
            (
                "legacy strict refusal",
                true,
                unversioned,
                "2.0.0",
                vectors.payload.as_bytes(),
                key,
            ),
            (
                "versioned strict success",
                true,
                versioned,
                "2.0.0",
                vectors.payload.as_bytes(),
                key,
            ),
            (
                "announced version mismatch",
                false,
                versioned,
                "3.0.0",
                vectors.payload.as_bytes(),
                key,
            ),
            (
                "payload tampering",
                true,
                versioned,
                "2.0.0",
                b"tampered".as_slice(),
                key,
            ),
            (
                "different key",
                true,
                versioned,
                "2.0.0",
                vectors.payload.as_bytes(),
                &vectors.other_public_key,
            ),
        ] {
            executed += 1;
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
    assert_eq!(executed, 12);
}
