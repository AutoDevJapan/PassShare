use super::*;
use passshare_core::{
    cloud_crypto::{
        migration::{
            prepare_migration, MigrationItemBinding, MigrationItemSource, TrustedOwnerKeyContext,
        },
        PasswordBoxKey,
    },
    crypto::MasterKey,
};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

const BOX: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ITEM: &str = "iiiiiiiiiiiiiiiiiiiiiiiiii";
const FILE: &str = "ffffffffffffffffffffffffff";
const TOKEN: &str = "synthetic-migration-session";
fn context() -> ItemContext {
    ItemContext {
        password_box_id: BOX.parse().unwrap(),
        item_id: ITEM.parse().unwrap(),
        item_version: 17,
        key_epoch: 1,
    }
}
fn file_context() -> AttachmentContext {
    AttachmentContext {
        password_box_id: BOX.parse().unwrap(),
        item_id: ITEM.parse().unwrap(),
        attachment_id: FILE.parse().unwrap(),
        attachment_version: 17,
        key_epoch: 1,
    }
}
fn original() -> Value {
    json!({"id":ITEM,"version":17,"vault":{"id":BOX},"unknownInteger":u64::MAX,"unknownFloat":1.0,"unknown":[null,{"nested":[3,2,1]}],"urls":[{"href":"https://example.test","extra":null}]})
}
fn plan() -> (MigrationTransportPlan, PasswordBoxKey, Value) {
    let key = PasswordBoxKey::generate().unwrap();
    let owner = OwnerKeyContext {
        password_box_id: BOX.parse().unwrap(),
        owner_account_id: "7b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10".parse().unwrap(),
        key_epoch: 1,
    };
    let bundle = OwnerKeyBundle::new(
        STANDARD.encode([1u8; 16]),
        key.wrap_for_owner(&MasterKey::generate().unwrap(), &owner)
            .unwrap(),
    )
    .unwrap();
    let original = original();
    let sources = vec![MigrationItemSource {
        item: MigrationItemPlaintext::new(original.clone()).unwrap(),
        attachments: vec![],
    }];
    let bindings = vec![MigrationItemBinding {
        source: context(),
        target: context(),
        attachments: vec![],
    }];
    let prepared = prepare_migration(
        &key,
        &TrustedOwnerKeyContext::new(owner).unwrap(),
        "65c228d3-1a71-4ea8-a431-b87e6162275d".parse().unwrap(),
        &BOX.parse().unwrap(),
        7,
        &sources,
        &bindings,
    )
    .unwrap();
    (
        MigrationTransportPlan::new(&prepared, bundle).unwrap(),
        key,
        original,
    )
}
struct Seen {
    line: String,
    headers: String,
    body: Vec<u8>,
}
struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    task: Option<thread::JoinHandle<Vec<Seen>>>,
}
impl Server {
    fn start(replies: Vec<Option<(u16, String)>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let task = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut seen = Vec::new();
            for reply in replies {
                let mut stream = loop {
                    if flag.load(Ordering::SeqCst) || Instant::now() >= deadline {
                        return seen;
                    }
                    match listener.accept() {
                        Ok((s, _)) => break s,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(_) => return seen,
                    }
                };
                // Winsock inherits nonblocking mode from the listener.
                if stream.set_nonblocking(false).is_err() {
                    return seen;
                }
                if stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .is_err()
                    || stream
                        .set_write_timeout(Some(Duration::from_secs(2)))
                        .is_err()
                {
                    return seen;
                }
                let mut wire = Vec::new();
                let mut buf = [0u8; 4096];
                let (end, len) = loop {
                    if Instant::now() >= deadline || flag.load(Ordering::SeqCst) {
                        return seen;
                    }
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => return seen,
                        Ok(n) => wire.extend_from_slice(&buf[..n]),
                    }
                    if let Some(end) = wire.windows(4).position(|s| s == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&wire[..end]);
                        let len = headers
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|s| s.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if wire.len() >= end + 4 + len {
                            break (end, len);
                        }
                    }
                    if wire.len() > MAX_HTTP {
                        return seen;
                    }
                };
                let headers = String::from_utf8_lossy(&wire[..end]).into_owned();
                let line = headers.lines().next().unwrap_or("").to_owned();
                seen.push(Seen {
                    line,
                    headers,
                    body: wire[end + 4..end + 4 + len].to_vec(),
                });
                if let Some((status, body)) = reply {
                    let response=format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                    let _ = stream.write_all(response.as_bytes());
                }
            }
            seen
        });
        Self {
            url,
            stop,
            task: Some(task),
        }
    }
    fn client(&self) -> EncryptedSessionClient {
        EncryptedSessionClient::new(&self.url, TOKEN).unwrap()
    }
    fn finish(mut self) -> Vec<Seen> {
        self.stop.store(true, Ordering::SeqCst);
        self.task.take().unwrap().join().unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}
