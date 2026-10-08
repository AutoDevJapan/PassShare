//! Run through the shared Cargo gate. Owns a disposable Docker PostgreSQL and
//! real Express host. No production configuration, model API or secret files.
use passshare_core::{
    cloud_crypto::{ItemContext, PasswordBoxKey},
    ConnectId,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::Duration,
};

fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
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
    fn start() -> Self {
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
                "postgres:17-alpine",
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
        let _ = command("docker")
            .args(["rm", "--force", "--volumes", &self.name])
            .stdout(Stdio::null())
            .status();
    }
}
struct Host {
    child: Child,
    port: u16,
}
impl Host {
    fn start(db: &Database) -> Self {
        let port = port();
        let backend = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        let executable = std::env::current_exe().unwrap();
        let binary = executable.parent().unwrap().join(if cfg!(windows) {
            "passshare-mutations.exe"
        } else {
            "passshare-mutations"
        });
        let mut cmd = command("node");
        cmd.env_clear();
        for key in ["PATH", "SystemRoot", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        let child = cmd
            .arg("src/encrypted/acceptance-host.js")
            .current_dir(backend)
            .env("PORT", port.to_string())
            .env("APP_ENV", "local")
            .env("DEV_SEED", "false")
            .env("PASSSHARE_MUTATIONS_BIN", binary)
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
        let host = Self { child, port };
        assert!(
            (0..100).any(|_| {
                if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    true
                } else {
                    thread::sleep(Duration::from_millis(100));
                    false
                }
            }),
            "API readiness"
        );
        host
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn http(port: u16, method: &str, path: &str, headers: &str, body: &Value) -> (u16, Value) {
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
    let body = if bytes.len() == split + 4 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[split + 4..]).unwrap()
    };
    (status, body)
}
fn signup(port: u16) -> (String, String, String) {
    let (status, session) = http(
        port,
        "POST",
        "/api/auth/signup",
        "x-passshare-client: mobile\r\n",
        &json!({"email":format!("{}@example.test",ConnectId::generate().unwrap()),"password":format!("{}Aa!",ConnectId::generate().unwrap())}),
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
    )
}
fn main() {
    let db = Database::start();
    let mut host = Host::start(&db);
    let p = host.port;
    let (refresh, connect, box_id) = signup(p);
    let (stranger, _, stranger_box) = signup(p);
    let headers = format!("Authorization: Bearer {refresh}\r\n");
    let stranger_headers = format!("Authorization: Bearer {stranger}\r\n");
    let connect_headers = format!("Authorization: Bearer {connect}\r\n");
    let root = format!("/api/encrypted/boxes/{box_id}");
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
    db.sql(&format!(
        "DELETE FROM vault_memberships WHERE user_id='{claimant}' AND vault_id='{box_id}'"
    ));
    assert_eq!(
        http(p, "GET", &path, &stranger_headers, &Value::Null).0,
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
        (enabled == 200 && written >= 400) || (enabled == 409 && written == 201),
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
    db.sql(&format!(
        "DELETE FROM connect_vaults WHERE id='{private_box}'"
    ));
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_box_state WHERE box_id='{private_box}')+(SELECT count(*) FROM encrypted_items WHERE box_id='{private_box}')")),"0");
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_items WHERE box_id='{box_id}'"
        )),
        "1"
    );
    // Restart proves persistence; client decrypts the unchanged opaque body.
    drop(host);
    host = Host::start(&db);
    let restored = http(host.port, "GET", &path, &headers, &Value::Null);
    assert_eq!(restored.0, 200);
    assert_eq!(
        key.decrypt_item(&serde_json::from_value(restored.1).unwrap(), &next)
            .unwrap(),
        next_item
    );
    // Session/membership revocation is checked against live DB state.
    db.sql(&format!(
        "DELETE FROM vault_memberships WHERE vault_id='{box_id}'"
    ));
    assert_eq!(http(host.port, "GET", &path, &headers, &Value::Null).0, 403);
    db.sql("DELETE FROM sessions");
    assert_eq!(http(host.port, "GET", &path, &headers, &Value::Null).0, 401);
    println!("encrypted storage acceptance: Core roundtrip, rejection preservation, CAS 1/4, epoch, scope, confirmed membership, CSRF, host/DB plaintext boundary, compatibility/activation race, restart, revocation and private-box cascade passed");
}
