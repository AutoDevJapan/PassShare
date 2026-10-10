#![cfg(target_arch = "wasm32")]
use passshare_cloud_wasm::CloudPasswordBox;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::wasm_bindgen_test;

// Node has no DedicatedWorkerGlobalScope. This transport fixture supplies only
// its message surface; start_worker and all dispatch/crypto run in exported WASM.
#[wasm_bindgen(inline_js = "
let replies = [];
export function install_worker_surface() {
  globalThis.DedicatedWorkerGlobalScope = class {
    static [Symbol.hasInstance](value) { return value === globalThis; }
  };
  globalThis.postMessage = (reply) => replies.push(reply);
}
export function worker_exchange(message) {
  globalThis.onmessage({ data: message });
  return replies.pop();
}
export function worker_ready() { return replies.pop(); }
export function remove_worker_surface() {
  delete globalThis.onmessage;
  delete globalThis.postMessage;
  delete globalThis.DedicatedWorkerGlobalScope;
  replies = [];
}
")]
extern "C" {
    fn install_worker_surface();
    fn worker_exchange(message: &str) -> String;
    fn worker_ready() -> String;
    fn remove_worker_surface();
}

#[wasm_bindgen_test]
fn exported_offline_recovery_keeps_the_key_and_rejects_wrong_live_scope() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use passshare_core::crypto::MasterKey;
    use zeroize::Zeroizing;
    let owner = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1});
    let context = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":1,"keyEpoch":1});
    let item = json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","version":1,"vault":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa"},"fields":[],"extra":{"keep":[1,2,3]},"urls":[{"href":"https://example.invalid/one"},{"href":"https://example.invalid/two"}]});
    let mut key = CloudPasswordBox::new(&owner.to_string()).unwrap();
    let envelope = key
        .encrypt_item(item.to_string(), &context.to_string())
        .unwrap();
    let material = Zeroizing::new(key.create_recovery_material().unwrap().as_string().unwrap());
    let mut transfer: Value = serde_json::from_str(&material).unwrap();
    let code = Zeroizing::new(transfer["recoveryCode"].as_str().unwrap().to_owned());
    // The transfer is test-only; do not retain its extra plaintext copy.
    if let Value::String(text) = &mut transfer["recoveryCode"] {
        use zeroize::Zeroize;
        text.zeroize();
    }
    let bundle = transfer["bundle"].to_string();
    key.lock();
    assert!(key.create_recovery_material().is_err());
    let mut restored =
        CloudPasswordBox::recover(&bundle, code.to_string(), &owner.to_string()).unwrap();
    let got = restored
        .decrypt_item(&envelope, &context.to_string())
        .unwrap()
        .as_string()
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&got).unwrap(), item);
    let new_password = Zeroizing::new(STANDARD.encode(MasterKey::generate().unwrap().as_bytes()));
    let rewrapped = restored.wrap_for_owner(new_password.to_string()).unwrap();
    restored.lock();
    let new_key =
        CloudPasswordBox::unlock(&rewrapped, new_password.to_string(), &owner.to_string()).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(
            &new_key
                .decrypt_item(&envelope, &context.to_string())
                .unwrap()
                .as_string()
                .unwrap()
        )
        .unwrap(),
        item
    );
    let mut stale = owner.clone();
    stale["keyEpoch"] = json!(2);
    assert!(CloudPasswordBox::recover(&bundle, code.to_string(), &stale.to_string()).is_err());
    let wrong = STANDARD.encode(MasterKey::generate().unwrap().as_bytes());
    assert!(CloudPasswordBox::recover(&bundle, wrong, &owner.to_string()).is_err());
}

#[wasm_bindgen_test]
fn exported_worker_create_edit_node_boundary() {
    install_worker_surface();
    passshare_cloud_wasm::start_worker().unwrap();
    let ready: Value = serde_json::from_str(&worker_ready()).unwrap();
    assert_eq!(ready["locked"], true);
    let mut id = 0;
    let mut send = |mut message: Value| -> Value {
        id += 1;
        message["version"] = json!(1);
        message["requestId"] = json!(id);
        serde_json::from_str(&worker_exchange(&message.to_string())).unwrap()
    };
    let owner = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1});
    assert_eq!(
        send(json!({"command":"generate","expectedGeneration":0,"owner":owner.to_string()}))["ok"],
        true
    );
    let values = json!({"title":"Node item","category":"LOGIN","username":"user","password":"node-private",
        "url":"https://example.test/", "body":"","notes":"","tags":"","favorite":false});
    let reply =
        send(json!({"command":"create","expectedGeneration":1,"values":values.to_string()}));
    assert_eq!(reply["ok"], true);
    assert!(!reply.to_string().contains("node-private"));
    let envelope: Value = serde_json::from_str(reply["envelope"].as_str().unwrap()).unwrap();
    let mut context = envelope["context"].clone();
    let body = send(
        json!({"command":"decrypt","expectedGeneration":1,"context":context.to_string(),"envelope":reply["envelope"]}),
    );
    let mut original: Value = serde_json::from_str(body["item"].as_str().unwrap()).unwrap();
    original["attachments"] = json!([{"id":"z"},{"id":"a"}]);
    original["custom"] = json!({"optional":null,"order":[3,1,2]});
    let mut values = values;
    values["title"] = json!("Node changed");
    context["itemVersion"] = json!(2);
    let edited = send(
        json!({"command":"edit","expectedGeneration":1,"context":context.to_string(),
        "item":original.to_string(),"values":values.to_string()}),
    );
    assert_eq!(edited["generation"], 1);
    assert_eq!(edited["locked"], false);
    let body = send(
        json!({"command":"decrypt","expectedGeneration":1,"context":context.to_string(),"envelope":edited["envelope"]}),
    );
    original["title"] = json!("Node changed");
    original["version"] = json!(2);
    assert_eq!(
        serde_json::from_str::<Value>(body["item"].as_str().unwrap()).unwrap(),
        original
    );
    values["id"] = json!("node-no-echo");
    let rejected =
        send(json!({"command":"create","expectedGeneration":1,"values":values.to_string()}));
    assert_eq!(rejected["error"], "PS051: Invalid encrypted data");
    assert!(!rejected.to_string().contains("node-no-echo"));
    let bundle = send(
        json!({"command":"wrap","expectedGeneration":1,"password":"Synthetic Node password!"}),
    );
    send(json!({"command":"lock"}));
    let wrong = send(
        json!({"command":"unlock","expectedGeneration":2,"owner":owner.to_string(),
        "bundle":bundle["bundle"],"password":"Wrong Node password!"}),
    );
    assert_eq!(wrong["ok"], false);
    assert_eq!(wrong["locked"], true);
    assert!(!wrong.to_string().contains("Wrong Node password!"));
    assert_eq!(
        send(json!({"command":"create","expectedGeneration":2,"values":values.to_string()}))
            ["error"],
        "PS057: Password box is locked"
    );
    remove_worker_surface();
}

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
