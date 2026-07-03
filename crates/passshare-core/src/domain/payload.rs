use serde::{Deserialize, Serialize};

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
    fn into_payload(self, vault_name: &str) -> Result<PasswordBoxPayload, crate::error::PassShareError> {
        match self {
            RawPasswordBoxPayload::V2(payload) => Ok(payload),
            RawPasswordBoxPayload::Legacy(legacy) => {
                crate::migration::migrate_legacy_payload(legacy, vault_name)
            }
        }
    }
}

pub fn deserialize_payload(bytes: &[u8], vault_name: &str) -> Result<PasswordBoxPayload, crate::error::PassShareError> {
    // Bytes here are already decrypted; if they will not parse the payload is
    // corrupt (or from an unsupported layout).
    let raw: RawPasswordBoxPayload = serde_json::from_slice(bytes)
        .map_err(|_| crate::error::PassShareError::CorruptFile)?;
    raw.into_payload(vault_name)
}
