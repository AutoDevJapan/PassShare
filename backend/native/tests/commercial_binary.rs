use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

// Exercise the shipping protocol, not a direct call into the policy module.
fn invoke(request: &Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_passshare-mutations"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start native binary");
    child.stdin.take().unwrap()
        .write_all(request.to_string().as_bytes()).expect("send small request");
    let output = child.wait_with_output().expect("collect native reply");
    assert!(output.status.success(), "native binary aborted");
    assert!(output.stderr.is_empty(), "native binary emitted diagnostics");
    serde_json::from_slice(&output.stdout).expect("native JSON reply")
}

fn actor() -> Value {
    json!({"sessionValid":true,"accountRemoved":false,"identityConfirmed":true,
        "billingAdministrator":true,"membershipActive":true,"hasExportScope":true})
}

fn quote() -> Value {
    json!({"command":"commercial-quote","currency":"JPY",
        "plan":{"type":"personal","users":1},
        "setup":{"installationCompanies":0,"supportHours":0,"maintenanceMonthlyJpy":null}})
}

#[test]
fn binary_quotes_approved_prices_and_never_reports_a_completed_purchase() {
    let mut request = quote();
    let personal = invoke(&request);
    assert_eq!(personal["status"], 200);
    assert_eq!(personal["body"]["monthlyTotalJpy"], 980);
    request["plan"] = json!({"type":"team","administrators":1,"members":1});
    let team = invoke(&request);
    assert_eq!(team["body"]["monthlyTotalJpy"], 2480);
    assert_eq!(team["body"]["policy"]["actualContractCreated"], false);
    assert_eq!(team["body"]["policy"]["paymentAdapterExecuted"], false);
}

#[test]
fn malformed_ascii_dates_return_a_fixed_error_instead_of_aborting() {
    for date in ["/026-01-31", "2026-/1-31", "2026-01-/1", "2026-00-01", "2026-02-29"] {
        let reply = invoke(&json!({"command":"commercial-lifecycle-decision",
            "operation":"renewal-preview","contractStart":date,"cycles":2}));
        assert_eq!(reply["status"], 400, "{date}");
        assert!(!reply.to_string().contains(date), "error echoes input");
    }
    let reply = invoke(&json!({"command":"commercial-lifecycle-decision",
        "operation":"renewal-preview","contractStart":"2026-01-31","cycles":2}));
    assert_eq!(reply["body"]["periods"][0]["periodEnd"], "2026-02-28");
    assert_eq!(reply["body"]["periods"][1]["periodEnd"], "2026-03-31");
}

#[test]
fn every_actor_assertion_must_be_a_boolean() {
    let request = json!({"command":"commercial-lifecycle-decision","operation":"post-end-export",
        "contractEnd":"2026-03-01","requestDate":"2026-03-15","actor":actor()});
    assert_eq!(invoke(&request)["status"], 200);
    for field in ["sessionValid","accountRemoved","identityConfirmed",
        "billingAdministrator","membershipActive","hasExportScope"] {
        for value in [Value::Null, json!(0), json!("false"), json!([])] {
            let mut changed = request.clone();
            changed["actor"][field] = value;
            assert_eq!(invoke(&changed)["status"], 400, "malformed assertion {field}");
        }
    }
}

#[test]
fn thirty_calendar_days_do_not_become_thirty_one() {
    let mut request = json!({"command":"commercial-lifecycle-decision","operation":"post-end-export",
        "contractEnd":"2026-03-01","requestDate":"2026-03-30","actor":actor()});
    assert_eq!(invoke(&request)["status"], 200);
    request["requestDate"] = json!("2026-03-31");
    assert_eq!(invoke(&request)["status"], 403);
    request["requestDate"] = json!("2026-02-28");
    assert_eq!(invoke(&request)["status"], 403);
    request["requestDate"] = json!("2026-03-15");
    request["actor"]["hasExportScope"] = json!(false);
    assert_eq!(invoke(&request)["status"], 403, "billing admin cannot grant key scope");
}

#[test]
fn amounts_crossing_the_json_transport_integer_limit_are_rejected() {
    const MAX: u64 = 9_007_199_254_740_991;
    let mut request = quote();
    request["plan"]["users"] = json!(MAX / 980);
    assert_eq!(invoke(&request)["status"], 200, "last safe multiple");
    request["plan"]["users"] = json!(MAX / 980 + 1);
    assert_eq!(invoke(&request)["status"], 400, "unsafe calculated subscription amount");
    request = quote();
    request["setup"]["supportHours"] = json!(MAX / 10_000);
    assert_eq!(invoke(&request)["status"], 200);
    request["setup"]["installationCompanies"] = json!(1);
    assert_eq!(invoke(&request)["status"], 400, "unsafe summed one-time amount");
}
