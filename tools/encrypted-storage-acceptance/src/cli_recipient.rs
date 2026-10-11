//! Explicit ignored acceptance: formal Node + verified owned PG + real op.
//! Only the caller-supplied disposable output directory receives plaintext.
use super::*;
use passshare_core::cloud_crypto::{AttachmentContext, AttachmentPlaintext};
use std::process::Output;
use std::sync::{Arc, Mutex};

static CLI_INVOCATIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static SDK_GETS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct Tap {
    port: u16,
    routes: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Tap {
    fn start(upstream: u16) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let routes = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (record, ending) = (routes.clone(), stop.clone());
        let worker = thread::spawn(move || {
            while !ending.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut client, _)) => {
                        client.set_nonblocking(false).unwrap();
                        client
                            .set_read_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        client
                            .set_write_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        let mut header = Vec::new();
                        while !header.ends_with(b"\r\n\r\n") {
                            assert!(header.len() < 65536, "CLI tap header bound");
                            let mut byte = [0];
                            client.read_exact(&mut byte).expect("CLI tap read");
                            header.push(byte[0]);
                        }
                        let header = String::from_utf8(header).unwrap();
                        let route = header.lines().next().unwrap().to_owned();
                        assert!(route.starts_with("GET "), "CLI recipient must only read");
                        assert!(!route.contains("sharing-snapshot") && !route.contains("/v1/"));
                        record.lock().unwrap().push(route);
                        let mut server = TcpStream::connect(("127.0.0.1", upstream)).unwrap();
                        server
                            .set_read_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        server
                            .set_write_timeout(Some(Duration::from_secs(10)))
                            .unwrap();
                        for line in header.lines().filter(|l| !l.is_empty()) {
                            if !line
                                .split_once(':')
                                .is_some_and(|(k, _)| k.eq_ignore_ascii_case("connection"))
                            {
                                write!(server, "{line}\r\n").unwrap();
                            }
                        }
                        server.write_all(b"Connection: close\r\n\r\n").unwrap();
                        let mut response = Vec::new();
                        server
                            .take(3 * 1024 * 1024 + 1)
                            .read_to_end(&mut response)
                            .unwrap();
                        assert!(response.len() <= 3 * 1024 * 1024);
                        client.write_all(&response).unwrap();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => panic!("CLI tap accept"),
                }
            }
        });
        Self {
            port,
            routes,
            stop,
            worker: Some(worker),
        }
    }
    fn clear(&self) {
        self.routes.lock().unwrap().clear();
    }
    fn seen(&self) -> Vec<String> {
        self.routes.lock().unwrap().clone()
    }
}
impl Drop for Tap {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(w) = self.worker.take() {
            assert!(w.join().is_ok(), "CLI tap worker completion");
        }
    }
}

