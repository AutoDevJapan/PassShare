//! Hosted routing is production only; browser cookies use its canonical proxy.
use serde_json::Value;

const CONFIG: &str = include_str!("../../../frontend/vercel.json");
const ENV_SYNC: &str = include_str!("../../../scripts/sync-vercel-env.mjs");

fn config() -> Value {
    serde_json::from_str(CONFIG).expect("Vercel JSON")
}

fn route<'a>(value: &'a Value, environment: &str) -> &'a Value {
    let source = format!("/backend/{environment}/:path*");
    value["rewrites"]
        .as_array()
        .unwrap()
        .iter()
        .find(|rule| rule["source"] == source)
        .expect("environment route")
}

fn production_is_bound_to_canonical_host(value: &Value) -> bool {
    let rule = route(value, "prd");
    rule["has"].as_array().is_some_and(|conditions| {
        conditions.iter().any(|condition| {
            condition["type"] == "host" && condition["value"] == "pass-share.bm1314.net"
        })
    })
}

fn hosted_routes_are_prd_only(value: &Value) -> bool {
    let proxies: Vec<_> = value["rewrites"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|rule| {
            rule["source"]
                .as_str()
                .is_some_and(|source| source.starts_with("/backend/"))
        })
        .collect();
    proxies.len() == 1
        && proxies[0]["source"] == "/backend/prd/:path*"
        && proxies[0]["destination"]
            == "https://pass-share-backend-production.up.railway.app/:path*"
        && production_is_bound_to_canonical_host(value)
}

#[test]
fn only_the_production_prefix_reaches_a_hosted_backend() {
    assert!(hosted_routes_are_prd_only(&config()));
}

#[test]
fn adding_a_development_proxy_to_production_is_rejected() {
    let mut value = config();
    assert!(hosted_routes_are_prd_only(&value));
    value["rewrites"].as_array_mut().unwrap().insert(
        0,
        serde_json::json!({
            "source": "/backend/dev/:path*",
            "destination": "https://pass-share-backend-production.up.railway.app/:path*"
        }),
    );
    assert!(!hosted_routes_are_prd_only(&value));
}

#[test]
fn production_proxy_cannot_be_selected_by_preview_hostname() {
    assert!(production_is_bound_to_canonical_host(&config()));
}

#[test]
fn missing_host_condition_would_fail_production_boundary() {
    let mut value = config();
    let rules = value["rewrites"].as_array_mut().unwrap();
    let rule = rules
        .iter_mut()
        .find(|rule| rule["source"] == "/backend/prd/:path*")
        .unwrap();
    rule.as_object_mut().unwrap().remove("has");
    assert!(!production_is_bound_to_canonical_host(&value));
}

#[test]
fn proxy_prefixes_precede_spa_and_authenticated_responses_are_not_cached() {
    let value = config();
    let rules = value["rewrites"].as_array().unwrap();
    let proxy = rules
        .iter()
        .position(|rule| rule["source"] == "/backend/prd/:path*")
        .unwrap();
    let spa = rules
        .iter()
        .position(|rule| rule["destination"] == "/index.html")
        .unwrap();
    assert!(proxy < spa);
    assert!(hosted_routes_are_prd_only(&value));
    assert!(value["headers"].as_array().unwrap().iter().any(|rule| {
        rule["source"] == "/backend/:environment/:path*"
            && rule["headers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|header| header["key"] == "Cache-Control" && header["value"] == "no-store")
    }));
}

fn sync_values_match(source: &str) -> bool {
    source
        .split_once("const ENV_VALUES = {")
        .and_then(|(_, tail)| tail.split_once('}'))
        .is_some_and(|(block, _)| {
            block.matches("VITE_API_BASE_URL:").count() == 1
                && block.contains("VITE_API_BASE_URL: '/backend/prd'")
                && block.contains("VITE_APP_ENV: 'prd'")
        })
        && source.contains("target: ['production']")
        && !source.contains("target: ['preview']")
        && !source.contains("target: ['development']")
}

#[test]
fn environment_sync_targets_only_production_on_its_origin_prefix() {
    assert!(sync_values_match(ENV_SYNC));
    assert!(!ENV_SYNC.contains("VITE_API_BASE_URL: 'https://"));
}

#[test]
fn staging_prefix_or_preview_sync_target_is_rejected() {
    assert!(sync_values_match(ENV_SYNC));
    let swapped = ENV_SYNC.replace("'/backend/prd'", "'/backend/stg'");
    assert_ne!(swapped, ENV_SYNC);
    assert!(!sync_values_match(&swapped));
    let preview = ENV_SYNC.replace("target: ['production']", "target: ['preview']");
    assert_ne!(preview, ENV_SYNC);
    assert!(!sync_values_match(&preview));
}

#[test]
fn git_configuration_enables_only_main() {
    let value = config();
    let branches = value["git"]["deploymentEnabled"].as_object().unwrap();
    assert_eq!(branches.get("main"), Some(&Value::Bool(true)));
    assert_eq!(branches.get("*"), Some(&Value::Bool(false)));
    assert_eq!(branches.get("**"), Some(&Value::Bool(false)));
    assert!(branches
        .iter()
        .all(|(branch, enabled)| branch == "main" || enabled == &Value::Bool(false)));
}
