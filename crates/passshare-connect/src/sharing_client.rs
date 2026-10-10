//! Session transport for sharing and atomic key rotation. No secret keys or
//! encryption passwords enter this module. Public shape checks do not establish
//! key trust or authenticate ciphertext; use Core with independently pinned keys.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use passshare_core::cloud_crypto::{
    AttachmentContext, EncryptedAttachment, EncryptedItem, PublicAccountIdentity, SharedKeyContext,
    WrappedSharedPasswordBoxKey, SHARED_KEY_SUITE,
};
use passshare_core::ConnectId;
use reqwest::{Method, Url};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::encrypted_client::{b64_len, decode};
use crate::{
    EncryptedSessionClient, EncryptedSessionError as Error, EncryptedSessionResult as Result,
    OwnerKeyBundle,
};

const MAX_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CIPHER: usize = 1_048_592;
const PAGE_SIZE: usize = 100;

fn safe(n: u64, minimum: u64) -> bool {
    (minimum..=MAX_INTEGER).contains(&n)
}
fn successor(n: u64) -> Result<u64> {
    if safe(n, 1) && n < MAX_INTEGER {
        Ok(n + 1)
    } else {
        Err(Error::InvalidArgument(
            "version or epoch cannot be incremented",
        ))
    }
}
fn id(s: &str) -> Result<()> {
    ConnectId::validate(s).map_err(|_| Error::InvalidArgument("invalid Connect identifier"))
}
fn canonical_uuid(s: &str) -> bool {
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
fn number<'de, D: Deserializer<'de>>(d: D, min: u64) -> std::result::Result<u64, D::Error> {
    let n = u64::deserialize(d)?;
    if safe(n, min) {
        Ok(n)
    } else {
        Err(serde::de::Error::custom("unsafe integer"))
    }
}
fn positive<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    number(d, 1)
}
fn count<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    number(d, 0)
}
// Omission preserves legacy responses; explicit null is invalid.
fn optional_positive<'de, D: Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<u64>, D::Error> {
    positive(d).map(Some)
}
fn zero<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    let n = u64::deserialize(d)?;
    if n == 0 {
        Ok(n)
    } else {
        Err(serde::de::Error::custom(
            "initial grant requires version zero",
        ))
    }
}
fn uuid_field<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<String, D::Error> {
    let s = String::deserialize(d)?;
    if canonical_uuid(&s) {
        Ok(s)
    } else {
        Err(serde::de::Error::custom("noncanonical UUID"))
    }
}
// deserialize_with makes these fields mandatory, while accepting explicit null.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
fn uuid_cursor<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<String>, D::Error> {
    let s = Option::<String>::deserialize(d)?;
    if s.as_deref().is_none_or(canonical_uuid) {
        Ok(s)
    } else {
        Err(serde::de::Error::custom("noncanonical UUID cursor"))
    }
}
fn bounded_page<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Vec<T>, D::Error> {
    let rows = Vec::<T>::deserialize(d)?;
    if rows.len() <= PAGE_SIZE {
        Ok(rows)
    } else {
        Err(serde::de::Error::custom("page exceeds 100 entries"))
    }
}
fn timestamp_field<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<String, D::Error> {
    let s = String::deserialize(d)?;
    if timestamp(&s) {
        Ok(s)
    } else {
        Err(serde::de::Error::custom("invalid expiration timestamp"))
    }
}
fn response_check(ok: bool) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidResponse(
            "sharing response violates expected contract",
        ))
    }
}
fn argument_check(ok: bool) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidArgument(
            "sharing inputs violate expected contract",
        ))
    }
}
fn wire<T: Serialize>(v: &T) -> Result<Value> {
    serde_json::to_value(v).map_err(|_| Error::InvalidArgument("cannot encode sharing payload"))
}