fn invoke(binary: &std::path::Path, tap: &Tap, input: &Value, args: &[&str]) -> Output {
    tap.clear();
    let mut cmd = command(binary.to_str().unwrap());
    cmd.env_clear();
    for key in ["SystemRoot", "TEMP", "TMP"] {
        if let Some(v) = std::env::var_os(key) {
            cmd.env(key, v);
        }
    }
    let mut child = cmd
        .env("OP_CONNECT_HOST", "http://127.0.0.1:1")
        .env("OP_CONNECT_TOKEN", "synthetic-connect-poison")
        .args([
            "--encrypted",
            "--recipient",
            "--secret-stdin",
            "--passshare-host",
            &format!("http://127.0.0.1:{}", tap.port),
        ])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("real op launch");
    let mut pipe = child.stdin.take().unwrap();
    let write = serde_json::to_writer(&mut pipe, input);
    drop(pipe);
    assert!(write.is_ok(), "CLI pipe input");
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let out = thread::spawn(move || {
        let mut b = Vec::new();
        out.take(2 * 1024 * 1024 + 1).read_to_end(&mut b).unwrap();
        b
    });
    let err = thread::spawn(move || {
        let mut b = Vec::new();
        err.take(65537).read_to_end(&mut b).unwrap();
        b
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(45);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("real op deadline");
        }
        thread::sleep(Duration::from_millis(5));
    };
    let result = Output {
        status,
        stdout: out.join().unwrap(),
        stderr: err.join().unwrap(),
    };
    assert!(result.stdout.len() <= 2 * 1024 * 1024 && result.stderr.len() <= 65536);
    for key in ["sessionToken", "encryptionPassword"] {
        let value = input[key].as_str().unwrap();
        assert!(!String::from_utf8_lossy(&result.stdout).contains(value));
        assert!(!String::from_utf8_lossy(&result.stderr).contains(value));
    }
    if !result.status.success() {
        assert!(result.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("synthetic-secret"));
    }
    result
}
fn read_preserves(
    db: &Database,
    binary: &std::path::Path,
    tap: &Tap,
    input: &Value,
    args: &[&str],
    success: bool,
) -> Output {
    let before = state_hash(db, true);
    let result = invoke(binary, tap, input, args);
    assert!(
        result.status.success() == success,
        "formal CLI outcome (diagnostics suppressed)"
    );
    assert!(
        state_hash(db, true) == before,
        "CLI success/rejection preserves every full row and xmin"
    );
    CLI_INVOCATIONS.fetch_add(1, Ordering::SeqCst);
    SDK_GETS.fetch_add(
        tap.seen()
            .iter()
            .filter(|p| !p.contains("/api/auth/me "))
            .count(),
        Ordering::SeqCst,
    );
    result
}
fn file_context(a: &Account, item: &str, id: &str, version: u64, epoch: u64) -> AttachmentContext {
    serde_json::from_value(json!({"passwordBoxId":a.box_id,"itemId":item,"attachmentId":id,"attachmentVersion":version,"keyEpoch":epoch})).unwrap()
}

