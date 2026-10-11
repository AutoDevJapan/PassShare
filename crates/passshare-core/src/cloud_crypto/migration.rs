//! Finite, client-only preparation. No importer, I/O, state switch or commit.
//! See `documents/spec/encrypted-migration-core.md` for the wrapper contract.

use std::collections::HashSet;

use super::*;

pub const MAX_MIGRATION_ATTACHMENTS: usize = 1024;
pub const MAX_MIGRATION_BOX_BYTES: usize = 1024 * 1024 * 1024;

/// Caller-selected owner context, obtained independently of ciphertext.
/// Validation checks syntax only; it does not authorize the caller or prove
/// that a supplied key is fresh, belongs to this owner, or has an owner bundle.
pub struct TrustedOwnerKeyContext(OwnerKeyContext);

impl TrustedOwnerKeyContext {
    pub fn new(context: OwnerKeyContext) -> Result<Self> {
        context.aad()?;
        Ok(Self(context))
    }

    pub fn context(&self) -> &OwnerKeyContext {
        &self.0
    }
}

/// Complete JSON object, not the lossy typed Item DTO. No Debug/Clone/serde.
/// All owned JSON strings (including unknown property names) erase on drop.
pub struct MigrationItemPlaintext(Value);

impl MigrationItemPlaintext {
    pub fn new(value: Value) -> Result<Self> {
        let plaintext = Self(value);
        if !plaintext.0.is_object() {
            return Err(CloudCryptoError::InvalidPayload);
        }
        plaintext.encoded_size()?;
        Ok(plaintext)
    }

    pub fn json(&self) -> &Value {
        &self.0
    }

    fn encoded_size(&self) -> Result<usize> {
        validate_depth(&self.0)?;
        let mut size = JsonSize(0);
        serde_json::to_writer(&mut size, &self.0).map_err(|_| CloudCryptoError::InvalidPayload)?;
        Ok(size.0)
    }
}

impl Drop for MigrationItemPlaintext {
    fn drop(&mut self) {
        // Iterative even for rejected, excessively deep caller JSON.
        let mut pending = vec![std::mem::take(&mut self.0)];
        while let Some(value) = pending.pop() {
            match value {
                Value::String(mut text) => text.zeroize(),
                Value::Array(values) => pending.extend(values),
                Value::Object(values) => {
                    for (mut key, value) in values {
                        key.zeroize();
                        pending.push(value);
                    }
                }
                _ => {}
            }
        }
    }
}

/// Owned file bytes, including a zero-length file. Context is a source claim
/// checked against the independently supplied binding and item references.
pub struct MigrationAttachmentSource {
    pub context: AttachmentContext,
    pub plaintext: AttachmentPlaintext,
}

/// Caller-owned snapshot. Preparation only borrows it, including on failure.
pub struct MigrationItemSource {
    pub item: MigrationItemPlaintext,
    pub attachments: Vec<MigrationAttachmentSource>,
}

/// Exact source/target routing; only IDs/epoch may change, never the revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationAttachmentBinding {
    pub source: AttachmentContext,
    pub target: AttachmentContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationItemBinding {
    pub source: ItemContext,
    pub target: ItemContext,
    /// Must match original JSON reference order, not byte-input order.
    pub attachments: Vec<MigrationAttachmentBinding>,
}

