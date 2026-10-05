use serde_json::Value;

const CLEANUP: &[&str] = &[
    "cleanup_node_reaped",
    "cleanup_owned_synthetic_databases",
    "cleanup_temporary_dump_removed",
];
const REQUIRED_POSITIVE: &[&str] = &[
    "restore_all_tables_exact_before_API",
    "reopen_gate_credentials_and_current_accounts_clean",
    "reconciled_official_API_ready",
    "reapproved_owner_item_all_values",
    "reapproved_attachment_exact_four_bytes",
    "reapproved_owner_PUT_version_plus_one",
    "reapproved_owner_PUT_requested_title",
    "saved_item_reread_all_values",
    "stale_PUT_version_409",
    "former_member_after_reapproval_write_403",
    "source_full_snapshot_unchanged_by_restore_and_API",
];

pub(super) fn validate(report: &Value, negative: bool) -> bool {
    let Some(checks) = report["checks"].as_array() else {
        return false;
    };
    let count = checks.len() as u64;
    let passed = checks.iter().filter(|c| c["passed"] == true).count() as u64;
    let exact = |name: &str, value: bool| {
        let entries = checks
            .iter()
            .filter(|c| c["name"] == name)
            .collect::<Vec<_>>();
        entries.len() == 1 && entries[0]["passed"] == value
    };
    if report["synthetic_only"] != true
        || report["check_count"].as_u64() != Some(count)
        || report["passed_count"].as_u64() != Some(passed)
        || !CLEANUP.iter().all(|name| exact(name, true))
    {
        return false;
    }
    if negative {
        report["completed"] == false
            && report["failure_class"] == "check_failed"
            && report["metadata"]["negative_control"] == true
            && exact("reopen_gate_credentials_and_current_accounts_clean", false)
            && checks
                .iter()
                .all(|c| c["name"] != "reconciled_official_API_ready")
            && report["measurements"]["rto"]["completed"] == false
    } else {
        report["completed"] == true
            && report["failure_class"].is_null()
            && report["metadata"]["negative_control"] == false
            && count == passed
            && REQUIRED_POSITIVE.iter().all(|name| exact(name, true))
            && report["measurements"]["rto"]["completed"] == true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn negative_fixture() -> Value {
        let mut checks = vec![
            json!({"name":"reopen_gate_credentials_and_current_accounts_clean","passed":false}),
        ];
        checks.extend(CLEANUP.iter().map(|n| json!({"name":n,"passed":true})));
        json!({"synthetic_only":true,"completed":false,"failure_class":"check_failed",
            "metadata":{"negative_control":true},"checks":checks,"check_count":4,"passed_count":3,
            "measurements":{"rto":{"completed":false}}})
    }

    #[test]
    fn negative_requires_absent_restart_and_present_exact_cleanup() {
        let original = negative_fixture();
        assert!(validate(&original, true));
        let mut restarted = original.clone();
        restarted["checks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"reconciled_official_API_ready","passed":true}));
        restarted["check_count"] = json!(5);
        restarted["passed_count"] = json!(4);
        assert!(!validate(&restarted, true));
        let mut no_cleanup = original.clone();
        no_cleanup["checks"]
            .as_array_mut()
            .unwrap()
            .retain(|c| !c["name"].as_str().unwrap().starts_with("cleanup_"));
        no_cleanup["check_count"] = json!(1);
        no_cleanup["passed_count"] = json!(0);
        assert!(!validate(&no_cleanup, true));
        let mut duplicate = original.clone();
        duplicate["checks"]
            .as_array_mut()
            .unwrap()
            .push(original["checks"][1].clone());
        duplicate["check_count"] = json!(5);
        duplicate["passed_count"] = json!(4);
        assert!(!validate(&duplicate, true));
    }

    #[test]
    fn positive_requires_end_to_end_names_and_complete_rto() {
        let mut names = REQUIRED_POSITIVE.to_vec();
        names.extend(CLEANUP);
        let checks = names
            .iter()
            .map(|n| json!({"name":n,"passed":true}))
            .collect::<Vec<_>>();
        let mut report = json!({"synthetic_only":true,"completed":true,"failure_class":null,
            "metadata":{"negative_control":false},"check_count":checks.len(),"passed_count":checks.len(),
            "checks":checks,"measurements":{"rto":{"completed":true}}});
        assert!(validate(&report, false));
        for required in REQUIRED_POSITIVE {
            let mut omitted = report.clone();
            omitted["checks"]
                .as_array_mut()
                .unwrap()
                .retain(|c| c["name"] != *required);
            omitted["check_count"] = json!(names.len() - 1);
            omitted["passed_count"] = json!(names.len() - 1);
            assert!(!validate(&omitted, false));
        }
        report["measurements"]["rto"]["completed"] = json!(false);
        assert!(!validate(&report, false));
    }
}
