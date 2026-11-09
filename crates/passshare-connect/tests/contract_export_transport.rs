//! Loopback HTTP + real Core ciphertext; no provider account or paid service.
use passshare_connect::*;
use passshare_core::cloud_crypto::PasswordBoxKey;
use passshare_core::ConnectId;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
const CONTRACT: &str = "00000000-0000-4000-8000-000000000001";
const BOX: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const A: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const B: &str = "cccccccccccccccccccccccccc";
struct Server {
    url: String,
    stop: Arc<AtomicBool>,
    job: Option<std::thread::JoinHandle<Vec<String>>>,
}
impl Server {
    fn new(replies: Vec<(u16, Value, String)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let job = std::thread::spawn(move || {
            let mut requests = Vec::new();
            while !flag.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut s, _)) => {
                        s.set_nonblocking(false).unwrap();
                        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                        let mut buf = Vec::new();
                        while !buf.ends_with(b"\r\n\r\n") {
                            let mut one = [0];
                            s.read_exact(&mut one).unwrap();
                            buf.push(one[0]);
                            assert!(buf.len() < 32768);
                        }
                        let (status, v, extra) = replies.get(requests.len()).cloned().unwrap_or((
                            503,
                            json!({}),
                            String::new(),
                        ));
                        requests.push(String::from_utf8(buf).unwrap());
                        let body = v.to_string();
                        let wire=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",body.len());
                        let _ = s.write_all(wire.as_bytes());
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
    fn json(v: Vec<Value>) -> Self {
        Self::new(v.into_iter().map(|v| (200, v, String::new())).collect())
    }
    fn client(&self) -> EncryptedSessionClient {
        EncryptedSessionClient::new(&(self.url.clone() + "/prefix"), "synthetic-export-session")
            .unwrap()
    }
    fn finish(mut self) -> Vec<String> {
        self.stop.store(true, Ordering::Release);
        self.job.take().unwrap().join().unwrap()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(j) = self.job.take() {
            let _ = j.join();
        }
    }
}
fn reply(data: Value) -> Value {
    json!({"format":"passshare-encrypted-export-v1","boxId":BOX,"keyEpoch":1,"snapshotRevision":7,"ciphertextOnly":true,"restoresIdentityMembershipOrKeys":false,"data":data})
}
fn state() -> Value {
    reply(json!({"keyEpoch":1,"stateRevision":7}))
}
fn item(key: &PasswordBoxKey, id: &str, text: &str) -> EncryptedItem {
    key.encrypt_item(
        &json!({"id":id,"version":1,"vault":{"id":BOX},"title":text,"attachments":[]}),
        &ItemContext {
            password_box_id: BOX.parse().unwrap(),
            item_id: id.parse().unwrap(),
            item_version: 1,
            key_epoch: 1,
        },
    )
    .unwrap()
}
#[tokio::test]
async fn exact_ciphertext_pages_and_final_snapshot_keep_scope_and_prefix() {
    let key = PasswordBoxKey::generate().unwrap();
    let a = item(&key, A, "synthetic-a");
    let b = item(&key, B, "synthetic-b");
    let mut initial = state();
    initial["receiptId"] = json!("00000000-0000-4000-8000-000000000002");
    let server = Server::json(vec![
        initial,
        reply(json!({"envelopes":[a],"nextCursor":A,"attachmentsIncluded":false})),
        reply(json!({"envelopes":[b],"nextCursor":null,"attachmentsIncluded":false})),
        state(),
    ]);
    let sdk = server.client();
    let snap = sdk
        .contract_export_snapshot(CONTRACT, BOX, 1)
        .await
        .unwrap();
    let first = sdk.contract_export_items(&snap, None).await.unwrap();
    assert_eq!(first.envelopes[0], a);
    let second = sdk
        .contract_export_items(&snap, first.next_cursor.as_ref().map(ConnectId::as_str))
        .await
        .unwrap();
    assert_eq!(second.envelopes[0], b);
    assert!(second.next_cursor.is_none());
    assert_eq!(
        key.decrypt_item(&first.envelopes[0], &a.context).unwrap()["title"],
        "synthetic-a"
    );
    sdk.verify_contract_export_snapshot(&snap).await.unwrap();
    let requests = server.finish();
    assert_eq!(requests.len(), 4);
    assert!(requests[0].starts_with(&format!(
        "GET /prefix/api/commercial-contracts/{CONTRACT}/export/boxes/{BOX}/state "
    )));
    assert!(requests[2].contains(&format!("after={A}")));
    assert!(!format!("{sdk:?}").contains("synthetic-export-session"));
}
#[tokio::test]
async fn forged_scope_stalled_cursor_and_revision_change_are_rejected() {
    let key = PasswordBoxKey::generate().unwrap();
    let a = item(&key, A, "synthetic");
    for mut invalid in [
        reply(json!({"envelopes":[a],"nextCursor":BOX,"attachmentsIncluded":false})),
        reply(json!({"envelopes":[a],"nextCursor":null,"attachmentsIncluded":true})),
        reply(json!({"envelopes":[a],"nextCursor":null,"attachmentsIncluded":false})),
    ] {
        if invalid["data"]["attachmentsIncluded"] == false
            && invalid["data"]["nextCursor"].is_null()
        {
            invalid["snapshotRevision"] = json!(8);
        }
        let server = Server::json(vec![state(), invalid]);
        let sdk = server.client();
        let snap = sdk
            .contract_export_snapshot(CONTRACT, BOX, 1)
            .await
            .unwrap();
        assert!(sdk.contract_export_items(&snap, None).await.is_err());
    }
    let mut wrong = state();
    wrong["boxId"] = json!(A);
    let server = Server::json(vec![wrong]);
    assert!(server
        .client()
        .contract_export_snapshot(CONTRACT, BOX, 1)
        .await
        .is_err());
}
#[tokio::test]
async fn credentials_do_not_follow_redirects_or_reveal_error_bodies() {
    for status in [302, 401, 403, 409, 429] {
        let server = Server::new(vec![(
            status,
            json!({"error":"PS024","message":"synthetic-private-body"}),
            "Location: /trap\r\n".into(),
        )]);
        let sdk = server.client();
        let e = sdk
            .contract_export_snapshot(CONTRACT, BOX, 1)
            .await
            .unwrap_err();
        assert_eq!(e.status(), Some(status));
        assert!(!e.to_string().contains("synthetic-private-body"));
        assert_eq!(server.finish().len(), 1);
    }
}
#[tokio::test]
async fn invalid_caller_context_is_rejected_without_a_request() {
    let server = Server::json(vec![]);
    let sdk = server.client();
    assert!(sdk
        .contract_export_snapshot("../contract", BOX, 1)
        .await
        .is_err());
    assert!(sdk
        .contract_export_snapshot(CONTRACT, BOX, 0)
        .await
        .is_err());
    assert_eq!(server.finish().len(), 0);
}
#[tokio::test]
async fn page_limit_supports_multiple_legitimate_large_items() {
    let key = PasswordBoxKey::generate().unwrap();
    let text = "x".repeat(700 * 1024);
    let a = item(&key, A, &text);
    let b = item(&key, B, &text);
    let server = Server::json(vec![
        state(),
        reply(json!({"envelopes":[a,b],"nextCursor":null,"attachmentsIncluded":false})),
    ]);
    let sdk = server.client();
    let snap = sdk
        .contract_export_snapshot(CONTRACT, BOX, 1)
        .await
        .unwrap();
    assert_eq!(
        sdk.contract_export_items(&snap, None)
            .await
            .unwrap()
            .envelopes
            .len(),
        2
    );
}
