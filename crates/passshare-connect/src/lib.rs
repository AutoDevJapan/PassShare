mod client;
mod encrypted_client;
mod error;
mod op_ref;

pub use client::ConnectClient;
pub use encrypted_client::{
    AccountIdentityBundle, AccountIdentityRecord, BoxState, EncryptedSessionClient,
    EncryptedSessionError, EncryptedSessionResult, ItemPage, ItemSummary, OwnerKeyBundle,
    OwnerKeyRecord,
};
pub use error::{ConnectError, ConnectResult};
pub use op_ref::{parse_op_reference, OpReference};
pub use passshare_core::cloud_crypto::{
    AccountIdentityContext, EncryptedItem, OwnerKeyContext, PublicAccountIdentity,
    WrappedAccountIdentity, WrappedPasswordBoxKey,
};

pub use passshare_core::domain::item::Item;
pub use passshare_core::domain::vault::Vault;

pub use error::ItemOverview;
