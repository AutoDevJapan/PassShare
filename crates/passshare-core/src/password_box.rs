use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use zeroize::{Zeroize, Zeroizing};

use crate::crypto::{
    decrypt, derive_master_key, derive_master_key_with_params, encrypt, generate_recovery_secret,
    generate_salt, MasterKey, FILE_VERSION, KDF_MEMORY_KIB, KDF_PARALLELISM, KDF_TIME_COST,
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

/// A master key retained in memory while the box is unlocked, tagged with the
/// exact KDF inputs it was derived from.
///
/// Deriving the master key runs a deliberately expensive Argon2id pass
/// (64 MiB / t=3 / p=4), so paying it on every mutation `save` is pure UX cost:
/// the box is already unlocked and the plaintext payload is already resident in
/// memory. Caching the derived key removes that per-save cost.
///
/// `save` may reuse a cached key **only** when its tagged inputs match the
/// parameters it is about to write to the file header (current defaults + the
/// box's salt). If they differ — e.g. the box was opened from a file written
/// with older KDF cost parameters (crypto-agility) — the key is re-derived so
/// the on-disk ciphertext stays consistent with the header, and the cache is
/// refreshed. The cache never influences the on-disk format or `FILE_VERSION`.
///
/// The key material is a [`MasterKey`], which is `ZeroizeOnDrop`; dropping the
/// cache (on `lock()`, on re-derive replacement, or when the `PasswordBox` is
/// torn down) wipes it. The salt/params are non-secret (they live in the file
/// header) so only the key needs scrubbing.
struct CachedMasterKey {
    key: MasterKey,
    salt: [u8; 16],
    memory_kib: u32,
    time_cost: u32,
    parallelism: u32,
}

pub struct PasswordBox {
    path: PathBuf,
    state: PasswordBoxState,
    payload: PasswordBoxPayload,
    salt: Option<[u8; 16]>,
    /// Master key retained while unlocked so repeated `save`s skip Argon2id.
    /// `None` when locked or not yet derived. See [`CachedMasterKey`].
    cached_key: Option<CachedMasterKey>,
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
            // Populated by the `save` below (first derivation), then reused.
            cached_key: None,
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
        // Retain the just-derived key for reuse by `save`, tagged with the KDF
        // inputs it was derived from (the header's, honoring crypto-agility).
        // If those differ from the current defaults, the first `save` re-derives
        // rather than reusing this key (see `master_key_for_save`).
        let cached_key = Some(CachedMasterKey {
            key,
            salt,
            memory_kib: file.kdf.memory_kib,
            time_cost: file.kdf.time_cost,
            parallelism: file.kdf.parallelism,
        });
        Ok(Self {
            path,
            state: PasswordBoxState::Unlocked,
            payload,
            salt: Some(salt),
            cached_key,
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
        self.payload.sync_vault_item_count();
        // Serializing our own in-memory payload: a failure is an internal bug.
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&self.payload)
                .map_err(|e| PassShareError::Internal(e.to_string()))?,
        );
        // Reuse the unlock-time master key when it matches what we are about to
        // write to the header; otherwise re-derive (first save after `create`,
        // or a box opened with older KDF cost parameters being re-keyed).
        let key = self.master_key_for_save(master_password, &salt)?;
        let (ciphertext, nonce) = encrypt(&plaintext, key)?;
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

    /// Return the master key `save` should encrypt with, reusing the cached
    /// unlock-time key when it is valid and re-deriving (and re-caching) when it
    /// is not.
    ///
    /// `save` always writes the **current default** KDF parameters to the header
    /// and must encrypt with a key derived from exactly those parameters (plus
    /// the box's salt), or the file would be undecryptable on the next `open`.
    /// The cached key is therefore reusable only when its tagged inputs equal
    /// those the header will advertise. A mismatch means the box was opened from
    /// a file written with different (older) cost parameters; re-deriving here is
    /// the crypto-agility re-key, and the refreshed cache lets subsequent saves
    /// take the fast path again.
    fn master_key_for_save(
        &mut self,
        master_password: &str,
        salt: &[u8; 16],
    ) -> Result<&MasterKey, PassShareError> {
        let reusable = matches!(
            &self.cached_key,
            Some(cached)
                if cached.salt == *salt
                    && cached.memory_kib == KDF_MEMORY_KIB
                    && cached.time_cost == KDF_TIME_COST
                    && cached.parallelism == KDF_PARALLELISM
        );
        if !reusable {
            // Replacing the `Option` drops any previous `CachedMasterKey`, whose
            // `MasterKey` is `ZeroizeOnDrop` — the stale key is wiped, not leaked.
            let key = derive_master_key(master_password, salt)?;
            self.cached_key = Some(CachedMasterKey {
                key,
                salt: *salt,
                memory_kib: KDF_MEMORY_KIB,
                time_cost: KDF_TIME_COST,
                parallelism: KDF_PARALLELISM,
            });
        }
        // `reusable` guarantees `Some` on the fast path, and the branch above
        // guarantees `Some` otherwise.
        Ok(&self
            .cached_key
            .as_ref()
            .expect("cached key is populated above")
            .key)
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
        // Drop the cached master key so a locked box holds no derived key.
        // Assigning `None` runs `CachedMasterKey`'s drop, zeroizing the
        // `MasterKey`; a subsequent unlock (`open`) re-derives from scratch.
        self.cached_key = None;
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
            for field in &mut item.fields {
                field.value.zeroize();
            }
        }
        if let Some(secret) = self.payload.recovery_secret.as_mut() {
            secret.zeroize();
        }
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
        stored.version = FILE_VERSION + 1;
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

    #[test]
    fn open_caches_key_matching_fresh_derivation() {
        // After unlocking, the retained key must equal a fresh derivation from
        // the same password + salt + (default) header params, so reusing it on
        // save is byte-for-byte equivalent to re-deriving.
        let path = temp_box_path();
        PasswordBox::create(&path, "correct-password").unwrap();

        let reopened = PasswordBox::open(&path, "correct-password").unwrap();
        let salt = reopened.salt.expect("unlocked box retains its salt");
        let fresh = derive_master_key("correct-password", &salt).unwrap();
        let cached = reopened.cached_key.as_ref().expect("key cached on open");
        assert_eq!(
            cached.key.as_bytes(),
            fresh.as_bytes(),
            "cached key must equal a fresh derivation"
        );
        assert_eq!(
            (cached.memory_kib, cached.time_cost, cached.parallelism),
            (KDF_MEMORY_KIB, KDF_TIME_COST, KDF_PARALLELISM),
            "cache tags the KDF params it was derived with"
        );
    }

    #[test]
    fn save_reuses_cached_key_verbatim() {
        // Prove the cache is actually consulted: poison it with a key derived
        // from the WRONG password but tagged with the params `save` will write.
        // The reuse condition holds, so `save` encrypts with the cached key and
        // ignores its `master_password` argument — the file then opens with the
        // poisoned password, not the "correct" one.
        let path = temp_box_path();
        let mut pb = PasswordBox::create(&path, "correct-password").unwrap();
        let salt = pb.salt.unwrap();

        pb.cached_key = Some(CachedMasterKey {
            key: derive_master_key("poisoned-password", &salt).unwrap(),
            salt,
            memory_kib: KDF_MEMORY_KIB,
            time_cost: KDF_TIME_COST,
            parallelism: KDF_PARALLELISM,
        });
        let vault_id = pb.vault().unwrap().id.clone();
        pb.add_item(Item::new_login(vault_id, "Site", "pwd").unwrap())
            .unwrap();
        pb.save("correct-password").unwrap();
        drop(pb);

        assert_eq!(
            PasswordBox::open(&path, "correct-password").err(),
            Some(PassShareError::InvalidMasterPassword),
            "save reused the cached (poisoned) key, not the argument"
        );
        let opened = PasswordBox::open(&path, "poisoned-password").unwrap();
        assert_eq!(opened.list_connect_items().unwrap().len(), 1);
    }

    #[test]
    fn save_rederives_when_cached_params_mismatch() {
        // A box opened from a file written with different (older) KDF cost
        // parameters carries a cache tagged with those params. Because `save`
        // always writes the current defaults, the cache must NOT be reused: the
        // key is re-derived from the argument so the file stays decryptable, and
        // the cache is refreshed to the defaults for subsequent fast-path saves.
        let path = temp_box_path();
        let mut pb = PasswordBox::create(&path, "correct-password").unwrap();
        let salt = pb.salt.unwrap();

        // Poison the key AND mark it with non-default params so reuse is refused.
        pb.cached_key = Some(CachedMasterKey {
            key: derive_master_key("poisoned-password", &salt).unwrap(),
            salt,
            memory_kib: KDF_MEMORY_KIB + 1024,
            time_cost: KDF_TIME_COST,
            parallelism: KDF_PARALLELISM,
        });
        let vault_id = pb.vault().unwrap().id.clone();
        pb.add_item(Item::new_login(vault_id, "Site", "pwd").unwrap())
            .unwrap();
        pb.save("correct-password").unwrap();

        let refreshed = pb.cached_key.as_ref().expect("cache refreshed on save");
        assert_eq!(
            (
                refreshed.memory_kib,
                refreshed.time_cost,
                refreshed.parallelism
            ),
            (KDF_MEMORY_KIB, KDF_TIME_COST, KDF_PARALLELISM),
            "re-derive refreshes the cache to the params written to the header"
        );

        // The file was encrypted with the re-derived (correct) key, not poison.
        let reopened = PasswordBox::open(&path, "correct-password").unwrap();
        assert_eq!(reopened.list_connect_items().unwrap().len(), 1);
        assert!(PasswordBox::open(&path, "poisoned-password").is_err());
    }

    #[test]
    fn repeated_saves_stay_decryptable() {
        // The fast path (cache reuse) across many saves must never desync the
        // ciphertext from the header: every re-open must still decrypt.
        let path = temp_box_path();
        let master = "MySecurePass123!";
        let mut pb = PasswordBox::create(&path, master).unwrap();
        let vault_id = pb.vault().unwrap().id.clone();

        for i in 0..5 {
            pb.add_item(Item::new_login(vault_id.clone(), format!("Site {i}"), "pwd").unwrap())
                .unwrap();
            pb.save(master).unwrap();
            let reopened = PasswordBox::open(&path, master).unwrap();
            assert_eq!(reopened.list_connect_items().unwrap().len(), i + 1);
        }
    }

    #[test]
    fn lock_clears_cached_master_key() {
        // Locking must drop the retained key (zeroized via `ZeroizeOnDrop`) so a
        // locked box holds no derived key material.
        let path = temp_box_path();
        let mut pb = PasswordBox::create(&path, "pass").unwrap();
        assert!(
            pb.cached_key.is_some(),
            "creating a box derives and caches the key"
        );
        pb.lock();
        assert!(
            pb.cached_key.is_none(),
            "lock() must clear the cached master key"
        );
    }
}
