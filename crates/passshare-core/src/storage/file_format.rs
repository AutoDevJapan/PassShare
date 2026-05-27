use std::fs;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

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
        serde_json::from_str(&data).map_err(Into::into)
    }

    pub fn save_to_path(&self, path: &Path) -> Result<(), PassShareError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let json = serde_json::to_string_pretty(self)?;
        fs::write(path, json)?;
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
    use tempfile::NamedTempFile;

    #[test]
    fn save_and_load_roundtrip() {
        let file = PasswordBoxFile {
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
            ciphertext: vec![3, 4, 5],
        };
        let tmp = NamedTempFile::new().unwrap();
        file.save_to_path(tmp.path()).unwrap();
        let loaded = PasswordBoxFile::load_from_path(tmp.path()).unwrap();
        assert_eq!(loaded, file);
    }
}
