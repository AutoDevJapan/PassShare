use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::connect_id::ConnectId;
use crate::error::PassShareError;

/// Legacy v0.1 login item (UUID-based). Kept for migration and desktop DTO compatibility.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginItem {
    pub id: Uuid,
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub username: String,
    pub password: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl LoginItem {
    pub fn new(title: impl Into<String>, password: impl Into<String>) -> Result<Self, PassShareError> {
        let title = title.into();
        let password = password.into();
        if title.trim().is_empty() {
            return Err(PassShareError::TitleRequired);
        }
        if password.is_empty() {
            return Err(PassShareError::PasswordRequired);
        }
        let now = Utc::now();
        Ok(Self {
            id: Uuid::new_v4(),
            title,
            url: String::new(),
            username: String::new(),
            password,
            notes: String::new(),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn from_connect(_id: ConnectId, title: String, password: String) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            title,
            url: String::new(),
            username: String::new(),
            password,
            notes: String::new(),
            created_at: now,
            updated_at: now,
        }
    }

    pub fn with_optional_fields(
        mut self,
        url: Option<String>,
        username: Option<String>,
        notes: Option<String>,
    ) -> Self {
        if let Some(url) = url {
            self.url = url;
        }
        if let Some(username) = username {
            self.username = username;
        }
        if let Some(notes) = notes {
            self.notes = notes;
        }
        self
    }

    /// Stable string ID for Tauri/desktop layer (Connect ID when available via Item conversion).
    pub fn connect_id_placeholder(&self) -> String {
        self.id.to_string()
    }
}
