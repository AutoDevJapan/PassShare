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
    exported_worker_sharing_contract(&mut send);
    remove_worker_surface();
}

// Reuse the installed real start_worker boundary: STARTED intentionally permits
// only one attachment per WASM instance. No host dispatcher substitute is used.
fn exported_worker_sharing_contract(send: &mut impl FnMut(Value) -> Value) {
    use passshare_cloud_wasm::CloudAccountIdentity;
    const INVALID: &str = "PS051: Invalid encrypted data";
    const OPEN: &str = "PS059: Password box is already open";
    const STALE: &str = "PS058: Stale worker generation";
    const SECRET: &str = "Synthetic identity worker password!";
    let a = json!({"accountId":"11111111-1111-4111-8111-111111111111","identityVersion":1});
    let b = json!({"accountId":"22222222-2222-4222-8222-222222222222","identityVersion":1});
    let owner = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","ownerAccountId":a["accountId"],"keyEpoch":1});
    let ctx = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":1,"keyEpoch":1});
    let item = json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","version":1,"vault":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa"},
        "fields":[{"value":"worker-sharing-private"}],"custom":{"keep":[3,1,2]},"attachments":[{"id":"z"},{"id":"a"}]});
    let mut recipient = CloudAccountIdentity::new(&b.to_string()).unwrap();
    let recipient_public: Value =
        serde_json::from_str(&recipient.public_identity().unwrap()).unwrap();
    // Pin the generated public descriptor before producing any sealed bundle.
    let pin_b = recipient_public["keyId"].as_str().unwrap().to_owned();
    let bundle_b = recipient.wrap(SECRET.into()).unwrap();
    recipient.lock();
    let mut g = send(json!({"command":"status"}))["generation"]
        .as_u64()
        .unwrap();
    let generated = send(
        json!({"command":"identityGenerate","expectedGeneration":g,"accountContext":a.to_string()}),
    );
    assert_eq!(generated["ok"], true);
    assert_eq!(generated["locked"], true);
    assert_eq!(generated["identityLocked"], false);
    g += 1;
    let sender_public: Value =
        serde_json::from_str(generated["publicIdentity"].as_str().unwrap()).unwrap();
    let pin_a = sender_public["keyId"].as_str().unwrap().to_owned();
    let grouped_code = pin_a
        .as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap().to_uppercase())
        .collect::<Vec<_>>()
        .join(" \n");
    let verify = json!({"command":"verifyPublicIdentity","expectedGeneration":g,
        "accountContext":a.to_string(),"publicIdentity":generated["publicIdentity"],"verificationCode":grouped_code});
    assert_eq!(
        send(verify.clone())["publicIdentity"],
        generated["publicIdentity"]
    );
    let mut mismatch = verify.clone();
    mismatch["verificationCode"] = json!("0".repeat(64));
    assert_eq!(send(mismatch)["error"], INVALID);
    let mut bad = verify.clone();
    bad["verificationCode"] = Value::Null;
    assert_eq!(send(bad)["ok"], false);
    let mut changed = verify.clone();
    changed["publicIdentity"] = json!(CloudAccountIdentity::new(&a.to_string())
        .unwrap()
        .public_identity()
        .unwrap());
    assert_eq!(send(changed)["error"], INVALID);
    let mut duplicate = verify;
    duplicate["publicIdentity"] = json!(generated["publicIdentity"]
        .as_str()
        .unwrap()
        .replace("\"keyId\":", "\"unknown\":1,\"keyId\":"));
    assert_eq!(send(duplicate)["error"], INVALID);
    assert_eq!(
        send(json!({"command":"identityPublic","expectedGeneration":g}))["publicIdentity"],
        generated["publicIdentity"]
    );
    let bundle_a =
        send(json!({"command":"identityWrap","expectedGeneration":g,"identitySecret":SECRET}))
            ["bundle"]
            .as_str()
            .unwrap()
            .to_owned();
    assert!(!bundle_a.contains(SECRET));
    assert_eq!(
        send(
            json!({"command":"encrypt","expectedGeneration":g,"context":ctx.to_string(),"item":item.to_string()})
        )["error"],
        "PS057: Password box is locked"
    );
    let mut wrong_owner = owner.clone();
    wrong_owner["ownerAccountId"] = b["accountId"].clone();
    let bad =
        send(json!({"command":"generate","expectedGeneration":g,"owner":wrong_owner.to_string()}));
    assert_eq!(bad["error"], INVALID);
    assert_eq!(bad["generation"], g);
    assert_eq!(
        send(
            json!({"command":"identityGenerate","expectedGeneration":g,"accountContext":b.to_string()})
        )["error"],
        OPEN
    );
    assert_eq!(
        send(json!({"command":"generate","expectedGeneration":g,"owner":owner.to_string()}))["ok"],
        true
    );
    g += 1;
    let ciphertext = send(json!({"command":"encrypt","expectedGeneration":g,"context":ctx.to_string(),"item":item.to_string()}))["envelope"].as_str().unwrap().to_owned();
    let owner_bundle = send(json!({"command":"wrap","expectedGeneration":g,"password":SECRET}))
        ["bundle"]
        .as_str()
        .unwrap()
        .to_owned();
    // Every expected value is selected independently, not read from an envelope.
    let shared = json!({"passwordBoxId":owner["passwordBoxId"],"senderAccountId":a["accountId"],
        "recipientAccountId":b["accountId"],"keyEpoch":1,"senderIdentityVersion":1,"recipientIdentityVersion":1,
        "senderKeyId":pin_a,"recipientKeyId":pin_b});
    let wrap = json!({"command":"sharedRecipientWrap","expectedGeneration":g,
        "trustedRecipientPublic":recipient_public.to_string(),"sharedContext":shared.to_string()});
    let sealed = send(wrap.clone());
    assert_eq!(sealed["ok"], true);
    assert!(!sealed.to_string().contains("worker-sharing-private"));
    let shared_envelope = sealed["envelope"].as_str().unwrap().to_owned();
    let replacement = CloudAccountIdentity::new(&a.to_string()).unwrap();
    let replacement_public = replacement.public_identity().unwrap();
    let replacement_bundle = replacement.wrap(SECRET.into()).unwrap();
    let replacement_recipient = CloudAccountIdentity::new(&b.to_string()).unwrap();
    let mut bad_wrap = wrap.clone();
    bad_wrap["trustedRecipientPublic"] = json!(replacement_recipient.public_identity().unwrap());
    assert_eq!(send(bad_wrap)["error"], INVALID);
    for (field, value) in [
        ("passwordBoxId", json!("cccccccccccccccccccccccccc")),
        ("senderAccountId", b["accountId"].clone()),
        ("recipientAccountId", a["accountId"].clone()),
        ("keyEpoch", json!(2)),
        ("senderIdentityVersion", json!(2)),
        ("recipientIdentityVersion", json!(2)),
        ("senderKeyId", json!("0".repeat(64))),
        ("recipientKeyId", json!("0".repeat(64))),
    ] {
        let mut changed = shared.clone();
        changed[field] = value;
        let mut request = wrap.clone();
        request["sharedContext"] = json!(changed.to_string());
        assert_eq!(send(request)["error"], INVALID);
    }
    let receive = json!({"command":"sharedReceiveUnlock","expectedGeneration":g,
        "envelope":shared_envelope,"trustedSenderPublic":sender_public.to_string(),"sharedContext":shared.to_string()});
    assert_eq!(send(receive.clone())["error"], OPEN);
    worker_strict_shared_inputs(send, &wrap, g);
    // Replayed/late lock is accepted even with requestId below the high-water mark.
    let late_lock = r#"{"version":1,"requestId":1,"command":"lock"}"#;
    let locked: Value = serde_json::from_str(&worker_exchange(late_lock)).unwrap();
    g += 1;
    assert_eq!(locked["generation"], g);
    assert_eq!(locked["locked"], true);
    assert_eq!(locked["identityLocked"], true);
    assert_eq!(send(wrap.clone())["error"], STALE);
    let replay: Value = serde_json::from_str(&worker_exchange(late_lock)).unwrap();
    g += 1;
    assert_eq!(replay["generation"], g);
    assert_eq!(
        send(json!({"command":"identityPublic","expectedGeneration":g}))["error"],
        "PS057: Account identity is locked"
    );
    let mut restore = json!({"command":"identityUnlock","expectedGeneration":g,"accountContext":a.to_string(),
        "expectedKeyId":pin_a,"bundle":bundle_a,"identitySecret":SECRET});
    let mut bad = restore.clone();
    bad["bundle"] = json!(replacement_bundle);
    assert_eq!(send(bad)["error"], INVALID); // same account/version, different pinned key
    for (field, value) in [
        ("accountContext", json!(b.to_string())),
        ("expectedKeyId", json!(pin_b)),
        ("identitySecret", json!("Wrong worker identity password!")),
    ] {
        let mut bad = restore.clone();
        bad[field] = value;
        let reply = send(bad);
        assert_eq!(reply["error"], INVALID);
        assert_eq!(reply["generation"], g);
        assert_eq!(reply["identityLocked"], true);
        assert!(!reply.to_string().contains("password!"));
    }
    assert_eq!(send(restore.clone())["ok"], true);
    g += 1;
    restore["expectedGeneration"] = json!(g);
    assert_eq!(send(restore)["error"], OPEN);
    // Owner restoration binds to the open identity, even if the bundle itself is valid.
    assert_eq!(
        send(
            json!({"command":"unlock","expectedGeneration":g,"owner":wrong_owner.to_string(),"bundle":owner_bundle,"password":SECRET})
        )["error"],
        INVALID
    );
    assert_eq!(
        send(
            json!({"command":"unlock","expectedGeneration":g,"owner":owner.to_string(),"bundle":owner_bundle,"password":SECRET})
        )["ok"],
        true
    );
    g += 1;
    assert_eq!(
        send(
            json!({"command":"decrypt","expectedGeneration":g,"context":ctx.to_string(),"envelope":ciphertext})
        )["ok"],
        true
    );
    send(json!({"command":"lock"}));
    g += 1;
    assert_eq!(
        send(
            json!({"command":"identityUnlock","expectedGeneration":g,"accountContext":b.to_string(),
        "expectedKeyId":pin_b,"bundle":bundle_b,"identitySecret":SECRET})
        )["ok"],
        true
    );
    g += 1;
    let mut receive = receive;
    receive["expectedGeneration"] = json!(g);
    let mut bad = receive.clone();
    bad["trustedSenderPublic"] = json!(replacement_public);
    assert_eq!(send(bad)["error"], INVALID);
    for (field, value) in [
        ("passwordBoxId", json!("cccccccccccccccccccccccccc")),
        ("keyEpoch", json!(2)),
        ("recipientAccountId", a["accountId"].clone()),
        ("senderKeyId", json!("0".repeat(64))),
    ] {
        let mut changed = shared.clone();
        changed[field] = value;
        let mut bad = receive.clone();
        bad["sharedContext"] = json!(changed.to_string());
        let reply = send(bad);
        assert_eq!(reply["error"], INVALID);
        assert_eq!(reply["generation"], g);
        assert_eq!(reply["identityLocked"], false);
        assert_eq!(reply["locked"], true);
    }
    let mut bad = receive.clone();
    bad["envelope"] = json!(owner_bundle);
    assert_eq!(send(bad)["error"], INVALID); // reject owner wrapping used as HPKE envelope
    assert_eq!(send(receive.clone())["ok"], true);
    g += 1;
    let decrypted = send(
        json!({"command":"decrypt","expectedGeneration":g,"context":ctx.to_string(),"envelope":ciphertext}),
    );
    assert_eq!(
        serde_json::from_str::<Value>(decrypted["item"].as_str().unwrap()).unwrap(),
        item
    );
    assert_eq!(
        send(json!({"command":"wrap","expectedGeneration":g,"password":SECRET}))["error"],
        INVALID
    );
    assert_eq!(
        send(json!({"command":"recoveryMaterial","expectedGeneration":g}))["error"],
        INVALID
    );
    receive["expectedGeneration"] = json!(g);
    assert_eq!(send(receive.clone())["error"], OPEN);
    assert_eq!(
        send(json!({"command":"generate","expectedGeneration":g,"owner":owner.to_string()}))
            ["error"],
        OPEN
    );
    let lock = send(json!({"command":"lock"}));
    g += 1;
    assert_eq!(lock["identityLocked"], true);
    assert_eq!(lock["locked"], true);
    assert_eq!(send(receive.clone())["error"], STALE);
    receive["expectedGeneration"] = json!(g);
    assert_eq!(send(receive)["error"], "PS057: Account identity is locked");
    assert_eq!(
        send(
            json!({"command":"decrypt","expectedGeneration":g,"context":ctx.to_string(),"envelope":ciphertext})
        )["error"],
        "PS057: Password box is locked"
    );
    let mut wrap = wrap;
    wrap["expectedGeneration"] = json!(g);
    assert_eq!(send(wrap)["error"], "PS057: Password box is locked");
}

