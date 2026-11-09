//! Owner bulk export. Only validated ciphertext and the already authenticated
//! wrapped owner bundle reach disk; decrypted DTOs/files are erased in memory.
use super::*;
use passshare_connect::{EncryptedAttachment, SharingAttachmentSummary};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::Path,
};

async fn read<T, F, Fut>(mut f: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = std::result::Result<T, EncryptedSessionError>>,
{
    match f().await {
        Err(e) if e.status() == Some(429) => {
            // Read-only, exact same selector. One bounded retry per read, never writes.
            eprintln!("export read rate limited; waiting for the server window");
            tokio::time::sleep(Duration::from_secs(60)).await;
            f().await.map_err(Error::from)
        }
        result => result.map_err(Error::from),
    }
}
struct Budget {
    used: usize,
    max: usize,
}
impl Budget {
    fn add<T: Serialize>(&mut self, value: &T) -> Result<()> {
        let n = serde_json::to_vec(value).map_err(|_| INPUT)?.len();
        self.used = self.used.checked_add(n).ok_or(INPUT)?;
        if self.used > self.max {
            return Err(EncryptedSessionError::ResponseTooLarge.into());
        }
        Ok(())
    }
}
fn publish(out: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if out.file_name().is_none() {
        return Err(INPUT);
    }
    let temp = parent.join(format!(".passshare-export-{}.tmp", Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|_| Error::Invalid("cannot create export temporary file"))?;
    let write = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = write.and_then(|_| std::fs::hard_link(&temp, out));
    let cleanup = std::fs::remove_file(&temp);
    if cleanup.is_err() {
        return Err(Error::Invalid(
            "export temporary file cleanup failed; inspect the selected output directory",
        ));
    }
    result.map_err(|_|Error::Invalid("cannot publish complete export; choose a new path on a filesystem supporting atomic hard links"))
}
pub(super) async fn run(
    session: &Session,
    contract: &str,
    out: &Path,
    max_bytes: usize,
) -> Result<()> {
    if max_bytes == 0 || max_bytes as u128 > MAX_SAFE as u128 || out.as_os_str().is_empty() {
        return Err(INPUT);
    }
    match std::fs::symlink_metadata(out) {
        Ok(_) => {
            return Err(Error::Invalid(
                "export never replaces an existing output file or link",
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::Invalid("cannot inspect export output path")),
    }
    let snapshot = read(|| {
        session
            .sdk
            .contract_export_snapshot(contract, session.box_id(), session.owner.key_epoch)
    })
    .await?;
    if snapshot.revision() != session.snapshot.state_revision {
        return Err(CONTEXT);
    }
    let metadata = session.metadata().await?;
    let expected: HashMap<_, _> = metadata
        .iter()
        .map(|m| (m.item_id.to_string(), m))
        .collect();
    let expected_files = session.snapshot.live_attachment_count.ok_or(CONTEXT)?;
    if (metadata.len() as u128 + expected_files as u128) * 64 > max_bytes as u128 {
        return Err(EncryptedSessionError::ResponseTooLarge.into());
    }
    let mut file_meta: HashMap<String, Vec<SharingAttachmentSummary>> = HashMap::new();
    let mut after: Option<String> = None;
    let mut file_count = 0u64;
    loop {
        let page = session
            .sharing
            .snapshot_attachments(session.box_id(), &session.snapshot, after.as_deref())
            .await?;
        for file in page.attachments {
            file_count = file_count.checked_add(1).ok_or(CONTEXT)?;
            if file_count > expected_files {
                return Err(CONTEXT);
            }
            file_meta
                .entry(file.item_id.to_string())
                .or_default()
                .push(file);
        }
        match page.next_cursor {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    if file_count != expected_files {
        return Err(CONTEXT);
    }
    let mut budget = Budget {
        used: 0,
        max: max_bytes,
    };
    budget.add(&session.owner_record.bundle)?;
    let mut items: Vec<EncryptedItem> = Vec::new();
    let mut files: Vec<EncryptedAttachment> = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = read(|| {
            session
                .sdk
                .contract_export_items(&snapshot, cursor.as_deref())
        })
        .await?;
        for envelope in page.envelopes {
            let item_id = envelope.context.item_id.to_string();
            let expected_item = expected.get(&item_id).ok_or(CONTEXT)?;
            let context = ItemContext {
                password_box_id: session.owner.password_box_id.clone(),
                item_id: expected_item.item_id.clone(),
                item_version: expected_item.item_version,
                key_epoch: session.owner.key_epoch,
            };
            if envelope.context != context || !seen.insert(item_id.clone()) {
                return Err(CONTEXT);
            }
            let plain = Plaintext(
                session
                    .key
                    .decrypt_item(&envelope, &context)
                    .map_err(|_| CRYPTO)?,
            );
            if plain.0.get("id").and_then(Value::as_str) != Some(item_id.as_str())
                || plain.0.get("version").and_then(Value::as_u64) != Some(context.item_version)
            {
                return Err(CRYPTO);
            }
            let references = match plain.0.get("attachments") {
                None | Some(Value::Null) => 0,
                Some(Value::Array(a)) => a.len(),
                _ => return Err(CRYPTO),
            };
            let item_files = file_meta.remove(&item_id).unwrap_or_default();
            if references != item_files.len() {
                return Err(CRYPTO);
            }
            for file in item_files {
                let context = AttachmentContext {
                    password_box_id: session.owner.password_box_id.clone(),
                    item_id: context.item_id.clone(),
                    attachment_id: file.attachment_id,
                    attachment_version: file.attachment_version,
                    key_epoch: session.owner.key_epoch,
                };
                authenticated_reference(&plain.0, &context)?;
                let encrypted =
                    read(|| session.sdk.contract_export_attachment(&snapshot, &context)).await?;
                let authenticated = session
                    .key
                    .decrypt_attachment(&encrypted, &context)
                    .map_err(|_| CRYPTO)?;
                if authenticated.content().len() as u64 != encrypted.content_bytes {
                    return Err(CRYPTO);
                }
                budget.add(&encrypted)?;
                files.push(encrypted);
            }
            budget.add(&envelope)?;
            items.push(envelope);
        }
        match page.next_cursor {
            Some(next) => cursor = Some(next.to_string()),
            None => break,
        }
    }
    if seen.len() != expected.len() || !file_meta.is_empty() || files.len() as u64 != expected_files
    {
        return Err(CONTEXT);
    }
    read(|| session.sdk.verify_contract_export_snapshot(&snapshot)).await?;
    let item_count = items.len();
    let attachment_count = files.len();
    let archive = json!({"format":"passshare-ciphertext-archive-v1","contractId":contract,"boxId":session.owner.password_box_id,
  "ownerContext":session.owner,"ownerBundleVersion":session.owner_record.bundle_version,"ownerBundle":session.owner_record.bundle,
  "snapshot":snapshot,"items":items,"attachments":files});
    let bytes = serde_json::to_vec(&archive).map_err(|_| INPUT)?;
    if bytes.len() > max_bytes {
        return Err(EncryptedSessionError::ResponseTooLarge.into());
    }
    publish(out, &bytes)?;
    println!(
        "{}",
        json!({"exported":true,"items":item_count,"attachments":attachment_count,"ciphertextOnly":true})
    );
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publish_is_complete_and_never_replaces_existing_paths() {
        let dir = std::env::temp_dir().join(format!("passshare-export-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("archive.json");
        publish(&path, b"ciphertext-fixture").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"ciphertext-fixture");
        assert!(publish(&path, b"replacement").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"ciphertext-fixture");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
