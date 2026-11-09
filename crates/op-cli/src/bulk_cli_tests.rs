//! Bulk executable fixture, using the existing owner's authenticated context.
use super::*;
use passshare_connect::{AttachmentContext, EncryptedAttachment};
const CONTRACT: &str = "00000000-0000-4000-8000-000000000001";
pub(super) fn export_route(method: &str, path: &str, s: &mut State) -> Option<(u16, Value)> {
    let items = s.export_items.as_ref()?;
    if method != "GET" {
        return None;
    }
    let encrypted = format!("/api/encrypted/boxes/{BOX}");
    if path == format!("{encrypted}/sharing-snapshot") {
        return Some((
            200,
            json!({"stateRevision":1,"keyEpoch":s.epoch,"ownerAccountId":OWNER,"ownerBundleVersion":s.owner_version,"memberCount":1,"liveItemCount":items.len(),"grantCount":0,"liveAttachmentCount":s.export_files.len(),"liveAttachmentBytes":s.export_files.iter().map(|a|serde_json::to_vec(a).unwrap().len()).sum::<usize>()}),
        ));
    }
    if path == format!("{encrypted}/sharing-snapshot/items?revision=1") {
        let rows:Vec<_>=items.iter().map(|a|json!({"itemId":a.context.item_id,"itemVersion":a.context.item_version,"keyEpoch":a.context.key_epoch})).collect();
        return Some((
            200,
            json!({"stateRevision":1,"items":rows,"nextCursor":null}),
        ));
    }
    if path == format!("{encrypted}/sharing-snapshot/attachments?revision=1") {
        let rows:Vec<_>=s.export_files.iter().map(|a|json!({"itemId":a.context.item_id,"attachmentId":a.context.attachment_id,"attachmentVersion":a.context.attachment_version,"keyEpoch":a.context.key_epoch})).collect();
        return Some((
            200,
            json!({"stateRevision":1,"attachments":rows,"nextCursor":null}),
        ));
    }
    let root = format!("/api/commercial-contracts/{CONTRACT}/export/boxes/{BOX}/");
    let tail = path.strip_prefix(&root)?;
    s.export_reads += 1;
    if s.export_failure != 0 && s.export_reads > s.export_fail_after {
        return Some(failure(s.export_failure, s));
    }
    let wrap = |data| json!({"format":"passshare-encrypted-export-v1","boxId":BOX,"keyEpoch":s.epoch,"snapshotRevision":1,"ciphertextOnly":true,"restoresIdentityMembershipOrKeys":false,"data":data});
    if tail == "state" {
        return Some((200, wrap(json!({"stateRevision":1,"keyEpoch":s.epoch}))));
    }
    let (route, query) = tail.split_once('?')?;
    if !query.starts_with("epoch=1&revision=1") {
        return Some(failure(409, s));
    }
    if route == "items" {
        let after = query.split('&').find_map(|a| a.strip_prefix("after="));
        let left: Vec<_> = items
            .iter()
            .filter(|i| after.is_none_or(|a| i.context.item_id.as_str() > a))
            .collect();
        let rows: Vec<_> = left.iter().take(10).copied().collect();
        let next = if left.len() > 10 {
            rows.last().map(|i| i.context.item_id.as_str())
        } else {
            None
        };
        return Some((
            200,
            wrap(json!({"envelopes":rows,"nextCursor":next,"attachmentsIncluded":false})),
        ));
    }
    let parts: Vec<_> = route.split('/').collect();
    if parts.len() == 4 && parts[0] == "items" && parts[2] == "attachments" {
        return Some(
            match s.export_files.iter().find(|a| {
                a.context.item_id.as_str() == parts[1]
                    && a.context.attachment_id.as_str() == parts[3]
            }) {
                Some(a) => (200, wrap(json!(a))),
                None => failure(404, s),
            },
        );
    }
    Some(failure(404, s))
}
fn prepared() -> (Server, Vec<Value>, Vec<u8>) {
    let server = Server::new();
    let bytes = vec![0, 1, 254, 255, 7, 0];
    let mut plain = Vec::new();
    let mut envelopes = Vec::new();
    let item_id = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
    let attachment_id = "zzzzzzzzzzzzzzzzzzzzzzzzzz";
    let context:AttachmentContext=serde_json::from_value(json!({"passwordBoxId":BOX,"itemId":item_id,"attachmentId":attachment_id,"attachmentVersion":1,"keyEpoch":1})).unwrap();
    let file = server
        .key
        .encrypt_attachment(
            &passshare_core::cloud_crypto::AttachmentPlaintext::new(
                "../opaque/filename.bin".into(),
                bytes.clone(),
            )
            .unwrap(),
            &context,
        )
        .unwrap();
    for n in 0..12 {
        let id = char::from(b'b' + n).to_string().repeat(26);
        let dto = json!({"id":id,"version":1,"vault":{"id":BOX},"title":format!("synthetic-{n}"),"fields":[{"value":FIELD}],"retained":{"unknown":[n,{"nested":true}]},"attachments":if n==0{json!([{"attachmentId":attachment_id,"attachmentVersion":1,"keyEpoch":1}])}else{json!([])}});
        let c = serde_json::from_value(
            json!({"passwordBoxId":BOX,"itemId":id,"itemVersion":1,"keyEpoch":1}),
        )
        .unwrap();
        envelopes.push(server.key.encrypt_item(&dto, &c).unwrap());
        plain.push(dto);
    }
    {
        let mut state = server.state.lock().unwrap();
        state.export_items = Some(envelopes);
        state.export_files = vec![file];
    }
    (server, plain, bytes)
}
fn directory() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("passshare-bulk-cli-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    dir
}
#[test]
fn executable_bulk_export_recovers_all_items_and_attachment_offline_without_replacing_output() {
    let (server, plain, file_bytes) = prepared();
    let dir = directory();
    let path = dir.join("archive.json");
    let args = [
        "export",
        "--contract",
        CONTRACT,
        "--vault",
        BOX,
        "--out",
        path.to_str().unwrap(),
    ];
    let result = server.run(&args, json!({}));
    assert!(result.status.success());
    let summary: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        summary,
        json!({"exported":true,"items":12,"attachments":1,"ciphertextOnly":true})
    );
    let saved = std::fs::read(&path).unwrap();
    let raw = String::from_utf8(saved.clone()).unwrap();
    assert!(!raw.contains(FIELD));
    assert!(!raw.contains(TOKEN));
    assert!(!raw.contains(server.password.as_str()));
    let password = server.password.clone();
    drop(server); // Recovery must not require the service.
    let archive: Value = serde_json::from_slice(&saved).unwrap();
    assert_eq!(archive["format"], "passshare-ciphertext-archive-v1");
    assert_eq!(archive["items"].as_array().unwrap().len(), 12);
    assert_eq!(archive["attachments"].as_array().unwrap().len(), 1);
    let owner: OwnerKeyContext =
        serde_json::from_value(json!({"passwordBoxId":BOX,"ownerAccountId":OWNER,"keyEpoch":1}))
            .unwrap();
    assert_eq!(archive["ownerContext"], json!(owner));
    let bundle: OwnerKeyBundle = serde_json::from_value(archive["ownerBundle"].clone()).unwrap();
    let salt: [u8; 16] = STANDARD.decode(bundle.salt).unwrap().try_into().unwrap();
    let root = crypto::derive_master_key(&password, &salt).unwrap();
    let recovered = PasswordBoxKey::unwrap_for_owner(&bundle.wrapped, &root, &owner).unwrap();
    for (encrypted, expected) in archive["items"].as_array().unwrap().iter().zip(&plain) {
        let item: EncryptedItem = serde_json::from_value(encrypted.clone()).unwrap();
        let context = serde_json::from_value(
            json!({"passwordBoxId":BOX,"itemId":expected["id"],"itemVersion":1,"keyEpoch":1}),
        )
        .unwrap();
        assert_eq!(recovered.decrypt_item(&item, &context).unwrap(), *expected);
    }
    let file: EncryptedAttachment =
        serde_json::from_value(archive["attachments"][0].clone()).unwrap();
    let expected_file=serde_json::from_value(json!({"passwordBoxId":BOX,"itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","attachmentId":"zzzzzzzzzzzzzzzzzzzzzzzzzz","attachmentVersion":1,"keyEpoch":1})).unwrap();
    let actual = recovered.decrypt_attachment(&file, &expected_file).unwrap();
    assert_eq!(actual.content(), file_bytes);
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    let second = prepared().0;
    let again = second.run(&args, json!({}));
    assert!(!again.status.success());
    assert_eq!(std::fs::read(&path).unwrap(), saved);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
