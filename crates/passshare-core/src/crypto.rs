use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use getrandom::fill;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::PassShareError;

pub const FILE_VERSION: u32 = 1;
pub const KDF_MEMORY_KIB: u32 = 65536;
pub const KDF_TIME_COST: u32 = 3;
pub const KDF_PARALLELISM: u32 = 4;
pub const RECOVERY_SECRET_BYTES: usize = 32;

// Security floor for KDF parameters read from a `.pbox` header. A file whose
// stored cost is below this is rejected (downgrade / tampering defense). The
// default parameters above are well above the floor, so legitimate files pass.
pub const KDF_MIN_MEMORY_KIB: u32 = 19456; // ~19 MiB (OWASP Argon2id floor)
pub const KDF_MIN_TIME_COST: u32 = 2;
pub const KDF_MIN_PARALLELISM: u32 = 1;

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct MasterKey([u8; 32]);

impl MasterKey {
    /// Generate an account root key locally, independently of authentication.
    pub fn generate() -> Result<Self, PassShareError> {
        let mut key = [0u8; 32];
        fill(&mut key).map_err(|_| PassShareError::Internal("Key generation failed".into()))?;
        Ok(Self(key))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Derive the master key using explicit Argon2id cost parameters (as stored in
/// the `.pbox` header), enforcing a minimum security floor.
pub fn derive_master_key_with_params(
    password: &str,
    salt: &[u8],
    memory_kib: u32,
    time_cost: u32,
    parallelism: u32,
) -> Result<MasterKey, PassShareError> {
    if memory_kib < KDF_MIN_MEMORY_KIB
        || time_cost < KDF_MIN_TIME_COST
        || parallelism < KDF_MIN_PARALLELISM
    {
        return Err(PassShareError::CorruptFile);
    }
    let params = Params::new(memory_kib, time_cost, parallelism, Some(32))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut output = [0u8; 32];
    argon2.hash_password_into(password.as_bytes(), salt, &mut output)?;
    Ok(MasterKey(output))
}

pub fn derive_master_key(password: &str, salt: &[u8]) -> Result<MasterKey, PassShareError> {
    derive_master_key_with_params(
        password,
        salt,
        KDF_MEMORY_KIB,
        KDF_TIME_COST,
        KDF_PARALLELISM,
    )
}

pub fn generate_salt() -> Result<[u8; 16], PassShareError> {
    let mut salt = [0u8; 16];
    fill(&mut salt).map_err(|e| PassShareError::Internal(e.to_string()))?;
    Ok(salt)
}

pub fn generate_recovery_secret() -> Result<String, PassShareError> {
    let mut bytes = [0u8; RECOVERY_SECRET_BYTES];
    fill(&mut bytes).map_err(|e| PassShareError::Internal(e.to_string()))?;
    Ok(BASE64.encode(bytes))
}

pub fn encrypt(plaintext: &[u8], key: &MasterKey) -> Result<(Vec<u8>, [u8; 24]), PassShareError> {
    let cipher = XChaCha20Poly1305::new_from_slice(key.as_bytes())
        .map_err(|e| PassShareError::Internal(e.to_string()))?;
    let mut nonce = [0u8; 24];
    fill(&mut nonce).map_err(|e| PassShareError::Internal(e.to_string()))?;
    let ciphertext = cipher
        .encrypt(&XNonce::from(nonce), plaintext)
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
        .decrypt(&XNonce::from(*nonce), ciphertext)
        .map_err(|_| PassShareError::InvalidMasterPassword)
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
    fn stored_default_params_match_convenience_helper() {
        // Reading the default params from a header must derive the same key as the
        // constant-based helper — guarantees backward compatibility of existing files.
        let salt = generate_salt().unwrap();
        let a = derive_master_key("pw", &salt).unwrap();
        let b = derive_master_key_with_params(
            "pw",
            &salt,
            KDF_MEMORY_KIB,
            KDF_TIME_COST,
            KDF_PARALLELISM,
        )
        .unwrap();
        assert_eq!(a.as_bytes(), b.as_bytes());
    }

    #[test]
    fn weak_kdf_params_rejected() {
        let salt = generate_salt().unwrap();
        for (m, t, p) in [
            (1024, KDF_TIME_COST, KDF_PARALLELISM),
            (KDF_MEMORY_KIB, 1, KDF_PARALLELISM),
            (KDF_MEMORY_KIB, KDF_TIME_COST, 0),
        ] {
            assert!(matches!(
                derive_master_key_with_params("pw", &salt, m, t, p),
                Err(PassShareError::CorruptFile)
            ));
        }
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
