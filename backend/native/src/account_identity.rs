//! Account-owned public descriptors and opaque client-wrapped identity seeds.
//! Public shape checks follow Core shared_keys; this is not AEAD verification.
use crate::encrypted::{exact_fields, id, number};
use crate::owner_key::canonical_uuid;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const MAX_INTEGER: u64 = 9_007_199_254_740_991;

fn failure() -> Value {
    json!({"status":400,"code":"PS051","message":"PS051: Invalid account identity request"})
}

fn fixed<const N: usize>(value: &Value) -> Option<[u8; N]> {
    let text = value.as_str()?;
    if text.len() != 4 * N.div_ceil(3) {
        return None;
    }
    let bytes = BASE64.decode(text).ok()?;
    let bytes: [u8; N] = bytes.as_slice().try_into().ok()?;
    (BASE64.encode(bytes) == text).then_some(bytes)
}

fn public_identity(value: &Value, actor: &str) -> Option<u64> {
    if !exact_fields(
        value,
        &["accountId", "identityVersion", "publicKey", "keyId"],
    ) || value["accountId"].as_str() != Some(actor)
    {
        return None;
    }
    let version = number(&value["identityVersion"], false)?;
    let point = fixed::<32>(&value["publicKey"])?;
    // Core's canonical RFC 7748 coordinate check. Low-order DH rejection belongs
    // to Core HPKE, not this public storage header validator.
    let at_least_p =
        point[31] == 0x7f && point[1..31].iter().all(|&b| b == 0xff) && point[0] >= 0xed;
    let fingerprint = format!("{:x}", Sha256::digest(point));
    if point[31] & 0x80 != 0 || at_least_p || value["keyId"].as_str() != Some(fingerprint.as_str())
    {
        return None;
    }
    Some(version)
}

fn valid_bundle(bundle: &Value, actor: &str, version: u64) -> bool {
    let wrapped = &bundle["wrapped"];
    let context = &wrapped["context"];
    exact_fields(bundle, &["format", "salt", "wrapped"])
        && exact_fields(wrapped, &["format", "context", "nonce", "ciphertext"])
        && exact_fields(context, &["accountId", "identityVersion"])
        && bundle["format"].as_u64() == Some(1)
        && wrapped["format"].as_u64() == Some(1)
        && fixed::<16>(&bundle["salt"]).is_some()
        && fixed::<24>(&wrapped["nonce"]).is_some()
        && fixed::<48>(&wrapped["ciphertext"]).is_some()
        && context["accountId"].as_str() == Some(actor)
        && context["identityVersion"].as_u64() == Some(version)
}

pub fn plan(input: &Value) -> Value {
    let (Some(actor), Some(session)) = (input["actor"].as_str(), input["session"].as_str()) else {
        return failure();
    };
    // Only middleware-supplied UUIDs are normalized. Public client contexts and
    // the explicit peer selector must already be canonical.
    let actor = actor.to_ascii_lowercase();
    let session = session.to_ascii_lowercase();
    if !canonical_uuid(&actor) || !canonical_uuid(&session) {
        return failure();
    }
    let request = &input["request"];
    match input["operation"].as_str() {
        Some("member-get") if request.is_null() => {
            let (Some(box_id), Some(target)) = (id(&input["boxId"]), input["accountId"].as_str())
            else {
                return failure();
            };
            if !canonical_uuid(target) {
                return failure();
            }
            json!({"status":200,"body":{
                "sql":"SELECT passshare_member_identity($1::uuid,$2::uuid,$3::varchar,$4::uuid) AS reply",
                "requiresReauthentication":false,"params":[actor,session,box_id,target]}})
        }
        Some("get") if request.is_null() => self_plan(
            &actor,
            &session,
            "get",
            Value::Null,
            Value::Null,
            Value::Null,
        ),
        Some("put") if exact_fields(request, &["expectedVersion", "identity", "bundle"]) => {
            let Some(previous) =
                number(&request["expectedVersion"], true).filter(|n| *n < MAX_INTEGER)
            else {
                return failure();
            };
            let Some(version) = public_identity(&request["identity"], &actor) else {
                return failure();
            };
            if !valid_bundle(&request["bundle"], &actor, version) {
                return failure();
            }
            if version != 1 {
                return json!({"status":409,"code":"PS015","message":"PS015: Account identity rotation is unsupported"});
            }
            self_plan(
                &actor,
                &session,
                "put",
                json!(previous),
                request["identity"].clone(),
                request["bundle"].clone(),
            )
        }
        _ => failure(),
    }
}

