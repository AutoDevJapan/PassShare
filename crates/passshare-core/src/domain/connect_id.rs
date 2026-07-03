use std::fmt;
use std::str::FromStr;

use getrandom::fill;
use serde::{Deserialize, Serialize};

use crate::error::PassShareError;

const ID_LEN: usize = 26;
const CHARSET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// 1Password Connect compatible ID: 26 lowercase alphanumeric characters.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ConnectId(String);

impl ConnectId {
    pub fn generate() -> Result<Self, PassShareError> {
        // Rejection sampling avoids the modulo bias of `byte % 36` (256 is not a
        // multiple of 36): draw fresh bytes and discard those at or above the
        // largest multiple of the charset size.
        const LIMIT: u8 = (256 / 36 * 36) as u8; // 252
        let mut id = String::with_capacity(ID_LEN);
        let mut buf = [0u8; ID_LEN];
        while id.len() < ID_LEN {
            fill(&mut buf).map_err(|e| PassShareError::Internal(e.to_string()))?;
            for &b in buf.iter() {
                if b < LIMIT {
                    id.push(CHARSET[(b as usize) % CHARSET.len()] as char);
                    if id.len() == ID_LEN {
                        break;
                    }
                }
            }
        }
        Ok(Self(id))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn validate(value: &str) -> Result<(), PassShareError> {
        if value.len() != ID_LEN {
            return Err(PassShareError::InvalidConnectId);
        }
        if !value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
            return Err(PassShareError::InvalidConnectId);
        }
        Ok(())
    }
}

impl FromStr for ConnectId {
    type Err = PassShareError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::validate(value)?;
        Ok(Self(value.to_string()))
    }
}

impl fmt::Display for ConnectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for ConnectId {
    type Error = PassShareError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::validate(&value)?;
        Ok(Self(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_id_matches_pattern() {
        let id = ConnectId::generate().unwrap();
        assert_eq!(id.as_str().len(), 26);
        ConnectId::validate(id.as_str()).unwrap();
    }

    #[test]
    fn generated_ids_are_valid_and_unique_across_many() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            let id = ConnectId::generate().unwrap();
            ConnectId::validate(id.as_str()).unwrap();
            assert!(seen.insert(id.as_str().to_string()), "unexpected duplicate id");
        }
    }

    #[test]
    fn rejects_invalid_ids() {
        assert!(ConnectId::from_str("abc").is_err());
        assert!(ConnectId::from_str("ABCDEFGHIJKLMNOPQRSTUVWXY").is_err());
        assert!(ConnectId::from_str("abcdefghijklmnopqrstuvwxy!").is_err());
    }
}
