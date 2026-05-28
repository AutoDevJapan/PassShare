use argon2::{
    password_hash::{PasswordHasher, SaltString},
    Algorithm, Argon2, Params, Version,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    XChaCha20Poly1305, XNonce,
};
use getrandom::getrandom;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::PassShareError;

pub const FILE_VERSION: u32 = 1;
pub const KDF_MEMORY_KIB: u32 = 65536;
pub const KDF_TIME_COST: u32 = 3;
pub const KDF_PARALLELISM: u32 = 4;
pub const RECOVERY_SECRET_BYTES: usize = 32;

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct MasterKey([u8; 32]);

impl MasterKey {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

pub fn derive_master_key(password: &str, salt: &[u8]) -> Result<MasterKey, PassShareError> {
    let params = Params::new(KDF_MEMORY_KIB, KDF_TIME_COST, KDF_PARALLELISM, Some(32))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = [0u8; 32];
    argon2.hash_password_into(password.as_bytes(), salt, &mut output)?;
    Ok(MasterKey(output))
}

pub fn generate_salt() -> Result<[u8; 16], PassShareError> {
    let mut salt = [0u8; 16];
    getrandom(&mut salt).map_err(|e| PassShareError::Internal(e.to_string()))?;
    Ok(salt)
}

pub fn generate_recovery_secret() -> Result<String, PassShareError> {
    let mut bytes = [0u8; RECOVERY_SECRET_BYTES];
    getrandom(&mut bytes).map_err(|e| PassShareError::Internal(e.to_string()))?;
    Ok(BASE64.encode(bytes))
}

pub fn encrypt(plaintext: &[u8], key: &MasterKey) -> Result<(Vec<u8>, [u8; 24]), PassShareError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes())
        .map_err(|e| PassShareError::Internal(e.to_string()))?;
    let mut nonce = [0u8; 24];
    getrandom(&mut nonce).map_err(|e| PassShareError::Internal(e.to_string()))?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|e| PassShareError::Internal(e.to_string()))?;
    Ok((ciphertext, nonce))
}

pub fn decrypt(
    ciphertext: &[u8],
    key: &MasterKey,
    nonce: &[u8; 24],
) -> Result<Vec<u8>, PassShareError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes())
        .map_err(|e| PassShareError::Internal(e.to_string()))?;
    cipher
        .decrypt(XNonce::from_slice(nonce), ciphertext)
        .map_err(|_| PassShareError::InvalidMasterPassword)
}

/// Argon2 salt string for verification-only checks (not used for file format).
#[allow(dead_code)]
pub fn hash_master_password_for_verify(password: &str) -> Result<String, PassShareError> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| PassShareError::Internal(e.to_string()))?;
    Ok(hash.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let salt = generate_salt().unwrap();
        let key = derive_master_key("test-password", &salt).unwrap();
        let plaintext = b"secret payload";
        let (ciphertext, nonce) = encrypt(plaintext, &key).unwrap();
        let decrypted = decrypt(&ciphertext, &key, &nonce).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn wrong_key_fails_decrypt() {
        let salt = generate_salt().unwrap();
        let key = derive_master_key("correct", &salt).unwrap();
        let wrong = derive_master_key("wrong", &salt).unwrap();
        let (ciphertext, nonce) = encrypt(b"data", &key).unwrap();
        assert_eq!(
            decrypt(&ciphertext, &wrong, &nonce),
            Err(PassShareError::InvalidMasterPassword)
        );
    }

    #[test]
    fn kdf_reference_timing() {
        use std::time::Instant;
        let salt = generate_salt().unwrap();
        let start = Instant::now();
        let _key = derive_master_key("benchmark-password", &salt).unwrap();
        let ms = start.elapsed().as_millis();
        println!("KDF_MS={ms}");
        assert!(ms > 0);
        assert!(ms < 5000, "KDF took {ms}ms, exceeds 5000ms ceiling");
    }
}
