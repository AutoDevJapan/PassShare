#![cfg(target_arch = "wasm32")]
use passshare_core::{
    cloud_crypto::{
        AccountIdentity, AccountIdentityContext, ItemContext, PasswordBoxKey, SharedKeyContext,
    },
    crypto::MasterKey,
};
use serde_json::json;
use uuid::Uuid;
use wasm_bindgen_test::wasm_bindgen_test;

fn identity() -> AccountIdentity {
    AccountIdentity::generate(AccountIdentityContext {
        account_id: Uuid::new_v4(),
        identity_version: 1,
    })
    .unwrap()
}
fn context(a: &AccountIdentity, b: &AccountIdentity, epoch: u64) -> SharedKeyContext {
    let (sender, recipient) = (a.public_identity(), b.public_identity());
    SharedKeyContext {
        password_box_id: "aaaaaaaaaaaaaaaaaaaaaaaaaa".parse().unwrap(),
        sender_account_id: sender.account_id,
        recipient_account_id: recipient.account_id,
        key_epoch: epoch,
        sender_identity_version: sender.identity_version,
        recipient_identity_version: recipient.identity_version,
        sender_key_id: sender.key_id,
        recipient_key_id: recipient.key_id,
    }
}

#[wasm_bindgen_test]
fn actual_wasm_shares_restores_and_excludes_old_member_from_new_epoch() {
    let (a, b, c) = (identity(), identity(), identity());
    let old = PasswordBoxKey::generate().unwrap();
    let ab = context(&a, &b, 1);
    let wrapped = old
        .wrap_for_recipient(&a, &b.public_identity(), &ab)
        .unwrap();
    let b_old =
        PasswordBoxKey::unwrap_for_recipient(&wrapped, &b, &a.public_identity(), &ab).unwrap();
    let item_context = ItemContext {
        password_box_id: ab.password_box_id.clone(),
        item_id: "bbbbbbbbbbbbbbbbbbbbbbbbbb".parse().unwrap(),
        item_version: 1,
        key_epoch: 1,
    };
    let item = json!({"id":item_context.item_id,"version":1,"vault":{"id":item_context.password_box_id},"extra":{"keep":[3,1,2]},"fields":[{"value":"Public synthetic shared WASM value"}]});
    let encrypted = old.encrypt_item(&item, &item_context).unwrap();
    assert_eq!(b_old.decrypt_item(&encrypted, &item_context).unwrap(), item);
    assert!(PasswordBoxKey::unwrap_for_recipient(&wrapped, &c, &a.public_identity(), &ab).is_err());
    assert!(PasswordBoxKey::unwrap_for_recipient(&wrapped, &b, &c.public_identity(), &ab).is_err());

    let root = MasterKey::generate().unwrap();
    let local = a.wrap(&root).unwrap();
    let restored =
        AccountIdentity::unwrap(&local, &root, a.context(), &a.public_identity().key_id).unwrap();
    assert_eq!(restored.public_identity(), a.public_identity());
    assert!(
        AccountIdentity::unwrap(&local, &root, a.context(), &c.public_identity().key_id).is_err()
    );
    let fresh = PasswordBoxKey::generate().unwrap();
    let ac = context(&restored, &c, 2);
    let c_bundle = fresh
        .wrap_for_recipient(&restored, &c.public_identity(), &ac)
        .unwrap();
    let c_new =
        PasswordBoxKey::unwrap_for_recipient(&c_bundle, &c, &restored.public_identity(), &ac)
            .unwrap();
    let new_context = ItemContext {
        key_epoch: 2,
        ..item_context.clone()
    };
    let current = fresh.encrypt_item(&item, &new_context).unwrap();
    assert_eq!(c_new.decrypt_item(&current, &new_context).unwrap(), item);
    assert!(b_old.decrypt_item(&current, &new_context).is_err());
    assert!(
        PasswordBoxKey::unwrap_for_recipient(&c_bundle, &b, &restored.public_identity(), &ac)
            .is_err()
    );
    assert_eq!(b_old.decrypt_item(&encrypted, &item_context).unwrap(), item);
}
