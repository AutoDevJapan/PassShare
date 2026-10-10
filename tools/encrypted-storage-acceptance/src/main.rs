//! Separate client-side Core/host contract acceptance; run via the Cargo gate.
//! Owns a disposable Docker PostgreSQL and
//! real Express host. No production configuration, model API or secret files.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
mod account_identity;
use passshare_core::{
    cloud_crypto::{ItemContext, OwnerKeyContext, PasswordBoxKey, WrappedPasswordBoxKey},
    crypto::{derive_master_key_with_params, generate_salt, MasterKey},
    ConnectId, PassShareError,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

mod go_session;

// Usage: <production-native-binary> OR --image <prebuilt-production-image>.
// Both modes require the preloaded pinned PostgreSQL image. Supplied images are never
// mounted over or removed by the tool; the caller owns its build/tag lifecycle.
const POSTGRES_IMAGE: &str =
    "mirror.gcr.io/library/postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
static CLEANUP_FAILED: AtomicBool = AtomicBool::new(false);

enum Mode {
    Node(PathBuf),
    Image(String),
}
impl Mode {
    fn parse(args: &[std::ffi::OsString]) -> Result<Self, &'static str> {
        match args {
            [flag, image] if flag == "--image" => {
                let image = image.to_str().ok_or("image tag must be ASCII")?;
                if image.is_empty()
                    || image.starts_with('-')
                    || !image
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"/._-:@".contains(&b))
                {
                    return Err("invalid image tag");
                }
                Ok(Self::Image(image.to_owned()))
            }
            [binary] if !binary.to_string_lossy().starts_with('-') => Ok(Self::Node(binary.into())),
            _ => Err("usage: <production-native-binary> OR --image <prebuilt-production-image>"),
        }
    }
    fn label(&self) -> &'static str {
        match self {
            Self::Node(_) => "node",
            Self::Image(_) => "image",
        }
    }
}

fn docker_ok(args: &[&str], operation: &str) {
    assert!(
        command("docker")
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success()),
        "{operation} failed"
    );
}
fn cleanup(args: &[&str]) {
    if !command("docker")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
    {
        CLEANUP_FAILED.store(true, Ordering::SeqCst);
        eprintln!("owned Docker resource cleanup failed");
    }
}
struct Network {
    name: String,
}
impl Network {
    fn start() -> Self {
        let network = Self {
            name: format!(
                "passshare1163-encrypted-net-{}",
                ConnectId::generate().unwrap()
            ),
        };
        docker_ok(
            &[
                "network",
                "create",
                "--driver",
                "bridge",
                "--label",
                "passshare.todo=1163",
                "--label",
                "passshare.fixture=encrypted-storage",
                &network.name,
            ],
            "create owned bridge network",
        );
        network
    }
}
impl Drop for Network {
    fn drop(&mut self) {
        cleanup(&["network", "rm", &self.name]);
    }
}

fn command(program: &str) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    }
    #[cfg(not(windows))]
    command
}
fn port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
struct Database {
    name: String,
    port: u16,
}
impl Database {
    fn start(network: &Network) -> Self {
        let db = Self {
            name: format!("passshare1163-encrypted-{}", ConnectId::generate().unwrap()),
            port: port(),
        };
        let status = command("docker")
            .args([
                "run",
                "--detach",
                "--name",
                &db.name,
                "--pull=never",
                "--network",
                &network.name,
                "--label",
                "passshare.todo=1163",
                "--label",
                "passshare.fixture=encrypted-storage",
                "--publish",
                &format!("127.0.0.1:{}:5432", db.port),
                "--env",
                "POSTGRES_USER=passshare",
                "--env",
                "POSTGRES_PASSWORD=passshare",
                "--env",
                "POSTGRES_DB=passshare",
                POSTGRES_IMAGE,
            ])
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "start isolated PostgreSQL");
        let ready = (0..150).any(|_| {
            if command("docker")
                .args([
                    "exec",
                    &db.name,
                    "pg_isready",
                    "-U",
                    "passshare",
                    "-d",
                    "passshare",
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
            {
                true
            } else {
                thread::sleep(Duration::from_millis(100));
                false
            }
        });
        assert!(ready, "PostgreSQL readiness");
        db
    }
    fn sql(&self, sql: &str) -> String {
        self.sql_before(sql, std::time::Instant::now() + Duration::from_secs(15))
    }
    fn sql_before(&self, sql: &str, deadline: std::time::Instant) -> String {
        let mut child = command("docker")
            .args([
                "exec",
                &self.name,
                "psql",
                "-X",
                "-q",
                "-A",
                "-t",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "passshare",
                "-d",
                "passshare",
                "-c",
                sql,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut readers = Vec::new();
        for (is_stdout, pipe) in [
            (true, Box::new(stdout) as Box<dyn Read + Send>),
            (false, Box::new(stderr) as Box<dyn Read + Send>),
        ] {
            let sender = sender.clone();
            readers.push(thread::spawn(move || {
                let mut bytes = Vec::new();
                let result = pipe.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes);
                let _ = sender.send((is_stdout, result, bytes));
            }));
        }
        drop(sender);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                if !reap_before(
                    &mut child,
                    std::time::Instant::now() + Duration::from_secs(2),
                ) {
                    CLEANUP_FAILED.store(true, Ordering::SeqCst);
                }
                panic!("fixture SQL exceeded its deadline");
            }
            thread::sleep(Duration::from_millis(10));
        };
        let mut output = None;
        for _ in 0..2 {
            let (is_stdout, result, bytes) = receiver
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("fixture SQL output drain exceeded deadline");
            result.expect("fixture SQL output read failed");
            assert!(
                bytes.len() <= 8 * 1024 * 1024,
                "fixture SQL output exceeded bound"
            );
            if is_stdout {
                output = Some(bytes);
            }
        }
        for reader in readers {
            reader.join().expect("fixture SQL reader failed");
        }
        assert!(status.success(), "fixture SQL failed");
        String::from_utf8(output.unwrap())
            .unwrap()
            .trim()
            .to_owned()
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        cleanup(&["rm", "--force", "--volumes", &self.name]);
    }
}
enum HostProcess {
    Node(Child),
    Container(String),
}
struct Host {
    process: HostProcess,
    port: u16,
}
impl Host {
    fn start(db: &Database, network: &Network, mode: &Mode) -> Self {
        Self::with_storage(db, network, mode, true)
    }
    fn with_storage(db: &Database, network: &Network, mode: &Mode, enabled: bool) -> Self {
        let port = port();
        let host = match mode {
            Mode::Image(image) => {
                let host = Self {
                    process: HostProcess::Container(format!(
                        "passshare1163-encrypted-api-{}",
                        ConnectId::generate().unwrap()
                    )),
                    port,
                };
                let HostProcess::Container(name) = &host.process else {
                    unreachable!()
                };
                // All values are separate CLI arguments. No shell interpolation,
                // host native mount, native ENV override, or external secrets.
                docker_ok(
                    &[
                        "run",
                        "--detach",
                        "--name",
                        name,
                        "--pull=never",
                        "--network",
                        &network.name,
                        "--label",
                        "passshare.todo=1163",
                        "--label",
                        "passshare.fixture=encrypted-storage",
                        "--publish",
                        &format!("127.0.0.1:{port}:8080"),
                        "--env",
                        "APP_ENV=local",
                        "--env",
                        "DEV_SEED=false",
                        "--env",
                        if enabled {
                            "PASSSHARE_ENCRYPTED_STORAGE=true"
                        } else {
                            "PASSSHARE_ENCRYPTED_STORAGE=false"
                        },
                        "--env",
                        "PORT=8080",
                        "--env",
                        &format!(
                            "DATABASE_URL=postgresql://passshare:passshare@{}:5432/passshare",
                            db.name
                        ),
                        image,
                    ],
                    "start owned production API image",
                );
                host
            }
            Mode::Node(binary) => Self::start_node(db, binary, port, enabled),
        };
        // Published container ports can accept TCP before the application has
        // completed migrations. Observe HTTP health from the real entrypoint.
        assert!(
            (0..200).any(|_| {
                if ready(port) {
                    true
                } else {
                    thread::sleep(Duration::from_millis(100));
                    false
                }
            }),
            "formal API HTTP readiness"
        );
        host
    }
    fn start_node(db: &Database, binary: &std::path::Path, port: u16, enabled: bool) -> Self {
        let backend = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("backend");
        let mut cmd = command("node");
        cmd.env_clear();
        for key in ["PATH", "SystemRoot", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        let child = cmd
            .arg("src/index.js")
            .current_dir(backend)
            .env("PORT", port.to_string())
            .env("APP_ENV", "local")
            .env("DEV_SEED", "false")
            .env("PASSSHARE_MUTATIONS_BIN", binary)
            .env(
                "PASSSHARE_ENCRYPTED_STORAGE",
                if enabled { "true" } else { "false" },
            )
            .env(
                "DATABASE_URL",
                format!(
                    "postgresql://passshare:passshare@127.0.0.1:{}/passshare",
                    db.port
                ),
            )
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        Self {
            process: HostProcess::Node(child),
            port,
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        match &mut self.process {
            HostProcess::Node(child) => {
                let _ = child.kill();
                if child.wait().is_err() {
                    CLEANUP_FAILED.store(true, Ordering::SeqCst);
                }
            }
            HostProcess::Container(name) => cleanup(&["rm", "--force", "--volumes", name]),
        }
    }
}
fn ready(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(500),
    ) else {
        return false;
    };
    if stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .is_err()
        || stream
            .set_write_timeout(Some(Duration::from_millis(500)))
            .is_err()
        || write!(
            stream,
            "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        )
        .is_err()
    {
        return false;
    }
    let mut bytes = Vec::new();
    if stream.take(65536).read_to_end(&mut bytes).is_err() {
        return false;
    }
    let Some(split) = bytes.windows(4).position(|p| p == b"\r\n\r\n") else {
        return false;
    };
    std::str::from_utf8(&bytes[..split]).is_ok_and(|headers| {
        headers
            .lines()
            .next()
            .is_some_and(|h| h.split_whitespace().nth(1) == Some("200"))
    }) && serde_json::from_slice::<Value>(&bytes[split + 4..])
        .is_ok_and(|body| body["status"] == "ok")
}
fn http(port: u16, method: &str, path: &str, headers: &str, body: &Value) -> (u16, Value) {
    let (status, bytes) = http_bytes(port, method, path, headers, body);
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, body)
}
fn http_bytes(port: u16, method: &str, path: &str, headers: &str, body: &Value) -> (u16, Vec<u8>) {
    let payload = if body.is_null() {
        String::new()
    } else {
        body.to_string()
    };
    http_payload(port, method, path, headers, &payload)
}
fn http_payload(
    port: u16,
    method: &str,
    path: &str,
    headers: &str,
    payload: &str,
) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    write!(stream,"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\n\r\n{payload}",payload.len()).unwrap();
    let mut bytes = Vec::new();
    stream
        .take(4 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .unwrap();
    let split = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let header = std::str::from_utf8(&bytes[..split]).unwrap();
    let status = header
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, bytes[split + 4..].to_vec())
}
fn signup(port: u16) -> (String, String, String) {
    let (refresh, connect, box_id, _) = signup_with_password(port);
    (refresh, connect, box_id)
}
fn signup_with_password(port: u16) -> (String, String, String, String) {
    let password = format!("{}Aa!", ConnectId::generate().unwrap());
    let (status, session) = http(
        port,
        "POST",
        "/api/auth/signup",
        "x-passshare-client: mobile\r\n",
        &json!({"email":format!("{}@example.test",ConnectId::generate().unwrap()),"password":password}),
    );
    assert_eq!(status, 201, "synthetic signup");
    let connect = session["connectAccessToken"].as_str().unwrap().to_owned();
    let refresh = session["refreshToken"].as_str().unwrap().to_owned();
    let (status, boxes) = http(
        port,
        "GET",
        "/v1/vaults",
        &format!("Authorization: Bearer {connect}\r\n"),
        &Value::Null,
    );
    assert_eq!(status, 200);
    (
        refresh,
        connect,
        boxes[0]["id"].as_str().unwrap().to_owned(),
        password,
    )
}
// Client-side owner key bundle, as packages/cloud-wasm builds it: a fixed
// Format-1 Argon2id costs are fixed independently of Core defaults.
// The password, salt-derived
// master key and raw box key stay in this process; the server sees the bundle only.
fn owner_context(box_id: &str, owner: &str, epoch: u64) -> OwnerKeyContext {
    serde_json::from_value(json!({"passwordBoxId":box_id,"ownerAccountId":owner,"keyEpoch":epoch}))
        .unwrap()
}
fn owner_master(password: &str, salt: &[u8]) -> Result<MasterKey, PassShareError> {
    derive_master_key_with_params(password, salt, 65_536, 3, 4)
}
fn owner_bundle(
    key: &PasswordBoxKey,
    master: &MasterKey,
    salt: [u8; 16],
    context: &OwnerKeyContext,
) -> Value {
    json!({"format":1,"salt":BASE64.encode(salt),
        "wrapped":key.wrap_for_owner(master,context).unwrap()})
}
// Re-derives the master key from the FETCHED salt, as a fresh client would.
fn unwrap_bundle(
    bundle: &Value,
    password: &str,
    context: &OwnerKeyContext,
) -> Result<PasswordBoxKey, PassShareError> {
    let salt = BASE64.decode(bundle["salt"].as_str().unwrap()).unwrap();
    let master = owner_master(password, &salt)?;
    let wrapped: WrappedPasswordBoxKey = serde_json::from_value(bundle["wrapped"].clone()).unwrap();
    PasswordBoxKey::unwrap_for_owner(&wrapped, &master, context)
        .map_err(|_| PassShareError::CorruptFile)
}

