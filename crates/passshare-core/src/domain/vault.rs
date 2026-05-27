use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::connect_id::ConnectId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VaultType {
    UserCreated,
    Personal,
    Everyone,
    Transfer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub id: ConnectId,
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(rename = "type")]
    pub vault_type: VaultType,
    #[serde(default)]
    pub items: u32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default = "default_content_version")]
    pub content_version: u32,
    #[serde(default = "default_attribute_version")]
    pub attribute_version: u32,
}

fn default_content_version() -> u32 {
    1
}

fn default_attribute_version() -> u32 {
    1
}

impl Vault {
    pub fn new(name: impl Into<String>) -> Result<Self, crate::error::PassShareError> {
        let now = Utc::now();
        Ok(Self {
            id: ConnectId::generate()?,
            name: name.into(),
            description: String::new(),
            vault_type: VaultType::UserCreated,
            items: 0,
            created_at: now,
            updated_at: now,
            content_version: 1,
            attribute_version: 1,
        })
    }

    pub fn refresh_item_count(&mut self, count: u32) {
        self.items = count;
        self.updated_at = Utc::now();
    }
}
