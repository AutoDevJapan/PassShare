use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use zeroize::{Zeroize, Zeroizing};

use crate::crypto::{
    decrypt, derive_master_key, derive_master_key_with_params, encrypt, generate_recovery_secret,
    generate_salt, FILE_VERSION, KDF_MEMORY_KIB, KDF_PARALLELISM, KDF_TIME_COST,
};
use crate::domain::connect_id::ConnectId;
use crate::domain::item::Item;
use crate::domain::login_item::LoginItem;
use crate::domain::login_view::LoginItemView;
use crate::domain::payload::{deserialize_payload, PasswordBoxPayload};
use crate::domain::vault::Vault;
use crate::error::PassShareError;
use crate::export::export_onepassword_csv;
use crate::generator::{generate_password, PasswordGeneratorOptions};
use crate::import::import_onepassword_csv;
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
        let vault_name = default_vault_name(&path);
        let salt = generate_salt()?;
        let recovery_secret = generate_recovery_secret()?;
        let payload = PasswordBoxPayload::new(Vault::new(vault_name)?, Some(recovery_secret));
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
        // Honor the KDF cost parameters recorded in the file header (crypto-agility)
        // instead of assuming the current defaults.
        let key = derive_master_key_with_params(
            master_password,
            &salt,
            file.kdf.memory_kib,
            file.kdf.time_cost,
            file.kdf.parallelism,
        )?;
        let nonce = file.cipher.nonce_bytes()?;
        let plaintext = Zeroizing::new(decrypt(&file.ciphertext, &key, &nonce)?);
        let vault_name = default_vault_name(&path);
        let payload = deserialize_payload(&plaintext, &vault_name)?;
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

    pub fn vault(&self) -> Result<&Vault, PassShareError> {
        self.ensure_unlocked()?;
        Ok(&self.payload.vault)
    }

    pub fn recovery_secret(&self) -> Result<Option<&str>, PassShareError> {
        self.ensure_unlocked()?;
        Ok(self.payload.recovery_secret.as_deref())
    }

    pub fn list_connect_items(&self) -> Result<Vec<Item>, PassShareError> {
        self.ensure_unlocked()?;
        Ok(self.payload.items.clone())
    }

    pub fn list_items(&self) -> Result<Vec<LoginItemView>, PassShareError> {
        self.ensure_unlocked()?;
        Ok(self
            .payload
            .items
            .iter()
            .filter_map(|item| item.to_login_view())
            .collect())
    }

    pub fn search(&self, query: &str) -> Result<Vec<LoginItemView>, PassShareError> {
        self.ensure_unlocked()?;
        let q = query.trim();
        if q.is_empty() {
            return self.list_items();
        }
        Ok(self
            .payload
            .items
            .iter()
            .filter(|item| item.matches_search(q))
            .filter_map(|item| item.to_login_view())
            .collect())
    }

    pub fn search_connect_items(&self, query: &str) -> Result<Vec<Item>, PassShareError> {
        self.ensure_unlocked()?;
        let q = query.trim();
        if q.is_empty() {
            return Ok(self.payload.items.clone());
        }
        Ok(self
            .payload
            .items
            .iter()
            .filter(|item| item.matches_search(q))
            .cloned()
            .collect())
    }

    pub fn add_item(&mut self, item: Item) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        self.payload.items.push(item);
        self.payload.sync_vault_item_count();
        Ok(())
    }

    pub fn add_login_item(&mut self, item: LoginItem) -> Result<Item, PassShareError> {
        self.ensure_unlocked()?;
        let connect_item = Item::from_login_item(item, &self.payload.vault)?;
        self.add_item(connect_item.clone())?;
        Ok(connect_item)
    }

    pub fn update_item(&mut self, item: Item) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        let pos = self
            .payload
            .items
            .iter()
            .position(|i| i.id == item.id)
            .ok_or(PassShareError::ItemNotFound)?;
        self.payload.items[pos] = item;
        self.payload.vault.updated_at = chrono::Utc::now();
        Ok(())
    }

    pub fn delete_item(&mut self, id: &str) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        let connect_id = ConnectId::from_str(id)?;
        let len_before = self.payload.items.len();
        self.payload.items.retain(|i| i.id != connect_id);
        if self.payload.items.len() == len_before {
            return Err(PassShareError::ItemNotFound);
        }
        self.payload.sync_vault_item_count();
        Ok(())
    }

    pub fn get_item(&self, id: &str) -> Result<&Item, PassShareError> {
        self.ensure_unlocked()?;
        let connect_id = ConnectId::from_str(id)?;
        self.payload
            .items
            .iter()
            .find(|i| i.id == connect_id)
            .ok_or(PassShareError::ItemNotFound)
    }

    pub fn import_onepassword_csv(&mut self, csv_data: &str) -> Result<usize, PassShareError> {
        self.ensure_unlocked()?;
        let imported = import_onepassword_csv(&self.payload.vault, csv_data)?;
        let count = imported.len();
        for item in imported {
            self.payload.items.push(item);
        }
        self.payload.sync_vault_item_count();
        Ok(count)
    }

    pub fn export_onepassword_csv(&self) -> Result<String, PassShareError> {
        self.ensure_unlocked()?;
        Ok(export_onepassword_csv(&self.payload.items))
    }

    pub fn upsert_sync_item(&mut self, item: Item) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        if let Some(pos) = self
            .payload
            .items
            .iter()
            .position(|existing| existing.id == item.id)
        {
            self.payload.items[pos] = item;
        } else {
            self.payload.items.push(item);
        }
        self.payload.sync_vault_item_count();
        Ok(())
    }

    pub fn save(&mut self, master_password: &str) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        let salt = self.salt.ok_or(PassShareError::CorruptFile)?;
        let key = derive_master_key(master_password, &salt)?;
        self.payload.sync_vault_item_count();
        // Serializing our own in-memory payload: a failure is an internal bug.
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&self.payload)
                .map_err(|e| PassShareError::Internal(e.to_string()))?,
        );
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
        // Wipe secret-bearing material before dropping the payload so cleartext
        // passwords do not linger in freed heap pages after locking.
        for item in &mut self.payload.items {
            for field in &mut item.fields {
                field.value.zeroize();
            }
        }
        if let Some(secret) = self.payload.recovery_secret.as_mut() {
            secret.zeroize();
        }
        if let Ok(vault) = Vault::new("_") {
            self.payload = PasswordBoxPayload::new(vault, None);
        }
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

