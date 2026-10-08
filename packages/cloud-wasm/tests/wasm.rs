#![cfg(target_arch = "wasm32")]
use passshare_cloud_wasm::CloudPasswordBox;
use serde_json::{json, Value};
use wasm_bindgen_test::wasm_bindgen_test;

#[wasm_bindgen_test]
fn exported_wasm_boundary_encrypts_restores_and_locks() {
    let owner = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1}).to_string();
    let context = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":1,"keyEpoch":1}).to_string();
    let item = json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","version":1,"vault":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa"},"fields":[{"value":"Synthetic WASM private value"}],"unknown":{"keep":[1,2,3]},"urls":[{"href":"https://example.test/one"},{"href":"https://example.test/two"}]}).to_string();
    let mut session = CloudPasswordBox::new(&owner).unwrap();
    let encrypted = session.encrypt_item(item.clone(), &context).unwrap();
    assert!(!encrypted.contains("Synthetic WASM private value"));
    assert_ne!(
        encrypted,
        session.encrypt_item(item.clone(), &context).unwrap()
    );
    let bundle = session
        .wrap_for_owner("Synthetic WASM encryption password!".into())
        .unwrap();
    let original: Value = serde_json::from_str(&bundle).unwrap();
    for field in ["format", "salt", "unknown"] {
        let mut altered = original.clone();
        altered[field] = match field {
            "format" => json!(2),
            "salt" => json!("AAAAAAAAAAAAAAAAAAAAAA=="),
            _ => json!(true),
        };
        assert!(CloudPasswordBox::unlock(
            &altered.to_string(),
            "Synthetic WASM encryption password!".into(),
            &owner
        )
        .is_err());
    }
    session.lock();
    assert!(session.is_locked());
    assert!(session.decrypt_item(&encrypted, &context).is_err());
    let mut restored = CloudPasswordBox::unlock(
        &bundle,
        "Synthetic WASM encryption password!".into(),
        &owner,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(
            &restored
                .decrypt_item(&encrypted, &context)
                .unwrap()
                .as_string()
                .unwrap()
        )
        .unwrap(),
        serde_json::from_str::<Value>(&item).unwrap()
    );
    assert!(
        CloudPasswordBox::unlock(&bundle, "Wrong synthetic WASM password!".into(), &owner).is_err()
    );
    assert!(restored
        .decrypt_item(
            &encrypted,
            &context.replace("\"itemVersion\":1", "\"itemVersion\":2")
        )
        .is_err());
    restored.lock();
    assert!(restored.encrypt_item(item, &context).is_err());
    assert!(restored
        .wrap_for_owner("Synthetic WASM encryption password!".into())
        .is_err());
}

#[wasm_bindgen_test]
fn fixed_format1_bundle_works_in_real_wasm() {
    let fixture: Value = serde_json::from_str(include_str!("format1-vector.json")).unwrap();
    let session = CloudPasswordBox::unlock(
        &fixture["bundle"].to_string(),
        "Synthetic format1 e\u{301} password!".into(),
        &fixture["owner"].to_string(),
    )
    .unwrap();
    let body = session
        .decrypt_item(
            &fixture["envelope"].to_string(),
            &fixture["context"].to_string(),
        )
        .unwrap()
        .as_string()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        fixture["item"]
    );
}
