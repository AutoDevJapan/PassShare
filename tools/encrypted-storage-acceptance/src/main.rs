//! Separate client-side Core/host contract acceptance; run via the Cargo gate.
//! Owns a disposable Docker PostgreSQL and
//! real Express host. No production configuration, model API or secret files.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
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

// Usage: <production-native-binary> OR --image <prebuilt-production-image>.
// Both modes require the preloaded pinned PostgreSQL image. Supplied images are never
// mounted over or removed by the tool; the caller owns its build/tag lifecycle.
const POSTGRES_IMAGE: &str =
    "postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
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
        let output = command("docker")
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
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fixture SQL failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
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
    let mode = Mode::parse(&std::env::args_os().skip(1).collect::<Vec<_>>())
        .unwrap_or_else(|reason| panic!("{reason}"));
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
    run_acceptance(&db, &network, &mode);
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
    let (refresh, connect, box_id, auth_password) = signup_with_password(p);
    let (stranger, _, stranger_box, stranger_auth_password) = signup_with_password(p);
    let headers = format!("Authorization: Bearer {refresh}\r\n");
    let stranger_headers = format!("Authorization: Bearer {stranger}\r\n");
    let mut connect_headers = format!("Authorization: Bearer {connect}\r\n");
    let root = format!("/api/encrypted/boxes/{box_id}");
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
    assert_eq!(http(p, "PUT", &path, &headers, &payload).0, 200);
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
    assert_eq!(http(p, "PUT", &path, &headers, &payload).0, 409);
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
    let next_envelope = key.encrypt_item(&next_item, &next).unwrap();
    let next_payload = json!({"expectedVersion":1,"envelope":next_envelope});
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let h = headers.clone();
            let path = path.clone();
            let body = next_payload.clone();
            thread::spawn(move || http(p, "PUT", &path, &h, &body).0)
        })
        .collect();
    let statuses: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(statuses.iter().filter(|s| **s == 200).count(), 1);
    assert_eq!(statuses.iter().filter(|s| **s == 409).count(), 3);
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
    db.sql(&format!(
        "DELETE FROM connect_vaults WHERE id='{private_box}'"
    ));
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_box_state WHERE box_id='{private_box}')+(SELECT count(*) FROM encrypted_items WHERE box_id='{private_box}')+(SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{private_box}')")),"0");
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
    db.sql("DELETE FROM sessions");
    assert_eq!(http(host.port, "GET", &path, &headers, &Value::Null).0, 401);
    assert_eq!(
        http(host.port, "GET", &owner_path, &headers, &Value::Null).0,
        401
    );
    println!("encrypted storage acceptance: Core roundtrip, rejection preservation, CAS 1/4, epoch, scope, confirmed membership, CSRF, host/DB plaintext boundary, compatibility/activation race, restart, revocation, private-box cascade, and owner key bundle unwrap/CAS/transfer/restart/cascade passed");
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