fn default_vault_name(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Password Box".to_string())
}

use std::str::FromStr;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::item::Item;
    use crate::domain::payload::deserialize_payload;
    use tempfile::NamedTempFile;

    #[test]
    fn create_open_add_search_save_roundtrip() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        let master = "MySecurePass123!";

        let mut pb = PasswordBox::create(&path, master).unwrap();
        assert_eq!(pb.state(), PasswordBoxState::Unlocked);
        assert!(pb.recovery_secret().unwrap().is_some());

        let item = Item::new_login(pb.vault().unwrap().id.clone(), "Example Site", "secret123")
            .unwrap()
            .with_optional_fields(
                Some("https://example.com".into()),
                Some("user@example.com".into()),
                None,
            )
            .unwrap();
        pb.add_item(item).unwrap();
        pb.save(master).unwrap();

        let opened = PasswordBox::open(&path, master).unwrap();
        assert_eq!(opened.list_connect_items().unwrap().len(), 1);
        let results = opened.search("example").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].username, "user@example.com");
        assert!(opened.vault().unwrap().items >= 1);
    }

    #[test]
    fn legacy_v01_payload_deserializes_and_migrates() {
        let legacy_json = serde_json::json!({
            "items": [LoginItem::new("Legacy", "pwd").unwrap()],
            "recovery_secret": null
        });
        let payload = deserialize_payload(legacy_json.to_string().as_bytes(), "legacy").unwrap();
        assert_eq!(payload.payload_version, 2);
        assert_eq!(payload.items.len(), 1);
        assert_eq!(payload.items[0].title, "Legacy");
    }

    #[test]
    fn add_item_validation() {
        let file = NamedTempFile::new().unwrap();
        let mut pb = PasswordBox::create(file.path(), "pass").unwrap();
        assert_eq!(
            Item::new_login(pb.vault().unwrap().id.clone(), "", "x"),
            Err(PassShareError::TitleRequired)
        );
        assert_eq!(
            Item::new_login(pb.vault().unwrap().id.clone(), "title", ""),
            Err(PassShareError::PasswordRequired)
        );
        let item = Item::new_login(pb.vault().unwrap().id.clone(), "Site", "pwd").unwrap();
        pb.add_item(item).unwrap();
        assert_eq!(pb.list_connect_items().unwrap().len(), 1);
    }

    #[test]
    fn import_csv_adds_items() {
        let file = NamedTempFile::new().unwrap();
        let mut pb = PasswordBox::create(file.path(), "pass").unwrap();
        let csv = "Title,Username,Password\nSite,user,pwd123\n";
        let count = pb.import_onepassword_csv(csv).unwrap();
        assert_eq!(count, 1);
        assert_eq!(pb.list_connect_items().unwrap().len(), 1);
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
    fn delete_item_not_found() {
        let file = NamedTempFile::new().unwrap();
        let mut pb = PasswordBox::create(file.path(), "pass").unwrap();
        assert_eq!(
            pb.delete_item("abcdefghijklmnopqrstuvwxyz"),
            Err(PassShareError::ItemNotFound)
        );
    }

    #[test]
    fn export_csv_contains_items() {
        let file = NamedTempFile::new().unwrap();
        let mut pb = PasswordBox::create(file.path(), "pass").unwrap();
        let vault_id = pb.vault().unwrap().id.clone();
        let item = Item::new_login(vault_id, "Export Me", "secret").unwrap();
        pb.add_item(item).unwrap();
        let csv = pb.export_onepassword_csv().unwrap();
        assert!(csv.contains("Export Me"));
        assert!(csv.contains("secret"));
    }

    #[test]
    fn upsert_sync_item_updates_existing() {
        let file = NamedTempFile::new().unwrap();
        let mut pb = PasswordBox::create(file.path(), "pass").unwrap();
        let vault_id = pb.vault().unwrap().id.clone();
        let item = Item::new_login(vault_id.clone(), "Original", "secret").unwrap();
        let id = item.id.clone();
        pb.add_item(item).unwrap();

        let mut updated = Item::new_login(vault_id, "Updated", "secret").unwrap();
        updated.id = id.clone();
        pb.upsert_sync_item(updated).unwrap();

        let stored = pb.get_item(id.to_string().as_str()).unwrap();
        assert_eq!(stored.title, "Updated");
    }

    #[test]
    fn open_rejects_weak_kdf_header() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path();
        PasswordBox::create(path, "correct-password").unwrap();

        // Tamper the header to advertise a weak KDF cost below the security floor.
        let mut stored = PasswordBoxFile::load_from_path(path).unwrap();
        stored.kdf.memory_kib = 1024;
        stored.save_to_path(path).unwrap();

        assert_eq!(
            PasswordBox::open(path, "correct-password").err(),
            Some(PassShareError::CorruptFile)
        );
    }

    #[test]
    fn open_honors_stored_default_kdf_params() {
        // A file written with the current defaults must still open normally after
        // the header params are honored on decrypt.
        let file = NamedTempFile::new().unwrap();
        let path = file.path();
        let mut pb = PasswordBox::create(path, "correct-password").unwrap();
        let vault_id = pb.vault().unwrap().id.clone();
        pb.add_item(Item::new_login(vault_id, "Site", "pwd").unwrap())
            .unwrap();
        pb.save("correct-password").unwrap();

        let reopened = PasswordBox::open(path, "correct-password").unwrap();
        assert_eq!(reopened.list_connect_items().unwrap().len(), 1);
    }

    #[test]
    fn open_rejects_tampered_ciphertext() {
        // Flipping a ciphertext byte fails the AEAD tag even with the right
        // password — the same signal as a wrong password (indistinguishable).
        let file = NamedTempFile::new().unwrap();
        let path = file.path();
        PasswordBox::create(path, "correct-password").unwrap();

        let mut stored = PasswordBoxFile::load_from_path(path).unwrap();
        assert!(!stored.ciphertext.is_empty());
        stored.ciphertext[0] ^= 0xff;
        stored.save_to_path(path).unwrap();

        assert_eq!(
            PasswordBox::open(path, "correct-password").err(),
            Some(PassShareError::InvalidMasterPassword)
        );
    }

    #[test]
    fn open_rejects_version_mismatch() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path();
        PasswordBox::create(path, "correct-password").unwrap();

        let mut stored = PasswordBoxFile::load_from_path(path).unwrap();
        stored.version = FILE_VERSION + 1;
        stored.save_to_path(path).unwrap();

        assert_eq!(
            PasswordBox::open(path, "correct-password").err(),
            Some(PassShareError::CorruptFile)
        );
    }

    #[test]
    fn open_rejects_unknown_cipher_algorithm() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path();
        PasswordBox::create(path, "correct-password").unwrap();

        let mut stored = PasswordBoxFile::load_from_path(path).unwrap();
        stored.cipher.algorithm = "aes-gcm".to_string();
        stored.save_to_path(path).unwrap();

        assert_eq!(
            PasswordBox::open(path, "correct-password").err(),
            Some(PassShareError::CorruptFile)
        );
    }

    #[test]
    fn open_rejects_wrong_length_nonce_and_salt() {
        // "AAAA" is valid base64 but decodes to 3 bytes — neither a 24-byte
        // nonce nor a 16-byte salt — so the fixed-length decode must reject it.
        for mutate in [
            (|s: &mut PasswordBoxFile| s.cipher.nonce = "AAAA".to_string())
                as fn(&mut PasswordBoxFile),
            |s: &mut PasswordBoxFile| s.kdf.salt = "AAAA".to_string(),
        ] {
            let file = NamedTempFile::new().unwrap();
            let path = file.path();
            PasswordBox::create(path, "correct-password").unwrap();

            let mut stored = PasswordBoxFile::load_from_path(path).unwrap();
            mutate(&mut stored);
            stored.save_to_path(path).unwrap();

            assert_eq!(
                PasswordBox::open(path, "correct-password").err(),
                Some(PassShareError::CorruptFile)
            );
        }
    }
}
