use super::*;

const OWNER: &str = "owner@example.invalid";
const MEMBER: &str = "member@example.invalid";
const INVITEE: &str = "invitee@example.invalid";
const DELETED: &str = "deleted@example.invalid";
const OLD_PASSWORD: &str = "SyntheticOwner123!";
const CURRENT_PASSWORD: &str = "SyntheticCurrent123!";
const INVITE_PASSWORD: &str = "SyntheticInvite123!";
const DELETED_PASSWORD: &str = "SyntheticDeleted123!";

struct Account {
    id: String,
    session: String,
    access: String,
}

fn text(value: &Value, pointer: &str) -> Result<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .map(str::to_owned)
        .ok_or(Failure::Shape)
}
fn identifier(value: &Value, pointer: &str, length: usize) -> Result<String> {
    let id = text(value, pointer)?;
    if id.len() != length || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(Failure::Shape);
    }
    Ok(id)
}

impl Api {
    fn account(
        &self,
        report: &mut Report,
        name: &'static str,
        signup: bool,
        email: &str,
        password: &str,
    ) -> Result<Account> {
        let path = if signup {
            "/api/auth/signup"
        } else {
            "/api/auth/login"
        };
        let value = self.json(
            report,
            name,
            "POST",
            path,
            "",
            Some(&json!({"email": email, "password": password})),
            if signup { 201 } else { 200 },
            None,
        )?;
        Ok(Account {
            id: identifier(&value, "/user/id", 36)?,
            session: text(&value, "/refreshToken")?,
            access: text(&value, "/connectAccessToken")?,
        })
    }
    fn connect(&self, report: &mut Report, name: &'static str, session: &str) -> Result<String> {
        let response = self.json(
            report,
            name,
            "GET",
            "/api/auth/connect-token",
            session,
            None,
            200,
            None,
        )?;
        text(&response, "/accessToken")
    }
}

