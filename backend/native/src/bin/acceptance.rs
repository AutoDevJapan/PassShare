use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct Server {
    child: Child,
    port: u16,
    binary: PathBuf,
}

impl Server {
    fn start(port: u16, binary: PathBuf) -> Self {
        let mut command = Command::new("node");
        command
            .arg("src/index.js")
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .env("PORT", port.to_string())
            .env("APP_ENV", "local")
            .env("PASSSHARE_MUTATIONS_BIN", &binary)
            .env("DEV_SEED", "false")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command.spawn().expect("start synthetic API");
        let server = Self {
            child,
            port,
            binary,
        };
        let ready = (0..100).any(|_| {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                true
            } else {
                thread::sleep(Duration::from_millis(100));
                false
            }
        });
        assert!(ready, "synthetic API did not become ready");
        server
    }
    fn restart(mut self) -> Self {
        self.child.kill().expect("stop synthetic API");
        self.child.wait().expect("reap synthetic API");
        Self::start(self.port, self.binary.clone())
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn http(port: u16, method: &str, path: &str, token: &str, key: &str, body: &Value) -> (u16, Value) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect synthetic API");
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let payload = if body.is_null() {
        String::new()
    } else {
        body.to_string()
    };
    let authorization = if token.is_empty() {
        String::new()
    } else {
        format!("Authorization: Bearer {token}\r\n")
    };
    let operation = if key.is_empty() {
        String::new()
    } else {
        format!("Idempotency-Key: {key}\r\n")
    };
    write!(stream,"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nx-passshare-client: mobile\r\n{authorization}{operation}Content-Length: {}\r\n\r\n{payload}",payload.len()).unwrap();
    let mut bytes = Vec::new();
    stream
        .take(4 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .expect("read synthetic response");
    let split = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .expect("HTTP headers");
    let headers = std::str::from_utf8(&bytes[..split]).unwrap();
    let status = headers
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let data = if bytes.len() == split + 4 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[split + 4..]).expect("JSON response")
    };
    (status, data)
}

