//! Finite real-binary recipient transport and trust-boundary regressions.
use super::*;
use passshare_connect::AccountIdentityBundle;
use passshare_core::cloud_crypto::{
    AccountIdentity, AccountIdentityContext, ItemContext, SharedKeyContext,
};

const RECIPIENT: &str = "22222222-2222-4222-8222-222222222222";
struct Fixture {
    input: Value,
    replies: Vec<Value>,
    dto: Value,
}
impl Fixture {
    fn new() -> Self {
        let identity = |id: &str| {
            AccountIdentity::generate(AccountIdentityContext {
                account_id: id.parse().unwrap(),
                identity_version: 1,
            })
            .unwrap()
        };
        let sender = identity(OWNER);
        let recipient = identity(RECIPIENT);
        let s = sender.public_identity();
        let r = recipient.public_identity();
        let context = SharedKeyContext {
            password_box_id: BOX.parse().unwrap(),
            sender_account_id: s.account_id,
            recipient_account_id: r.account_id,
            key_epoch: 1,
            sender_identity_version: 1,
            recipient_identity_version: 1,
            sender_key_id: s.key_id.clone(),
            recipient_key_id: r.key_id.clone(),
        };
        let password = random_password();
        let salt = crypto::generate_salt().unwrap();
        let master = crypto::derive_master_key(&password, &salt).unwrap();
        let bundle =
            AccountIdentityBundle::new(STANDARD.encode(salt), recipient.wrap(&master).unwrap())
                .unwrap();
        let key = PasswordBoxKey::generate().unwrap();
        let item_context = ItemContext {
            password_box_id: BOX.parse().unwrap(),
            item_id: LEGACY_ITEM.parse().unwrap(),
            item_version: 3,
            key_epoch: 1,
        };
        let dto = json!({"id":LEGACY_ITEM,"vault":{"id":BOX},"version":3,"category":"CUSTOM","title":"visible",
            "fields":[{"id":"second","value":"retained","unknown":[3,1,2]},{"id":"first","purpose":"PASSWORD","value":FIELD}],
            "tags":["z","a","z"],"urls":[{"href":"https://example.test/"}],"unknown":{"nested":[null,true,"\0Ж"]}});
        let envelope = key.encrypt_item(&dto, &item_context).unwrap();
        let grant = key.wrap_for_recipient(&sender, &r, &context).unwrap();
        Self {
            input: json!({"sessionToken":TOKEN,"encryptionPassword":password.as_str(),"sharedReceive":{
                "sender":s,"recipient":r,"context":context,"identityBundleVersion":1,"itemContext":item_context}}),
            replies: vec![
                json!({"user":{"id":RECIPIENT}}),
                json!({"mode":"encrypted","keyEpoch":1}),
                json!({"bundleVersion":1,"identity":r,"bundle":bundle}),
                json!({"grantVersion":1,"keyEpoch":1,"envelope":grant}),
                json!({"stateRevision":7,"keyEpoch":1}),
                json!(envelope),
            ],
            dto,
        }
    }
    fn run(&self, args: &[&str], failure: Option<(usize, u16)>) -> (Output, Vec<String>) {
        self.raw(
            args,
            failure,
            Zeroizing::new(self.input.to_string()).as_str(),
        )
    }
    fn raw(
        &self,
        args: &[&str],
        failure: Option<(usize, u16)>,
        raw: &str,
    ) -> (Output, Vec<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let child_stop = stop.clone();
        let replies = self.replies.clone();
        let worker = thread::spawn(move || {
            let mut paths = Vec::new();
            while !child_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(5)))
                            .unwrap();
                        let mut header = Zeroizing::new(Vec::new());
                        while !header.ends_with(b"\r\n\r\n") {
                            assert!(header.len() < 32768);
                            let mut byte = [0];
                            stream.read_exact(&mut byte).unwrap();
                            header.push(byte[0]);
                        }
                        let header = Zeroizing::new(String::from_utf8(header.to_vec()).unwrap());
                        let path = header.lines().next().unwrap().to_owned();
                        assert!(path.starts_with("GET "));
                        let index = paths.len();
                        paths.push(path);
                        let status = failure.filter(|(i, _)| *i == index).map_or(200, |(_, s)| s);
                        let body = if status == 200 {
                            replies.get(index).unwrap().to_string()
                        } else {
                            json!({"error":{"code":"PS016","message":FIELD}}).to_string()
                        };
                        write!(stream,"HTTP/1.1 {status} status\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
            paths
        });
        let mut child = Command::new(env!("CARGO_BIN_EXE_op"))
            .env_clear()
            .env(
                "SystemRoot",
                std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
            )
            .env("OP_CONNECT_HOST", "http://127.0.0.1:1")
            .env("OP_CONNECT_TOKEN", "forbidden-connect-marker")
            .args([
                "--encrypted",
                "--recipient",
                "--secret-stdin",
                "--passshare-host",
                &host,
            ])
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let write = child.stdin.take().unwrap().write_all(raw.as_bytes());
        assert!(write.is_ok() || write.unwrap_err().kind() == std::io::ErrorKind::BrokenPipe);
        let out = child.stdout.take().unwrap();
        let err = child.stderr.take().unwrap();
        let out = thread::spawn(move || read_bounded(out));
        let err = thread::spawn(move || read_bounded(err));
        let deadline = Instant::now() + Duration::from_secs(45);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("recipient CLI deadline");
            }
            thread::sleep(Duration::from_millis(5));
        };
        stop.store(true, Ordering::SeqCst);
        let paths = worker.join().unwrap();
        let output = Output {
            status,
            stdout: out.join().unwrap(),
            stderr: err.join().unwrap(),
        };
        for secret in [
            TOKEN,
            self.input["encryptionPassword"].as_str().unwrap(),
            "forbidden-connect-marker",
        ] {
            assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
            assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
        }
        if !output.status.success() {
            assert!(output.stdout.is_empty());
            assert!(!String::from_utf8_lossy(&output.stderr).contains(FIELD));
        }
        (output, paths)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fn wipe(v: &mut Value) {
            match v {
                Value::String(s) => zeroize::Zeroize::zeroize(s),
                Value::Array(a) => a.iter_mut().for_each(wipe),
                Value::Object(o) => o.values_mut().for_each(wipe),
                _ => {}
            }
        }
        wipe(&mut self.input);
        wipe(&mut self.dto);
    }
}

