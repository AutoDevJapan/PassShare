use super::*;
use serde_json::json;

#[test]
#[cfg(target_os = "linux")]
fn generated_credentials_use_os_entropy_without_a_fixed_password_prefix() {
    let first = synthetic_password().unwrap();
    let second = synthetic_password().unwrap();
    assert_eq!(first.len(), 32);
    assert_eq!(second.len(), 32);
    assert_ne!(first, second);
    assert!(first
        .bytes()
        .chain(second.bytes())
        .all(|b| (33..=126).contains(&b)));
}

fn valid_inputs() -> Vec<(String, String)> {
    vec![
        (
            "PASSSHARE_RESTORE_DRILL".into(),
            "synthetic-container-v1".into(),
        ),
        (
            "DRILL_SOURCE_SHA".into(),
            "aea0e7bdbb249a8466b7f65f774e9cccd1312883".into(),
        ),
        ("DRILL_BACKEND_SHA256".into(), "a".repeat(64)),
    ]
}

#[test]
fn input_guard_requires_container_and_rejects_connection_inputs() {
    let inputs = valid_inputs();
    assert!(validate_inputs(1, true, &inputs).is_ok());
    assert!(validate_inputs(2, true, &inputs).is_err());
    assert!(validate_inputs(1, false, &inputs).is_err());
    assert!(validate_inputs(1, true, &[]).is_err());
    for key in [
        "DATABASE_URL",
        "PGHOST",
        "PGSERVICEFILE",
        "POSTGRES_PASSWORD",
        "OP_CONNECT_HOST",
        "CONNECT_TOKEN",
        "NODE_OPTIONS",
        "PASSSHARE_MUTATIONS_BIN",
        "AWS_SECRET_ACCESS_KEY",
        "HTTP_PROXY",
    ] {
        let mut bad = inputs.clone();
        bad.push((key.into(), "production-value-must-never-be-reported".into()));
        assert!(
            validate_inputs(1, true, &bad).is_err(),
            "guard allowed {key}"
        );
    }
    let mut bad_sha = inputs;
    bad_sha[1].1 = "main; injection".into();
    assert!(validate_inputs(1, true, &bad_sha).is_err());
    assert!(database_url("drill_source").is_ok());
    assert!(database_url("drill_restored").is_ok());
    for db in [
        "postgres",
        "customers",
        "drill_source?host=production",
        "drill_source;DROP",
    ] {
        assert!(database_url(db).is_err());
    }
}

#[test]
fn exact_json_ignores_key_order_but_preserves_all_values_and_array_order() {
    let a = json!({"x": [{"b": 2, "a": "日本語"}], "nullable": null});
    let b: Value = serde_json::from_str(r#"{"nullable":null,"x":[{"a":"日本語","b":2}]}"#).unwrap();
    assert!(exact_json(&a, &b));
    for altered in [
        json!({"x": [{"b": 3, "a": "日本語"}], "nullable": null}),
        json!({"x": [{"b": 2, "a": "日本語"}]}),
        json!({"x": [{"b": 2, "a": "日本語"}], "nullable": "null"}),
    ] {
        assert!(!exact_json(&a, &altered));
    }
    assert!(!exact_json(&json!([1, 2]), &json!([2, 1])));
}

#[test]
fn negative_status_is_exact_and_transport_failure_cannot_pass() {
    for expected in [401, 403, 404, 409] {
        assert!(status_matches(Some(expected), expected));
        for actual in [None, Some(200), Some(400), Some(500)] {
            assert!(!status_matches(actual, expected));
        }
    }
}

#[test]
fn fixture_and_comparison_detect_added_field_url_and_attachment_loss() {
    let item = item_fixture("Synthetic restore item");
    assert_eq!(item["fields"][1]["value"], "日本語の追加欄");
    assert_eq!(item["urls"].as_array().unwrap().len(), 2);
    let mut missing = item.clone();
    missing["fields"].as_array_mut().unwrap().remove(1);
    assert!(!exact_json(&item, &missing));
    let mut reversed = item.clone();
    reversed["urls"].as_array_mut().unwrap().reverse();
    assert!(!exact_json(&item, &reversed));
    assert!(attachment_matches(200, &[0, 1, 254, 255]));
    assert!(!attachment_matches(200, &[0, 1, 254]));
    assert!(!attachment_matches(200, &[0, 1, 255, 254]));
    assert!(!attachment_matches(403, &[0, 1, 254, 255]));
}

#[test]
fn snapshot_cannot_succeed_with_missing_or_empty_required_tables() {
    let mut snapshot = serde_json::Map::new();
    for table in TABLES {
        snapshot.insert((*table).into(), json!([{"synthetic": true}]));
    }
    let value = Value::Object(snapshot.clone());
    assert!(snapshot_populated(&value));
    snapshot.remove("sessions");
    assert!(!snapshot_populated(&Value::Object(snapshot.clone())));
    snapshot.insert("sessions".into(), json!([]));
    assert!(!snapshot_populated(&Value::Object(snapshot)));
}

#[test]
fn report_records_actual_checks_and_only_static_failure_categories() {
    let mut report = Report::new(None);
    report.check("positive_fixture", true).unwrap();
    assert!(report.check("negative_fixture", false).is_err());
    let encoded = report.json(false, Some(Failure::Http)).to_string();
    let decoded: Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded["check_count"], 2);
    assert_eq!(decoded["passed_count"], 1);
    assert_eq!(decoded["failure_class"], "http_transport");
    assert_eq!(decoded["checks"][1]["passed"], false);
    assert!(!encoded.contains("refreshToken"));
}

