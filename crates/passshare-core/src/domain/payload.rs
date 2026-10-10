use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::item::Item;
use super::login_item::LoginItem;
use super::vault::Vault;

pub const PAYLOAD_VERSION_V2: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordBoxPayload {
    #[serde(default = "default_payload_version")]
    pub payload_version: u32,
    pub vault: Vault,
    pub items: Vec<Item>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_secret: Option<String>,
}

fn default_payload_version() -> u32 {
    PAYLOAD_VERSION_V2
}

impl PasswordBoxPayload {
    pub fn new(vault: Vault, recovery_secret: Option<String>) -> Self {
        Self {
            payload_version: PAYLOAD_VERSION_V2,
            vault,
            items: Vec::new(),
            recovery_secret,
        }
    }

    pub fn sync_vault_item_count(&mut self) {
        self.vault.refresh_item_count(self.items.len() as u32);
    }
}

/// Legacy v0.1 plaintext payload (LoginItem + optional recovery secret).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct LegacyPasswordBoxPayload {
    pub items: Vec<LoginItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_secret: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
enum RawPasswordBoxPayload {
    V2(PasswordBoxPayload),
    Legacy(LegacyPasswordBoxPayload),
}

impl RawPasswordBoxPayload {
    fn into_payload(
        self,
        vault_name: &str,
    ) -> Result<PasswordBoxPayload, crate::error::PassShareError> {
        match self {
            RawPasswordBoxPayload::V2(payload) => Ok(payload),
            RawPasswordBoxPayload::Legacy(legacy) => {
                crate::migration::migrate_legacy_payload(legacy, vault_name)
            }
        }
    }
}

pub fn deserialize_payload(
    bytes: &[u8],
    vault_name: &str,
) -> Result<PasswordBoxPayload, crate::error::PassShareError> {
    // Bytes here are already decrypted (the AEAD auth tag verified), so they came
    // from a genuine PassShare box. Distinguish two failure modes:
    //   * invalid JSON / structure  -> CorruptFile
    //   * valid JSON but a newer     -> UnsupportedVersion
    //     `payloadVersion` we don't understand
    let value = ParsedPlaintext(
        serde_json::from_slice(bytes).map_err(|_| crate::error::PassShareError::CorruptFile)?,
    );

    // Peek the version BEFORE the typed parse: `payload_version` is a plain field,
    // so a newer-but-structurally-compatible payload would otherwise silently
    // deserialize as V2 and risk misinterpreting/dropping newer data. A decrypted
    // payload from a newer app is unsupported, not corrupt — surface it distinctly
    // so the UI can prompt an app upgrade. Legacy payloads carry no `payloadVersion`
    // and fall through to the untagged parse + migration below.
    if let Some(version) = value
        .0
        .get("payloadVersion")
        .and_then(serde_json::Value::as_u64)
    {
        if version > u64::from(PAYLOAD_VERSION_V2) {
            return Err(crate::error::PassShareError::UnsupportedVersion);
        }
    }

    // Borrow from the guard so ignored extensions and error paths do not
    // consume an unguarded plaintext JSON allocation.
    let raw = RawPasswordBoxPayload::deserialize(&value.0)
        .map_err(|_| crate::error::PassShareError::CorruptFile)?;
    raw.into_payload(vault_name)
}

struct ParsedPlaintext(serde_json::Value);
impl Drop for ParsedPlaintext {
    fn drop(&mut self) {
        fn clear(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::String(text) => text.zeroize(),
                serde_json::Value::Array(values) => values.iter_mut().for_each(clear),
                serde_json::Value::Object(values) => {
                    for (mut key, mut value) in std::mem::take(values) {
                        key.zeroize();
                        clear(&mut value);
                    }
                }
                _ => {}
            }
        }
        clear(&mut self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::PassShareError;

    fn v2_value() -> serde_json::Value {
        let payload = PasswordBoxPayload::new(Vault::new("My Box").unwrap(), None);
        serde_json::to_value(payload).unwrap()
    }

    #[test]
    fn valid_v2_payload_round_trips() {
        let bytes = serde_json::to_vec(&v2_value()).unwrap();
        let payload = deserialize_payload(&bytes, "My Box").unwrap();
        assert_eq!(payload.payload_version, PAYLOAD_VERSION_V2);
        assert!(payload.items.is_empty());
    }

    #[test]
    fn newer_payload_version_is_unsupported_not_corrupt() {
        // Structurally valid V2 shape but a future payloadVersion: it must be
        // rejected as UnsupportedVersion rather than silently downgraded to V2.
        let mut value = v2_value();
        value["payloadVersion"] = serde_json::json!(PAYLOAD_VERSION_V2 + 1);
        let bytes = serde_json::to_vec(&value).unwrap();
        let err = deserialize_payload(&bytes, "My Box").unwrap_err();
        assert_eq!(err, PassShareError::UnsupportedVersion);
    }

    #[test]
    fn garbage_json_is_corrupt() {
        let err = deserialize_payload(b"{ not json ]", "My Box").unwrap_err();
        assert_eq!(err, PassShareError::CorruptFile);
    }

    #[test]
    fn legacy_payload_without_version_migrates() {
        // Legacy v0.1 layout carries no payloadVersion; it must still migrate to V2.
        let legacy = serde_json::json!({
            "items": [LoginItem::new("Site", "pwd").unwrap()],
            "recovery_secret": null
        });
        let bytes = serde_json::to_vec(&legacy).unwrap();
        let payload = deserialize_payload(&bytes, "Legacy Box").unwrap();
        assert_eq!(payload.payload_version, PAYLOAD_VERSION_V2);
        assert_eq!(payload.items.len(), 1);
    }
}