impl Runner {
    pub(super) fn run(&mut self, report: &mut Report, inputs: &Inputs) -> Result<()> {
        report.check("fixed_synthetic_container_inputs", true)?;
        report.check(
            "official_backend_and_native_present",
            Path::new("/app/src/index.js").is_file() && Path::new(NATIVE).is_file(),
        )?;
        report.measurement(
            "native_sha256",
            json!(sha256(None, Some(Path::new(NATIVE)))?),
        );
        report.measurement(
            "backend_entry_sha256",
            json!(sha256(None, Some(Path::new("/app/src/index.js")))?),
        );

        // Refuse a reused database. No DROP IF EXISTS, no connection string inputs.
        sql("postgres", "CREATE DATABASE drill_source;")?;
        self.source_created = true;
        self.start_api("drill_source", report, "source_official_api_ready")?;
        let table_names: Value = serde_json::from_str(&sql("drill_source",
            "SELECT COALESCE(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public';")?)
            .map_err(|_| Failure::Json)?;
        let mut expected_tables = TABLES.to_vec();
        expected_tables.sort_unstable();
        report.check(
            "ten_required_plus_native_schema_tables_only",
            table_names == json!(expected_tables),
        )?;

        let owner = self
            .api
            .account(report, "source_owner_signup", true, OWNER, OLD_PASSWORD)?;
        let member = self.api.account(
            report,
            "source_member_signup",
            true,
            MEMBER,
            CURRENT_PASSWORD,
        )?;
        let invitee = self.api.account(
            report,
            "source_invitee_signup",
            true,
            INVITEE,
            INVITE_PASSWORD,
        )?;
        let deleted = self.api.account(
            report,
            "source_deleted_fixture_signup",
            true,
            DELETED,
            DELETED_PASSWORD,
        )?;
        let boxes = self.api.json(
            report,
            "source_owner_boxes_status",
            "GET",
            "/v1/vaults",
            &owner.access,
            None,
            200,
            None,
        )?;
        report.check(
            "source_owner_has_one_box",
            boxes.as_array().is_some_and(|b| b.len() == 1),
        )?;
        let box_id = identifier(&boxes, "/0/id", 26)?;
        let items_path = format!("/v1/vaults/{box_id}/items");
        let sharing_path = format!("/api/auth/vaults/{box_id}");

        let fixture = item_fixture("Synthetic restore item");
        let item = self.api.json(
            report,
            "source_native_item_creation",
            "POST",
            &items_path,
            &owner.access,
            Some(&fixture),
            201,
            Some("synthetic-restore-before-0001"),
        )?;
        let item_id = identifier(&item, "/id", 26)?;
        let item_path = format!("{items_path}/{item_id}");
        // Check the API did not already discard the fixture's additional data.
        for key in ["urls", "tags", "sections"] {
            if !exact_json(&fixture[key], &item[key]) {
                return report.check("source_fixture_complete", false);
            }
        }
        let field_values = item["fields"].as_array().ok_or(Failure::Shape)?;
        let fixture_fields = fixture["fields"].as_array().ok_or(Failure::Shape)?;
        let fields_kept = field_values.len() == fixture_fields.len()
            && field_values.iter().zip(fixture_fields).all(|(a, b)| {
                b.as_object()
                    .is_some_and(|fields| fields.iter().all(|(key, value)| a[key] == *value))
            });
        report.check("source_fixture_complete", fields_kept)?;
        let second_item = self.api.json(
            report,
            "source_second_item_creation",
            "POST",
            &items_path,
            &owner.access,
            Some(&item_fixture("Synthetic second item")),
            201,
            Some("synthetic-restore-before-0002"),
        )?;
        let second_id = identifier(&second_item, "/id", 26)?;
        let second_path = format!("{items_path}/{second_id}");
        let file = self.api.json(
            report,
            "source_attachment_creation",
            "POST",
            &format!("{item_path}/files"),
            &owner.access,
            Some(&json!({"name": "synthetic.bin", "contentBase64": "AAH+/w=="})),
            201,
            None,
        )?;
        report.check(
            "source_attachment_four_bytes",
            file["size"].as_u64() == Some(4),
        )?;
        let file_id = identifier(&file, "/id", 26)?;
        let file_path = format!("{item_path}/files/{file_id}");

        let invitation = self.api.json(
            report,
            "source_member_invitation",
            "POST",
            &format!("{sharing_path}/invitations"),
            &owner.session,
            Some(&json!({"email": MEMBER, "role": "member"})),
            201,
            None,
        )?;
        let accepted_id = identifier(&invitation, "/id", 36)?;
        self.api.json(
            report,
            "source_member_acceptance",
            "POST",
            &format!("/api/auth/invitations/{accepted_id}/accept"),
            &member.session,
            Some(&json!({})),
            200,
            None,
        )?;
        let member_access =
            self.api
                .connect(report, "source_member_fresh_connect", &member.session)?;
        let shared_item = self.api.json(
            report,
            "source_member_reads_item",
            "GET",
            &item_path,
            &member_access,
            None,
            200,
            None,
        )?;
        report.check(
            "source_member_reads_full_item",
            exact_json(&item, &shared_item),
        )?;
        let pending = self.api.json(
            report,
            "source_pending_invitation",
            "POST",
            &format!("{sharing_path}/invitations"),
            &owner.session,
            Some(&json!({"email": INVITEE, "role": "member"})),
            201,
            None,
        )?;
        let pending_id = identifier(&pending, "/id", 36)?;

        // This final fixture write populates both login guard tables, not fabricated rows.
        // Bracket its committed update; no API mutations occur between this and dump.
        let last_update_begin = unix_ms();
        self.api.json(
            report,
            "source_synthetic_failed_login",
            "POST",
            "/api/auth/login",
            "",
            Some(&json!({"email": "absent@example.invalid", "password": "SyntheticAbsent123!"})),
            401,
            None,
        )?;
        let last_update_end = unix_ms();
        let baseline = snapshot("drill_source")?;
        report.check(
            "snapshot_all_ten_and_native_tables_populated",
            snapshot_populated(&baseline),
        )?;
        report.measurement(
            "baseline_sha256",
            json!(sha256(
                Some(serde_json::to_vec(&baseline).map_err(|_| Failure::Json)?),
                None
            )?),
        );
        report.measurement(
            "last_included_update_range",
            json!({
                "from_unix_ms": last_update_begin, "through_unix_ms": last_update_end,
                "basis": "last_quiescent_fixture_HTTP_write_commit_bracket",
            }),
        );

        let dump_path = self.temporary.path.join("synthetic.dump");
        let dump_begin = unix_ms();
        let dump_start = Instant::now();
        let mut dump = pg_command("pg_dump", "drill_source")?;
        dump.args(["--format=custom", "--no-owner", "--no-acl", "--file"])
            .arg(&dump_path);
        command_output(dump, None)?;
        let dump_end = unix_ms();
        report.measurement("dump_ms", json!(dump_start.elapsed().as_millis() as u64));
        report.measurement(
            "dump_snapshot_range",
            json!({"from_unix_ms": dump_begin, "through_unix_ms": dump_end}),
        );
        report.measurement("dump_sha256", json!(sha256(None, Some(&dump_path))?));
        report.measurement(
            "dump_bytes",
            json!(std::fs::metadata(&dump_path)
                .map_err(|_| Failure::Io)?
                .len()),
        );
        // Prove the snapshot/dump were quiescent even if a future backend gains a sweeper.
        report.check(
            "source_snapshot_stable_through_dump",
            exact_json(&baseline, &snapshot("drill_source")?),
        )?;

        let excluded_begin = unix_ms();
        let late_item = self.api.json(
            report,
            "source_post_backup_item_added",
            "POST",
            &items_path,
            &owner.access,
            Some(&item_fixture("Synthetic excluded item")),
            201,
            Some("synthetic-restore-after-0001"),
        )?;
        let late_id = identifier(&late_item, "/id", 26)?;
        let late_path = format!("{items_path}/{late_id}");
        self.api.json(
            report,
            "source_member_removed",
            "DELETE",
            &format!("{sharing_path}/members/{}", member.id),
            &owner.session,
            None,
            204,
            None,
        )?;
        self.api.json(
            report,
            "source_old_member_token_denied",
            "GET",
            &item_path,
            &member_access,
            None,
            401,
            None,
        )?;
        self.api.json(
            report,
            "source_invitation_cancelled",
            "DELETE",
            &format!("{sharing_path}/invitations/{pending_id}"),
            &owner.session,
            None,
            204,
            None,
        )?;
        // Simulated current account state; there is no claim of a password/delete API.
        sql("drill_source", "BEGIN; UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE email='member@example.invalid') WHERE email='owner@example.invalid'; DELETE FROM users WHERE email='deleted@example.invalid'; COMMIT;")?;
        self.api.json(
            report,
            "source_changed_password_denies_old",
            "POST",
            "/api/auth/login",
            "",
            Some(&json!({"email": OWNER, "password": OLD_PASSWORD})),
            401,
            None,
        )?;
        self.api.json(
            report,
            "source_deleted_account_denied",
            "POST",
            "/api/auth/login",
            "",
            Some(&json!({"email": DELETED, "password": DELETED_PASSWORD})),
            401,
            None,
        )?;
        let excluded_end = unix_ms();
        report.measurement("excluded_updates_range", json!({"from_unix_ms": excluded_begin,
            "through_unix_ms": excluded_end, "item_additions": 1,
            "other_changes": "membership_removal_invitation_revocation_SQL_account_state_and_auth_request_records"}));
        let source_after = snapshot("drill_source")?;
        report.check(
            "source_post_backup_item_present",
            source_after["connect_items"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["id"] == late_id)),
        )?;
        report.check(
            "source_has_exactly_one_post_backup_item",
            source_after["connect_items"].as_array().map(Vec::len) == Some(3),
        )?;

