use serde::{Deserialize, Serialize};

use super::connect_id::ConnectId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FieldType {
    String,
    Concealed,
    Email,
    Url,
    Otp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FieldPurpose {
    Username,
    Password,
    Notes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionReference {
    pub id: ConnectId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: ConnectId,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub id: ConnectId,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<FieldPurpose>,
    #[serde(default)]
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<SectionReference>,
}

impl Field {
    pub fn new(
        label: impl Into<String>,
        field_type: FieldType,
        value: impl Into<String>,
    ) -> Result<Self, crate::error::PassShareError> {
        Ok(Self {
            id: ConnectId::generate()?,
            label: label.into(),
            field_type,
            purpose: None,
            value: value.into(),
            section: None,
        })
    }

    pub fn with_purpose(mut self, purpose: FieldPurpose) -> Self {
        self.purpose = Some(purpose);
        self
    }
}
