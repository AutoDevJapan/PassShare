#![cfg(target_arch = "wasm32")]
use base64::{engine::general_purpose::STANDARD, Engine as _};
use js_sys::{Array, Object, Reflect, Uint8Array};
use passshare_cloud_wasm::{CloudAccountIdentity, CloudPasswordBox};
use passshare_core::crypto::MasterKey;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::wasm_bindgen_test;
use zeroize::Zeroizing;

#[wasm_bindgen(inline_js = "
let reply;
export function install() {
 globalThis.DedicatedWorkerGlobalScope=class {static [Symbol.hasInstance](v){return v===globalThis;}};
 globalThis.postMessage=(v,transfers=[])=>{reply=structuredClone(v,{transfer:transfers});};
}
export function exchange(v,transfers) {globalThis.onmessage({data:structuredClone(v,{transfer:transfers})});return reply;}
")]
extern "C" {
    fn install();
    fn exchange(v: &JsValue, transfers: &Array) -> JsValue;
}
fn header(v: &JsValue) -> Value {
    let text = v.as_string().unwrap_or_else(|| {
        Reflect::get(v, &"message".into())
            .unwrap()
            .as_string()
            .unwrap()
    });
    serde_json::from_str(&text).unwrap()
}
struct Worker {
    id: u64,
    g: u64,
}
impl Worker {
    fn send(&mut self, mut request: Value, bytes: Option<&[u8]>) -> (Value, Option<Uint8Array>) {
        self.id += 1;
        request["version"] = json!(1);
        request["requestId"] = json!(self.id);
        if request["command"] != "lock" && request["command"] != "status" {
            request["expectedGeneration"] = json!(self.g);
        }
        self.raw(request, bytes)
    }
    fn raw(&mut self, request: Value, bytes: Option<&[u8]>) -> (Value, Option<Uint8Array>) {
        let transfers = Array::new();
        let message: JsValue = if let Some(bytes) = bytes {
            let bytes = Uint8Array::from(bytes);
            transfers.push(&bytes.buffer());
            let obj = Object::new();
            Reflect::set(&obj, &"message".into(), &request.to_string().into()).unwrap();
            Reflect::set(&obj, &"bytes".into(), &bytes).unwrap();
            obj.into()
        } else {
            request.to_string().into()
        };
        let output = exchange(&message, &transfers);
        let reply = header(&output);
        let bytes = if output.is_object() {
            Some(
                Reflect::get(&output, &"bytes".into())
                    .unwrap()
                    .unchecked_into::<Uint8Array>(),
            )
        } else {
            None
        };
        self.g = reply["generation"].as_u64().unwrap();
        (reply, bytes)
    }
}
fn source(key: &CloudPasswordBox, c: &Value, revision: u64) -> Value {
    let ctx = json!({"passwordBoxId":c["passwordBoxId"],"itemId":c["itemId"],"itemVersion":3,"keyEpoch":c["keyEpoch"]});
    let item = json!({"id":c["itemId"],"version":3,"vault":{"id":c["passwordBoxId"]},"attachments":[{"attachmentId":c["attachmentId"],"attachmentVersion":c["attachmentVersion"],"keyEpoch":c["keyEpoch"]}]});
    json!({"itemEnvelope":key.encrypt_item(item.to_string(),&ctx.to_string()).unwrap(),"expectedItemContext":ctx,"itemSnapshotRevision":revision,"attachmentSnapshotRevision":revision})
}
#[wasm_bindgen_test]
fn actual_start_worker_attachment_boundary_and_shared_scope() {
    let secret = Zeroizing::new(STANDARD.encode(MasterKey::generate().unwrap().as_bytes()));
    let owner = json!({"passwordBoxId":"a".repeat(26),"ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1});
    let mut key = CloudPasswordBox::new(&owner.to_string()).unwrap();
    let bundle = key.wrap_for_owner(secret.to_string()).unwrap();
    install();
    passshare_cloud_wasm::start_worker().unwrap();
    let mut worker = Worker { id: 0, g: 0 };
    assert!(worker.send(json!({"command":"unlock","owner":owner.to_string(),"bundle":bundle,"password":secret.as_str()}),None).0["ok"]==true);
    let ctx = json!({"passwordBoxId":"a".repeat(26),"itemId":"b".repeat(26),"attachmentId":"c".repeat(26),"attachmentVersion":1,"keyEpoch":1});
    let attachment_source = source(&key, &ctx, 17);
    // ArrayBuffer is an equally finite transferable input, not a JSON array.
    worker.id += 1;
    let array_buffer = Uint8Array::from(&[0u8, 255][..]).buffer();
    let message = Object::new();
    Reflect::set(&message,&"message".into(),&json!({"version":1,"requestId":worker.id,"expectedGeneration":worker.g,"command":"encryptAttachment","name":"","expectedAttachmentContext":ctx.to_string()}).to_string().into()).unwrap();
    Reflect::set(&message, &"bytes".into(), &array_buffer).unwrap();
    let transfers = Array::new();
    transfers.push(&array_buffer);
    assert!(
        header(&exchange(&message, &transfers))["ok"] == true && array_buffer.byte_length() == 0
    );
    let mut last = String::new();
    for bytes in [vec![], vec![0, 255, 128, 0, 1], vec![255; 1_048_576]] {
        let encrypted=worker.send(json!({"command":"encryptAttachment","name":"日本語🦀\0","expectedAttachmentContext":ctx.to_string()}),Some(&bytes)).0;
        assert!(encrypted["ok"] == true && encrypted.as_object().unwrap().len() == 7);
        let envelope = encrypted["envelope"].as_str().unwrap();
        let (r,got)=worker.send(json!({"command":"decryptAttachment","envelope":envelope,"expectedAttachmentContext":ctx.to_string(),"attachmentSource":attachment_source.to_string()}),None);
        let got = got.unwrap();
        assert!(
            r["ok"] == true
                && r["name"] == "日本語🦀\0"
                && got.to_vec() == bytes
                && r.as_object().unwrap().len() == 7
        );
        got.fill(0, 0, got.length());
        let bound = key
            .decrypt_attachment(envelope, &ctx.to_string(), &attachment_source.to_string())
            .unwrap();
        assert!(
            bound.name().as_string().as_deref() == Some("日本語🦀\0")
                && bound.content().to_vec() == bytes
        );
        assert!(CloudPasswordBox::new(&owner.to_string())
            .unwrap()
            .decrypt_attachment(envelope, &ctx.to_string(), &attachment_source.to_string())
            .is_err());
        for (field, value) in [
            ("passwordBoxId", json!("d".repeat(26))),
            ("itemId", json!("d".repeat(26))),
            ("attachmentId", json!("d".repeat(26))),
            ("attachmentVersion", json!(2)),
            ("keyEpoch", json!(2)),
        ] {
            let mut wrong = ctx.clone();
            wrong[field] = value;
            assert!(worker.send(json!({"command":"decryptAttachment","envelope":envelope,"expectedAttachmentContext":wrong.to_string(),"attachmentSource":attachment_source.to_string()}),None).0["ok"]==false);
        }
        let mut tamper: Value = serde_json::from_str(envelope).unwrap();
        let cipher = tamper["ciphertext"].as_str().unwrap();
        tamper["ciphertext"] = json!(format!(
            "{}{}",
            if cipher.starts_with('A') { "B" } else { "A" },
            &cipher[1..]
        ));
        assert!(worker.send(json!({"command":"decryptAttachment","envelope":tamper.to_string(),"expectedAttachmentContext":ctx.to_string(),"attachmentSource":attachment_source.to_string()}),None).0["ok"]==false);
        last = envelope.to_owned();
    }
    let encrypt = json!({"command":"encryptAttachment","name":"","expectedAttachmentContext":ctx.to_string()});
    assert!(worker.send(encrypt.clone(), Some(&vec![0; 1_048_577])).0["ok"] == false);
    for (field, value) in [
        ("name", Value::Null),
        ("name", json!("x".repeat(4097))),
        ("unknown", Value::Null),
        ("expectedAttachmentContext", Value::Null),
        ("expectedAttachmentContext", json!("{}")),
    ] {
        let mut bad = encrypt.clone();
        bad[field] = value;
        assert!(worker.send(bad, Some(&[0, 255])).0["ok"] == false);
    }
    assert!(worker.send(encrypt.clone(), None).0["ok"] == false);
    // The structured-clone surface accepts only exact fields and ordinary byte storage.
    // Each refusal preserves the live session; mutable rejected input is wiped.
    for kind in 0..6 {
        let bad = Object::new();
        let buffer = Uint8Array::from(&[0u8, 255][..]);
        Reflect::set(&bad, &"message".into(), &encrypt.to_string().into()).unwrap();
        let bytes: JsValue = match kind {
            0 => JsValue::NULL,
            1 => Array::of2(&0.into(), &255.into()).into(),
            2 => "AP8=".into(),
            _ => buffer.clone().into(),
        };
        Reflect::set(&bad, &"bytes".into(), &bytes).unwrap();
        if kind == 3 {
            Reflect::set(&bad, &"extra".into(), &JsValue::NULL).unwrap();
        }
        if kind == 4 {
            Reflect::set(&bad, &"message".into(), &JsValue::NULL).unwrap();
        }
        if kind == 5 {
            Reflect::set(&bad, &"message".into(), &3.into()).unwrap();
        }
        let result = exchange(&bad, &Array::new());
        assert!(header(&result)["ok"] == false && header(&result)["locked"] == false);
    }
    for field in [
        "passwordBoxId",
        "itemId",
        "attachmentId",
        "attachmentVersion",
        "keyEpoch",
    ] {
        for value in [Value::Null, json!(1.0), json!(9_007_199_254_740_992u64)] {
            let mut bad = ctx.clone();
            bad[field] = value;
            assert!(worker.send(json!({"command":"encryptAttachment","name":"","expectedAttachmentContext":bad.to_string()}),Some(&[0])).0["ok"] == false);
        }
    }
    let name_max = "x".repeat(4096);
    assert!(worker.send(json!({"command":"encryptAttachment","name":name_max,"expectedAttachmentContext":ctx.to_string()}),Some(&[])).0["ok"] == true);
    let decrypt = json!({"command":"decryptAttachment","envelope":last,"expectedAttachmentContext":ctx.to_string(),"attachmentSource":attachment_source.to_string()});
    let mut wrong = attachment_source.clone();
    wrong["attachmentSnapshotRevision"] = json!(18);
    let mut bad = decrypt.clone();
    bad["attachmentSource"] = json!(wrong.to_string());
    assert!(worker.send(bad, None).0["ok"] == false);
    // Replays and stale generations retain the live handle and never return file bytes.
    let mut replay = encrypt.clone();
    replay["version"] = json!(1);
    replay["requestId"] = json!(worker.id);
    replay["expectedGeneration"] = json!(worker.g);
    assert!(worker.raw(replay, Some(&[0])).0["ok"] == false);
    worker.id += 1;
    let stale = json!({"version":1,"requestId":worker.id,"expectedGeneration":0,"command":"encryptAttachment","name":"","expectedAttachmentContext":ctx.to_string()});
    assert!(worker.raw(stale, Some(&[0])).0["error"] == "PS058: Stale worker generation");
    assert!(worker.send(decrypt.clone(), None).0["ok"] == true);
    // Item/attachment domains cannot be confused.
    let mut purpose = decrypt.clone();
    purpose["envelope"] = attachment_source["itemEnvelope"].clone();
    assert!(worker.send(purpose, None).0["ok"] == false);
    let item_ctx = attachment_source["expectedItemContext"].to_string();
    assert!(
        worker
            .send(
                json!({"command":"decrypt","envelope":last,"context":item_ctx}),
                None
            )
            .0["ok"]
            == false
    );
    // Isolate FILE wrong-key: authenticate the reference item under the wrong
    // session's own key, then reject the independently expected file ciphertext.
    let wrong_key = CloudPasswordBox::new(&owner.to_string()).unwrap();
    let wrong_source = source(&wrong_key, &ctx, 17);
    worker.send(json!({"command":"lock"}), None);
    assert!(worker.send(json!({"command":"unlock","owner":owner.to_string(),"bundle":wrong_key.wrap_for_owner(secret.to_string()).unwrap(),"password":secret.as_str()}),None).0["ok"]==true);
    let rejected=worker.send(json!({"command":"decryptAttachment","envelope":last,"expectedAttachmentContext":ctx.to_string(),"attachmentSource":wrong_source.to_string()}),None).0;
    assert!(rejected["ok"] == false && rejected["locked"] == false);
    worker.send(json!({"command":"lock"}), None);
    assert!(worker.send(json!({"command":"unlock","owner":owner.to_string(),"bundle":bundle,"password":secret.as_str()}),None).0["ok"]==true);
    // Actual recipient key import retains box/epoch and owner-only refusals.
    let a = json!({"accountId":owner["ownerAccountId"],"identityVersion":1});
    let b = json!({"accountId":"22222222-2222-4222-8222-222222222222","identityVersion":1});
    let sender = CloudAccountIdentity::new(&a.to_string()).unwrap();
    let recipient = CloudAccountIdentity::new(&b.to_string()).unwrap();
    let sender_pub: Value = serde_json::from_str(&sender.public_identity().unwrap()).unwrap();
    let recipient_pub: Value = serde_json::from_str(&recipient.public_identity().unwrap()).unwrap();
    let shared = json!({"passwordBoxId":ctx["passwordBoxId"],"keyEpoch":1,"senderAccountId":a["accountId"],"senderIdentityVersion":1,"senderKeyId":sender_pub["keyId"],"recipientAccountId":b["accountId"],"recipientIdentityVersion":1,"recipientKeyId":recipient_pub["keyId"]});
    let wrapped = key
        .wrap_for_recipient(&sender, &recipient_pub.to_string(), &shared.to_string())
        .unwrap();
    worker.send(json!({"command":"lock"}), None);
    assert!(worker.send(decrypt.clone(), None).0["error"] == "PS057: Password box is locked");
    assert!(worker.send(json!({"command":"identityUnlock","accountContext":b.to_string(),"expectedKeyId":recipient_pub["keyId"],"identitySecret":secret.as_str(),"bundle":recipient.wrap(secret.to_string()).unwrap()}),None).0["ok"]==true);
    assert!(worker.send(json!({"command":"sharedReceiveUnlock","envelope":wrapped,"trustedSenderPublic":sender_pub.to_string(),"sharedContext":shared.to_string()}),None).0["ok"]==true);
    assert!(worker.send(decrypt, None).0["ok"] == true);
    assert!(
        worker
            .send(json!({"command":"wrap","password":secret.as_str()}), None)
            .0["ok"]
            == false
    );
    assert!(worker.send(json!({"command":"recoveryMaterial"}), None).0["ok"] == false);
    let locked = worker.send(json!({"command":"lock"}), None).0;
    assert!(locked["locked"] == true && locked["identityLocked"] == true);
    key.lock();
}
