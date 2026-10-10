//! Real loopback HTTP contract checks; crypto remains in Core with OS entropy.
use passshare_connect::*;
use passshare_core::cloud_crypto::{AttachmentPlaintext, PasswordBoxKey};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    job: Option<std::thread::JoinHandle<Vec<(String, Value)>>>,
}
impl Server {
    fn new(replies: Vec<(u16, String, String)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let job = std::thread::spawn(move || {
            let mut requests = Vec::new();
            while !flag.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .unwrap();
                        let (head, body) = read(&mut stream);
                        let (status, body_out, extra) = replies
                            .get(requests.len())
                            .cloned()
                            .unwrap_or((503, "{}".into(), String::new()));
                        requests.push((head, body));
                        let response=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body_out}",body_out.len());
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1))
                    }
                    Err(_) => break,
                }
            }
            requests
        });
        Self {
            url,
            stop,
            job: Some(job),
        }
    }
    fn json(replies: Vec<Value>) -> Self {
        Self::new(
            replies
                .into_iter()
                .map(|v| (200, v.to_string(), String::new()))
                .collect(),
        )
    }
    fn finish(mut self) -> Vec<(String, Value)> {
        self.stop.store(true, Ordering::Release);
        self.job.take().unwrap().join().unwrap()
    }
    fn client(&self) -> EncryptedSessionClient {
        EncryptedSessionClient::new(&self.url, "synthetic-session").unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(job) = self.job.take() {
            let _ = job.join();
        }
    }
}
fn read(stream: &mut TcpStream) -> (String, Value) {
    let mut bytes = Vec::new();
    let mut part = [0; 8192];
    let end = loop {
        let n = stream.read(&mut part).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&part[..n]);
        if let Some(p) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
    };
    let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
    let len = head
        .lines()
        .find_map(|l| {
            l.split_once(':')
                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .map(|(_, v)| v.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < end + len {
        let n = stream.read(&mut part).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&part[..n]);
    }
    let body = if len == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&bytes[end..end + len]).unwrap()
    };
    (head, body)
}
fn context(version: u64, epoch: u64) -> AttachmentContext {
    AttachmentContext {
        password_box_id: "a".repeat(26).parse().unwrap(),
        item_id: "b".repeat(26).parse().unwrap(),
        attachment_id: "c".repeat(26).parse().unwrap(),
        attachment_version: version,
        key_epoch: epoch,
    }
}
fn encrypted(c: &AttachmentContext, bytes: Vec<u8>) -> EncryptedAttachment {
    PasswordBoxKey::generate()
        .unwrap()
        .encrypt_attachment(
            &AttachmentPlaintext::new("添付🦀".into(), bytes).unwrap(),
            c,
        )
        .unwrap()
}
fn item(c: &AttachmentContext) -> AttachmentItemWrite {
    let ctx = ItemContext {
        password_box_id: c.password_box_id.clone(),
        item_id: c.item_id.clone(),
        item_version: 4,
        key_epoch: c.key_epoch,
    };
    AttachmentItemWrite{expected_version:3,envelope:PasswordBoxKey::generate().unwrap().encrypt_item(&json!({"id":c.item_id,"version":4,"vault":{"id":c.password_box_id},"attachments":[{"attachmentId":c.attachment_id,"attachmentVersion":c.attachment_version,"keyEpoch":c.key_epoch}]}),&ctx).unwrap()}
}
fn put_reply() -> Value {
    json!({"stateRevision":9,"itemVersion":4,"attachmentVersion":1,"keyEpoch":1})
}
const OWNER: &str = "11111111-1111-4111-8111-111111111111";
fn snapshot() -> Value {
    json!({"stateRevision":7,"keyEpoch":1,"ownerAccountId":OWNER,"ownerBundleVersion":1,"memberCount":2,"liveItemCount":1,"grantCount":1,"liveAttachmentCount":101,"liveAttachmentBytes":20000})
}
fn rotation() -> RotationExpectation {
    RotationExpectation {
        operation_id: "33333333-3333-4333-8333-333333333333".into(),
        password_box_id: context(1, 1).password_box_id,
        owner_account_id: OWNER.into(),
        expected_state_revision: 7,
        expected_key_epoch: 1,
        expected_owner_bundle_version: 1,
        remove_account_id: "22222222-2222-4222-8222-222222222222".into(),
        item_count: Some(1),
        grant_count: Some(0),
    }
}
#[tokio::test]
async fn exact_atomic_put_delete_get_and_maximum_binary_ciphertext() {
    let c = context(1, 1);
    let e = encrypted(&c, vec![0, 255, 128]);
    let write = item(&c);
    let server = Server::json(vec![
        put_reply(),
        json!({"stateRevision":9,"itemVersion":4,"deleted":true,"keyEpoch":1}),
        json!(e),
    ]);
    let client = server.client();
    assert!(client.put_attachment(7, &write, 0, &e, &c).await.is_ok());
    assert!(client.delete_attachment(7, &write, &c).await.is_ok());
    assert!(client.get_attachment(7, &c).await.unwrap() == e);
    let requests = server.finish();
    assert!(requests.len() == 3);
    let route = format!(
        "/api/encrypted/boxes/{}/items/{}/attachments/{}",
        c.password_box_id, c.item_id, c.attachment_id
    );
    assert!(
        requests[0].0.starts_with(&format!("PUT {route} HTTP/1.1"))
            && requests[1]
                .0
                .starts_with(&format!("DELETE {route} HTTP/1.1"))
            && requests[2]
                .0
                .starts_with(&format!("GET {route}?revision=7 HTTP/1.1"))
    );
    assert!(requests.iter().all(|(head, _)| head
        .to_ascii_lowercase()
        .contains("authorization: bearer synthetic-session")));
    assert!(
        requests[0].1
            == json!({"expectedStateRevision":7,"item":write,"expectedVersion":0,"envelope":e})
    );
    assert!(
        requests[1].1
            == json!({"expectedStateRevision":7,"item":write,"expectedVersion":1,"keyEpoch":1})
    );
    assert!(requests[2].1.is_null());
    let max = encrypted(&c, vec![255; 1_048_576]);
    let server = Server::json(vec![json!(max)]);
    assert!(server.client().get_attachment(7, &c).await.unwrap() == max);
    assert!(server.finish().len() == 1);
}
#[tokio::test]
async fn errors_redirects_and_auth_are_redacted_without_retry() {
    let c = context(1, 1);
    let e = encrypted(&c, vec![]);
    let write = item(&c);
    for status in [401, 403, 409] {
        let server = Server::new(vec![
            (
                status,
                json!({"error":"PS015","message":"server-secret"}).to_string(),
                String::new(),
            ),
            (200, put_reply().to_string(), String::new()),
        ]);
        let result = server
            .client()
            .put_attachment(7, &write, 0, &e, &c)
            .await
            .unwrap_err();
        assert!(
            result.status() == Some(status)
                && !format!("{result:?} {result}").contains("server-secret")
        );
        assert!(server.finish().len() == 1);
    }
    let target = Server::json(vec![json!(e)]);
    let server = Server::new(vec![(
        307,
        String::new(),
        format!("Location: {}/redirect-secret\r\n", target.url),
    )]);
    let result = server.client().get_attachment(7, &c).await.unwrap_err();
    assert!(result.status() == Some(307) && !format!("{result:?}").contains("redirect-secret"));
    assert!(server.finish().len() == 1 && target.finish().is_empty());
}
#[tokio::test]
async fn strict_core_envelope_and_reply_unknown_null_integer_base64_context_and_size() {
    let c = context(1, 1);
    let e = encrypted(&c, vec![0, 255]);
    let mut invalid = Vec::new();
    for (path, value) in [
        ("/extra", Value::Null),
        ("/format", json!(1.0)),
        ("/contentBytes", json!(1_048_577)),
        ("/contentBytes", Value::Null),
        ("/nonce", json!("not canonical")),
        ("/context/keyEpoch", json!(2)),
        ("/context/attachmentVersion", json!(2)),
        ("/context/itemId", json!("d".repeat(26))),
        ("/context/passwordBoxId", json!("d".repeat(26))),
        ("/context/attachmentId", json!("d".repeat(26))),
    ] {
        let mut bad = json!(e);
        if path == "/extra" {
            bad["extra"] = value;
        } else {
            *bad.pointer_mut(path).unwrap() = value;
        }
        invalid.push(bad);
    }
    for field in ["format", "context", "contentBytes", "nonce", "ciphertext"] {
        let mut bad = json!(e);
        bad[field] = Value::Null;
        invalid.push(bad);
    }
    let mut bad = json!(e);
    bad["context"]["unknown"] = Value::Null;
    invalid.push(bad);
    for field in ["attachmentVersion", "keyEpoch"] {
        for value in [Value::Null, json!(1.0), json!(9007199254740992u64)] {
            let mut bad = json!(e);
            bad["context"][field] = value;
            invalid.push(bad);
        }
    }
    for cipher in [
        format!(" {}", e.ciphertext),
        e.ciphertext.trim_end_matches('=').to_owned(),
    ] {
        let mut bad = json!(e);
        bad["ciphertext"] = json!(cipher);
        invalid.push(bad);
    }
    let server = Server::json(invalid.clone());
    let client = server.client();
    for _ in &invalid {
        assert!(client.get_attachment(7, &c).await.is_err());
    }
    assert!(server.finish().len() == invalid.len());
    let server = Server::new(vec![(200, "x".repeat(1_404_001), String::new())]);
    assert!(
        server.client().get_attachment(7, &c).await.unwrap_err()
            == EncryptedSessionError::ResponseTooLarge
    );
    server.finish();
    let server = Server::new(vec![(
        200,
        json!(e)
            .to_string()
            .replacen("\"format\":1", "\"format\":1,\"format\":1", 1),
        String::new(),
    )]);
    assert!(server.client().get_attachment(7, &c).await.is_err());
    server.finish();
    let mut replies = Vec::new();
    for field in [
        "stateRevision",
        "itemVersion",
        "attachmentVersion",
        "keyEpoch",
    ] {
        for value in [
            Value::Null,
            json!(1.0),
            json!(9007199254740992u64),
            json!(0),
        ] {
            let mut bad = put_reply();
            bad[field] = value;
            replies.push(bad);
        }
    }
    let mut bad = put_reply();
    bad["auth"] = json!("forbidden");
    replies.push(bad);
    let server = Server::json(replies.clone());
    let client = server.client();
    let write = item(&c);
    for _ in &replies {
        assert!(client.put_attachment(7, &write, 0, &e, &c).await.is_err());
    }
    assert!(server.finish().len() == replies.len());
    // Locally rejected arguments must not emit HTTP requests.
    let server = Server::json(vec![]);
    let client = server.client();
    assert!(client.put_attachment(7, &write, 1, &e, &c).await.is_err());
    assert!(client.get_attachment(0, &c).await.is_err());
    assert!(client
        .put_attachment(9_007_199_254_740_990, &write, 0, &e, &c)
        .await
        .is_err());
    let mut large = write.clone();
    large.envelope=PasswordBoxKey::generate().unwrap().encrypt_item(&json!({"id":c.item_id,"version":4,"vault":{"id":c.password_box_id},"notes":"x".repeat(900_000)}),&large.envelope.context).unwrap();
    let max = encrypted(&c, vec![255; 1_048_576]);
    assert!(client.put_attachment(7, &large, 0, &max, &c).await.is_err());
    assert!(server.finish().is_empty());
}