        // Synthetic RTO starts at the *first* stop attempt, before switching DBs.
        let rto_start = Instant::now();
        let rto_begin = unix_ms();
        report.measurement(
            "rto",
            json!({"started_at_unix_ms": rto_begin, "completed": false}),
        );
        self.stop_api(report, "first_source_API_stop_and_local_connection_refusal")?;
        let create_start = Instant::now();
        sql("postgres", "CREATE DATABASE drill_restored;")?;
        self.restored_created = true;
        report.measurement(
            "restore_database_create_ms",
            json!(create_start.elapsed().as_millis() as u64),
        );
        let restore_start = Instant::now();
        let mut restore = pg_command("pg_restore", "drill_restored")?;
        restore
            .args([
                "--exit-on-error",
                "--no-owner",
                "--no-acl",
                "--dbname=drill_restored",
            ])
            .arg(&dump_path);
        command_output(restore, None)?;
        report.measurement(
            "pg_restore_ms",
            json!(restore_start.elapsed().as_millis() as u64),
        );
        let compare_start = Instant::now();
        let restored = snapshot("drill_restored")?;
        // Individually count the original ten comparisons plus the native extra table.
        let names = [
            "restore_connect_vaults_full_rows",
            "restore_connect_items_full_rows",
            "restore_connect_item_files_full_rows",
            "restore_users_full_rows",
            "restore_sessions_full_rows",
            "restore_connect_tokens_full_rows",
            "restore_memberships_full_rows",
            "restore_invitations_full_rows",
            "restore_login_failures_full_rows",
            "restore_login_ip_requests_full_rows",
            "restore_native_operations_full_rows",
        ];
        for (table, name) in TABLES.iter().zip(names) {
            report.check(name, exact_json(&baseline[*table], &restored[*table]))?;
        }
        report.check(
            "restore_all_tables_exact_before_API",
            exact_json(&baseline, &restored),
        )?;
        report.check(
            "restore_excludes_post_backup_item",
            restored["connect_items"]
                .as_array()
                .is_some_and(|rows| rows.len() == 2 && rows.iter().all(|r| r["id"] != late_id)),
        )?;
        report.measurement(
            "restore_compare_ms",
            json!(compare_start.elapsed().as_millis() as u64),
        );

