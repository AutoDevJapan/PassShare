//! Real executable + real SDK + Core-generated ciphertext over finite loopback
//! HTTP. The fixture validates CAS and preserves the original DTO independently.
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use passshare_connect::{EncryptedItem, OwnerKeyBundle, OwnerKeyContext};
use passshare_core::{cloud_crypto::PasswordBoxKey, crypto};
use serde_json::{json, Value};
use zeroize::Zeroizing;

const BOX: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER: &str = "11111111-1111-4111-8111-111111111111";
const TOKEN: &str = "fixture-session-only-marker";
const FIELD: &str = "fixture-item-only-marker";
const LEGACY_ITEM: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";

struct State {
    password: Zeroizing<String>,
    bundle: OwnerKeyBundle,
    envelope: Option<EncryptedItem>,
    deleted_version: Option<u64>,
    writes: usize,
    puts: usize,
    requests: usize,
    authorized: bool,
    auth_failure: u16,
    write_failure: u16,
    owner_version: u64,
    bundle_version: u64,
    epoch: u64,
    wrong_owner: bool,
    auth_oversized: bool,
    auth_id: String,
    redirects: usize,
    replayed: Option<Value>,
}
struct Server {
    password: Zeroizing<String>,
    host: String,
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
    key: PasswordBoxKey,
}
impl Server {
    fn new() -> Self {
        let password = random_password();
        let key = PasswordBoxKey::generate().unwrap();
        let owner: OwnerKeyContext = serde_json::from_value(
            json!({"passwordBoxId":BOX,"ownerAccountId":OWNER,"keyEpoch":1}),
        )
        .unwrap();
        let salt = crypto::generate_salt().unwrap();
        let root = crypto::derive_master_key(&password, &salt).unwrap();
        let bundle = OwnerKeyBundle::new(
            STANDARD.encode(salt),
            key.wrap_for_owner(&root, &owner).unwrap(),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(State {
            password: password.clone(),
            bundle,
            envelope: None,
            deleted_version: None,
            writes: 0,
            puts: 0,
            requests: 0,
            authorized: true,
            auth_failure: 0,
            write_failure: 0,
            owner_version: 1,
            bundle_version: 1,
            epoch: 1,
            wrong_owner: false,
            auth_oversized: false,
            auth_id: OWNER.into(),
            redirects: 0,
            replayed: None,
        }));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let child_stop = stop.clone();
        let child_state = state.clone();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(120);
            while !child_stop.load(Ordering::SeqCst) && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => serve(&mut stream, &child_state),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            password,
            host,
            state,
            stop,
            worker: Some(worker),
            key,
        }
    }
    fn run(&self, args: &[&str], extra: Value) -> Output {
        let mut input = json!({"sessionToken":TOKEN,"encryptionPassword":self.password.as_str()});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let mut child = Command::new(env!("CARGO_BIN_EXE_op"))
            .env_clear()
            .env(
                "SystemRoot",
                std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
            )
            // Poison legacy configuration: an encrypted command must ignore it.
            .env("OP_CONNECT_HOST", "http://127.0.0.1:1/legacy-marker")
            .env("OP_CONNECT_TOKEN", "fixture-legacy-only-marker")
            .args([
                "--encrypted",
                "--secret-stdin",
                "--passshare-host",
                &self.host,
            ])
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let encoded = serde_json::to_vec(&input).unwrap();
        let mut stdin = child.stdin.take().unwrap();
        // A rejected argv command can close stdin before its input is consumed.
        let write = stdin.write_all(&encoded);
        assert!(write.is_ok() || write.unwrap_err().kind() == std::io::ErrorKind::BrokenPipe);
        drop(stdin);
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let out = thread::spawn(move || read_bounded(stdout));
        let err = thread::spawn(move || read_bounded(stderr));
        let deadline = Instant::now() + Duration::from_secs(45);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("CLI deadline exceeded");
            }
            thread::sleep(Duration::from_millis(10));
        };
        let output = Output {
            status,
            stdout: out.join().unwrap(),
            stderr: err.join().unwrap(),
        };
        let fixture_password = self.state.lock().unwrap().password.clone();
        for credential in [
            TOKEN,
            self.password.as_str(),
            fixture_password.as_str(),
            input["sessionToken"].as_str().unwrap(),
            input["encryptionPassword"].as_str().unwrap(),
            "fixture-legacy-only-marker",
        ] {
            assert!(!String::from_utf8_lossy(&output.stdout).contains(credential));
            assert!(!String::from_utf8_lossy(&output.stderr).contains(credential));
        }
        if !output.status.success() {
            let diagnostic = String::from_utf8_lossy(&output.stderr).replace(FIELD, "[redacted]");
            eprintln!("CLI failure: {} {}", output.status, diagnostic);
        }
        output
    }
    fn dto(&self) -> Value {
        let envelope = self.state.lock().unwrap().envelope.clone().unwrap();
        self.key.decrypt_item(&envelope, &envelope.context).unwrap()
    }
}
fn random_password() -> Zeroizing<String> {
    Zeroizing::new(STANDARD.encode(crypto::generate_salt().unwrap()))
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                assert!(result.is_ok(), "HTTP fixture failed");
            }
        }
    }
}
fn read_bounded(mut reader: impl Read) -> Vec<u8> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(128 * 1024)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() < 128 * 1024);
    bytes
}
fn serve(stream: &mut TcpStream, state: &Mutex<State>) {
    // Windows accepted sockets inherit the listener's nonblocking mode.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut buffer = [0; 4096];
        let count = stream.read(&mut buffer).unwrap();
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&buffer[..count]);
        assert!(bytes.len() <= 32 * 1024);
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
    let mut request = headers.lines().next().unwrap().split_whitespace();
    let method = request.next().unwrap();
    let path = request.next().unwrap();
    let length: usize = headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .map(|(_, value)| value.trim().parse().unwrap())
        .unwrap_or(0);
    assert!(length < 32 * 1024);
    while bytes.len() < header_end + length {
        let mut buffer = [0; 4096];
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&buffer[..count]);
    }
    let body: Value = if length == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
    };
    let expected_token = if path.starts_with("/v1/") {
        "fixture-legacy-only-marker"
    } else {
        TOKEN
    };
    let authenticated = headers
        .lines()
        .filter_map(|l| l.split_once(':'))
        .any(|(n, v)| {
            n.eq_ignore_ascii_case("authorization")
                && v.trim() == format!("Bearer {expected_token}")
        });
    let mut state = state.lock().unwrap();
    state.requests += 1;
    state.authorized &= authenticated;
    let (status, reply) = if authenticated {
        route(method, path, &body, &mut state)
    } else {
        failure(401, &state)
    };
    let wire = if status == 204 {
        Vec::new()
    } else {
        serde_json::to_vec(&reply).unwrap()
    };
    let location = if status == 302 {
        "Location: /redirect-target\r\n"
    } else {
        ""
    };
    let header = format!("HTTP/1.1 {status} fixture\r\n{location}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", wire.len());
    // Rejection of response-size headers may close the connection early.
    if stream.write_all(header.as_bytes()).is_ok() {
        let _ = stream.write_all(&wire);
    }
}
fn failure(status: u16, state: &State) -> (u16, Value) {
    (
        status,
        json!({"error":"PS015","message":format!("{TOKEN} {} {FIELD}", state.password.as_str())}),
    )
}
fn route(method: &str, path: &str, body: &Value, s: &mut State) -> (u16, Value) {
    if path == "/redirect-target" {
        s.redirects += 1;
        return (200, json!({"user":{"id":OWNER}}));
    }
    if s.auth_failure != 0 {
        return failure(s.auth_failure, s);
    }
    // Independent legacy fixture, requiring a different credential and /v1
    // routes. This exercises actual executable compatibility after dispatch.
    if path == "/v1/vaults" && method == "GET" {
        return (
            200,
            json!([{"id":BOX,"name":"fixture-box","type":"USER_CREATED","items":0,
            "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}]),
        );
    }
    if path == format!("/v1/vaults/{BOX}/items") && method == "POST" {
        assert!(body["category"].as_str() == Some("LOGIN"));
        assert!(body["fields"][0]["value"].as_str() == Some("fixture-connect-value"));
        return (200, json!({"id":LEGACY_ITEM}));
    }
    if path == format!("/v1/vaults/{BOX}/items/{LEGACY_ITEM}") && method == "GET" {
        return (
            200,
            json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","title":"fixture","category":"LOGIN","vault":{"id":BOX},
            "fields":[{"id":"cccccccccccccccccccccccccc","label":"username","type":"STRING","purpose":"USERNAME","value":"fixture-connect-value"}],
            "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}),
        );
    }
    if path == "/api/auth/me" {
        if s.auth_oversized {
            return (
                200,
                json!({"user":{"id":OWNER},"padding":"x".repeat(17*1024)}),
            );
        }
        return (
            200,
            json!({"user":{"id":s.auth_id,"email":"fixture@example.invalid","createdAt":"2026-01-01T00:00:00Z"}}),
        );
    }
    let prefix = format!("/api/encrypted/boxes/{BOX}");
    if path == prefix {
        return (200, json!({"mode":"encrypted","keyEpoch":s.epoch}));
    }
    if path == format!("{prefix}/owner-key") {
        return (
            200,
            json!({"bundleVersion":s.bundle_version,"bundle":s.bundle}),
        );
    }
    if path == format!("{prefix}/sharing-snapshot") {
        return (
            200,
            json!({"stateRevision":1,"keyEpoch":s.epoch,"ownerAccountId":if s.wrong_owner { "22222222-2222-4222-8222-222222222222" } else { OWNER },
            "ownerBundleVersion":s.owner_version,"memberCount":1,"liveItemCount":if s.envelope.is_some() {1} else {0},"grantCount":0}),
        );
    }
    if path == format!("{prefix}/sharing-snapshot/items?revision=1") {
        let items: Vec<Value> = s.envelope.iter().map(|e| json!({"itemId":e.context.item_id,"itemVersion":e.context.item_version,"keyEpoch":e.context.key_epoch})).collect();
        return (
            200,
            json!({"stateRevision":1,"items":items,"nextCursor":null}),
        );
    }
    if path.starts_with(&format!("{prefix}/sharing-snapshot/items/")) {
        return match &s.envelope {
            Some(envelope) => (200, json!(envelope)),
            None => failure(404, s),
        };
    }
    if path.starts_with(&format!("{prefix}/items/")) {
        if method == "PUT" {
            s.puts += 1;
            if s.write_failure != 0 {
                return failure(s.write_failure, s);
            }
            // Writes contain only the opaque request, never credential plaintext.
            let wire = serde_json::to_string(body).unwrap();
            assert!([TOKEN, s.password.as_str(), FIELD]
                .iter()
                .all(|marker| !wire.contains(marker)));
            let e: EncryptedItem = serde_json::from_value(body["envelope"].clone()).unwrap();
            assert!(path.ends_with(e.context.item_id.as_str()));
            let expected = body["expectedVersion"].as_u64().unwrap();
            if s.deleted_version.is_some() {
                return failure(409, s);
            }
            if let Some(current) = &s.envelope {
                if *current == e && e.context.item_version == expected + 1 {
                    s.replayed = Some(body.clone());
                    return (200, json!(current));
                }
                if current.context.item_version != expected {
                    return failure(409, s);
                }
            } else if expected != 0 {
                return failure(409, s);
            }
            assert!(e.context.item_version == expected + 1);
            if e.context.key_epoch != s.epoch {
                return failure(409, s);
            }
            s.writes += 1;
            s.envelope = Some(e.clone());
            return (200, json!(e));
        }
        if method == "DELETE" {
            let expected = body["expectedVersion"].as_u64().unwrap();
            if s.write_failure != 0 {
                return failure(s.write_failure, s);
            }
            if body["keyEpoch"].as_u64() != Some(s.epoch) {
                return failure(409, s);
            }
            if s.deleted_version == Some(expected) {
                return (204, Value::Null);
            }
            if s.envelope.as_ref().map(|e| e.context.item_version) != Some(expected) {
                return failure(409, s);
            }
            s.deleted_version = Some(expected);
            s.envelope = None;
            s.writes += 1;
            return (204, Value::Null);
        }
    }
    failure(404, s)
}
fn item() -> Value {
    json!({"item":{"title":"fixture","category":"LOGIN","fields":[
        {"id":"password-field","label":"password","purpose":"PASSWORD","type":"CONCEALED","value":FIELD,"section":{"id":"section-a"},"future":7},
        {"id":"custom-field","label":"custom","type":"STRING","value":"retain-this","unknown":{"x":true}}],
        "sections":[{"id":"section-a","label":"section"}],"urls":[{"href":"https://example.invalid","future":8}],
        "tags":["retained"],"favorite":true,"unknownTop":{"nested":[1,2,3]}}})
}
fn safe_failure(output: &Output, status: u16) {
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains(&format!("HTTP {status}")));
    assert!(!text.contains(FIELD));
}

#[test]
fn executable_normalizes_owner_password_like_the_wasm_client() {
    use unicode_normalization::UnicodeNormalization;
    let server = Server::new();
    let typed = Zeroizing::new(format!("fixture e\u{301} {}", random_password().as_str()));
    let normalized = Zeroizing::new(typed.nfc().collect::<String>());
    assert!(typed.as_str() != normalized.as_str());
    let salt = crypto::generate_salt().unwrap();
    let root = crypto::derive_master_key_with_params(&normalized, &salt, 65_536, 3, 4).unwrap();
    let owner = server.state.lock().unwrap().bundle.wrapped.context.clone();
    let mut full = item()["item"].clone();
    full["id"] = json!(LEGACY_ITEM);
    full["version"] = json!(1);
    full["vault"] = json!({"id":BOX});
    let context = serde_json::from_value(
        json!({"passwordBoxId":BOX,"itemId":LEGACY_ITEM,"itemVersion":1,"keyEpoch":1}),
    )
    .unwrap();
    {
        let mut state = server.state.lock().unwrap();
        state.bundle = OwnerKeyBundle::new(
            STANDARD.encode(salt),
            server.key.wrap_for_owner(&root, &owner).unwrap(),
        )
        .unwrap();
        state.password = normalized.clone();
        state.envelope = Some(server.key.encrypt_item(&full, &context).unwrap());
    }
    for password in [typed.as_str(), normalized.as_str()] {
        let output = server.run(
            &["item", "get", LEGACY_ITEM, "--vault", BOX],
            json!({"encryptionPassword":password}),
        );
        assert!(output.status.success());
        let got: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(got == full);
    }
}

#[test]
fn executable_create_read_edit_delete_and_explicit_replay_preserve_complete_dto() {
    let server = Server::new();
    let prepared = server.run(
        &["--prepare-only", "item", "create", "--vault", BOX],
        item(),
    );
    assert!(prepared.status.success());
    assert!(!String::from_utf8_lossy(&prepared.stdout).contains(FIELD));
    let opaque: Value = serde_json::from_slice(&prepared.stdout).unwrap();
    assert!(opaque["ownerAccountId"].as_str() == Some(OWNER));
    assert!(server.state.lock().unwrap().puts == 0);
    let id = opaque["itemId"].as_str().unwrap();
    for _ in 0..2 {
        let result = server.run(
            &["item", "retry", "--vault", BOX],
            json!({"preparedWrite":opaque}),
        );
        assert!(result.status.success());
    }
    assert!(server.state.lock().unwrap().writes == 1);
    let original = server.dto();
    let mut expected = item()["item"].clone();
    expected["id"] = json!(id);
    expected["version"] = json!(1);
    expected["vault"] = json!({"id":BOX});
    assert!(original == expected);
    let full = server.run(&["item", "get", id, "--vault", BOX], json!({}));
    assert!(full.status.success());
    assert!(serde_json::from_slice::<Value>(&full.stdout).unwrap() == expected);
    let reference = format!("op://{BOX}/{id}/password");
    let read_ref = server.run(&["read", &reference], json!({}));
    assert!(read_ref.status.success());
    assert!(String::from_utf8_lossy(&read_ref.stdout).trim() == FIELD);
    let read = server.run(
        &["item", "get", id, "--vault", BOX, "--fields", "password"],
        json!({}),
    );
    assert!(read.status.success());
    assert!(String::from_utf8_lossy(&read.stdout).trim() == FIELD);
    let edit = server.run(
        &["--prepare-only", "item", "edit", id, "--vault", BOX],
        json!({"selectedFields":{"password":"changed-marker"}}),
    );
    assert!(edit.status.success());
    let edit_opaque: Value = serde_json::from_slice(&edit.stdout).unwrap();
    for _ in 0..2 {
        assert!(server
            .run(
                &["item", "retry", "--vault", BOX],
                json!({"preparedWrite":edit_opaque})
            )
            .status
            .success());
    }
    expected["version"] = json!(2);
    expected["fields"][0]["value"] = json!("changed-marker");
    assert!(server.dto() == expected);
    assert!(server.state.lock().unwrap().writes == 2);
    safe_failure(
        &server.run(
            &["item", "retry", "--vault", BOX],
            json!({"preparedWrite":opaque}),
        ),
        409,
    );
    let listed = server.run(&["item", "list", "--vault", BOX], json!({}));
    assert!(listed.status.success());
    assert!(String::from_utf8_lossy(&listed.stdout).trim() == format!("{id}\t2"));
    assert!(!String::from_utf8_lossy(&listed.stdout).contains("changed-marker"));
    let boxes = server.run(&["vault", "list", "--password-box", BOX], json!({}));
    assert!(boxes.status.success());
    assert!(String::from_utf8_lossy(&boxes.stdout).trim() == format!("{BOX}\t1"));
    let delete = server.run(
        &["--prepare-only", "item", "delete", id, "--vault", BOX],
        json!({}),
    );
    assert!(delete.status.success());
    let delete_opaque: Value = serde_json::from_slice(&delete.stdout).unwrap();
    for _ in 0..2 {
        assert!(server
            .run(
                &["item", "retry", "--vault", BOX],
                json!({"preparedWrite":delete_opaque})
            )
            .status
            .success());
    }
    assert!(server.state.lock().unwrap().writes == 3);
    safe_failure(
        &server.run(
            &["item", "retry", "--vault", BOX],
            json!({"preparedWrite":opaque}),
        ),
        409,
    );
    assert!(server.state.lock().unwrap().authorized);
}

#[test]
fn executable_redacts_401_403_409_and_does_not_retry_writes() {
    let server = Server::new();
    safe_failure(
        &server.run(
            &["item", "create", "--vault", BOX],
            json!({"sessionToken":"fixture-legacy-only-marker"}),
        ),
        401,
    );
    assert!(server.state.lock().unwrap().puts == 0);
    assert!(!server
        .run(
            &["item", "create", "--vault", BOX],
            json!({"item":item()["item"],"encryptionPassword":random_password().as_str()})
        )
        .status
        .success());
    assert!(server.state.lock().unwrap().puts == 0);
    for status in [401, 403] {
        server.state.lock().unwrap().auth_failure = status;
        safe_failure(
            &server.run(&["item", "create", "--vault", BOX], item()),
            status,
        );
        assert!(server.state.lock().unwrap().puts == 0);
    }
    server.state.lock().unwrap().auth_failure = 0;
    for status in [401, 403, 409] {
        server.state.lock().unwrap().write_failure = status;
        let before = server.state.lock().unwrap().puts;
        safe_failure(
            &server.run(&["item", "create", "--vault", BOX], item()),
            status,
        );
        assert!(server.state.lock().unwrap().puts == before + 1);
        assert!(server.state.lock().unwrap().writes == 0);
    }
}

#[test]
fn executable_rejects_owner_bundle_epoch_and_replay_scope_mismatch_before_write() {
    let server = Server::new();
    server.state.lock().unwrap().wrong_owner = true;
    assert!(!server
        .run(&["item", "create", "--vault", BOX], item())
        .status
        .success());
    server.state.lock().unwrap().wrong_owner = false;
    server.state.lock().unwrap().owner_version = 2;
    assert!(!server
        .run(&["item", "create", "--vault", BOX], item())
        .status
        .success());
    server.state.lock().unwrap().owner_version = 1;
    server.state.lock().unwrap().epoch = 2;
    assert!(!server
        .run(&["item", "create", "--vault", BOX], item())
        .status
        .success());
    server.state.lock().unwrap().epoch = 1;
    assert!(server.state.lock().unwrap().puts == 0);
    let prepared = server.run(
        &["--prepare-only", "item", "create", "--vault", BOX],
        item(),
    );
    assert!(prepared.status.success());
    let opaque: Value = serde_json::from_slice(&prepared.stdout).unwrap();
    for (key, value) in [
        (
            "ownerAccountId",
            json!("22222222-2222-4222-8222-222222222222"),
        ),
        ("ownerBundleVersion", json!(2)),
        ("keyEpoch", json!(2)),
        ("server", json!("https://example.invalid/")),
        ("passwordBoxId", json!("bbbbbbbbbbbbbbbbbbbbbbbbbb")),
        ("expectedVersion", json!(1)),
    ] {
        let mut changed = opaque.clone();
        changed[key] = value;
        assert!(!server
            .run(
                &["item", "retry", "--vault", BOX],
                json!({"preparedWrite":changed})
            )
            .status
            .success());
    }
    let mut changed = opaque.clone();
    changed["envelope"]["ciphertext"] = json!("invalid-marker");
    assert!(!server
        .run(
            &["item", "retry", "--vault", BOX],
            json!({"preparedWrite":changed})
        )
        .status
        .success());
    assert!(server.state.lock().unwrap().puts == 0);
    // Control request on the very same fixture proves rejection counts aren't vacuous.
    assert!(server
        .run(
            &["item", "retry", "--vault", BOX],
            json!({"preparedWrite":opaque})
        )
        .status
        .success());
    assert!(server.state.lock().unwrap().puts == 1);
}

#[test]
fn executable_rejects_argv_secret_without_network_and_environment_boundary_works() {
    let server = Server::new();
    let output = server.run(
        &[
            "item",
            "create",
            "--vault",
            BOX,
            "password=fixture-argv-marker",
        ],
        item(),
    );
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("fixture-argv-marker"));
    assert!(server.state.lock().unwrap().requests == 0);
    for args in [
        vec!["item", "create", "--vault", BOX, "--category", "PASSWORD"],
        vec!["item", "get", "--unexpected-secret=fixture-argv-marker"],
        vec!["--encrypted=true", "item", "list", "--vault", BOX],
    ] {
        let output = server.run(&args, json!({}));
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stderr).contains("fixture-argv-marker"));
    }
    assert!(server.state.lock().unwrap().requests == 0);
    let output = Command::new(env!("CARGO_BIN_EXE_op"))
        .env_clear()
        .env(
            "SystemRoot",
            std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
        )
        .env("PASSSHARE_HOST", &server.host)
        .env("PASSSHARE_SESSION_TOKEN", TOKEN)
        .env("PASSSHARE_ENCRYPTION_PASSWORD", server.password.as_str())
        .env(
            "PASSSHARE_INPUT_JSON",
            serde_json::to_string(&item()).unwrap(),
        )
        .args(["--encrypted", "item", "create", "--vault", BOX])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(server.state.lock().unwrap().writes == 1);
    assert!(server.state.lock().unwrap().authorized);
}