fn worker_strict_shared_inputs(send: &mut impl FnMut(Value) -> Value, wrap: &Value, g: u64) {
    const INVALID: &str = "PS051: Invalid encrypted data";
    for command in [
        "identityGenerate",
        "identityPublic",
        "identityWrap",
        "identityUnlock",
        "sharedRecipientWrap",
        "sharedReceiveUnlock",
    ] {
        let request = match command {
            "identityGenerate" => {
                json!({"command":command,"expectedGeneration":g,"accountContext":"{}"})
            }
            "identityPublic" => json!({"command":command,"expectedGeneration":g}),
            "identityWrap" => {
                json!({"command":command,"expectedGeneration":g,"identitySecret":"Synthetic identity password!"})
            }
            "identityUnlock" => {
                json!({"command":command,"expectedGeneration":g,"accountContext":"{}","bundle":"{}","expectedKeyId":"0".repeat(64),"identitySecret":"Synthetic identity password!"})
            }
            "sharedRecipientWrap" => wrap.clone(),
            _ => {
                json!({"command":command,"expectedGeneration":g,"envelope":"{}","trustedSenderPublic":"{}","sharedContext":"{}"})
            }
        };
        for key in request
            .as_object()
            .unwrap()
            .keys()
            .filter(|k| k.as_str() != "command")
        {
            let mut missing = request.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert_eq!(send(missing)["error"], INVALID);
            for value in [Value::Null, json!(false)] {
                let mut bad = request.clone();
                bad[key] = value;
                assert_eq!(send(bad)["error"], INVALID);
            }
        }
        for key in ["unknown", "owner", "password", "item"] {
            let mut bad = request.clone();
            bad[key] = json!("worker-no-secret-echo");
            let reply = send(bad);
            assert_eq!(reply["error"], INVALID);
            assert!(!reply.to_string().contains("worker-no-secret-echo"));
        }
        let mut duplicate = request.clone();
        duplicate["version"] = json!(1);
        duplicate["requestId"] = json!(9_007_199_254_740_000u64);
        let text = duplicate.to_string();
        let text = format!("{{\"command\":\"{command}\",{}", &text[1..]);
        let reply: Value = serde_json::from_str(&worker_exchange(&text)).unwrap();
        assert_eq!(reply["error"], INVALID);
        assert_eq!(reply["requestId"], Value::Null);
    }
    for (key, limit) in [("sharedContext", 1024), ("trustedRecipientPublic", 512)] {
        let mut bad = wrap.clone();
        bad[key] = json!("x".repeat(limit + 1));
        assert_eq!(send(bad)["error"], INVALID);
    }
    let oversized = format!("{{\"private\":\"{}\"}}", "x".repeat(6 * 1024 * 1024 + 4096));
    let reply: Value = serde_json::from_str(&worker_exchange(&oversized)).unwrap();
    assert_eq!(reply["error"], INVALID);
    // Reuse the most recent id and otherwise valid request; dispatcher rejects replay.
    let reply = send(wrap.clone());
    assert_eq!(reply["ok"], true);
    let mut replay = wrap.clone();
    replay["version"] = json!(1);
    replay["requestId"] = reply["requestId"].clone();
    let replay: Value = serde_json::from_str(&worker_exchange(&replay.to_string())).unwrap();
    assert_eq!(replay["error"], INVALID);
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