#[tokio::test]
async fn snapshot_and_stage_reject_each_wrong_revision_epoch_cursor_and_new_field() {
    let c = context(1, 1);
    let snap: SharingSnapshot = serde_json::from_value(snapshot()).unwrap();
    let page = json!({"stateRevision":7,"attachments":[{"itemId":c.item_id,"attachmentId":c.attachment_id,"attachmentVersion":1,"keyEpoch":1}],"nextCursor":null});
    // One-page fixture uses its own correct snapshot header.
    let mut snap = snap;
    snap.live_attachment_count = Some(1);
    let mut bad = Vec::new();
    for (path, value) in [
        ("/stateRevision", json!(8)),
        ("/stateRevision", Value::Null),
        (
            "/nextCursor",
            json!(format!("{}:{}", c.item_id, c.attachment_id)),
        ),
        ("/attachments/0/keyEpoch", json!(2)),
        ("/attachments/0/attachmentVersion", json!(1.0)),
        ("/attachments/0/attachmentId", json!("../a")),
        ("/attachments/0/itemId", json!("ａ".repeat(26))),
    ] {
        let mut v = page.clone();
        *v.pointer_mut(path).unwrap() = value;
        bad.push(v);
    }
    let mut v = page.clone();
    v.as_object_mut().unwrap().remove("nextCursor");
    bad.push(v);
    let mut v = page.clone();
    v["attachments"][0]["auth"] = Value::Null;
    bad.push(v);
    let mut v = page.clone();
    v["attachments"] = json!(vec![page["attachments"][0].clone(); 101]);
    bad.push(v);
    let server = Server::json(bad.clone());
    let sdk = SharingRotationClient::new(&server.client());
    for _ in &bad {
        assert!(sdk
            .snapshot_attachments(c.password_box_id.as_str(), &snap, None)
            .await
            .is_err());
    }
    assert!(server.finish().len() == bad.len());
    let next = context(2, 2);
    let r = rotation();
    let request = RotationAttachmentRequest {
        expected_version: 1,
        envelope: encrypted(&next, vec![255]),
    };
    let reply = json!({"operationId":r.operation_id,"itemId":next.item_id,"attachmentId":next.attachment_id,"attachmentVersion":2,"keyEpoch":2});
    let mut bad = Vec::new();
    for (field, value) in [
        ("operationId", json!(OWNER)),
        ("itemId", json!("d".repeat(26))),
        ("attachmentId", json!("d".repeat(26))),
        ("attachmentVersion", json!(3)),
        ("keyEpoch", json!(3)),
        ("attachmentVersion", Value::Null),
        ("auth", Value::Null),
    ] {
        let mut v = reply.clone();
        v[field] = value;
        bad.push(v);
    }
    let server = Server::json(bad.clone());
    let sdk = SharingRotationClient::new(&server.client());
    for _ in &bad {
        assert!(sdk.stage_attachment(&r, &request, &next).await.is_err());
    }
    assert!(server.finish().len() == bad.len());
    let mut committed = json!({"operationId":r.operation_id,"status":"committed","keyEpoch":2,"stateRevision":8,"ownerBundleVersion":2,"removedAccountId":r.remove_account_id,"itemCount":1,"grantCount":0});
    let mut replies = Vec::new();
    for value in [Value::Null, json!(0), json!(1.0), json!(1025)] {
        committed["attachmentCount"] = value;
        replies.push(committed.clone());
    }
    let server = Server::json(replies.clone());
    let sdk = SharingRotationClient::new(&server.client());
    for _ in &replies {
        assert!(sdk
            .commit_rotation_with_attachments(&r, 1, "synthetic-login-proof")
            .await
            .is_err());
    }
    assert!(server.finish().len() == replies.len());
}
#[tokio::test]
async fn snapshot_composite_cursor_same_revision_and_rotation_stage() {
    let c = context(1, 1);
    let e = encrypted(&c, vec![0, 255]);
    let rows:Vec<_>=(0..100).map(|n|json!({"itemId":c.item_id,"attachmentId":format!("{:026}",n),"attachmentVersion":1,"keyEpoch":1})).collect();
    let cursor = format!("{}:{:026}", c.item_id, 99);
    let page = json!({"stateRevision":7,"attachments":rows,"nextCursor":cursor});
    let last = json!({"stateRevision":7,"attachments":[{"itemId":c.item_id,"attachmentId":c.attachment_id,"attachmentVersion":1,"keyEpoch":1}],"nextCursor":null});
    let next = context(2, 2);
    let staged = encrypted(&next, vec![0]);
    let r = rotation();
    let reply = json!({"operationId":r.operation_id,"itemId":next.item_id,"attachmentId":next.attachment_id,"attachmentVersion":2,"keyEpoch":2});
    let server = Server::json(vec![snapshot(), page, last, json!(e), reply]);
    let session = server.client();
    let sdk = SharingRotationClient::new(&session);
    let snap = sdk
        .sharing_snapshot(c.password_box_id.as_str(), OWNER)
        .await
        .unwrap();
    assert!(snap.live_attachment_count == Some(101));
    let first = sdk
        .snapshot_attachments(c.password_box_id.as_str(), &snap, None)
        .await
        .unwrap();
    assert!(first.attachments.len() == 100);
    let second = sdk
        .snapshot_attachments(
            c.password_box_id.as_str(),
            &snap,
            first.next_cursor.as_deref(),
        )
        .await
        .unwrap();
    assert!(second.attachments.len() == 1);
    assert!(
        sdk.snapshot_attachment(c.password_box_id.as_str(), &snap, &c)
            .await
            .unwrap()
            == e
    );
    let request = RotationAttachmentRequest {
        expected_version: 1,
        envelope: staged,
    };
    assert!(sdk.stage_attachment(&r, &request, &next).await.is_ok());
    let calls = server.finish();
    assert!(
        calls.len() == 5
            && calls[2]
                .0
                .contains(&format!("after={}%3A{:026}", c.item_id, 99))
    );
    assert!(calls[3].0.contains(&format!(
        "sharing-snapshot/items/{}/attachments/{}?revision=7",
        c.item_id, c.attachment_id
    )));
    assert!(
        calls[4].0.starts_with(&format!(
            "PUT /api/encrypted/boxes/{}/rotations/{}/items/{}/attachments/{} ",
            c.password_box_id, r.operation_id, c.item_id, c.attachment_id
        )) && calls[4].1 == json!(request)
    );
    let server = Server::json(vec![]);
    let sdk = SharingRotationClient::new(&server.client());
    for cursor in [
        "../a:b", "a%2fb:c", "ａ:b", "a\\b:c", "a:b:c", "a:b", "a\0:b",
    ] {
        assert!(sdk
            .snapshot_attachments(c.password_box_id.as_str(), &snap, Some(cursor))
            .await
            .is_err());
    }
    assert!(server.finish().is_empty());
}
#[tokio::test]
async fn optional_attachment_fields_preserve_legacy_and_reject_null_unknown() {
    let mut old = snapshot();
    old.as_object_mut().unwrap().remove("liveAttachmentCount");
    old.as_object_mut().unwrap().remove("liveAttachmentBytes");
    let server = Server::json(vec![old, snapshot()]);
    let sdk = SharingRotationClient::new(&server.client());
    assert!(sdk
        .sharing_snapshot(&"a".repeat(26), OWNER)
        .await
        .unwrap()
        .live_attachment_count
        .is_none());
    assert!(
        sdk.sharing_snapshot(&"a".repeat(26), OWNER)
            .await
            .unwrap()
            .live_attachment_count
            == Some(101)
    );
    assert!(server.finish().len() == 2);
    let mut bad = Vec::new();
    for field in ["liveAttachmentCount", "liveAttachmentBytes"] {
        for value in [Value::Null, json!(0), json!(1.0)] {
            let mut v = snapshot();
            v[field] = value;
            bad.push(v);
        }
    }
    let mut v = snapshot();
    v["unknown"] = json!(true);
    bad.push(v);
    let server = Server::json(bad.clone());
    let sdk = SharingRotationClient::new(&server.client());
    for _ in bad {
        assert!(sdk.sharing_snapshot(&"a".repeat(26), OWNER).await.is_err());
    }
    server.finish();
    let r = rotation();
    let committed = json!({"operationId":r.operation_id,"status":"committed","keyEpoch":2,"stateRevision":8,"ownerBundleVersion":2,"removedAccountId":r.remove_account_id,"itemCount":1,"grantCount":0,"attachmentCount":101});
    let status = json!({"operationId":r.operation_id,"status":"committed","itemCount":1,"grantCount":0,"attachmentCount":101,"stagedBytes":0,"expiresAt":"2026-10-11T02:03:04.123456+00:00","result":committed});
    let server = Server::json(vec![committed.clone(), status, committed]);
    let sdk = SharingRotationClient::new(&server.client());
    assert!(sdk
        .commit_rotation_with_attachments(&r, 101, "synthetic-login-proof")
        .await
        .is_ok());
    assert!(sdk.rotation_status_with_attachments(&r, 101).await.is_ok());
    assert!(sdk
        .commit_rotation_with_attachments(&r, 100, "synthetic-login-proof")
        .await
        .is_err());
    assert!(server.finish().len() == 3);
}