fn main() {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    // Consume a valueless fixture prefix before the unchanged Node/image parser.
    let identity_fixture = args.first().is_some_and(|arg| arg == "--account-identity");
    let mode_args = if identity_fixture {
        &args[1..]
    } else {
        &args[..]
    };
    let (go_executable, host_args) =
        go_session::cli(mode_args).unwrap_or_else(|reason| panic!("{reason}"));
    assert!(
        !identity_fixture || go_executable.is_none(),
        "fixture modes are mutually exclusive"
    );
    let mode = Mode::parse(host_args).unwrap_or_else(|reason| panic!("{reason}"));
    let mode = match mode {
        Mode::Node(binary) => {
            let binary = binary
                .canonicalize()
                .expect("production native binary must exist");
            assert!(binary.is_file(), "production native binary must be a file");
            Mode::Node(binary)
        }
        Mode::Image(image) => {
            docker_ok(
                &["image", "inspect", &image],
                "inspect prebuilt production image",
            );
            Mode::Image(image)
        }
    };
    docker_ok(
        &["image", "inspect", POSTGRES_IMAGE],
        "inspect preloaded PostgreSQL base image",
    );
    let network = Network::start();
    let db = Database::start(&network);
    if let Some(executable) = go_executable {
        go_session::run(&db, &network, &mode, &executable);
    } else if identity_fixture {
        account_identity::run(&db, &network, &mode);
    } else {
        run_acceptance(&db, &network, &mode);
    }
    drop(db);
    drop(network);
    assert!(
        !CLEANUP_FAILED.load(Ordering::SeqCst),
        "owned fixture cleanup must succeed"
    );
    println!(
        "encrypted storage mode={} acceptance and owned fixture cleanup passed",
        mode.label()
    );
}
fn run_acceptance(db: &Database, network: &Network, mode: &Mode) {
    let mut host = Host::start(db, network, mode);
    let p = host.port;
    accept_atomic_setup(db, p);
    let (refresh, connect, box_id, auth_password) = signup_with_password(p);
    let (stranger, _, stranger_box, stranger_auth_password) = signup_with_password(p);
    let headers = format!("Authorization: Bearer {refresh}\r\n");
    let stranger_headers = format!("Authorization: Bearer {stranger}\r\n");
    let mut connect_headers = format!("Authorization: Bearer {connect}\r\n");
    let root = format!("/api/encrypted/boxes/{box_id}");
    // Keep the pooled HTTP connection reactor alive between synchronous Core/HTTP steps.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let sdk =
        passshare_connect::EncryptedSessionClient::new(&format!("http://127.0.0.1:{p}"), &refresh)
            .unwrap();
    assert_eq!(
        runtime.block_on(sdk.state(&box_id)).unwrap(),
        passshare_connect::BoxState::Compatibility
    );
    assert_eq!(
        http(p, "GET", &root, &connect_headers, &Value::Null).0,
        401,
        "Connect credentials are not account sessions"
    );
    assert_eq!(
        http(p, "GET", &root, &headers, &Value::Null).1["mode"],
        "compatibility"
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            "",
            &json!({"keyEpoch":1})
        )
        .0,
        401
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &stranger_headers,
            &json!({"keyEpoch":1})
        )
        .0,
        403
    );
    // Cookie writes require the same CSRF protection as account routes.
    for client in ["mobile", "extension"] {
        assert_eq!(
            http(
                p,
                "POST",
                &format!("{root}/enable"),
                &format!("Cookie: passshare_session={refresh}\r\nx-passshare-client: {client}\r\n"),
                &json!({"keyEpoch":1})
            )
            .0,
            403
        );
    }
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &format!("Cookie: passshare_session={refresh}\r\n"),
            &json!({"keyEpoch":1})
        )
        .0,
        403
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &headers,
            &json!({"keyEpoch":1})
        )
        .0,
        200
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &headers,
            &json!({"keyEpoch":1})
        )
        .0,
        200
    );
    let context = ItemContext {
        password_box_id: box_id.parse().unwrap(),
        item_id: ConnectId::generate().unwrap(),
        item_version: 1,
        key_epoch: 1,
    };
    let item = json!({"id":context.item_id,"version":1,"vault":{"id":context.password_box_id},"title":"Synthetic title","fields":[{"type":"CONCEALED","value":ConnectId::generate().unwrap()}],"retained":{"array":[1,2,3]}});
    let key = PasswordBoxKey::generate().unwrap();
    let envelope = key.encrypt_item(&item, &context).unwrap();
    let payload = json!({"expectedVersion":0,"envelope":envelope});
    let path = format!("{root}/items/{}", context.item_id);
    // Keys and plaintext are forbidden even if all public headers are valid.
    for pointer in ["", "/envelope", "/envelope/context"] {
        for field in ["key", "password", "plaintext", "fields"] {
            let mut bad = payload.clone();
            bad.pointer_mut(pointer).unwrap()[field] = json!("must-not-enter-storage");
            assert_eq!(http(p, "PUT", &path, &headers, &bad).0, 400);
        }
    }
    assert_eq!(runtime.block_on(sdk.enable_empty_box(&box_id)).unwrap(), 1);
    assert_eq!(
        runtime.block_on(sdk.state(&box_id)).unwrap(),
        passshare_connect::BoxState::Encrypted { key_epoch: 1 }
    );
    assert_eq!(
        runtime
            .block_on(sdk.put_item(&box_id, context.item_id.as_str(), 0, &envelope))
            .unwrap(),
        envelope
    );
    assert_eq!(
        runtime
            .block_on(sdk.get_item(&box_id, context.item_id.as_str()))
            .unwrap(),
        envelope
    );
    let sdk_page = runtime.block_on(sdk.list(&box_id, None)).unwrap();
    assert_eq!(sdk_page.items.len(), 1);
    assert_eq!(sdk_page.items[0].item_id, context.item_id);
    assert!(sdk_page.next_cursor.is_none());
    let different_envelope = key.encrypt_item(&item, &context).unwrap();
    assert_ne!(different_envelope, envelope);
    let sdk_conflict = runtime
        .block_on(sdk.put_item(&box_id, context.item_id.as_str(), 0, &different_envelope))
        .unwrap_err();
    assert_eq!(sdk_conflict.status(), Some(409));
    assert_eq!(sdk_conflict.code(), Some("PS015"));
    accept_encrypted_put_replay(
        db,
        p,
        (&refresh, &connect, &stranger, &stranger_box),
        &context,
        &item,
        &key,
    );
    accept_encrypted_delete(
        db,
        p,
        (&refresh, &connect, &stranger, &stranger_box),
        &context,
        &item,
        &key,
    );
    let (status, stored) = http(p, "GET", &path, &headers, &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(stored, serde_json::to_value(&envelope).unwrap());
    assert_eq!(
        key.decrypt_item(&serde_json::from_value(stored.clone()).unwrap(), &context)
            .unwrap(),
        item
    );
    assert_eq!(
        http(p, "GET", &path, &stranger_headers, &Value::Null).0,
        403
    );
    let before_replay = db.sql(&format!(
        "SELECT to_jsonb(i)::text FROM encrypted_items i WHERE box_id='{box_id}' AND item_id='{}'",
        context.item_id
    ));
    assert_eq!(
        http(p, "PUT", &path, &headers, &payload),
        (200, stored.clone())
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT to_jsonb(i)::text FROM encrypted_items i WHERE box_id='{box_id}' AND item_id='{}'",
            context.item_id
        )),
        before_replay,
        "exact create replay preserves updated_at and the full row"
    );
    let claimant = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{stranger_box}'"
    ));
    // Owner key bundle: synthetic password and bundles are derived by Core here.
    let owner_id = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner'"
    ));
    let owner_path = format!("{root}/owner-key");
    let owner_password = format!(
        "synthetic-owner-password-{}",
        ConnectId::generate().unwrap()
    );
    let salt = generate_salt().unwrap();
    let master = owner_master(&owner_password, &salt).unwrap();
    let owner_ctx = owner_context(&box_id, &owner_id, 1);
    let bundle1 = owner_bundle(&key, &master, salt, &owner_ctx);
    let put1 = json!({"expectedVersion":0,"bundle":bundle1});
    let stranger_put = json!({"expectedVersion":0,"bundle":owner_bundle(&key,&master,salt,&owner_context(&box_id,&claimant,1))});
    for (credentials, expected) in [
        ("", 401),
        (connect_headers.as_str(), 401),
        (stranger_headers.as_str(), 403),
    ] {
        assert_eq!(
            http(p, "GET", &owner_path, credentials, &Value::Null).0,
            expected
        );
        let body = if expected == 403 {
            &stranger_put
        } else {
            &put1
        };
        assert_eq!(http(p, "PUT", &owner_path, credentials, body).0, expected);
    }
    // Cookie writes need CSRF; a claimed client type is not a bypass.
    for client in [
        "",
        "x-passshare-client: mobile\r\n",
        "x-passshare-client: extension\r\n",
    ] {
        assert_eq!(
            http(
                p,
                "PUT",
                &owner_path,
                &format!("Cookie: passshare_session={refresh}\r\n{client}"),
                &put1
            )
            .0,
            403
        );
    }
    assert_eq!(
        http(p, "GET", &owner_path, &headers, &Value::Null).0,
        404,
        "missing bundle"
    );
    for pointer in ["/bundle", "/bundle/wrapped", "/bundle/wrapped/context"] {
        for field in ["password", "key", "kdf"] {
            let mut bad = put1.clone();
            bad.pointer_mut(pointer).unwrap()[field] = json!("must-not-enter-storage");
            assert_eq!(http(p, "PUT", &owner_path, &headers, &bad).0, 400);
        }
    }
    for (pointer, value) in [
        ("/bundle/format", json!(2)),
        ("/bundle/salt", json!(BASE64.encode([1u8; 15]))),
        (
            "/bundle/wrapped/ciphertext",
            json!(BASE64.encode([0u8; 47])),
        ),
        (
            "/bundle/wrapped/context/passwordBoxId",
            json!(ConnectId::generate().unwrap()),
        ),
        ("/bundle/wrapped/context/ownerAccountId", json!(claimant)),
        ("/expectedVersion", json!(9_007_199_254_740_991u64)),
    ] {
        let mut bad = put1.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert_eq!(
            http(p, "PUT", &owner_path, &headers, &bad).0,
            400,
            "{pointer}"
        );
    }
    let other_epoch = json!({"expectedVersion":0,"bundle":owner_bundle(&key,&master,salt,&owner_context(&box_id,&owner_id,2))});
    let (status, rejection) = http(p, "PUT", &owner_path, &headers, &other_epoch);
    assert_eq!((status, &rejection["error"]), (409, &json!("PS056")));
    assert_eq!(
        http(p, "GET", &owner_path, &headers, &Value::Null).0,
        404,
        "rejections store nothing"
    );
    let csrf = ConnectId::generate().unwrap();
    let cookie_headers = format!(
        "Cookie: passshare_session={refresh}; passshare_csrf={csrf}\r\nx-csrf-token: {csrf}\r\n"
    );
    let (status, created) = http(p, "PUT", &owner_path, &cookie_headers, &put1);
    assert_eq!(status, 200);
    assert_eq!(created, json!({"bundleVersion":1,"bundle":bundle1}));
    let (status, fetched) = http(p, "GET", &owner_path, &headers, &Value::Null);
    assert_eq!((status, &fetched), (200, &created));
    let sdk_bundle = runtime
        .block_on(sdk.get_owner_key(&box_id, &owner_ctx))
        .unwrap();
    assert_eq!(sdk_bundle.bundle_version, 1);
    assert_eq!(serde_json::to_value(&sdk_bundle.bundle).unwrap(), bundle1);
    let sdk_replay = runtime
        .block_on(sdk.put_owner_key(&box_id, 0, &sdk_bundle.bundle, None))
        .unwrap_err();
    assert_eq!(sdk_replay.status(), Some(409));
    assert_eq!(sdk_replay.code(), Some("PS015"));
    let recovered = unwrap_bundle(&fetched["bundle"], &owner_password, &owner_ctx).unwrap();
    assert_eq!(
        recovered
            .decrypt_item(&serde_json::from_value(stored.clone()).unwrap(), &context)
            .unwrap(),
        item,
        "bundle unwraps to the key that decrypts the stored item"
    );
    let wrong_password = format!("incorrect-{}", ConnectId::generate().unwrap());
    assert!(unwrap_bundle(&fetched["bundle"], &wrong_password, &owner_ctx).is_err());
    assert!(unwrap_bundle(
        &fetched["bundle"],
        &owner_password,
        &owner_context(&box_id, &claimant, 1)
    )
    .is_err());
    let (status, replay) = http(p, "PUT", &owner_path, &headers, &put1);
    assert_eq!((status, &replay["error"]), (409, &json!("PS015")));
    let bundle2 = owner_bundle(&key, &master, salt, &owner_ctx);
    // A session alone must not replace the only key wrapper with structurally
    // valid garbage. Missing/wrong reauthentication leaves all bytes intact.
    let mut garbage = bundle2.clone();
    garbage["wrapped"]["ciphertext"] = json!(BASE64.encode([0u8; 48]));
    for body in [
        json!({"expectedVersion":1,"bundle":garbage}),
        json!({"expectedVersion":1,"bundle":garbage,"currentPassword":format!("wrong-{}",ConnectId::generate().unwrap())}),
    ] {
        let (status, error) = http(p, "PUT", &owner_path, &headers, &body);
        assert_eq!((status, &error["error"]), (401, &json!("PS026")));
        assert_eq!(
            http(p, "GET", &owner_path, &headers, &Value::Null).1,
            created
        );
    }
    let (status, updated) = http(
        p,
        "PUT",
        &owner_path,
        &headers,
        &json!({"expectedVersion":1,"bundle":bundle2,"currentPassword":auth_password}),
    );
    assert_eq!(
        (status, &updated),
        (200, &json!({"bundleVersion":2,"bundle":bundle2}))
    );
    assert_eq!(http(p, "PUT", &owner_path, &headers, &put1).0, 409);
    assert_eq!(
        http(
            p,
            "PUT",
            &owner_path,
            &headers,
            &json!({"expectedVersion":1,"bundle":bundle1,"currentPassword":auth_password})
        )
        .0,
        409,
        "stale update preserves the current bundle"
    );
    assert_eq!(
        http(p, "GET", &owner_path, &headers, &Value::Null).1,
        updated
    );
    let bundle3 = owner_bundle(&key, &master, salt, &owner_ctx);
    let contenders: Vec<_> = (0..4)
        .map(|_| {
            let (h, path) = (headers.clone(), owner_path.clone());
            let body =
                json!({"expectedVersion":2,"bundle":bundle3,"currentPassword":auth_password});
            thread::spawn(move || http(p, "PUT", &path, &h, &body).0)
        })
        .collect();
    let statuses: Vec<_> = contenders.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(statuses.iter().filter(|s| **s == 200).count(), 1);
    assert_eq!(statuses.iter().filter(|s| **s == 409).count(), 3);
    let current_bundle = json!({"bundleVersion":3,"bundle":bundle3});
    assert_eq!(
        http(p, "GET", &owner_path, &headers, &Value::Null).1,
        current_bundle
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_owner_keys WHERE bundle::text LIKE '%{owner_password}%'"
        )),
        "0"
    );
    // Unconfirmed membership cannot read; confirmed membership can read but
    // cannot enable. This fixture never sends or stores a box key on the host.
    db.sql(&format!("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES('{claimant}','{box_id}','member')"));
    assert_eq!(
        http(p, "GET", &path, &stranger_headers, &Value::Null).0,
        403
    );
    db.sql(&format!("UPDATE vault_memberships SET confirmed_at=NOW() WHERE user_id='{claimant}' AND vault_id='{box_id}'"));
    assert_eq!(
        http(p, "GET", &path, &stranger_headers, &Value::Null).0,
        200
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &stranger_headers,
            &json!({"keyEpoch":1})
        )
        .0,
        403
    );
    // A confirmed non-owner member can neither read nor write an owner bundle.
    let member_put = json!({"expectedVersion":0,"bundle":owner_bundle(&key,&master,salt,&owner_context(&box_id,&claimant,1))});
    assert_eq!(
        http(p, "GET", &owner_path, &stranger_headers, &Value::Null).0,
        403
    );
    assert_eq!(
        http(p, "PUT", &owner_path, &stranger_headers, &member_put).0,
        403
    );
    // Ownership transfer: the previous owner loses access and the new owner never
    // sees the previous bundle. The new owner must wrap a key it already holds.
    let swap = |new: &str, authorization: &str, password: &str| {
        assert_eq!(
            http(
                p,
                "POST",
                &format!("/api/auth/vaults/{box_id}/ownership"),
                authorization,
                &json!({"currentPassword":password,"targetUserId":new})
            )
            .0,
            204,
            "formal ownership transfer must succeed before testing key access"
        );
    };
    swap(&claimant, &headers, &auth_password);
    assert_eq!(http(p, "GET", &owner_path, &headers, &Value::Null).0, 403);
    let old_put = json!({"expectedVersion":3,"bundle":owner_bundle(&key,&master,salt,&owner_ctx),"currentPassword":auth_password});
    assert_eq!(http(p, "PUT", &owner_path, &headers, &old_put).0, 403);
    assert_eq!(
        http(p, "GET", &owner_path, &stranger_headers, &Value::Null).0,
        404
    );
    assert_eq!(
        http(
            p,
            "PUT",
            &owner_path,
            &stranger_headers,
            &json!({"expectedVersion":0,"bundle":bundle1})
        )
        .0,
        400,
        "another owner's context is refused"
    );
    let new_password = format!(
        "synthetic-owner-password-{}",
        ConnectId::generate().unwrap()
    );
    let new_salt = generate_salt().unwrap();
    let new_ctx = owner_context(&box_id, &claimant, 1);
    let new_bundle = owner_bundle(
        &key,
        &owner_master(&new_password, &new_salt).unwrap(),
        new_salt,
        &new_ctx,
    );
    let (status, new_created) = http(
        p,
        "PUT",
        &owner_path,
        &stranger_headers,
        &json!({"expectedVersion":0,"bundle":new_bundle}),
    );
    assert_eq!(
        (status, &new_created),
        (200, &json!({"bundleVersion":1,"bundle":new_bundle}))
    );
    assert_eq!(
        http(p, "GET", &owner_path, &stranger_headers, &Value::Null).1,
        new_created
    );
    assert!(
        unwrap_bundle(&new_created["bundle"], &new_password, &new_ctx)
            .unwrap()
            .decrypt_item(&serde_json::from_value(stored.clone()).unwrap(), &context)
            .is_ok()
    );
    swap(&owner_id, &stranger_headers, &stranger_auth_password);
    // Formal ownership transfer revokes old Connect tokens. Refresh through
    // the real auth API before asserting the legacy ciphertext boundary.
    let (status, refreshed) = http(
        p,
        "POST",
        "/api/auth/token/refresh",
        "",
        &json!({"refreshToken":refresh}),
    );
    assert_eq!(
        status, 200,
        "new live Connect token after ownership transfer"
    );
    connect_headers = format!(
        "Authorization: Bearer {}\r\n",
        refreshed["connectAccessToken"].as_str().unwrap()
    );
    assert_eq!(
        http(p, "GET", &owner_path, &headers, &Value::Null).1,
        current_bundle,
        "owner bundle survives transfer and return untouched"
    );
    db.sql(&format!(
        "DELETE FROM vault_memberships WHERE user_id='{claimant}' AND vault_id='{box_id}'"
    ));
    assert_eq!(
        http(p, "GET", &path, &stranger_headers, &Value::Null).0,
        403
    );
    assert_eq!(
        http(p, "GET", &owner_path, &stranger_headers, &Value::Null).0,
        403
    );
    for (pointer, value) in [
        ("/envelope/format", json!(2)),
        ("/envelope/nonce", json!("bad")),
        (
            "/envelope/context/passwordBoxId",
            json!(ConnectId::generate().unwrap()),
        ),
        (
            "/envelope/context/itemId",
            json!(ConnectId::generate().unwrap()),
        ),
        ("/envelope/context/itemVersion", json!(3)),
        ("/envelope/ciphertext", json!("malformed")),
    ] {
        let mut bad = payload.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert_eq!(http(p, "PUT", &path, &headers, &bad).0, 400, "{pointer}");
        assert_eq!(
            http(p, "GET", &path, &headers, &Value::Null).1,
            stored,
            "rejection preserves original"
        );
    }
    let mut generation = payload.clone();
    generation["expectedVersion"] = json!(1);
    generation["envelope"]["context"]["itemVersion"] = json!(2);
    generation["envelope"]["context"]["keyEpoch"] = json!(2);
    let (status, rejection) = http(p, "PUT", &path, &headers, &generation);
    assert_eq!(status, 409);
    assert_eq!(rejection["error"], "PS056");
    let mut next = context.clone();
    next.item_version = 2;
    let mut next_item = item.clone();
    next_item["version"] = json!(2);
    next_item["title"] = json!("Updated client title");
    // Different prepared ciphertexts must still compete through CAS. Identical
    // prepared requests are exercised separately by accept_encrypted_put_replay.
    let candidates = (0..4)
        .map(|_| key.encrypt_item(&next_item, &next).unwrap())
        .collect::<Vec<_>>();
    for (index, candidate) in candidates.iter().enumerate() {
        assert!(candidates[..index].iter().all(|other| other != candidate));
    }
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(5));
    let workers: Vec<_> = candidates
        .into_iter()
        .map(|candidate| {
            let h = headers.clone();
            let path = path.clone();
            let barrier = barrier.clone();
            let body = json!({"expectedVersion":1,"envelope":candidate});
            thread::spawn(move || {
                barrier.wait();
                (http(p, "PUT", &path, &h, &body), candidate)
            })
        })
        .collect();
    barrier.wait();
    let outcomes: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(
        outcomes.iter().filter(|(reply, _)| reply.0 == 200).count(),
        1
    );
    assert_eq!(
        outcomes.iter().filter(|(reply, _)| reply.0 == 409).count(),
        3
    );
    for (reply, _) in outcomes.iter().filter(|(reply, _)| reply.0 == 409) {
        assert_eq!(reply.1["error"], "PS015");
    }
    let (reply, next_envelope) = outcomes
        .into_iter()
        .find(|(reply, _)| reply.0 == 200)
        .unwrap();
    assert_eq!(reply.1, serde_json::to_value(&next_envelope).unwrap());
    assert_eq!(
        http(p, "GET", &format!("{root}/items"), &headers, &Value::Null).1["items"],
        json!([{"itemId":context.item_id,"itemVersion":2,"keyEpoch":1}])
    );
    assert_eq!(
        http(
            p,
            "GET",
            &format!("{root}/items?after={}", context.item_id),
            &headers,
            &Value::Null
        )
        .1["items"],
        json!([])
    );
    // Host rejects old reads/import/forms/files, including encoded/case aliases.
    for path in [
        format!("/v1/vaults/{box_id}/items"),
        format!(
            "/v1/vaults/%{:02x}{}/items",
            box_id.as_bytes()[0],
            &box_id[1..]
        ),
        format!("/V1/VAULTS/{box_id}/ITEMS/"),
        format!("/v1/vaults/{box_id}/imports/1pux"),
        format!("/v1/vaults/{box_id}/items/{}/form", context.item_id),
        format!("/v1/vaults/{box_id}/items/{}/files", context.item_id),
    ] {
        assert_eq!(http(p, "GET", &path, &connect_headers, &Value::Null).0, 409);
        assert_eq!(
            http(
                p,
                "POST",
                &path,
                &connect_headers,
                &json!({"title":"Plaintext"})
            )
            .0,
            409
        );
    }
    // Verify the DB itself rejects old writes when middleware is bypassed.
    let denied = command("docker")
        .args([
            "exec",
            &db.name,
            "psql",
            "-X",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "passshare",
            "-d",
            "passshare",
            "-c",
            &format!(
                "INSERT INTO connect_items(id,vault_id,document) VALUES('{}','{box_id}','{{}}')",
                ConnectId::generate().unwrap()
            ),
        ])
        .output()
        .unwrap();
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("PS055"));
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM connect_items WHERE vault_id='{box_id}'"
        )),
        "0"
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT envelope::text FROM encrypted_items WHERE box_id='{box_id}' AND item_id='{}'",
            context.item_id
        ))
        .parse::<Value>()
        .unwrap(),
        serde_json::to_value(&next_envelope).unwrap()
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_items WHERE envelope::text LIKE '%{}%'",
            item["fields"][0]["value"].as_str().unwrap()
        )),
        "0"
    );
    // A nonempty compatibility box remains usable, and activation fails intact.
    let (compat_refresh, compat_connect, compat_box) = signup(p);
    let compat_path = format!("/v1/vaults/{compat_box}/items");
    assert_eq!(
        http(
            p,
            "POST",
            &compat_path,
            &format!("Authorization: Bearer {compat_connect}\r\n"),
            &json!({"title":"Compatibility fixture","category":"LOGIN"})
        )
        .0,
        201
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("/api/encrypted/boxes/{compat_box}/enable"),
            &format!("Authorization: Bearer {compat_refresh}\r\n"),
            &json!({"keyEpoch":1})
        )
        .0,
        409
    );
    assert_eq!(
        http(
            p,
            "GET",
            &compat_path,
            &format!("Authorization: Bearer {compat_connect}\r\n"),
            &Value::Null
        )
        .1
        .as_array()
        .unwrap()
        .len(),
        1
    );
    // An empty second box races activation with the old plaintext writer. No
    // schedule may commit BOTH modes. Each run owns an empty fresh DB, so the
    // ordinary signup limit is kept intact (five registrations total).
    let (race_refresh, race_connect, race_box) = signup(p);
    let race_enable = format!("/api/encrypted/boxes/{race_box}/enable");
    let race_legacy = format!("/v1/vaults/{race_box}/items");
    let enabling = thread::spawn(move || {
        http(
            p,
            "POST",
            &race_enable,
            &format!("Authorization: Bearer {race_refresh}\r\n"),
            &json!({"keyEpoch":1}),
        )
        .0
    });
    let writing = thread::spawn(move || {
        http(
            p,
            "POST",
            &race_legacy,
            &format!("Authorization: Bearer {race_connect}\r\n"),
            &json!({"title":"Race fixture","category":"LOGIN"}),
        )
        .0
    });
    let enabled = enabling.join().unwrap();
    let written = writing.join().unwrap();
    assert!(
        (enabled == 200 && written == 409) || (enabled == 409 && written == 201),
        "activation/legacy race: {enabled}/{written}"
    );
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_box_state WHERE box_id='{race_box}')+(SELECT count(*) FROM connect_items WHERE vault_id='{race_box}')")),"1");
    // Account retirement deletes private boxes. Both levels cascade without
    // purging another box. There is no separate memory map to purge.
    let (private_refresh, _, private_box) = signup(p);
    let private_headers = format!("Authorization: Bearer {private_refresh}\r\n");
    let private_root = format!("/api/encrypted/boxes/{private_box}");
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{private_root}/enable"),
            &private_headers,
            &json!({"keyEpoch":1})
        )
        .0,
        200
    );
    let private_context = ItemContext {
        password_box_id: private_box.parse().unwrap(),
        ..context.clone()
    };
    let mut private_item = item.clone();
    private_item["vault"]["id"] = json!(private_box);
    assert_eq!(http(p,"PUT",&format!("{private_root}/items/{}",context.item_id),&private_headers,
        &json!({"expectedVersion":0,"envelope":key.encrypt_item(&private_item,&private_context).unwrap()})).0,200);
    let private_owner = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{private_box}'"
    ));
    assert_eq!(
        http(
            p,
            "PUT",
            &format!("{private_root}/owner-key"),
            &private_headers,
            &json!({"expectedVersion":0,"bundle":owner_bundle(&key,&master,salt,&owner_context(&private_box,&private_owner,1))})
        )
        .0,
        200
    );
    assert_eq!(
        http_bytes(
            p,
            "DELETE",
            &format!("{private_root}/items/{}", context.item_id),
            &private_headers,
            &json!({"expectedVersion":1,"keyEpoch":1})
        ),
        (204, Vec::new())
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{private_box}'"
        )),
        "1"
    );
    let retained_context = ItemContext {
        item_id: ConnectId::generate().unwrap(),
        ..private_context.clone()
    };
    private_item["id"] = json!(retained_context.item_id);
    assert_eq!(http(p,"PUT",&format!("{private_root}/items/{}",retained_context.item_id),&private_headers,
        &json!({"expectedVersion":0,"envelope":key.encrypt_item(&private_item,&retained_context).unwrap()})).0,200);
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_items WHERE box_id='{private_box}')::text || ':' || (SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{private_box}')::text")),"1:1", "both live ciphertext and deletion metadata must exist before cascade");
    db.sql(&format!(
        "DELETE FROM connect_vaults WHERE id='{private_box}'"
    ));
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_box_state WHERE box_id='{private_box}')+(SELECT count(*) FROM encrypted_items WHERE box_id='{private_box}')+(SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{private_box}')+(SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{private_box}')")),"0");
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_items WHERE box_id='{box_id}'"
        )),
        "1"
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{box_id}'"
        )),
        "2",
        "another box's owner bundles are retained"
    );
    // Restart proves persistence; client decrypts the unchanged opaque body.
    drop(host);
    host = Host::with_storage(db, network, mode, false);
    assert_eq!(
        http_bytes(host.port, "GET", &path, &headers, &Value::Null).0,
        404
    );
    assert_eq!(
        http_bytes(host.port, "GET", &owner_path, &headers, &Value::Null).0,
        404,
        "owner key API is disabled with the encrypted storage flag"
    );
    assert_eq!(
        http(
            host.port,
            "GET",
            &format!("/v1/vaults/{box_id}/items"),
            &connect_headers,
            &Value::Null
        )
        .0,
        409,
        "disabled storage cannot make an encrypted box look empty"
    );
    drop(host);
    host = Host::start(db, network, mode);
    let restored = http(host.port, "GET", &path, &headers, &Value::Null);
    assert_eq!(restored.0, 200);
    assert_eq!(
        key.decrypt_item(&serde_json::from_value(restored.1).unwrap(), &next)
            .unwrap(),
        next_item
    );
    // The bundle is durable across restart and still unwraps to the item key.
    let restored_bundle = http(host.port, "GET", &owner_path, &headers, &Value::Null);
    assert_eq!(
        (restored_bundle.0, &restored_bundle.1),
        (200, &current_bundle)
    );
    assert_eq!(
        unwrap_bundle(&restored_bundle.1["bundle"], &owner_password, &owner_ctx)
            .unwrap()
            .decrypt_item(&next_envelope, &next)
            .unwrap(),
        next_item
    );
    // Deleting an account removes only its own bundles.
    db.sql(&format!("DELETE FROM users WHERE id='{claimant}'"));
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{box_id}'"
        )),
        "1"
    );
    // Session/membership revocation is checked against live DB state.
    db.sql(&format!(
        "DELETE FROM vault_memberships WHERE vault_id='{box_id}'"
    ));
    assert_eq!(http(host.port, "GET", &path, &headers, &Value::Null).0, 403);
    assert_eq!(
        http(host.port, "GET", &owner_path, &headers, &Value::Null).0,
        403
    );
    assert_eq!(http(host.port, "PUT", &owner_path, &headers, &put1).0, 403);
    let committed_payload = json!({"expectedVersion":1,"envelope":next_envelope});
    let committed_snapshot = || {
        db.sql(&format!(
            "SELECT to_jsonb(i)::text FROM encrypted_items i WHERE box_id='{box_id}' AND item_id='{}'",
            context.item_id
        ))
    };
    let committed_row = committed_snapshot();
    assert_eq!(
        http(host.port, "PUT", &path, &headers, &committed_payload).0,
        403
    );
    assert_eq!(committed_snapshot(), committed_row);
    db.sql("DELETE FROM sessions");
    assert_eq!(http(host.port, "GET", &path, &headers, &Value::Null).0, 401);
    assert_eq!(
        http(host.port, "PUT", &path, &headers, &committed_payload).0,
        401
    );
    assert_eq!(committed_snapshot(), committed_row);
    assert_eq!(
        http(host.port, "GET", &owner_path, &headers, &Value::Null).0,
        401
    );
    println!("encrypted storage acceptance: Core roundtrip, rejection preservation, CAS 1/4, epoch, scope, confirmed membership, CSRF, host/DB plaintext boundary, compatibility/activation race, restart, revocation, private-box cascade, and owner key bundle unwrap/CAS/transfer/restart/cascade passed");
}