#[test]
#[ignore = "requires explicit verified local PG manifest, native/op binaries and owned output directory"]
fn formal_cli_recipient() {
    let supplied =
        |name: &str| PathBuf::from(std::env::var_os(name).expect("explicit CLI fixture input"));
    let manifest = supplied("PASSSHARE_CLI_PG_MANIFEST");
    let binary = supplied("PASSSHARE_CLI_BINARY").canonicalize().unwrap();
    let native = supplied("PASSSHARE_CLI_NATIVE").canonicalize().unwrap();
    let output = supplied("PASSSHARE_CLI_OUTPUT_DIR").canonicalize().unwrap();
    assert!(output.is_dir() && manifest.is_absolute() && binary.is_file() && native.is_file());
    let db = Database::from_local(
        local_postgres::LocalPostgres::start_attachments(&manifest),
        "source",
    );
    println!(
        "CLI fixture created: database={} port={} owner={}",
        db.name, db.port, db.fixture_owner_id
    );
    let network = Network {
        name: String::new(),
    };
    let host = Host::start(&db, &network, &Mode::Node(native));
    let p = host.port;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let a = Account::signup(p);
    let b = Account::signup(p);
    a.register(p, &rt);
    b.register(p, &rt);
    let key = PasswordBoxKey::generate().unwrap();
    call(
        p,
        &a,
        "POST",
        &format!("{}/setup", root(&a)),
        &json!({"bundle":owner_bundle(&key,&a.master,a.salt,&owner_context(&a.box_id,&a.id,1))}),
        200,
    );
    accept(p, &b, &invite(p, &a, &b));
    let rev = || number(&snapshot(p, &a), "stateRevision");
    call(
        p,
        &a,
        "PUT",
        &format!("{}/grants/{}", root(&a), b.id),
        &json!({"expectedStateRevision":rev(),"expectedVersion":0,"keyEpoch":1,"envelope":grant(&key,&a,&b,1)}),
        200,
    );
    let item = ConnectId::generate().unwrap().to_string();
    let files = [
        AttachmentPlaintext::new(
            "../original\0éЖ🦀.bin".into(),
            (0..=255).chain((0..=255).rev()).collect(),
        )
        .unwrap(),
        AttachmentPlaintext::new(String::new(), Vec::new()).unwrap(),
    ];
    let ids = [
        ConnectId::generate().unwrap().to_string(),
        ConnectId::generate().unwrap().to_string(),
    ];
    let mut dto = json!({"id":item,"vault":{"id":a.box_id,"name":"fixture"},"version":1,"category":"CUSTOM","title":"fixture",
        "fields":[{"id":"second","value":"kept","future":[3,1,2]},{"id":"first","purpose":"PASSWORD","value":"synthetic-secret\0Ж"}],
        "sections":[{"id":"z"},{"id":"a"}],"urls":[{"href":"https://second.example.test/"},{"href":"https://first.example.test/"}],
        "tags":["z","a","z"],"favorite":true,"future":{"ordered":[3,1,2],"null":null,"nested":{"flag":false}},"attachments":[]});
    call(
        p,
        &a,
        "PUT",
        &format!("{}/items/{item}", root(&a)),
        &json!({"expectedVersion":0,"envelope":key.encrypt_item(&dto,&context(&a,&item,1,1)).unwrap()}),
        200,
    );
    for (i, file) in files.iter().enumerate() {
        let c = file_context(&a, &item, &ids[i], 1, 1);
        dto["version"] = json!(i + 2);
        dto["attachments"]
            .as_array_mut()
            .unwrap()
            .push(json!({"attachmentId":ids[i],"attachmentVersion":1,"keyEpoch":1}));
        call(
            p,
            &a,
            "PUT",
            &format!("{}/items/{item}/attachments/{}", root(&a), ids[i]),
            &json!({"expectedStateRevision":rev(),"expectedVersion":0,"item":{"expectedVersion":i+1,"envelope":key.encrypt_item(&dto,&context(&a,&item,i as u64+2,1)).unwrap()},"envelope":key.encrypt_attachment(file,&c).unwrap()}),
            200,
        );
    }
    let mut input = json!({"sessionToken":b.session,"encryptionPassword":b.encryption_password,"sharedReceive":{
        "sender":a.pin,"recipient":b.pin,"context":shared_context(&a,&b,1),"identityBundleVersion":1,"itemContext":context(&a,&item,3,1)}});
    let valid = input.clone();
    let tap = Tap::start(p);
    let get = ["item", "get", &item, "--vault", &a.box_id];
    let result = read_preserves(&db, &binary, &tap, &input, &get, true);
    assert!(
        serde_json::from_slice::<Value>(&result.stdout).unwrap() == dto,
        "all JSON/fields/unknown properties/array order"
    );
    let result = read_preserves(
        &db,
        &binary,
        &tap,
        &input,
        &[
            "item", "get", &item, "--vault", &a.box_id, "--fields", "password",
        ],
        true,
    );
    assert!(String::from_utf8(result.stdout).unwrap() == "synthetic-secret\0Ж\n");
    let reference = format!("op://{}/{item}/password", a.box_id);
    let result = read_preserves(&db, &binary, &tap, &input, &["read", &reference], true);
    assert!(String::from_utf8(result.stdout).unwrap() == "synthetic-secret\0Ж\n");
    input["sharedReceive"]
        .as_object_mut()
        .unwrap()
        .remove("itemContext");
    let result = read_preserves(
        &db,
        &binary,
        &tap,
        &input,
        &["item", "list", "--vault", &a.box_id],
        true,
    );
    assert!(String::from_utf8(result.stdout).unwrap() == format!("{item}\t3\n"));
    let revision = rev();
    for (i, file) in files.iter().enumerate() {
        input = valid.clone();
        input["sharedReceive"]["attachmentContext"] = json!(file_context(&a, &item, &ids[i], 1, 1));
        let path = output.join(format!("cli-file-{}", ConnectId::generate().unwrap()));
        let dest = path.to_str().unwrap();
        let args = [
            "attachment",
            "get",
            &ids[i],
            "--item",
            &item,
            "--vault",
            &a.box_id,
            "--out",
            dest,
            "--print-name",
        ];
        let result = read_preserves(&db, &binary, &tap, &input, &args, true);
        assert!(
            std::fs::read(&path).unwrap() == file.content(),
            "all file bytes including empty file"
        );
        assert!(
            serde_json::from_slice::<String>(&result.stdout).unwrap() == file.name(),
            "original Unicode/NUL/empty names preserved"
        );
        assert!(
            tap.seen()
                == vec![
                    "GET /api/auth/me HTTP/1.1".to_owned(),
                    format!("GET {} HTTP/1.1", root(&a)),
                    "GET /api/encrypted/account-identity HTTP/1.1".to_owned(),
                    format!("GET {}/grants/me HTTP/1.1", root(&a)),
                    format!("GET {}/attachment-state HTTP/1.1", root(&a)),
                    format!(
                        "GET {}/items/{item}/attachment-snapshot?revision={revision} HTTP/1.1",
                        root(&a)
                    ),
                    format!(
                        "GET {}/items/{item}/attachments/{}?revision={revision} HTTP/1.1",
                        root(&a),
                        ids[i]
                    )
                ],
            "actual SDK paths, one request each, one revision"
        );
        read_preserves(&db, &binary, &tap, &input, &args, false);
        assert!(
            std::fs::read(&path).unwrap() == file.content(),
            "existing destination unchanged"
        );
    }
    let refused_path = output.join(format!("cli-refused-{}", ConnectId::generate().unwrap()));
    let refused_args = [
        "attachment",
        "get",
        &ids[0],
        "--item",
        &item,
        "--vault",
        &a.box_id,
        "--out",
        refused_path.to_str().unwrap(),
    ];
    let refuse_attachment = |input: &Value, epoch: u64| {
        let mut input = input.clone();
        input["sharedReceive"]["attachmentContext"] =
            json!(file_context(&a, &item, &ids[0], epoch, epoch));
        read_preserves(&db, &binary, &tap, &input, &refused_args, false);
        assert!(
            !refused_path.exists(),
            "rejected download never creates a file"
        );
    };
    input = valid.clone();
    input["sharedReceive"]["attachmentContext"] = json!(file_context(&a, &item, &ids[0], 2, 1));
    read_preserves(&db, &binary, &tap, &input, &refused_args, false);
    assert_eq!(
        tap.seen().len(),
        6,
        "mismatched authenticated reference never requests attachment"
    );
    assert!(!refused_path.exists());
    input = valid.clone();
    // Wrong but self-validating sender pin, independently supplied, is not
    // replaced from the grant reply. No plaintext or file is created.
    let wrong = AccountIdentity::generate(a.identity.context().clone())
        .unwrap()
        .public_identity();
    input["sharedReceive"]["sender"] = json!(wrong);
    input["sharedReceive"]["context"]["senderKeyId"] = json!(wrong.key_id);
    read_preserves(&db, &binary, &tap, &input, &get, false);
    assert_eq!(tap.seen().len(), 4);
    input = valid.clone();
    let wrong_self = AccountIdentity::generate(b.identity.context().clone())
        .unwrap()
        .public_identity();
    input["sharedReceive"]["recipient"] = json!(wrong_self);
    input["sharedReceive"]["context"]["recipientKeyId"] = json!(wrong_self.key_id);
    read_preserves(&db, &binary, &tap, &input, &get, false);
    assert_eq!(tap.seen().len(), 3);
    input = valid.clone();
    input["sharedReceive"]["itemContext"]["itemVersion"] = json!(2);
    read_preserves(&db, &binary, &tap, &input, &get, false);
    assert_eq!(tap.seen().len(), 6);
    input = valid.clone();
    input["sessionToken"] = json!(b.connect);
    let failed = read_preserves(&db, &binary, &tap, &input, &get, false);
    assert!(String::from_utf8_lossy(&failed.stderr).contains("HTTP 401"));
    assert_eq!(tap.seen().len(), 1);
    input = valid.clone();
    // Explicit synthetic confirmation and stale-grant conditions. Each CLI
    // rejection must itself preserve all rows/xmin; no auth rule is relaxed.
    db.sql(&format!(
        "UPDATE vault_memberships SET confirmed_at=NULL WHERE vault_id='{}' AND user_id='{}'",
        a.box_id, b.id
    ));
    let failed = read_preserves(&db, &binary, &tap, &input, &get, false);
    assert!(String::from_utf8_lossy(&failed.stderr).contains("HTTP 403"));
    refuse_attachment(&input, 1);
    db.sql(&format!("UPDATE vault_memberships SET confirmed_at=clock_timestamp() WHERE vault_id='{}' AND user_id='{}'",a.box_id,b.id));
    // Current public epoch 2 with the original epoch-1 grant: an explicitly
    // synthetic stale-grant condition, restored before the real rotation.
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id='{}'",
        a.box_id
    ));
    input["sharedReceive"]["context"]["keyEpoch"] = json!(2);
    input["sharedReceive"]["itemContext"]["keyEpoch"] = json!(2);
    let failed = read_preserves(&db, &binary, &tap, &input, &get, false);
    assert!(String::from_utf8_lossy(&failed.stderr).contains("HTTP 404"));
    assert_eq!(tap.seen().len(), 4);
    refuse_attachment(&input, 2);
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=1 WHERE box_id='{}'",
        a.box_id
    ));
    input = valid.clone();
    db.sql(&format!(
        "UPDATE vault_memberships SET role='readonly' WHERE vault_id='{}' AND user_id='{}'",
        a.box_id, b.id
    ));
    read_preserves(&db, &binary, &tap, &input, &get, true);
    // Real owner rotation removes B and seals every surviving item/file. The
    // recipient CLI does not perform this unsupported write operation.
    let new = PasswordBoxKey::generate().unwrap();
    let op = operation_id(&db);
    let rotation = format!("{}/rotations/{op}", root(&a));
    call(
        p,
        &a,
        "PUT",
        &rotation,
        &json!({"expectedStateRevision":rev(),"expectedKeyEpoch":1,"expectedOwnerBundleVersion":1,"removeAccountId":b.id,
        "bundle":owner_bundle(&new,&a.master,a.salt,&owner_context(&a.box_id,&a.id,2))}),
        200,
    );
    let mut next = dto.clone();
    next["version"] = json!(4);
    for r in next["attachments"].as_array_mut().unwrap() {
        r["attachmentVersion"] = json!(2);
        r["keyEpoch"] = json!(2);
    }
    call(
        p,
        &a,
        "PUT",
        &format!("{rotation}/items/{item}"),
        &json!({"expectedVersion":3,"envelope":new.encrypt_item(&next,&context(&a,&item,4,2)).unwrap()}),
        200,
    );
    for (i, file) in files.iter().enumerate() {
        call(
            p,
            &a,
            "PUT",
            &format!("{rotation}/items/{item}/attachments/{}", ids[i]),
            &json!({"expectedVersion":1,"envelope":new.encrypt_attachment(file,&file_context(&a,&item,&ids[i],2,2)).unwrap()}),
            200,
        );
    }
    let committed = call(
        p,
        &a,
        "POST",
        &format!("{rotation}/commit"),
        &json!({"currentPassword":a.login_password}),
        200,
    );
    assert!(committed["status"] == "committed" && committed["keyEpoch"] == 2);
    read_preserves(&db, &binary, &tap, &input, &get, false);
    refuse_attachment(&input, 1);
    let (status, login) = http(
        p,
        "POST",
        "/api/auth/login",
        "x-passshare-client: mobile\r\n",
        &json!({"email":b.email,"password":b.login_password}),
    );
    assert_eq!(
        status, 200,
        "removed recipient can log in to their own account"
    );
    input["sessionToken"] = login["refreshToken"].clone();
    read_preserves(&db, &binary, &tap, &input, &get, false);
    refuse_attachment(&input, 1);
    input["sharedReceive"]["context"]["keyEpoch"] = json!(2);
    input["sharedReceive"]["itemContext"] = json!(context(&a, &item, 4, 2));
    read_preserves(&db, &binary, &tap, &input, &get, false);
    refuse_attachment(&input, 2);
    drop(tap);
    drop(host);
    drop(db);
    assert!(
        !CLEANUP_FAILED.load(Ordering::SeqCst),
        "owned Node/DB cleanup completed"
    );
    println!("formal CLI recipient passed: complete DTO/list/get/read; 2 names and all bytes including empty; exact single SDK requests; no overwrite; wrong pin/old item/Connect/unconfirmed/stale grant and actual removal old/new session refusals; all CLI reads preserve full rows/xmin; owned Node and DB removed");
    println!(
        "CLI_INVOCATIONS={} SDK_GETS={}",
        CLI_INVOCATIONS.load(Ordering::SeqCst),
        SDK_GETS.load(Ordering::SeqCst)
    );
}
