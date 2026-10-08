//! Generate a public synthetic compatibility fixture; never run on user data.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use passshare_core::{
    cloud_crypto::{ItemContext, OwnerKeyContext, PasswordBoxKey},
    crypto::{derive_master_key_with_params, generate_salt},
};
use serde_json::json;
fn main() {
    let password = std::env::args()
        .nth(1)
        .expect("public synthetic fixture password required");
    let destination = std::env::args()
        .nth(2)
        .expect("new fixture output path required");
    assert!(
        !std::path::Path::new(&destination).exists(),
        "existing compatibility fixtures are immutable"
    );
    let owner: OwnerKeyContext = serde_json::from_value(json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1})).unwrap();
    let context: ItemContext = serde_json::from_value(json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":1,"keyEpoch":1})).unwrap();
    let item = json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","version":1,"vault":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa"},"title":"Public format1 compatibility fixture","extra":{"keep":[1,2,3]}});
    let key = PasswordBoxKey::generate().unwrap();
    let salt = generate_salt().unwrap();
    let root = derive_master_key_with_params(&password, &salt, 65_536, 3, 4).unwrap();
    let wrapped = key.wrap_for_owner(&root, &owner).unwrap();
    let envelope = key.encrypt_item(&item, &context).unwrap();
    let fixture = json!({"owner":owner,"context":context,"item":item,"bundle":{"format":1,"salt":B64.encode(salt),"wrapped":wrapped},"envelope":envelope});
    std::fs::write(destination, serde_json::to_vec_pretty(&fixture).unwrap()).unwrap();
}