#[test]
fn executable_auth_transport_rejects_redirects_and_oversized_body() {
    let server = Server::new();
    server.state.lock().unwrap().auth_failure = 302;
    let output = server.run(&["item", "list", "--vault", BOX], json!({}));
    safe_failure(&output, 302);
    assert!(server.state.lock().unwrap().requests == 1);
    assert!(server.state.lock().unwrap().redirects == 0);
    server.state.lock().unwrap().auth_failure = 0;
    server.state.lock().unwrap().auth_oversized = true;
    assert!(!server
        .run(&["item", "list", "--vault", BOX], json!({}))
        .status
        .success());
    assert!(server.state.lock().unwrap().requests == 2);
    server.state.lock().unwrap().auth_oversized = false;
    assert!(server
        .run(&["item", "list", "--vault", BOX], json!({}))
        .status
        .success());
    assert!(server.state.lock().unwrap().requests > 2);
}

#[test]
fn executable_live_subject_requires_canonical_nonnil_uuid() {
    let server = Server::new();
    for (index, id) in [
        "not-a-uuid",
        "00000000-0000-0000-0000-000000000000",
        "11111111111141118111111111111111",
        "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        "{11111111-1111-4111-8111-111111111111}",
        "urn:uuid:11111111-1111-4111-8111-111111111111",
    ]
    .iter()
    .enumerate()
    {
        server.state.lock().unwrap().auth_id = (*id).into();
        let output = server.run(&["item", "list", "--vault", BOX], json!({}));
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&output.stderr).contains(id));
        let state = server.state.lock().unwrap();
        assert!(state.requests == index + 1);
        assert!(state.puts == 0);
    }
    server.state.lock().unwrap().auth_id = OWNER.into();
    let output = server.run(&["vault", "list", "--password-box", BOX], json!({}));
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).trim() == format!("{BOX}\t1"));
}