#[test]
fn recipient_reads_complete_dto_selected_field_reference_and_public_list() {
    let mut f = Fixture::new();
    let args = ["item", "get", LEGACY_ITEM, "--vault", BOX];
    let (out, paths) = f.run(&args, None);
    assert!(out.status.success());
    assert!(serde_json::from_slice::<Value>(&out.stdout).unwrap() == f.dto);
    assert_eq!(paths.len(), 6);
    assert!(paths[3].contains("/grants/me "));
    assert!(paths[4].contains("/attachment-state "));
    assert!(paths[5].contains("/attachment-snapshot?revision=7 "));
    assert!(paths
        .iter()
        .all(|p| !p.contains("sharing-snapshot") && !p.contains("/v1/")));
    let (out, _) = f.run(
        &[
            "item",
            "get",
            LEGACY_ITEM,
            "--vault",
            BOX,
            "--fields",
            "password",
        ],
        None,
    );
    assert!(out.status.success());
    assert!(out.stdout == format!("{FIELD}\n").as_bytes());
    let reference = format!("op://{BOX}/{LEGACY_ITEM}/password");
    let (out, _) = f.run(&["read", &reference], None);
    assert!(out.status.success());
    assert!(out.stdout == format!("{FIELD}\n").as_bytes());
    f.input["sharedReceive"]
        .as_object_mut()
        .unwrap()
        .remove("itemContext");
    f.replies[4] =
        json!({"items":[{"itemId":LEGACY_ITEM,"itemVersion":3,"keyEpoch":1}],"nextCursor":null});
    let (out, paths) = f.run(&["item", "list", "--vault", BOX], None);
    assert!(out.status.success());
    assert!(out.stdout == format!("{LEGACY_ITEM}\t3\n").as_bytes());
    assert_eq!(paths.len(), 5);
}

