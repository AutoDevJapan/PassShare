//! Contract-scoped opaque export transport. Snapshot selectors do not replace
//! independently held key epochs or item/attachment contexts. Core authenticates
//! every ciphertext; no password or unwrapped key enters this module.
use crate::attachment_client::{envelope as check_attachment, positive};
use crate::encrypted_client::{decode, envelope_problem};
use crate::{
    AttachmentContext, AttachmentState, EncryptedAttachment, EncryptedItem, EncryptedSessionClient,
    EncryptedSessionError as Error, EncryptedSessionResult as Result, ItemContext,
};
use passshare_core::ConnectId;
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const PAGE_BYTES: usize = 4 * 1024 * 1024 + 4096;
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn integer(n: u64) -> Result<()> {
    if (1..=MAX_SAFE).contains(&n) {
        Ok(())
    } else {
        Err(Error::InvalidArgument("invalid export integer"))
    }
}
fn box_id(s: &str) -> Result<()> {
    ConnectId::validate(s).map_err(|_| Error::InvalidArgument("invalid export box ID"))
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractExportSnapshot {
    contract_id: String,
    box_id: ConnectId,
    key_epoch: u64,
    snapshot_revision: u64,
}
impl ContractExportSnapshot {
    pub fn key_epoch(&self) -> u64 {
        self.key_epoch
    }
    pub fn revision(&self) -> u64 {
        self.snapshot_revision
    }
    pub fn box_id(&self) -> &str {
        self.box_id.as_str()
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply<T> {
    format: String,
    receipt_id: Option<String>,
    box_id: ConnectId,
    #[serde(deserialize_with = "positive")]
    key_epoch: u64,
    #[serde(deserialize_with = "positive")]
    snapshot_revision: u64,
    ciphertext_only: bool,
    restores_identity_membership_or_keys: bool,
    data: T,
}
impl<T> Reply<T> {
    fn check(&self, box_id: &str, epoch: u64, revision: Option<u64>) -> Result<()> {
        if self.format != "passshare-encrypted-export-v1"
            || !self.ciphertext_only
            || self.restores_identity_membership_or_keys
            || self.box_id.as_str() != box_id
            || self.key_epoch != epoch
            || revision.is_some_and(|r| r != self.snapshot_revision)
            || self.receipt_id.as_ref().is_some_and(|s| !uuid(s))
        {
            return Err(Error::ContextMismatch);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContractExportItems {
    pub envelopes: Vec<EncryptedItem>,
    pub next_cursor: Option<ConnectId>,
    attachments_included: bool,
}
impl EncryptedSessionClient {
    fn contract_export_endpoint(
        &self,
        contract: &str,
        box_name: &str,
        tail: &[&str],
    ) -> Result<Url> {
        if !uuid(contract) {
            return Err(Error::InvalidArgument("invalid export contract ID"));
        }
        box_id(box_name)?;
        let mut url = self.endpoint(&[])?;
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| Error::InvalidBaseUrl("cannot be a base"))?;
            path.pop_if_empty().pop().extend([
                "commercial-contracts",
                contract,
                "export",
                "boxes",
                box_name,
            ]);
            path.extend(tail);
        }
        Ok(url)
    }
    pub async fn contract_export_snapshot(
        &self,
        contract: &str,
        box_name: &str,
        expected_epoch: u64,
    ) -> Result<ContractExportSnapshot> {
        integer(expected_epoch)?;
        let reply: Reply<AttachmentState> = decode(
            &self
                .send(
                    Method::GET,
                    self.contract_export_endpoint(contract, box_name, &["state"])?,
                    None,
                )
                .await?,
        )?;
        reply.check(box_name, expected_epoch, None)?;
        if reply.data.key_epoch != expected_epoch
            || reply.data.state_revision != reply.snapshot_revision
        {
            return Err(Error::ContextMismatch);
        }
        Ok(ContractExportSnapshot {
            contract_id: contract.into(),
            box_id: box_name
                .parse()
                .map_err(|_| Error::InvalidArgument("invalid export box ID"))?,
            key_epoch: expected_epoch,
            snapshot_revision: reply.snapshot_revision,
        })
    }
    fn export_at(&self, snapshot: &ContractExportSnapshot, tail: &[&str]) -> Result<Url> {
        let mut url =
            self.contract_export_endpoint(&snapshot.contract_id, snapshot.box_id(), tail)?;
        url.query_pairs_mut()
            .append_pair("epoch", &snapshot.key_epoch.to_string())
            .append_pair("revision", &snapshot.snapshot_revision.to_string());
        Ok(url)
    }
    /// Structure/scope validation only. Caller must authenticate each envelope
    /// against its independently held item metadata using Core.
    pub async fn contract_export_items(
        &self,
        snapshot: &ContractExportSnapshot,
        after: Option<&str>,
    ) -> Result<ContractExportItems> {
        if let Some(after) = after {
            box_id(after)?;
        }
        let mut url = self.export_at(snapshot, &["items"])?;
        if let Some(after) = after {
            url.query_pairs_mut().append_pair("after", after);
        }
        let reply: Reply<ContractExportItems> = decode(
            &self
                .send_limited(Method::GET, url, None, 200, PAGE_BYTES)
                .await?,
        )?;
        reply.check(
            snapshot.box_id(),
            snapshot.key_epoch,
            Some(snapshot.snapshot_revision),
        )?;
        let page = reply.data;
        if page.attachments_included || page.envelopes.len() > 10 {
            return Err(Error::InvalidResponse("invalid export page"));
        }
        let mut previous = after;
        for item in &page.envelopes {
            let id = item.context.item_id.as_str();
            if envelope_problem(item, snapshot.box_id(), id).is_some()
                || item.context.key_epoch != snapshot.key_epoch
                || previous.is_some_and(|p| p >= id)
            {
                return Err(Error::ContextMismatch);
            }
            previous = Some(id);
        }
        if let Some(next) = &page.next_cursor {
            if page
                .envelopes
                .last()
                .is_none_or(|e| e.context.item_id != *next)
            {
                return Err(Error::InvalidResponse("export cursor does not advance"));
            }
        }
        Ok(page)
    }
    pub async fn contract_export_attachment_item(
        &self,
        snapshot: &ContractExportSnapshot,
        expected: &ItemContext,
    ) -> Result<EncryptedItem> {
        if expected.password_box_id.as_str() != snapshot.box_id()
            || expected.key_epoch != snapshot.key_epoch
        {
            return Err(Error::InvalidArgument("export item context differs"));
        }
        integer(expected.item_version)?;
        let reply: Reply<EncryptedItem> = decode(
            &self
                .send(
                    Method::GET,
                    self.export_at(
                        snapshot,
                        &["items", expected.item_id.as_str(), "attachment-snapshot"],
                    )?,
                    None,
                )
                .await?,
        )?;
        reply.check(
            snapshot.box_id(),
            snapshot.key_epoch,
            Some(snapshot.snapshot_revision),
        )?;
        if envelope_problem(&reply.data, snapshot.box_id(), expected.item_id.as_str()).is_some()
            || reply.data.context != *expected
        {
            return Err(Error::ContextMismatch);
        }
        Ok(reply.data)
    }
    pub async fn contract_export_attachment(
        &self,
        snapshot: &ContractExportSnapshot,
        expected: &AttachmentContext,
    ) -> Result<EncryptedAttachment> {
        if expected.password_box_id.as_str() != snapshot.box_id()
            || expected.key_epoch != snapshot.key_epoch
        {
            return Err(Error::InvalidArgument("export attachment context differs"));
        }
        expected
            .validate_public()
            .map_err(|_| Error::InvalidArgument("invalid export attachment context"))?;
        let limit = 4 * (1024usize * 1024 + 4096 + 4 + 16).div_ceil(3) + 8192;
        let reply: Reply<EncryptedAttachment> = decode(
            &self
                .send_limited(
                    Method::GET,
                    self.export_at(
                        snapshot,
                        &[
                            "items",
                            expected.item_id.as_str(),
                            "attachments",
                            expected.attachment_id.as_str(),
                        ],
                    )?,
                    None,
                    200,
                    limit,
                )
                .await?,
        )?;
        reply.check(
            snapshot.box_id(),
            snapshot.key_epoch,
            Some(snapshot.snapshot_revision),
        )?;
        check_attachment(&reply.data, expected)?;
        Ok(reply.data)
    }
    /// Recheck authority and snapshot after collecting all pages, before publishing
    /// a complete file. Reads propagate 401/403/409/429; no silent partial success.
    pub async fn verify_contract_export_snapshot(
        &self,
        snapshot: &ContractExportSnapshot,
    ) -> Result<()> {
        let current = self
            .contract_export_snapshot(&snapshot.contract_id, snapshot.box_id(), snapshot.key_epoch)
            .await?;
        if current != *snapshot {
            return Err(Error::ContextMismatch);
        }
        Ok(())
    }
}