#[test]
fn executable_legacy_connect_dispatch_and_default_category_are_preserved() {
    let server = Server::new();
    let output = Command::new(env!("CARGO_BIN_EXE_op"))
        .env_clear()
        .env(
            "SystemRoot",
            std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
        )
        .env("OP_CONNECT_HOST", &server.host)
        .env("OP_CONNECT_TOKEN", "fixture-legacy-only-marker")
        // Poison session inputs; legacy mode must not inspect them.
        .env("PASSSHARE_SESSION_TOKEN", "invalid session marker")
        .env("PASSSHARE_ENCRYPTION_PASSWORD", "invalid encryption marker")
        .args([
            "item",
            "create",
            "--vault",
            BOX,
            "--title",
            "fixture",
            "username=fixture-connect-value",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).trim() == "bbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert!(output.stderr.is_empty());
    let output = Command::new(env!("CARGO_BIN_EXE_op"))
        .env_clear()
        .env(
            "SystemRoot",
            std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
        )
        .env("OP_CONNECT_HOST", &server.host)
        .env("OP_CONNECT_TOKEN", "fixture-legacy-only-marker")
        .args(["vault", "list"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).trim() == format!("{BOX}\tfixture-box"));
    assert!(server.state.lock().unwrap().requests == 3);
    assert!(server.state.lock().unwrap().authorized);
}
