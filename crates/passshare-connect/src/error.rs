use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConnectError {
    #[error("Connect API error ({status}): {message}")]
    Api { status: u16, message: String },

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Missing OP_CONNECT_HOST")]
    MissingHost,

    #[error("Missing OP_CONNECT_TOKEN")]
    MissingToken,

    #[error("{0}")]
    Other(String),
}

pub type ConnectResult<T> = Result<T, ConnectError>;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemOverview {
    pub id: String,
    pub title: String,
    pub version: u32,
    pub vault: VaultRef,
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub urls: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct VaultRef {
    pub id: String,
}
