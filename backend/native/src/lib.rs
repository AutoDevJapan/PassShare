pub mod account;
pub mod account_identity;
pub mod account_page;
pub mod commercial_lifecycle;
pub mod create;
pub mod edit;
pub mod encrypted;
pub mod encrypted_attachment;
pub mod encrypted_migration;
pub mod encrypted_rotation;
pub mod encrypted_setup;
pub mod lifecycle_page;
pub mod owner_key;
pub mod recovery;
pub mod retirement;
pub mod share;
pub mod shared_grant;

use serde_json::{json, Value};

pub fn dispatch(input: &Value) -> Value {
    if input.get("requestJson").is_some() {
        return encrypted_attachment::dispatch_raw(input);
    }
    match input.get("command").and_then(Value::as_str) {
        Some("account-lifecycle-page") => lifecycle_page::render(input),
        Some("account-lifecycle-form") => lifecycle_page::validate_form(input),
        Some("commercial-quote") => commercial_lifecycle::quote(input),
        Some("commercial-lifecycle-decision") => commercial_lifecycle::lifecycle(input),
        Some("encrypted-schema") => json!({"status":200,"body":encrypted::SCHEMA}),
        Some("encrypted-plan") => encrypted::plan(input),
        Some("encrypted-attachment-plan") => encrypted_attachment::plan(input),
        Some("encrypted-migration-plan") => encrypted_migration::plan(input),
        Some("shared-grant-plan") => shared_grant::plan(input),
        Some("encrypted-rotation-plan") => encrypted_rotation::plan(input),
        Some("encrypted-setup-plan") => encrypted_setup::plan(input),
        Some("owner-key-plan") => owner_key::plan(input),
        Some("account-identity-plan") => account_identity::plan(input),
        Some("account-retire") => retirement::retire(input),
        Some("account-owner-transfer") => retirement::transfer(input),
        Some("account-recovery-schema") => json!({"status":200,"body":recovery::SCHEMA}),
        Some("account-recovery-prepare") => recovery::prepare(input),
        Some("account-recovery-input") => recovery::validate_input(input),
        Some("account-recovery-issue") => recovery::authorize_issue(input),
        Some("account-recovery-consume") => recovery::authorize_recovery(input),
        Some("sharing-schema") => json!({"status":200,"body":share::MEMBERSHIP_SCHEMA}),
        Some("account-password-input") => account::validate_input(input),
        Some("account-password-form") => account_page::validate_form(input),
        Some("account-password-page") => account_page::render(input),
        Some("account-password-change") => account::authorize_change(input),
        Some("invitation-proof") => share::prepare(input),
        Some("invitation-accept") => share::accept(input),
        Some("schema") => json!({"status":200,"body":create::SCHEMA}),
        Some("scope") => match create::scope(input) {
            Ok(body) => json!({"status":200,"body":body}),
            Err(_) => json!({"status":400,"message":"PS018: Invalid creation operation"}),
        },
        Some("create") => create::decide(input),
        Some("record") => create::record(input),
        Some("edit") => {
            let original = &input["original"];
            let expected = input["version"].as_u64().filter(|value| *value > 0);
            if expected.is_none() || expected != original["version"].as_u64() {
                return json!({"status":409,"message":"PS015: Item changed since it was read"});
            }
            match edit::edit_item(original, &input["values"]) {
                Ok(body) => json!({"status":200,"body":body}),
                Err(_) => json!({"status":400,"message":"PS018: Invalid item edit"}),
            }
        }
        _ => json!({"status":400,"message":"PS018: Invalid mutation request"}),
    }
}
