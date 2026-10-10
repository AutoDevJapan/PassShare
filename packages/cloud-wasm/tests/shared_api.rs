//! Node is wasm-bindgen-test's default runner. Exercise the public WASM API,
//! not Core crypto helpers. All passphrases and DTOs here are synthetic.
#![cfg(target_arch = "wasm32")]

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use passshare_cloud_wasm::{CloudAccountIdentity, CloudPasswordBox};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;
use wasm_bindgen_test::wasm_bindgen_test;

const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
const C: &str = "33333333-3333-4333-8333-333333333333";
const BOX: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_BOX: &str = "cccccccccccccccccccccccccc";
const PASSWORD: &str = "Synthetic identity e\u{301} password!";
const NORMALIZED_PASSWORD: &str = "Synthetic identity é password!";
const INVALID: &str = "PS051: Invalid encrypted data";
const IDENTITY_LOCKED: &str = "PS057: Account identity is locked";
const BOX_LOCKED: &str = "PS057: Password box is locked";

fn value(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn expect_error<T>(result: Result<T, JsValue>, expected: &str) {
    match result {
        Err(error) => assert_eq!(error.as_string().as_deref(), Some(expected)),
        Ok(_) => panic!("public binding accepted an invalid operation"),
    }
}

fn account(id: &str) -> String {
    json!({"accountId":id,"identityVersion":1}).to_string()
}

fn owner(id: &str) -> String {
    json!({"passwordBoxId":BOX,"ownerAccountId":id,"keyEpoch":1}).to_string()
}

fn public(identity: &CloudAccountIdentity) -> String {
    identity.public_identity().unwrap()
}

fn restored_identity(id: &str) -> CloudAccountIdentity {
    let independent_context = account(id);
    let mut original = CloudAccountIdentity::new(&independent_context).unwrap();
    let pinned = value(&public(&original));
    let bundle = original.wrap(PASSWORD.into()).unwrap();
    original.lock();
    CloudAccountIdentity::unlock(
        &bundle,
        NORMALIZED_PASSWORD.into(),
        &independent_context,
        pinned["keyId"].as_str().unwrap(),
    )
    .unwrap()
}

// These contexts are explicitly constructed from independent fixture values
// and pinned descriptors, never from a received shared envelope.
fn shared(sender: &str, recipient: &str) -> Value {
    let (sender, recipient) = (value(sender), value(recipient));
    json!({
        "passwordBoxId":BOX,"keyEpoch":1,
        "senderAccountId":sender["accountId"],
        "recipientAccountId":recipient["accountId"],
        "senderIdentityVersion":sender["identityVersion"],
        "recipientIdentityVersion":recipient["identityVersion"],
        "senderKeyId":sender["keyId"],"recipientKeyId":recipient["keyId"]
    })
}

fn item_context() -> Value {
    json!({"passwordBoxId":BOX,"itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":1,"keyEpoch":1})
}

fn full_item() -> Value {
    json!({
        "id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","version":1,"vault":{"id":BOX},
        "title":"Synthetic shared DTO","category":"LOGIN",
        "fields":[{"id":"password","type":"CONCEALED","value":"Synthetic plaintext"},
                  {"id":"username","value":"Synthetic user"}],
        "sections":[{"id":"extra","fields":[{"id":"nested","value":"Keep me"}]}],
        "urls":[{"href":"https://example.test/a"},{"href":"https://example.test/b"}],
        "attachments":[{"id":"attachment-1","name":"Synthetic.bin","size":3,
                        "opaque":{"data":[1,2,3],"retain":true}},
                       {"id":"attachment-2","custom":[null,{"keep":"yes"}]}],
        "opaque":{"array":[3,1,2],"object":{"unknown":"preserve","empty":[]}},
        "tags":["one","two"],"notes":"Synthetic notes"
    })
}

fn flip_base64(input: &str) -> String {
    let mut bytes = B64.decode(input).unwrap();
    bytes[0] ^= 1;
    B64.encode(bytes)
}

#[wasm_bindgen_test]
fn public_identity_bundles_restore_a_b_c_and_pin_the_identity() {
    let mut pinned = Vec::new();
    for id in [A, B, C] {
        let independently_held_context = account(id);
        let mut identity = CloudAccountIdentity::new(&independently_held_context).unwrap();
        let descriptor = public(&identity);
        let descriptor_value = value(&descriptor);
        assert_eq!(descriptor_value.as_object().unwrap().len(), 4);
        assert_eq!(descriptor_value["accountId"], id);
        assert_eq!(descriptor_value["identityVersion"], 1);
        let public_key = descriptor_value["publicKey"].as_str().unwrap();
        let bytes = B64.decode(public_key).unwrap();
        assert_eq!(bytes.len(), 32);
        assert_eq!(B64.encode(bytes), public_key);
        let key_id = descriptor_value["keyId"].as_str().unwrap();
        assert_eq!(key_id.len(), 64);
        assert_eq!(descriptor, format!(
            "{{\"accountId\":\"{id}\",\"identityVersion\":1,\"publicKey\":\"{public_key}\",\"keyId\":\"{key_id}\"}}"
        ));
        let bundle = identity.wrap(PASSWORD.into()).unwrap();
        let sealed = value(&bundle);
        assert_eq!(sealed.as_object().unwrap().len(), 3);
        assert_eq!(sealed["format"], 1);
        assert_eq!(
            B64.decode(sealed["salt"].as_str().unwrap()).unwrap().len(),
            16
        );
        assert_eq!(sealed["wrapped"].as_object().unwrap().len(), 4);
        assert_eq!(
            B64.decode(sealed["wrapped"]["ciphertext"].as_str().unwrap())
                .unwrap()
                .len(),
            48
        );
        assert!(!bundle.contains(PASSWORD));
        assert!(!bundle.contains("publicKey") && !bundle.contains("keyId"));
        identity.lock();
        identity.lock();
        expect_error(identity.public_identity(), IDENTITY_LOCKED);
        expect_error(identity.wrap(PASSWORD.into()), IDENTITY_LOCKED);
        let restored = CloudAccountIdentity::unlock(
            &bundle,
            NORMALIZED_PASSWORD.into(),
            &independently_held_context,
            key_id,
        )
        .unwrap();
        assert_eq!(public(&restored), descriptor);
        pinned.push((descriptor, bundle));
    }
    let (descriptor, bundle) = &pinned[0];
    let descriptor_value = value(descriptor);
    let key_id = descriptor_value["keyId"].as_str().unwrap();
    let foreign = value(&pinned[2].0);
    expect_error(
        CloudAccountIdentity::unlock(
            bundle,
            "Wrong synthetic password!".into(),
            &account(A),
            key_id,
        ),
        INVALID,
    );
    expect_error(
        CloudAccountIdentity::unlock(
            bundle,
            PASSWORD.into(),
            &account(A),
            foreign["keyId"].as_str().unwrap(),
        ),
        INVALID,
    );
    for scope in [
        account(B),
        json!({"accountId":A,"identityVersion":2}).to_string(),
    ] {
        expect_error(
            CloudAccountIdentity::unlock(bundle, PASSWORD.into(), &scope, key_id),
            INVALID,
        );
    }
    // Same account/version, independently generated secret: replacement still
    // fails with the original caller-held fingerprint.
    let substitute = CloudAccountIdentity::new(&account(A)).unwrap();
    let replacement = substitute.wrap(PASSWORD.into()).unwrap();
    expect_error(
        CloudAccountIdentity::unlock(&replacement, PASSWORD.into(), &account(A), key_id),
        INVALID,
    );
    for bad_id in [
        "".to_string(),
        "x".repeat(64),
        "A".repeat(64),
        "0".repeat(65),
    ] {
        expect_error(
            CloudAccountIdentity::unlock(bundle, PASSWORD.into(), &account(A), &bad_id),
            INVALID,
        );
    }
}

#[wasm_bindgen_test]
fn public_identity_wrapper_rejects_unknown_fields_tamper_and_bounds() {
    let identity = CloudAccountIdentity::new(&account(A)).unwrap();
    let descriptor = value(&public(&identity));
    let key_id = descriptor["keyId"].as_str().unwrap();
    let bundle = value(&identity.wrap(PASSWORD.into()).unwrap());
    let restore = |sealed: &Value| {
        CloudAccountIdentity::unlock(&sealed.to_string(), PASSWORD.into(), &account(A), key_id)
    };
    for pointer in ["", "/wrapped", "/wrapped/context"] {
        let mut altered = bundle.clone();
        altered
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("unexpected".into(), json!("Synthetic hostile input"));
        expect_error(restore(&altered), INVALID);
    }
    for pointer in ["/format", "/wrapped/format"] {
        let mut altered = bundle.clone();
        *altered.pointer_mut(pointer).unwrap() = json!(2);
        expect_error(restore(&altered), INVALID);
    }
    for pointer in ["/salt", "/wrapped/nonce", "/wrapped/ciphertext"] {
        let mut altered = bundle.clone();
        *altered.pointer_mut(pointer).unwrap() = json!(flip_base64(
            bundle.pointer(pointer).unwrap().as_str().unwrap()
        ));
        expect_error(restore(&altered), INVALID);
        for text in [
            "?".to_string(),
            "A".repeat(4096),
            format!("{}\n", bundle.pointer(pointer).unwrap().as_str().unwrap()),
        ] {
            let mut altered = bundle.clone();
            *altered.pointer_mut(pointer).unwrap() = json!(text);
            expect_error(restore(&altered), INVALID);
        }
    }
    // Correct decoded salt length but noncanonical padding bits (16 bytes).
    for salt in [
        "AAAAAAAAAAAAAAAAAAAAAB==",
        "AAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAA=",
    ] {
        let mut altered = bundle.clone();
        altered["salt"] = json!(salt);
        expect_error(restore(&altered), INVALID);
    }
    for pointer in [
        "/wrapped/context/accountId",
        "/wrapped/context/identityVersion",
    ] {
        let mut altered = bundle.clone();
        *altered.pointer_mut(pointer).unwrap() = if pointer.ends_with("accountId") {
            json!(B)
        } else {
            json!(2)
        };
        expect_error(restore(&altered), INVALID);
    }
    expect_error(
        CloudAccountIdentity::unlock(&" ".repeat(2049), PASSWORD.into(), &account(A), key_id),
        INVALID,
    );
    for context in [
        json!({"accountId":A,"identityVersion":1,"unknown":true}),
        json!({"accountId":"00000000-0000-0000-0000-000000000000","identityVersion":1}),
        json!({"accountId":A,"identityVersion":0}),
        json!({"accountId":A,"identityVersion":9_007_199_254_740_992_u64}),
    ] {
        expect_error(CloudAccountIdentity::new(&context.to_string()), INVALID);
        expect_error(
            CloudAccountIdentity::unlock(
                &bundle.to_string(),
                PASSWORD.into(),
                &context.to_string(),
                key_id,
            ),
            INVALID,
        );
    }
    expect_error(CloudAccountIdentity::new(&" ".repeat(257)), INVALID);
    for secret in [
        "short".to_string(),
        "x".repeat(1025),
        "é".repeat(513),
        "e\u{301}".repeat(7),
    ] {
        expect_error(identity.wrap(secret.clone()), INVALID);
        expect_error(
            CloudAccountIdentity::unlock(&bundle.to_string(), secret, &account(A), key_id),
            INVALID,
        );
    }
    // Both exact password bounds and the normalized character count use the
    // existing owner-password policy, rather than a new identity policy.
    for secret in ["é".repeat(8), "x".repeat(1024)] {
        let sealed = identity.wrap(secret.clone()).unwrap();
        let restored = CloudAccountIdentity::unlock(&sealed, secret, &account(A), key_id).unwrap();
        assert_eq!(public(&restored), public(&identity));
    }
}

#[wasm_bindgen_test]
fn public_shared_bindings_preserve_full_dto_and_current_recipient_scope() {
    let mut a = restored_identity(A);
    let mut b = restored_identity(B);
    let c = restored_identity(C);
    let (a_public, b_public, c_public) = (public(&a), public(&b), public(&c));
    let ab = shared(&a_public, &b_public).to_string();
    let mut sender = CloudPasswordBox::new(&owner(A)).unwrap();
    let owner_bundle = sender.wrap_for_owner(PASSWORD.into()).unwrap();
    let envelope = sender.wrap_for_recipient(&a, &b_public, &ab).unwrap();
    let second = value(&sender.wrap_for_recipient(&a, &b_public, &ab).unwrap());
    assert_ne!(value(&envelope)["enc"], second["enc"]);
    assert_ne!(value(&envelope)["ciphertext"], second["ciphertext"]);
    let mut recipient =
        CloudPasswordBox::unlock_for_recipient(&envelope, &b, &a_public, &ab).unwrap();
    assert!(!recipient.is_locked());
    let context = item_context().to_string();
    let item = full_item();
    let encrypted = sender.encrypt_item(item.to_string(), &context).unwrap();
    assert!(!encrypted.contains("Synthetic plaintext") && !encrypted.contains("Synthetic.bin"));
    assert_eq!(
        value(
            &recipient
                .decrypt_item(&encrypted, &context)
                .unwrap()
                .as_string()
                .unwrap()
        ),
        item
    );
    let encrypted_by_b = recipient.encrypt_item(item.to_string(), &context).unwrap();
    assert_eq!(
        value(
            &sender
                .decrypt_item(&encrypted_by_b, &context)
                .unwrap()
                .as_string()
                .unwrap()
        ),
        item
    );
    expect_error(recipient.wrap_for_owner(PASSWORD.into()), INVALID);
    // Preserved owner flow still reopens and reads recipient-produced items.
    let restored_owner =
        CloudPasswordBox::unlock(&owner_bundle, PASSWORD.into(), &owner(A)).unwrap();
    assert_eq!(
        value(
            &restored_owner
                .decrypt_item(&encrypted_by_b, &context)
                .unwrap()
                .as_string()
                .unwrap()
        ),
        item
    );
    // A recipient's operational caller is B, not the envelope's sender A.
    let bc = shared(&b_public, &c_public).to_string();
    let forwarded = recipient.wrap_for_recipient(&b, &c_public, &bc).unwrap();
    let c_box = CloudPasswordBox::unlock_for_recipient(&forwarded, &c, &b_public, &bc).unwrap();
    assert_eq!(
        value(
            &c_box
                .decrypt_item(&encrypted_by_b, &context)
                .unwrap()
                .as_string()
                .unwrap()
        ),
        item
    );
    let ac = shared(&a_public, &c_public).to_string();
    expect_error(recipient.wrap_for_recipient(&a, &c_public, &ac), INVALID);
    expect_error(sender.wrap_for_recipient(&b, &c_public, &bc), INVALID);
    for field in ["passwordBoxId", "keyEpoch", "itemVersion"] {
        let mut wrong = item_context();
        wrong[field] = if field == "passwordBoxId" {
            json!(OTHER_BOX)
        } else {
            json!(2)
        };
        expect_error(
            recipient.decrypt_item(&encrypted, &wrong.to_string()),
            INVALID,
        );
        expect_error(
            recipient.encrypt_item(item.to_string(), &wrong.to_string()),
            INVALID,
        );
    }
    let mut bad_item = item.clone();
    bad_item["vault"]["id"] = json!(OTHER_BOX);
    let mut other_context = item_context();
    other_context["passwordBoxId"] = json!(OTHER_BOX);
    let other_owner = json!({"passwordBoxId":OTHER_BOX,"ownerAccountId":A,"keyEpoch":1});
    let mut other_box = CloudPasswordBox::new(&other_owner.to_string()).unwrap();
    // Positive control: the DTO and context agree and Core can encrypt them.
    // Only the original recipient's box scope must reject this valid pair.
    assert!(other_box
        .encrypt_item(bad_item.to_string(), &other_context.to_string())
        .is_ok());
    expect_error(
        recipient.encrypt_item(bad_item.to_string(), &other_context.to_string()),
        INVALID,
    );
    other_box.lock();
    expect_error(
        recipient.encrypt_item(bad_item.to_string(), &context),
        INVALID,
    );
    let mut tampered_item = value(&encrypted);
    tampered_item["ciphertext"] = json!(flip_base64(tampered_item["ciphertext"].as_str().unwrap()));
    expect_error(
        recipient.decrypt_item(&tampered_item.to_string(), &context),
        INVALID,
    );
    a.lock();
    expect_error(
        sender.wrap_for_recipient(&a, &b_public, &ab),
        IDENTITY_LOCKED,
    );
    b.lock();
    expect_error(
        CloudPasswordBox::unlock_for_recipient(&envelope, &b, &a_public, &ab),
        IDENTITY_LOCKED,
    );
    // Dropping an identity does not claim to erase independently opened boxes.
    assert_eq!(
        value(
            &recipient
                .decrypt_item(&encrypted, &context)
                .unwrap()
                .as_string()
                .unwrap()
        ),
        item
    );
    recipient.lock();
    recipient.lock();
    assert!(recipient.is_locked());
    expect_error(
        recipient.encrypt_item(item.to_string(), &context),
        BOX_LOCKED,
    );
    expect_error(recipient.decrypt_item(&encrypted, &context), BOX_LOCKED);
    expect_error(recipient.wrap_for_owner(PASSWORD.into()), BOX_LOCKED);
    expect_error(recipient.wrap_for_recipient(&c, &c_public, &bc), BOX_LOCKED);
    sender.lock();
    expect_error(sender.wrap_for_recipient(&c, &b_public, &ab), BOX_LOCKED);
}

#[wasm_bindgen_test]
fn public_shared_bindings_reject_other_identities_and_every_context_relabel() {
    let a = CloudAccountIdentity::new(&account(A)).unwrap();
    let b = CloudAccountIdentity::new(&account(B)).unwrap();
    let c = CloudAccountIdentity::new(&account(C)).unwrap();
    let same_account_other_key = CloudAccountIdentity::new(&account(B)).unwrap();
    let (a_public, b_public, c_public) = (public(&a), public(&b), public(&c));
    let ab = shared(&a_public, &b_public);
    let sender = CloudPasswordBox::new(&owner(A)).unwrap();
    let envelope = value(
        &sender
            .wrap_for_recipient(&a, &b_public, &ab.to_string())
            .unwrap(),
    );
    for recipient in [&c, &same_account_other_key] {
        expect_error(
            CloudPasswordBox::unlock_for_recipient(
                &envelope.to_string(),
                recipient,
                &a_public,
                &ab.to_string(),
            ),
            INVALID,
        );
    }
    expect_error(
        CloudPasswordBox::unlock_for_recipient(
            &envelope.to_string(),
            &b,
            &c_public,
            &ab.to_string(),
        ),
        INVALID,
    );
    for (field, changed) in [
        ("passwordBoxId", json!(OTHER_BOX)),
        ("keyEpoch", json!(2)),
        ("senderAccountId", json!(C)),
        ("recipientAccountId", json!(C)),
        ("senderIdentityVersion", json!(2)),
        ("recipientIdentityVersion", json!(2)),
        ("senderKeyId", json!("0".repeat(64))),
        ("recipientKeyId", json!("0".repeat(64))),
    ] {
        let mut wrong = ab.clone();
        wrong[field] = changed;
        expect_error(
            sender.wrap_for_recipient(&a, &b_public, &wrong.to_string()),
            INVALID,
        );
        expect_error(
            CloudPasswordBox::unlock_for_recipient(
                &envelope.to_string(),
                &b,
                &a_public,
                &wrong.to_string(),
            ),
            INVALID,
        );
        let mut relabelled = envelope.clone();
        relabelled["context"] = wrong.clone();
        expect_error(
            CloudPasswordBox::unlock_for_recipient(
                &relabelled.to_string(),
                &b,
                &a_public,
                &ab.to_string(),
            ),
            INVALID,
        );
        expect_error(
            CloudPasswordBox::unlock_for_recipient(
                &relabelled.to_string(),
                &b,
                &a_public,
                &wrong.to_string(),
            ),
            INVALID,
        );
    }
    // Consistent relabelling to C is rejected cryptographically as well as by
    // descriptor/context checks; the old ciphertext is still for B.
    let ac = shared(&a_public, &c_public);
    let mut to_c = envelope.clone();
    to_c["context"] = ac.clone();
    expect_error(
        CloudPasswordBox::unlock_for_recipient(&to_c.to_string(), &c, &a_public, &ac.to_string()),
        INVALID,
    );
    // Likewise, pinning C and relabelling the sender to C cannot authenticate
    // the original A ciphertext, even when all public metadata agrees.
    let cb = shared(&c_public, &b_public);
    let mut from_c = envelope.clone();
    from_c["context"] = cb.clone();
    expect_error(
        CloudPasswordBox::unlock_for_recipient(&from_c.to_string(), &b, &c_public, &cb.to_string()),
        INVALID,
    );
    for (field, changed) in [
        ("accountId", json!(C)),
        ("identityVersion", json!(2)),
        ("keyId", json!("0".repeat(64))),
        ("publicKey", value(&c_public)["publicKey"].clone()),
        ("unknown", json!(true)),
    ] {
        let mut wrong_sender = value(&a_public);
        wrong_sender[field] = changed.clone();
        expect_error(
            CloudPasswordBox::unlock_for_recipient(
                &envelope.to_string(),
                &b,
                &wrong_sender.to_string(),
                &ab.to_string(),
            ),
            INVALID,
        );
        let mut wrong_recipient = value(&b_public);
        wrong_recipient[field] = changed;
        expect_error(
            sender.wrap_for_recipient(&a, &wrong_recipient.to_string(), &ab.to_string()),
            INVALID,
        );
    }
}

#[wasm_bindgen_test]
fn public_shared_envelopes_reject_tamper_unknown_fields_and_oversized_inputs() {
    let a = CloudAccountIdentity::new(&account(A)).unwrap();
    let b = CloudAccountIdentity::new(&account(B)).unwrap();
    let (a_public, b_public) = (public(&a), public(&b));
    let ab = shared(&a_public, &b_public).to_string();
    let sender = CloudPasswordBox::new(&owner(A)).unwrap();
    let envelope = value(&sender.wrap_for_recipient(&a, &b_public, &ab).unwrap());
    let receive = |sealed: &Value| {
        CloudPasswordBox::unlock_for_recipient(&sealed.to_string(), &b, &a_public, &ab)
    };
    for (field, changed) in [
        ("format", json!(2)),
        ("suite", json!("hpke-base/0x0020/0x0001/0x0003")),
        ("unknown", json!("Synthetic hostile input")),
        ("enc", json!(flip_base64(envelope["enc"].as_str().unwrap()))),
        (
            "ciphertext",
            json!(flip_base64(envelope["ciphertext"].as_str().unwrap())),
        ),
    ] {
        let mut wrong = envelope.clone();
        wrong[field] = changed;
        expect_error(receive(&wrong), INVALID);
    }
    let mut wrong = envelope.clone();
    wrong["context"]["unknown"] = json!(true);
    expect_error(receive(&wrong), INVALID);
    let mut wrong_context = value(&ab);
    wrong_context["unknown"] = json!(true);
    expect_error(
        sender.wrap_for_recipient(&a, &b_public, &wrong_context.to_string()),
        INVALID,
    );
    expect_error(
        CloudPasswordBox::unlock_for_recipient(
            &envelope.to_string(),
            &b,
            &a_public,
            &wrong_context.to_string(),
        ),
        INVALID,
    );
    for field in ["enc", "ciphertext"] {
        for changed in [
            "?".to_string(),
            "A".repeat(4096),
            format!("{}\n", envelope[field].as_str().unwrap()),
        ] {
            let mut wrong = envelope.clone();
            wrong[field] = json!(changed);
            expect_error(receive(&wrong), INVALID);
        }
    }
    expect_error(
        CloudPasswordBox::unlock_for_recipient(&" ".repeat(2049), &b, &a_public, &ab),
        INVALID,
    );
    expect_error(
        CloudPasswordBox::unlock_for_recipient(&envelope.to_string(), &b, &" ".repeat(513), &ab),
        INVALID,
    );
    expect_error(
        CloudPasswordBox::unlock_for_recipient(
            &envelope.to_string(),
            &b,
            &a_public,
            &" ".repeat(1025),
        ),
        INVALID,
    );
    expect_error(
        sender.wrap_for_recipient(&a, &" ".repeat(513), &ab),
        INVALID,
    );
    expect_error(
        sender.wrap_for_recipient(&a, &b_public, &" ".repeat(1025)),
        INVALID,
    );
    for field in [
        "keyEpoch",
        "senderIdentityVersion",
        "recipientIdentityVersion",
    ] {
        for number in [0, 9_007_199_254_740_992_u64] {
            let mut wrong = value(&ab);
            wrong[field] = json!(number);
            expect_error(
                sender.wrap_for_recipient(&a, &b_public, &wrong.to_string()),
                INVALID,
            );
            expect_error(
                CloudPasswordBox::unlock_for_recipient(
                    &envelope.to_string(),
                    &b,
                    &a_public,
                    &wrong.to_string(),
                ),
                INVALID,
            );
        }
    }
}