        self.start_api(
            "drill_restored",
            report,
            "unsafe_restored_official_API_ready",
        )?;
        self.api.json(
            report,
            "unsafe_restore_old_member_token_revived",
            "GET",
            &item_path,
            &member_access,
            None,
            200,
            None,
        )?;
        self.api.json(
            report,
            "unsafe_restore_old_owner_session_revived",
            "GET",
            "/api/auth/me",
            &owner.session,
            None,
            200,
            None,
        )?;
        self.api.json(
            report,
            "unsafe_restore_old_password_revived",
            "POST",
            "/api/auth/login",
            "",
            Some(&json!({"email": OWNER, "password": OLD_PASSWORD})),
            200,
            None,
        )?;
        self.api.json(
            report,
            "unsafe_restore_deleted_account_revived",
            "POST",
            "/api/auth/login",
            "",
            Some(&json!({"email": DELETED, "password": DELETED_PASSWORD})),
            200,
            None,
        )?;
        let pending_restored = self.api.json(
            report,
            "unsafe_restore_invitation_list",
            "GET",
            "/api/auth/invitations",
            &invitee.session,
            None,
            200,
            None,
        )?;
        report.check(
            "unsafe_restore_cancelled_invitation_revived",
            pending_restored["invitations"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["id"] == pending_id)),
        )?;
        self.stop_api(report, "restored_API_closed_before_SQL_reconciliation")?;
        let reconcile_start = Instant::now();
        let purge = if inputs.omit_purge {
            ""
        } else {
            "DELETE FROM sessions; DELETE FROM connect_tokens;"
        };
        sql("drill_restored", &format!("BEGIN; {purge} DELETE FROM vault_memberships; UPDATE vault_invitations SET status='revoked',responded_at=NOW() WHERE status='pending'; UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE email='member@example.invalid') WHERE email='owner@example.invalid'; DELETE FROM users WHERE email='deleted@example.invalid'; COMMIT;"))?;
        let state: Value = serde_json::from_str(&sql("drill_restored", "SELECT jsonb_build_object('sessions',(SELECT count(*) FROM sessions),'tokens',(SELECT count(*) FROM connect_tokens),'memberships',(SELECT count(*) FROM vault_memberships),'pending',(SELECT count(*) FROM vault_invitations WHERE status='pending'),'current_password_matches',(SELECT a.password_hash=b.password_hash FROM users a,users b WHERE a.email='owner@example.invalid' AND b.email='member@example.invalid'),'deleted_account_absent',NOT EXISTS(SELECT 1 FROM users WHERE email='deleted@example.invalid')); ")?)
            .map_err(|_| Failure::Json)?;
        // Omit-purge intentionally fails here, while Node remains stopped, exit 1.
        report.check(
            "reopen_gate_credentials_and_current_accounts_clean",
            reopen_state_clean(&state),
        )?;
        let after_reconcile = snapshot("drill_restored")?;
        report.check(
            "reconciliation_keeps_all_items_boxes_and_attachments",
            [
                "connect_vaults",
                "connect_items",
                "connect_item_files",
                "mutation_operations",
            ]
            .iter()
            .all(|table| exact_json(&baseline[*table], &after_reconcile[*table])),
        )?;
        report.measurement(
            "reconciliation_ms",
            json!(reconcile_start.elapsed().as_millis() as u64),
        );
        self.start_api("drill_restored", report, "reconciled_official_API_ready")?;

        for (account, name) in [
            (&owner, "old_owner_session_401"),
            (&member, "old_member_session_401"),
            (&invitee, "old_invitee_session_401"),
            (&deleted, "old_deleted_session_401"),
        ] {
            self.api.json(
                report,
                name,
                "GET",
                "/api/auth/me",
                &account.session,
                None,
                401,
                None,
            )?;
        }
        self.api.json(
            report,
            "old_owner_connect_401",
            "GET",
            &item_path,
            &owner.access,
            None,
            401,
            None,
        )?;
        self.api.json(
            report,
            "old_member_connect_401",
            "GET",
            &item_path,
            &member_access,
            None,
            401,
            None,
        )?;
        self.api.json(
            report,
            "old_refresh_token_401",
            "POST",
            "/api/auth/token/refresh",
            "",
            Some(&json!({"refreshToken": owner.session})),
            401,
            None,
        )?;
        self.api.json(
            report,
            "old_password_still_401",
            "POST",
            "/api/auth/login",
            "",
            Some(&json!({"email": OWNER, "password": OLD_PASSWORD})),
            401,
            None,
        )?;
        self.api.json(
            report,
            "deleted_account_still_401",
            "POST",
            "/api/auth/login",
            "",
            Some(&json!({"email": DELETED, "password": DELETED_PASSWORD})),
            401,
            None,
        )?;
        let current_owner = self.api.account(
            report,
            "current_owner_login",
            false,
            OWNER,
            CURRENT_PASSWORD,
        )?;
        let current_member = self.api.account(
            report,
            "current_former_member_login",
            false,
            MEMBER,
            CURRENT_PASSWORD,
        )?;
        let current_invitee = self.api.account(
            report,
            "current_invitee_login",
            false,
            INVITEE,
            INVITE_PASSWORD,
        )?;
        self.api.json(
            report,
            "unapproved_owner_read_403",
            "GET",
            &item_path,
            &current_owner.access,
            None,
            403,
            None,
        )?;
        self.api.json(
            report,
            "unapproved_owner_write_403",
            "PUT",
            &item_path,
            &current_owner.access,
            Some(&item),
            403,
            None,
        )?;
        self.api.json(
            report,
            "unapproved_former_member_403",
            "GET",
            &item_path,
            &current_member.access,
            None,
            403,
            None,
        )?;
        self.api.json(
            report,
            "cancelled_invite_accept_404",
            "POST",
            &format!("/api/auth/invitations/{pending_id}/accept"),
            &current_invitee.session,
            Some(&json!({})),
            404,
            None,
        )?;

        // SQL fixture reapproval, not completed identity verification or a reapproval API.
        // IDs validated before SQL construction; no external identifiers are accepted.
        sql("drill_restored", &format!("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES ('{}','{box_id}','owner');", owner.id))?;
        let fresh = self.api.connect(
            report,
            "reapproved_owner_fresh_connect",
            &current_owner.session,
        )?;
        let recovered = self.api.json(
            report,
            "reapproved_owner_item_status",
            "GET",
            &item_path,
            &fresh,
            None,
            200,
            None,
        )?;
        report.check(
            "reapproved_owner_item_all_values",
            exact_json(&item, &recovered),
        )?;
        let recovered_second = self.api.json(
            report,
            "reapproved_owner_second_item_status",
            "GET",
            &second_path,
            &fresh,
            None,
            200,
            None,
        )?;
        report.check(
            "reapproved_owner_second_item_all_values",
            exact_json(&second_item, &recovered_second),
        )?;
        let recovered_file = self.api.json(
            report,
            "reapproved_attachment_metadata_status",
            "GET",
            &file_path,
            &fresh,
            None,
            200,
            None,
        )?;
        report.check(
            "reapproved_attachment_metadata_all_values",
            exact_json(&file, &recovered_file),
        )?;
        let binary = self
            .api
            .request("GET", &format!("{file_path}/content"), &fresh, None, None);
        report.check(
            "reapproved_attachment_exact_four_bytes",
            binary
                .as_ref()
                .is_ok_and(|(status, bytes)| attachment_matches(*status, bytes)),
        )?;
        self.api.json(
            report,
            "post_backup_item_API_404",
            "GET",
            &late_path,
            &fresh,
            None,
            404,
            None,
        )?;

        let mut edit = item.clone();
        edit["title"] = json!("Synthetic owner update after recovery");
        let saved = self.api.json(
            report,
            "reapproved_owner_PUT_success",
            "PUT",
            &item_path,
            &fresh,
            Some(&edit),
            200,
            None,
        )?;
        report.check(
            "reapproved_owner_PUT_version_plus_one",
            item["version"]
                .as_u64()
                .filter(|v| *v > 0)
                .and_then(|v| v.checked_add(1))
                .is_some_and(|expected| saved["version"].as_u64() == Some(expected)),
        )?;
        report.check(
            "reapproved_owner_PUT_requested_title",
            saved["title"] == edit["title"],
        )?;
        report.check(
            "PUT_preserves_additional_data",
            ["fields", "urls", "tags", "sections"]
                .iter()
                .all(|k| exact_json(&item[*k], &saved[*k])),
        )?;
        self.api.json(
            report,
            "stale_PUT_version_409",
            "PUT",
            &item_path,
            &fresh,
            Some(&edit),
            409,
            None,
        )?;
        let reread = self.api.json(
            report,
            "saved_item_reread_status",
            "GET",
            &item_path,
            &fresh,
            None,
            200,
            None,
        )?;
        report.check("saved_item_reread_all_values", exact_json(&saved, &reread))?;
        let saved_binary =
            self.api
                .request("GET", &format!("{file_path}/content"), &fresh, None, None);
        report.check(
            "PUT_preserves_attachment_four_bytes",
            saved_binary
                .as_ref()
                .is_ok_and(|(status, bytes)| attachment_matches(*status, bytes)),
        )?;
        self.api.json(
            report,
            "former_member_after_reapproval_read_403",
            "GET",
            &item_path,
            &current_member.access,
            None,
            403,
            None,
        )?;
        self.api.json(
            report,
            "former_member_after_reapproval_write_403",
            "PUT",
            &item_path,
            &current_member.access,
            Some(&saved),
            403,
            None,
        )?;
        self.api.json(
            report,
            "former_member_attachment_403",
            "GET",
            &format!("{file_path}/content"),
            &current_member.access,
            None,
            403,
            None,
        )?;
        let members = self.api.json(
            report,
            "reapproved_members_list_status",
            "GET",
            &format!("{sharing_path}/members"),
            &current_owner.session,
            None,
            200,
            None,
        )?;
        report.check(
            "only_SQL_reapproved_owner_is_member",
            members["members"].as_array().is_some_and(|rows| {
                rows.len() == 1 && rows[0]["userId"] == owner.id && rows[0]["role"] == "owner"
            }),
        )?;
        report.check(
            "source_full_snapshot_unchanged_by_restore_and_API",
            exact_json(&source_after, &snapshot("drill_source")?),
        )?;
        report.measurement(
            "source_after_sha256",
            json!(sha256(
                Some(serde_json::to_vec(&source_after).map_err(|_| Failure::Json)?),
                None
            )?),
        );
        report.measurement("rto", json!({"started_at_unix_ms": rto_begin, "confirmed_at_unix_ms": unix_ms(),
            "elapsed_ms": rto_start.elapsed().as_millis() as u64, "completed": true,
            "basis": "first_API_stop_attempt_through_reconciled_reapproved_read_write_and_denial_checks"}));
        Ok(())
    }
}
