//! Actual owner CLI -> formal Node/image -> isolated PostgreSQL acceptance.
//! Billing periods below are explicit SQL fixtures, not signed payment delivery.
use super::*;
use passshare_core::cloud_crypto::{AttachmentContext, AttachmentPlaintext, EncryptedAttachment};

fn invoke(
    binary: &std::path::Path,
    port: u16,
    input: &Value,
    args: &[&str],
) -> std::process::Output {
    let mut cmd = command(binary.to_str().unwrap());
    cmd.env_clear();
    for key in ["SystemRoot", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    let mut child = cmd
        .env("OP_CONNECT_HOST", "http://127.0.0.1:1")
        .env("OP_CONNECT_TOKEN", "synthetic-unused-connect")
        .args([
            "--encrypted",
            "--secret-stdin",
            "--passshare-host",
            &format!("http://127.0.0.1:{port}"),
        ])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("real owner op launch");
    let mut pipe = child.stdin.take().unwrap();
    serde_json::to_writer(&mut pipe, input).expect("CLI secret pipe");
    drop(pipe);
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let collect = |stream: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            stream.take(65537).read_to_end(&mut bytes).unwrap();
            bytes
        })
    };
    let stdout = collect(Box::new(stdout));
    let stderr = collect(Box::new(stderr));
    let deadline = std::time::Instant::now() + Duration::from_secs(100);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("owner CLI deadline");
        }
        thread::sleep(Duration::from_millis(5));
    };
    let result = std::process::Output {
        status,
        stdout: stdout.join().unwrap(),
        stderr: stderr.join().unwrap(),
    };
    assert!(result.stdout.len() <= 65536 && result.stderr.len() <= 65536);
    for secret in ["sessionToken", "encryptionPassword"] {
        let value = input[secret].as_str().unwrap();
        assert!(!String::from_utf8_lossy(&result.stdout).contains(value));
        assert!(!String::from_utf8_lossy(&result.stderr).contains(value));
    }
    assert!(!String::from_utf8_lossy(&result.stdout).contains("bulk-plaintext-sentinel"));
    assert!(!String::from_utf8_lossy(&result.stderr).contains("bulk-plaintext-sentinel"));
    result
}
fn contract(db: &Database, p: u16, a: &Account) -> String {
    let q = call(
        p,
        a,
        "POST",
        "/api/commercial-contracts",
        &json!({"requestId":operation_id(db),"currency":"JPY","plan":{"type":"personal","users":1},"setup":{"installationCompanies":0,"supportHours":0,"maintenanceMonthlyJpy":null}}),
        201,
    );
    let id = text_field(&q, "id");
    call(
        p,
        a,
        "POST",
        &format!("/api/commercial-contracts/{id}/accept"),
        &json!({"quoteHash":q["quoteHash"]}),
        200,
    );
    id
}
#[test]
#[ignore = "requires explicit owned Docker PG, formal backend/op binaries and owned output directory"]
fn formal_cli_bulk_export() {
    let supplied =
        |name: &str| PathBuf::from(std::env::var_os(name).expect("explicit bulk CLI input"));
    let binary = supplied("PASSSHARE_CLI_BINARY").canonicalize().unwrap();
    let output = supplied("PASSSHARE_CLI_OUTPUT_DIR").canonicalize().unwrap();
    assert!(binary.is_file() && output.is_dir());
    let selector =
        std::env::var("PASSSHARE_CLI_DOCKER_MODE").expect("explicit Docker fixture mode");
    let mode = match selector.as_str() {
        "node" => Mode::Node(supplied("PASSSHARE_CLI_NATIVE").canonicalize().unwrap()),
        "image" => Mode::parse(&[
            "--image".into(),
            std::env::var_os("PASSSHARE_CLI_IMAGE").expect("explicit fixture image"),
        ])
        .unwrap(),
        _ => panic!("choose explicit node or image fixture"),
    };
    let network = Network::start();
    let db = Database::start(&network);
    println!(
        "bulk fixture source={} network={} owner={}",
        db.name, network.name, db.fixture_owner_id
    );
    let host = Host::start(&db, &network, &mode);
    let p = host.port;
    let a = Account::signup(p);
    let b = Account::signup(p);
    let key = PasswordBoxKey::generate().unwrap();
    call(
        p,
        &a,
        "POST",
        &format!("{}/setup", root(&a)),
        &json!({"bundle":owner_bundle(&key,&a.master,a.salt,&owner_context(&a.box_id,&a.id,1))}),
        200,
    );
    let mut expected = BTreeMap::new();
    for n in 0..12 {
        let id = ConnectId::generate().unwrap().to_string();
        let mut value = dto(&a, &id, n, "bulk-plaintext-sentinel");
        value["attachments"] = json!([]);
        call(
            p,
            &a,
            "PUT",
            &format!("{}/items/{id}", root(&a)),
            &json!({"expectedVersion":0,"envelope":key.encrypt_item(&value,&context(&a,&id,1,1)).unwrap()}),
            200,
        );
        expected.insert(id, value);
    }
    let item = expected.keys().next().unwrap().clone();
    let file_id = ConnectId::generate().unwrap().to_string();
    let file_context:AttachmentContext=serde_json::from_value(json!({"passwordBoxId":a.box_id,"itemId":item,"attachmentId":file_id,"attachmentVersion":1,"keyEpoch":1})).unwrap();
    let bytes: Vec<u8> = (0..=255).chain((0..=255).rev()).collect();
    let file = AttachmentPlaintext::new("../held/日本語\0.bin".into(), bytes.clone()).unwrap();
    let value = expected.get_mut(&item).unwrap();
    value["version"] = json!(2);
    value["attachments"] = json!([{"attachmentId":file_id,"attachmentVersion":1,"keyEpoch":1}]);
    call(
        p,
        &a,
        "PUT",
        &format!("{}/items/{item}/attachments/{file_id}", root(&a)),
        &json!({"expectedStateRevision":snapshot(p,&a)["stateRevision"],"expectedVersion":0,
        "item":{"expectedVersion":1,"envelope":key.encrypt_item(value,&context(&a,&item,2,1)).unwrap()},
        "envelope":key.encrypt_attachment(&file,&file_context).unwrap()}),
        200,
    );
    let unpaid = contract(&db, p, &a);
    let paid = contract(&db, p, &a);
    // Only this invocation's isolated DB is changed. The period ended five days
    // ago: actual server authorization must allow only the 30-day export window.
    db.sql(&format!("INSERT INTO commercial_live_contracts(contract_id,contract_start) VALUES('{paid}',CURRENT_DATE-35); INSERT INTO commercial_live_periods(account_id,event_id,contract_id,cycle,period_start,period_end,amount_jpy,provider_object_id,event_hash,evidence) VALUES('acct_cli_bulk','evt_{paid}','{paid}',1,CURRENT_DATE-35,CURRENT_DATE-5,980,'pi_{paid}','synthetic-client-export-only','provider_live')"));
    drop(host);
    // Compose the existing full-row archive/authorization qualification with
    // this client path: restored API -> contract export -> offline Core files.
    let restored = encrypted_restore::attachment_roundtrip(&db, &network);
    println!("bulk fixture restored={}", restored.name);
    let host = Host::start(&restored, &network, &mode);
    let p = host.port;
    let path = output.join(format!("bulk-{}.json", ConnectId::generate().unwrap()));
    let path_text = path.to_str().unwrap();
    let input = json!({"sessionToken":a.session,"encryptionPassword":a.encryption_password});
    let before = state_hash(&restored, true);
    let args = [
        "export",
        "--contract",
        paid.as_str(),
        "--vault",
        a.box_id.as_str(),
        "--out",
        path_text,
    ];
    let unpaid_args = [
        "export",
        "--contract",
        unpaid.as_str(),
        "--vault",
        a.box_id.as_str(),
        "--out",
        path_text,
    ];
    let denied = invoke(&binary, p, &input, &unpaid_args);
    assert!(!denied.status.success() && !path.exists());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("403"));
    let other = json!({"sessionToken":b.session,"encryptionPassword":b.encryption_password});
    let denied = invoke(&binary, p, &other, &args);
    assert!(!denied.status.success() && !path.exists());
    let saved = invoke(&binary, p, &input, &args);
    assert!(
        saved.status.success(),
        "formal bulk export failed (diagnostics suppressed)"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&saved.stdout).unwrap(),
        json!({"exported":true,"items":12,"attachments":1,"ciphertextOnly":true})
    );
    assert_eq!(
        state_hash(&restored, true),
        before,
        "export must preserve encryption/identity/Connect business rows"
    );
    let encoded = std::fs::read(&path).unwrap();
    let raw = String::from_utf8(encoded.clone()).unwrap();
    for secret in [&a.session, &a.encryption_password] {
        assert!(!raw.contains(secret));
    }
    assert!(!raw.contains("bulk-plaintext-sentinel"));
    let again = invoke(&binary, p, &input, &args);
    assert!(!again.status.success());
    assert_eq!(std::fs::read(&path).unwrap(), encoded);
    let archive: Value = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(archive["items"].as_array().unwrap().len(), 12);
    assert_eq!(archive["attachments"].as_array().unwrap().len(), 1);
    let owner = owner_context(&a.box_id, &a.id, 1);
    assert_eq!(archive["ownerContext"], json!(owner));
    drop(host);
    drop(restored);
    drop(db);
    drop(network); // No service may be needed to recover.
    let reopened = unwrap_bundle(&archive["ownerBundle"], &a.encryption_password, &owner).unwrap();
    let mut recovered = BTreeMap::new();
    for item in archive["items"].as_array().unwrap() {
        let sealed: EncryptedItem = serde_json::from_value(item.clone()).unwrap();
        let id = sealed.context.item_id.to_string();
        let expected_value = expected
            .get(&id)
            .expect("archive item must be in independently held inventory");
        let c = context(&a, &id, expected_value["version"].as_u64().unwrap(), 1);
        assert_eq!(reopened.decrypt_item(&sealed, &c).unwrap(), *expected_value);
        assert!(recovered.insert(id, ()).is_none());
    }
    assert_eq!(recovered.len(), expected.len());
    let sealed: EncryptedAttachment =
        serde_json::from_value(archive["attachments"][0].clone()).unwrap();
    let recovered_file = reopened.decrypt_attachment(&sealed, &file_context).unwrap();
    assert_eq!(recovered_file.name(), file.name());
    assert_eq!(recovered_file.content(), bytes);
    std::fs::remove_file(&path).unwrap();
    assert!(!path.exists());
    assert!(!CLEANUP_FAILED.load(Ordering::SeqCst));
    println!("bulk CLI accepted: formal backend/restored owned PG, 12 complete DTOs + binary file, unpaid/foreign owner refused, no replacement, offline Core exact recovery, owned resources reclaimed; billing period is synthetic SQL only");
}
