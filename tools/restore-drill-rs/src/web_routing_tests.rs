//! The browser must reach its own site's proxy; direct cross-site cookie auth fails.
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

#[test]
fn each_relative_prefix_targets_only_its_environment() {
    let value = config();
    for (environment, backend) in [
        ("prd", "production"),
        ("stg", "staging"),
        ("dev", "development"),
    ] {
        assert_eq!(
            route(&value, environment)["destination"],
            format!("https://pass-share-backend-{backend}.up.railway.app/:path*")
        );
    }
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
    assert_eq!(rules.len(), 4);
    assert_eq!(rules[3]["destination"], "/index.html");
    assert!(rules[..3]
        .iter()
        .all(|rule| rule["source"].as_str().unwrap().starts_with("/backend/")));
    assert!(value["headers"].as_array().unwrap().iter().any(|rule| {
        rule["source"] == "/backend/:environment/:path*"
            && rule["headers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|header| header["key"] == "Cache-Control" && header["value"] == "no-store")
    }));
}

#[test]
fn environment_sync_keeps_auth_and_connect_on_same_origin() {
    for environment in ["prd", "stg", "dev"] {
        assert!(ENV_SYNC.contains(&format!("VITE_API_BASE_URL: '/backend/{environment}'")));
    }
    assert!(!ENV_SYNC.contains("VITE_API_BASE_URL: 'https://"));
}
