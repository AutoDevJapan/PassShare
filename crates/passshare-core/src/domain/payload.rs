use serde::{Deserialize, Serialize};

use super::login_item::LoginItem;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PasswordBoxPayload {
    pub items: Vec<LoginItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_secret: Option<String>,
}

impl Default for PasswordBoxPayload {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            recovery_secret: None,
        }
    }
}
