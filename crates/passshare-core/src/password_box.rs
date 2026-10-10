use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use zeroize::{Zeroize, Zeroizing};

use crate::crypto::{
    decrypt, decrypt_recovery_key, derive_master_key, derive_master_key_with_params, encrypt,
    encrypt_recovery_key, generate_recovery_secret, generate_salt, recovery_key, MasterKey,
    KDF_MEMORY_KIB, KDF_PARALLELISM, KDF_TIME_COST, RECOVERY_FILE_VERSION,
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
use crate::storage::file_format::{KdfParams, PasswordBoxFile, RecoveryWrapper, StoredCipher};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordBoxState {
    Locked,
    Unlocked,
}

/// A complete mutation that becomes visible only after its encrypted save succeeds.
#[derive(Clone, Copy)]
pub enum SavedChange<'a> {
    Add(&'a Item),
    Update(&'a Item),
    Delete(&'a str),
    ImportCsv(&'a str),
    Upsert(&'a Item),
}

pub struct PasswordBox {
    path: PathBuf,
    state: PasswordBoxState,
    payload: PasswordBoxPayload,
    salt: Option<[u8; 16]>,
    file_version: u32,
    recovery_only: bool,
    // Keep the authenticated JSON for fields not represented by the current DTO.
    // It is merged at save, and its serialized buffer is scrubbed on teardown.
    original_payload: Option<Zeroizing<Vec<u8>>>,
    source_fingerprint: Option<[u8; 32]>,
}

impl PasswordBox {
    /// Stage the change separately from the live box and publish it only after
    /// the atomic file replacement succeeds. Errors and panic unwinding discard
    /// the staged box, whose Drop implementation scrubs its plaintext secrets.
    /// Returns the number of affected items (the imported count for CSV).
    pub fn apply_and_save(
        &mut self,
        change: SavedChange<'_>,
        master_password: &str,
    ) -> Result<usize, PassShareError> {
        self.ensure_unlocked()?;
        let mut staged = Self {
            path: self.path.clone(),
            state: self.state,
            payload: self.payload.clone(),
            salt: self.salt,
            file_version: self.file_version,
            recovery_only: self.recovery_only,
            original_payload: self.original_payload.clone(),
            source_fingerprint: self.source_fingerprint,
        };
        let count = match change {
            SavedChange::Add(item) => {
                staged.add_item(item.clone())?;
                1
            }
            SavedChange::Update(item) => {
                staged.update_item(item.clone())?;
                1
            }
            SavedChange::Delete(id) => {
                staged.delete_item(id)?;
                1
            }
            SavedChange::ImportCsv(csv) => staged.import_onepassword_csv(csv)?,
            SavedChange::Upsert(item) => {
                staged.upsert_sync_item(item.clone())?;
                1
            }
        };
        staged.save(master_password)?;
        std::mem::swap(&mut self.payload, &mut staged.payload);
        std::mem::swap(&mut self.original_payload, &mut staged.original_payload);
        std::mem::swap(&mut self.source_fingerprint, &mut staged.source_fingerprint);
        Ok(count)
    }

    pub fn create(path: impl AsRef<Path>, master_password: &str) -> Result<Self, PassShareError> {
        let path = path.as_ref().to_path_buf();
        let vault_name = default_vault_name(&path);
        let vault = Vault::new(vault_name)?;
        let salt = generate_salt()?;
        let recovery_secret = generate_recovery_secret()?;
        let payload = PasswordBoxPayload::new(vault, Some(recovery_secret));
        let mut pb = Self {
            path,
            state: PasswordBoxState::Unlocked,
            payload,
            salt: Some(salt),
            file_version: RECOVERY_FILE_VERSION,
            recovery_only: false,
            original_payload: None,
            source_fingerprint: None,
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
        let pb = Self::open_with_key(path, &file, &key, false)?;
        if file.version == RECOVERY_FILE_VERSION {
            let code = pb
                .payload
                .recovery_secret
                .as_deref()
                .ok_or(PassShareError::CorruptFile)?;
            let recovered = Self::unwrap_recovery_key(&file, code)?;
            if recovered.as_bytes() != key.as_bytes() {
                return Err(PassShareError::CorruptFile);
            }
        }
        Ok(pb)
    }

    /// Read-only recovery. No password or recovered master key is retained.
    /// Call `rekey_recovered` explicitly before attempting any saved mutation.
    pub fn recover(path: impl AsRef<Path>, code: &str) -> Result<Self, PassShareError> {
        let path = path.as_ref().to_path_buf();
        let file = PasswordBoxFile::load_from_path(&path)?;
        file.validate_version()?;
        let key = Self::unwrap_recovery_key(&file, code)?;
        let pb = Self::open_with_key(path, &file, &key, true)?;
        if pb.payload.recovery_secret.as_deref() != Some(code) {
            return Err(PassShareError::CorruptFile);
        }
        Ok(pb)
    }

    fn unwrap_recovery_key(
        file: &PasswordBoxFile,
        code: &str,
    ) -> Result<MasterKey, PassShareError> {
        let wrapper = file.recovery.as_ref().ok_or(PassShareError::CorruptFile)?;
        let recovery = recovery_key(code)?;
        decrypt_recovery_key(
            &wrapper.ciphertext,
            &recovery,
            &wrapper.cipher.nonce_bytes()?,
            &file.recovery_aad()?,
        )
    }

    fn open_with_key(
        path: PathBuf,
        file: &PasswordBoxFile,
        key: &MasterKey,
        recovery_only: bool,
    ) -> Result<Self, PassShareError> {
        let plaintext =
            Zeroizing::new(decrypt(&file.ciphertext, key, &file.cipher.nonce_bytes()?)?);
        #[derive(serde::Deserialize)]
        struct FormatBinding {
            #[serde(default, rename = "localKeyRecoveryVersion")]
            recovery_version: Option<u32>,
        }
        let binding: FormatBinding =
            serde_json::from_slice(&plaintext).map_err(|_| PassShareError::CorruptFile)?;
        if (file.version == RECOVERY_FILE_VERSION
            && binding.recovery_version != Some(RECOVERY_FILE_VERSION))
            || (file.version != RECOVERY_FILE_VERSION && binding.recovery_version.is_some())
        {
            return Err(PassShareError::CorruptFile);
        }
        // Construct a scrub-on-drop owner before fallible payload deserialization.
        let mut pb = Self {
            path,
            state: PasswordBoxState::Unlocked,
            payload: PasswordBoxPayload::new(Vault::new("_")?, None),
            salt: Some(file.kdf.salt_bytes()?),
            file_version: file.version,
            recovery_only,
            original_payload: Some(plaintext),
            source_fingerprint: Some(file.fingerprint()?),
        };
        pb.payload = deserialize_payload(
            pb.original_payload.as_ref().unwrap(),
            &default_vault_name(&pb.path),
        )?;
        Ok(pb)
    }

    /// Explicit v1 opt-in. Authentication and atomic save must succeed before
    /// publishing the new version/code to this object. v2 uses the same code.
    pub fn enable_recovery(
        &mut self,
        current_master_password: &str,
    ) -> Result<Zeroizing<String>, PassShareError> {
        self.ensure_unlocked()?;
        if self.recovery_only {
            return Err(PassShareError::InvalidMasterPassword);
        }
        let authenticated = Self::open(&self.path, current_master_password)?;
        if authenticated.source_fingerprint != self.source_fingerprint {
            return Err(PassShareError::CorruptFile);
        }
        let code = Zeroizing::new(match &self.payload.recovery_secret {
            Some(code) => code.clone(),
            None => generate_recovery_secret()?,
        });
        recovery_key(&code)?;
        let salt = self.salt.ok_or(PassShareError::CorruptFile)?;
        let saved = self.write_with_password(
            current_master_password,
            salt,
            RECOVERY_FILE_VERSION,
            Some(&code),
        )?;
        self.publish_saved(saved);
        if let Some(previous) = &mut self.payload.recovery_secret {
            previous.zeroize();
        }
        self.payload.recovery_secret = Some(code.to_string());
        self.file_version = RECOVERY_FILE_VERSION;
        Ok(code)
    }

    /// Atomically re-encrypt a recovered box with a fresh salt and new password.
    /// The recovery code is intentionally reusable until explicitly rotated.
    pub fn rekey_recovered(&mut self, new_password: &str) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        if !self.recovery_only {
            return Err(PassShareError::CorruptFile);
        }
        if new_password.is_empty() {
            return Err(PassShareError::PasswordRequired);
        }
        let salt = generate_salt()?;
        let saved = self.write_with_password(
            new_password,
            salt,
            RECOVERY_FILE_VERSION,
            self.payload.recovery_secret.as_deref(),
        )?;
        self.publish_saved(saved);
        self.salt = Some(salt);
        self.recovery_only = false;
        Ok(())
    }

    /// Replace the code on the current file; older backups retain their old code.
    pub fn rotate_recovery(
        &mut self,
        current_master_password: &str,
    ) -> Result<Zeroizing<String>, PassShareError> {
        self.ensure_unlocked()?;
        if self.recovery_only || self.file_version != RECOVERY_FILE_VERSION {
            return Err(PassShareError::CorruptFile);
        }
        let authenticated = Self::open(&self.path, current_master_password)?;
        if authenticated.source_fingerprint != self.source_fingerprint {
            return Err(PassShareError::CorruptFile);
        }
        let code = Zeroizing::new(generate_recovery_secret()?);
        let saved = self.write_with_password(
            current_master_password,
            self.salt.ok_or(PassShareError::CorruptFile)?,
            RECOVERY_FILE_VERSION,
            Some(&code),
        )?;
        self.publish_saved(saved);
        if let Some(previous) = &mut self.payload.recovery_secret {
            previous.zeroize();
        }
        self.payload.recovery_secret = Some(code.to_string());
        Ok(code)
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
        scrub_item_fields(&mut self.payload.items[pos]);
        self.payload.items[pos] = item;
        self.payload.vault.updated_at = chrono::Utc::now();
        Ok(())
    }

    pub fn delete_item(&mut self, id: &str) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        let connect_id = ConnectId::from_str(id)?;
        let len_before = self.payload.items.len();
        self.payload.items.retain_mut(|item| {
            if item.id == connect_id {
                scrub_item_fields(item);
                false
            } else {
                true
            }
        });
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
            scrub_item_fields(&mut self.payload.items[pos]);
            self.payload.items[pos] = item;
        } else {
            self.payload.items.push(item);
        }
        self.payload.sync_vault_item_count();
        Ok(())
    }

    pub fn save(&mut self, master_password: &str) -> Result<(), PassShareError> {
        self.ensure_unlocked()?;
        if self.recovery_only {
            return Err(PassShareError::InvalidMasterPassword);
        }
        let salt = self.salt.ok_or(PassShareError::CorruptFile)?;
        let saved = self.write_with_password(
            master_password,
            salt,
            self.file_version,
            self.payload.recovery_secret.as_deref(),
        )?;
        self.publish_saved(saved);
        Ok(())
    }

    fn write_with_password(
        &self,
        master_password: &str,
        salt: [u8; 16],
        version: u32,
        code: Option<&str>,
    ) -> Result<(Zeroizing<Vec<u8>>, [u8; 32]), PassShareError> {
        let key = derive_master_key(master_password, &salt)?;
        let plaintext = self.serialize_preserving_extensions(version, code)?;
        let (ciphertext, nonce) = encrypt(&plaintext, &key)?;
        let mut file = PasswordBoxFile {
            version,
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
            recovery: None,
        };
        if version == RECOVERY_FILE_VERSION {
            let recovery = recovery_key(code.ok_or(PassShareError::CorruptFile)?)?;
            let (ciphertext, nonce) = encrypt_recovery_key(&key, &recovery, &file.recovery_aad()?)?;
            file.recovery = Some(RecoveryWrapper {
                cipher: StoredCipher {
                    algorithm: "xchacha20poly1305".into(),
                    nonce: BASE64.encode(nonce),
                },
                ciphertext,
            });
        }
        let fingerprint = file.fingerprint()?;
        if let Some(expected) = self.source_fingerprint {
            let current = PasswordBoxFile::load_from_path(&self.path)?;
            if current.fingerprint()? != expected {
                return Err(PassShareError::CorruptFile);
            }
        }
        file.save_to_path(&self.path)?;
        Ok((plaintext, fingerprint))
    }

    fn publish_saved(&mut self, (plaintext, fingerprint): (Zeroizing<Vec<u8>>, [u8; 32])) {
        self.original_payload = Some(plaintext);
        self.source_fingerprint = Some(fingerprint);
    }

    fn serialize_preserving_extensions(
        &self,
        version: u32,
        code: Option<&str>,
    ) -> Result<Zeroizing<Vec<u8>>, PassShareError> {
        let mut current = SecretJson(
            serde_json::to_value(&self.payload)
                .map_err(|e| PassShareError::Internal(e.to_string()))?,
        );
        if version == RECOVERY_FILE_VERSION {
            current.0["localKeyRecoveryVersion"] = serde_json::json!(RECOVERY_FILE_VERSION);
        }
        if let Some(code) = code {
            if let Some(previous) = current.0.get_mut("recoverySecret") {
                scrub_json(previous);
            }
            current.0["recoverySecret"] = serde_json::Value::String(code.to_owned());
        } else if let Some(object) = current.0.as_object_mut() {
            if let Some(mut removed) = object.remove("recoverySecret") {
                scrub_json(&mut removed);
            }
        }
        let mut original = SecretJson(match &self.original_payload {
            Some(bytes) => {
                serde_json::from_slice(bytes).map_err(|_| PassShareError::CorruptFile)?
            }
            None => serde_json::Value::Null,
        });
        // Legacy plaintext is migrated to the typed payload rather than merged.
        if original.0.get("vault").is_none() {
            scrub_json(&mut original.0);
            original.0 = serde_json::Value::Null;
        }
        merge_extensions(&mut current.0, &original.0, "payload");
        Ok(Zeroizing::new(
            serde_json::to_vec(&current.0).map_err(|e| PassShareError::Internal(e.to_string()))?,
        ))
    }

    pub fn lock(&mut self) {
        self.state = PasswordBoxState::Locked;
        // Wipe secret-bearing material before dropping the payload so cleartext
        // passwords do not linger in freed heap pages after locking.
        self.zeroize_secrets();
        if let Ok(vault) = Vault::new("_") {
            self.payload = PasswordBoxPayload::new(vault, None);
        }
        self.salt = None;
        self.original_payload = None;
        self.recovery_only = false;
        self.source_fingerprint = None;
    }

    /// Scrub every plaintext secret still held in the in-memory payload.
    ///
    /// Shared by `lock()` and the `Drop` impl so that boxes torn down without an
    /// explicit `lock()` (state replacement in the desktop app, process exit,
    /// panic unwinding) still have their cleartext field values and recovery
    /// secret zeroized in place. Idempotent: running it again over an
    /// already-wiped (or empty) payload is a no-op, so `lock()`-then-drop does
    /// not double-free or panic.
    ///
    /// Best-effort by nature: any earlier `String` reallocation (push/growth)
    /// may have left stale copies on freed heap pages that we can no longer
    /// reach. Wiping the current buffers is the strongest guarantee available
    /// without moving every secret behind a `Zeroizing` newtype.
    fn zeroize_secrets(&mut self) {
        for item in &mut self.payload.items {
            scrub_item_fields(item);
        }
        if let Some(secret) = self.payload.recovery_secret.as_mut() {
            secret.zeroize();
        }
        self.original_payload = None;
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

impl Drop for PasswordBox {
    /// Guarantee plaintext scrubbing on every teardown path — not just an
    /// explicit `lock()`. Without this, replacing an unlocked box in app state,
    /// or unwinding on panic / process exit, would drop the payload's `String`
    /// buffers with the decrypted passwords and recovery secret still in them.
    fn drop(&mut self) {
        self.zeroize_secrets();
    }
}

// Scrub before replacement/removal as well as whole-box teardown: Drop can only
// reach items still in the payload, not String buffers already released by Vec.
fn scrub_item_fields(item: &mut Item) {
    for field in &mut item.fields {
        field.value.zeroize();
    }
    for url in &mut item.urls {
        url.href.zeroize();
        url.label.zeroize();
        for (mut key, mut value) in std::mem::take(&mut url.extensions) {
            key.zeroize();
            scrub_json(&mut value);
        }
    }
    #[cfg(test)]
    saved_change_tests::observe_scrubbed_item(item);
}

fn default_vault_name(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Password Box".to_string())
}

use std::str::FromStr;

#[cfg(test)]
#[path = "password_box_saved_tests.rs"]
mod saved_change_tests;

#[cfg(test)]
#[path = "password_box_recovery_tests.rs"]
mod recovery_tests;

/// Ensure temporary JSON copies, including unknown secret fields, are scrubbed.
struct SecretJson(serde_json::Value);

impl Drop for SecretJson {
    fn drop(&mut self) {
        scrub_json(&mut self.0);
    }
}

fn scrub_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => s.zeroize(),
        serde_json::Value::Array(values) => values.iter_mut().for_each(scrub_json),
        serde_json::Value::Object(values) => {
            for (mut key, mut value) in std::mem::take(values) {
                key.zeroize();
                scrub_json(&mut value);
            }
        }
        _ => {}
    }
}

fn merge_extensions(current: &mut serde_json::Value, original: &serde_json::Value, context: &str) {
    // URLs now carry their own extensions. Never infer identity from href or
    // reinsert properties that a caller explicitly removed from that value.
    if context == "urls" {
        return;
    }
    use serde_json::Value;
    match (current, original) {
        (Value::Object(current), Value::Object(original)) => {
            let known: &[&str] = match context {
                "payload" => &[
                    "payloadVersion",
                    "vault",
                    "items",
                    "recoverySecret",
                    "localKeyRecoveryVersion",
                ],
                "vault" => &[
                    "id",
                    "name",
                    "description",
                    "type",
                    "items",
                    "createdAt",
                    "updatedAt",
                    "contentVersion",
                    "attributeVersion",
                ],
                "vault-ref" => &["id"],
                "items" => &[
                    "id",
                    "title",
                    "category",
                    "vault",
                    "fields",
                    "sections",
                    "urls",
                    "tags",
                    "favorite",
                    "createdAt",
                    "updatedAt",
                    "lastEditedBy",
                ],
                "fields" => &["id", "label", "type", "purpose", "value", "section"],
                "sections" => &["id", "label"],
                "urls" => &["href", "primary", "label"],
                "section" => &["id"],
                _ => &[],
            };
            for (name, previous) in original {
                if let Some(value) = current.get_mut(name) {
                    // The payload owns a full Vault; an Item owns only a
                    // reference. Preserve extensions on that narrower DTO.
                    let nested = if context == "items" && name == "vault" {
                        "vault-ref"
                    } else {
                        name
                    };
                    merge_extensions(value, previous, nested);
                } else if !known.contains(&name.as_str()) {
                    current.insert(name.clone(), previous.clone());
                }
            }
        }
        (Value::Array(current), Value::Array(original))
            if matches!(context, "items" | "fields" | "sections" | "urls") =>
        {
            let key = if context == "urls" { "href" } else { "id" };
            let mut used = vec![false; original.len()];
            for value in current {
                if let Some((index, previous)) =
                    original.iter().enumerate().find(|(index, previous)| {
                        !used[*index]
                            && value.get(key).is_some()
                            && previous.get(key) == value.get(key)
                    })
                {
                    used[index] = true;
                    merge_extensions(value, previous, context);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::item::Item;
    use crate::domain::payload::deserialize_payload;
    use tempfile::{NamedTempFile, TempPath};

    /// A temp path whose backing file handle is already closed, so the atomic
    /// rename used by the save path (#390) is not blocked by an open handle on
    /// Windows. In production the `.pbox` is never held open across a save.
    fn temp_box_path() -> TempPath {
        NamedTempFile::new().unwrap().into_temp_path()
    }

    #[test]
    fn create_open_add_search_save_roundtrip() {
        let path = temp_box_path();
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
        let path = temp_box_path();
        let mut pb = PasswordBox::create(&path, "pass").unwrap();
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
        let path = temp_box_path();
        let mut pb = PasswordBox::create(&path, "pass").unwrap();
        let csv = "Title,Username,Password\nSite,user,pwd123\n";
        let count = pb.import_onepassword_csv(csv).unwrap();
        assert_eq!(count, 1);
        assert_eq!(pb.list_connect_items().unwrap().len(), 1);
    }

    #[test]
    fn wrong_master_password_on_open() {
        let path = temp_box_path();
        PasswordBox::create(&path, "correct-password").unwrap();
        assert!(matches!(
            PasswordBox::open(&path, "wrong-password"),
            Err(PassShareError::InvalidMasterPassword)
        ));
    }

    #[test]
    fn delete_item_not_found() {
        let path = temp_box_path();
        let mut pb = PasswordBox::create(&path, "pass").unwrap();
        assert_eq!(
            pb.delete_item("abcdefghijklmnopqrstuvwxyz"),
            Err(PassShareError::ItemNotFound)
        );
    }

    #[test]
    fn export_csv_contains_items() {
        let path = temp_box_path();
        let mut pb = PasswordBox::create(&path, "pass").unwrap();
        let vault_id = pb.vault().unwrap().id.clone();
        let item = Item::new_login(vault_id, "Export Me", "secret").unwrap();
        pb.add_item(item).unwrap();
        let csv = pb.export_onepassword_csv().unwrap();
        assert!(csv.contains("Export Me"));
        assert!(csv.contains("secret"));
    }

    #[test]
    fn upsert_sync_item_updates_existing() {
        let path = temp_box_path();
        let mut pb = PasswordBox::create(&path, "pass").unwrap();
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
    fn zeroize_secrets_scrubs_field_and_recovery_secret_heap() {
        // The shared helper that both `lock()` and `Drop` invoke must wipe the
        // decrypted secrets in place. We inspect the concealed password field's
        // heap buffer directly to prove the plaintext bytes are overwritten,
        // not merely that the length was reset.
        let path = temp_box_path();
        let secret = "top-secret-plaintext-marker-9973";
        let mut pb = PasswordBox::create(&path, "pass").unwrap();
        let vault_id = pb.vault().unwrap().id.clone();
        pb.add_item(Item::new_login(vault_id, "Site", secret).unwrap())
            .unwrap();

        // `create()` seeds a recovery secret; capture the password field buffer.
        assert!(pb.payload.recovery_secret.is_some());
        let (ptr, len) = {
            let field = pb
                .payload
                .items
                .iter()
                .flat_map(|item| item.fields.iter())
                .find(|f| f.value == secret)
                .expect("password field present");
            (field.value.as_ptr(), field.value.len())
        };

        // SAFETY: `pb` owns the allocation and the [0..len) region is the
        // initialized plaintext; the read is sound while `pb` is alive.
        let before = unsafe { std::slice::from_raw_parts(ptr, len) };
        assert_eq!(before, secret.as_bytes(), "plaintext present before wipe");

        pb.zeroize_secrets();

        // `String::zeroize` overwrites the bytes in place and truncates without
        // reallocating, so `ptr` still points at the same (now zeroed) buffer.
        // SAFETY: same allocation, still owned by `pb`, bytes written to zero.
        let after = unsafe { std::slice::from_raw_parts(ptr, len) };
        assert!(
            after.iter().all(|&b| b == 0),
            "field plaintext must be wiped in place"
        );
        for item in &pb.payload.items {
            for field in &item.fields {
                assert!(field.value.is_empty(), "field value truncated after wipe");
            }
        }
        assert_eq!(
            pb.payload.recovery_secret.as_deref(),
            Some(""),
            "recovery secret zeroized"
        );
    }

    #[test]
    fn lock_then_drop_is_safe() {
        // Double zeroization (explicit lock followed by drop) must be a no-op on
        // the second pass — no panic, no double free.
        let path = temp_box_path();
        let mut pb = PasswordBox::create(&path, "pass").unwrap();
        let vault_id = pb.vault().unwrap().id.clone();
        pb.add_item(Item::new_login(vault_id, "Site", "secret").unwrap())
            .unwrap();
        pb.lock();
        assert_eq!(pb.state(), PasswordBoxState::Locked);
        // `pb` drops at end of scope; Drop re-runs zeroize_secrets over the
        // already-emptied payload without incident.
    }

    #[test]
    fn open_rejects_weak_kdf_header() {
        let path = temp_box_path();
        PasswordBox::create(&path, "correct-password").unwrap();

        // Tamper the header to advertise a weak KDF cost below the security floor.
        let mut stored = PasswordBoxFile::load_from_path(&path).unwrap();
        stored.kdf.memory_kib = 1024;
        stored.save_to_path(&path).unwrap();

        assert_eq!(
            PasswordBox::open(&path, "correct-password").err(),
            Some(PassShareError::CorruptFile)
        );
    }

    #[test]
    fn open_honors_stored_default_kdf_params() {
        // A file written with the current defaults must still open normally after
        // the header params are honored on decrypt.
        let path = temp_box_path();
        let mut pb = PasswordBox::create(&path, "correct-password").unwrap();
        let vault_id = pb.vault().unwrap().id.clone();
        pb.add_item(Item::new_login(vault_id, "Site", "pwd").unwrap())
            .unwrap();
        pb.save("correct-password").unwrap();

        let reopened = PasswordBox::open(&path, "correct-password").unwrap();
        assert_eq!(reopened.list_connect_items().unwrap().len(), 1);
    }

    #[test]
    fn open_rejects_tampered_ciphertext() {
        // Flipping a ciphertext byte fails the AEAD tag even with the right
        // password — the same signal as a wrong password (indistinguishable).
        let path = temp_box_path();
        PasswordBox::create(&path, "correct-password").unwrap();

        let mut stored = PasswordBoxFile::load_from_path(&path).unwrap();
        assert!(!stored.ciphertext.is_empty());
        stored.ciphertext[0] ^= 0xff;
        stored.save_to_path(&path).unwrap();

        assert_eq!(
            PasswordBox::open(&path, "correct-password").err(),
            Some(PassShareError::InvalidMasterPassword)
        );
    }

    #[test]
    fn open_rejects_version_mismatch() {
        let path = temp_box_path();
        PasswordBox::create(&path, "correct-password").unwrap();

        let mut stored = PasswordBoxFile::load_from_path(&path).unwrap();
        stored.version = RECOVERY_FILE_VERSION + 1;
        stored.save_to_path(&path).unwrap();

        assert_eq!(
            PasswordBox::open(&path, "correct-password").err(),
            Some(PassShareError::CorruptFile)
        );
    }

    #[test]
    fn open_rejects_unknown_cipher_algorithm() {
        let path = temp_box_path();
        PasswordBox::create(&path, "correct-password").unwrap();

        let mut stored = PasswordBoxFile::load_from_path(&path).unwrap();
        stored.cipher.algorithm = "aes-gcm".to_string();
        stored.save_to_path(&path).unwrap();

        assert_eq!(
            PasswordBox::open(&path, "correct-password").err(),
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
            let path = temp_box_path();
            PasswordBox::create(&path, "correct-password").unwrap();

            let mut stored = PasswordBoxFile::load_from_path(&path).unwrap();
            mutate(&mut stored);
            stored.save_to_path(&path).unwrap();

            assert_eq!(
                PasswordBox::open(&path, "correct-password").err(),
                Some(PassShareError::CorruptFile)
            );
        }
    }
}