fn main() {
    let port = TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let executable = std::env::current_exe().unwrap();
    let binary = executable.parent().unwrap().join(if cfg!(windows) {
        "passshare-mutations.exe"
    } else {
        "passshare-mutations"
    });
    let mut server = Server::start(port, binary);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let (status, session) = http(
        port,
        "POST",
        "/api/auth/signup",
        "",
        "",
        &json!({"email":format!("fixture-{nonce}@example.test"),"password":"Synthetic-Passshare-2026!"}),
    );
    assert!(status == 201, "synthetic signup");
    let token = session["connectAccessToken"]
        .as_str()
        .expect("connect access token")
        .to_owned();
    let refresh = session["refreshToken"]
        .as_str()
        .expect("synthetic refresh token")
        .to_owned();
    let (status, boxes) = http(port, "GET", "/v1/vaults", &token, "", &Value::Null);
    assert!(status == 200, "synthetic box list");
    let box_id = boxes[0]["id"].as_str().expect("initial box").to_owned();
    let path = format!("/v1/vaults/{box_id}/items");
    let body = json!({"title":"Synthetic card","category":"CREDIT_CARD","fields":[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa","label":"number","type":"CONCEALED","value":"synthetic-number"}],"sections":[{"id":"section","label":"Additional"}],"urls":[{"href":"https://example.test/one","primary":true,"label":"one"},{"href":"https://example.test/two","primary":false,"label":"two"}],"favorite":false,"tags":["a,b","two"],"files":[],"customMetadata":{"synthetic":true}});
    let (status, created) = http(port, "POST", &path, &token, "fixture-item-0001", &body);
    assert!(status == 201, "native item create");
    let (status, replayed) = http(port, "POST", &path, &token, "fixture-item-0001", &body);
    assert!(
        status == 201 && replayed == created,
        "exact replay returns original result"
    );
    let mut changed = body.clone();
    changed["title"] = json!("Changed draft");
    assert!(
        http(port, "POST", &path, &token, "fixture-item-0001", &changed).0 == 409,
        "same key with modified draft is conflict"
    );
    let (status, second) = http(port, "POST", &path, &token, "fixture-item-0002", &body);
    assert!(
        status == 201 && second["id"] != created["id"],
        "different operation permits intentionally identical content"
    );
    let mut threads = Vec::new();
    for _ in 0..4 {
        let token = token.clone();
        let path = path.clone();
        let body = body.clone();
        threads.push(thread::spawn(move || {
            http(port, "POST", &path, &token, "fixture-item-parallel", &body)
        }));
    }
    let mut parallel_id = Value::Null;
    for thread in threads {
        let (status, result) = thread.join().unwrap();
        assert!(status == 201, "parallel create status");
        if parallel_id.is_null() {
            parallel_id = result["id"].clone();
        } else {
            assert!(parallel_id == result["id"], "parallel request creates once");
        }
    }
    let (status, after) = http(port, "GET", &path, &token, "", &Value::Null);
    assert!(
        status == 200 && after.as_array().unwrap().len() == 3,
        "create count is exactly three"
    );
    if std::env::var_os("DATABASE_URL").is_some() {
        server = server.restart();
        let (status, result) = http(port, "POST", &path, &token, "fixture-item-0001", &body);
        assert!(
            status == 201 && result == created,
            "durable replay after server restart"
        );
    }
    let id = created["id"].as_str().unwrap();
    let values = json!({"title":"Renamed synthetic card","category":"CREDIT_CARD","username":"","password":"","url":"https://example.test/one","body":"","notes":"","tags":"a,b, two","favorite":false});
    let edit_path = format!("{path}/{id}/form");
    let (status, edited) = http(
        port,
        "PUT",
        &edit_path,
        &token,
        "",
        &json!({"version":1,"values":values}),
    );
    assert!(status == 200, "native empty-body card edit");
    let mut expected = created.clone();
    expected["title"] = json!("Renamed synthetic card");
    expected["version"] = json!(2);
    expected["updatedAt"] = edited["updatedAt"].clone();
    assert!(
        edited == expected,
        "title edit preserves every additional field, URL, section and metadata"
    );
    assert!(
        http(
            port,
            "PUT",
            &edit_path,
            &token,
            "",
            &json!({"version":1,"values":values})
        )
        .0 == 409,
        "stale editor is conflict"
    );
    assert!(
        http(port, "POST", &path, &token, "fixture-item-0001", &body).0 == 409,
        "changed saved result is not recreated"
    );
    let (status, other) = http(
        port,
        "POST",
        "/api/auth/signup",
        "",
        "",
        &json!({"email":format!("other-{nonce}@example.test"),"password":"Synthetic-Passshare-2026!"}),
    );
    assert!(status == 201, "second synthetic actor");
    assert!(
        http(
            port,
            "POST",
            &path,
            other["connectAccessToken"].as_str().unwrap(),
            "fixture-item-0001",
            &body
        )
        .0 == 403,
        "another actor cannot use the key to retrieve a result"
    );
    let (status, created_box) = http(
        port,
        "POST",
        "/api/auth/vaults",
        &refresh,
        "fixture-box-00001",
        &json!({"name":"Synthetic operation box"}),
    );
    assert!(status == 201, "atomic box and owner membership create");
    let (status, replay_box) = http(
        port,
        "POST",
        "/api/auth/vaults",
        &refresh,
        "fixture-box-00001",
        &json!({"name":"Synthetic operation box"}),
    );
    assert!(
        status == 201 && replay_box == created_box,
        "box replay has the same identity"
    );
    assert!(
        http(
            port,
            "POST",
            "/api/auth/vaults",
            &refresh,
            "fixture-box-00001",
            &json!({"name":"Modified box draft"})
        )
        .0 == 409,
        "modified box draft remains conflict"
    );
    println!("native HTTP acceptance passed: exact/modified/parallel create, durable replay when PostgreSQL is configured, scoped denial, full edit preservation, stale version, box identity");
    drop(server);
}