fn self_plan(
    actor: &str,
    session: &str,
    operation: &str,
    previous: Value,
    identity: Value,
    bundle: Value,
) -> Value {
    json!({"status":200,"body":{
        "sql":"SELECT passshare_account_identity_operation($1::uuid,$2::uuid,$3::text,$4::bigint,$5::jsonb,$6::jsonb,$7::text) AS reply",
        "requiresReauthentication":previous.as_u64().is_some_and(|n| n>0),
        "params":[actor,session,operation,previous,identity,bundle,Value::Null]}})
}

#[cfg(test)]
mod tests {
    use super::*;
    const ACTOR: &str = "11111111-1111-4111-8111-111111111111";
    const SESSION: &str = "22222222-2222-4222-8222-222222222222";

    fn input(previous: u64) -> Value {
        let mut point = [0u8; 32];
        point[0] = 9;
        json!({"actor":ACTOR,"session":SESSION,"operation":"put","request":{
            "expectedVersion":previous,"identity":{"accountId":ACTOR,"identityVersion":1,
                "publicKey":BASE64.encode(point),"keyId":format!("{:x}",Sha256::digest(point))},
            "bundle":{"format":1,"salt":BASE64.encode([0u8;16]),"wrapped":{"format":1,
                "context":{"accountId":ACTOR,"identityVersion":1},
                "nonce":BASE64.encode([0u8;24]),"ciphertext":BASE64.encode([0u8;48])}}
        }})
    }

    #[test]
    fn public_headers_plan_bootstrap_and_reauthenticated_cas_without_credentials() {
        for previous in [0, 1, MAX_INTEGER - 1] {
            let request = input(previous);
            let result = plan(&request);
            assert_eq!(result["status"], 200);
            assert_eq!(result["body"]["requiresReauthentication"], previous > 0);
            assert_eq!(result["body"]["params"][0], ACTOR);
            assert_eq!(result["body"]["params"][6], Value::Null);
            assert_eq!(result["body"]["params"][4], request["request"]["identity"]);
            assert_eq!(result["body"]["params"][5], request["request"]["bundle"]);
        }
        let mut overflow = input(MAX_INTEGER);
        assert_eq!(plan(&overflow)["status"], 400);
        overflow["request"]["expectedVersion"] = json!(0.5);
        assert_eq!(plan(&overflow)["status"], 400);
    }

    #[test]
    fn noncanonical_points_are_denied_even_with_their_matching_fingerprint() {
        assert_eq!(plan(&input(0))["status"], 200);
        let mut p = [0xffu8; 32];
        p[0] = 0xed;
        p[31] = 0x7f;
        let mut high = [0u8; 32];
        high[31] = 0x80;
        for point in [p, high] {
            let mut request = input(0);
            // Keep a matching fingerprint and all other valid fields so only
            // the noncanonical coordinate makes this request fail.
            request["request"]["identity"]["publicKey"] = json!(BASE64.encode(point));
            request["request"]["identity"]["keyId"] = json!(format!("{:x}", Sha256::digest(point)));
            assert_eq!(plan(&request)["status"], 400);
        }
    }

    #[test]
    fn scope_unknown_fields_and_malformed_values_never_echo_private_input() {
        for pointer in [
            "/request",
            "/request/identity",
            "/request/bundle",
            "/request/bundle/wrapped",
            "/request/bundle/wrapped/context",
        ] {
            let mut request = input(0);
            request.pointer_mut(pointer).unwrap()["plaintext"] =
                json!("synthetic-private-sentinel");
            let result = plan(&request);
            assert_eq!(result["status"], 400);
            assert!(!result.to_string().contains("synthetic-private-sentinel"));
        }
        let mut mismatch = input(0);
        mismatch["request"]["bundle"]["wrapped"]["context"]["accountId"] = json!(SESSION);
        assert_eq!(plan(&mismatch)["status"], 400);
        mismatch = input(0);
        mismatch["request"]["bundle"]["salt"] = json!("AAAAAAAAAAAAAAAAAAAAAB==");
        assert_eq!(plan(&mismatch)["status"], 400);
        mismatch = input(0);
        mismatch["request"]["identity"]["identityVersion"] = json!(2);
        mismatch["request"]["bundle"]["wrapped"]["context"]["identityVersion"] = json!(2);
        assert_eq!(plan(&mismatch)["status"], 409);
    }
}