/// Ciphertext and public routing only. Fields cannot be mutated through this
/// API. Reuse replay_bytes() verbatim after an explicit status decision; a new
/// preparation generates new nonces and is not an automatic network retry.
pub struct PreparedMigration {
    operation_id: Uuid,
    items: Vec<PreparedMigrationItem>,
    replay_bytes: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedMigrationItem {
    binding: MigrationItemBinding,
    envelope: EncryptedItem,
    attachments: Vec<EncryptedAttachment>,
}

impl PreparedMigrationItem {
    pub fn binding(&self) -> &MigrationItemBinding {
        &self.binding
    }
    pub fn envelope(&self) -> &EncryptedItem {
        &self.envelope
    }
    pub fn attachments(&self) -> &[EncryptedAttachment] {
        &self.attachments
    }
}

impl PreparedMigration {
    pub fn operation_id(&self) -> Uuid {
        self.operation_id
    }
    pub fn items(&self) -> &[PreparedMigrationItem] {
        &self.items
    }
    /// Stable serialized plan: no keys, filenames, original JSON or hashes.
    pub fn replay_bytes(&self) -> &[u8] {
        &self.replay_bytes
    }
}

fn budget_add(total: usize, bytes: usize) -> Result<usize> {
    total
        .checked_add(bytes)
        .filter(|total| *total <= MAX_MIGRATION_BOX_BYTES)
        .ok_or(CloudCryptoError::InvalidPayload)
}

fn references(item: &Value) -> Result<&[Value]> {
    match item.get("attachments") {
        None => Ok(&[]),
        Some(Value::Array(values)) if values.len() <= MAX_MIGRATION_ATTACHMENTS => Ok(values),
        _ => Err(CloudCryptoError::InvalidPayload),
    }
}

fn check_attachment_binding(
    binding: &MigrationAttachmentBinding,
    item: &MigrationItemBinding,
    reference: &Value,
) -> Result<()> {
    binding.source.validate_public()?;
    binding.target.validate_public()?;
    if binding.source.password_box_id != item.source.password_box_id
        || binding.source.item_id != item.source.item_id
        || binding.source.key_epoch != item.source.key_epoch
        || binding.target.password_box_id != item.target.password_box_id
        || binding.target.item_id != item.target.item_id
        || binding.target.key_epoch != item.target.key_epoch
        || binding.target.attachment_version != binding.source.attachment_version
        || reference.get("attachmentId").and_then(Value::as_str)
            != Some(binding.source.attachment_id.as_str())
        || reference.get("attachmentVersion").and_then(Value::as_u64)
            != Some(binding.source.attachment_version)
        || reference.get("keyEpoch").and_then(Value::as_u64) != Some(binding.source.key_epoch)
    {
        return Err(CloudCryptoError::InvalidContext);
    }
    Ok(())
}

fn file<'a>(
    source: &'a MigrationItemSource,
    binding: &MigrationAttachmentBinding,
) -> Result<&'a AttachmentPlaintext> {
    let mut matches = source
        .attachments
        .iter()
        .filter(|file| file.context == binding.source);
    let file = matches.next().ok_or(CloudCryptoError::InvalidPayload)?;
    if matches.next().is_some() {
        return Err(CloudCryptoError::InvalidPayload);
    }
    Ok(&file.plaintext)
}

fn routed_item(
    source: &MigrationItemSource,
    binding: &MigrationItemBinding,
) -> Result<MigrationItemPlaintext> {
    // A separate wrapper, never insert migration attributes into the original.
    MigrationItemPlaintext::new(serde_json::json!({
        "id": binding.target.item_id,
        "version": binding.target.item_version,
        "vault": {"id": binding.target.password_box_id},
        "attachments": binding.attachments.iter().map(|file| serde_json::json!({
            "attachmentId": file.target.attachment_id,
            "attachmentVersion": file.target.attachment_version,
            "keyEpoch": file.target.key_epoch,
        })).collect::<Vec<_>>(),
        "original": source.item.json(),
    }))
}