/// The caller must obtain both descriptors and this context independently of
/// the fetched envelope. Descriptor self-validation alone does not prove trust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedKeyExpectation {
    pub context: SharedKeyContext,
    pub sender: PublicAccountIdentity,
    pub recipient: PublicAccountIdentity,
}
impl SharedKeyExpectation {
    pub fn validate(&self, box_id: &str) -> Result<()> {
        id(box_id)?;
        let c = &self.context;
        argument_check(
            c.password_box_id.as_str() == box_id
                && c.sender_account_id != c.recipient_account_id
                && safe(c.key_epoch, 1)
                && safe(c.sender_identity_version, 1)
                && safe(c.recipient_identity_version, 1)
                && !c.sender_account_id.is_nil()
                && !c.recipient_account_id.is_nil()
                && fingerprint(&c.sender_key_id)
                && fingerprint(&c.recipient_key_id)
                && self.sender.validate_public().is_ok()
                && self.recipient.validate_public().is_ok()
                && c.sender_account_id == self.sender.account_id
                && c.sender_identity_version == self.sender.identity_version
                && c.sender_key_id == self.sender.key_id
                && c.recipient_account_id == self.recipient.account_id
                && c.recipient_identity_version == self.recipient.identity_version
                && c.recipient_key_id == self.recipient.key_id,
        )
    }
    pub fn validate_envelope(
        &self,
        box_id: &str,
        envelope: &WrappedSharedPasswordBoxKey,
    ) -> Result<()> {
        self.validate(box_id)?;
        argument_check(shared_shape(envelope))?;
        argument_check(envelope.context == self.context)
    }
}
fn fingerprint(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn shared_shape(e: &WrappedSharedPasswordBoxKey) -> bool {
    let c = &e.context;
    if e.format != 1
        || e.suite != SHARED_KEY_SUITE
        || b64_len(&e.enc) != Some(32)
        || b64_len(&e.ciphertext) != Some(48)
        || !safe(c.key_epoch, 1)
        || !safe(c.sender_identity_version, 1)
        || !safe(c.recipient_identity_version, 1)
        || c.sender_account_id.is_nil()
        || c.recipient_account_id.is_nil()
        || c.sender_account_id == c.recipient_account_id
        || !fingerprint(&c.sender_key_id)
        || !fingerprint(&c.recipient_key_id)
        || ConnectId::validate(c.password_box_id.as_str()).is_err()
    {
        return false;
    }
    let Ok(point) = STANDARD.decode(&e.enc) else {
        return false;
    };
    point[31] & 0x80 == 0
        && !(point[31] == 0x7f && point[1..31].iter().all(|&b| b == 0xff) && point[0] >= 0xed)
}
fn shared_reply(
    bytes: &[u8],
    path: &str,
    e: &WrappedSharedPasswordBoxKey,
    expected: &SharedKeyExpectation,
) -> Result<()> {
    // Typed decode first preserves serde's duplicate/unknown-field rejection.
    let v: Value = decode(bytes)?;
    let c = v
        .pointer(path)
        .ok_or(Error::InvalidResponse("missing shared context"))?;
    response_check(["senderAccountId", "recipientAccountId"].iter().all(|key| {
        c.get(key)
            .and_then(Value::as_str)
            .is_some_and(canonical_uuid)
    }))?;
    response_check(shared_shape(e))?;
    if e.context != expected.context {
        return Err(Error::ContextMismatch);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitialGrantRequest {
    #[serde(deserialize_with = "positive")]
    pub expected_state_revision: u64,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
    #[serde(deserialize_with = "zero")]
    pub expected_version: u64,
    pub envelope: WrappedSharedPasswordBoxKey,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitialGrantReply {
    #[serde(deserialize_with = "positive")]
    pub grant_version: u64,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
    #[serde(deserialize_with = "positive")]
    pub state_revision: u64,
    pub envelope: WrappedSharedPasswordBoxKey,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelfGrantReply {
    #[serde(deserialize_with = "positive")]
    pub grant_version: u64,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
    pub envelope: WrappedSharedPasswordBoxKey,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharingSnapshot {
    #[serde(deserialize_with = "positive")]
    pub state_revision: u64,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
    #[serde(deserialize_with = "uuid_field")]
    pub owner_account_id: String,
    #[serde(deserialize_with = "positive")]
    pub owner_bundle_version: u64,
    #[serde(deserialize_with = "positive")]
    pub member_count: u64,
    #[serde(deserialize_with = "count")]
    pub live_item_count: u64,
    #[serde(deserialize_with = "count")]
    pub grant_count: u64,
    #[serde(
        default,
        deserialize_with = "optional_positive",
        skip_serializing_if = "Option::is_none"
    )]
    pub live_attachment_count: Option<u64>,
    #[serde(
        default,
        deserialize_with = "optional_positive",
        skip_serializing_if = "Option::is_none"
    )]
    pub live_attachment_bytes: Option<u64>,
}
impl SharingSnapshot {
    pub fn validate(&self) -> Result<()> {
        if !canonical_uuid(&self.owner_account_id) {
            return Err(Error::InvalidArgument("UUID must be canonical and nonnil"));
        }
        argument_check(
            safe(self.state_revision, 1)
                && safe(self.key_epoch, 1)
                && safe(self.owner_bundle_version, 1)
                && safe(self.member_count, 1)
                && safe(self.live_item_count, 0)
                && safe(self.grant_count, 0)
                && self.grant_count < self.member_count,
        )?;
        argument_check(
            match (self.live_attachment_count, self.live_attachment_bytes) {
                (None, None) => true,
                (Some(n), Some(bytes)) => {
                    (1..=1024).contains(&n) && (1..=1_073_741_824).contains(&bytes)
                }
                _ => false,
            },
        )
    }
    /// Call after collecting all pages at this revision and before constructing
    /// a rotation. Rejects missing rows, duplicates, extra owners and grantees.
    pub fn validate_complete_members(&self, members: &[SharingMember]) -> Result<()> {
        self.validate()?;
        argument_check(
            members.len() as u64 == self.member_count
                && members
                    .windows(2)
                    .all(|w| w[0].account_id < w[1].account_id)
                && members.iter().all(|m| member_shape(m, self))
                && members
                    .iter()
                    .filter(|m| m.role == SharingMemberRole::Owner)
                    .count()
                    == 1
                && members.iter().filter(|m| m.key_granted).count() as u64 == self.grant_count,
        )
    }
    pub fn validate_complete_items(&self, items: &[SharingItemSummary]) -> Result<()> {
        self.validate()?;
        argument_check(
            items.len() as u64 == self.live_item_count
                && items
                    .windows(2)
                    .all(|w| w[0].item_id.as_str() < w[1].item_id.as_str())
                && items.iter().all(|i| {
                    ConnectId::validate(i.item_id.as_str()).is_ok()
                        && safe(i.item_version, 1)
                        && i.key_epoch == self.key_epoch
                }),
        )
    }
}
fn member_shape(m: &SharingMember, snapshot: &SharingSnapshot) -> bool {
    canonical_uuid(&m.account_id)
        && (m.role == SharingMemberRole::Owner) == (m.account_id == snapshot.owner_account_id)
        && (!m.key_granted || (m.membership_confirmed && m.role != SharingMemberRole::Owner))
        && (m.role != SharingMemberRole::Owner || m.membership_confirmed)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SharingMemberRole {
    Owner,
    Member,
    Readonly,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharingMember {
    #[serde(deserialize_with = "uuid_field")]
    pub account_id: String,
    pub role: SharingMemberRole,
    pub membership_confirmed: bool,
    pub key_granted: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharingMembersPage {
    #[serde(deserialize_with = "positive")]
    pub state_revision: u64,
    #[serde(deserialize_with = "bounded_page")]
    pub members: Vec<SharingMember>,
    #[serde(deserialize_with = "uuid_cursor")]
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharingItemsPage {
    #[serde(deserialize_with = "positive")]
    pub state_revision: u64,
    #[serde(deserialize_with = "bounded_page")]
    pub items: Vec<SharingItemSummary>,
    #[serde(deserialize_with = "nullable")]
    pub next_cursor: Option<ConnectId>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharingItemSummary {
    pub item_id: ConnectId,
    #[serde(deserialize_with = "positive")]
    pub item_version: u64,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharingAttachmentSummary {
    pub item_id: ConnectId,
    pub attachment_id: ConnectId,
    #[serde(deserialize_with = "positive")]
    pub attachment_version: u64,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
}
impl SharingAttachmentSummary {
    pub fn cursor(&self) -> String {
        format!("{}:{}", self.item_id, self.attachment_id)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharingAttachmentsPage {
    #[serde(deserialize_with = "positive")]
    pub state_revision: u64,
    #[serde(deserialize_with = "bounded_page")]
    pub attachments: Vec<SharingAttachmentSummary>,
    #[serde(deserialize_with = "nullable")]
    pub next_cursor: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationAttachmentRequest {
    #[serde(deserialize_with = "positive")]
    pub expected_version: u64,
    pub envelope: EncryptedAttachment,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationAttachmentReply {
    #[serde(deserialize_with = "uuid_field")]
    pub operation_id: String,
    pub item_id: ConnectId,
    pub attachment_id: ConnectId,
    #[serde(deserialize_with = "positive")]
    pub attachment_version: u64,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
}
fn attachment_cursor(cursor: &str) -> Result<()> {
    let (item, file) = cursor
        .split_once(':')
        .ok_or(Error::InvalidArgument("invalid attachment cursor"))?;
    id(item)?;
    id(file)
}

/// Persist this expectation alongside the immutable start payload. Reuse it
/// after a lost reply; never replace its base revision with a later snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RotationExpectation {
    pub operation_id: String,
    pub password_box_id: ConnectId,
    pub owner_account_id: String,
    pub expected_state_revision: u64,
    pub expected_key_epoch: u64,
    pub expected_owner_bundle_version: u64,
    pub remove_account_id: String,
    /// Exact final counts, if known from the complete original snapshot.
    pub item_count: Option<u64>,
    pub grant_count: Option<u64>,
}
impl RotationExpectation {
    pub fn validate(&self) -> Result<()> {
        id(self.password_box_id.as_str())?;
        if !canonical_uuid(&self.operation_id)
            || !canonical_uuid(&self.owner_account_id)
            || !canonical_uuid(&self.remove_account_id)
        {
            return Err(Error::InvalidArgument("UUID must be canonical and nonnil"));
        }
        successor(self.expected_key_epoch)?;
        successor(self.expected_owner_bundle_version)?;
        argument_check(
            safe(self.expected_state_revision, 1)
                && self.expected_state_revision < MAX_INTEGER
                && self.owner_account_id != self.remove_account_id
                && self.item_count.is_none_or(|n| safe(n, 0))
                && self.grant_count.is_none_or(|n| safe(n, 0)),
        )
    }
    fn check_result(&self, r: &RotationCommitReply) -> Result<()> {
        response_check(
            r.operation_id == self.operation_id
                && r.key_epoch == self.expected_key_epoch + 1
                && r.owner_bundle_version == self.expected_owner_bundle_version + 1
                && r.removed_account_id == self.remove_account_id
                && r.state_revision > self.expected_state_revision
                && self.item_count.is_none_or(|n| n == r.item_count)
                && self.grant_count.is_none_or(|n| n == r.grant_count)
                && r.attachment_count.is_none_or(|n| (1..=1024).contains(&n)),
        )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationStartRequest {
    #[serde(deserialize_with = "positive")]
    pub expected_state_revision: u64,
    #[serde(deserialize_with = "positive")]
    pub expected_key_epoch: u64,
    #[serde(deserialize_with = "positive")]
    pub expected_owner_bundle_version: u64,
    #[serde(deserialize_with = "uuid_field")]
    pub remove_account_id: String,
    pub bundle: OwnerKeyBundle,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
pub enum RotationStartReply {
    Pending {
        #[serde(rename = "operationId", deserialize_with = "uuid_field")]
        operation_id: String,
    },
    Committed {
        #[serde(rename = "operationId", deserialize_with = "uuid_field")]
        operation_id: String,
        result: RotationCommitReply,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationItemRequest {
    #[serde(deserialize_with = "positive")]
    pub expected_version: u64,
    pub envelope: EncryptedItem,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationGrantRequest {
    pub envelope: WrappedSharedPasswordBoxKey,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationItemReply {
    #[serde(deserialize_with = "uuid_field")]
    pub operation_id: String,
    pub item_id: ConnectId,
    #[serde(deserialize_with = "positive")]
    pub item_version: u64,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationGrantReply {
    #[serde(deserialize_with = "uuid_field")]
    pub operation_id: String,
    #[serde(deserialize_with = "uuid_field")]
    pub recipient_account_id: String,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
}
/// A login proof, never an encryption password. Debug always redacts it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationCommitRequest {
    pub current_password: String,
}
impl std::fmt::Debug for RotationCommitRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RotationCommitRequest")
            .field("current_password", &"<redacted>")
            .finish()
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommittedStatus {
    Committed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationCommitReply {
    #[serde(deserialize_with = "uuid_field")]
    pub operation_id: String,
    pub status: CommittedStatus,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
    #[serde(deserialize_with = "positive")]
    pub state_revision: u64,
    #[serde(deserialize_with = "positive")]
    pub owner_bundle_version: u64,
    #[serde(deserialize_with = "uuid_field")]
    pub removed_account_id: String,
    #[serde(deserialize_with = "count")]
    pub item_count: u64,
    #[serde(deserialize_with = "count")]
    pub grant_count: u64,
    #[serde(
        default,
        deserialize_with = "optional_positive",
        skip_serializing_if = "Option::is_none"
    )]
    pub attachment_count: Option<u64>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RotationStatus {
    Pending,
    Expired,
    Committed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RotationStatusReply {
    #[serde(deserialize_with = "uuid_field")]
    pub operation_id: String,
    pub status: RotationStatus,
    #[serde(deserialize_with = "count")]
    pub item_count: u64,
    #[serde(deserialize_with = "count")]
    pub grant_count: u64,
    #[serde(
        default,
        deserialize_with = "optional_positive",
        skip_serializing_if = "Option::is_none"
    )]
    pub attachment_count: Option<u64>,
    #[serde(deserialize_with = "count")]
    pub staged_bytes: u64,
    #[serde(deserialize_with = "timestamp_field")]
    pub expires_at: String,
    #[serde(deserialize_with = "nullable")]
    pub result: Option<RotationCommitReply>,
}

/// Clones the existing session transport, preserving its URL guards, bearer,
/// no-proxy/no-redirect/no-cookie behavior, bounds, and strict 204 handling.
#[derive(Debug, Clone)]
pub struct SharingRotationClient {
    session: EncryptedSessionClient,
}
impl From<EncryptedSessionClient> for SharingRotationClient {
    fn from(session: EncryptedSessionClient) -> Self {
        Self { session }
    }
}
impl SharingRotationClient {
    pub fn new(session: &EncryptedSessionClient) -> Self {
        Self {
            session: session.clone(),
        }
    }
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
    ) -> Result<(T, Vec<u8>)> {
        let bytes = self.session.send(method, url, body).await?;
        Ok((decode(&bytes)?, bytes))
    }
    fn endpoint(&self, box_id: &str, tail: &[&str]) -> Result<Url> {
        id(box_id)?;
        let mut segments = vec!["boxes", box_id];
        segments.extend_from_slice(tail);
        self.session.endpoint(&segments)
    }
    fn rotation_url(&self, e: &RotationExpectation, tail: &[&str]) -> Result<Url> {
        e.validate()?;
        let mut path = vec!["rotations", e.operation_id.as_str()];
        path.extend_from_slice(tail);
        self.endpoint(e.password_box_id.as_str(), &path)
    }
    pub async fn put_initial_grant(
        &self,
        box_id: &str,
        recipient_id: &str,
        request: &InitialGrantRequest,
        expected: &SharedKeyExpectation,
    ) -> Result<InitialGrantReply> {
        if !canonical_uuid(recipient_id) {
            return Err(Error::InvalidArgument("UUID must be canonical and nonnil"));
        }
        expected.validate_envelope(box_id, &request.envelope)?;
        argument_check(
            request.expected_version == 0
                && safe(request.expected_state_revision, 1)
                && request.key_epoch == expected.context.key_epoch
                && recipient_id == expected.context.recipient_account_id.to_string(),
        )?;
        let (reply, bytes): (InitialGrantReply, _) = self
            .request(
                Method::PUT,
                self.endpoint(box_id, &["grants", recipient_id])?,
                Some(&wire(request)?),
            )
            .await?;
        shared_reply(&bytes, "/envelope/context", &reply.envelope, expected)?;
        response_check(
            reply.grant_version == 1
                && reply.key_epoch == request.key_epoch
                && reply.state_revision >= request.expected_state_revision
                && reply.envelope == request.envelope,
        )?;
        Ok(reply)
    }
    /// Expected context is mandatory and is never inferred from this reply.
    pub async fn get_self_grant(
        &self,
        box_id: &str,
        expected: &SharedKeyExpectation,
    ) -> Result<SelfGrantReply> {
        expected.validate(box_id)?;
        let (reply, bytes): (SelfGrantReply, _) = self
            .request(Method::GET, self.endpoint(box_id, &["grants", "me"])?, None)
            .await?;
        shared_reply(&bytes, "/envelope/context", &reply.envelope, expected)?;
        response_check(reply.grant_version == 1 && reply.key_epoch == expected.context.key_epoch)?;
        Ok(reply)
    }
    pub async fn sharing_snapshot(
        &self,
        box_id: &str,
        expected_owner_id: &str,
    ) -> Result<SharingSnapshot> {
        if !canonical_uuid(expected_owner_id) {
            return Err(Error::InvalidArgument("UUID must be canonical and nonnil"));
        }
        let (reply, _): (SharingSnapshot, _) = self
            .request(
                Method::GET,
                self.endpoint(box_id, &["sharing-snapshot"])?,
                None,
            )
            .await?;
        response_check(reply.validate().is_ok())?;
        if reply.owner_account_id != expected_owner_id {
            return Err(Error::ContextMismatch);
        }
        Ok(reply)
    }
    fn snapshot_url(
        &self,
        box_id: &str,
        snapshot: &SharingSnapshot,
        tail: &[&str],
        after: Option<&str>,
    ) -> Result<Url> {
        snapshot.validate()?;
        let mut path = vec!["sharing-snapshot"];
        path.extend_from_slice(tail);
        let mut url = self.endpoint(box_id, &path)?;
        url.query_pairs_mut()
            .append_pair("revision", &snapshot.state_revision.to_string());
        if let Some(after) = after {
            url.query_pairs_mut().append_pair("after", after);
        }
        Ok(url)
    }
    pub async fn snapshot_members(
        &self,
        box_id: &str,
        snapshot: &SharingSnapshot,
        after: Option<&str>,
    ) -> Result<SharingMembersPage> {
        if let Some(after) = after {
            if !canonical_uuid(after) {
                return Err(Error::InvalidArgument("UUID must be canonical and nonnil"));
            }
        }
        let (reply, _): (SharingMembersPage, _) = self
            .request(
                Method::GET,
                self.snapshot_url(box_id, snapshot, &["members"], after)?,
                None,
            )
            .await?;
        response_check(
            reply.state_revision == snapshot.state_revision
                && reply.members.len() as u64 <= snapshot.member_count,
        )?;
        page(
            reply.members.iter().map(|m| m.account_id.as_str()),
            after,
            reply.next_cursor.as_deref(),
        )?;
        response_check(reply.members.iter().all(|m| member_shape(m, snapshot)))?;
        // A complete one-page result must contain the sole owner and match counts.
        if after.is_none() {
            response_check(
                reply.members.len() as u64 == snapshot.member_count.min(PAGE_SIZE as u64),
            )?;
        }
        if after.is_none() && reply.next_cursor.is_none() {
            response_check(snapshot.validate_complete_members(&reply.members).is_ok())?;
        }
        Ok(reply)
    }
    pub async fn snapshot_items(
        &self,
        box_id: &str,
        snapshot: &SharingSnapshot,
        after: Option<&str>,
    ) -> Result<SharingItemsPage> {
        if let Some(after) = after {
            id(after)?;
        }
        let (reply, _): (SharingItemsPage, _) = self
            .request(
                Method::GET,
                self.snapshot_url(box_id, snapshot, &["items"], after)?,
                None,
            )
            .await?;
        response_check(
            reply.state_revision == snapshot.state_revision
                && reply.items.len() as u64 <= snapshot.live_item_count,
        )?;
        page(
            reply.items.iter().map(|m| m.item_id.as_str()),
            after,
            reply.next_cursor.as_ref().map(ConnectId::as_str),
        )?;
        response_check(
            reply
                .items
                .iter()
                .all(|m| safe(m.item_version, 1) && m.key_epoch == snapshot.key_epoch),
        )?;
        if after.is_none() {
            response_check(
                reply.items.len() as u64 == snapshot.live_item_count.min(PAGE_SIZE as u64),
            )?;
        }
        Ok(reply)
    }
    pub async fn snapshot_item(
        &self,
        box_id: &str,
        snapshot: &SharingSnapshot,
        item: &SharingItemSummary,
    ) -> Result<EncryptedItem> {
        id(item.item_id.as_str())?;
        argument_check(safe(item.item_version, 1) && item.key_epoch == snapshot.key_epoch)?;
        let (reply, _): (EncryptedItem, _) = self
            .request(
                Method::GET,
                self.snapshot_url(box_id, snapshot, &["items", item.item_id.as_str()], None)?,
                None,
            )
            .await?;
        response_check(item_shape(
            &reply,
            box_id,
            item.item_id.as_str(),
            item.item_version,
            snapshot.key_epoch,
        ))?;
        Ok(reply)
    }
    pub async fn start_rotation(
        &self,
        expected: &RotationExpectation,
        bundle: &OwnerKeyBundle,
    ) -> Result<RotationStartReply> {
        let url = self.rotation_url(expected, &[])?;
        bundle.validate()?;
        let c = &bundle.wrapped.context;
        argument_check(
            c.password_box_id == expected.password_box_id
                && c.owner_account_id.to_string() == expected.owner_account_id
                && c.key_epoch == expected.expected_key_epoch + 1,
        )?;
        let request = RotationStartRequest {
            expected_state_revision: expected.expected_state_revision,
            expected_key_epoch: expected.expected_key_epoch,
            expected_owner_bundle_version: expected.expected_owner_bundle_version,
            remove_account_id: expected.remove_account_id.clone(),
            bundle: bundle.clone(),
        };
        let (reply, _): (RotationStartReply, _) = self
            .request(Method::PUT, url, Some(&wire(&request)?))
            .await?;
        match &reply {
            RotationStartReply::Pending { operation_id } => {
                response_check(operation_id == &expected.operation_id)?
            }
            RotationStartReply::Committed {
                operation_id,
                result,
            } => {
                response_check(operation_id == &expected.operation_id)?;
                expected.check_result(result)?;
            }
        }
        Ok(reply)
    }
    pub async fn stage_item(
        &self,
        expected: &RotationExpectation,
        request: &RotationItemRequest,
    ) -> Result<RotationItemReply> {
        expected.validate()?;
        let c = &request.envelope.context;
        let new_version = successor(request.expected_version)?;
        id(c.item_id.as_str())?;
        argument_check(item_shape(
            &request.envelope,
            expected.password_box_id.as_str(),
            c.item_id.as_str(),
            new_version,
            expected.expected_key_epoch + 1,
        ))?;
        let (reply, _): (RotationItemReply, _) = self
            .request(
                Method::PUT,
                self.rotation_url(expected, &["items", c.item_id.as_str()])?,
                Some(&wire(request)?),
            )
            .await?;
        response_check(
            reply.operation_id == expected.operation_id
                && reply.item_id == c.item_id
                && reply.item_version == new_version
                && reply.key_epoch == expected.expected_key_epoch + 1,
        )?;
        Ok(reply)
    }
    pub async fn stage_grant(
        &self,
        rotation: &RotationExpectation,
        request: &RotationGrantRequest,
        expected: &SharedKeyExpectation,
    ) -> Result<RotationGrantReply> {
        rotation.validate()?;
        expected.validate_envelope(rotation.password_box_id.as_str(), &request.envelope)?;
        let recipient = expected.context.recipient_account_id.to_string();
        argument_check(
            expected.context.key_epoch == rotation.expected_key_epoch + 1
                && expected.context.sender_account_id.to_string() == rotation.owner_account_id
                && recipient != rotation.remove_account_id,
        )?;
        let (reply, _): (RotationGrantReply, _) = self
            .request(
                Method::PUT,
                self.rotation_url(rotation, &["grants", &recipient])?,
                Some(&wire(request)?),
            )
            .await?;
        response_check(
            reply.operation_id == rotation.operation_id
                && reply.recipient_account_id == recipient
                && reply.key_epoch == rotation.expected_key_epoch + 1,
        )?;
        Ok(reply)
    }
    /// Only the current LOGIN password is sent. No encryption password is
    /// accepted. The transport never returns server text or request fragments.
    pub async fn commit_rotation(
        &self,
        expected: &RotationExpectation,
        current_login_password: &str,
    ) -> Result<RotationCommitReply> {
        let url = self.rotation_url(expected, &["commit"])?;
        argument_check(!current_login_password.is_empty())?;
        let request = RotationCommitRequest {
            current_password: current_login_password.to_owned(),
        };
        let (reply, _): (RotationCommitReply, _) = self
            .request(Method::POST, url, Some(&wire(&request)?))
            .await?;
        expected.check_result(&reply)?;
        Ok(reply)
    }
    /// A committed result is historical evidence for this operation, not the
    /// latest box state. This client maintains no mutable revision/epoch cache.
    pub async fn rotation_status(
        &self,
        expected: &RotationExpectation,
    ) -> Result<RotationStatusReply> {
        let (reply, _): (RotationStatusReply, _) = self
            .request(Method::GET, self.rotation_url(expected, &[])?, None)
            .await?;
        response_check(
            reply.operation_id == expected.operation_id
                && timestamp(&reply.expires_at)
                && expected.item_count.is_none_or(|n| reply.item_count <= n)
                && expected.grant_count.is_none_or(|n| reply.grant_count <= n)
                && reply
                    .attachment_count
                    .is_none_or(|n| (1..=1024).contains(&n)),
        )?;
        match (reply.status, &reply.result) {
            (RotationStatus::Committed, Some(r)) => {
                expected.check_result(r)?;
                response_check(
                    reply.item_count == r.item_count
                        && reply.grant_count == r.grant_count
                        && reply.attachment_count == r.attachment_count
                        && reply.staged_bytes == 0,
                )?;
            }
            (RotationStatus::Pending | RotationStatus::Expired, None) => {}
            _ => {
                return Err(Error::InvalidResponse(
                    "inconsistent rotation status and result",
                ))
            }
        }
        Ok(reply)
    }
    /// Public metadata pagination only. This does not prove the complete set or stored byte budget.
    pub async fn snapshot_attachments(
        &self,
        box_id: &str,
        snapshot: &SharingSnapshot,
        after: Option<&str>,
    ) -> Result<SharingAttachmentsPage> {
        if let Some(cursor) = after {
            attachment_cursor(cursor)?;
        }
        let (reply, _): (SharingAttachmentsPage, _) = self
            .request(
                Method::GET,
                self.snapshot_url(box_id, snapshot, &["attachments"], after)?,
                None,
            )
            .await?;
        response_check(
            reply.state_revision == snapshot.state_revision
                && reply.attachments.len() as u64 <= snapshot.live_attachment_count.unwrap_or(0),
        )?;
        let cursors: Vec<_> = reply
            .attachments
            .iter()
            .map(SharingAttachmentSummary::cursor)
            .collect();
        page(
            cursors.iter().map(String::as_str),
            after,
            reply.next_cursor.as_deref(),
        )?;
        response_check(reply.attachments.iter().all(|a| {
            id(a.item_id.as_str()).is_ok()
                && id(a.attachment_id.as_str()).is_ok()
                && a.key_epoch == snapshot.key_epoch
        }))?;
        if let Some(cursor) = &reply.next_cursor {
            response_check(attachment_cursor(cursor).is_ok())?;
        }
        if after.is_none() {
            response_check(
                reply.attachments.len() as u64
                    == snapshot.live_attachment_count.unwrap_or(0).min(100),
            )?;
        }
        Ok(reply)
    }
    /// Mandatory independent context from the authenticated item reference at this revision.
    pub async fn snapshot_attachment(
        &self,
        box_id: &str,
        snapshot: &SharingSnapshot,
        expected: &AttachmentContext,
    ) -> Result<EncryptedAttachment> {
        crate::attachment_client::expected(expected)?;
        argument_check(
            expected.password_box_id.as_str() == box_id && expected.key_epoch == snapshot.key_epoch,
        )?;
        let reply: EncryptedAttachment = decode(
            &self
                .session
                .send_attachment(self.snapshot_url(
                    box_id,
                    snapshot,
                    &[
                        "items",
                        expected.item_id.as_str(),
                        "attachments",
                        expected.attachment_id.as_str(),
                    ],
                    None,
                )?)
                .await?,
        )?;
        if reply.context != *expected {
            return Err(Error::ContextMismatch);
        }
        Ok(reply)
    }
    pub async fn stage_attachment(
        &self,
        rotation: &RotationExpectation,
        request: &RotationAttachmentRequest,
        expected: &AttachmentContext,
    ) -> Result<RotationAttachmentReply> {
        rotation.validate()?;
        crate::attachment_client::envelope(&request.envelope, expected)?;
        argument_check(
            expected.password_box_id == rotation.password_box_id
                && expected.key_epoch == rotation.expected_key_epoch + 1
                && expected.attachment_version == successor(request.expected_version)?,
        )?;
        let body = wire(request)?;
        crate::attachment_client::bounded_request(&body)?;
        let (reply, _): (RotationAttachmentReply, _) = self
            .request(
                Method::PUT,
                self.rotation_url(
                    rotation,
                    &[
                        "items",
                        expected.item_id.as_str(),
                        "attachments",
                        expected.attachment_id.as_str(),
                    ],
                )?,
                Some(&body),
            )
            .await?;
        response_check(
            reply.operation_id == rotation.operation_id
                && reply.item_id == expected.item_id
                && reply.attachment_id == expected.attachment_id
                && reply.attachment_version == expected.attachment_version
                && reply.key_epoch == expected.key_epoch,
        )?;
        Ok(reply)
    }
    /// Callers with attachments must retain an independently collected final count.
    pub async fn commit_rotation_with_attachments(
        &self,
        expected: &RotationExpectation,
        attachment_count: u64,
        current_login_password: &str,
    ) -> Result<RotationCommitReply> {
        argument_check(attachment_count <= 1024)?;
        let reply = self
            .commit_rotation(expected, current_login_password)
            .await?;
        response_check(reply.attachment_count.unwrap_or(0) == attachment_count)?;
        Ok(reply)
    }
    /// Omission on pending/expired means zero staged attachments, as emitted by
    /// the API. It does not prove server support, capacity or completion. A
    /// committed result must match the independently held final attachment count.
    pub async fn rotation_status_with_attachments(
        &self,
        expected: &RotationExpectation,
        attachment_count: u64,
    ) -> Result<RotationStatusReply> {
        argument_check(attachment_count <= 1024)?;
        let reply = self.rotation_status(expected).await?;
        response_check(reply.attachment_count.unwrap_or(0) <= attachment_count)?;
        if let Some(result) = &reply.result {
            response_check(result.attachment_count.unwrap_or(0) == attachment_count)?;
        }
        Ok(reply)
    }
    pub async fn abort_rotation(&self, expected: &RotationExpectation) -> Result<()> {
        self.session
            .send_expected(Method::DELETE, self.rotation_url(expected, &[])?, None, 204)
            .await?;
        Ok(())
    }
}
fn page<'a>(
    ids: impl Iterator<Item = &'a str>,
    after: Option<&str>,
    next: Option<&str>,
) -> Result<()> {
    let ids: Vec<_> = ids.collect();
    response_check(
        ids.len() <= PAGE_SIZE
            && ids.windows(2).all(|w| w[0] < w[1])
            && ids
                .first()
                .is_none_or(|first| after.is_none_or(|a| *first > a))
            && if ids.len() == PAGE_SIZE {
                next == ids.last().copied()
            } else {
                next.is_none()
            },
    )
}
fn item_shape(e: &EncryptedItem, box_id: &str, item_id: &str, version: u64, epoch: u64) -> bool {
    let c = &e.context;
    e.format == 1
        && c.password_box_id.as_str() == box_id
        && c.item_id.as_str() == item_id
        && safe(version, 1)
        && safe(epoch, 1)
        && c.item_version == version
        && c.key_epoch == epoch
        && b64_len(&e.nonce) == Some(24)
        && b64_len(&e.ciphertext).is_some_and(|n| (16..=MAX_CIPHER).contains(&n))
}
// PostgreSQL JSON timestamps use ISO dates and an explicit UTC offset. Validate
// the calendar and clock without depending on a new date/time crate.
fn timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    if !(25..=32).contains(&b.len())
        || b.get(4) != Some(&b'-')
        || b.get(7) != Some(&b'-')
        || b.get(10) != Some(&b'T')
        || b.get(13) != Some(&b':')
        || b.get(16) != Some(&b':')
    {
        return false;
    }
    let parse = |a: usize, z: usize| -> Option<u32> {
        let part = b.get(a..z)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        part.iter().try_fold(0u32, |v, n| {
            v.checked_mul(10)?.checked_add(u32::from(n - b'0'))
        })
    };
    let (Some(y), Some(m), Some(d), Some(h), Some(min), Some(sec)) = (
        parse(0, 4),
        parse(5, 7),
        parse(8, 10),
        parse(11, 13),
        parse(14, 16),
        parse(17, 19),
    ) else {
        return false;
    };
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    if y == 0 || d == 0 || d > days || h > 23 || min > 59 || sec > 59 {
        return false;
    }
    let offset = b.len() - 6;
    if offset != 19
        && !(offset >= 21 && b[19] == b'.' && b[20..offset].iter().all(u8::is_ascii_digit))
    {
        return false;
    }
    matches!(b[offset], b'+' | b'-')
        && b[offset + 3] == b':'
        && parse(offset + 1, offset + 3).is_some_and(|n| n <= 23)
        && parse(offset + 4, offset + 6).is_some_and(|n| n <= 59)
}

#[cfg(test)]
mod tests {
    use super::*;
    use passshare_core::cloud_crypto::{
        AccountIdentity, AccountIdentityContext, ItemContext, OwnerKeyContext, PasswordBoxKey,
    };
    use passshare_core::crypto::MasterKey;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    const OWNER: &str = "11111111-1111-4111-8111-111111111111";
    const RECIPIENT: &str = "22222222-2222-4222-8222-222222222222";
    const REMOVED: &str = "33333333-3333-4333-8333-333333333333";
    const OP: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const TOKEN: &str = "synthetic-session-bearer";
    fn box_id() -> String {
        "b".repeat(26)
    }
    fn item_id() -> String {
        "i".repeat(26)
    }

    struct Data {
        recipient: AccountIdentity,
        expected: SharedKeyExpectation,
        key: PasswordBoxKey,
        shared: WrappedSharedPasswordBoxKey,
        bundle: OwnerKeyBundle,
        item: EncryptedItem,
    }
    fn data(epoch: u64) -> Data {
        let identity = |account: &str| {
            AccountIdentity::generate(AccountIdentityContext {
                account_id: account.parse().unwrap(),
                identity_version: 1,
            })
            .unwrap()
        };
        let sender = identity(OWNER);
        let recipient = identity(RECIPIENT);
        let key = PasswordBoxKey::generate().unwrap();
        let s = sender.public_identity();
        let r = recipient.public_identity();
        let context = SharedKeyContext {
            password_box_id: box_id().parse().unwrap(),
            sender_account_id: s.account_id,
            recipient_account_id: r.account_id,
            key_epoch: epoch,
            sender_identity_version: s.identity_version,
            recipient_identity_version: r.identity_version,
            sender_key_id: s.key_id.clone(),
            recipient_key_id: r.key_id.clone(),
        };
        let shared = key.wrap_for_recipient(&sender, &r, &context).unwrap();
        let root = MasterKey::generate().unwrap();
        let wrapped = key
            .wrap_for_owner(
                &root,
                &OwnerKeyContext {
                    password_box_id: context.password_box_id.clone(),
                    owner_account_id: s.account_id,
                    key_epoch: epoch,
                },
            )
            .unwrap();
        // A fresh runtime-generated salt avoids fixed credential material.
        let salt = STANDARD.encode(&STANDARD.decode(&wrapped.nonce).unwrap()[..16]);
        let bundle = OwnerKeyBundle::new(salt, wrapped).unwrap();
        let item = key
            .encrypt_item(
                &json!({"id":item_id(),"vault":{"id":box_id()},"version":2,
            "title":"Synthetic fixture", "extra":{"preserved":[true,7]}}),
                &ItemContext {
                    password_box_id: box_id().parse().unwrap(),
                    item_id: item_id().parse().unwrap(),
                    key_epoch: epoch,
                    item_version: 2,
                },
            )
            .unwrap();
        Data {
            recipient,
            expected: SharedKeyExpectation {
                context,
                sender: s,
                recipient: r,
            },
            key,
            shared,
            bundle,
            item,
        }
    }
    fn rotation() -> RotationExpectation {
        RotationExpectation {
            operation_id: OP.to_owned(),
            password_box_id: box_id().parse().unwrap(),
            owner_account_id: OWNER.to_owned(),
            expected_state_revision: 10,
            expected_key_epoch: 1,
            expected_owner_bundle_version: 4,
            remove_account_id: REMOVED.to_owned(),
            item_count: Some(1),
            grant_count: Some(1),
        }
    }
    fn committed() -> Value {
        json!({"operationId":OP,"status":"committed","keyEpoch":2,"stateRevision":19,
            "ownerBundleVersion":5,"removedAccountId":REMOVED,"itemCount":1,"grantCount":1})
    }
    fn snapshot() -> SharingSnapshot {
        SharingSnapshot {
            state_revision: 10,
            key_epoch: 2,
            owner_account_id: OWNER.to_owned(),
            owner_bundle_version: 5,
            member_count: 2,
            live_item_count: 1,
            grant_count: 1,
            live_attachment_count: None,
            live_attachment_bytes: None,
        }
    }
    fn members() -> Value {
        json!({"stateRevision":10,"members":[
            {"accountId":OWNER,"role":"owner","membershipConfirmed":true,"keyGranted":false},
            {"accountId":RECIPIENT,"role":"readonly","membershipConfirmed":true,"keyGranted":true}],"nextCursor":null})
    }
    fn items() -> Value {
        json!({"stateRevision":10,"items":[{"itemId":item_id(),"itemVersion":2,"keyEpoch":2}],"nextCursor":null})
    }
    fn status(state: &str, result: Value) -> Value {
        json!({"operationId":OP,"status":state,"itemCount":1,"grantCount":1,"stagedBytes":0,
            "expiresAt":"2026-10-11T02:03:04.123456+00:00","result":result})
    }
    fn http(code: u16, body: &Value) -> Vec<u8> {
        let body = body.to_string();
        format!("HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
    }
    fn empty() -> Vec<u8> {
        b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
    }
    #[derive(Debug)]
    struct Seen {
        line: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }
    impl Seen {
        fn header(&self, key: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        }
        fn json(&self) -> Value {
            serde_json::from_slice(&self.body).unwrap()
        }
    }
    fn read_request(stream: &mut TcpStream, deadline: Instant) -> Option<Seen> {
        stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .ok()?;
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        let head = loop {
            if let Some(p) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                break p + 4;
            }
            if Instant::now() >= deadline || buffer.len() > 16384 {
                return None;
            }
            let n = stream.read(&mut chunk).ok()?;
            if n == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..n]);
        };
        let text = String::from_utf8(buffer[..head].to_vec()).ok()?;
        let mut lines = text.split("\r\n");
        let line = lines.next()?.to_owned();
        let headers: Vec<_> = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
            .collect();
        let length = headers
            .iter()
            .find(|(k, _)| k == "content-length")
            .map(|(_, v)| v.parse::<usize>())
            .transpose()
            .ok()?
            .unwrap_or(0);
        if length > 2 * 1024 * 1024 {
            return None;
        }
        while buffer.len() < head + length {
            if Instant::now() >= deadline {
                return None;
            }
            let n = stream.read(&mut chunk).ok()?;
            if n == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..n]);
        }
        Some(Seen {
            line,
            headers,
            body: buffer[head..head + length].to_vec(),
        })
    }
    /// Each fixture has a global deadline and per-stream deadlines. Drop wakes
    /// and joins its thread even when an assertion unwinds. Timing is never the
    /// assertion: captured requests prove both traffic and absence of retries.
    struct Fixture {
        addr: SocketAddr,
        stop: Arc<(Mutex<bool>, Condvar)>,
        worker: Option<JoinHandle<Vec<Seen>>>,
    }
    impl Fixture {
        fn start(responses: Vec<Vec<u8>>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let addr = listener.local_addr().unwrap();
            let stop = Arc::new((Mutex::new(false), Condvar::new()));
            let signal = stop.clone();
            let worker = thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(20);
                let mut seen = Vec::new();
                for response in responses {
                    let mut stream = loop {
                        let stopped = signal.0.lock().unwrap();
                        if *stopped || Instant::now() >= deadline {
                            return seen;
                        }
                        drop(stopped);
                        match listener.accept() {
                            Ok((stream, _)) => break stream,
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                let stopped = signal.0.lock().unwrap();
                                drop(
                                    signal
                                        .1
                                        .wait_timeout_while(
                                            stopped,
                                            Duration::from_millis(5),
                                            |stop| !*stop,
                                        )
                                        .unwrap(),
                                );
                            }
                            Err(_) => return seen,
                        }
                    };
                    stream.set_nonblocking(false).unwrap();
                    if let Some(request) = read_request(&mut stream, deadline) {
                        seen.push(request);
                    }
                    let _ = stream.write_all(&response);
                }
                seen
            });
            Self {
                addr,
                stop,
                worker: Some(worker),
            }
        }
        fn url(&self) -> String {
            format!("http://{}/prefix", self.addr)
        }
        fn client(&self) -> SharingRotationClient {
            SharingRotationClient::new(&EncryptedSessionClient::new(&self.url(), TOKEN).unwrap())
        }
        fn finish(mut self) -> Vec<Seen> {
            self.join()
        }
        fn join(&mut self) -> Vec<Seen> {
            *self.stop.0.lock().unwrap() = true;
            self.stop.1.notify_all();
            self.worker
                .take()
                .map(|w| w.join().unwrap())
                .unwrap_or_default()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.join();
        }
    }
    fn assert_api(error: Error, code: u16) {
        assert_eq!(error.status(), Some(code));
        let text = format!("{error} {error:?}");
        assert!(!text.contains(TOKEN));
    }

    #[tokio::test]
    async fn every_endpoint_sends_exact_public_json_selectors_and_session_auth() {
        let d = data(2);
        let r = rotation();
        let s = snapshot();
        let grant = InitialGrantRequest {
            expected_state_revision: 10,
            key_epoch: 2,
            expected_version: 0,
            envelope: d.shared.clone(),
        };
        let item = RotationItemRequest {
            expected_version: 1,
            envelope: d.item.clone(),
        };
        let sg = RotationGrantRequest {
            envelope: d.shared.clone(),
        };
        let summary = SharingItemSummary {
            item_id: item_id().parse().unwrap(),
            item_version: 2,
            key_epoch: 2,
        };
        let current_login_password = d.bundle.wrapped.nonce.clone();
        let server = Fixture::start(vec![
            http(
                200,
                &json!({"grantVersion":1,"keyEpoch":2,"stateRevision":12,"envelope":d.shared}),
            ),
            http(
                200,
                &json!({"grantVersion":1,"keyEpoch":2,"envelope":d.shared}),
            ),
            http(200, &json!(s)),
            http(200, &members()),
            http(200, &items()),
            http(200, &json!(d.item)),
            http(200, &json!({"operationId":OP,"status":"pending"})),
            http(
                200,
                &json!({"operationId":OP,"itemId":item_id(),"itemVersion":2,"keyEpoch":2}),
            ),
            http(
                200,
                &json!({"operationId":OP,"recipientAccountId":RECIPIENT,"keyEpoch":2}),
            ),
            http(200, &committed()),
            http(200, &status("committed", committed())),
            empty(),
        ]);
        let c = server.client();
        c.put_initial_grant(&box_id(), RECIPIENT, &grant, &d.expected)
            .await
            .unwrap();
        let got = c.get_self_grant(&box_id(), &d.expected).await.unwrap();
        // Actual Core HPKE positive control, including decrypting a real item.
        let unwrapped = PasswordBoxKey::unwrap_for_recipient(
            &got.envelope,
            &d.recipient,
            &d.expected.sender,
            &d.expected.context,
        )
        .unwrap();
        let plain = unwrapped.decrypt_item(&d.item, &d.item.context).unwrap();
        assert_eq!(plain, d.key.decrypt_item(&d.item, &d.item.context).unwrap());
        c.sharing_snapshot(&box_id(), OWNER).await.unwrap();
        c.snapshot_members(&box_id(), &s, None).await.unwrap();
        c.snapshot_items(&box_id(), &s, None).await.unwrap();
        c.snapshot_item(&box_id(), &s, &summary).await.unwrap();
        c.start_rotation(&r, &d.bundle).await.unwrap();
        c.stage_item(&r, &item).await.unwrap();
        c.stage_grant(&r, &sg, &d.expected).await.unwrap();
        c.commit_rotation(&r, &current_login_password)
            .await
            .unwrap();
        c.rotation_status(&r).await.unwrap();
        c.abort_rotation(&r).await.unwrap();
        let seen = server.finish();
        let b = format!("/prefix/api/encrypted/boxes/{}", box_id());
        let expected = [
            format!("PUT {b}/grants/{RECIPIENT}"),
            format!("GET {b}/grants/me"),
            format!("GET {b}/sharing-snapshot"),
            format!("GET {b}/sharing-snapshot/members?revision=10"),
            format!("GET {b}/sharing-snapshot/items?revision=10"),
            format!("GET {b}/sharing-snapshot/items/{}?revision=10", item_id()),
            format!("PUT {b}/rotations/{OP}"),
            format!("PUT {b}/rotations/{OP}/items/{}", item_id()),
            format!("PUT {b}/rotations/{OP}/grants/{RECIPIENT}"),
            format!("POST {b}/rotations/{OP}/commit"),
            format!("GET {b}/rotations/{OP}"),
            format!("DELETE {b}/rotations/{OP}"),
        ];
        assert_eq!(seen.len(), expected.len());
        for (request, path) in seen.iter().zip(expected) {
            assert_eq!(request.line, format!("{path} HTTP/1.1"));
            assert_eq!(
                request.header("authorization"),
                Some(format!("Bearer {TOKEN}").as_str())
            );
            assert_eq!(request.header("accept"), Some("application/json"));
            assert_eq!(request.header("cookie"), None);
        }
        assert_eq!(seen[0].json(), json!(grant));
        assert_eq!(
            seen[6].json(),
            json!({"expectedStateRevision":10,"expectedKeyEpoch":1,
            "expectedOwnerBundleVersion":4,"removeAccountId":REMOVED,"bundle":d.bundle})
        );
        assert_eq!(seen[7].json(), json!(item));
        assert_eq!(seen[8].json(), json!(sg));
        assert_eq!(
            seen[9].json(),
            json!({"currentPassword":current_login_password})
        );
        for i in [1, 2, 3, 4, 5, 10, 11] {
            assert!(seen[i].body.is_empty());
        }
        for i in [0, 6, 7, 8, 9] {
            assert_eq!(seen[i].header("content-type"), Some("application/json"));
        }
        assert_eq!(seen[11].header("connection"), Some("close"));
    }

    #[tokio::test]
    async fn invalid_arguments_are_isolated_between_real_positive_requests() {
        let d = data(2);
        let grant = InitialGrantRequest {
            expected_state_revision: 10,
            key_epoch: 2,
            expected_version: 0,
            envelope: d.shared.clone(),
        };
        let reply = http(
            200,
            &json!({"grantVersion":1,"keyEpoch":2,"stateRevision":12,"envelope":d.shared}),
        );
        let server = Fixture::start(vec![reply.clone(), reply]);
        let c = server.client();
        c.put_initial_grant(&box_id(), RECIPIENT, &grant, &d.expected)
            .await
            .unwrap();
        let mut bad_inputs = Vec::new();
        for field in [
            "version",
            "revision",
            "epoch",
            "format",
            "suite",
            "enc-high",
            "enc-p",
            "enc-unpadded",
            "cipher-short",
            "key-id",
            "swapped",
        ] {
            let mut g = grant.clone();
            match field {
                "version" => g.expected_version = 1,
                "revision" => g.expected_state_revision = MAX_INTEGER + 1,
                "epoch" => g.key_epoch = 1,
                "format" => g.envelope.format = 2,
                "suite" => g.envelope.suite = "hpke-base/0x0020/0x0001/0x0003".into(),
                "enc-high" => {
                    let mut p = STANDARD.decode(&g.envelope.enc).unwrap();
                    p[31] |= 0x80;
                    g.envelope.enc = STANDARD.encode(p);
                }
                "enc-p" => {
                    let mut p = [0xff; 32];
                    p[0] = 0xed;
                    p[31] = 0x7f;
                    g.envelope.enc = STANDARD.encode(p);
                }
                "enc-unpadded" => g.envelope.enc.pop().map(|_| ()).unwrap(),
                "cipher-short" => g.envelope.ciphertext = STANDARD.encode([0u8; 47]),
                "key-id" => g.envelope.context.sender_key_id = "g".repeat(64),
                "swapped" => g.envelope.context.recipient_account_id = REMOVED.parse().unwrap(),
                _ => unreachable!(),
            }
            bad_inputs.push(g);
        }
        for g in bad_inputs {
            assert!(matches!(
                c.put_initial_grant(&box_id(), RECIPIENT, &g, &d.expected)
                    .await,
                Err(Error::InvalidArgument(_))
            ));
        }
        let mut wrong_pin = d.expected.clone();
        wrong_pin.sender.key_id = "0".repeat(64);
        assert!(c.get_self_grant(&box_id(), &wrong_pin).await.is_err());
        let mut wrong_context = d.expected.clone();
        wrong_context.context.recipient_key_id = "0".repeat(64);
        assert!(c.get_self_grant(&box_id(), &wrong_context).await.is_err());
        let other_identity = AccountIdentity::generate(AccountIdentityContext {
            account_id: OWNER.parse().unwrap(),
            identity_version: 1,
        })
        .unwrap()
        .public_identity();
        assert!(other_identity.validate_public().is_ok());
        let mut substituted_descriptor = d.expected.clone();
        substituted_descriptor.sender = other_identity;
        assert!(c
            .get_self_grant(&box_id(), &substituted_descriptor)
            .await
            .is_err());
        for recipient in [
            RECIPIENT.replace('-', ""),
            "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB".into(),
            "00000000-0000-0000-0000-000000000000".into(),
            "../recipient".into(),
        ] {
            assert!(c
                .put_initial_grant(&box_id(), &recipient, &grant, &d.expected)
                .await
                .is_err());
        }
        let mut r = rotation();
        for field in [
            "operation",
            "removed",
            "epoch",
            "bundle",
            "revision",
            "count",
        ] {
            let mut bad = r.clone();
            match field {
                "operation" => bad.operation_id = OP.to_uppercase(),
                "removed" => bad.remove_account_id = OWNER.into(),
                "epoch" => bad.expected_key_epoch = MAX_INTEGER,
                "bundle" => bad.expected_owner_bundle_version = MAX_INTEGER,
                "revision" => bad.expected_state_revision = 0,
                "count" => bad.item_count = Some(MAX_INTEGER + 1),
                _ => unreachable!(),
            }
            assert!(c.start_rotation(&bad, &d.bundle).await.is_err());
        }
        let mut bad_bundle = d.bundle.clone();
        bad_bundle.wrapped.context.key_epoch = 1;
        assert!(c.start_rotation(&r, &bad_bundle).await.is_err());
        r.expected_key_epoch = MAX_INTEGER;
        assert!(c
            .stage_item(
                &r,
                &RotationItemRequest {
                    expected_version: 1,
                    envelope: d.item.clone()
                }
            )
            .await
            .is_err());
        for version in [0, MAX_INTEGER, MAX_INTEGER + 1] {
            assert!(c
                .stage_item(
                    &rotation(),
                    &RotationItemRequest {
                        expected_version: version,
                        envelope: d.item.clone()
                    }
                )
                .await
                .is_err());
        }
        assert!(c
            .stage_grant(
                &rotation(),
                &RotationGrantRequest {
                    envelope: d.shared.clone()
                },
                &wrong_context
            )
            .await
            .is_err());
        assert!(c
            .snapshot_items(&box_id(), &snapshot(), Some("../item"))
            .await
            .is_err());
        assert!(c
            .snapshot_members(&box_id(), &snapshot(), Some(OP.to_uppercase().as_str()))
            .await
            .is_err());
        assert!(c.commit_rotation(&rotation(), "").await.is_err());
        c.put_initial_grant(&box_id(), RECIPIENT, &grant, &d.expected)
            .await
            .unwrap();
        assert_eq!(
            server.finish().len(),
            2,
            "all rejected inputs must avoid HTTP between valid controls"
        );
    }

    #[tokio::test]
    async fn shared_reply_mutations_each_keep_other_fields_valid() {
        let d = data(2);
        let valid = json!({"grantVersion":1,"keyEpoch":2,"envelope":d.shared});
        let mut cases = Vec::new();
        for (path, value) in [
            ("/grantVersion", json!(0)),
            ("/grantVersion", json!(MAX_INTEGER + 1)),
            ("/grantVersion", json!(2)),
            ("/keyEpoch", json!("2")),
            ("/keyEpoch", Value::Null),
            ("/keyEpoch", json!(1)),
            ("/envelope/format", json!(2)),
            ("/envelope/suite", json!("base")),
            ("/envelope/enc", json!(STANDARD.encode([0xff; 32]))),
            ("/envelope/ciphertext", json!(STANDARD.encode([0u8; 49]))),
            ("/envelope/context/recipientAccountId", json!(REMOVED)),
            (
                "/envelope/context/senderAccountId",
                json!(OWNER.replace('-', "")),
            ),
            ("/envelope/context/senderKeyId", json!("G".repeat(64))),
            ("/envelope/context/keyEpoch", json!(MAX_INTEGER + 1)),
            ("/envelope/context/senderIdentityVersion", json!(0)),
        ] {
            let mut v = valid.clone();
            *v.pointer_mut(path).unwrap() = value;
            cases.push(v);
        }
        for path in ["/envelope", "/envelope/context", ""] {
            let mut v = valid.clone();
            v.pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unexpected".into(), json!(true));
            cases.push(v);
        }
        let mut enc = STANDARD.decode(&d.shared.enc).unwrap();
        enc[31] = 0x80;
        let mut v = valid.clone();
        v["envelope"]["enc"] = json!(STANDARD.encode(enc));
        cases.push(v);
        let mut noncanonical = d.shared.enc.clone();
        noncanonical.pop();
        let mut v = valid.clone();
        v["envelope"]["enc"] = json!(noncanonical);
        cases.push(v);
        let mut v = valid.clone();
        v["envelope"]["ciphertext"] = json!("A".repeat(1_398_125));
        cases.push(v);
        let server = Fixture::start(
            std::iter::once(http(200, &valid))
                .chain(cases.iter().map(|v| http(200, v)))
                .chain(std::iter::once(http(200, &valid)))
                .collect(),
        );
        let c = server.client();
        c.get_self_grant(&box_id(), &d.expected).await.unwrap();
        for _ in &cases {
            assert!(c.get_self_grant(&box_id(), &d.expected).await.is_err());
        }
        c.get_self_grant(&box_id(), &d.expected).await.unwrap();
        assert_eq!(server.finish().len(), cases.len() + 2);
        let mut wrong = d.expected.clone();
        wrong.context.key_epoch = 3;
        let server = Fixture::start(vec![http(200, &valid)]);
        assert_eq!(
            server
                .client()
                .get_self_grant(&box_id(), &wrong)
                .await
                .unwrap_err(),
            Error::ContextMismatch
        );
        assert_eq!(server.finish().len(), 1);
    }

    #[tokio::test]
    async fn initial_grant_echo_and_revision_are_checked_but_replay_revision_can_advance() {
        let d = data(2);
        let request = InitialGrantRequest {
            expected_state_revision: 10,
            key_epoch: 2,
            expected_version: 0,
            envelope: d.shared.clone(),
        };
        let valid = json!({"grantVersion":1,"keyEpoch":2,"stateRevision":10,"envelope":d.shared});
        let mut low = valid.clone();
        low["stateRevision"] = json!(9);
        let mut altered = valid.clone();
        altered["envelope"]["ciphertext"] = json!(STANDARD.encode([7u8; 48]));
        let mut version = valid.clone();
        version["grantVersion"] = json!(2);
        let mut later = valid.clone();
        later["stateRevision"] = json!(1000);
        let server = Fixture::start(vec![
            http(200, &valid),
            http(200, &low),
            http(200, &altered),
            http(200, &version),
            http(200, &later),
        ]);
        let c = server.client();
        c.put_initial_grant(&box_id(), RECIPIENT, &request, &d.expected)
            .await
            .unwrap();
        for _ in 0..3 {
            assert!(c
                .put_initial_grant(&box_id(), RECIPIENT, &request, &d.expected)
                .await
                .is_err());
        }
        assert_eq!(
            c.put_initial_grant(&box_id(), RECIPIENT, &request, &d.expected)
                .await
                .unwrap()
                .state_revision,
            1000
        );
        assert_eq!(server.finish().len(), 5);
    }

    #[tokio::test]
    async fn snapshot_pages_require_revision_sorted_ids_and_mandatory_correct_cursors() {
        let s = snapshot();
        let valid = items();
        let mut cases = Vec::new();
        for (path, value) in [
            ("/stateRevision", json!(11)),
            ("/stateRevision", json!(0)),
            ("/stateRevision", json!(MAX_INTEGER + 1)),
            ("/stateRevision", json!(10.5)),
            ("/stateRevision", Value::Null),
            ("/items/0/itemVersion", json!(0)),
            ("/items/0/keyEpoch", json!(1)),
            ("/nextCursor", json!(item_id())),
        ] {
            let mut v = valid.clone();
            *v.pointer_mut(path).unwrap() = value;
            cases.push(v);
        }
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove("nextCursor");
        cases.push(missing);
        let mut unknown = valid.clone();
        unknown["items"][0]["extra"] = json!(true);
        cases.push(unknown);
        let mut too_many = valid.clone();
        too_many["items"] = json!(vec![valid["items"][0].clone(); 101]);
        cases.push(too_many);
        let mut empty_page = valid.clone();
        empty_page["items"] = json!([]);
        cases.push(empty_page);
        let server = Fixture::start(
            std::iter::once(http(200, &valid))
                .chain(cases.iter().map(|v| http(200, v)))
                .chain(std::iter::once(http(200, &valid)))
                .collect(),
        );
        let c = server.client();
        c.snapshot_items(&box_id(), &s, None).await.unwrap();
        for _ in &cases {
            assert!(c.snapshot_items(&box_id(), &s, None).await.is_err());
        }
        c.snapshot_items(&box_id(), &s, None).await.unwrap();
        assert_eq!(server.finish().len(), cases.len() + 2);

        let rows: Vec<_> = (1..=100)
            .map(|n| json!({"itemId":format!("{n:026}"),"itemVersion":1,"keyEpoch":2}))
            .collect();
        let full = json!({"stateRevision":10,"items":rows,"nextCursor":format!("{:026}",100)});
        let mut big = s.clone();
        big.live_item_count = 200;
        let mut bad = Vec::new();
        let mut v = full.clone();
        v["nextCursor"] = Value::Null;
        bad.push(v);
        let mut v = full.clone();
        v["nextCursor"] = v["items"][50]["itemId"].clone();
        bad.push(v);
        let mut v = full.clone();
        v["items"].as_array_mut().unwrap().swap(0, 1);
        bad.push(v);
        let mut v = full.clone();
        v["items"][1] = v["items"][0].clone();
        bad.push(v);
        let server = Fixture::start(
            bad.iter()
                .map(|v| http(200, v))
                .chain(std::iter::once(http(200, &full)))
                .chain(std::iter::once(http(200, &full)))
                .collect(),
        );
        let c = server.client();
        for _ in &bad {
            assert!(c.snapshot_items(&box_id(), &big, None).await.is_err());
        }
        c.snapshot_items(&box_id(), &big, None).await.unwrap();
        assert!(c
            .snapshot_items(&box_id(), &big, Some(&format!("{:026}", 1)))
            .await
            .is_err());
        let seen = server.finish();
        assert_eq!(seen.len(), bad.len() + 2);
        assert!(seen
            .last()
            .unwrap()
            .line
            .ends_with(&format!("?revision=10&after={:026} HTTP/1.1", 1)));
    }

    #[tokio::test]
    async fn snapshot_member_header_and_single_item_validation() {
        let d = data(2);
        let s = snapshot();
        let mut headers = Vec::new();
        for (key, value) in [
            ("ownerBundleVersion", json!(0)),
            ("ownerAccountId", json!(REMOVED)),
            ("grantCount", json!(2)),
            ("memberCount", json!(0)),
            ("liveItemCount", json!(-1)),
            ("keyEpoch", json!("2")),
        ] {
            let mut v = json!(s);
            v[key] = value;
            headers.push(v);
        }
        let server = Fixture::start(
            headers
                .iter()
                .map(|v| http(200, v))
                .chain(std::iter::once(http(200, &json!(s))))
                .collect(),
        );
        let c = server.client();
        for _ in &headers {
            assert!(c.sharing_snapshot(&box_id(), OWNER).await.is_err());
        }
        c.sharing_snapshot(&box_id(), OWNER).await.unwrap();
        assert_eq!(server.finish().len(), headers.len() + 1);
        let valid = members();
        let mut pages = Vec::new();
        for (path, value) in [
            ("/members/1/membershipConfirmed", json!(false)),
            ("/members/1/role", json!("owner")),
            ("/members/0/keyGranted", json!(true)),
            ("/members/0/role", json!("member")),
            ("/members/1/accountId", json!(OWNER)),
            ("/members/1/keyGranted", Value::Null),
            ("/members/1/role", json!("unknown")),
            ("/stateRevision", json!(11)),
            ("/nextCursor", json!(OP)),
        ] {
            let mut v = valid.clone();
            *v.pointer_mut(path).unwrap() = value;
            pages.push(v);
        }
        let mut v = valid.clone();
        v["members"].as_array_mut().unwrap().swap(0, 1);
        pages.push(v);
        let mut v = valid.clone();
        v.as_object_mut().unwrap().remove("nextCursor");
        pages.push(v);
        let server = Fixture::start(
            pages
                .iter()
                .map(|v| http(200, v))
                .chain(std::iter::once(http(200, &valid)))
                .collect(),
        );
        let c = server.client();
        for _ in &pages {
            assert!(c.snapshot_members(&box_id(), &s, None).await.is_err());
        }
        c.snapshot_members(&box_id(), &s, None).await.unwrap();
        assert_eq!(server.finish().len(), pages.len() + 1);
        let summary = SharingItemSummary {
            item_id: item_id().parse().unwrap(),
            item_version: 2,
            key_epoch: 2,
        };
        let mut altered = Vec::new();
        let v = json!(d.item);
        for (path, value) in [
            ("/context/itemVersion", json!(1)),
            ("/context/keyEpoch", json!(1)),
            ("/context/passwordBoxId", json!("c".repeat(26))),
            ("/nonce", json!(STANDARD.encode([0u8; 23]))),
            ("/ciphertext", json!(STANDARD.encode([0u8; 15]))),
        ] {
            let mut bad = v.clone();
            *bad.pointer_mut(path).unwrap() = value;
            altered.push(bad);
        }
        let server = Fixture::start(
            altered
                .iter()
                .map(|v| http(200, v))
                .chain(std::iter::once(http(200, &v)))
                .collect(),
        );
        let c = server.client();
        for _ in &altered {
            assert!(c.snapshot_item(&box_id(), &s, &summary).await.is_err());
        }
        c.snapshot_item(&box_id(), &s, &summary).await.unwrap();
        assert_eq!(server.finish().len(), altered.len() + 1);
    }

    #[tokio::test]
    async fn historical_start_commit_and_status_replays_use_the_original_expectation() {
        let d = data(2);
        let r = rotation();
        let replay = json!({"operationId":OP,"status":"committed","result":committed()});
        let server = Fixture::start(vec![
            http(200, &replay),
            http(200, &committed()),
            http(200, &status("committed", committed())),
        ]);
        let c = server.client();
        assert!(matches!(
            c.start_rotation(&r, &d.bundle).await.unwrap(),
            RotationStartReply::Committed { .. }
        ));
        assert_eq!(
            c.commit_rotation(&r, &d.bundle.wrapped.nonce)
                .await
                .unwrap()
                .state_revision,
            19
        );
        assert_eq!(
            c.rotation_status(&r)
                .await
                .unwrap()
                .result
                .unwrap()
                .key_epoch,
            2
        );
        assert_eq!(server.finish().len(), 3);
        let mut bad_results = Vec::new();
        for (key, value) in [
            ("operationId", json!(RECIPIENT)),
            ("keyEpoch", json!(3)),
            ("ownerBundleVersion", json!(6)),
            ("removedAccountId", json!(RECIPIENT)),
            ("itemCount", json!(0)),
            ("grantCount", json!(0)),
            ("stateRevision", json!(10)),
            ("stateRevision", json!(MAX_INTEGER + 1)),
            ("status", json!("pending")),
        ] {
            let mut v = committed();
            v[key] = value;
            bad_results.push(v);
        }
        let server = Fixture::start(
            bad_results
                .iter()
                .map(|v| http(200, v))
                .chain(std::iter::once(http(200, &committed())))
                .collect(),
        );
        let c = server.client();
        for _ in &bad_results {
            assert!(c
                .commit_rotation(&r, &d.bundle.wrapped.nonce)
                .await
                .is_err());
        }
        c.commit_rotation(&r, &d.bundle.wrapped.nonce)
            .await
            .unwrap();
        assert_eq!(server.finish().len(), bad_results.len() + 1);
        let mut cases = vec![
            status("pending", committed()),
            status("committed", Value::Null),
            status("expired", committed()),
        ];
        for (key, value) in [
            ("operationId", json!(RECIPIENT)),
            ("stagedBytes", json!(1)),
            ("itemCount", json!(2)),
            ("expiresAt", json!("2026-02-30T02:03:04+00:00")),
            ("expiresAt", Value::Null),
        ] {
            let mut v = status("committed", committed());
            v[key] = value;
            cases.push(v);
        }
        let mut v = status("committed", committed());
        v["result"]["operationId"] = json!(RECIPIENT);
        cases.push(v);
        let mut v = status("pending", Value::Null);
        v.as_object_mut().unwrap().remove("result");
        cases.push(v);
        let server = Fixture::start(
            cases
                .iter()
                .map(|v| http(200, v))
                .chain([
                    http(200, &status("pending", Value::Null)),
                    http(200, &status("expired", Value::Null)),
                    http(200, &status("committed", committed())),
                ])
                .collect(),
        );
        let c = server.client();
        for _ in &cases {
            assert!(c.rotation_status(&r).await.is_err());
        }
        for _ in 0..3 {
            c.rotation_status(&r).await.unwrap();
        }
        assert_eq!(server.finish().len(), cases.len() + 3);
    }

    #[tokio::test]
    async fn start_reply_and_member_pagination_are_strict_and_bind_queries() {
        let d = data(2);
        let r = rotation();
        let pending = json!({"operationId":OP,"status":"pending"});
        let invalid = [
            json!({"operationId":RECIPIENT,"status":"pending"}),
            json!({"operationId":OP,"status":"expired"}),
            json!({"operationId":OP,"status":"pending","result":null}),
            json!({"operationId":OP,"status":"committed","result":null}),
            json!({"operationId":OP,"status":"committed","result":{
                "operationId":RECIPIENT,"status":"committed","keyEpoch":2,"stateRevision":19,
                "ownerBundleVersion":5,"removedAccountId":REMOVED,"itemCount":1,"grantCount":1}}),
        ];
        let server = Fixture::start(
            std::iter::once(http(200, &pending))
                .chain(invalid.iter().map(|v| http(200, v)))
                .chain(std::iter::once(http(200, &pending)))
                .collect(),
        );
        let c = server.client();
        c.start_rotation(&r, &d.bundle).await.unwrap();
        for _ in &invalid {
            assert!(c.start_rotation(&r, &d.bundle).await.is_err());
        }
        c.start_rotation(&r, &d.bundle).await.unwrap();
        assert_eq!(server.finish().len(), invalid.len() + 2);

        let account = |n| format!("00000000-0000-4000-8000-{n:012}");
        let mut s = snapshot();
        s.owner_account_id = account(1);
        s.member_count = 101;
        s.grant_count = 0;
        let rows: Vec<_> = (1..=100)
            .map(|n| {
                json!({"accountId":account(n),
            "role":if n == 1 { "owner" } else { "member" },
            "membershipConfirmed":true,"keyGranted":false})
            })
            .collect();
        let full = json!({"stateRevision":10,"members":rows,"nextCursor":account(100)});
        let tail = json!({"stateRevision":10,"members":[{"accountId":account(101),
            "role":"readonly","membershipConfirmed":false,"keyGranted":false}],"nextCursor":null});
        let mut bad_cursor = full.clone();
        bad_cursor["nextCursor"] = json!(account(99));
        let mut null_cursor = full.clone();
        null_cursor["nextCursor"] = Value::Null;
        let server = Fixture::start(vec![
            http(200, &bad_cursor),
            http(200, &null_cursor),
            http(200, &full),
            http(200, &tail),
        ]);
        let c = server.client();
        assert!(c.snapshot_members(&box_id(), &s, None).await.is_err());
        assert!(c.snapshot_members(&box_id(), &s, None).await.is_err());
        let first = c.snapshot_members(&box_id(), &s, None).await.unwrap();
        let last = c
            .snapshot_members(&box_id(), &s, first.next_cursor.as_deref())
            .await
            .unwrap();
        let mut complete = first.members;
        complete.extend(last.members);
        s.validate_complete_members(&complete).unwrap();
        assert!(s.validate_complete_members(&complete[..100]).is_err());
        complete[100] = complete[99].clone();
        assert!(s.validate_complete_members(&complete).is_err());
        let seen = server.finish();
        assert_eq!(seen.len(), 4);
        assert!(seen[3]
            .line
            .ends_with(&format!("?revision=10&after={} HTTP/1.1", account(100))));
        let page: SharingItemsPage = serde_json::from_value(items()).unwrap();
        snapshot().validate_complete_items(&page.items).unwrap();
        assert!(snapshot().validate_complete_items(&[]).is_err());
    }

    #[tokio::test]
    async fn stage_replies_must_match_operation_target_version_and_epoch() {
        let d = data(2);
        let r = rotation();
        let item = RotationItemRequest {
            expected_version: 1,
            envelope: d.item.clone(),
        };
        let valid = json!({"operationId":OP,"itemId":item_id(),"itemVersion":2,"keyEpoch":2});
        let mut replies = Vec::new();
        for (key, value) in [
            ("operationId", json!(RECIPIENT)),
            ("itemId", json!("j".repeat(26))),
            ("itemVersion", json!(1)),
            ("keyEpoch", json!(1)),
            ("itemVersion", Value::Null),
        ] {
            let mut v = valid.clone();
            v[key] = value;
            replies.push(v);
        }
        let server = Fixture::start(
            replies
                .iter()
                .map(|v| http(200, v))
                .chain(std::iter::once(http(200, &valid)))
                .collect(),
        );
        let c = server.client();
        for _ in &replies {
            assert!(c.stage_item(&r, &item).await.is_err());
        }
        c.stage_item(&r, &item).await.unwrap();
        assert_eq!(server.finish().len(), replies.len() + 1);
        let request = RotationGrantRequest {
            envelope: d.shared.clone(),
        };
        let valid = json!({"operationId":OP,"recipientAccountId":RECIPIENT,"keyEpoch":2});
        let mut replies = Vec::new();
        for (key, value) in [
            ("operationId", json!(RECIPIENT)),
            ("recipientAccountId", json!(REMOVED)),
            ("keyEpoch", json!(1)),
        ] {
            let mut v = valid.clone();
            v[key] = value;
            replies.push(v);
        }
        let server = Fixture::start(
            replies
                .iter()
                .map(|v| http(200, v))
                .chain(std::iter::once(http(200, &valid)))
                .collect(),
        );
        let c = server.client();
        for _ in &replies {
            assert!(c.stage_grant(&r, &request, &d.expected).await.is_err());
        }
        c.stage_grant(&r, &request, &d.expected).await.unwrap();
        assert_eq!(server.finish().len(), replies.len() + 1);
    }

    #[tokio::test]
    async fn errors_are_bounded_redacted_without_retries_or_redirect_token_forwarding() {
        let d = data(2);
        let r = rotation();
        let current_login_password = d.bundle.wrapped.nonce.clone();
        for status_code in [401, 403, 409] {
            let server = Fixture::start(vec![
                http(
                    status_code,
                    &json!({"error":"PS015","message":current_login_password,
                "token":TOKEN,"secretKey":"synthetic-body-secret"}),
                ),
                http(200, &committed()),
            ]);
            let err = server
                .client()
                .commit_rotation(&r, &current_login_password)
                .await
                .unwrap_err();
            let text = format!("{err} {err:?}");
            assert!(!text.contains(&current_login_password));
            assert!(!text.contains("synthetic-body-secret"));
            assert_api(err, status_code);
            assert_eq!(server.finish().len(), 1);
        }
        let server = Fixture::start(vec![format!(
            "HTTP/1.1 503 Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\nx",
            16 * 1024 + 1
        )
        .into_bytes()]);
        let err = server
            .client()
            .commit_rotation(&r, &current_login_password)
            .await
            .unwrap_err();
        assert_eq!(err.code(), None);
        assert_api(err, 503);
        assert_eq!(server.finish().len(), 1);
        let mut streamed = b"HTTP/1.1 409 Error\r\nConnection: close\r\n\r\n".to_vec();
        let repeated_secret = current_login_password.repeat(600);
        assert!(repeated_secret.len() > 16 * 1024);
        streamed.extend_from_slice(repeated_secret.as_bytes());
        let server = Fixture::start(vec![streamed, http(200, &committed())]);
        let err = server
            .client()
            .commit_rotation(&r, &current_login_password)
            .await
            .unwrap_err();
        assert_eq!(err.code(), None);
        assert!(!format!("{err} {err:?}").contains(&current_login_password));
        assert_api(err, 409);
        assert_eq!(server.finish().len(), 1);
        let target = Fixture::start(vec![http(200, &committed())]);
        let origin=Fixture::start(vec![format!("HTTP/1.1 307 Redirect\r\nLocation: {}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",target.url()).into_bytes()]);
        assert_api(
            origin
                .client()
                .commit_rotation(&r, &current_login_password)
                .await
                .unwrap_err(),
            307,
        );
        assert_eq!(origin.finish().len(), 1);
        assert!(target.finish().is_empty());
        let server = Fixture::start(vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\nx",
            1_398_124 + 4096 + 1
        )
        .into_bytes()]);
        assert_eq!(
            server.client().rotation_status(&r).await.unwrap_err(),
            Error::ResponseTooLarge
        );
        assert_eq!(server.finish().len(), 1);
        let proof = RotationCommitRequest {
            current_password: current_login_password.clone(),
        };
        assert!(!format!("{proof:?}").contains(&current_login_password));
    }

    #[tokio::test]
    async fn abort_reuses_empty_204_framing_validation_and_no_body() {
        for reply in [http(204,&json!({"unexpected":true})),
            b"HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\nx\r\n0\r\n\r\n".to_vec(),
            http(200,&json!({})),http(201,&json!({})),http(205,&json!({}))] {
            let server=Fixture::start(vec![reply]);assert!(server.client().abort_rotation(&rotation()).await.is_err());
            assert_eq!(server.finish().len(),1);
        }
        let server = Fixture::start(vec![empty()]);
        server.client().abort_rotation(&rotation()).await.unwrap();
        let seen = server.finish();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].body.is_empty());
        assert_eq!(seen[0].header("connection"), Some("close"));
    }

    #[test]
    fn strict_public_dtos_reject_null_missing_unknown_duplicates_and_unsafe_numbers() {
        let d = data(2);
        let v = json!({"expectedStateRevision":10,"keyEpoch":2,"expectedVersion":0,"envelope":d.shared});
        assert!(serde_json::from_value::<InitialGrantRequest>(v.clone()).is_ok());
        for (path, value) in [
            ("/expectedVersion", json!(1)),
            ("/expectedStateRevision", json!(MAX_INTEGER + 1)),
            ("/keyEpoch", Value::Null),
            ("/envelope/context/recipientIdentityVersion", Value::Null),
        ] {
            let mut bad = v.clone();
            *bad.pointer_mut(path).unwrap() = value;
            assert!(serde_json::from_value::<InitialGrantRequest>(bad).is_err());
        }
        let mut bad = v.clone();
        bad["envelope"]["context"]["unexpected"] = json!(true);
        assert!(serde_json::from_value::<InitialGrantRequest>(bad).is_err());
        let snapshot_json = serde_json::to_string(&snapshot()).unwrap();
        let duplicate = format!(
            "{},\"stateRevision\":10}}",
            &snapshot_json[..snapshot_json.len() - 1]
        );
        assert!(decode::<SharingSnapshot>(duplicate.as_bytes()).is_err());
        let bytes = format!(
            "{{\"grantVersion\":1,\"keyEpoch\":2,\"envelope\":{},\"keyEpoch\":2}}",
            json!(d.shared)
        );
        assert!(decode::<SelfGrantReply>(bytes.as_bytes()).is_err());
        assert!(
            decode::<RotationCommitRequest>(b"{\"encryptionPassword\":\"synthetic\"}").is_err()
        );
        assert!(decode::<RotationStartReply>(
            format!("{{\"operationId\":\"{OP}\",\"status\":\"pending\",\"result\":null}}")
                .as_bytes()
        )
        .is_err());
        for after in [Some(RECIPIENT), Some(OWNER)] {
            assert!(page([OWNER].into_iter(), after, None).is_err());
        }
        assert!(timestamp("2026-10-11T02:03:04+00:00"));
        assert!(!timestamp("2026-10-11T25:03:04+00:00"));
    }
}
