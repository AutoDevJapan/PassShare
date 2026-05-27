use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use uuid::Uuid;

use crate::crypto::{
    decrypt, derive_master_key, encrypt, generate_recovery_secret, generate_salt, FILE_VERSION,
    KDF_MEMORY_KIB, KDF_PARALLELISM, KDF_TIME_COST,
};
use crate::domain::login_item::LoginItem;
use crate::domain::payload::PasswordBoxPayload;
use crate::error::PassShareError;
use crate::generator::{generate_password, PasswordGeneratorOptions};
use crate::storage::file_format::{KdfParams, PasswordBoxFile, StoredCipher};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordBoxState {
    Locked,
    Unlocked,
}

pub struct PasswordBox {
    path: PathBuf,
    state: PasswordBoxState,
    payload: PasswordBoxPayload,
    salt: Option<[u8; 16]>,
}

impl PasswordBox {
    pub fn create(path: impl AsRef<Path>, master_password: &str) -> Result<Self, PassShareError> {
        let path = path.as_ref().to_path_buf();
        let salt = generate_salt()?;
        let recovery_secret = generate_recovery_secret()?;
        let payload = PasswordBoxPayload {
            items: Vec::new(),
            recovery_secret: Some(recovery_secret),
        };
        let mut pb = Self {
            path,
            state: PasswordBoxState::Unlocked,
            payload,
            salt: Some(salt),
        };
        pb.save(master_password)?;
        Ok(pb)
    }

    pub fn open(path: impl AsRef<Path>, master_password: &str) -> Result<Self, PassShareError> {
        let path = path.as_ref().to_path_buf();
        let file = PasswordBoxFile::load_from_path(&path)?;
        file.validate_version()?;
        let salt = file.kdf.salt_bytes()?;
        let key = derive_master_key(master_password, &salt)?;
        let nonce = file.cipher.nonce_bytes()?;
        let plaintext = decrypt(&file.ciphertext, &key, &nonce)?;
        let payload: PasswordBoxPayload = serde_json::from_slice(&plaintext)?;
        Ok(Self {
            path,
            state: PasswordBoxState::Unlocked,
            payload,
            salt: Some(salt),
        })
    }

    pub fn state(&self) -> PasswordBoxState {
        self.state
    }

    pub fn recovery_secret(&self) -> Result<Option<&str>, PassShareError> {
        self.ensure_unlocked()?;
        Ok(self.payload.recovery_secret.as_deref())
    }

    pub fn list_items(&self) -> Result<&[LoginItem], PassShareError> {
        self.ensure_unlocked()?;
        Ok(&self.payload.items)
    }

