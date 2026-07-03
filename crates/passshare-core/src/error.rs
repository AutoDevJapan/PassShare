use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PassShareError {
    #[error("PS001: マスターパスワードが正しくありません")]
    InvalidMasterPassword,

    #[error("PS002: パスワードボックスファイルが見つかりません")]
    FileNotFound,

    #[error("PS003: ファイルが壊れているか、別のパスワードボックスです")]
    CorruptFile,

    #[error("PS004: タイトルは必須です")]
    TitleRequired,

    #[error("PS005: パスワードは必須です")]
    PasswordRequired,

    #[error("PS006: パスワードボックスは閉じています")]
    BoxLocked,

    #[error("PS007: ログイン情報が見つかりません")]
    ItemNotFound,

    #[error("PS008: 内部エラー: {0}")]
    Internal(String),

    #[error("PS009: ID 形式が正しくありません")]
    InvalidConnectId,

    #[error("PS010: インポートに失敗しました: {0}")]
    ImportError(String),
}

impl From<argon2::Error> for PassShareError {
    fn from(value: argon2::Error) -> Self {
        Self::Internal(value.to_string())
    }
}

impl From<chacha20poly1305::Error> for PassShareError {
    fn from(value: chacha20poly1305::Error) -> Self {
        Self::Internal(value.to_string())
    }
}

impl From<std::io::Error> for PassShareError {
    fn from(value: std::io::Error) -> Self {
        if value.kind() == std::io::ErrorKind::NotFound {
            Self::FileNotFound
        } else {
            Self::Internal(value.to_string())
        }
    }
}

// Intentionally no blanket `From<serde_json::Error>`: the same error type is
// produced by both serialization (writing our own data — a bug, → Internal) and
// deserialization (reading untrusted bytes — → CorruptFile). A blanket impl
// would mislabel serialize bugs as "corrupt file". Each call site maps
// explicitly so the direction — and therefore the surfaced error — is correct.