#[tokio::test]
async fn pending_empty_attachment_stage_keeps_legacy_status_shape_and_final_count_is_mandatory() {
    let r = rotation();
    // Actual SQL omits attachmentCount when no attachments have been staged yet,
    // even when the independently held live snapshot contains attachments.
    let pending = json!({"operationId":r.operation_id,"status":"pending","itemCount":0,"grantCount":0,"stagedBytes":0,"expiresAt":"2026-10-11T02:03:04.123456+00:00","result":null});
    let committed = json!({"operationId":r.operation_id,"status":"committed","keyEpoch":2,"stateRevision":8,"ownerBundleVersion":2,"removedAccountId":r.remove_account_id,"itemCount":1,"grantCount":0});
    let final_status = json!({"operationId":r.operation_id,"status":"committed","itemCount":1,"grantCount":0,"stagedBytes":0,"expiresAt":"2026-10-11T02:03:04.123456+00:00","result":committed});
    let server = Server::json(vec![pending, final_status]);
    let sdk = SharingRotationClient::new(&server.client());
    let result = sdk.rotation_status_with_attachments(&r, 101).await.unwrap();
    assert!(
        result.status == RotationStatus::Pending
            && result.attachment_count.is_none()
            && result.result.is_none()
    );
    assert!(sdk.rotation_status_with_attachments(&r, 101).await.is_err());
    assert!(server.finish().len() == 2);
}