#[test]
fn recipient_denials_are_terminal_without_retry_or_plaintext_output() {
    let f = Fixture::new();
    for (index, status) in [(0, 401), (1, 403), (2, 401), (3, 403), (4, 409), (5, 409)] {
        let (out, paths) = f.run(
            &["item", "get", LEGACY_ITEM, "--vault", BOX],
            Some((index, status)),
        );
        assert!(!out.status.success());
        assert_eq!(paths.len(), index + 1);
        assert!(String::from_utf8_lossy(&out.stderr).contains(&format!("HTTP {status}")));
    }
}

#[test]
fn recipient_rejects_missing_alias_duplicate_unknown_null_and_unsafe_trust_before_http() {
    let mut f = Fixture::new();
    let valid = f.input.clone();
    let args = ["item", "get", LEGACY_ITEM, "--vault", BOX];
    // First establish that the injected transport is used for a valid command.
    assert!(f.run(&args, None).0.status.success());
    for (path, value) in [
        ("/sharedReceive/context/keyEpoch", json!(0)),
        (
            "/sharedReceive/context/keyEpoch",
            json!(9007199254740992u64),
        ),
        ("/sharedReceive/context/keyEpoch", json!(1.5)),
        ("/sharedReceive/itemContext", Value::Null),
        ("/sharedReceive/sender", Value::Null),
        (
            "/sharedReceive/recipient/accountId",
            json!("{22222222-2222-4222-8222-222222222222}"),
        ),
        ("/sharedReceive/identityBundleVersion", json!(0)),
        (
            "/sharedReceive/identityBundleVersion",
            json!(9007199254740992u64),
        ),
    ] {
        f.input = valid.clone();
        *f.input.pointer_mut(path).unwrap() = value;
        let (out, paths) = f.run(&args, None);
        assert!(!out.status.success());
        assert!(paths.is_empty());
    }
    for name in [
        "sender",
        "recipient",
        "context",
        "identityBundleVersion",
        "itemContext",
    ] {
        f.input = valid.clone();
        f.input["sharedReceive"]
            .as_object_mut()
            .unwrap()
            .remove(name);
        let (out, paths) = f.run(&args, None);
        assert!(!out.status.success());
        assert!(paths.is_empty());
    }
    f.input = valid.clone();
    f.input["sharedReceive"]["unknown"] = json!(FIELD);
    assert!(f.run(&args, None).1.is_empty());
    f.input = valid;
    let raw = Zeroizing::new(f.input.to_string().replacen(
        "\"identityBundleVersion\":1",
        "\"identityBundleVersion\":1,\"identityBundleVersion\":1",
        1,
    ));
    let (out, paths) = f.raw(&args, None, &raw);
    assert!(!out.status.success());
    assert!(paths.is_empty());
    for args in [
        vec!["item", "delete", LEGACY_ITEM, "--vault", BOX],
        vec!["item", "retry", "--vault", BOX],
        vec!["vault", "list"],
        vec!["--prepare-only", "item", "get", LEGACY_ITEM, "--vault", BOX],
    ] {
        let (out, paths) = f.run(&args, None);
        assert!(!out.status.success());
        assert!(paths.is_empty());
    }
}

#[test]
fn recipient_never_adopts_reply_identity_bundle_epoch_or_item_context() {
    let mut f = Fixture::new();
    let replies = f.replies.clone();
    for (index, path, value) in [
        (0, "/user/id", json!(OWNER)),
        (1, "/keyEpoch", json!(2)),
        (2, "/bundleVersion", json!(2)),
        (3, "/keyEpoch", json!(2)),
        (3, "/envelope/context/keyEpoch", json!(2)),
        (4, "/keyEpoch", json!(2)),
        (5, "/context/itemVersion", json!(4)),
        (5, "/ciphertext", json!("tampered")),
    ] {
        f.replies = replies.clone();
        *f.replies[index].pointer_mut(path).unwrap() = value;
        let (out, paths) = f.run(&["item", "get", LEGACY_ITEM, "--vault", BOX], None);
        assert!(!out.status.success());
        assert_eq!(paths.len(), index + 1);
    }
}