/// Prepare a complete finite snapshot under an immutable caller-created key.
/// `source_revision` is an independent positive precondition, NOT evidence of
/// current server state. The future authenticated server transaction must check
/// it, ownership, exact membership and the corresponding owner key bundle.
/// This function performs no I/O and never changes the source or active state.
pub fn prepare_migration(
    key: &PasswordBoxKey,
    owner: &TrustedOwnerKeyContext,
    operation_id: Uuid,
    source_password_box_id: &ConnectId,
    source_revision: u64,
    sources: &[MigrationItemSource],
    bindings: &[MigrationItemBinding],
) -> Result<PreparedMigration> {
    owner.0.aad()?;
    ConnectId::validate(source_password_box_id.as_str())
        .map_err(|_| CloudCryptoError::InvalidContext)?;
    if operation_id.is_nil() || !(1..=MAX_JSON_INTEGER).contains(&source_revision) {
        return Err(CloudCryptoError::InvalidContext);
    }
    if sources.len() != bindings.len() {
        return Err(CloudCryptoError::InvalidPayload);
    }
    let mut source_ids = HashSet::new();
    let mut target_ids = HashSet::new();
    let mut source_file_ids = HashSet::new();
    let mut target_file_ids = HashSet::new();
    let mut total_bytes = 0;
    // Validate the whole set before sealing anything. No partial plan escapes.
    for (source, binding) in sources.iter().zip(bindings) {
        binding.source.validate()?;
        binding.target.validate()?;
        if &binding.source.password_box_id != source_password_box_id
            || binding.target.password_box_id != owner.0.password_box_id
            || binding.target.key_epoch != owner.0.key_epoch
            || binding.target.item_version != binding.source.item_version
            || !source_ids.insert(&binding.source.item_id)
            || !target_ids.insert(&binding.target.item_id)
        {
            return Err(CloudCryptoError::InvalidContext);
        }
        check_item(source.item.json(), &binding.source)?;
        let refs = references(source.item.json())?;
        if refs.len() != binding.attachments.len() || refs.len() != source.attachments.len() {
            return Err(CloudCryptoError::InvalidPayload);
        }
        for (reference, attachment) in refs.iter().zip(&binding.attachments) {
            check_attachment_binding(attachment, binding, reference)?;
            if !source_file_ids.insert(&attachment.source.attachment_id)
                || !target_file_ids.insert(&attachment.target.attachment_id)
                || source_file_ids.len() > MAX_MIGRATION_ATTACHMENTS
            {
                return Err(CloudCryptoError::InvalidPayload);
            }
            let plaintext = file(source, attachment)?;
            // Validate optional original name/size metadata without requiring it.
            if reference
                .get("name")
                .is_some_and(|name| name.as_str() != Some(plaintext.name()))
                || reference
                    .get("contentBytes")
                    .is_some_and(|size| size.as_u64() != Some(plaintext.content().len() as u64))
            {
                return Err(CloudCryptoError::InvalidPayload);
            }
            total_bytes = budget_add(total_bytes, plaintext.name().len())?;
            total_bytes = budget_add(total_bytes, plaintext.content().len())?;
        }
        total_bytes = budget_add(total_bytes, routed_item(source, binding)?.encoded_size()?)?;
    }
    let mut items = Vec::with_capacity(sources.len());
    for (source, binding) in sources.iter().zip(bindings) {
        let plaintext = routed_item(source, binding)?;
        let envelope = key.encrypt_item(plaintext.json(), &binding.target)?;
        let attachments = binding
            .attachments
            .iter()
            .map(|binding| key.encrypt_attachment(file(source, binding)?, &binding.target))
            .collect::<Result<Vec<_>>>()?;
        items.push(PreparedMigrationItem {
            binding: binding.clone(),
            envelope,
            attachments,
        });
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire<'a> {
        format: u32,
        operation_id: Uuid,
        owner_context: &'a OwnerKeyContext,
        source_password_box_id: &'a ConnectId,
        source_revision: u64,
        items: &'a [PreparedMigrationItem],
    }
    let replay_bytes = serde_json::to_vec(&Wire {
        format: 1,
        operation_id,
        owner_context: &owner.0,
        source_password_box_id,
        source_revision,
        items: &items,
    })
    .map_err(|_| CloudCryptoError::InvalidPayload)?;
    Ok(PreparedMigration {
        operation_id,
        items,
        replay_bytes,
    })
}

#[cfg(test)]
mod tests;
