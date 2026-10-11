//! Opaque attachment HTTP transport. Core DTO validation is structural, not authentication.
use crate::encrypted_client::{decode, envelope_problem};
use crate::{
    AttachmentContext, EncryptedAttachment, EncryptedItem, EncryptedSessionClient,
    EncryptedSessionError as Error, EncryptedSessionResult as Result, ItemContext,
};
use reqwest::Method;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;

const MAX_SAFE: u64 = 9_007_199_254_740_991;
/// Public CAS selector only. This does not authenticate or replace a key pin.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentState {
    #[serde(deserialize_with = "positive")]
    pub state_revision: u64,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
}

fn read_id(id: &str) -> Result<()> {
    passshare_core::ConnectId::validate(id).map_err(|_| Error::InvalidArgument("invalid id"))
}
fn read_integer(n: u64) -> Result<()> {
    if (1..=MAX_SAFE).contains(&n) {
        Ok(())
    } else {
        Err(Error::InvalidArgument("invalid attachment read integer"))
    }
}
pub(crate) fn positive<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    let n = u64::deserialize(d)?;
    if (1..=MAX_SAFE).contains(&n) {
        Ok(n)
    } else {
        Err(serde::de::Error::custom("unsafe integer"))
    }
}
pub(crate) fn expected(context: &AttachmentContext) -> Result<()> {
    context
        .validate_public()
        .map_err(|_| Error::InvalidArgument("invalid attachment context"))
}
pub(crate) fn envelope(envelope: &EncryptedAttachment, context: &AttachmentContext) -> Result<()> {
    expected(context)?;
    envelope
        .validate_public()
        .map_err(|_| Error::InvalidArgument("invalid attachment envelope"))?;
    if envelope.context != *context {
        return Err(Error::ContextMismatch);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentItemWrite {
    #[serde(deserialize_with = "positive")]
    pub expected_version: u64,
    pub envelope: EncryptedItem,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentPutReply {
    #[serde(deserialize_with = "positive")]
    pub state_revision: u64,
    #[serde(deserialize_with = "positive")]
    pub item_version: u64,
    #[serde(deserialize_with = "positive")]
    pub attachment_version: u64,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentDeleteReply {
    #[serde(deserialize_with = "positive")]
    pub state_revision: u64,
    #[serde(deserialize_with = "positive")]
    pub item_version: u64,
    pub deleted: bool,
    #[serde(deserialize_with = "positive")]
    pub key_epoch: u64,
}
fn revision(n: u64) -> Result<()> {
    if (1..MAX_SAFE).contains(&n) {
        Ok(())
    } else {
        Err(Error::InvalidArgument("invalid state revision"))
    }
}
fn mutation_revision(n: u64) -> Result<()> {
    if (1..=MAX_SAFE - 2).contains(&n) {
        Ok(())
    } else {
        Err(Error::InvalidArgument("invalid attachment state revision"))
    }
}
fn item_write(item: &AttachmentItemWrite, context: &AttachmentContext) -> Result<()> {
    revision(item.expected_version)?;
    if envelope_problem(
        &item.envelope,
        context.password_box_id.as_str(),
        context.item_id.as_str(),
    )
    .is_some()
        || item.envelope.context.item_version != item.expected_version + 1
        || item.envelope.context.key_epoch != context.key_epoch
    {
        return Err(Error::InvalidArgument("invalid attachment item write"));
    }
    Ok(())
}
impl EncryptedSessionClient {
    /// Read the recipient-visible selector using an independently held key epoch.
    /// The reply is a CAS input, never a source for the expected epoch or key pin.
    pub async fn get_attachment_state(
        &self,
        box_id: &str,
        expected_key_epoch: u64,
    ) -> Result<AttachmentState> {
        read_id(box_id)?;
        read_integer(expected_key_epoch)?;
        let state: AttachmentState = decode(
            &self
                .send(
                    Method::GET,
                    self.endpoint(&["boxes", box_id, "attachment-state"])?,
                    None,
                )
                .await?,
        )?;
        if state.key_epoch != expected_key_epoch {
            return Err(Error::ContextMismatch);
        }
        Ok(state)
    }

    /// Read an opaque item at the same public revision used for attachment GET.
    /// All expected item context comes from the caller, not the state/envelope.
    /// The caller must authenticate the returned item with Core before using its references.
    pub async fn get_attachment_snapshot(
        &self,
        state_revision: u64,
        expected: &ItemContext,
    ) -> Result<EncryptedItem> {
        read_integer(state_revision)?;
        read_id(expected.password_box_id.as_str())?;
        read_id(expected.item_id.as_str())?;
        read_integer(expected.item_version)?;
        read_integer(expected.key_epoch)?;
        let mut url = self.endpoint(&[
            "boxes",
            expected.password_box_id.as_str(),
            "items",
            expected.item_id.as_str(),
            "attachment-snapshot",
        ])?;
        url.query_pairs_mut()
            .append_pair("revision", &state_revision.to_string());
        let item: EncryptedItem = decode(&self.send(Method::GET, url, None).await?)?;
        if let Some(problem) = envelope_problem(
            &item,
            expected.password_box_id.as_str(),
            expected.item_id.as_str(),
        ) {
            return Err(Error::InvalidResponse(problem));
        }
        if item.context != *expected {
            return Err(Error::ContextMismatch);
        }
        Ok(item)
    }

    fn attachment_url(&self, c: &AttachmentContext) -> Result<reqwest::Url> {
        expected(c)?;
        self.endpoint(&[
            "boxes",
            c.password_box_id.as_str(),
            "items",
            c.item_id.as_str(),
            "attachments",
            c.attachment_id.as_str(),
        ])
    }
    /// The caller binds expected to authenticated item references and this same snapshot revision.
    /// Neither response headers nor the fetched envelope supply the expectation.
    pub async fn get_attachment(
        &self,
        state_revision: u64,
        expected: &AttachmentContext,
    ) -> Result<EncryptedAttachment> {
        if !(1..=MAX_SAFE).contains(&state_revision) {
            return Err(Error::InvalidArgument("invalid state revision"));
        }
        let mut url = self.attachment_url(expected)?;
        url.query_pairs_mut()
            .append_pair("revision", &state_revision.to_string());
        let result: EncryptedAttachment = decode(&self.send_attachment(url).await?)?;
        if result.context != *expected {
            return Err(Error::ContextMismatch);
        }
        Ok(result)
    }
    /// Atomic item + attachment CAS. `expected` is independently chosen NEXT attachment context.
    pub async fn put_attachment(
        &self,
        expected_state_revision: u64,
        item: &AttachmentItemWrite,
        expected_version: u64,
        ciphertext: &EncryptedAttachment,
        expected: &AttachmentContext,
    ) -> Result<AttachmentPutReply> {
        mutation_revision(expected_state_revision)?;
        envelope(ciphertext, expected)?;
        item_write(item, expected)?;
        if expected_version >= MAX_SAFE || expected.attachment_version != expected_version + 1 {
            return Err(Error::InvalidArgument("invalid attachment successor"));
        }
        let body = json!({"expectedStateRevision":expected_state_revision,"item":item,"expectedVersion":expected_version,"envelope":ciphertext});
        bounded_request(&body)?;
        let result: AttachmentPutReply = decode(
            &self
                .send(Method::PUT, self.attachment_url(expected)?, Some(&body))
                .await?,
        )?;
        if result.state_revision != expected_state_revision + 2
            || result.item_version != item.expected_version + 1
            || result.attachment_version != expected.attachment_version
            || result.key_epoch != expected.key_epoch
        {
            return Err(Error::InvalidResponse("attachment write result mismatch"));
        }
        Ok(result)
    }
    /// Delete returns HTTP 200 metadata (not the existing item-delete 204 contract).
    /// `expected` is the independently trusted CURRENT live attachment context.
    pub async fn delete_attachment(
        &self,
        expected_state_revision: u64,
        item: &AttachmentItemWrite,
        expected: &AttachmentContext,
    ) -> Result<AttachmentDeleteReply> {
        mutation_revision(expected_state_revision)?;
        expected
            .validate_public()
            .map_err(|_| Error::InvalidArgument("invalid attachment context"))?;
        item_write(item, expected)?;
        let body = json!({"expectedStateRevision":expected_state_revision,"item":item,"expectedVersion":expected.attachment_version,"keyEpoch":expected.key_epoch});
        bounded_request(&body)?;
        let result: AttachmentDeleteReply = decode(
            &self
                .send(Method::DELETE, self.attachment_url(expected)?, Some(&body))
                .await?,
        )?;
        if result.state_revision != expected_state_revision + 2
            || result.item_version != item.expected_version + 1
            || !result.deleted
            || result.key_epoch != expected.key_epoch
        {
            return Err(Error::InvalidResponse("attachment delete result mismatch"));
        }
        Ok(result)
    }
}
pub(crate) fn bounded_request(body: &serde_json::Value) -> Result<()> {
    if serde_json::to_vec(body)
        .map_err(|_| Error::InvalidArgument("invalid attachment request"))?
        .len()
        > 2 * 1024 * 1024
    {
        return Err(Error::InvalidArgument(
            "attachment request exceeds HTTP limit",
        ));
    }
    Ok(())
}