#[test]
fn executable_bulk_failures_leave_no_partial_file_or_plaintext() {
    // The 401 case expires only at the final state read, after every payload
    // has arrived. Even then there must be no published or partial archive.
    for (status, fail_after) in [(401, 4), (403, 2), (409, 3)] {
        let (server, _, _) = prepared();
        {
            let mut s = server.state.lock().unwrap();
            s.export_failure = status;
            s.export_fail_after = fail_after;
        }
        let dir = directory();
        let path = dir.join("archive.json");
        let result = server.run(
            &[
                "export",
                "--contract",
                CONTRACT,
                "--vault",
                BOX,
                "--out",
                path.to_str().unwrap(),
            ],
            json!({}),
        );
        assert!(!result.status.success());
        assert!(server.state.lock().unwrap().export_reads > fail_after);
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir(dir).unwrap();
    }
    let (server, _, _) = prepared();
    let dir = directory();
    let path = dir.join("archive.json");
    let result = server.run(
        &[
            "export",
            "--contract",
            CONTRACT,
            "--vault",
            BOX,
            "--out",
            path.to_str().unwrap(),
            "--max-bytes",
            "1",
        ],
        json!({}),
    );
    assert!(!result.status.success());
    assert!(!path.exists());
    std::fs::remove_dir(dir).unwrap();
}

#[test]
fn corrupted_attachment_is_never_published_as_a_complete_archive() {
    let (server, _, _) = prepared();
    {
        let mut state = server.state.lock().unwrap();
        let ciphertext = &mut state.export_files[0].ciphertext;
        let first = if ciphertext.starts_with('A') {
            "B"
        } else {
            "A"
        };
        ciphertext.replace_range(0..1, first);
    }
    let dir = directory();
    let path = dir.join("archive.json");
    let result = server.run(
        &[
            "export",
            "--contract",
            CONTRACT,
            "--vault",
            BOX,
            "--out",
            path.to_str().unwrap(),
        ],
        json!({}),
    );
    assert!(!result.status.success());
    assert!(!path.exists());
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    assert!(!String::from_utf8_lossy(&result.stderr).contains(FIELD));
    std::fs::remove_dir(dir).unwrap();
}
