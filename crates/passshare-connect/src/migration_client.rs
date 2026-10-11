//! Finite migration transport on the existing session bearer connection.
//! Public shape checks are not AEAD authentication. Read back and decrypt with
//! Core and independent expected contexts before explicitly committing.
use crate::{
    EncryptedSessionClient, EncryptedSessionError as Error, EncryptedSessionResult as Result,
    OwnerKeyBundle,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use passshare_core::{
    cloud_crypto::{
        migration::{MigrationItemPlaintext, PreparedMigration},
        AttachmentContext, AttachmentPlaintext, EncryptedAttachment, EncryptedItem, ItemContext,
        OwnerKeyContext,
    },
    ConnectId,
};
use reqwest::{Method, Url};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

mod secret_json;
use secret_json::{SecretBytes, SecretJson};
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_HTTP: usize = 2 * 1024 * 1024;

fn id(id: &str) -> Result<()> {
    ConnectId::validate(id).map_err(|_| Error::InvalidArgument("invalid migration identifier"))
}
fn positive(n: u64) -> Result<()> {
    if (1..=MAX_SAFE).contains(&n) {
        Ok(())
    } else {
        Err(Error::InvalidArgument("invalid migration revision"))
    }
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s != "00000000-0000-0000-0000-000000000000"
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    // The recursive parser rejects duplicates even inside Core/public structs.
    let value = SecretJson::parse(bytes)?;
    T::deserialize(&value.0).map_err(|_| Error::InvalidResponse("malformed migration response"))
}
fn count(n: u64) -> bool {
    n <= MAX_SAFE
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceSnapshot {
    pub source_password_box_id: ConnectId,
    pub source_revision: u64,
    pub item_count: u64,
    pub attachment_count: u64,
    pub key_epoch: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationSourceSummary {
    pub id: ConnectId,
    pub version: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourcePage {
    pub items: Vec<MigrationSourceSummary>,
    pub source_revision: u64,
    #[serde(deserialize_with = "nullable")]
    pub after: Option<ConnectId>,
}

/// No Debug/Clone/serde; names and actual bytes erase through Core on drop.
/// Missing legacy content is distinct from an available zero-byte file.
pub enum MigrationSourceFile {
    Available(AttachmentPlaintext),
    Missing { metadata: MigrationItemPlaintext },
}
impl MigrationSourceFile {
    pub fn available(&self) -> Option<&AttachmentPlaintext> {
        match self {
            Self::Available(file) => Some(file),
            Self::Missing { .. } => None,
        }
    }
    pub fn missing_metadata(&self) -> Option<&Value> {
        match self {
            Self::Missing { metadata } => Some(metadata.json()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MigrationState {
    Pending,
    Committed,
    Aborted,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHeader {
    pub format: u32,
    pub operation_id: String,
    pub owner_context: OwnerKeyContext,
    pub source_password_box_id: ConnectId,
    pub source_revision: u64,
    pub item_count: u64,
    pub attachment_count: u64,
    pub owner_bundle: OwnerKeyBundle,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationStatus {
    pub status: MigrationState,
    pub expired: bool,
    pub header: MigrationHeader,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationFileBinding {
    pub source: AttachmentContext,
    pub target: AttachmentContext,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationBinding {
    pub source: ItemContext,
    pub target: ItemContext,
    pub attachments: Vec<MigrationFileBinding>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MigrationStagedItem {
    pub binding: MigrationBinding,
    pub envelope: EncryptedItem,
}

struct FrozenItem {
    dto: MigrationStagedItem,
    bytes: Vec<u8>,
    files: Vec<(EncryptedAttachment, Vec<u8>)>,
}
/// Constructed only from Core's immutable preparation. No key/password/plaintext
/// input and no re-encryption. Every request body is serialized once and reused.
pub struct MigrationTransportPlan {
    header: MigrationHeader,
    header_bytes: Vec<u8>,
    items: Vec<FrozenItem>,
    core_replay: Vec<u8>,
}
impl MigrationTransportPlan {
    pub fn new(prepared: &PreparedMigration, owner_bundle: OwnerKeyBundle) -> Result<Self> {
        owner_bundle.validate()?;
        let mut wire: Value = serde_json::from_slice(prepared.replay_bytes())
            .map_err(|_| Error::InvalidArgument("invalid Core migration plan"))?;
        wire.as_object_mut()
            .ok_or(Error::InvalidArgument("invalid Core migration plan"))?
            .remove("items");
        wire["itemCount"] = json!(prepared.items().len());
        let attachments: usize = prepared.items().iter().map(|i| i.attachments().len()).sum();
        wire["attachmentCount"] = json!(attachments);
        wire["ownerBundle"] = json!(owner_bundle);
        let header: MigrationHeader = serde_json::from_value(wire)
            .map_err(|_| Error::InvalidArgument("invalid Core migration header"))?;
        if header.format != 1
            || !uuid(&header.operation_id)
            || header.owner_context != header.owner_bundle.wrapped.context
            || header.owner_context.password_box_id != header.source_password_box_id
            || header.owner_context.key_epoch != 1
            || positive(header.source_revision).is_err()
            || !count(header.item_count)
            || header.attachment_count > 1024
        {
            return Err(Error::InvalidArgument("unsupported migration header"));
        }
        let mut items = Vec::new();
        for item in prepared.items() {
            let binding: MigrationBinding = serde_json::from_value(json!(item.binding()))
                .map_err(|_| Error::InvalidArgument("invalid Core migration binding"))?;
            let dto = MigrationStagedItem {
                binding,
                envelope: item.envelope().clone(),
            };
            let bytes = encode(&dto)?;
            let mut files = Vec::new();
            for envelope in item.attachments() {
                files.push((envelope.clone(), encode(&json!({"envelope":envelope}))?));
            }
            items.push(FrozenItem { dto, bytes, files });
        }
        let header_bytes = encode(&header)?;
        Ok(Self {
            header,
            header_bytes,
            items,
            core_replay: prepared.replay_bytes().to_vec(),
        })
    }
    pub fn header(&self) -> &MigrationHeader {
        &self.header
    }
    pub fn core_replay_bytes(&self) -> &[u8] {
        &self.core_replay
    }
    pub fn header_request_bytes(&self) -> &[u8] {
        &self.header_bytes
    }
    pub fn item_request_bytes(&self, index: usize) -> Result<&[u8]> {
        Ok(&self.item(index)?.bytes)
    }
    pub fn file_request_bytes(&self, item: usize, file: usize) -> Result<&[u8]> {
        Ok(&self.file(item, file)?.1)
    }
    fn item(&self, index: usize) -> Result<&FrozenItem> {
        self.items
            .get(index)
            .ok_or(Error::InvalidArgument("migration item index out of range"))
    }
    fn file(&self, item: usize, file: usize) -> Result<&(EncryptedAttachment, Vec<u8>)> {
        self.item(item)?
            .files
            .get(file)
            .ok_or(Error::InvalidArgument("migration file index out of range"))
    }
}
fn encode<T: Serialize>(v: &T) -> Result<Vec<u8>> {
    let bytes =
        serde_json::to_vec(v).map_err(|_| Error::InvalidArgument("invalid migration request"))?;
    if bytes.len() > MAX_HTTP {
        return Err(Error::InvalidArgument(
            "migration request exceeds HTTP limit",
        ));
    }
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StateReply {
    status: MigrationState,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitReply {
    status: MigrationState,
    operation_id: String,
}

impl EncryptedSessionClient {
    async fn migration_send(
        &self,
        method: Method,
        url: Url,
        body: Option<&[u8]>,
    ) -> Result<SecretBytes> {
        let mut request = self.authenticated_request(method, url);
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(body.to_vec());
        }
        // No SDK retry, including commit and failed reads. Frozen bytes are reused
        // only when the caller explicitly decides after authenticated status.
        let mut response = request
            .send()
            .await
            .map_err(|_| Error::Transport("migration request failed"))?;
        let status = response.status().as_u16();
        let limit = if status == 200 { MAX_HTTP } else { 16 * 1024 };
        // Reserve the bounded body once: growing a plaintext Vec could otherwise
        // free earlier allocations before our drop erasure can reach them.
        let mut bytes = SecretBytes(Vec::with_capacity(limit));
        let read = async {
            if response.content_length().is_some_and(|n| n > limit as u64) {
                return Err(Error::ResponseTooLarge);
            }
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| Error::Transport("migration response failed"))?
            {
                if bytes.0.len().saturating_add(chunk.len()) > limit {
                    return Err(Error::ResponseTooLarge);
                }
                bytes.0.extend_from_slice(&chunk);
            }
            Ok(())
        }
        .await;
        if status != 200 {
            let code = if read.is_ok() {
                SecretJson::parse(&bytes.0).ok().and_then(|v| {
                    v.0.get("error")
                        .and_then(Value::as_str)
                        .filter(|s| {
                            s.len() == 5
                                && s.starts_with("PS")
                                && s[2..].bytes().all(|b| b.is_ascii_digit())
                        })
                        .map(str::to_owned)
                })
            } else {
                None
            };
            return Err(Error::Api { status, code });
        }
        read?;
        Ok(bytes)
    }
    fn source_url(&self, box_id: &str, suffix: &[&str], revision: Option<u64>) -> Result<Url> {
        id(box_id)?;
        let mut segments = vec!["boxes", box_id, "migration-source"];
        segments.extend_from_slice(suffix);
        let mut url = self.endpoint(&segments)?;
        if let Some(n) = revision {
            positive(n)?;
            url.query_pairs_mut()
                .append_pair("revision", &n.to_string());
        }
        Ok(url)
    }
    fn migration_url(&self, plan: &MigrationTransportPlan, suffix: &[&str]) -> Result<Url> {
        let mut segments = vec![
            "boxes",
            plan.header.source_password_box_id.as_str(),
            "migrations",
            &plan.header.operation_id,
        ];
        segments.extend_from_slice(suffix);
        self.endpoint(&segments)
    }
    pub async fn migration_source(&self, box_id: &str) -> Result<MigrationSourceSnapshot> {
        let bytes = self
            .migration_send(Method::GET, self.source_url(box_id, &[], None)?, None)
            .await?;
        let snapshot: MigrationSourceSnapshot = decode(&bytes.0)?;
        if snapshot.source_password_box_id.as_str() != box_id
            || positive(snapshot.source_revision).is_err()
            || !count(snapshot.item_count)
            || snapshot.attachment_count > 1024
            || snapshot.key_epoch != 1
        {
            return Err(Error::InvalidResponse("invalid migration source snapshot"));
        }
        Ok(snapshot)
    }
    pub async fn migration_source_items(
        &self,
        box_id: &str,
        revision: u64,
        after: Option<&str>,
    ) -> Result<MigrationSourcePage> {
        let mut url = self.source_url(box_id, &["items"], Some(revision))?;
        if let Some(cursor) = after {
            id(cursor)?;
            url.query_pairs_mut().append_pair("after", cursor);
        }
        let bytes = self.migration_send(Method::GET, url, None).await?;
        let page: MigrationSourcePage = decode(&bytes.0)?;
        if page.source_revision != revision || page.items.len() > 100 {
            return Err(Error::InvalidResponse("migration page mismatch"));
        }
        let mut previous = after;
        for item in &page.items {
            if id(item.id.as_str()).is_err()
                || positive(item.version).is_err()
                || previous.is_some_and(|p| item.id.as_str() <= p)
            {
                return Err(Error::InvalidResponse("invalid migration source entry"));
            }
            previous = Some(item.id.as_str());
        }
        if (page.items.len() == 100 && page.after.as_ref().map(|c| c.as_str()) != previous)
            || (page.items.len() != 100 && page.after.is_some())
        {
            return Err(Error::InvalidResponse("invalid migration cursor"));
        }
        Ok(page)
    }
    /// Expected routing/epoch is independent caller state, not a fetched header.
    /// Unknown JSON fields are retained. No lossy domain::Item conversion.
    pub async fn migration_source_item(
        &self,
        revision: u64,
        expected: &ItemContext,
    ) -> Result<MigrationItemPlaintext> {
        id(expected.password_box_id.as_str())?;
        id(expected.item_id.as_str())?;
        positive(expected.item_version)?;
        positive(expected.key_epoch)?;
        let url = self.source_url(
            expected.password_box_id.as_str(),
            &["items", expected.item_id.as_str()],
            Some(revision),
        )?;
        let bytes = self.migration_send(Method::GET, url, None).await?;
        let value = SecretJson::parse(&bytes.0)?;
        if value.0.get("id").and_then(Value::as_str) != Some(expected.item_id.as_str())
            || value.0.pointer("/vault/id").and_then(Value::as_str)
                != Some(expected.password_box_id.as_str())
            || value.0.get("version").and_then(Value::as_u64) != Some(expected.item_version)
        {
            return Err(Error::ContextMismatch);
        }
        validate_source_references(&value.0, expected)?;
        MigrationItemPlaintext::new(value.take())
            .map_err(|_| Error::InvalidResponse("invalid full migration source JSON"))
    }
    pub async fn migration_source_file(
        &self,
        revision: u64,
        expected: &AttachmentContext,
    ) -> Result<MigrationSourceFile> {
        expected
            .validate_public()
            .map_err(|_| Error::InvalidArgument("invalid migration source file context"))?;
        let url = self.source_url(
            expected.password_box_id.as_str(),
            &[
                "items",
                expected.item_id.as_str(),
                "files",
                expected.attachment_id.as_str(),
            ],
            Some(revision),
        )?;
        let bytes = self.migration_send(Method::GET, url, None).await?;
        source_file(&bytes.0, expected)
    }
    async fn migration_write(
        &self,
        plan: &MigrationTransportPlan,
        suffix: &[&str],
        bytes: &[u8],
    ) -> Result<MigrationState> {
        let bytes = self
            .migration_send(Method::PUT, self.migration_url(plan, suffix)?, Some(bytes))
            .await?;
        let reply: StateReply = decode(&bytes.0)?;
        if reply.status == MigrationState::Aborted {
            return Err(Error::InvalidResponse("unexpected migration write state"));
        }
        Ok(reply.status)
    }
    pub async fn stage_migration_header(
        &self,
        plan: &MigrationTransportPlan,
    ) -> Result<MigrationState> {
        self.migration_write(plan, &[], &plan.header_bytes).await
    }
    pub async fn stage_migration_item(
        &self,
        plan: &MigrationTransportPlan,
        index: usize,
    ) -> Result<MigrationState> {
        let item = plan.item(index)?;
        self.migration_write(
            plan,
            &["items", item.dto.binding.target.item_id.as_str()],
            &item.bytes,
        )
        .await
    }
    pub async fn stage_migration_file(
        &self,
        plan: &MigrationTransportPlan,
        item: usize,
        file: usize,
    ) -> Result<MigrationState> {
        let (envelope, bytes) = plan.file(item, file)?;
        self.migration_write(
            plan,
            &[
                "items",
                envelope.context.item_id.as_str(),
                "files",
                envelope.context.attachment_id.as_str(),
            ],
            bytes,
        )
        .await
    }
    pub async fn migration_status(&self, plan: &MigrationTransportPlan) -> Result<MigrationStatus> {
        let bytes = self
            .migration_send(Method::GET, self.migration_url(plan, &[])?, None)
            .await?;
        let status: MigrationStatus = decode(&bytes.0)?;
        if status.header != plan.header {
            return Err(Error::ContextMismatch);
        }
        // Comparing raw public values also rejects UUID spellings normalized by Core.
        let raw = SecretJson::parse(&bytes.0)?;
        if raw.0.get("header") != Some(&json!(plan.header)) {
            return Err(Error::ContextMismatch);
        }
        Ok(status)
    }
    pub async fn staged_migration_item(
        &self,
        plan: &MigrationTransportPlan,
        index: usize,
    ) -> Result<MigrationStagedItem> {
        let expected = &plan.item(index)?.dto;
        let bytes = self
            .migration_send(
                Method::GET,
                self.migration_url(plan, &["items", expected.binding.target.item_id.as_str()])?,
                None,
            )
            .await?;
        let item: MigrationStagedItem = decode(&bytes.0)?;
        if &item != expected {
            return Err(Error::ContextMismatch);
        }
        Ok(item)
    }
    pub async fn staged_migration_file(
        &self,
        plan: &MigrationTransportPlan,
        item: usize,
        file: usize,
    ) -> Result<EncryptedAttachment> {
        let expected = &plan.file(item, file)?.0;
        let bytes = self
            .migration_send(
                Method::GET,
                self.migration_url(
                    plan,
                    &[
                        "items",
                        expected.context.item_id.as_str(),
                        "files",
                        expected.context.attachment_id.as_str(),
                    ],
                )?,
                None,
            )
            .await?;
        let envelope: EncryptedAttachment = decode(&bytes.0)?;
        if &envelope != expected {
            return Err(Error::ContextMismatch);
        }
        Ok(envelope)
    }
    pub async fn cancel_migration(&self, plan: &MigrationTransportPlan) -> Result<MigrationState> {
        let bytes = self
            .migration_send(Method::DELETE, self.migration_url(plan, &[])?, None)
            .await?;
        let reply: StateReply = decode(&bytes.0)?;
        if reply.status != MigrationState::Aborted {
            return Err(Error::InvalidResponse("unexpected cancellation state"));
        }
        Ok(reply.status)
    }
    /// Explicit irreversible step. Caller must first authenticate all staged
    /// ciphertext with Core and independent original JSON/file bytes. A failed
    /// response does not prove rollback: check status, then decide explicitly.
    pub async fn commit_migration(&self, plan: &MigrationTransportPlan) -> Result<MigrationState> {
        let bytes = self
            .migration_send(Method::POST, self.migration_url(plan, &["commit"])?, None)
            .await?;
        let reply: CommitReply = decode(&bytes.0)?;
        if reply.status != MigrationState::Committed
            || reply.operation_id != plan.header.operation_id
        {
            return Err(Error::ContextMismatch);
        }
        Ok(reply.status)
    }
}

fn validate_source_references(value: &Value, item: &ItemContext) -> Result<()> {
    let refs = match value.get("attachments") {
        None => return Ok(()),
        Some(Value::Array(refs)) if refs.len() <= 1024 => refs,
        _ => {
            return Err(Error::InvalidResponse(
                "invalid source attachment references",
            ))
        }
    };
    let mut ids = std::collections::HashSet::new();
    for reference in refs {
        let file = reference
            .get("attachmentId")
            .and_then(Value::as_str)
            .ok_or(Error::InvalidResponse("invalid source attachment id"))?;
        let version = reference
            .get("attachmentVersion")
            .and_then(Value::as_u64)
            .ok_or(Error::InvalidResponse("invalid source attachment version"))?;
        if id(file).is_err()
            || positive(version).is_err()
            || !ids.insert(file)
            || reference.get("keyEpoch").and_then(Value::as_u64) != Some(item.key_epoch)
        {
            return Err(Error::ContextMismatch);
        }
    }
    Ok(())
}
fn source_file(bytes: &[u8], expected: &AttachmentContext) -> Result<MigrationSourceFile> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct File<'a> {
        id: &'a str,
        item_id: &'a str,
        name: &'a str,
        content_bytes: u64,
        available: bool,
        #[serde(deserialize_with = "nullable", borrow)]
        content: Option<&'a str>,
    }
    let value = SecretJson::parse(bytes)?;
    let file = File::deserialize(&value.0)
        .map_err(|_| Error::InvalidResponse("invalid source file response"))?;
    if file.id != expected.attachment_id.as_str() || file.item_id != expected.item_id.as_str() {
        return Err(Error::ContextMismatch);
    }
    if file.content_bytes > 1024 * 1024 || file.name.len() > 4096 {
        return Err(Error::InvalidResponse("source file exceeds Core limit"));
    }
    if !file.available {
        if file.content.is_some() {
            return Err(Error::InvalidResponse(
                "missing source file carries content",
            ));
        }
        return Ok(MigrationSourceFile::Missing {
            metadata: MigrationItemPlaintext::new(value.take())
                .map_err(|_| Error::InvalidResponse("invalid missing source file metadata"))?,
        });
    }
    let text = file.content.ok_or(Error::InvalidResponse(
        "available source file lacks content",
    ))?;
    let mut content = SecretBytes(Vec::new());
    STANDARD
        .decode_vec(text, &mut content.0)
        .map_err(|_| Error::InvalidResponse("invalid source file Base64"))?;
    let canonical = SecretBytes(STANDARD.encode(&content.0).into_bytes());
    if canonical.0 != text.as_bytes() || content.0.len() as u64 != file.content_bytes {
        return Err(Error::InvalidResponse("source file content mismatch"));
    }
    let plaintext = AttachmentPlaintext::new(file.name.to_owned(), std::mem::take(&mut content.0))
        .map_err(|_| Error::InvalidResponse("invalid source file plaintext"))?;
    Ok(MigrationSourceFile::Available(plaintext))
}

#[cfg(test)]
mod tests;
