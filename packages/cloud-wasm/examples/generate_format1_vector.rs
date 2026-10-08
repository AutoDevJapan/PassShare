//! Generate a public synthetic compatibility fixture; never run on user data.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use passshare_core::{
    cloud_crypto::{ItemContext, OwnerKeyContext, PasswordBoxKey},
    crypto::derive_master_key_with_params,
};
use serde_json::json;
fn main() {
    let owner: OwnerKeyContext = serde_json::from_value(json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1})).unwrap();
    let context: ItemContext = serde_json::from_value(json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":1,"keyEpoch":1})).unwrap();
    let item = json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","version":1,"vault":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa"},"title":"Public format1 compatibility fixture","extra":{"keep":[1,2,3]}});
    let key = PasswordBoxKey::generate().unwrap();
    let salt = [37u8; 16];
    let root = derive_master_key_with_params("Synthetic format1 é password!", &salt, 65_536, 3, 4)
        .unwrap();
    let wrapped = key.wrap_for_owner(&root, &owner).unwrap();
    let envelope = key.encrypt_item(&item, &context).unwrap();
    let fixture = json!({"owner":owner,"context":context,"item":item,"bundle":{"format":1,"salt":B64.encode(salt),"wrapped":wrapped},"envelope":envelope});
    std::fs::write(
        "packages/cloud-wasm/tests/format1-vector.json",
        serde_json::to_vec_pretty(&fixture).unwrap(),
    )
    .unwrap();
}
