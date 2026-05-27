use crate::domain::item::Item;
use crate::domain::login_item::LoginItem;
use crate::domain::payload::{LegacyPasswordBoxPayload, PasswordBoxPayload};
use crate::domain::vault::Vault;
use crate::error::PassShareError;

pub fn migrate_legacy_payload(
    legacy: LegacyPasswordBoxPayload,
    vault_name: &str,
) -> Result<PasswordBoxPayload, PassShareError> {
    let mut vault = Vault::new(vault_name)?;
    let mut items = Vec::with_capacity(legacy.items.len());
    for login in legacy.items {
        items.push(Item::from_login_item(login, &vault)?);
    }
    vault.refresh_item_count(items.len() as u32);
    Ok(PasswordBoxPayload {
        payload_version: crate::domain::payload::PAYLOAD_VERSION_V2,
        vault,
        items,
        recovery_secret: legacy.recovery_secret,
    })
}

pub fn migrate_login_items(
    logins: Vec<LoginItem>,
    vault_name: &str,
    recovery_secret: Option<String>,
) -> Result<PasswordBoxPayload, PassShareError> {
    migrate_legacy_payload(
        LegacyPasswordBoxPayload {
            items: logins,
            recovery_secret,
        },
        vault_name,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_payload_migrates_all_fields() {
        let login = LoginItem::new("Site", "pwd")
            .unwrap()
            .with_optional_fields(
                Some("https://example.com".into()),
                Some("user".into()),
                Some("note".into()),
            );
        let payload = migrate_legacy_payload(
            LegacyPasswordBoxPayload {
                items: vec![login],
                recovery_secret: Some("recovery".into()),
            },
            "My Box",
        )
        .unwrap();

        assert_eq!(payload.payload_version, 2);
        assert_eq!(payload.items.len(), 1);
        assert_eq!(payload.recovery_secret.as_deref(), Some("recovery"));
        let item = &payload.items[0];
        assert_eq!(item.title, "Site");
        assert_eq!(
            item.field_value_by_purpose(crate::domain::field::FieldPurpose::Password),
            Some("pwd".into())
        );
    }
}