fn reply(v: Value) -> Option<(u16, String)> {
    Some((200, v.to_string()))
}

#[test]
fn strict_json_preserves_complete_numeric_and_array_values_and_rejects_duplicates() {
    let original = original();
    let bytes = serde_json::to_vec(&original).unwrap();
    let parsed = SecretJson::parse(&bytes).unwrap();
    assert!(parsed.0 == original);
    assert_eq!(parsed.0["unknownInteger"].as_u64(), Some(u64::MAX));
    assert!(parsed.0["unknownFloat"].is_f64());
    for invalid in [
        r#"{"unknown":{"password":"first","password":"second"}}"#,
        r#"{"x":1,"x":2}"#,
        r#"{"x":1} {}"#,
    ] {
        let error = SecretJson::parse(invalid.as_bytes()).err().unwrap();
        assert!(!format!("{error:?}").contains("first"));
    }
}
#[test]
fn missing_null_and_real_zero_file_are_distinct_and_owned() {
    let c = file_context();
    let base = json!({"id":FILE,"itemId":ITEM,"name":"空.bin","contentBytes":0,"available":true,"content":""});
    let zero = source_file(&serde_json::to_vec(&base).unwrap(), &c).unwrap();
    assert!(zero
        .available()
        .is_some_and(|f| f.content().is_empty() && f.name() == "空.bin"));
    let mut missing = base.clone();
    missing["available"] = json!(false);
    missing["content"] = Value::Null;
    assert!(source_file(&serde_json::to_vec(&missing).unwrap(), &c)
        .unwrap()
        .missing_metadata()
        .is_some());
    for mutation in [
        json!({"content":null}),
        json!({"contentBytes":1}),
        json!({"available":false}),
        json!({"content":"AA=="}),
        json!({"contentBytes":1.0}),
        json!({"extra":true}),
        json!({"itemId":BOX}),
    ] {
        let mut bad = base.clone();
        bad.as_object_mut()
            .unwrap()
            .extend(mutation.as_object().unwrap().clone());
        assert!(source_file(&serde_json::to_vec(&bad).unwrap(), &c).is_err());
    }
    let mut missing_field = base;
    missing_field.as_object_mut().unwrap().remove("content");
    assert!(source_file(&serde_json::to_vec(&missing_field).unwrap(), &c).is_err());
}
#[test]
fn public_contract_rejects_unknown_fields_aliases_and_unsafe_numbers() {
    let valid = json!({"sourcePasswordBoxId":BOX,"sourceRevision":7,"itemCount":0,"attachmentCount":0,"keyEpoch":1});
    assert!(decode::<MigrationSourceSnapshot>(&serde_json::to_vec(&valid).unwrap()).is_ok());
    for mutation in [
        json!({"sourceRevision":1.0}),
        json!({"itemCount":-1}),
        json!({"source_revision":7}),
        json!({"extra":null}),
    ] {
        let mut bad = valid.clone();
        bad.as_object_mut()
            .unwrap()
            .extend(mutation.as_object().unwrap().clone());
        assert!(decode::<MigrationSourceSnapshot>(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
    for invalid in [
        r#"{"status":"pending","status":"committed"}"#,
        r#"{"status":"unknown"}"#,
        r#"{"status":"pending","operationId":"extra"}"#,
    ] {
        assert!(decode::<StateReply>(invalid.as_bytes()).is_err());
    }
}
#[tokio::test]
async fn frozen_stage_and_readback_use_core_and_explicit_status_before_replay() {
    let (plan, key, original) = plan();
    let staged = json!(plan.items[0].dto);
    let server = Server::start(vec![
        reply(json!({"status":"pending"})),
        reply(json!({"status":"pending"})),
        reply(staged.clone()),
        reply(json!({"status":"pending","expired":false,"header":plan.header})),
        reply(json!({"status":"pending"})),
    ]);
    let client = server.client();
    assert_eq!(
        client.stage_migration_header(&plan).await.unwrap(),
        MigrationState::Pending
    );
    client.stage_migration_item(&plan, 0).await.unwrap();
    let read = client.staged_migration_item(&plan, 0).await.unwrap();
    let opened =
        MigrationItemPlaintext::new(key.decrypt_item(&read.envelope, &context()).unwrap()).unwrap();
    assert!(opened.json()["original"] == original);
    assert!(PasswordBoxKey::generate()
        .unwrap()
        .decrypt_item(&read.envelope, &context())
        .is_err());
    assert_eq!(
        client.migration_status(&plan).await.unwrap().status,
        MigrationState::Pending
    );
    client.stage_migration_item(&plan, 0).await.unwrap();
    let seen = server.finish();
    assert_eq!(seen.len(), 5);
    assert!(seen[1].body == seen[4].body && seen[1].body == plan.item_request_bytes(0).unwrap());
    assert!(seen
        .iter()
        .all(|s| s.headers.contains(&format!("Bearer {TOKEN}"))
            && !s.headers.to_ascii_lowercase().contains("cookie:")));
    assert!(seen[0].body == plan.header_request_bytes());
    assert!(seen[2].line.contains("/migrations/") && seen[2].body.is_empty());
    assert!(plan.core_replay_bytes() == plan.core_replay.as_slice());
}
#[tokio::test]
async fn response_loss_requires_status_and_explicit_commit_retry_without_automatic_request() {
    let (plan, _, _) = plan();
    let server = Server::start(vec![
        None,
        reply(json!({"status":"committed","expired":false,"header":plan.header})),
        reply(json!({"status":"committed","operationId":plan.header.operation_id})),
    ]);
    let client = server.client();
    assert!(client.commit_migration(&plan).await.is_err());
    assert_eq!(
        client.migration_status(&plan).await.unwrap().status,
        MigrationState::Committed
    );
    assert_eq!(
        client.commit_migration(&plan).await.unwrap(),
        MigrationState::Committed
    );
    let seen = server.finish();
    assert_eq!(seen.len(), 3);
    assert!(
        seen[0].line.starts_with("POST ")
            && seen[1].line.starts_with("GET ")
            && seen[2].line.starts_with("POST ")
    );
    assert!(seen.iter().all(|s| s.body.is_empty()));
}
#[tokio::test]
async fn server_rejections_keep_status_and_static_codes_without_body_or_token() {
    let (plan, _, _) = plan();
    let replies = [401, 403, 409, 429, 503]
        .iter()
        .map(|s| {
            Some((
                *s,
                format!(r#"{{"error":"PS015","message":"body-{TOKEN}"}}"#),
            ))
        })
        .collect();
    let server = Server::start(replies);
    let client = server.client();
    for status in [401, 403, 409, 429, 503] {
        let error = client.stage_migration_header(&plan).await.err().unwrap();
        assert_eq!(error.status(), Some(status));
        assert_eq!(error.code(), Some("PS015"));
        assert!(!format!("{error:?} {error}").contains(TOKEN));
    }
    assert_eq!(server.finish().len(), 5);
}
#[tokio::test]
async fn response_context_and_public_alias_mismatches_are_refused() {
    let (plan, _, _) = plan();
    let mut wrong = json!(plan.items[0].dto);
    wrong["binding"]["target"]["itemVersion"] = json!(18);
    let mut header = json!(plan.header);
    header["ownerContext"]["ownerAccountId"] = json!("7B1F3C52-0A4E-4C1D-9A55-3F2D6E8B9C10");
    let server = Server::start(vec![
        reply(wrong),
        reply(json!({"status":"pending","expired":false,"header":header})),
        reply(json!({"status":"committed","operationId":"65C228D3-1A71-4EA8-A431-B87E6162275D"})),
    ]);
    let client = server.client();
    assert!(client.staged_migration_item(&plan, 0).await.is_err());
    assert!(client.migration_status(&plan).await.is_err());
    assert!(client.commit_migration(&plan).await.is_err());
    assert_eq!(server.finish().len(), 3);
}
#[tokio::test]
async fn source_paging_100_plus_one_and_complete_source_json_bind_revision() {
    let mut ids = (0..101).map(|n| format!("{n:026}")).collect::<Vec<_>>();
    ids.sort();
    let page = json!({"items":ids[..100].iter().map(|id|json!({"id":id,"version":17})).collect::<Vec<_>>(),"sourceRevision":7,"after":ids[99]});
    let last = json!({"items":[{"id":ids[100],"version":17}],"sourceRevision":7,"after":null});
    let server = Server::start(vec![
        reply(page),
        reply(last),
        reply(original()),
        reply(json!({"items":[],"sourceRevision":8,"after":null})),
        reply(json!({"items":[],"sourceRevision":7})),
        reply(
            json!({"sourcePasswordBoxId":BOX,"sourceRevision":MAX_SAFE+1,"itemCount":0,"attachmentCount":0,"keyEpoch":1}),
        ),
    ]);
    let client = server.client();
    let first = client.migration_source_items(BOX, 7, None).await.unwrap();
    assert_eq!(first.items.len(), 100);
    let last = client
        .migration_source_items(BOX, 7, first.after.as_ref().map(|c| c.as_str()))
        .await
        .unwrap();
    assert_eq!(last.items.len(), 1);
    assert!(last.after.is_none());
    let full = client.migration_source_item(7, &context()).await.unwrap();
    assert!(full.json() == &original());
    assert!(client.migration_source_items(BOX, 7, None).await.is_err());
    assert!(client.migration_source_items(BOX, 7, None).await.is_err());
    assert!(client.migration_source(BOX).await.is_err());
    let seen = server.finish();
    assert_eq!(seen.len(), 6);
    assert!(seen[1]
        .line
        .contains(&format!("revision=7&after={}", ids[99])));
}
#[tokio::test]
async fn invalid_inputs_do_not_consume_a_positive_control_request() {
    let server = Server::start(vec![reply(
        json!({"items":[],"sourceRevision":7,"after":null}),
    )]);
    let client = server.client();
    assert!(client
        .migration_source_items(BOX, MAX_SAFE + 1, None)
        .await
        .is_err());
    assert!(client
        .migration_source_items(BOX, 7, Some("../bad"))
        .await
        .is_err());
    let mut bad = context();
    bad.key_epoch = 0;
    assert!(client.migration_source_item(7, &bad).await.is_err());
    client.migration_source_items(BOX, 7, None).await.unwrap();
    assert_eq!(server.finish().len(), 1);
}

#[tokio::test]
async fn staged_file_is_frozen_and_core_opens_independent_name_and_every_byte() {
    use passshare_core::cloud_crypto::migration::{
        MigrationAttachmentBinding, MigrationAttachmentSource,
    };
    let key = PasswordBoxKey::generate().unwrap();
    let c = file_context();
    let mut original = original();
    let bytes = (0..=255).chain([0, 254, 255]).collect::<Vec<u8>>();
    let name = "independent🧪.bin";
    original["attachments"] =
        json!([{"attachmentId":FILE,"attachmentVersion":17,"keyEpoch":1,"extra":null}]);
    let sources = vec![MigrationItemSource {
        item: MigrationItemPlaintext::new(original).unwrap(),
        attachments: vec![MigrationAttachmentSource {
            context: c.clone(),
            plaintext: AttachmentPlaintext::new(name.to_owned(), bytes.clone()).unwrap(),
        }],
    }];
    let bindings = vec![MigrationItemBinding {
        source: context(),
        target: context(),
        attachments: vec![MigrationAttachmentBinding {
            source: c.clone(),
            target: c.clone(),
        }],
    }];
    let owner = OwnerKeyContext {
        password_box_id: BOX.parse().unwrap(),
        owner_account_id: "7b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10".parse().unwrap(),
        key_epoch: 1,
    };
    let bundle = OwnerKeyBundle::new(
        STANDARD.encode([1u8; 16]),
        key.wrap_for_owner(&MasterKey::generate().unwrap(), &owner)
            .unwrap(),
    )
    .unwrap();
    let prepared = prepare_migration(
        &key,
        &TrustedOwnerKeyContext::new(owner).unwrap(),
        "65c228d3-1a71-4ea8-a431-b87e6162275d".parse().unwrap(),
        &BOX.parse().unwrap(),
        7,
        &sources,
        &bindings,
    )
    .unwrap();
    let plan = MigrationTransportPlan::new(&prepared, bundle).unwrap();
    let envelope = &plan.items[0].files[0].0;
    let mut wrong = json!(envelope);
    wrong["context"]["attachmentVersion"] = json!(18);
    let server = Server::start(vec![
        reply(json!({"status":"pending"})),
        reply(json!(envelope)),
        reply(json!({"status":"pending"})),
        reply(wrong),
        reply(json!({"status":"aborted"})),
    ]);
    let client = server.client();
    client.stage_migration_file(&plan, 0, 0).await.unwrap();
    let returned = client.staged_migration_file(&plan, 0, 0).await.unwrap();
    let opened = key.decrypt_attachment(&returned, &c).unwrap();
    assert!(opened.name() == name && opened.content() == bytes);
    assert!(PasswordBoxKey::generate()
        .unwrap()
        .decrypt_attachment(&returned, &c)
        .is_err());
    client.stage_migration_file(&plan, 0, 0).await.unwrap();
    assert!(client.staged_migration_file(&plan, 0, 0).await.is_err());
    assert_eq!(
        client.cancel_migration(&plan).await.unwrap(),
        MigrationState::Aborted
    );
    let seen = server.finish();
    assert_eq!(seen.len(), 5);
    assert!(seen[0].body == seen[2].body && seen[0].body == plan.file_request_bytes(0, 0).unwrap());
    assert!(seen[4].line.starts_with("DELETE ") && seen[4].body.is_empty());
}
