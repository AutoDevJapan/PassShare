use std::fs;
use std::io::Write as _;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use crate::crypto::FILE_VERSION;
use crate::error::PassShareError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    pub algorithm: String,
    pub salt: String,
    pub memory_kib: u32,
    pub time_cost: u32,
    pub parallelism: u32,
}

impl KdfParams {
    pub fn salt_bytes(&self) -> Result<[u8; 16], PassShareError> {
        decode_fixed::<16>(&self.salt)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredCipher {
    pub algorithm: String,
    pub nonce: String,
}

impl StoredCipher {
    pub fn nonce_bytes(&self) -> Result<[u8; 24], PassShareError> {
        decode_fixed::<24>(&self.nonce)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PasswordBoxFile {
    pub version: u32,
    pub kdf: KdfParams,
    pub cipher: StoredCipher,
    #[serde(with = "base64_bytes")]
    pub ciphertext: Vec<u8>,
}

impl PasswordBoxFile {
    pub fn load_from_path(path: &Path) -> Result<Self, PassShareError> {
        let data = fs::read_to_string(path)?;
        // Reading untrusted on-disk bytes: malformed JSON means a corrupt file.
        serde_json::from_str(&data).map_err(|_| PassShareError::CorruptFile)
    }

    /// Persist the box atomically.
    ///
    /// The `.pbox` is the user's only copy of every password, so an in-place
    /// `truncate → write` must never be used: a crash / power loss / ENOSPC in
    /// the middle would leave a half-written file and lose everything (#390).
    ///
    /// Instead we write the full contents to a sibling temp file, fsync it, and
    /// atomically rename it over the destination. A crash before the rename
    /// leaves the previous `.pbox` fully intact; the rename itself is atomic on
    /// POSIX (`rename(2)`) and on Windows (`MoveFileEx` with
    /// `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`, as used by
    /// `std::fs::rename` / `tempfile`'s `persist`). The temp file only ever
    /// holds ciphertext — no plaintext touches the disk.
    pub fn save_to_path(&self, path: &Path) -> Result<(), PassShareError> {
        // Resolve the directory the temp file must live in; it has to be the
        // same directory as the target so the rename stays within one
        // filesystem (a cross-device rename is not atomic and would fall back to
        // copy). An empty/relative parent maps to the current directory.
        let parent = match path.parent() {
            Some(p) if !p.as_os_str().is_empty() => {
                fs::create_dir_all(p)?;
                p
            }
            _ => Path::new("."),
        };

        // Serializing our own struct: a failure here is an internal bug, not a
        // corrupt input file.
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| PassShareError::Internal(e.to_string()))?;

        // Write the full payload to a temp file in the target directory, flush
        // it, and fsync so the bytes are durable before we swap it in.
        let mut tmp = NamedTempFile::new_in(parent)?;
        tmp.write_all(json.as_bytes())?;
        tmp.flush()?;
        tmp.as_file().sync_all()?;

        // Atomically replace the destination. On failure `tmp` (carried inside
        // the returned error) is dropped and removed, so no residue leaks to the
        // production path and any existing file stays untouched.
        tmp.persist(path)
            .map_err(|e| PassShareError::from(e.error))?;

        // fsync the parent directory so the rename entry itself is durable
        // (POSIX). Best-effort and platform-dependent; see `sync_parent_dir`.
        sync_parent_dir(parent);
        Ok(())
    }

    pub fn validate_version(&self) -> Result<(), PassShareError> {
        if self.version != FILE_VERSION {
            return Err(PassShareError::CorruptFile);
        }
        if self.kdf.algorithm != "argon2id" || self.cipher.algorithm != "xchacha20poly1305" {
            return Err(PassShareError::CorruptFile);
        }
        Ok(())
    }
}

/// fsync the directory that just received a rename so the directory entry is
/// durable across a crash. On POSIX a file `fsync` does not guarantee the
/// enclosing directory's metadata is flushed, so we open and `sync_all` the
/// directory. Some filesystems return an error for directory fsync; that is
/// non-fatal, hence best-effort.
#[cfg(unix)]
fn sync_parent_dir(dir: &Path) {
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
}

/// On Windows the atomic replace (`MoveFileEx` with `MOVEFILE_WRITE_THROUGH`,
/// used by `std::fs::rename` / `tempfile`'s `persist`) already flushes through
/// to disk, and directory handles cannot be `fsync`-ed via the standard
/// library, so there is nothing extra to do here.
#[cfg(not(unix))]
fn sync_parent_dir(_dir: &Path) {}

fn decode_fixed<const N: usize>(encoded: &str) -> Result<[u8; N], PassShareError> {
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| PassShareError::CorruptFile)?;
    if bytes.len() != N {
        return Err(PassShareError::CorruptFile);
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    Ok(out)
}

mod base64_bytes {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&BASE64.encode(bytes))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        BASE64
            .decode(s)
            .map_err(|e| serde::de::Error::custom(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{NamedTempFile, TempDir};

    fn sample_file(ciphertext: Vec<u8>) -> PasswordBoxFile {
        PasswordBoxFile {
            version: FILE_VERSION,
            kdf: KdfParams {
                algorithm: "argon2id".into(),
                salt: BASE64.encode([1u8; 16]),
                memory_kib: 65536,
                time_cost: 3,
                parallelism: 4,
            },
            cipher: StoredCipher {
                algorithm: "xchacha20poly1305".into(),
                nonce: BASE64.encode([2u8; 24]),
            },
            ciphertext,
        }
    }

    fn dir_file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn save_and_load_roundtrip() {
        let file = sample_file(vec![3, 4, 5]);
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("box.pbox");
        file.save_to_path(&path).unwrap();
        let loaded = PasswordBoxFile::load_from_path(&path).unwrap();
        assert_eq!(loaded, file);
    }

    #[test]
    fn save_leaves_no_temp_residue() {
        // After a successful atomic save the target directory must contain only
        // the `.pbox` — the sibling temp file must have been renamed away.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("box.pbox");
        sample_file(vec![9; 128]).save_to_path(&path).unwrap();
        assert_eq!(dir_file_names(dir.path()), vec!["box.pbox".to_string()]);
    }

    #[test]
    fn save_overwrites_existing_file_completely() {
        // Overwriting a larger file with a smaller one must fully replace it via
        // the atomic rename, never leave a truncated/partial mix.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("box.pbox");

        let big = sample_file(vec![7; 4096]);
        big.save_to_path(&path).unwrap();

        let small = sample_file(vec![1, 2, 3]);
        small.save_to_path(&path).unwrap();

        let loaded = PasswordBoxFile::load_from_path(&path).unwrap();
        assert_eq!(loaded, small);
        assert_eq!(dir_file_names(dir.path()), vec!["box.pbox".to_string()]);
    }

    #[test]
    fn stray_temp_file_does_not_affect_target() {
        // A leftover temp file from a previous interrupted write must not be
        // mistaken for the box nor block a fresh save/load of the real path.
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".tmpLEFTOVER"), b"partial garbage").unwrap();

        let path = dir.path().join("box.pbox");
        let file = sample_file(vec![42; 64]);
        file.save_to_path(&path).unwrap();

        let loaded = PasswordBoxFile::load_from_path(&path).unwrap();
        assert_eq!(loaded, file);
    }

    #[test]
    fn failed_persist_preserves_existing_file_and_leaves_no_residue() {
        // Force the atomic rename to fail by making the target path an existing
        // directory (rename-onto-directory fails on both POSIX and Windows).
        // The pre-existing sibling `.pbox` must stay intact and no temp file
        // may leak into the directory. Runs under any uid (no perms trick), so
        // it is reliable in the root Docker CI container.
        let dir = TempDir::new().unwrap();
        let good_path = dir.path().join("box.pbox");
        let original = sample_file(vec![5; 200]);
        original.save_to_path(&good_path).unwrap();

        let blocked = dir.path().join("blocked.pbox");
        fs::create_dir(&blocked).unwrap();
        let err = sample_file(vec![6; 10]).save_to_path(&blocked).unwrap_err();
        assert!(matches!(err, PassShareError::Internal(_)));

        // The good box is untouched and still fully readable.
        let loaded = PasswordBoxFile::load_from_path(&good_path).unwrap();
        assert_eq!(loaded, original);
        // Only the intended entries remain — no stray temp file survived.
        assert_eq!(
            dir_file_names(dir.path()),
            vec!["blocked.pbox".to_string(), "box.pbox".to_string()]
        );
    }

    #[test]
    fn load_rejects_malformed_json_as_corrupt() {
        // Deserializing untrusted on-disk bytes must surface CorruptFile, not an
        // Internal error (the serialize/deserialize split, #322).
        let tmp = NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"{ this is not json ]").unwrap();
        let err = PasswordBoxFile::load_from_path(tmp.path()).unwrap_err();
        assert_eq!(err, PassShareError::CorruptFile);
    }
}