    pub fn search(&self, query: &str) -> Result<Vec<LoginItem>, PassShareError> {
        self.ensure_unlocked()?;
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Ok(self.payload.items.clone());
        }
        Ok(self
            .payload
            .items
            .iter()
            .filter(|item| {
                item.title.to_lowercase().contains(&q)
                    || item.url.to_lowercase().contains(&q)
                    || item.username.to_lowercase().contains(&q)
            })
            .cloned()
            .collect())
    }

    pub fn add_item(&mut self, item: LoginItem) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        self.payload.items.push(item);
        Ok(())
    }

    pub fn update_item(&mut self, item: LoginItem) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        let pos = self
            .payload
            .items
            .iter()
            .position(|i| i.id == item.id)
            .ok_or(PassShareError::ItemNotFound)?;
        self.payload.items[pos] = item;
        Ok(())
    }

    pub fn delete_item(&mut self, id: Uuid) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        let len_before = self.payload.items.len();
        self.payload.items.retain(|i| i.id != id);
        if self.payload.items.len() == len_before {
            return Err(PassShareError::ItemNotFound);
        }
        Ok(())
    }

    pub fn get_item(&self, id: Uuid) -> Result<&LoginItem, PassShareError> {
        self.ensure_unlocked()?;
        self.payload
            .items
            .iter()
            .find(|i| i.id == id)
            .ok_or(PassShareError::ItemNotFound)
    }

    pub fn save(&mut self, master_password: &str) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        let salt = self.salt.ok_or(PassShareError::CorruptFile)?;
        let key = derive_master_key(master_password, &salt)?;
        let plaintext = serde_json::to_vec(&self.payload)?;
        let (ciphertext, nonce) = encrypt(&plaintext, &key)?;
        let file = PasswordBoxFile {
            version: FILE_VERSION,
            kdf: KdfParams {
                algorithm: "argon2id".to_string(),
                salt: BASE64.encode(salt),
                memory_kib: KDF_MEMORY_KIB,
                time_cost: KDF_TIME_COST,
                parallelism: KDF_PARALLELISM,
            },
            cipher: StoredCipher {
                algorithm: "xchacha20poly1305".to_string(),
                nonce: BASE64.encode(nonce),
            },
            ciphertext,
        };
        file.save_to_path(&self.path)?;
        Ok(())
    }

    pub fn lock(&mut self) {
        self.state = PasswordBoxState::Locked;
        self.payload = PasswordBoxPayload::default();
        self.salt = None;
    }

    pub fn generate_password(options: PasswordGeneratorOptions) -> String {
        generate_password(options)
    }

    fn ensure_unlocked(&self) -> Result<(), PassShareError> {
        if self.state == PasswordBoxState::Locked {
            return Err(PassShareError::BoxLocked);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn create_open_add_search_save_roundtrip() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        let master = "MySecurePass123!";

        let mut pb = PasswordBox::create(&path, master).unwrap();
        assert_eq!(pb.state(), PasswordBoxState::Unlocked);
        assert!(pb.recovery_secret().unwrap().is_some());

        let item = LoginItem::new("Example Site", "secret123")
            .unwrap()
            .with_optional_fields(
                Some("https://example.com".into()),
                Some("user@example.com".into()),
                None,
            );
        pb.add_item(item).unwrap();
        pb.save(master).unwrap();

        let opened = PasswordBox::open(&path, master).unwrap();
        assert_eq!(opened.list_items().unwrap().len(), 1);
        let results = opened.search("example").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].username, "user@example.com");
    }

    #[test]
    fn wrong_master_password_on_open() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path();
        PasswordBox::create(path, "correct-password").unwrap();
        assert!(matches!(
            PasswordBox::open(path, "wrong-password"),
            Err(PassShareError::InvalidMasterPassword)
        ));
    }

    #[test]
    fn add_item_validation() {
        let file = NamedTempFile::new().unwrap();
        let mut pb = PasswordBox::create(file.path(), "pass").unwrap();
        assert_eq!(
            LoginItem::new("", "x"),
            Err(PassShareError::TitleRequired)
        );
        assert_eq!(
            LoginItem::new("title", ""),
            Err(PassShareError::PasswordRequired)
        );
        let item = LoginItem::new("Site", "pwd").unwrap();
        pb.add_item(item).unwrap();
        assert_eq!(pb.list_items().unwrap().len(), 1);
    }

    #[test]
    fn delete_item_not_found() {
        let file = NamedTempFile::new().unwrap();
        let mut pb = PasswordBox::create(file.path(), "pass").unwrap();
        assert_eq!(
            pb.delete_item(Uuid::new_v4()),
            Err(PassShareError::ItemNotFound)
        );
    }

    #[test]
    fn update_item_sets_updated_at() {
        let file = NamedTempFile::new().unwrap();
        let mut pb = PasswordBox::create(file.path(), "pass").unwrap();
        let item = LoginItem::new("Site", "pwd").unwrap();
        let id = item.id;
        pb.add_item(item).unwrap();

        let mut updated = pb.get_item(id).unwrap().clone();
        updated.title = "Updated Site".into();
        updated.updated_at = chrono::Utc::now();
        pb.update_item(updated.clone()).unwrap();
        assert_eq!(pb.get_item(id).unwrap().title, "Updated Site");
    }
}