#[test]
fn negative_control_without_credential_purge_blocks_reopening() {
    let clean = json!({"sessions": 0, "tokens": 0, "memberships": 0, "pending": 0,
        "current_password_matches": true, "deleted_account_absent": true});
    assert!(reopen_state_clean(&clean));
    for key in ["sessions", "tokens", "memberships", "pending"] {
        let mut dirty = clean.clone();
        dirty[key] = json!(1);
        assert!(!reopen_state_clean(&dirty));
        let mut report = Report::new(None);
        assert!(report
            .check(
                "reopen_gate_credentials_and_current_accounts_clean",
                reopen_state_clean(&dirty)
            )
            .is_err());
        assert_eq!(report.json(false, Some(Failure::Check))["completed"], false);
    }
    for key in ["current_password_matches", "deleted_account_absent"] {
        let mut dirty = clean.clone();
        dirty[key] = json!(false);
        assert!(!reopen_state_clean(&dirty));
    }
    assert!(!reopen_state_clean(&json!({})));
    let mut control = valid_inputs();
    control.push((
        "PASSSHARE_DRILL_CONTROL".into(),
        "omit-credential-purge".into(),
    ));
    assert!(validate_inputs(1, true, &control).unwrap().omit_purge);
    control.last_mut().unwrap().1 = "arbitrary-script".into();
    assert!(validate_inputs(1, true, &control).is_err());
}

#[cfg(target_os = "linux")]
fn fixture_child() -> OwnedChild {
    let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
    cmd.args([
        "--exact",
        "tests::child_fixture",
        "--ignored",
        "--nocapture",
    ])
    .env("PASSSHARE_CHILD_FIXTURE", "1")
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
    OwnedChild::spawn(&mut cmd).unwrap()
}

#[test]
#[ignore = "spawned only by the lifecycle tests"]
fn child_fixture() {
    assert_eq!(std::env::var("PASSSHARE_CHILD_FIXTURE").unwrap(), "1");
    loop {
        std::thread::park();
    }
}

#[test]
#[cfg(target_os = "linux")]
fn child_is_killed_and_reaped_on_explicit_stop_and_failure_unwind() {
    let mut child = fixture_child();
    let pid = child.pid();
    assert!(std::path::Path::new(&format!("/proc/{pid}")).exists());
    child.stop().unwrap();
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    child.stop().unwrap(); // Repeated cleanup is harmless.
    let pid_cell = std::cell::Cell::new(0);
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let child = fixture_child();
        pid_cell.set(child.pid());
        panic!("synthetic injected failure");
    }));
    assert!(failure.is_err());
    assert!(!std::path::Path::new(&format!("/proc/{}", pid_cell.get())).exists());
}

#[test]
fn temporary_dump_directory_is_removed_even_on_early_return() {
    let path;
    {
        let temporary = Temporary::create().unwrap();
        path = temporary.path.clone();
        std::fs::write(path.join("synthetic.dump"), [0, 1, 2]).unwrap();
        assert!(path.exists());
    }
    assert!(!path.exists());
}