fn accept_encrypted_put_replay(
    db: &Database,
    p: u16,
    credentials: (&str, &str, &str, &str),
    original_context: &ItemContext,
    original_item: &Value,
    key: &PasswordBoxKey,
) {
    let (session, connect, member_session, member_box) = credentials;
    let box_id = original_context.password_box_id.as_str();
    let headers = format!("Authorization: Bearer {session}\r\n");
    let member_headers = format!("Authorization: Bearer {member_session}\r\n");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let base = format!("http://127.0.0.1:{p}");
    let sdk = passshare_connect::EncryptedSessionClient::new(&base, session).unwrap();
    let member_sdk = passshare_connect::EncryptedSessionClient::new(&base, member_session).unwrap();
    let mut context = ItemContext {
        item_id: ConnectId::generate().unwrap(),
        ..original_context.clone()
    };
    let item_id = context.item_id.as_str().to_owned();
    let race_id = ConnectId::generate().unwrap();
    let path = format!("/api/encrypted/boxes/{box_id}/items/{item_id}");
    let snapshot = |id: &str| {
        db.sql(&format!(
            "SELECT jsonb_build_object('row',to_jsonb(i),'xmin',i.xmin::text)::text FROM encrypted_items i WHERE box_id='{box_id}' AND item_id='{id}'"
        ))
    };
    let actor = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner'"
    ));
    let session_id = db.sql(&format!(
        "SELECT id::text FROM sessions WHERE user_id='{actor}' ORDER BY created_at LIMIT 1"
    ));
    let member = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{member_box}' AND role='owner'"
    ));
    let csrf = ConnectId::generate().unwrap();
    let cookie = format!(
        "Cookie: passshare_session={session}; passshare_csrf={csrf}\r\nx-csrf-token: {csrf}\r\n"
    );
    let mut item = original_item.clone();
    item["id"] = json!(item_id);
    if item.get("attachments").is_none() {
        item["attachments"] =
            json!([{"id":"synthetic-replay-attachment","name":"retained.bin","size":3}]);
    }
    if item.get("payload").is_none() {
        item["payload"] = json!({"ordered":[3,1,2],"unknown":{"null":null,"value":ConnectId::generate().unwrap()}});
    }

    // Synthetic fixture instrumentation: fail any redundant UPDATE, even if
    // it writes the same timestamp/values. No ledger or additional table is used.
    // Real version advances are allowed; exact replay must never reach UPDATE.
    db.sql(&format!("CREATE FUNCTION passshare_put_replay_write_fault() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic redundant replay update'; END $$; CREATE TRIGGER passshare_put_replay_write_fault BEFORE UPDATE ON encrypted_items FOR EACH ROW WHEN (OLD.box_id='{box_id}' AND OLD.item_id IN ('{item_id}','{race_id}') AND OLD.revision=NEW.revision) EXECUTE FUNCTION passshare_put_replay_write_fault();"));
    let mut first_payload = Value::Null;
    let mut last_payload = Value::Null;
    for version in [1, 2] {
        context.item_version = version;
        item["version"] = json!(version);
        item["title"] = json!(format!("Full DTO replay version {version}"));
        let envelope = key.encrypt_item(&item, &context).unwrap();
        let public = serde_json::to_value(&envelope).unwrap();
        let payload = json!({"expectedVersion":version-1,"envelope":public});
        // A different confirmed writer commits version 2. The original actor
        // may replay the identical stored public envelope regardless of author.
        let writer = if version == 1 { &sdk } else { &member_sdk };
        assert_eq!(
            runtime
                .block_on(writer.put_item(box_id, &item_id, version - 1, &envelope))
                .unwrap(),
            envelope
        );
        let before = snapshot(&item_id);
        if version == 1 {
            // Verify the fixture observer is armed; only its exact injected
            // error is accepted, and the redundant write must roll back.
            db.sql(&format!("DO $$ BEGIN BEGIN UPDATE encrypted_items SET revision=revision WHERE box_id='{box_id}' AND item_id='{item_id}'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='synthetic redundant replay update' THEN RETURN; END IF; RAISE; END; RAISE EXCEPTION 'replay write observer did not fire'; END $$;"));
            assert_eq!(snapshot(&item_id), before);
        }
        let row: Value = serde_json::from_str(&before).unwrap();
        assert_eq!(row["row"]["revision"], version);
        assert_eq!(row["row"]["key_epoch"], 1);
        assert_eq!(row["row"]["envelope"], public);
        assert!(row["row"]["updated_at"].as_str().is_some());
        assert_eq!(
            runtime
                .block_on(sdk.put_item(box_id, &item_id, version - 1, &envelope))
                .unwrap(),
            envelope
        );
        let fetched = runtime.block_on(sdk.get_item(box_id, &item_id)).unwrap();
        assert_eq!(fetched, envelope);
        assert_eq!(key.decrypt_item(&fetched, &context).unwrap(), item);
        assert_eq!(
            http(p, "GET", &path, &headers, &Value::Null),
            (200, public.clone())
        );
        assert_eq!(
            snapshot(&item_id),
            before,
            "SDK replay preserves updated_at and xmin"
        );

        // Serialize in a different order on the wire, including context keys.
        // A Value-only comparison would never exercise JSONB normalization.
        let reordered = format!(
            "{{ \"envelope\": {{ \"nonce\": {}, \"format\": 1, \"context\": {{ \"passwordBoxId\": {}, \"keyEpoch\": 1, \"itemVersion\": {version}, \"itemId\": {} }}, \"ciphertext\": {} }}, \"expectedVersion\": {} }}",
            public["nonce"],
            public["context"]["passwordBoxId"],
            public["context"]["itemId"],
            public["ciphertext"],
            version - 1
        );
        assert_ne!(reordered, payload.to_string());
        assert_eq!(serde_json::from_str::<Value>(&reordered).unwrap(), payload);
        let (status, bytes) = http_payload(p, "PUT", &path, &cookie, &reordered);
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), public);
        assert_eq!(
            snapshot(&item_id),
            before,
            "JSONB replay does not update the row"
        );

        let reject = |body: &Value, status, code| {
            let reply = http(p, "PUT", &path, &headers, body);
            assert_eq!((reply.0, reply.1["error"].as_str()), (status, Some(code)));
            assert_eq!(
                snapshot(&item_id),
                before,
                "rejection preserves the full row and time"
            );
            assert_eq!(
                http(p, "GET", &path, &headers, &Value::Null),
                (200, public.clone())
            );
        };
        // Canonical, same-length encodings differing in just one public value.
        for field in ["nonce", "ciphertext"] {
            let mut changed = payload.clone();
            let mut bytes = BASE64.decode(public[field].as_str().unwrap()).unwrap();
            bytes[0] ^= 1;
            changed["envelope"][field] = json!(BASE64.encode(bytes));
            reject(&changed, 409, "PS015");
        }
        let fresh = key.encrypt_item(&item, &context).unwrap();
        assert_ne!(fresh, envelope);
        reject(
            &json!({"expectedVersion":version-1,"envelope":fresh}),
            409,
            "PS015",
        );
        let mut different_item = item.clone();
        different_item["title"] = json!("Different full DTO at the same revision");
        let different_body = key.encrypt_item(&different_item, &context).unwrap();
        reject(
            &json!({"expectedVersion":version-1,"envelope":different_body}),
            409,
            "PS015",
        );
        if version == 2 {
            reject(&first_payload, 409, "PS015");
        }
        let mut other_epoch = payload.clone();
        other_epoch["envelope"]["context"]["keyEpoch"] = json!(2);
        reject(&other_epoch, 409, "PS056");
        for (pointer, value) in [
            ("/expectedVersion", json!(version)),
            ("/expectedVersion", json!("0")),
            ("/envelope/format", json!(2)),
            ("/envelope/format", json!("1")),
            ("/envelope/context/itemVersion", json!("1")),
            ("/envelope/context/keyEpoch", json!(0)),
            (
                "/envelope/context/itemId",
                json!(ConnectId::generate().unwrap()),
            ),
            (
                "/envelope/context/passwordBoxId",
                json!(ConnectId::generate().unwrap()),
            ),
            ("/envelope/nonce", json!("bad")),
            ("/envelope/ciphertext", json!("malformed")),
        ] {
            let mut bad = payload.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            reject(&bad, 400, "PS051");
        }
        for pointer in ["", "/envelope", "/envelope/context"] {
            let mut bad = payload.clone();
            bad.pointer_mut(pointer).unwrap()["plaintext"] = json!("forbidden");
            reject(&bad, 400, "PS051");
        }
        for (credentials, status) in [
            (String::new(), 401),
            (format!("Authorization: Bearer {connect}\r\n"), 401),
            (format!("Cookie: passshare_session={session}\r\n"), 403),
            (
                format!("Cookie: passshare_session={session}\r\nx-passshare-client: mobile\r\n"),
                403,
            ),
            (
                format!("Cookie: passshare_session={session}\r\nx-passshare-client: extension\r\n"),
                403,
            ),
        ] {
            assert_eq!(http(p, "PUT", &path, &credentials, &payload).0, status);
            assert_eq!(snapshot(&item_id), before);
        }

        // Synthetic active-epoch change: an otherwise exact old envelope is
        // rejected before replay recognition. This does not implement rotation.
        db.sql(&format!(
            "UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id='{box_id}'"
        ));
        reject(&payload, 409, "PS056");
        db.sql(&format!(
            "UPDATE encrypted_box_state SET key_epoch=1 WHERE box_id='{box_id}'"
        ));

        // Exercise the authoritative DB checks on a validated exact envelope,
        // independently of the HTTP middleware. Fixture changes roll back.
        let sql_body = public.to_string().replace('\'', "''");
        let operation = format!("SELECT passshare_encrypted_operation('{actor}','{session_id}','{box_id}','put','{item_id}',{},'{sql_body}'::jsonb,1)", version - 1);
        for (mutation, status, code) in [
            (
                format!("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id='{session_id}'"),
                401,
                "PS024",
            ),
            (
                format!("DELETE FROM sessions WHERE id='{session_id}'"),
                401,
                "PS024",
            ),
            (
                format!("DELETE FROM vault_memberships WHERE user_id='{actor}' AND vault_id='{box_id}'"),
                403,
                "PS016",
            ),
        ] {
            let reply: Value = serde_json::from_str(
                &db.sql(&format!("BEGIN; {mutation}; {operation}; ROLLBACK;")),
            )
            .unwrap();
            assert_eq!(
                (reply["status"].as_u64(), reply["code"].as_str()),
                (Some(status), Some(code))
            );
            assert_eq!(snapshot(&item_id), before);
        }
        if version == 1 {
            assert_eq!(http(p, "PUT", &path, &member_headers, &payload).0, 403);
            db.sql(&format!("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES('{member}','{box_id}','member')"));
            assert_eq!(http(p, "PUT", &path, &member_headers, &payload).0, 403);
            db.sql(&format!("UPDATE vault_memberships SET confirmed_at=NOW(),role='viewer' WHERE user_id='{member}' AND vault_id='{box_id}'"));
            let reply = http(p, "PUT", &path, &member_headers, &payload);
            assert_eq!((reply.0, reply.1["error"].as_str()), (403, Some("PS032")));
            db.sql(&format!("UPDATE vault_memberships SET role='member' WHERE user_id='{member}' AND vault_id='{box_id}'"));
            assert_eq!(
                http(p, "PUT", &path, &member_headers, &payload),
                (200, public.clone())
            );
            assert_eq!(snapshot(&item_id), before);
            first_payload = payload.clone();
        } else {
            db.sql(&format!(
                "DELETE FROM vault_memberships WHERE user_id='{member}' AND vault_id='{box_id}'"
            ));
            assert_eq!(http(p, "PUT", &path, &member_headers, &payload).0, 403);
            assert_eq!(
                snapshot(&item_id),
                before,
                "removed writer cannot replay its own envelope"
            );
        }
        last_payload = payload;
    }

    // Identical prepared create AND update requests start at one barrier. This
    // synchronizes HTTP request starts, not observation of a DB lock waiter.
    // The synthetic trigger above detects a second UPDATE even if snapshots
    // would otherwise miss a fast redundant write before either response.
    let race_path = format!("/api/encrypted/boxes/{box_id}/items/{race_id}");
    let mut race_context = ItemContext {
        item_id: race_id,
        ..original_context.clone()
    };
    item["id"] = json!(race_context.item_id);
    for version in [1, 2] {
        race_context.item_version = version;
        item["version"] = json!(version);
        let envelope = key.encrypt_item(&item, &race_context).unwrap();
        let public = serde_json::to_value(&envelope).unwrap();
        let payload = json!({"expectedVersion":version-1,"envelope":public});
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let requests = (0..2)
            .map(|_| {
                let barrier = barrier.clone();
                let path = race_path.clone();
                let headers = headers.clone();
                let body = payload.clone();
                thread::spawn(move || {
                    barrier.wait();
                    http(p, "PUT", &path, &headers, &body)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        for request in requests {
            assert_eq!(request.join().unwrap(), (200, public.clone()));
        }
        assert_eq!(
            db.sql(&format!(
                "SELECT count(*) FROM encrypted_items WHERE box_id='{box_id}' AND item_id='{}'",
                race_context.item_id
            )),
            "1"
        );
        let before = snapshot(race_context.item_id.as_str());
        let row: Value = serde_json::from_str(&before).unwrap();
        assert_eq!(row["row"]["revision"], version);
        assert_eq!(row["row"]["key_epoch"], 1);
        assert_eq!(row["row"]["envelope"], public);
        assert!(row["row"]["updated_at"].as_str().is_some());
        let fetched = runtime
            .block_on(sdk.get_item(box_id, race_context.item_id.as_str()))
            .unwrap();
        assert_eq!(fetched, envelope);
        assert_eq!(key.decrypt_item(&fetched, &race_context).unwrap(), item);
        assert_eq!(
            http(p, "GET", &race_path, &headers, &Value::Null),
            (200, public.clone())
        );
        assert_eq!(
            http(p, "PUT", &race_path, &headers, &payload),
            (200, public)
        );
        assert_eq!(snapshot(race_context.item_id.as_str()), before);
    }
    db.sql("DROP TRIGGER passshare_put_replay_write_fault ON encrypted_items; DROP FUNCTION passshare_put_replay_write_fault();");
    runtime
        .block_on(sdk.delete_item(box_id, &item_id, 2, 1))
        .unwrap();
    let tombstone = db.sql(&format!("SELECT to_jsonb(t)::text FROM encrypted_item_tombstones t WHERE box_id='{box_id}' AND item_id='{item_id}'"));
    for payload in [&first_payload, &last_payload] {
        let reply = http(p, "PUT", &path, &headers, payload);
        assert_eq!((reply.0, reply.1["error"].as_str()), (409, Some("PS015")));
        assert!(snapshot(&item_id).is_empty());
        assert_eq!(db.sql(&format!("SELECT to_jsonb(t)::text FROM encrypted_item_tombstones t WHERE box_id='{box_id}' AND item_id='{item_id}'")), tombstone);
    }
    let error = runtime
        .block_on(sdk.get_item(box_id, &item_id))
        .unwrap_err();
    assert_eq!((error.status(), error.code()), (Some(404), Some("PS012")));
    runtime
        .block_on(sdk.delete_item(box_id, race_context.item_id.as_str(), 2, 1))
        .unwrap();
    println!("encrypted PUT replay: full Core DTO create/update, SDK/JSONB replay without writes/time changes, different ciphertext/nonce CAS, later writer rejection, auth/CSRF/live DB guards, barrier-started identical create/update, and deleted ID rejection passed");
}

fn accept_encrypted_delete(
    db: &Database,
    p: u16,
    credentials: (&str, &str, &str, &str),
    original_context: &ItemContext,
    original_item: &Value,
    key: &PasswordBoxKey,
) {
    let (session, connect, stranger, stranger_box) = credentials;
    let box_id = original_context.password_box_id.as_str();
    let root = format!("/api/encrypted/boxes/{box_id}");
    let headers = format!("Authorization: Bearer {session}\r\n");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let sdk =
        passshare_connect::EncryptedSessionClient::new(&format!("http://127.0.0.1:{p}"), session)
            .unwrap();
    // Retain the complete original DTO and arbitrary nested values. Every new
    // nonce/key is generated by real Core, never reused static ciphertext.
    let context = ItemContext {
        item_id: ConnectId::generate().unwrap(),
        ..original_context.clone()
    };
    let item_id = context.item_id.as_str();
    let path = format!("{root}/items/{item_id}");
    let mut item = original_item.clone();
    item["id"] = json!(item_id);
    if item.get("attachments").is_none() {
        item["attachments"] = json!([{"id":"synthetic-attachment","name":"retained.bin","size":3}]);
    }
    if item.get("payload").is_none() {
        item["payload"] = json!({"ordered":[3,1,2],"unknown":{"null":null,"value":ConnectId::generate().unwrap()}});
    }
    let envelope = key.encrypt_item(&item, &context).unwrap();
    runtime
        .block_on(sdk.put_item(box_id, item_id, 0, &envelope))
        .unwrap();
    let fetched = runtime.block_on(sdk.get_item(box_id, item_id)).unwrap();
    assert_eq!(key.decrypt_item(&fetched, &context).unwrap(), item);
    let deletion = json!({"expectedVersion":1,"keyEpoch":1});
    let live_snapshot = || {
        db.sql(&format!(
        "SELECT to_jsonb(i)::text FROM encrypted_items i WHERE box_id='{box_id}' AND item_id='{item_id}'"
    ))
    };
    let before = live_snapshot();
    let reject = |body: &Value, status, code| {
        let reply = http(p, "DELETE", &path, &headers, body);
        assert_eq!(reply.0, status);
        assert_eq!(reply.1["error"], code);
        assert_eq!(
            live_snapshot(),
            before,
            "rejection must preserve the complete ciphertext row"
        );
    };
    reject(&json!({"expectedVersion":2,"keyEpoch":1}), 409, "PS015");
    reject(&json!({"expectedVersion":1,"keyEpoch":2}), 409, "PS056");
    for body in [
        json!({"expectedVersion":0,"keyEpoch":1}),
        json!({"expectedVersion":9007199254740992u64,"keyEpoch":1}),
        json!({"expectedVersion":1,"keyEpoch":0}),
        json!({"expectedVersion":1,"keyEpoch":9007199254740992u64}),
        json!({"expectedVersion":"1","keyEpoch":1}),
        json!({"expectedVersion":1,"keyEpoch":true}),
        json!({"expectedVersion":1}),
        json!({"expectedVersion":1,"keyEpoch":1,"envelope":envelope}),
        json!({"expectedVersion":1,"keyEpoch":1,"plaintext":"forbidden"}),
    ] {
        reject(&body, 400, "PS051");
    }
    for (credentials, status) in [
        (String::new(), 401),
        (format!("Authorization: Bearer {connect}\r\n"), 401),
        (format!("Authorization: Bearer {stranger}\r\n"), 403),
        (format!("Cookie: passshare_session={session}\r\n"), 403),
        (
            format!("Cookie: passshare_session={session}\r\nx-passshare-client: mobile\r\n"),
            403,
        ),
        (
            format!("Cookie: passshare_session={session}\r\nx-passshare-client: extension\r\n"),
            403,
        ),
    ] {
        assert_eq!(http(p, "DELETE", &path, &credentials, &deletion).0, status);
        assert_eq!(live_snapshot(), before);
    }
    let missing = ConnectId::generate().unwrap();
    let error = runtime
        .block_on(sdk.delete_item(box_id, missing.as_str(), 1, 1))
        .unwrap_err();
    assert_eq!((error.status(), error.code()), (Some(404), Some("PS044")));

    // Synthetic role/session state also exercises the DB recheck directly,
    // bypassing middleware claims without bypassing the operation's locks.
    let actor = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner'"
    ));
    let session_id = db.sql(&format!(
        "SELECT id::text FROM sessions WHERE user_id='{actor}' ORDER BY created_at LIMIT 1"
    ));
    let sql_operation = format!("SELECT passshare_encrypted_operation('{actor}','{session_id}','{box_id}','delete','{item_id}',1,NULL,1)");
    let reply: Value = serde_json::from_str(&db.sql(&format!("BEGIN; UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id='{session_id}'; {sql_operation}; ROLLBACK;"))).unwrap();
    assert_eq!(
        (reply["status"].as_u64(), reply["code"].as_str()),
        (Some(401), Some("PS024"))
    );
    let reply: Value = serde_json::from_str(&db.sql(&format!("BEGIN; DELETE FROM vault_memberships WHERE vault_id='{box_id}' AND user_id='{actor}'; {sql_operation}; ROLLBACK;"))).unwrap();
    assert_eq!(
        (reply["status"].as_u64(), reply["code"].as_str()),
        (Some(403), Some("PS016"))
    );
    assert_eq!(live_snapshot(), before);
    let member = db.sql(&format!("SELECT user_id::text FROM vault_memberships WHERE vault_id='{stranger_box}' AND role='owner'"));
    let member_headers = format!("Authorization: Bearer {stranger}\r\n");
    db.sql(&format!("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES('{member}','{box_id}','member')"));
    assert_eq!(http(p, "DELETE", &path, &member_headers, &deletion).0, 403);
    db.sql(&format!("UPDATE vault_memberships SET confirmed_at=NOW(),role='viewer' WHERE user_id='{member}' AND vault_id='{box_id}'"));
    let reply = http(p, "DELETE", &path, &member_headers, &deletion);
    assert_eq!((reply.0, reply.1["error"].as_str()), (403, Some("PS032")));
    assert_eq!(live_snapshot(), before);
    db.sql(&format!(
        "DELETE FROM vault_memberships WHERE user_id='{member}' AND vault_id='{box_id}'"
    ));

    // Direct SQL fault injection is SYNTHETIC fixture setup only. A tombstone
    // insert trigger fails after the function has executed the live-row DELETE.
    // This proves transactional rollback, not an actual production outage.
    db.sql(&format!("CREATE FUNCTION passshare_delete_fault() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.box_id='{box_id}' AND NEW.item_id='{item_id}' THEN RAISE EXCEPTION 'synthetic tombstone insert failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER passshare_delete_fault BEFORE INSERT ON encrypted_item_tombstones FOR EACH ROW EXECUTE FUNCTION passshare_delete_fault();"));
    reject(&deletion, 503, "PS019");
    assert_eq!(db.sql(&format!("SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{box_id}' AND item_id='{item_id}'")), "0");
    let fetched = runtime.block_on(sdk.get_item(box_id, item_id)).unwrap();
    assert_eq!(key.decrypt_item(&fetched, &context).unwrap(), item);
    db.sql("DROP TRIGGER passshare_delete_fault ON encrypted_item_tombstones; DROP FUNCTION passshare_delete_fault();");

    // State/row epoch inconsistencies are also synthetic setup, never a claim
    // that rotation exists. Both sides must match the active epoch to delete.
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id='{box_id}'"
    ));
    reject(&json!({"expectedVersion":1,"keyEpoch":2}), 409, "PS056");
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=1 WHERE box_id='{box_id}'"
    ));

    // DB constraints defend direct metadata writes independently of the HTTP
    // planner. All statements here touch only this disposable fixture's box.
    for values in [
        format!("'{box_id}','{item_id}',0,1"),
        format!("'{box_id}','{item_id}',9007199254740992,1"),
        format!("'{box_id}','{item_id}',1,0"),
        format!("'{box_id}','{item_id}',1,9007199254740992"),
        format!("'{box_id}','INVALID',1,1"),
        format!("'INVALID','{item_id}',1,1"),
    ] {
        db.sql(&format!("DO $$ BEGIN BEGIN INSERT INTO encrypted_item_tombstones(box_id,item_id,last_live_version,key_epoch) VALUES({values}); RAISE EXCEPTION 'invalid tombstone accepted'; EXCEPTION WHEN check_violation THEN NULL; END; END $$;"));
    }
    runtime
        .block_on(sdk.delete_item(box_id, item_id, 1, 1))
        .unwrap();
    let error = runtime.block_on(sdk.get_item(box_id, item_id)).unwrap_err();
    assert_eq!(
        (error.status(), error.code()),
        (Some(404), Some("PS012")),
        "GET retains its existing error code"
    );
    assert!(!runtime
        .block_on(sdk.list(box_id, None))
        .unwrap()
        .items
        .iter()
        .any(|entry| entry.item_id.as_str() == item_id));
    assert!(live_snapshot().is_empty());
    let tombstone: Value = serde_json::from_str(&db.sql(&format!(
        "SELECT to_jsonb(t)::text FROM encrypted_item_tombstones t WHERE box_id='{box_id}' AND item_id='{item_id}'"
    ))).unwrap();
    assert_eq!(
        tombstone,
        json!({"box_id":box_id,"item_id":item_id,"last_live_version":1,"key_epoch":1})
    );
    assert_eq!(db.sql("SELECT string_agg(column_name,',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='encrypted_item_tombstones'"), "box_id,item_id,last_live_version,key_epoch", "no envelope, nonce, secret, ciphertext or key column");
    // The SDK accepts the replay, and the independent raw HTTP helper observes
    // that the formal Node adapter sends exactly zero bytes after its headers.
    runtime
        .block_on(sdk.delete_item(box_id, item_id, 1, 1))
        .unwrap();
    assert_eq!(
        http_bytes(p, "DELETE", &path, &headers, &deletion),
        (204, Vec::new())
    );
    let csrf = ConnectId::generate().unwrap();
    let cookie = format!(
        "Cookie: passshare_session={session}; passshare_csrf={csrf}\r\nx-csrf-token: {csrf}\r\n"
    );
    assert_eq!(
        http_bytes(p, "DELETE", &path, &cookie, &deletion),
        (204, Vec::new())
    );
    for (version, epoch, code) in [(2, 1, "PS015"), (1, 2, "PS056")] {
        let error = runtime
            .block_on(sdk.delete_item(box_id, item_id, version, epoch))
            .unwrap_err();
        assert_eq!((error.status(), error.code()), (Some(409), Some(code)));
    }
    let error = runtime
        .block_on(sdk.put_item(box_id, item_id, 0, &envelope))
        .unwrap_err();
    assert_eq!((error.status(), error.code()), (Some(409), Some("PS015")));
    let updated_context = ItemContext {
        item_version: 2,
        ..context.clone()
    };
    let mut updated_item = item.clone();
    updated_item["version"] = json!(2);
    let updated_envelope = key.encrypt_item(&updated_item, &updated_context).unwrap();
    let error = runtime
        .block_on(sdk.put_item(box_id, item_id, 1, &updated_envelope))
        .unwrap_err();
    assert_eq!((error.status(), error.code()), (Some(409), Some("PS015")));
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id='{box_id}'"
    ));
    let error = runtime
        .block_on(sdk.delete_item(box_id, item_id, 1, 2))
        .unwrap_err();
    assert_eq!(
        (error.status(), error.code()),
        (Some(409), Some("PS056")),
        "old tombstone must not replay in a new epoch"
    );
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=1 WHERE box_id='{box_id}'"
    ));
    assert_eq!(
        runtime.block_on(sdk.state(box_id)).unwrap(),
        passshare_connect::BoxState::Encrypted { key_epoch: 1 }
    );
    assert_eq!(
        http(
            p,
            "GET",
            &format!("/v1/vaults/{box_id}/items"),
            &format!("Authorization: Bearer {connect}\r\n"),
            &Value::Null
        )
        .0,
        409
    );
    let retained: Value = serde_json::from_str(&db.sql(&format!("SELECT to_jsonb(t)::text FROM encrypted_item_tombstones t WHERE box_id='{box_id}' AND item_id='{item_id}'"))).unwrap();
    assert_eq!(
        retained, tombstone,
        "replays and conflicts leave metadata unchanged"
    );

    // Both HTTP requests begin from one barrier with the same live revision.
    // Only one wins; a winning update must be decryptable as the complete DTO,
    // and a winning delete must leave a tombstone and no live ciphertext.
    let race_context = ItemContext {
        item_id: ConnectId::generate().unwrap(),
        ..context.clone()
    };
    let race_id = race_context.item_id.as_str();
    let race_path = format!("{root}/items/{race_id}");
    let mut race_item = item.clone();
    race_item["id"] = json!(race_id);
    let race_envelope = key.encrypt_item(&race_item, &race_context).unwrap();
    runtime
        .block_on(sdk.put_item(box_id, race_id, 0, &race_envelope))
        .unwrap();
    let race_next_context = ItemContext {
        item_version: 2,
        ..race_context.clone()
    };
    let mut race_next_item = race_item.clone();
    race_next_item["version"] = json!(2);
    let race_next_envelope = key
        .encrypt_item(&race_next_item, &race_next_context)
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let requests = [
        ("DELETE", deletion.clone()),
        (
            "PUT",
            json!({"expectedVersion":1,"envelope":race_next_envelope}),
        ),
    ];
    let handles = requests
        .into_iter()
        .map(|(method, body)| {
            let path = race_path.clone();
            let headers = headers.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                http(p, method, &path, &headers, &body)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    let raced_live = runtime.block_on(sdk.get_item(box_id, race_id));
    let raced_tombstone = db.sql(&format!("SELECT last_live_version::text || ':' || key_epoch::text FROM encrypted_item_tombstones WHERE box_id='{box_id}' AND item_id='{race_id}'"));
    match (outcomes[0].0, outcomes[1].0) {
        (204, 409) => {
            assert!(outcomes[0].1.is_null());
            assert_eq!(outcomes[1].1["error"], "PS015");
            assert_eq!(raced_live.unwrap_err().status(), Some(404));
            assert_eq!(raced_tombstone, "1:1");
            assert!(!runtime
                .block_on(sdk.list(box_id, None))
                .unwrap()
                .items
                .iter()
                .any(|entry| entry.item_id.as_str() == race_id));
        }
        (409, 200) => {
            assert_eq!(outcomes[0].1["error"], "PS015");
            let stored = raced_live.unwrap();
            assert_eq!(stored, race_next_envelope);
            assert_eq!(
                key.decrypt_item(&stored, &race_next_context).unwrap(),
                race_next_item
            );
            assert!(raced_tombstone.is_empty());
            runtime
                .block_on(sdk.delete_item(box_id, race_id, 2, 1))
                .unwrap();
        }
        statuses => panic!("delete/update CAS must have one winner: {statuses:?}"),
    }
    assert_eq!(db.sql(&format!("SELECT count(*) FROM encrypted_items WHERE box_id='{box_id}' AND item_id IN ('{item_id}','{race_id}')")), "0");
    // A currently confirmed member can delete, including an exact replay. Role
    // removal then denies the same replay despite the matching tombstone.
    db.sql(&format!("INSERT INTO vault_memberships(user_id,vault_id,role,confirmed_at) VALUES('{member}','{box_id}','member',NOW())"));
    let member_context = ItemContext {
        item_id: ConnectId::generate().unwrap(),
        ..context.clone()
    };
    let mut member_item = item.clone();
    member_item["id"] = json!(member_context.item_id);
    let member_envelope = key.encrypt_item(&member_item, &member_context).unwrap();
    runtime
        .block_on(sdk.put_item(box_id, member_context.item_id.as_str(), 0, &member_envelope))
        .unwrap();
    let member_path = format!("{root}/items/{}", member_context.item_id);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let concurrent = (0..2)
        .map(|_| {
            let barrier = barrier.clone();
            let path = member_path.clone();
            let headers = member_headers.clone();
            let body = deletion.clone();
            thread::spawn(move || {
                barrier.wait();
                http_bytes(p, "DELETE", &path, &headers, &body)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    for response in concurrent {
        assert_eq!(response.join().unwrap(), (204, Vec::new()));
    }
    assert_eq!(db.sql(&format!("SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{box_id}' AND item_id='{}'",member_context.item_id)),"1");
    db.sql(&format!(
        "DELETE FROM vault_memberships WHERE user_id='{member}' AND vault_id='{box_id}'"
    ));
    assert_eq!(
        http(p, "DELETE", &member_path, &member_headers, &deletion).0,
        403
    );
    accept_waiting_delete_revocation(db, p, key, original_item);
    println!("encrypted delete: SDK 204, empty wire reply, full DTO preservation, strict metadata, auth/CSRF, synthetic rollback/epoch/DB constraints, GET/list absence, replay, reserved ID, encrypted boundary and synchronized delete/update CAS passed");
}

struct HeldBox {
    child: Child,
}
impl HeldBox {
    fn start(db: &Database, box_id: &str, label: &str) -> Self {
        let mut child = command("docker")
            .args([
                "exec",
                "-i",
                "--env",
                &format!("PGAPPNAME={label}"),
                &db.name,
                "psql",
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "passshare",
                "-d",
                "passshare",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        writeln!(child.stdin.as_mut().unwrap(), "SET statement_timeout=12000; SET idle_in_transaction_session_timeout=15000; BEGIN; SELECT id FROM connect_vaults WHERE id='{box_id}' FOR UPDATE;").unwrap();
        child.stdin.as_mut().unwrap().flush().unwrap();
        Self { child }
    }
    fn commit(&mut self) {
        writeln!(self.child.stdin.as_mut().unwrap(), "COMMIT;\\q").unwrap();
        self.child.stdin.as_mut().unwrap().flush().unwrap();
        drop(self.child.stdin.take());
    }
}
impl Drop for HeldBox {
    fn drop(&mut self) {
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = writeln!(stdin, "ROLLBACK;\\q");
        }
        if !reap_before(
            &mut self.child,
            std::time::Instant::now() + Duration::from_secs(3),
        ) {
            let _ = self.child.kill();
            if !reap_before(
                &mut self.child,
                std::time::Instant::now() + Duration::from_secs(2),
            ) {
                CLEANUP_FAILED.store(true, Ordering::SeqCst);
                eprintln!("owned SQL holder did not exit within cleanup deadline");
            }
        }
    }
}
fn reap_before(child: &mut Child, deadline: std::time::Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Err(_) => return false,
            Ok(None) => {}
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
}
fn wait_db(db: &Database, sql: &str) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if db.sql_before(sql, deadline) == "t" {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
}
fn accept_waiting_delete_revocation(db: &Database, p: u16, key: &PasswordBoxKey, original: &Value) {
    let (session, _, box_id) = signup(p);
    let headers = format!("Authorization: Bearer {session}\r\n");
    let root = format!("/api/encrypted/boxes/{box_id}");
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &headers,
            &json!({"keyEpoch":1})
        )
        .0,
        200
    );
    let context = ItemContext {
        password_box_id: box_id.parse().unwrap(),
        item_id: ConnectId::generate().unwrap(),
        item_version: 1,
        key_epoch: 1,
    };
    let mut item = original.clone();
    item["id"] = json!(context.item_id);
    item["vault"]["id"] = json!(box_id);
    item["version"] = json!(1);
    let envelope = key.encrypt_item(&item, &context).unwrap();
    let path = format!("{root}/items/{}", context.item_id);
    assert_eq!(
        http(
            p,
            "PUT",
            &path,
            &headers,
            &json!({"expectedVersion":0,"envelope":envelope})
        )
        .0,
        200
    );
    let label = format!("passshare-delete-held-{}", context.item_id);
    let mut held = HeldBox::start(db, &box_id, &label);
    assert!(wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{label}' AND state='idle in transaction')")),"synthetic holder must have acquired the box lock");
    let request = thread::spawn(move || {
        http(
            p,
            "DELETE",
            &path,
            &headers,
            &json!({"expectedVersion":1,"keyEpoch":1}),
        )
    });
    let waiting=wait_db(db,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT passshare_encrypted_operation(%')");
    // Synthetic direct session revocation, committed while DELETE demonstrably
    // waits before its authoritative session check. This is not a logout claim.
    db.sql(&format!("DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner')"));
    held.commit();
    let reply = request.join().unwrap();
    assert!(
        waiting,
        "the API must be waiting on the held DB lock before revocation"
    );
    assert_eq!((reply.0, reply.1["error"].as_str()), (401, Some("PS024")));
    let stored: Value = serde_json::from_str(&db.sql(&format!(
        "SELECT envelope::text FROM encrypted_items WHERE box_id='{box_id}' AND item_id='{}'",
        context.item_id
    )))
    .unwrap();
    assert_eq!(stored, serde_json::to_value(envelope).unwrap());
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{box_id}'"
        )),
        "0"
    );
    println!("encrypted delete: DB-observed waiter rejects committed synthetic session revocation and preserves ciphertext without a tombstone");
}

fn accept_atomic_setup(db: &Database, p: u16) {
    let (session, connect, box_id, _) = signup_with_password(p);
    let actor = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner'"
    ));
    let headers = format!("Authorization: Bearer {session}\r\n");
    let root = format!("/api/encrypted/boxes/{box_id}");
    let setup = format!("{root}/setup");
    let key = PasswordBoxKey::generate().unwrap();
    let password = format!("setup-password-{}", ConnectId::generate().unwrap());
    let salt = generate_salt().unwrap();
    let master = owner_master(&password, &salt).unwrap();
    let ctx = owner_context(&box_id, &actor, 1);
    let bundle = owner_bundle(&key, &master, salt, &ctx);
    let body = json!({"bundle":bundle});
    for credentials in [
        String::new(),
        format!("Authorization: Bearer {connect}\r\n"),
    ] {
        assert_eq!(http(p, "POST", &setup, &credentials, &body).0, 401);
    }
    let (stranger, stranger_connect, stranger_box) = signup(p);
    let stranger_actor=db.sql(&format!("SELECT user_id::text FROM vault_memberships WHERE vault_id='{stranger_box}' AND role='owner'"));
    let stranger_body =
        json!({"bundle":owner_bundle(&key,&master,salt,&owner_context(&box_id,&stranger_actor,1))});
    assert_eq!(
        http(
            p,
            "POST",
            &setup,
            &format!("Authorization: Bearer {stranger}\r\n"),
            &stranger_body
        )
        .0,
        403
    );
    for client in [
        "",
        "x-passshare-client: mobile\r\n",
        "x-passshare-client: extension\r\n",
    ] {
        assert_eq!(
            http(
                p,
                "POST",
                &setup,
                &format!("Cookie: passshare_session={session}\r\n{client}"),
                &body
            )
            .0,
            403
        );
    }
    for pointer in ["", "/bundle", "/bundle/wrapped", "/bundle/wrapped/context"] {
        let mut bad = body.clone();
        bad.pointer_mut(pointer).unwrap()["password"] = json!("forbidden");
        assert_eq!(http(p, "POST", &setup, &headers, &bad).0, 400);
    }
    // This failure occurs AFTER activation's INSERT, inside the same function.
    db.sql(&format!("CREATE FUNCTION passshare_setup_fault() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.box_id='{box_id}' THEN RAISE EXCEPTION 'synthetic bundle insert failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER passshare_setup_fault BEFORE INSERT ON encrypted_owner_keys FOR EACH ROW EXECUTE FUNCTION passshare_setup_fault();"));
    assert_eq!(http(p, "POST", &setup, &headers, &body).0, 503);
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_box_state WHERE box_id='{box_id}')+(SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{box_id}')")),"0","failed bundle write must roll back activation");
    assert_eq!(
        http(p, "GET", &root, &headers, &Value::Null).1["mode"],
        "compatibility"
    );
    db.sql("DROP TRIGGER passshare_setup_fault ON encrypted_owner_keys; DROP FUNCTION passshare_setup_fault();");
    let csrf = ConnectId::generate().unwrap();
    let cookie = format!(
        "Cookie: passshare_session={session}; passshare_csrf={csrf}\r\nx-csrf-token: {csrf}\r\n"
    );
    let (status, created) = http(p, "POST", &setup, &cookie, &body);
    assert_eq!(status, 200);
    assert_eq!(
        created,
        json!({"mode":"encrypted","keyEpoch":1,"bundleVersion":1,"bundle":bundle})
    );
    // A lost first response is reconciled with the identical ciphertext. New
    // random wrapping or key generation is a conflicting operation.
    assert_eq!(
        http(p, "POST", &setup, &headers, &body),
        (200, created.clone())
    );
    let different = json!({"bundle":owner_bundle(&key,&master,salt,&ctx)});
    assert_eq!(http(p, "POST", &setup, &headers, &different).0, 409);
    let fetched = http(
        p,
        "GET",
        &format!("{root}/owner-key"),
        &headers,
        &Value::Null,
    );
    assert_eq!(fetched, (200, json!({"bundleVersion":1,"bundle":bundle})));
    let reopened = unwrap_bundle(&fetched.1["bundle"], &password, &ctx).unwrap();
    let item_ctx = ItemContext {
        password_box_id: box_id.parse().unwrap(),
        item_id: ConnectId::generate().unwrap(),
        item_version: 1,
        key_epoch: 1,
    };
    let item = json!({"id":item_ctx.item_id,"version":item_ctx.item_version,
        "vault":{"id":item_ctx.password_box_id},"title":"Atomic setup",
        "fields":[{"value":ConnectId::generate().unwrap()}],"retained":[3,1,2]});
    let envelope = key.encrypt_item(&item, &item_ctx).unwrap();
    let item_path = format!("{root}/items/{}", item_ctx.item_id);
    assert_eq!(
        http(
            p,
            "PUT",
            &item_path,
            &headers,
            &json!({"expectedVersion":0,"envelope":envelope})
        )
        .0,
        200
    );
    let (status, stored_item) = http(p, "GET", &item_path, &headers, &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(
        reopened
            .decrypt_item(&serde_json::from_value(stored_item).unwrap(), &item_ctx)
            .unwrap(),
        item
    );
    assert_eq!(
        http(p, "POST", &setup, &headers, &body),
        (200, created),
        "exact replay remains safe after item writes"
    );

    // Different initial keys race from the same barrier; the losing key must
    // never replace the winner or produce an orphaned activation.
    let (race_session, _, race_box) = signup(p);
    let race_actor = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{race_box}' AND role='owner'"
    ));
    let race_ctx = owner_context(&race_box, &race_actor, 1);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let bodies = [
        json!({"bundle":owner_bundle(&key,&master,salt,&race_ctx)}),
        json!({"bundle":owner_bundle(&PasswordBoxKey::generate().unwrap(),&master,salt,&race_ctx)}),
    ];
    let handles = bodies
        .iter()
        .map(|body| {
            let body = body.clone();
            let path = format!("/api/encrypted/boxes/{race_box}/setup");
            let headers = format!("Authorization: Bearer {race_session}\r\n");
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                http(p, "POST", &path, &headers, &body)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(outcomes.iter().filter(|o| o.0 == 200).count(), 1);
    assert_eq!(outcomes.iter().filter(|o| o.0 == 409).count(), 1);
    let winner = outcomes.iter().find(|o| o.0 == 200).unwrap();
    let persisted = http(
        p,
        "GET",
        &format!("/api/encrypted/boxes/{race_box}/owner-key"),
        &format!("Authorization: Bearer {race_session}\r\n"),
        &Value::Null,
    );
    assert_eq!(persisted.1["bundle"], winner.1["bundle"]);
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_box_state WHERE box_id='{race_box}')+(SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{race_box}')")),"2");

    // These states are separate from the older enable function's acceptance.
    let stranger_headers = format!("Authorization: Bearer {stranger}\r\n");
    assert_eq!(
        http(
            p,
            "POST",
            &format!("/v1/vaults/{stranger_box}/items"),
            &format!("Authorization: Bearer {stranger_connect}\r\n"),
            &json!({"title":"Retained compatibility fixture","category":"LOGIN"})
        )
        .0,
        201
    );
    let nonempty = json!({"bundle":owner_bundle(&key,&master,salt,&owner_context(&stranger_box,&stranger_actor,1))});
    assert_setup_rejected_intact(db, p, &stranger_box, &stranger_headers, &nonempty, "PS055");

    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id='{box_id}'"
    ));
    assert_setup_rejected_intact(db, p, &box_id, &headers, &body, "PS056");
    db.sql(&format!("UPDATE encrypted_box_state SET key_epoch=1 WHERE box_id='{box_id}'; DELETE FROM encrypted_owner_keys WHERE box_id='{box_id}'"));
    assert_setup_rejected_intact(db, p, &box_id, &headers, &body, "PS015");

    // Fixture for a transferred owner with the prior owner's bundle retained.
    // Role changes are direct synthetic DB setup, not a transfer API claim.
    db.sql(&format!("UPDATE vault_memberships SET role='member',confirmed_at=NOW() WHERE vault_id='{race_box}' AND user_id='{race_actor}'; INSERT INTO vault_memberships(vault_id,user_id,role) VALUES('{race_box}','{stranger_actor}','owner')"));
    let replacement = json!({"bundle":owner_bundle(&key,&master,salt,&owner_context(&race_box,&stranger_actor,1))});
    assert_setup_rejected_intact(db, p, &race_box, &stranger_headers, &replacement, "PS015");
    println!("atomic setup: authorization/CSRF, strict public headers, post-activation failure rollback, exact replay, different-key rejection, full item decrypt and synchronized concurrent initialization passed");
}

fn assert_setup_rejected_intact(
    db: &Database,
    p: u16,
    box_id: &str,
    headers: &str,
    body: &Value,
    code: &str,
) {
    let snapshot = || {
        db.sql(&format!("SELECT md5(jsonb_build_object('state',(SELECT to_jsonb(s) FROM encrypted_box_state s WHERE box_id='{box_id}'),'keys',(SELECT jsonb_agg(to_jsonb(k) ORDER BY owner_id) FROM encrypted_owner_keys k WHERE box_id='{box_id}'),'encrypted',(SELECT jsonb_agg(to_jsonb(i) ORDER BY item_id) FROM encrypted_items i WHERE box_id='{box_id}'),'plain',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM connect_items i WHERE vault_id='{box_id}'))::text)"))
    };
    let before = snapshot();
    let (status, error) = http(
        p,
        "POST",
        &format!("/api/encrypted/boxes/{box_id}/setup"),
        headers,
        body,
    );
    assert_eq!((status, error["error"].as_str()), (409, Some(code)));
    assert_eq!(
        snapshot(),
        before,
        "rejected setup must preserve every stored row"
    );
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64;

    #[test]
    fn cli_modes_are_exact_and_image_values_cannot_be_docker_options() {
        assert!(matches!(
            Mode::parse(&["native.exe".into()]),
            Ok(Mode::Node(_))
        ));
        assert!(matches!(
            Mode::parse(&["--image".into(), "passshare1163-api:fixture".into()]),
            Ok(Mode::Image(_))
        ));
        for args in [
            vec![],
            vec!["--image"],
            vec!["--image", "--privileged"],
            vec!["--image", "tag --env extra"],
            vec!["--image", "tag", "extra"],
            vec!["binary", "extra"],
            vec!["--unknown"],
        ] {
            assert!(Mode::parse(&args.into_iter().map(Into::into).collect::<Vec<_>>()).is_err());
        }
    }

    fn native_plan(context: &ItemContext, envelope: &Value) -> Value {
        passshare_mutations::dispatch(&json!({"command":"encrypted-plan","operation":"put",
            "actor":"synthetic","session":"synthetic","boxId":context.password_box_id,
            "itemId":context.item_id,"request":{"expectedVersion":context.item_version-1,"envelope":envelope}}))
    }
    fn context(version: u64, epoch: u64) -> ItemContext {
        ItemContext {
            password_box_id: ConnectId::generate().unwrap(),
            item_id: ConnectId::generate().unwrap(),
            item_version: version,
            key_epoch: epoch,
        }
    }
    fn item(context: &ItemContext) -> Value {
        json!({"id":context.item_id,"version":context.item_version,"vault":{"id":context.password_box_id},"payload":""})
    }
    #[test]
    fn core_real_envelopes_match_host_contract_at_numeric_and_size_boundaries() {
        let key = PasswordBoxKey::generate().unwrap();
        for context in [
            context(1, 1),
            context(9_007_199_254_740_991, 9_007_199_254_740_991),
        ] {
            let original = item(&context);
            let envelope = key.encrypt_item(&original, &context).unwrap();
            let plan = native_plan(&context, &serde_json::to_value(&envelope).unwrap());
            assert_eq!(plan["status"], 200);
            assert_eq!(
                plan["body"]["params"][6],
                serde_json::to_value(&envelope).unwrap()
            );
            assert_eq!(key.decrypt_item(&envelope, &context).unwrap(), original);
        }
        let context = context(1, 1);
        let mut original = item(&context);
        let overhead = serde_json::to_vec(&original).unwrap().len();
        original["payload"] = json!("a".repeat(1024 * 1024 - overhead));
        assert_eq!(serde_json::to_vec(&original).unwrap().len(), 1024 * 1024);
        let envelope = key.encrypt_item(&original, &context).unwrap();
        assert_eq!(
            BASE64.decode(&envelope.ciphertext).unwrap().len(),
            1024 * 1024 + 16
        );
        assert_eq!(
            native_plan(&context, &serde_json::to_value(&envelope).unwrap())["status"],
            200
        );
        original["payload"] = json!("a".repeat(1024 * 1024 - overhead + 1));
        assert!(key.encrypt_item(&original, &context).is_err());
        let mut too_large = serde_json::to_value(&envelope).unwrap();
        too_large["ciphertext"] = json!(BASE64.encode(vec![0u8; 1024 * 1024 + 17]));
        assert_eq!(native_plan(&context, &too_large)["status"], 400);
    }
    #[test]
    fn core_real_owner_bundle_matches_host_contract_and_rejects_scope_changes() {
        let owner = "7b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10";
        let box_id = ConnectId::generate().unwrap();
        let key = PasswordBoxKey::generate().unwrap();
        let salt = generate_salt().unwrap();
        let password = format!("synthetic-{}", ConnectId::generate().unwrap());
        let master = owner_master(&password, &salt).unwrap();
        let context = owner_context(box_id.as_str(), owner, 1);
        let bundle = owner_bundle(&key, &master, salt, &context);
        let plan = |actor: &str, bundle: &Value| {
            passshare_mutations::dispatch(&json!({"command":"owner-key-plan","operation":"put",
                "actor":actor,"session":"synthetic","boxId":box_id,
                "request":{"expectedVersion":0,"bundle":bundle}}))
        };
        let accepted = plan(owner, &bundle);
        assert_eq!(accepted["status"], 200);
        assert_eq!(accepted["body"]["params"][5], bundle);
        assert!(unwrap_bundle(&bundle, &password, &context).is_ok());
        assert_eq!(
            plan("8b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10", &bundle)["status"],
            400
        );
        let mut extra = bundle.clone();
        extra["kdf"] = json!({"memoryKiB":8});
        assert_eq!(plan(owner, &extra)["status"], 400);
    }
    #[test]
    fn host_rejects_extra_fields_and_malformed_types_on_real_core_envelopes() {
        let context = context(1, 1);
        let key = PasswordBoxKey::generate().unwrap();
        let envelope =
            serde_json::to_value(key.encrypt_item(&item(&context), &context).unwrap()).unwrap();
        for pointer in ["", "/context"] {
            for name in ["key", "plaintext", "realm"] {
                let mut changed = envelope.clone();
                changed.pointer_mut(pointer).unwrap()[name] = json!("forbidden");
                assert_eq!(native_plan(&context, &changed)["status"], 400);
            }
        }
        for (pointer, value) in [
            ("/format", json!(1.0)),
            ("/context/itemVersion", json!("1")),
            ("/context/keyEpoch", json!(0)),
        ] {
            let mut changed = envelope.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert_eq!(native_plan(&context, &changed)["status"], 400);
        }
    }
}
