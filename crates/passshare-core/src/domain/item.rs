use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::connect_id::ConnectId;
use super::field::{Field, FieldPurpose, FieldType};
use super::login_item::LoginItem;
use super::login_view::LoginItemView;
use super::vault::Vault;
use crate::error::PassShareError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ItemCategory {
    Login,
    Password,
    SecureNote,
    CreditCard,
    Identity,
    SshKey,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultReference {
    pub id: ConnectId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemUrl {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default)]
    pub primary: bool,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: ConnectId,
    pub title: String,
    pub category: ItemCategory,
    pub vault: VaultReference,
    pub fields: Vec<Field>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<super::field::Section>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub urls: Vec<ItemUrl>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_edited_by: Option<String>,
}

impl Item {
    pub fn new_login(
        vault_id: ConnectId,
        title: impl Into<String>,
        password: impl Into<String>,
    ) -> Result<Self, PassShareError> {
        let title = title.into();
        let password = password.into();
        if title.trim().is_empty() {
            return Err(PassShareError::TitleRequired);
        }
        if password.is_empty() {
            return Err(PassShareError::PasswordRequired);
        }

        let now = Utc::now();
        let fields = vec![
            Field::new("username", FieldType::String, "")?.with_purpose(FieldPurpose::Username),
            Field::new("password", FieldType::Concealed, password)?.with_purpose(FieldPurpose::Password),
            Field::new("notes", FieldType::String, "")?,
        ];

        Ok(Self {
            id: ConnectId::generate()?,
            title,
            category: ItemCategory::Login,
            vault: VaultReference { id: vault_id },
            fields,
            sections: Vec::new(),
            urls: Vec::new(),
            tags: Vec::new(),
            favorite: false,
            created_at: now,
            updated_at: now,
            last_edited_by: None,
        })
    }

    pub fn with_optional_fields(
        mut self,
        url: Option<String>,
        username: Option<String>,
        notes: Option<String>,
    ) -> Result<Self, PassShareError> {
        if let Some(url) = url.filter(|u| !u.is_empty()) {
            self.urls.push(ItemUrl {
                label: String::new(),
                primary: true,
                href: url,
            });
        }
        if let Some(username) = username {
            self.set_field_by_purpose(FieldPurpose::Username, &username)?;
        }
        if let Some(notes) = notes {
            self.set_field_by_label("notes", &notes)?;
        }
        Ok(self)
    }

    pub fn from_login_item(login: LoginItem, vault: &Vault) -> Result<Self, PassShareError> {
        let mut item = Self::new_login(vault.id.clone(), login.title, login.password)?;
        item.id = ConnectId::generate()?;
        item.created_at = login.created_at;
        item.updated_at = login.updated_at;
        item = item.with_optional_fields(
            if login.url.is_empty() {
                None
            } else {
                Some(login.url)
            },
            if login.username.is_empty() {
                None
            } else {
                Some(login.username)
            },
            if login.notes.is_empty() {
                None
            } else {
                Some(login.notes)
            },
        )?;
        Ok(item)
    }

    pub fn to_login_view(&self) -> Option<LoginItemView> {
        if self.category != ItemCategory::Login {
            return None;
        }
        let password = self.field_value_by_purpose(FieldPurpose::Password)?;
        Some(LoginItemView {
            id: self.id.to_string(),
            title: self.title.clone(),
            url: self
                .urls
                .iter()
                .find(|u| u.primary)
                .map(|u| u.href.clone())
                .or_else(|| self.urls.first().map(|u| u.href.clone()))
                .unwrap_or_default(),
            username: self
                .field_value_by_purpose(FieldPurpose::Username)
                .unwrap_or_default(),
            password,
            notes: self.field_value_by_label("notes").unwrap_or_default(),
        })
    }

    pub fn to_login_item(&self) -> Option<LoginItem> {
        let view = self.to_login_view()?;
        let mut login = LoginItem::from_connect(self.id.clone(), view.title, view.password);
        login.url = view.url;
        login.username = view.username;
        login.notes = view.notes;
        login.created_at = self.created_at;
        login.updated_at = self.updated_at;
        Some(login)
    }

    pub fn field_value_by_purpose(&self, purpose: FieldPurpose) -> Option<String> {
        self.fields
            .iter()
            .find(|f| f.purpose == Some(purpose))
            .map(|f| f.value.clone())
    }

    pub fn field_value_by_label(&self, label: &str) -> Option<String> {
        self.fields
            .iter()
            .find(|f| f.label.eq_ignore_ascii_case(label))
            .map(|f| f.value.clone())
    }

    fn set_field_by_purpose(&mut self, purpose: FieldPurpose, value: &str) -> Result<(), PassShareError> {
        if let Some(field) = self.fields.iter_mut().find(|f| f.purpose == Some(purpose)) {
            field.value = value.to_string();
            return Ok(());
        }
        Err(PassShareError::Internal(format!("missing field purpose {:?}", purpose)))
    }

    fn set_field_by_label(&mut self, label: &str, value: &str) -> Result<(), PassShareError> {
        if let Some(field) = self.fields.iter_mut().find(|f| f.label.eq_ignore_ascii_case(label)) {
            field.value = value.to_string();
            return Ok(());
        }
        Err(PassShareError::Internal(format!("missing field label {label}")))
    }

    pub fn matches_search(&self, query: &str) -> bool {
        let q = query.to_lowercase();
        self.title.to_lowercase().contains(&q)
            || self.urls.iter().any(|u| u.href.to_lowercase().contains(&q))
            || self
                .field_value_by_purpose(FieldPurpose::Username)
                .is_some_and(|v| v.to_lowercase().contains(&q))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_roundtrip_via_login_item() {
        let vault = Vault::new("Work").unwrap();
        let login = LoginItem::new("GitHub", "secret")
            .unwrap()
            .with_optional_fields(
                Some("https://github.com".into()),
                Some("dev@example.com".into()),
                Some("memo".into()),
            );
        let item = Item::from_login_item(login.clone(), &vault).unwrap();
        let back = item.to_login_item().unwrap();
        assert_eq!(back.title, login.title);
        assert_eq!(back.password, login.password);
        assert_eq!(back.url, login.url);
        assert_eq!(back.username, login.username);
        assert_eq!(back.notes, login.notes);
    }
}
