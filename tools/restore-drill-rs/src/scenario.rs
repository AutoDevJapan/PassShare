use super::*;

const OWNER: &str = "owner@example.invalid";
const MEMBER: &str = "member@example.invalid";
const INVITEE: &str = "invitee@example.invalid";
const DELETED: &str = "deleted@example.invalid";

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

fn seed_pending_refund_truth(value: &Value) -> Result<()> {
    // This endpoint exists only in the isolated verification image. It never
    // observes Stripe and cannot authorize a new provider mutation.
    let script=r#"fetch('http://127.0.0.1:8999/fixture/state',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer rk_test_refund_http_fixture','stripe-account':'acct_restorefixture'},body:process.argv[1]}).then(r=>{if(r.status!==200)process.exitCode=1}).catch(()=>process.exitCode=1)"#;
    let mut command=clean_command("/usr/local/bin/node");
    command.arg("-e").arg(script).arg(value.to_string());
    command_output(command,None).map(|_|())
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
        let old_password = synthetic_password()?;
        let current_password = synthetic_password()?;
        let invite_password = synthetic_password()?;
        let deleted_password = synthetic_password()?;
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
        report.check(
            "exact_known_product_schema_tables_only",
            schema_inventory_matches(&schema_inventory("drill_source")?),
        )?;

        let owner = self
            .api
            .account(report, "source_owner_signup", true, OWNER, &old_password)?;
        let member = self.api.account(
            report,
            "source_member_signup",
            true,
            MEMBER,
            &current_password,
        )?;
        let invitee = self.api.account(
            report,
            "source_invitee_signup",
            true,
            INVITEE,
            &invite_password,
        )?;
        let deleted = self.api.account(
            report,
            "source_deleted_fixture_signup",
            true,
            DELETED,
            &deleted_password,
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
            Some(&json!({"confirmationCode":invitation["confirmationCode"]})),
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

        // Exercise the public intake path so the dump contains a real actor-bound
        // receipt, not a SQL-only row. Exact snapshot comparison covers it too.
        let receipt = self.api.json(
            report,
            "source_support_receipt_saved",
            "POST",
            "/api/support-receipts",
            &owner.session,
            Some(&json!({"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "kind":"technical","version":"0.1.0","platform":"web","errorCode":"PS019"})),
            201,
            None,
        )?;
        let receipt_id = identifier(&receipt, "/id", 36)?;
        let contract_input = json!({"requestId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","currency":"JPY","plan":{"type":"personal","users":1},"setup":{"installationCompanies":0,"supportHours":0,"maintenanceMonthlyJpy":null}});
        let contract_draft = self.api.json(
            report,
            "source_contract_draft",
            "POST",
            "/api/commercial-contracts",
            &owner.session,
            Some(&contract_input),
            201,
            None,
        )?;
        let contract_id = identifier(&contract_draft, "/id", 36)?;
        self.api.json(
            report,
            "source_contract_accepted",
            "POST",
            &format!("/api/commercial-contracts/{contract_id}/accept"),
            &owner.session,
            Some(&json!({"quoteHash":contract_draft["quoteHash"]})),
            200,
            None,
        )?;
        let retired_contract = self.api.json(
            report,
            "source_retired_contract_draft",
            "POST",
            "/api/commercial-contracts",
            &deleted.session,
            Some(&contract_input),
            201,
            None,
        )?;
        let retired_contract_id = identifier(&retired_contract, "/id", 36)?;
        self.api.json(
            report,
            "source_retired_contract_accepted",
            "POST",
            &format!("/api/commercial-contracts/{retired_contract_id}/accept"),
            &deleted.session,
            Some(&json!({"quoteHash":retired_contract["quoteHash"]})),
            200,
            None,
        )?;
        // Public HTTP intake with synthetic signatures, never provider delivery proof.
        for (label, actor, id, hash) in [
            (
                "source_payment_event_saved",
                &owner.id,
                &contract_id,
                &contract_draft["quoteHash"],
            ),
            (
                "source_retired_payment_event_saved",
                &deleted.id,
                &retired_contract_id,
                &retired_contract["quoteHash"],
            ),
        ] {
            let payload = json!({"id":format!("evt_{}",id.replace('-',"")),"account":"acct_restorefixture","type":"payment_intent.succeeded","livemode":false,"created":unix_ms()/1000,"data":{"object":{"id":format!("pi_{}",id.replace('-',"")),"object":"payment_intent","status":"succeeded","currency":"jpy","amount":980,"amount_received":980,"livemode":false,"metadata":{"contractId":id,"ownerId":actor,"quoteHash":hash}}}});
            let script = r#"const crypto=require('node:crypto');const payload=process.argv[1];const t=Math.floor(Date.now()/1000);const sig=crypto.createHmac('sha256','whsec_restore_synthetic_only').update(t+'.'+payload).digest('hex');fetch('http://127.0.0.1:8080/api/commercial-events/stripe-test',{method:'POST',headers:{'content-type':'application/json','stripe-signature':'t='+t+',v1='+sig},body:payload}).then(async r=>{if(r.status!==200)process.exitCode=1;else console.log('saved')}).catch(()=>process.exitCode=1)"#;
            let mut command = clean_command("/usr/local/bin/node");
            command.arg("-e").arg(script).arg(payload.to_string());
            report.check(label, command_output(command, None).is_ok())?;
            let refund_time = payload["created"].as_u64().ok_or(Failure::Shape)?;
            let key = id.replace('-', "");
            let retired = id == &retired_contract_id;
            let current_refunds = [("re_refund", "succeeded", 400),("re_failed", "failed", 200),("pyr_pending", "pending", 100),("re_ambiguous", "requires_action", 100),("re_canceled", "canceled", 100)]
                .iter().map(|(prefix,status,amount)|json!({"id":format!("{prefix}{key}"),"object":"refund","payment_intent":format!("pi_{key}"),"currency":"jpy","amount":amount,"created":refund_time,"status":status})).collect::<Vec<_>>();
            let provider_state =
                json!({"payment":payload["data"]["object"],"refunds":current_refunds});
            let seed_script = r#"fetch('http://127.0.0.1:8999/fixture/state',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer rk_test_refund_http_fixture','stripe-account':'acct_restorefixture'},body:process.argv[1]}).then(r=>{if(r.status!==200)process.exitCode=1}).catch(()=>process.exitCode=1)"#;
            let mut seed = clean_command("/usr/local/bin/node");
            seed.arg("-e")
                .arg(seed_script)
                .arg(provider_state.to_string());
            report.check(
                if retired {
                    "source_retired_test_refund_private_provider_seeded"
                } else {
                    "source_test_refund_private_provider_seeded"
                },
                command_output(seed, None).is_ok(),
            )?;
            for (kind, event_type, current_check, retired_check) in [
                (
                    "created",
                    "refund.created",
                    "source_test_refund_created_saved",
                    "source_retired_test_refund_created_saved",
                ),
                (
                    "updated",
                    "refund.updated",
                    "source_test_refund_updated_saved",
                    "source_retired_test_refund_updated_saved",
                ),
            ] {
                let refund = json!({"id":format!("evt_refund{kind}{key}"),"account":"acct_restorefixture","type":event_type,"livemode":false,"created":refund_time,"data":{"object":{"id":format!("re_refund{key}"),"object":"refund","payment_intent":format!("pi_{key}"),"status":"succeeded","currency":"jpy","amount":400,"created":refund_time,"metadata":{}}}});
                let mut command = clean_command("/usr/local/bin/node");
                command.arg("-e").arg(script).arg(refund.to_string());
                report.check(
                    if retired {
                        retired_check
                    } else {
                        current_check
                    },
                    command_output(command, None).is_ok(),
                )?;
            }
            let mut lifecycle_saved = true;
            for (tag, refund_prefix, status, seconds, amount) in [
                ("action", "re_refund", "requires_action", 1, 400),
                ("failed", "re_refund", "failed", 2, 400),
                ("pending", "re_refund", "pending", 3, 400),
                ("resuccess", "re_refund", "succeeded", 4, 400),
                ("failedonly", "re_failed", "failed", 5, 200),
                ("pendingonly", "pyr_pending", "pending", 6, 100),
                ("samepending", "re_ambiguous", "pending", 7, 100),
                ("samesuccess", "re_ambiguous", "succeeded", 7, 100),
                ("canceled", "re_canceled", "canceled", 8, 100),
            ] {
                let refund = json!({"id":format!("evt_refund{tag}{key}"),"account":"acct_restorefixture","type":if status=="failed"||status=="canceled" {"refund.failed"} else {"refund.updated"},"livemode":false,"created":refund_time+seconds,"data":{"object":{"id":format!("{refund_prefix}{key}"),"object":"refund","payment_intent":format!("pi_{key}"),"status":status,"currency":"jpy","amount":amount,"created":refund_time,"metadata":{}}}});
                let mut command = clean_command("/usr/local/bin/node");
                command.arg("-e").arg(script).arg(refund.to_string());
                lifecycle_saved &= command_output(command, None).is_ok();
            }
            report.check(
                if retired {
                    "source_retired_test_refund_lifecycle_saved"
                } else {
                    "source_test_refund_lifecycle_saved"
                },
                lifecycle_saved,
            )?;
            report.check(if retired {"source_retired_test_refund_nonempty"} else {"source_test_refund_nonempty"},sql("drill_source",&format!("SELECT count(*) FROM commercial_test_refunds r JOIN commercial_payment_events p ON (r.account_id,r.payment_event_id,r.contract_id,r.provider_object_id)=(p.account_id,p.event_id,p.contract_id,p.provider_object_id) WHERE r.contract_id='{id}' AND r.amount_jpy=400 AND p.amount_jpy=980 AND r.evidence='provider_test_sandbox'"))?.trim()=="1")?;
            report.check(if retired {"source_retired_test_refund_events_nonempty"} else {"source_test_refund_events_nonempty"},sql("drill_source",&format!("SELECT count(*) FROM commercial_test_refund_events WHERE contract_id='{id}' AND length(event_hash)=64"))?.trim()=="11")?;
            report.check(if retired {"source_retired_test_refund_api_fixture_qualified"} else {"source_test_refund_api_fixture_qualified"},sql("drill_source",&format!("SELECT count(*) FROM commercial_test_refunds WHERE contract_id='{id}' AND status_verified AND status_checked_at IS NOT NULL AND status_event_created IS NULL AND api_reserved_jpy=600 AND ((refund_id='re_refund{key}' AND amount_jpy=400 AND provider_status='succeeded') OR (refund_id='re_failed{key}' AND amount_jpy=200 AND provider_status='failed') OR (refund_id='pyr_pending{key}' AND amount_jpy=100 AND provider_status='pending') OR (refund_id='re_ambiguous{key}' AND amount_jpy=100 AND provider_status='requires_action') OR (refund_id='re_canceled{key}' AND amount_jpy=100 AND provider_status='canceled'))"))?.trim()=="5")?;
            report.check(if retired {"source_retired_test_refund_observed_statuses"} else {"source_test_refund_observed_statuses"},sql("drill_source",&format!("SELECT count(DISTINCT observed_status) FROM commercial_test_refund_events WHERE contract_id='{id}' AND observed_status IN ('succeeded','failed','pending','requires_action','canceled')"))?.trim()=="5")?;
        }
        // Live-evidence fixture: signed synthetic events through the closed-by-default
        // live receiver (own secret/account/tables). Never provider delivery proof.
        let live_input = json!({"requestId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","currency":"JPY","plan":{"type":"personal","users":1},"setup":{"installationCompanies":0,"supportHours":0,"maintenanceMonthlyJpy":null}});
        let live_draft = self.api.json(
            report,
            "source_live_contract_draft",
            "POST",
            "/api/commercial-contracts",
            &owner.session,
            Some(&live_input),
            201,
            None,
        )?;
        let live_id = identifier(&live_draft, "/id", 36)?;
        self.api.json(
            report,
            "source_live_contract_accepted",
            "POST",
            &format!("/api/commercial-contracts/{live_id}/accept"),
            &owner.session,
            Some(&json!({"quoteHash":live_draft["quoteHash"]})),
            200,
            None,
        )?;
        let retired_live = self.api.json(
            report,
            "source_retired_live_contract_draft",
            "POST",
            "/api/commercial-contracts",
            &deleted.session,
            Some(&live_input),
            201,
            None,
        )?;
        let retired_live_id = identifier(&retired_live, "/id", 36)?;
        self.api.json(
            report,
            "source_retired_live_contract_accepted",
            "POST",
            &format!("/api/commercial-contracts/{retired_live_id}/accept"),
            &deleted.session,
            Some(&json!({"quoteHash":retired_live["quoteHash"]})),
            200,
            None,
        )?;
        let live_script = r#"const crypto=require('node:crypto');const payload=process.argv[1];const t=Math.floor(Date.now()/1000);const sig=crypto.createHmac('sha256','whsec_restore_live_synthetic_only').update(t+'.'+payload).digest('hex');fetch('http://127.0.0.1:8080/api/commercial-events/stripe-live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':'t='+t+',v1='+sig},body:payload}).then(async r=>{if(r.status!==200)process.exitCode=1;else console.log('saved')}).catch(()=>process.exitCode=1)"#;
        // Cycle 1 anchors at 2026-01-31 JST; cycle 2 arrives late (2026-03-20) and must still cover 02-28..03-31.
        for (label, actor, id, hash, cycle, created) in [
            (
                "source_live_cycle1_saved",
                &owner.id,
                &live_id,
                &live_draft["quoteHash"],
                1,
                1769785200_i64,
            ),
            (
                "source_live_cycle2_late_saved",
                &owner.id,
                &live_id,
                &live_draft["quoteHash"],
                2,
                1773964800_i64,
            ),
            (
                "source_retired_live_cycle1_saved",
                &deleted.id,
                &retired_live_id,
                &retired_live["quoteHash"],
                1,
                1769785200_i64,
            ),
        ] {
            let key = id.replace('-', "");
            let payload = json!({"id":format!("evt_live{cycle}{key}"),"account":"acct_restorelive","type":"payment_intent.succeeded","livemode":true,"created":created,"data":{"object":{"id":format!("pi_live{cycle}{key}"),"object":"payment_intent","status":"succeeded","currency":"jpy","amount":980,"amount_received":980,"livemode":true,"metadata":{"contractId":id,"ownerId":actor,"quoteHash":hash,"cycle":cycle.to_string()}}}});
            let mut command = clean_command("/usr/local/bin/node");
            command.arg("-e").arg(live_script).arg(payload.to_string());
            report.check(label, command_output(command, None).is_ok())?;
        }
        let mut source_refund_request = Value::Null;
        for (retired, session, id) in [
            (false, &owner.session, &live_id),
            (true, &deleted.session, &retired_live_id),
        ] {
            let key = id.replace('-', "");
            let request = self.api.json(
                report,
                if retired { "source_retired_refund_request_API" } else { "source_refund_request_API" },
                "POST",
                &format!("/api/commercial-contracts/{id}/refund-requests"),
                session,
                Some(&json!({"requestId":"45454545-4545-4545-8545-454545454545","paymentIntentId":format!("pi_live1{key}"),"amountJpy":400,"reason":"service_unprovided"})),
                201,
                None,
            )?;
            report.check(if retired {"source_retired_refund_request_nonempty"} else {"source_refund_request_nonempty"},sql("drill_source",&format!("SELECT count(*) FROM commercial_refund_requests r JOIN commercial_live_periods p ON (r.account_id,r.payment_event_id,r.contract_id,r.provider_object_id,r.payment_amount_jpy,r.payment_event_hash)=(p.account_id,p.event_id,p.contract_id,p.provider_object_id,p.amount_jpy,p.event_hash) JOIN commercial_contracts c ON c.id=r.contract_id WHERE r.contract_id='{id}' AND p.cycle=1 AND r.requested_amount_jpy=400 AND r.payment_amount_jpy=980 AND r.quote_hash=c.quote_hash AND r.reason='service_unprovided' AND r.status='received' AND r.requested_at IS NOT NULL"))?.trim()=="1")?;
            if !retired {
                source_refund_request = request;
            }
        }
        self.api.json(
            report,
            "source_paid_contract_unpaid_withdrawal_denied",
            "POST",
            &format!("/api/commercial-contracts/{live_id}/cancel"),
            &owner.session,
            Some(&json!({"quoteHash":live_draft["quoteHash"],"revision":0})),
            409,
            None,
        )?;
        self.api.json(
            report,
            "source_live_cancel_scheduled",
            "POST",
            &format!("/api/commercial-contracts/{live_id}/cancel-at-period-end"),
            &owner.session,
            Some(&json!({"quoteHash":live_draft["quoteHash"]})),
            200,
            None,
        )?;
        let late_key = live_id.replace('-', "");
        let cancel_second:i64=sql("drill_source",&format!("SELECT floor(extract(epoch FROM cancel_requested_at))::bigint FROM commercial_live_contracts WHERE contract_id='{live_id}'"))?.trim().parse().map_err(|_|Failure::Json)?;
        let pre_payment = json!({"id":format!("evt_pre{late_key}"),"account":"acct_restorelive","type":"payment_intent.succeeded","livemode":true,"created":cancel_second-60,"data":{"object":{"id":format!("pi_pre{late_key}"),"object":"payment_intent","status":"succeeded","currency":"jpy","amount":980,"amount_received":980,"livemode":true,"metadata":{"contractId":live_id,"ownerId":owner.id,"quoteHash":live_draft["quoteHash"],"cycle":"3"}}}});
        let mut pre_command = clean_command("/usr/local/bin/node");
        pre_command
            .arg("-e")
            .arg(live_script)
            .arg(pre_payment.to_string());
        report.check(
            "source_pre_cancel_paid_delivery_reconciled",
            command_output(pre_command, None).is_ok(),
        )?;
        report.check("source_cancellation_preserved_paid_cutoff_extended",sql("drill_source",&format!("SELECT cancel_after_cycle FROM commercial_live_contracts WHERE contract_id='{live_id}'"))?.trim()=="3")?;
        let late_payment = json!({"id":format!("evt_late{late_key}"),"account":"acct_restorelive","type":"payment_intent.succeeded","livemode":true,"created":cancel_second+1,"data":{"object":{"id":format!("pi_late{late_key}"),"object":"payment_intent","status":"succeeded","currency":"jpy","amount":980,"amount_received":980,"livemode":true,"metadata":{"contractId":live_id,"ownerId":owner.id,"quoteHash":live_draft["quoteHash"],"cycle":"4"}}}});
        let mut late_command = clean_command("/usr/local/bin/node");
        late_command
            .arg("-e")
            .arg(live_script)
            .arg(late_payment.to_string());
        report.check(
            "source_late_paid_evidence_preserved",
            command_output(late_command, None).is_ok(),
        )?;
        let live_before = self.api.json(
            report,
            "source_live_contract_read",
            "GET",
            &format!("/api/commercial-contracts/{live_id}"),
            &owner.session,
            None,
            200,
            None,
        )?;
        // An independent current-period contract exercises stored quote -> consent
        // -> signed seat payment -> plan application, not a fabricated empty ledger.
        let mut seat_contract_id = String::new();
        let mut retired_seat_contract_id = String::new();
        let mut decrease_id = String::new();
        let mut retired_decrease_id = String::new();
        let mut seat_provider_second = 0;
        let mut additional_refund_requests = Vec::new();
        for (actor, retired) in [(&owner, false), (&deleted, true)] {
            let input = json!({"requestId":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","currency":"JPY","plan":{"type":"personal","users":1},"setup":{"installationCompanies":0,"supportHours":0,"maintenanceMonthlyJpy":null}});
            let draft = self.api.json(
                report,
                if retired {
                    "seat_retired_contract"
                } else {
                    "seat_contract"
                },
                "POST",
                "/api/commercial-contracts",
                &actor.session,
                Some(&input),
                201,
                None,
            )?;
            let cid = identifier(&draft, "/id", 36)?;
            self.api.json(
                report,
                if retired {
                    "seat_retired_contract_accept"
                } else {
                    "seat_contract_accept"
                },
                "POST",
                &format!("/api/commercial-contracts/{cid}/accept"),
                &actor.session,
                Some(&json!({"quoteHash":draft["quoteHash"]})),
                200,
                None,
            )?;
            let key = cid.replace('-', "");
            let payment = json!({"id":format!("evt_seatperiod{key}"),"account":"acct_restorelive","type":"payment_intent.succeeded","livemode":true,"created":unix_ms()/1000,"data":{"object":{"id":format!("pi_seatperiod{key}"),"object":"payment_intent","status":"succeeded","currency":"jpy","amount":980,"amount_received":980,"livemode":true,"metadata":{"contractId":cid,"ownerId":actor.id,"quoteHash":draft["quoteHash"],"cycle":"1"}}}});
            let mut cmd = clean_command("/usr/local/bin/node");
            cmd.arg("-e").arg(live_script).arg(payment.to_string());
            report.check(
                if retired {
                    "seat_retired_period_paid"
                } else {
                    "seat_period_paid"
                },
                command_output(cmd, None).is_ok(),
            )?;
            // Keep the real shared commercial quota; no test-only limit override.
            std::thread::sleep(Duration::from_secs(60));
            let quote = self.api.json(report,if retired {"seat_retired_quote"} else {"seat_quote"},"POST",&format!("/api/commercial-contracts/{cid}/seat-quotes"),&actor.session,Some(&json!({"requestId":"ffffffff-ffff-4fff-8fff-ffffffffffff","requestedPlan":{"type":"personal","users":2},"roundingPolicy":"ceil-jpy"})),201,None)?;
            let sid = identifier(&quote, "/id", 36)?;
            self.api.json(
                report,
                if retired {
                    "seat_retired_consent"
                } else {
                    "seat_consent"
                },
                "POST",
                &format!("/api/commercial-contracts/{cid}/seat-quotes/{sid}/accept"),
                &actor.session,
                Some(&json!({"quoteHash":quote["quoteHash"]})),
                200,
                None,
            )?;
            let review_quote = self.api.json(report,if retired {"seat_retired_review_quote"} else {"seat_review_quote"},"POST",&format!("/api/commercial-contracts/{cid}/seat-quotes"),&actor.session,Some(&json!({"requestId":"45454545-6767-4898-8989-abababababab","requestedPlan":{"type":"personal","users":3},"roundingPolicy":"ceil-jpy"})),201,None)?;
            let review_sid = identifier(&review_quote, "/id", 36)?;
            self.api.json(
                report,
                if retired {
                    "seat_retired_review_consent"
                } else {
                    "seat_review_consent"
                },
                "POST",
                &format!("/api/commercial-contracts/{cid}/seat-quotes/{review_sid}/accept"),
                &actor.session,
                Some(&json!({"quoteHash":review_quote["quoteHash"]})),
                200,
                None,
            )?;
            let mut payment = payment;
            payment["created"] = json!(unix_ms() / 1000);
            payment["id"] = json!(format!("evt_seatincrease{key}"));
            payment["data"]["object"]["id"] = json!(format!("pi_seatincrease{key}"));
            payment["data"]["object"]["amount"] = quote["quote"]["proposedRoundedJpy"].clone();
            payment["data"]["object"]["amount_received"] =
                quote["quote"]["proposedRoundedJpy"].clone();
            payment["data"]["object"]["metadata"]["quoteHash"] = quote["quoteHash"].clone();
            payment["data"]["object"]["metadata"]["seatChangeId"] = json!(sid);
            let mut cmd = clean_command("/usr/local/bin/node");
            cmd.arg("-e").arg(live_script).arg(payment.to_string());
            report.check(
                if retired {
                    "seat_retired_applied"
                } else {
                    "seat_applied"
                },
                command_output(cmd, None).is_ok(),
            )?;
            let mut review_payment = payment.clone();
            review_payment["id"] = json!(format!("evt_seatreview{key}"));
            review_payment["created"] = json!(unix_ms() / 1000);
            review_payment["data"]["object"]["id"] = json!(format!("pi_seatreview{key}"));
            review_payment["data"]["object"]["amount"] =
                review_quote["quote"]["proposedRoundedJpy"].clone();
            review_payment["data"]["object"]["amount_received"] =
                review_quote["quote"]["proposedRoundedJpy"].clone();
            review_payment["data"]["object"]["metadata"]["quoteHash"] =
                review_quote["quoteHash"].clone();
            review_payment["data"]["object"]["metadata"]["seatChangeId"] = json!(review_sid);
            let mut cmd = clean_command("/usr/local/bin/node");
            cmd.arg("-e")
                .arg(live_script)
                .arg(review_payment.to_string());
            report.check(
                if retired {
                    "source_retired_seat_review_paid"
                } else {
                    "source_seat_review_paid"
                },
                command_output(cmd, None).is_ok(),
            )?;
            let mut decrease_quotes = Vec::new();
            for request in [
                "11111111-2222-4333-8444-555555555555",
                "66666666-7777-4888-8999-aaaaaaaaaaaa",
            ] {
                let reduction = self.api.json(
                    report,
                    if retired {
                        "decrease_retired_quote"
                    } else {
                        "decrease_quote"
                    },
                    "POST",
                    &format!("/api/commercial-contracts/{cid}/seat-decrease-quotes"),
                    &actor.session,
                    Some(
                        &json!({"requestId":request,"requestedPlan":{"type":"personal","users":1}}),
                    ),
                    201,
                    None,
                )?;
                let did = identifier(&reduction, "/id", 36)?;
                self.api.json(
                    report,
                    if retired {
                        "decrease_retired_accept"
                    } else {
                        "decrease_accept"
                    },
                    "POST",
                    &format!("/api/commercial-contracts/{cid}/seat-decrease-quotes/{did}/accept"),
                    &actor.session,
                    Some(&json!({"quoteHash":reduction["quoteHash"]})),
                    200,
                    None,
                )?;
                decrease_quotes.push((did, reduction));
            }
            for (index, (did, reduction)) in decrease_quotes.iter().enumerate() {
                let payment = json!({"id":format!("evt_decrease{index}{key}"),"account":"acct_restorelive","type":"payment_intent.succeeded","livemode":true,"created":unix_ms()/1000,"data":{"object":{"id":format!("pi_decrease{index}{key}"),"object":"payment_intent","status":"succeeded","currency":"jpy","amount":980,"amount_received":980,"livemode":true,"metadata":{"contractId":cid,"ownerId":actor.id,"quoteHash":draft["quoteHash"],"cycle":"2","seatDecreaseId":did,"seatDecreaseQuoteHash":reduction["quoteHash"]}}}});
                if index == 1 {
                    let mut mismatch = payment.clone();
                    mismatch["id"] = json!(format!("evt_decreasemismatch{key}"));
                    mismatch["data"]["object"]["id"] = json!(format!("pi_decreasemismatch{key}"));
                    mismatch["data"]["object"]["amount"] = json!(979);
                    mismatch["data"]["object"]["amount_received"] = json!(979);
                    let mut cmd = clean_command("/usr/local/bin/node");
                    cmd.arg("-e").arg(live_script).arg(mismatch.to_string());
                    report.check(
                        if retired {
                            "source_retired_decrease_mismatch_received"
                        } else {
                            "source_decrease_mismatch_received"
                        },
                        command_output(cmd, None).is_ok(),
                    )?;
                    report.check(if retired {"source_retired_decrease_actual_amount_saved"} else {"source_decrease_actual_amount_saved"},sql("drill_source",&format!("SELECT count(*) FROM commercial_plan_payment_exceptions WHERE contract_id='{cid}' AND amount_jpy=979 AND reason='seat_decrease_amount_mismatch'"))?.trim()=="1")?;
                }
                let mut cmd = clean_command("/usr/local/bin/node");
                cmd.arg("-e").arg(live_script).arg(payment.to_string());
                report.check(
                    if retired {
                        "decrease_retired_payment"
                    } else {
                        "decrease_payment"
                    },
                    command_output(cmd, None).is_ok(),
                )?;
            }
            let signed_second = payment["created"].as_u64().ok_or(Failure::Shape)?;
            report.check(if retired {"source_retired_seat_provider_success_saved"} else {"source_seat_provider_success_saved"},sql("drill_source",&format!("SELECT count(*) FROM commercial_seat_changes WHERE id='{sid}' AND provider_event_created={signed_second} AND payment_received_at IS NOT NULL AND accepted_at IS NOT NULL"))?.trim()=="1")?;
            if !retired {
                seat_provider_second = signed_second;
            }
            let funded = decrease_quotes[1].0.clone();
            let legacy_payment = json!({"id":format!("evt_legacyplan{key}"),"account":"acct_restorelive","type":"payment_intent.succeeded","livemode":true,"created":unix_ms()/1000,"data":{"object":{"id":format!("pi_legacyplan{key}"),"object":"payment_intent","status":"succeeded","currency":"jpy","amount":1960,"amount_received":1960,"livemode":true,"metadata":{"contractId":cid,"ownerId":actor.id,"quoteHash":draft["quoteHash"],"cycle":"3"}}}});
            let mut cmd = clean_command("/usr/local/bin/node");
            cmd.arg("-e")
                .arg(live_script)
                .arg(legacy_payment.to_string());
            report.check(
                if retired {
                    "source_retired_decrease_legacy_paid"
                } else {
                    "source_decrease_legacy_paid"
                },
                command_output(cmd, None).is_ok(),
            )?;
            report.check(if retired {"source_retired_decrease_legacy_adjustment"} else {"source_decrease_legacy_adjustment"},sql("drill_source",&format!("SELECT count(*) FROM commercial_live_periods WHERE contract_id='{cid}' AND cycle=3 AND plan_adjustment_review AND billing_plan->>'users'='2' AND amount_jpy=1960"))?.trim()=="1")?;
            report.check(if retired {"source_retired_decrease_funded"} else {"source_decrease_funded"},sql("drill_source",&format!("SELECT count(*) FROM commercial_seat_decreases WHERE id='{funded}' AND state='funded' AND accepted_at IS NOT NULL AND target_cycle=2 AND quote->'renewalQuote'->>'monthlyTotalJpy'='980'"))?.trim()=="1")?;
            report.check(if retired {"source_retired_decrease_exception_nonempty"} else {"source_decrease_exception_nonempty"},sql("drill_source",&format!("SELECT count(*) FROM commercial_plan_payment_exceptions WHERE contract_id='{cid}' AND amount_jpy=980 AND length(event_hash)=64 AND reason='seat_decrease_no_longer_applicable'"))?.trim()=="1")?;
            report.check(if retired {"source_retired_decrease_period_bound"} else {"source_decrease_period_bound"},sql("drill_source",&format!("SELECT count(*) FROM commercial_live_periods WHERE contract_id='{cid}' AND cycle=2 AND seat_decrease_id='{funded}' AND billing_plan->>'users'='1' AND amount_jpy=980"))?.trim()=="1")?;
            let paid_sources:Value=serde_json::from_str(&sql("drill_source",&format!("SELECT json_agg(row_to_json(s) ORDER BY kind,detail) FROM (SELECT provider_object_id,paid_amount_jpy::text AS amount,'seat_change' AS kind,state AS detail FROM commercial_seat_changes WHERE contract_id='{cid}' AND paid_amount_jpy>0 AND state IN ('applied','refund_review') UNION ALL SELECT provider_object_id,amount_jpy::text,'payment_exception','mismatch' FROM commercial_plan_payment_exceptions WHERE contract_id='{cid}' AND reason='seat_decrease_amount_mismatch') s"))?).map_err(|_|Failure::Json)?;
            let paid_sources = paid_sources
                .as_array()
                .filter(|rows| rows.len() == 3)
                .ok_or(Failure::Shape)?;
            for (index, paid) in paid_sources.iter().enumerate() {
                let label = match (paid["kind"].as_str(), paid["detail"].as_str()) {
                    (Some("seat_change"), Some("applied")) => "seat_applied",
                    (Some("seat_change"), Some("refund_review")) => "seat_review",
                    (Some("payment_exception"), Some("mismatch")) => "payment_exception",
                    _ => return Err(Failure::Shape),
                };
                let amount: u64 = paid["amount"]
                    .as_str()
                    .ok_or(Failure::Shape)?
                    .parse()
                    .map_err(|_| Failure::Shape)?;
                let names = match label {
                    "seat_applied" => (
                        if retired {
                            "source_retired_seat_applied_refund_request_API"
                        } else {
                            "source_seat_applied_refund_request_API"
                        },
                        if retired {
                            "source_retired_seat_applied_refund_request_nonempty"
                        } else {
                            "source_seat_applied_refund_request_nonempty"
                        },
                        "restored_seat_applied_refund_request_API",
                        "restored_seat_applied_refund_request_values",
                    ),
                    "seat_review" => (
                        if retired {
                            "source_retired_seat_review_refund_request_API"
                        } else {
                            "source_seat_review_refund_request_API"
                        },
                        if retired {
                            "source_retired_seat_review_refund_request_nonempty"
                        } else {
                            "source_seat_review_refund_request_nonempty"
                        },
                        "restored_seat_review_refund_request_API",
                        "restored_seat_review_refund_request_values",
                    ),
                    "payment_exception" => (
                        if retired {
                            "source_retired_payment_exception_refund_request_API"
                        } else {
                            "source_payment_exception_refund_request_API"
                        },
                        if retired {
                            "source_retired_payment_exception_refund_request_nonempty"
                        } else {
                            "source_payment_exception_refund_request_nonempty"
                        },
                        "restored_payment_exception_refund_request_API",
                        "restored_payment_exception_refund_request_values",
                    ),
                    _ => return Err(Failure::Shape),
                };
                let requested = amount.min(400);
                let request_id = [
                    "64646464-6464-4646-8646-646464646464",
                    "75757575-7575-4757-8757-757575757575",
                    "86868686-8686-4868-8868-868686868686",
                ][index];
                let receipt=self.api.json(report,names.0,"POST",&format!("/api/commercial-contracts/{cid}/refund-requests"),&actor.session,Some(&json!({"requestId":request_id,"paymentIntentId":paid["provider_object_id"],"amountJpy":requested,"reason":"service_unprovided"})),201,None)?;
                let rid = identifier(&receipt, "/id", 36)?;
                report.check(names.1,receipt["paymentSource"]==paid["kind"] && receipt["paymentAmountJpy"]==amount && receipt["refundExecuted"]==false && sql("drill_source",&format!("SELECT count(*) FROM commercial_refund_requests WHERE id='{rid}' AND contract_id='{cid}' AND requested_amount_jpy={requested} AND payment_amount_jpy={amount} AND length(payment_event_hash)=64 AND status='received'"))?.trim()=="1")?;
                if !retired {
                    additional_refund_requests.push((cid.clone(), receipt, names.2, names.3));
                }
            }
            if retired {
                retired_decrease_id = funded;
            } else {
                decrease_id = funded;
            }
            if retired {
                retired_seat_contract_id = cid;
            } else {
                seat_contract_id = cid;
            }
        }
        report.check("source_refund_requests_all_paid_sources",sql("drill_source","SELECT string_agg(payment_source||':'||n,',' ORDER BY payment_source) FROM (SELECT payment_source,count(*) n FROM commercial_refund_requests GROUP BY payment_source) s")?.trim()=="payment_exception:2,period:2,seat_change:4")?;
        // An explicit synthetic reviewer is enrolled only in the isolated image
        // runtime. Production deployment configuration stays untouched.
        self.stop_api(report, "source_API_closed_before_fixture_reviewer_enrollment")?;
        self.refund_reviewer = Some(member.id.clone());
        self.start_api("drill_source", report, "source_API_ready_with_fixture_reviewer")?;
        let mut source_refund_review = Value::Null;
        for (retired, session, id) in [
            (false, &owner.session, &live_id),
            (true, &deleted.session, &retired_live_id),
        ] {
            let claim = self.api.json(report, if retired {"source_retired_review_request_replay"} else {"source_review_request_replay"}, "POST", &format!("/api/commercial-contracts/{id}/refund-requests"),session,Some(&json!({"requestId":"45454545-4545-4545-8545-454545454545","paymentIntentId":format!("pi_live1{}",id.replace('-',"")),"amountJpy":400,"reason":"service_unprovided"})),201,None)?;
            let rid=identifier(&claim,"/id",36)?;
            let denied=self.api.request("GET",&format!("/api/commercial-contracts/refund-review/{rid}"),session,None,None)?;
            report.check(if retired {"source_retired_owner_not_reviewer"} else {"source_owner_not_reviewer"},denied.0==403)?;
            let key=id.replace('-',"");
            let seed=json!({"payment":{"id":format!("pi_live1{key}"),"object":"payment_intent","livemode":true,"status":"succeeded","currency":"jpy","amount":980,"amount_received":980,"metadata":{"contractId":id,"ownerId":if retired {&deleted.id} else {&owner.id},"quoteHash":if retired {&retired_live["quoteHash"]} else {&live_draft["quoteHash"]},"cycle":"1"}},"refunds":[]});
            let seed_script=r#"fetch('http://127.0.0.1:8998/fixture/state',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer rk_live_refund_http_fixture','stripe-account':'acct_restorelive'},body:process.argv[1]}).then(r=>{if(r.status!==200)process.exitCode=1}).catch(()=>process.exitCode=1)"#;
            let mut command=clean_command("/usr/local/bin/node");command.arg("-e").arg(seed_script).arg(seed.to_string());
            report.check(if retired {"source_retired_refund_review_provider_seed"} else {"source_refund_review_provider_seed"},command_output(command,None).is_ok())?;
            let decision=self.api.json(report,if retired {"source_retired_refund_review_HTTP"} else {"source_refund_review_HTTP"},"POST",&format!("/api/commercial-contracts/refund-review/{rid}/decisions"),&member.session,Some(&json!({"operationId":"67676767-6767-4767-8767-676767676767","expectedRevision":0,"decision":"approved","amountJpy":400,"reason":"unprovided_period_confirmed"})),201,None)?;
            report.check(if retired {"source_retired_refund_review_nonempty"} else {"source_refund_review_nonempty"},decision["decision"]=="approved" && decision["revision"]==1 && decision["approvedAmountJpy"]==400 && decision["refundExecuted"]==false && sql("drill_source",&format!("SELECT count(*) FROM commercial_refund_reviews v JOIN commercial_refund_requests r ON (v.request_id,v.contract_id,v.request_fingerprint,v.requested_amount_jpy)=(r.id,r.contract_id,r.request_fingerprint,r.requested_amount_jpy) WHERE v.request_id='{rid}' AND v.revision=1 AND v.decision='approved' AND v.reason='unprovided_period_confirmed' AND v.amount_jpy=400 AND v.requested_amount_jpy=400 AND v.reviewer_id='{}' AND v.balance->>'qualified'='true' AND v.balance->>'availableRefundJpy'='980' AND v.created_at IS NOT NULL",member.id))?.trim()=="1")?;
            if !retired { source_refund_review=decision;source_refund_request=self.api.json(report,"source_review_owner_read","GET",&format!("/api/commercial-contracts/{id}/refund-requests/{rid}"),session,None,200,None)?; }
        }
        let mut source_test_execution = Value::Null;
        for (retired, session, id, quote_hash) in [
            (false, &owner.session, &contract_id, &contract_draft["quoteHash"]),
            (true, &deleted.session, &retired_contract_id, &retired_contract["quoteHash"]),
        ] {
            let operation="89898989-8989-4989-8989-898989898989";
            // Each contract owns a distinct operation identity. Both are signed
            // sandbox-payment approvals through HTTP; the executor remains off.
            let operation=if retired {"90909090-9090-4090-8090-909090909090"} else {operation};
            let result=self.api.json(report,if retired {"source_retired_test_refund_operation_HTTP"} else {"source_test_refund_operation_HTTP"},"POST",&format!("/api/commercial-contracts/{id}/test-refund-operations"),&member.session,Some(&json!({"operationId":operation,"paymentIntentId":format!("pi_{}",id.replace('-',"")),"quoteHash":quote_hash,"amountJpy":100,"reason":"unprovided_period_confirmed"})),201,None)?;
            report.check(if retired {"source_retired_test_refund_operation_nonempty"} else {"source_test_refund_operation_nonempty"},result["state"]=="approved" && result["approvedAmountJpy"]==100 && result["paymentEvidence"]=="provider_test_sandbox" && result["refundExecuted"]==false && sql("drill_source",&format!("SELECT count(*) FROM commercial_test_refund_operations o JOIN commercial_payment_events p ON (o.account_id,o.payment_event_id,o.contract_id,o.provider_object_id,o.payment_amount_jpy,o.payment_event_hash)=(p.account_id,p.event_id,p.contract_id,p.provider_object_id,p.amount_jpy,p.event_hash) WHERE o.operation_id='{operation}' AND o.contract_id='{id}' AND o.amount_jpy=100 AND o.payment_amount_jpy=980 AND o.state='approved' AND o.evidence='provider_test_sandbox' AND o.reviewer_id='{}' AND o.provider_refund_id IS NULL AND o.approved_at IS NOT NULL",member.id))?.trim()=="1")?;
            let closed=self.api.request("POST",&format!("/api/commercial-contracts/{id}/test-refund-operations/{operation}/execute"),&member.session,Some(&json!({})),None)?;
            report.check(if retired {"source_retired_test_refund_executor_closed"} else {"source_test_refund_executor_closed"},closed.0==503)?;
            let read=self.api.json(report,if retired {"source_retired_test_refund_operation_owner"} else {"source_test_refund_operation_owner"},"GET",&format!("/api/commercial-contracts/{id}/test-refund-operations/{operation}"),session,None,200,None)?;
            if !retired {source_test_execution=read;}
        }
        // SQL simulates interrupted dispatch state; the separate HTTP/PG test
        // injects a real result-write failure after a private provider POST.
        let pending_operations = [
            ("91919191-9191-4191-8191-919191919191", "uncertain", 10),
            ("92929292-9292-4292-8292-929292929292", "in_flight", 20),
        ];
        for (index, (operation, state, amount)) in pending_operations.iter().enumerate() {
            self.api.json(
                report,
                if index == 0 {"source_uncertain_refund_approval_HTTP"} else {"source_inflight_refund_approval_HTTP"},
                "POST", &format!("/api/commercial-contracts/{contract_id}/test-refund-operations"),
                &member.session,
                Some(&json!({"operationId":operation,"paymentIntentId":format!("pi_{}",contract_id.replace('-',"")),"quoteHash":contract_draft["quoteHash"],"amountJpy":amount,"reason":"unprovided_period_confirmed"})),
                201, None,
            )?;
            sql("drill_source", &format!("UPDATE commercial_test_refund_operations SET state='{state}',first_dispatched_at=clock_timestamp(),result_recorded_at=CASE WHEN '{state}'='uncertain' THEN clock_timestamp() ELSE NULL END WHERE operation_id='{operation}';"))?;
        }
        for (index, (operation, state, amount)) in [
            ("93939393-9393-4393-8393-939393939393", "uncertain", 10),
            ("94949494-9494-4494-8494-949494949494", "in_flight", 20),
        ].iter().enumerate() {
            self.api.json(report,if index==0 {"source_retired_uncertain_refund_approval_HTTP"} else {"source_retired_inflight_refund_approval_HTTP"},"POST",&format!("/api/commercial-contracts/{retired_contract_id}/test-refund-operations"),&member.session,Some(&json!({"operationId":operation,"paymentIntentId":format!("pi_{}",retired_contract_id.replace('-',"")),"quoteHash":retired_contract["quoteHash"],"amountJpy":amount,"reason":"unprovided_period_confirmed"})),201,None)?;
            sql("drill_source",&format!("UPDATE commercial_test_refund_operations SET state='{state}',first_dispatched_at=clock_timestamp() WHERE operation_id='{operation}';"))?;
        }
        report.check("source_retired_pending_refund_operation_states",sql("drill_source",&format!("SELECT count(*) FROM commercial_test_refund_operations WHERE contract_id='{retired_contract_id}' AND ((operation_id='93939393-9393-4393-8393-939393939393' AND state='uncertain' AND amount_jpy=10) OR (operation_id='94949494-9494-4494-8494-949494949494' AND state='in_flight' AND amount_jpy=20)) AND first_dispatched_at IS NOT NULL AND provider_refund_id IS NULL;"))?.trim()=="2")?;
        let source_uncertain_refund=self.api.json(report,"source_uncertain_refund_owner_HTTP","GET",&format!("/api/commercial-contracts/{contract_id}/test-refund-operations/{}",pending_operations[0].0),&owner.session,None,200,None)?;
        let source_inflight_refund=self.api.json(report,"source_inflight_refund_owner_HTTP","GET",&format!("/api/commercial-contracts/{contract_id}/test-refund-operations/{}",pending_operations[1].0),&owner.session,None,200,None)?;
        report.check("source_pending_refund_operation_states",
            source_uncertain_refund["state"]=="uncertain" && source_uncertain_refund["approvedAmountJpy"]==10 && source_uncertain_refund["refundExecuted"]==false &&
            source_inflight_refund["state"]=="in_flight" && source_inflight_refund["approvedAmountJpy"]==20 && source_inflight_refund["refundExecuted"]==false &&
            sql("drill_source",&format!("SELECT count(*) FROM commercial_test_refund_operations WHERE contract_id='{contract_id}' AND operation_id IN ('{}','{}') AND state IN ('uncertain','in_flight') AND first_dispatched_at IS NOT NULL AND provider_refund_id IS NULL AND approved_at IS NOT NULL AND reviewer_id='{}';",pending_operations[0].0,pending_operations[1].0,member.id))?.trim()=="2"
        )?;
        self.api.json(
            report,
            "source_unpaid_acceptance_canceled",
            "POST",
            &format!("/api/commercial-contracts/{contract_id}/cancel"),
            &owner.session,
            Some(&json!({"quoteHash":contract_draft["quoteHash"],"revision":0})),
            200,
            None,
        )?;
        let contract = self.api.json(
            report,
            "source_canceled_contract_read",
            "GET",
            &format!("/api/commercial-contracts/{contract_id}"),
            &owner.session,
            None,
            200,
            None,
        )?;
        self.api.json(report,"source_deleted_account_receipt_saved","POST","/api/support-receipts",&deleted.session,Some(&json!({"requestId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","kind":"technical","version":"0.1.0","platform":"web","errorCode":""})),201,None)?;
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
        report.check(
            "plaintext_fixture_encrypted_tables_empty",
            encrypted_tables_empty(&baseline),
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
            Some(&json!({"email": OWNER, "password": &old_password})),
            401,
            None,
        )?;
        self.api.json(
            report,
            "source_deleted_account_denied",
            "POST",
            "/api/auth/login",
            "",
            Some(&json!({"email": DELETED, "password": &deleted_password})),
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
        report.check(
            "restored_exact_known_product_schema_tables_only",
            schema_inventory_matches(&schema_inventory("drill_restored")?),
        )?;
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
            "restore_support_receipts_full_rows",
            "restore_contracts_full_rows",
            "restore_payment_events_full_rows",
            "restore_paid_periods_full_rows",
            "restore_live_contracts_full_rows",
            "restore_live_periods_full_rows",
            "restore_seat_changes_full_rows",
            "restore_seat_decreases_full_rows",
            "restore_plan_payment_exceptions_full_rows",
            "restore_test_refunds_full_rows",
            "restore_test_refund_events_full_rows",
            "restore_refund_requests_full_rows",
            "restore_refund_reviews_full_rows",
            "restore_test_refund_operations_full_rows",
        ];
        if names.len() != TABLES.len() {
            return Err(Failure::Shape);
        }
        for (table, name) in TABLES.iter().zip(names) {
            report.check(name, exact_json(&baseline[*table], &restored[*table]))?;
        }
        report.check(
            "restore_all_tables_exact_before_API",
            exact_json(&baseline, &restored),
        )?;
        report.check(
            "restored_plaintext_encrypted_tables_empty_before_API",
            encrypted_tables_empty(&restored),
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
            Some(&json!({"email": OWNER, "password": &old_password})),
            200,
            None,
        )?;
        self.api.json(
            report,
            "unsafe_restore_deleted_account_revived",
            "POST",
            "/api/auth/login",
            "",
            Some(&json!({"email": DELETED, "password": &deleted_password})),
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
            "reconciliation_keeps_encrypted_tables_empty",
            encrypted_tables_empty(&after_reconcile),
        )?;
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
            Some(&json!({"email": OWNER, "password": &old_password})),
            401,
            None,
        )?;
        self.api.json(
            report,
            "deleted_account_still_401",
            "POST",
            "/api/auth/login",
            "",
            Some(&json!({"email": DELETED, "password": &deleted_password})),
            401,
            None,
        )?;
        let current_owner = self.api.account(
            report,
            "current_owner_login",
            false,
            OWNER,
            &current_password,
        )?;
        let current_member = self.api.account(
            report,
            "current_former_member_login",
            false,
            MEMBER,
            &current_password,
        )?;
        let current_invitee = self.api.account(
            report,
            "current_invitee_login",
            false,
            INVITEE,
            &invite_password,
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

        self.api.json(
            report,
            "restored_receipt_old_session_denied",
            "GET",
            &format!("/api/support-receipts/{receipt_id}"),
            &owner.session,
            None,
            401,
            None,
        )?;
        let current_receipt = self.api.json(
            report,
            "restored_receipt_current_owner_read",
            "GET",
            &format!("/api/support-receipts/{receipt_id}"),
            &current_owner.session,
            None,
            200,
            None,
        )?;
        report.check(
            "restored_receipt_exact_current_owner",
            exact_json(&receipt, &current_receipt),
        )?;
        self.api.json(
            report,
            "restored_contract_old_session_denied",
            "GET",
            &format!("/api/commercial-contracts/{contract_id}"),
            &owner.session,
            None,
            401,
            None,
        )?;
        let restored_contract = self.api.json(
            report,
            "restored_contract_current_owner",
            "GET",
            &format!("/api/commercial-contracts/{contract_id}"),
            &current_owner.session,
            None,
            200,
            None,
        )?;
        report.check(
            "restored_contract_exact_amount_hash_acceptance",
            exact_json(&contract, &restored_contract),
        )?;
        report.check(
            "restored_cancellation_timestamp_revision",
            restored_contract["cancellationRequestedAt"].is_string()
                && restored_contract["lifecycleRevision"] == 1,
        )?;
        self.api.json(
            report,
            "restored_canceled_acceptance_denied",
            "POST",
            &format!("/api/commercial-contracts/{contract_id}/accept"),
            &current_owner.session,
            Some(&json!({"quoteHash":contract_draft["quoteHash"]})),
            409,
            None,
        )?;
        report.check("restored_payment_ledger_nonempty",sql("drill_restored",&format!("SELECT count(*) FROM commercial_payment_events WHERE contract_id='{contract_id}'"))?.trim()=="1")?;
        report.check("restored_paid_period_nonempty_sandbox_only",sql("drill_restored",&format!("SELECT count(*) FROM commercial_paid_periods WHERE contract_id='{contract_id}' AND evidence='provider_test_sandbox' AND period_end>period_start AND amount_jpy=980"))?.trim()=="1")?;
        report.check("retired_paid_period_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_paid_periods WHERE contract_id='{retired_contract_id}'"))?.trim()=="0")?;
        report.check("retired_payment_ledger_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_payment_events WHERE contract_id='{retired_contract_id}'"))?.trim()=="0")?;
        report.check("restored_test_refund_nonempty",sql("drill_restored",&format!("SELECT count(*) FROM commercial_test_refunds r JOIN commercial_payment_events p ON (r.account_id,r.payment_event_id,r.contract_id,r.provider_object_id)=(p.account_id,p.event_id,p.contract_id,p.provider_object_id) WHERE r.contract_id='{contract_id}' AND r.amount_jpy=400 AND p.amount_jpy=980 AND r.evidence='provider_test_sandbox'"))?.trim()=="1")?;
        report.check("restored_test_refund_events_nonempty",sql("drill_restored",&format!("SELECT count(*) FROM commercial_test_refund_events WHERE contract_id='{contract_id}' AND length(event_hash)=64"))?.trim()=="11")?;
        report.check("restored_test_refund_api_fixture_qualified",sql("drill_restored",&format!("SELECT count(*) FROM commercial_test_refunds WHERE contract_id='{contract_id}' AND provider_status IN ('succeeded','failed','pending','requires_action','canceled') AND status_verified AND status_checked_at IS NOT NULL AND status_event_created IS NULL AND api_reserved_jpy=600"))?.trim()=="5")?;
        report.check("restored_test_refund_event_statuses",sql("drill_restored",&format!("SELECT count(DISTINCT observed_status) FROM commercial_test_refund_events WHERE contract_id='{contract_id}' AND observed_status IN ('succeeded','failed','pending','requires_action','canceled')"))?.trim()=="5")?;
        report.check("retired_test_refunds_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_test_refunds WHERE contract_id='{retired_contract_id}'"))?.trim()=="0")?;
        report.check("retired_test_refund_events_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_test_refund_events WHERE contract_id='{retired_contract_id}'"))?.trim()=="0")?;
        let refund_history = self.api.json(
            report,
            "restored_test_refund_owner_API",
            "GET",
            &format!("/api/commercial-contracts/{contract_id}/test-refunds"),
            &current_owner.session,
            None,
            200,
            None,
        )?;
        report.check(
            "restored_test_refund_owner_values",
            refund_history["refunds"].as_array().is_some_and(|r| {
                r.len() == 5
                    && r.iter().all(|v| v["evidence"] == "provider_test_sandbox")
                    && r.iter().all(|v| {
                        v["statusBasis"] == "provider_api_test" && v["statusCheckedAt"].is_string()
                    })
                    && r.iter()
                        .filter_map(|v| v["confirmedAmountJpy"].as_u64())
                        .sum::<u64>()
                        == 400
                    && r.iter()
                        .filter(|v| v["providerStatus"] != "succeeded")
                        .all(|v| v["confirmedAmountJpy"] == 0)
                    && [
                        "failed",
                        "pending",
                        "requires_action",
                        "succeeded",
                        "canceled",
                    ]
                    .iter()
                    .all(|s| {
                        r.iter().any(|v| {
                            v["observedStatuses"]
                                .as_array()
                                .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(*s)))
                        })
                    })
            }) && refund_history["nextCursor"].is_null()
                && refund_history["liveRefundExecuted"] == false
                && refund_history["entitlementsGranted"] == false,
        )?;
        report.check("restored_refund_request_nonempty",sql("drill_restored",&format!("SELECT count(*) FROM commercial_refund_requests r JOIN commercial_live_periods p ON (r.account_id,r.payment_event_id,r.contract_id,r.provider_object_id,r.payment_amount_jpy,r.payment_event_hash)=(p.account_id,p.event_id,p.contract_id,p.provider_object_id,p.amount_jpy,p.event_hash) JOIN commercial_contracts c ON c.id=r.contract_id WHERE r.contract_id='{live_id}' AND p.cycle=1 AND r.requested_amount_jpy=400 AND r.payment_amount_jpy=980 AND r.quote_hash=c.quote_hash AND r.status='received' AND r.reason='service_unprovided'"))?.trim()=="1")?;
        report.check("retired_refund_requests_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_refund_requests WHERE contract_id='{retired_live_id}'"))?.trim()=="0")?;
        report.check("restored_refund_review_nonempty",sql("drill_restored",&format!("SELECT count(*) FROM commercial_refund_reviews v JOIN commercial_refund_requests r ON (v.request_id,v.contract_id,v.request_fingerprint,v.requested_amount_jpy)=(r.id,r.contract_id,r.request_fingerprint,r.requested_amount_jpy) WHERE r.contract_id='{live_id}' AND v.revision=1 AND v.decision='approved' AND v.reason='unprovided_period_confirmed' AND v.amount_jpy=400 AND v.requested_amount_jpy=400 AND v.reviewer_id='{}' AND v.balance->>'qualified'='true' AND v.balance->>'availableRefundJpy'='980' AND v.created_at IS NOT NULL",member.id))?.trim()=="1")?;
        report.check("retired_refund_reviews_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_refund_reviews WHERE contract_id='{retired_live_id}'"))?.trim()=="0")?;
        report.check("restored_test_refund_operation_nonempty",sql("drill_restored",&format!("SELECT count(*) FROM commercial_test_refund_operations o JOIN commercial_payment_events p ON (o.account_id,o.payment_event_id,o.contract_id,o.provider_object_id,o.payment_amount_jpy,o.payment_event_hash)=(p.account_id,p.event_id,p.contract_id,p.provider_object_id,p.amount_jpy,p.event_hash) WHERE o.operation_id='89898989-8989-4989-8989-898989898989' AND o.contract_id='{contract_id}' AND o.amount_jpy=100 AND o.payment_amount_jpy=980 AND o.state='approved' AND o.evidence='provider_test_sandbox' AND o.reviewer_id='{}' AND o.provider_refund_id IS NULL",member.id))?.trim()=="1")?;
        report.check("retired_test_refund_operations_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_test_refund_operations WHERE contract_id='{retired_contract_id}'"))?.trim()=="0")?;
        let restored_test_execution=self.api.json(report,"restored_test_refund_operation_owner_HTTP","GET",&format!("/api/commercial-contracts/{contract_id}/test-refund-operations/89898989-8989-4989-8989-898989898989"),&current_owner.session,None,200,None)?;
        report.check("restored_test_refund_operation_exact_values",exact_json(&source_test_execution,&restored_test_execution))?;
        report.check("restored_pending_refund_operation_states",sql("drill_restored",&format!("SELECT count(*) FROM commercial_test_refund_operations o JOIN commercial_payment_events p ON (o.account_id,o.payment_event_id,o.contract_id,o.provider_object_id,o.payment_amount_jpy,o.payment_event_hash)=(p.account_id,p.event_id,p.contract_id,p.provider_object_id,p.amount_jpy,p.event_hash) WHERE o.contract_id='{contract_id}' AND o.first_dispatched_at IS NOT NULL AND o.provider_refund_id IS NULL AND ((o.operation_id='{}' AND o.state='uncertain' AND o.amount_jpy=10 AND o.result_recorded_at IS NOT NULL) OR (o.operation_id='{}' AND o.state='in_flight' AND o.amount_jpy=20 AND o.result_recorded_at IS NULL));",pending_operations[0].0,pending_operations[1].0))?.trim()=="2")?;
        report.check("retired_pending_refund_operations_cascaded",sql("drill_restored","SELECT count(*) FROM commercial_test_refund_operations WHERE operation_id IN ('93939393-9393-4393-8393-939393939393','94949494-9494-4494-8494-949494949494');")?.trim()=="0")?;
        let pending_before=sql("drill_restored",&format!("SELECT row_to_json(o) FROM commercial_test_refund_operations o WHERE operation_id='{}';",pending_operations[0].0))?;
        sql("drill_restored",&format!("DO $validation$ BEGIN BEGIN UPDATE commercial_test_refund_operations SET payment_event_hash=repeat('0',64) WHERE operation_id='{}'; RAISE EXCEPTION 'Expected original event FK rejection'; EXCEPTION WHEN foreign_key_violation THEN NULL; END; END $validation$;",pending_operations[0].0))?;
        report.check("restored_pending_refund_invalid_binding_rejected",pending_before==sql("drill_restored",&format!("SELECT row_to_json(o) FROM commercial_test_refund_operations o WHERE operation_id='{}';",pending_operations[0].0))?)?;
        sql("drill_restored",&format!("DO $validation$ BEGIN BEGIN UPDATE commercial_test_refund_operations SET state='succeeded' WHERE operation_id='{}'; RAISE EXCEPTION 'Expected missing provider result rejection'; EXCEPTION WHEN check_violation THEN NULL; END; END $validation$;",pending_operations[0].0))?;
        report.check("restored_pending_refund_invalid_success_rejected",pending_before==sql("drill_restored",&format!("SELECT row_to_json(o) FROM commercial_test_refund_operations o WHERE operation_id='{}';",pending_operations[0].0))?)?;
        let restored_uncertain_refund=self.api.json(report,"restored_uncertain_refund_owner_HTTP","GET",&format!("/api/commercial-contracts/{contract_id}/test-refund-operations/{}",pending_operations[0].0),&current_owner.session,None,200,None)?;
        let restored_inflight_refund=self.api.json(report,"restored_inflight_refund_owner_HTTP","GET",&format!("/api/commercial-contracts/{contract_id}/test-refund-operations/{}",pending_operations[1].0),&current_owner.session,None,200,None)?;
        report.check("restored_uncertain_refund_exact_values",exact_json(&source_uncertain_refund,&restored_uncertain_refund))?;
        report.check("restored_inflight_refund_exact_values",exact_json(&source_inflight_refund,&restored_inflight_refund))?;
        let pending_path=format!("/api/commercial-contracts/{contract_id}/test-refund-operations/{}",pending_operations[0].0);
        let missing=self.api.request("POST",&format!("{pending_path}/reconcile"),&current_member.session,Some(&json!({})),None)?;
        report.check("restored_pending_refund_missing_truth_409",missing.0==409)?;
        let pending_rows:Value=serde_json::from_str(&sql("drill_restored",&format!("SELECT jsonb_agg(jsonb_build_object('operation',operation_id,'fingerprint',decision_fingerprint,'amount',amount_jpy) ORDER BY operation_id) FROM commercial_test_refund_operations WHERE operation_id IN ('{}','{}');",pending_operations[0].0,pending_operations[1].0))?).map_err(|_|Failure::Json)?;
        let rows=pending_rows.as_array().filter(|rows|rows.len()==2).ok_or(Failure::Shape)?;
        let payment=json!({"id":format!("pi_{}",contract_id.replace('-',"")),"object":"payment_intent","livemode":false,"status":"succeeded","currency":"jpy","amount":980,"amount_received":980,"metadata":{"contractId":contract_id,"ownerId":owner.id,"quoteHash":contract_draft["quoteHash"]}});
        let refunds=rows.iter().enumerate().map(|(index,row)|json!({"id":format!("re_restoredpending{index}"),"object":"refund","payment_intent":payment["id"],"amount":row["amount"],"currency":"jpy","status":"succeeded","metadata":{"operationId":row["operation"],"decisionFingerprint":row["fingerprint"]}})).collect::<Vec<_>>();
        let mut mismatched=refunds.clone();mismatched[0]["metadata"]["decisionFingerprint"]=json!("0".repeat(64));
        seed_pending_refund_truth(&json!({"payment":payment,"refunds":mismatched}))?;
        let wrong=self.api.request("POST",&format!("{pending_path}/reconcile"),&current_member.session,Some(&json!({})),None)?;
        report.check("restored_pending_refund_wrong_decision_409",wrong.0==409 && sql("drill_restored",&format!("SELECT count(*) FROM commercial_test_refund_operations WHERE operation_id='{}' AND state='uncertain' AND provider_refund_id IS NULL;",pending_operations[0].0))?.trim()=="1")?;
        seed_pending_refund_truth(&json!({"payment":payment,"refunds":refunds}))?;
        let mut reconciled=true;
        for (index,(operation,_,amount)) in pending_operations.iter().enumerate() {
            let current=self.api.json(report,if index==0 {"restored_uncertain_refund_reconcile_HTTP"} else {"restored_inflight_refund_reconcile_HTTP"},"POST",&format!("/api/commercial-contracts/{contract_id}/test-refund-operations/{operation}/reconcile"),&current_member.session,Some(&json!({})),200,None)?;
            reconciled &= current["state"]=="succeeded" && current["approvedAmountJpy"]==*amount && current["providerRefundId"]==format!("re_restoredpending{index}") && current["liveRefundExecuted"]==false && current["entitlementsGranted"]==false;
        }
        report.check("restored_pending_refund_metadata_reconciled",reconciled)?;
        let refund_request_id = identifier(&source_refund_request, "/id", 36)?;
        let restored_review=self.api.json(report,"restored_refund_review_reviewer_HTTP","GET",&format!("/api/commercial-contracts/refund-review/{refund_request_id}"),&current_member.session,None,200,None)?;
        report.check("restored_refund_review_exact_values",exact_json(&source_refund_review,&restored_review["review"]) && restored_review["reviewRevision"]==1)?;
        let restored_refund_request = self.api.json(
            report,
            "restored_refund_request_owner_API",
            "GET",
            &format!("/api/commercial-contracts/{live_id}/refund-requests/{refund_request_id}"),
            &current_owner.session,
            None,
            200,
            None,
        )?;
        report.check(
            "restored_refund_request_owner_values",
            exact_json(&source_refund_request, &restored_refund_request)
                && restored_refund_request["refundExecuted"] == false
                && restored_refund_request["approvalGranted"] == true
                && restored_refund_request["approvedAmountJpy"]==400
                && restored_refund_request["review"]["executionAuthorized"]==false,
        )?;
        for (cid, source, api_name, value_name) in &additional_refund_requests {
            let rid = identifier(source, "/id", 36)?;
            let restored = self.api.json(
                report,
                api_name,
                "GET",
                &format!("/api/commercial-contracts/{cid}/refund-requests/{rid}"),
                &current_owner.session,
                None,
                200,
                None,
            )?;
            report.check(value_name, exact_json(source, &restored))?;
        }
        report.check("restored_refund_requests_all_paid_sources",sql("drill_restored","SELECT string_agg(payment_source||':'||n,',' ORDER BY payment_source) FROM (SELECT payment_source,count(*) n FROM commercial_refund_requests GROUP BY payment_source) s")?.trim()=="payment_exception:1,period:1,seat_change:2")?;
        report.check("retired_extra_refund_requests_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_refund_requests WHERE contract_id='{retired_seat_contract_id}'"))?.trim()=="0")?;
        let restored_live = self.api.json(
            report,
            "restored_live_contract_current_owner",
            "GET",
            &format!("/api/commercial-contracts/{live_id}"),
            &current_owner.session,
            None,
            200,
            None,
        )?;
        // The fixture ended in March 2026. Compare stable contract boundaries;
        // today's date is re-derived and may cross midnight while restoring.
        for (name, field) in [
            ("restored_live_contract_start", "contractStart"),
            ("restored_live_paid_through", "paidThrough"),
            ("restored_live_export_window", "exportWindow"),
        ] {
            report.check(
                name,
                exact_json(
                    &live_before["entitlement"][field],
                    &restored_live["entitlement"][field],
                ),
            )?;
        }
        report.check("restored_live_periods_anchored_nonempty", sql("drill_restored",&format!("SELECT string_agg(cycle||':'||period_start||'>'||period_end||':'||amount_jpy||':'||evidence, ',' ORDER BY cycle) FROM commercial_live_periods WHERE contract_id='{live_id}' AND disposition='effective'"))?.trim()=="1:2026-01-31>2026-02-28:980:provider_live,2:2026-02-28>2026-03-31:980:provider_live,3:2026-03-31>2026-04-30:980:provider_live")?;
        report.check("restored_late_payment_refund_disposition_nonempty", sql("drill_restored",&format!("SELECT count(*) FROM commercial_live_periods WHERE contract_id='{live_id}' AND cycle=4 AND disposition='refund_review' AND amount_jpy=980"))?.trim()=="1")?;
        report.check("restored_reconciled_paid_evidence",sql("drill_restored",&format!("SELECT count(*) FROM commercial_live_periods WHERE contract_id='{live_id}' AND cycle=3 AND disposition='effective' AND disposition_reason='paid_before_cancellation' AND provider_event_created IS NOT NULL AND reconciled_at IS NOT NULL"))?.trim()=="1")?;
        report.check("restored_live_contract_anchor", sql("drill_restored",&format!("SELECT contract_start::text FROM commercial_live_contracts WHERE contract_id='{live_id}'"))?.trim()=="2026-01-31")?;
        report.check("restored_seat_change_nonempty_applied",sql("drill_restored",&format!("SELECT count(*) FROM commercial_seat_changes WHERE contract_id='{seat_contract_id}' AND state='applied' AND accepted_at IS NOT NULL AND applied_at IS NOT NULL AND provider_object_id IS NOT NULL"))?.trim()=="1")?;
        report.check("restored_seat_provider_success_saved",sql("drill_restored",&format!("SELECT count(*) FROM commercial_seat_changes WHERE contract_id='{seat_contract_id}' AND state='applied' AND provider_event_created={seat_provider_second} AND payment_received_at IS NOT NULL"))?.trim()=="1")?;
        report.check("restored_current_plan_revision",sql("drill_restored",&format!("SELECT (current_plan->>'users')||':'||seat_revision FROM commercial_contracts WHERE id='{seat_contract_id}'"))?.trim()=="2:1")?;
        report.check("retired_seat_change_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_seat_changes WHERE contract_id='{retired_seat_contract_id}'"))?.trim()=="0")?;
        report.check("restored_decrease_nonempty_funded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_seat_decreases WHERE id='{decrease_id}' AND state='funded' AND target_cycle=2 AND accepted_at IS NOT NULL AND quote->'renewalQuote'->>'monthlyTotalJpy'='980'"))?.trim()=="1")?;
        report.check("restored_decrease_exception_nonempty",sql("drill_restored",&format!("SELECT count(*) FROM commercial_plan_payment_exceptions WHERE contract_id='{seat_contract_id}' AND amount_jpy=980 AND reason='seat_decrease_no_longer_applicable'"))?.trim()=="1")?;
        report.check("restored_decrease_actual_amount_saved",sql("drill_restored",&format!("SELECT count(*) FROM commercial_plan_payment_exceptions WHERE contract_id='{seat_contract_id}' AND amount_jpy=979 AND reason='seat_decrease_amount_mismatch'"))?.trim()=="1")?;
        report.check("restored_decrease_period_bound",sql("drill_restored",&format!("SELECT count(*) FROM commercial_live_periods WHERE contract_id='{seat_contract_id}' AND cycle=2 AND seat_decrease_id='{decrease_id}' AND billing_plan->>'users'='1' AND amount_jpy=980"))?.trim()=="1")?;
        report.check("restored_decrease_legacy_adjustment",sql("drill_restored",&format!("SELECT count(*) FROM commercial_live_periods WHERE contract_id='{seat_contract_id}' AND cycle=3 AND plan_adjustment_review AND billing_plan->>'users'='2' AND amount_jpy=1960"))?.trim()=="1")?;
        report.check("retired_decreases_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_seat_decreases WHERE id='{retired_decrease_id}' OR contract_id='{retired_seat_contract_id}'"))?.trim()=="0")?;
        report.check("retired_decrease_exceptions_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_plan_payment_exceptions WHERE contract_id='{retired_seat_contract_id}'"))?.trim()=="0")?;
        report.check("retired_decrease_periods_cascaded",sql("drill_restored",&format!("SELECT count(*) FROM commercial_live_periods WHERE contract_id='{retired_seat_contract_id}'"))?.trim()=="0")?;
        report.check("retired_live_rows_cascaded", sql("drill_restored",&format!("SELECT (SELECT count(*) FROM commercial_live_contracts WHERE contract_id='{retired_live_id}')+(SELECT count(*) FROM commercial_live_periods WHERE contract_id='{retired_live_id}')"))?.trim()=="0")?;
        report.check(
            "retired_contracts_cascaded",
            sql(
                "drill_restored",
                &format!(
                    "SELECT count(*) FROM commercial_contracts WHERE user_id='{}'",
                    deleted.id
                ),
            )?
            .trim()
                == "0",
        )?;
        report.check(
            "retired_account_receipts_cascaded",
            sql(
                "drill_restored",
                &format!(
                    "SELECT count(*) FROM support_receipts WHERE user_id='{}'",
                    deleted.id
                ),
            )?
            .trim()
                == "0",
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
            "plaintext_API_keeps_encrypted_tables_empty",
            encrypted_tables_empty(&snapshot("drill_restored")?),
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
