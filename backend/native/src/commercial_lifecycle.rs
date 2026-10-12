use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const PERSONAL_USER_MONTHLY_JPY: u64 = 980;
const TEAM_ADMIN_MONTHLY_JPY: u64 = 1_980;
const TEAM_MEMBER_MONTHLY_JPY: u64 = 500;
const INSTALLATION_COMPANY_JPY: u64 = 10_000;
const SUPPORT_HOUR_JPY: u64 = 10_000;
const MAINTENANCE_MIN_JPY: u64 = 10_000;
const MAINTENANCE_MAX_JPY: u64 = 200_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn error(status: u16, code: &str, message: &str) -> Value {
    json!({"status":status,"code":code,"message":message})
}

fn invalid() -> Value {
    error(400, "PS018", "PS018: Invalid commercial lifecycle request")
}

fn exact_fields(value: &Value, fields: &[&str]) -> bool {
    crate::encrypted::exact_fields(value, fields)
}

fn amount(value: &Value, zero: bool) -> Option<u64> {
    value
        .as_u64()
        .filter(|n| *n <= MAX_SAFE_INTEGER && (zero || *n > 0))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct Date {
    year: i32,
    month: u32,
    day: u32,
}

impl Date {
    fn parse(value: &Value) -> Option<Self> {
        let text = value.as_str()?;
        let bytes = text.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }
        let year = parse_digits(&bytes[0..4])? as i32;
        let month = parse_digits(&bytes[5..7])?;
        let day = parse_digits(&bytes[8..10])?;
        if !(1900..=9999).contains(&year)
            || !(1..=12).contains(&month)
            || day == 0
            || day > days_in_month(year, month)
        {
            return None;
        }
        Some(Self { year, month, day })
    }

    fn add_anchor_months(self, months: u64) -> Option<Self> {
        let month0 = i64::from(self.year)
            .checked_mul(12)?
            .checked_add(i64::from(self.month - 1))?
            .checked_add(i64::try_from(months).ok()?)?;
        let year = i32::try_from(month0.div_euclid(12)).ok()?;
        let month = u32::try_from(month0.rem_euclid(12) + 1).ok()?;
        if !(1900..=9999).contains(&year) {
            return None;
        }
        let day = self.day.min(days_in_month(year, month));
        Some(Self { year, month, day })
    }

    fn ordinal(self) -> i64 {
        days_before_year(self.year)
            + days_before_month(self.year, self.month)
            + i64::from(self.day - 1)
    }

    fn add_days(self, days: i64) -> Option<Self> {
        let mut year = self.year;
        let mut month = self.month;
        let mut day = i64::from(self.day).checked_add(days)?;
        loop {
            if day < 1 {
                if month == 1 {
                    year = year.checked_sub(1)?;
                    month = 12;
                } else {
                    month -= 1;
                }
                if year < 1900 {
                    return None;
                }
                day = day.checked_add(i64::from(days_in_month(year, month)))?;
                continue;
            }
            let month_days = i64::from(days_in_month(year, month));
            if day <= month_days {
                break;
            }
            day -= month_days;
            if month == 12 {
                year = year.checked_add(1)?;
                month = 1;
            } else {
                month += 1;
            }
            if year > 9999 {
                return None;
            }
        }
        Some(Self {
            year,
            month,
            day: u32::try_from(day).ok()?,
        })
    }
}

impl std::fmt::Display for Date {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

fn parse_digits(bytes: &[u8]) -> Option<u32> {
    bytes.iter().try_fold(0u32, |acc, byte| {
        if !byte.is_ascii_digit() {
            return None;
        }
        acc.checked_mul(10)?.checked_add(u32::from(byte - b'0'))
    })
}

fn leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn days_before_year(year: i32) -> i64 {
    let previous = i64::from(year - 1);
    previous * 365 + previous / 4 - previous / 100 + previous / 400
}

fn days_before_month(year: i32, month: u32) -> i64 {
    let mut days = 0i64;
    for current in 1..month {
        days += i64::from(days_in_month(year, current));
    }
    days
}

fn days_between(start: Date, end: Date) -> Option<u64> {
    u64::try_from(end.ordinal().checked_sub(start.ordinal())?).ok()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlanKind {
    Personal,
    Team,
}

#[derive(Clone, Debug)]
struct PlanPrice {
    kind: PlanKind,
    monthly_jpy: u64,
    normalized: Value,
}

fn plan_price(value: &Value) -> Option<PlanPrice> {
    let kind = value["type"].as_str()?;
    match kind {
        "personal" if exact_fields(value, &["type", "users"]) => {
            let users = amount(&value["users"], false)?;
            let monthly_jpy = users
                .checked_mul(PERSONAL_USER_MONTHLY_JPY)
                .filter(|n| *n <= MAX_SAFE_INTEGER)?;
            Some(PlanPrice {
                kind: PlanKind::Personal,
                monthly_jpy,
                normalized: json!({
                    "type":"personal",
                    "users":users,
                    "unitMonthlyJpy":PERSONAL_USER_MONTHLY_JPY
                }),
            })
        }
        "team" if exact_fields(value, &["type", "administrators", "members"]) => {
            let administrators = amount(&value["administrators"], false)?;
            let members = amount(&value["members"], false)?;
            let admin_total = administrators.checked_mul(TEAM_ADMIN_MONTHLY_JPY)?;
            let member_total = members.checked_mul(TEAM_MEMBER_MONTHLY_JPY)?;
            let monthly_jpy = admin_total
                .checked_add(member_total)
                .filter(|n| *n <= MAX_SAFE_INTEGER)?;
            Some(PlanPrice {
                kind: PlanKind::Team,
                monthly_jpy,
                normalized: json!({
                    "type":"team",
                    "administrators":administrators,
                    "members":members,
                    "administratorUnitMonthlyJpy":TEAM_ADMIN_MONTHLY_JPY,
                    "memberUnitMonthlyJpy":TEAM_MEMBER_MONTHLY_JPY
                }),
            })
        }
        _ => None,
    }
}

fn actor_authority(
    input: &Value,
    need_billing: bool,
    need_export_scope: bool,
) -> Result<Value, Value> {
    if !exact_fields(
        input,
        &[
            "sessionValid",
            "accountRemoved",
            "identityConfirmed",
            "billingAdministrator",
            "membershipActive",
            "hasExportScope",
        ],
    ) || input
        .as_object()
        .is_some_and(|fields| fields.values().any(|value| !value.is_boolean()))
    {
        return Err(invalid());
    }
    if input["sessionValid"] != true {
        return Err(error(401, "PS024", "Session is invalid or expired"));
    }
    if input["accountRemoved"] == true {
        return Err(error(403, "PS061", "Actor account is removed"));
    }
    if input["identityConfirmed"] != true {
        return Err(error(403, "PS062", "Actor identity is unconfirmed"));
    }
    if need_billing && input["billingAdministrator"] != true {
        return Err(error(
            403,
            "PS063",
            "Billing administrator assertion is required",
        ));
    }
    if need_export_scope && (input["membershipActive"] != true || input["hasExportScope"] != true) {
        return Err(error(
            403,
            "PS064",
            "Current membership and export key scope are required",
        ));
    }
    Ok(json!({
        "assertionSource":"provided_assertions",
        "independentlyCheckedIdentity":false,
        "sessionValid":input["sessionValid"],
        "accountRemoved":input["accountRemoved"],
        "identityConfirmed":input["identityConfirmed"],
        "billingAdministrator":input["billingAdministrator"],
        "membershipActive":input["membershipActive"],
        "hasExportScope":input["hasExportScope"],
        "billingAdministratorPurpose":"contract and billing lifecycle only",
        "billingAdministratorDoesNotImplyPasswordBoxOwner":true,
        "passwordBoxOwnershipIndependentlyChecked":false,
        "doesNotGrantPasswordBoxOwnership":true,
        "doesNotGrantMembership":true,
        "doesNotGrantKeyAccess":true
    }))
}

pub fn quote(input: &Value) -> Value {
    if !exact_fields(input, &["command", "currency", "plan", "setup"])
        || input["currency"].as_str() != Some("JPY")
    {
        return invalid();
    }
    let Some(plan) = plan_price(&input["plan"]) else {
        return invalid();
    };
    let setup = &input["setup"];
    if !exact_fields(
        setup,
        &[
            "installationCompanies",
            "supportHours",
            "maintenanceMonthlyJpy",
        ],
    ) {
        return invalid();
    }
    let (Some(installation_companies), Some(support_hours)) = (
        amount(&setup["installationCompanies"], true),
        amount(&setup["supportHours"], true),
    ) else {
        return invalid();
    };
    let maintenance = match &setup["maintenanceMonthlyJpy"] {
        Value::Null => None,
        value => match amount(value, false)
            .filter(|n| (MAINTENANCE_MIN_JPY..=MAINTENANCE_MAX_JPY).contains(n))
        {
            Some(amount) => Some(amount),
            None => return invalid(),
        },
    };
    let installation_total = match installation_companies
        .checked_mul(INSTALLATION_COMPANY_JPY)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
    {
        Some(value) => value,
        None => return invalid(),
    };
    let support_total = match support_hours
        .checked_mul(SUPPORT_HOUR_JPY)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
    {
        Some(value) => value,
        None => return invalid(),
    };
    let monthly_total = match plan
        .monthly_jpy
        .checked_add(maintenance.unwrap_or(0))
        .filter(|n| *n <= MAX_SAFE_INTEGER)
    {
        Some(value) => value,
        None => return invalid(),
    };
    let one_time_total = match installation_total
        .checked_add(support_total)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
    {
        Some(value) => value,
        None => return invalid(),
    };
    json!({"status":200,"body":{
        "kind":"commercial-quotation",
        "currency":"JPY",
        "taxTreatment":"tax_included_final_payment_amount",
        "plan":plan.normalized,
        "monthlySubscriptionJpy":plan.monthly_jpy,
        "monthlyMaintenanceJpy":maintenance,
        "monthlyTotalJpy":monthly_total,
        "oneTimeInstallationJpy":installation_total,
        "oneTimeSupportJpy":support_total,
        "oneTimeTotalJpy":one_time_total,
        "lineItems":[
            {"code":"subscription","amountJpy":plan.monthly_jpy,"cadence":"monthly"},
            {"code":"maintenance","amountJpy":maintenance,"cadence":"monthly","requiresExplicitQuote":true},
            {"code":"installation","unitJpy":INSTALLATION_COMPANY_JPY,"quantity":installation_companies,"amountJpy":installation_total,"cadence":"one_time"},
            {"code":"support","unitJpy":SUPPORT_HOUR_JPY,"quantity":support_hours,"amountJpy":support_total,"cadence":"one_time"}
        ],
        "policy":{
            "inventedFeesIncluded":false,
            "minimumBeyondApprovedTeamMinimumIncluded":false,
            "paymentAdapterExecuted":false,
            "actualContractCreated":false
        }
    }})
}

pub fn lifecycle(input: &Value) -> Value {
    match input["operation"].as_str() {
        Some("renewal-preview") => renewal_preview(input),
        Some("seat-increase-quote") => seat_increase(input),
        Some("seat-decrease") => seat_decrease(input),
        Some("cancel") => cancel(input),
        Some("post-end-export") => post_end_export(input),
        _ => invalid(),
    }
}

fn renewal_preview(input: &Value) -> Value {
    if !exact_fields(input, &["command", "operation", "contractStart", "cycles"]) {
        return invalid();
    }
    let (Some(start), Some(cycles)) = (
        Date::parse(&input["contractStart"]),
        amount(&input["cycles"], false).filter(|n| *n <= 120),
    ) else {
        return invalid();
    };
    let mut periods = Vec::new();
    for cycle in 0..cycles {
        let Some(period_start) = start.add_anchor_months(cycle) else {
            return invalid();
        };
        let Some(period_end) = start.add_anchor_months(cycle + 1) else {
            return invalid();
        };
        periods.push(json!({
            "periodStart":period_start.to_string(),
            "periodEnd":period_end.to_string(),
            "renewalDate":period_end.to_string()
        }));
    }
    json!({"status":200,"body":{
        "kind":"commercial-lifecycle-renewal-preview",
        "calendar":"gregorian",
        "timezonePolicy":"not_applicable_calendar_dates_only",
        "anchorDay":start.day,
        "contractStart":start.to_string(),
        "periods":periods,
        "policy":{
            "anchorUsesOriginalContractStartDay":true,
            "clampsOnlyMonthsWithoutAnchorDay":true,
            "doesNotDriftFromClampedMonth":true
        }
    }})
}

fn seat_increase(input: &Value) -> Value {
    if !exact_fields(
        input,
        &[
            "command",
            "operation",
            "currency",
            "currentPlan",
            "requestedPlan",
            "periodStart",
            "periodEnd",
            "changeDate",
            "roundingPolicy",
            "actor",
            "acceptedQuote",
        ],
    ) || input["currency"].as_str() != Some("JPY")
    {
        return invalid();
    }
    let authority = match actor_authority(&input["actor"], true, false) {
        Ok(value) => value,
        Err(err) => return err,
    };
    let Some((current, requested)) =
        compatible_plans(&input["currentPlan"], &input["requestedPlan"])
    else {
        return invalid();
    };
    if requested.monthly_jpy <= current.monthly_jpy
        || !seat_counts_monotonic(&current.normalized, &requested.normalized, true)
    {
        return invalid();
    }
    let (Some(period_start), Some(period_end), Some(change_date)) = (
        Date::parse(&input["periodStart"]),
        Date::parse(&input["periodEnd"]),
        Date::parse(&input["changeDate"]),
    ) else {
        return invalid();
    };
    if !(period_start < period_end && period_start <= change_date && change_date < period_end) {
        return invalid();
    }
    let (Some(denominator), Some(numerator)) = (
        days_between(period_start, period_end),
        days_between(change_date, period_end),
    ) else {
        return invalid();
    };
    if denominator == 0 || numerator == 0 || numerator > denominator {
        return invalid();
    }
    let Some(delta_monthly) = requested.monthly_jpy.checked_sub(current.monthly_jpy) else {
        return invalid();
    };
    let Some(exact_numerator_jpy) = delta_monthly
        .checked_mul(numerator)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
    else {
        return invalid();
    };
    let rounded = match input["roundingPolicy"].as_str() {
        Some("none") => Value::Null,
        Some("floor-jpy") => json!(exact_numerator_jpy / denominator),
        Some("ceil-jpy") => {
            let Some(value) = exact_numerator_jpy
                .checked_add(denominator - 1)
                .map(|value| value / denominator)
            else {
                return invalid();
            };
            json!(value)
        }
        _ => return invalid(),
    };
    let quote = json!({
        "currency":"JPY",
        "currentPlan":current.normalized,
        "requestedPlan":requested.normalized,
        "additionalMonthlyJpy":delta_monthly,
        "periodStart":period_start.to_string(),
        "periodEnd":period_end.to_string(),
        "changeDate":change_date.to_string(),
        "proration":{
            "calendar":"gregorian",
            "timezonePolicy":"not_applicable_calendar_dates_only",
            "periodEndExclusive":true,
            "numeratorRemainingDays":numerator,
            "denominatorPeriodDays":denominator,
            "exactNumeratorJpy":exact_numerator_jpy,
            "exactDenominator":denominator,
            "exactExpression":"additionalMonthlyJpy * numeratorRemainingDays / denominatorPeriodDays"
        },
        "proposedRoundedJpy":rounded,
        "roundingPolicy":input["roundingPolicy"]
    });
    let quote_hash = quote_hash(&quote);
    if input["acceptedQuote"].is_null() {
        return json!({"status":200,"body":{
            "kind":"commercial-seat-increase-proposal",
            "actorAuthority":authority,
            "quote":quote,
            "quoteHash":quote_hash,
            "acceptance":{"required":true,"requiresUnchangedQuote":true},
            "decision":"requires-explicit-acceptance",
            "paymentAdapterExecuted":false,
            "actualSeatChangePersisted":false
        }});
    }
    if input["acceptedQuote"] != quote {
        return error(
            409,
            "PS015",
            "PS015: Commercial quote changed; request explicit acceptance again",
        );
    }
    json!({"status":200,"body":{
        "kind":"commercial-seat-increase-decision",
        "actorAuthority":authority,
        "quote":quote,
        "quoteHash":quote_hash,
        "decision":"accepted-unchanged-quote",
        "proposalOnly":true,
        "paymentAdapterRequired":true,
        "paymentAdapterExecuted":false,
        "actualSeatChangePersisted":false
    }})
}

fn seat_decrease(input: &Value) -> Value {
    if !exact_fields(
        input,
        &[
            "command",
            "operation",
            "currency",
            "currentPlan",
            "requestedPlan",
            "currentPeriodEnd",
            "actor",
        ],
    ) || input["currency"].as_str() != Some("JPY")
    {
        return invalid();
    }
    let authority = match actor_authority(&input["actor"], true, false) {
        Ok(value) => value,
        Err(err) => return err,
    };
    let Some((current, requested)) =
        compatible_plans(&input["currentPlan"], &input["requestedPlan"])
    else {
        return invalid();
    };
    if requested.monthly_jpy >= current.monthly_jpy
        || !seat_counts_monotonic(&current.normalized, &requested.normalized, false)
    {
        return invalid();
    }
    let Some(period_end) = Date::parse(&input["currentPeriodEnd"]) else {
        return invalid();
    };
    json!({"status":200,"body":{
        "kind":"commercial-seat-decrease-decision",
        "actorAuthority":authority,
        "decision":"apply-next-renewal",
        "effectiveDate":period_end.to_string(),
        "currentPlan":current.normalized,
        "requestedPlan":requested.normalized,
        "refundForCurrentPeriodJpy":0,
        "paymentAdapterExecuted":false,
        "actualSeatChangePersisted":false
    }})
}

fn cancel(input: &Value) -> Value {
    if !exact_fields(
        input,
        &[
            "command",
            "operation",
            "currency",
            "periodStart",
            "periodEnd",
            "cancelDate",
            "actor",
        ],
    ) || input["currency"].as_str() != Some("JPY")
    {
        return invalid();
    }
    let authority = match actor_authority(&input["actor"], true, false) {
        Ok(value) => value,
        Err(err) => return err,
    };
    let (Some(start), Some(end), Some(cancel_date)) = (
        Date::parse(&input["periodStart"]),
        Date::parse(&input["periodEnd"]),
        Date::parse(&input["cancelDate"]),
    ) else {
        return invalid();
    };
    if !(start < end && start <= cancel_date && cancel_date < end) {
        return invalid();
    }
    json!({"status":200,"body":{
        "kind":"commercial-cancellation-decision",
        "actorAuthority":authority,
        "decision":"cancel-at-paid-period-end",
        "cancelDate":cancel_date.to_string(),
        "paidPeriodStart":start.to_string(),
        "paidPeriodEndExclusive":end.to_string(),
        "preservesPaidPeriod":true,
        "penaltyJpy":0,
        "selfServiceProratedRefundJpy":0,
        "paymentAdapterExecuted":false,
        "actualCancellationPersisted":false,
        "automaticDeletionScheduled":false
    }})
}

fn post_end_export(input: &Value) -> Value {
    if !exact_fields(
        input,
        &[
            "command",
            "operation",
            "contractEnd",
            "requestDate",
            "actor",
        ],
    ) {
        return invalid();
    }
    let authority = match actor_authority(&input["actor"], false, true) {
        Ok(value) => value,
        Err(err) => return err,
    };
    let (Some(contract_end), Some(request_date)) = (
        Date::parse(&input["contractEnd"]),
        Date::parse(&input["requestDate"]),
    ) else {
        return invalid();
    };
    let Some(export_until) = contract_end.add_days(30) else {
        return invalid();
    };
    if request_date < contract_end || request_date >= export_until {
        return error(403, "PS065", "Post-end export window has expired");
    }
    json!({"status":200,"body":{
        "kind":"commercial-post-end-export-decision",
        "actorAuthority":authority,
        "decision":"allow-export-proposal-only",
        "contractEnd":contract_end.to_string(),
        "requestDate":request_date.to_string(),
        "exportWindowEndExclusive":export_until.to_string(),
        "notRenewedIdentityMembershipOrKeyPermission":true,
        "requiresCurrentIdentityMembershipAndKeyScope":true,
        "paymentAdapterExecuted":false,
        "actualExportAuthorizationPersisted":false,
        "automaticDeletionExecuted":false
    }})
}

fn compatible_plans(current: &Value, requested: &Value) -> Option<(PlanPrice, PlanPrice)> {
    let current = plan_price(current)?;
    let requested = plan_price(requested)?;
    (current.kind == requested.kind).then_some((current, requested))
}

fn seat_counts_monotonic(current: &Value, requested: &Value, increase: bool) -> bool {
    match current["type"].as_str() {
        Some("personal") => compare_count(
            current["users"].as_u64(),
            requested["users"].as_u64(),
            increase,
        ),
        Some("team") => {
            compare_count(
                current["administrators"].as_u64(),
                requested["administrators"].as_u64(),
                increase,
            ) && compare_count(
                current["members"].as_u64(),
                requested["members"].as_u64(),
                increase,
            )
        }
        _ => false,
    }
}

fn compare_count(current: Option<u64>, requested: Option<u64>, increase: bool) -> bool {
    match (current, requested, increase) {
        (Some(current), Some(requested), true) => requested >= current,
        (Some(current), Some(requested), false) => requested <= current,
        _ => false,
    }
}

fn quote_hash(quote: &Value) -> String {
    format!("{:x}", Sha256::digest(quote.to_string().as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor() -> Value {
        json!({
            "sessionValid":true,
            "accountRemoved":false,
            "identityConfirmed":true,
            "billingAdministrator":true,
            "membershipActive":true,
            "hasExportScope":true
        })
    }

    #[test]
    fn quote_uses_only_approved_tax_included_jpy_prices() {
        let result = quote(&json!({
            "command":"commercial-quote",
            "currency":"JPY",
            "plan":{"type":"team","administrators":1,"members":4},
            "setup":{"installationCompanies":1,"supportHours":2,"maintenanceMonthlyJpy":10000}
        }));
        assert_eq!(result["status"], 200);
        assert_eq!(result["body"]["monthlySubscriptionJpy"], 3980);
        assert_eq!(result["body"]["monthlyTotalJpy"], 13980);
        assert_eq!(result["body"]["oneTimeTotalJpy"], 30000);
        assert_eq!(
            quote(&json!({
                "command":"commercial-quote",
                "currency":"USD",
                "plan":{"type":"team","administrators":1,"members":1},
                "setup":{"installationCompanies":0,"supportHours":0,"maintenanceMonthlyJpy":null}
            }))["status"],
            400
        );
    }

    #[test]
    fn quote_rejects_fractional_negative_missing_unknown_and_unapproved_values() {
        let valid = json!({
            "command":"commercial-quote",
            "currency":"JPY",
            "plan":{"type":"personal","users":1},
            "setup":{"installationCompanies":0,"supportHours":0,"maintenanceMonthlyJpy":null}
        });
        assert_eq!(quote(&valid)["status"], 200);
        for (path, value) in [
            ("/plan/users", json!(1.5)),
            ("/plan/users", json!(-1)),
            ("/setup/supportHours", json!("1")),
            ("/setup/maintenanceMonthlyJpy", json!(9_999)),
            ("/setup/maintenanceMonthlyJpy", json!(200_001)),
        ] {
            let mut changed = valid.clone();
            *changed.pointer_mut(path).unwrap() = value;
            assert_eq!(quote(&changed)["status"], 400, "{path}");
        }
        let mut missing = valid.clone();
        missing["plan"].as_object_mut().unwrap().remove("users");
        assert_eq!(quote(&missing)["status"], 400);
        let mut extra = valid;
        extra["setup"]["discount"] = json!(1);
        assert_eq!(quote(&extra)["status"], 400);
    }

    #[test]
    fn renewal_anchor_uses_original_day_without_clamped_month_drift() {
        let result = lifecycle(&json!({
            "command":"commercial-lifecycle-decision",
            "operation":"renewal-preview",
            "contractStart":"2026-01-31",
            "cycles":3
        }));
        assert_eq!(result["status"], 200);
        assert_eq!(result["body"]["periods"][0]["periodEnd"], "2026-02-28");
        assert_eq!(result["body"]["periods"][1]["periodEnd"], "2026-03-31");
        assert_eq!(result["body"]["periods"][2]["periodStart"], "2026-03-31");

        let leap = lifecycle(&json!({
            "command":"commercial-lifecycle-decision",
            "operation":"renewal-preview",
            "contractStart":"2024-02-29",
            "cycles":13
        }));
        assert_eq!(leap["body"]["periods"][11]["periodEnd"], "2025-02-28");
        assert_eq!(leap["body"]["periods"][12]["periodEnd"], "2025-03-29");
    }

    #[test]
    fn seat_increase_returns_exact_fraction_and_requires_unchanged_acceptance() {
        let request = json!({
            "command":"commercial-lifecycle-decision",
            "operation":"seat-increase-quote",
            "currency":"JPY",
            "currentPlan":{"type":"team","administrators":1,"members":1},
            "requestedPlan":{"type":"team","administrators":1,"members":3},
            "periodStart":"2026-01-31",
            "periodEnd":"2026-02-28",
            "changeDate":"2026-02-14",
            "roundingPolicy":"ceil-jpy",
            "actor":actor(),
            "acceptedQuote":null
        });
        let proposal = lifecycle(&request);
        assert_eq!(proposal["status"], 200);
        assert_eq!(
            proposal["body"]["quote"]["proration"]["numeratorRemainingDays"],
            14
        );
        assert_eq!(
            proposal["body"]["quote"]["proration"]["denominatorPeriodDays"],
            28
        );
        assert_eq!(
            proposal["body"]["quote"]["proration"]["exactNumeratorJpy"],
            14_000
        );
        assert_eq!(proposal["body"]["quote"]["proposedRoundedJpy"], 500);

        let mut accepted = request.clone();
        accepted["acceptedQuote"] = proposal["body"]["quote"].clone();
        assert_eq!(
            lifecycle(&accepted)["body"]["decision"],
            "accepted-unchanged-quote"
        );

        accepted["acceptedQuote"]["proposedRoundedJpy"] = json!(499);
        assert_eq!(lifecycle(&accepted)["status"], 409);
    }

    #[test]
    fn decreases_and_cancellation_are_next_period_or_paid_period_only() {
        let decrease = lifecycle(&json!({
            "command":"commercial-lifecycle-decision",
            "operation":"seat-decrease",
            "currency":"JPY",
            "currentPlan":{"type":"team","administrators":1,"members":3},
            "requestedPlan":{"type":"team","administrators":1,"members":1},
            "currentPeriodEnd":"2026-03-31",
            "actor":actor()
        }));
        assert_eq!(decrease["body"]["decision"], "apply-next-renewal");
        assert_eq!(decrease["body"]["refundForCurrentPeriodJpy"], 0);

        let cancel = lifecycle(&json!({
            "command":"commercial-lifecycle-decision",
            "operation":"cancel",
            "currency":"JPY",
            "periodStart":"2026-02-28",
            "periodEnd":"2026-03-31",
            "cancelDate":"2026-03-01",
            "actor":actor()
        }));
        assert_eq!(cancel["body"]["preservesPaidPeriod"], true);
        assert_eq!(cancel["body"]["penaltyJpy"], 0);
        assert_eq!(cancel["body"]["selfServiceProratedRefundJpy"], 0);
    }

    #[test]
    fn access_decisions_reject_expired_removed_or_unconfirmed_actor_assertions() {
        for (path, value, status) in [
            ("/actor/sessionValid", json!(false), 401),
            ("/actor/accountRemoved", json!(true), 403),
            ("/actor/identityConfirmed", json!(false), 403),
        ] {
            let mut input = json!({
                "command":"commercial-lifecycle-decision",
                "operation":"cancel",
                "currency":"JPY",
                "periodStart":"2026-02-28",
                "periodEnd":"2026-03-31",
                "cancelDate":"2026-03-01",
                "actor":actor()
            });
            *input.pointer_mut(path).unwrap() = value;
            assert_eq!(lifecycle(&input)["status"], status, "{path}");
        }
    }

    #[test]
    fn post_end_export_is_not_new_membership_or_key_permission() {
        let result = lifecycle(&json!({
            "command":"commercial-lifecycle-decision",
            "operation":"post-end-export",
            "contractEnd":"2026-03-31",
            "requestDate":"2026-04-29",
            "actor":actor()
        }));
        assert_eq!(result["status"], 200);
        assert_eq!(
            result["body"]["notRenewedIdentityMembershipOrKeyPermission"],
            true
        );
        assert_eq!(
            result["body"]["actorAuthority"]["independentlyCheckedIdentity"],
            false
        );

        let expired = lifecycle(&json!({
            "command":"commercial-lifecycle-decision",
            "operation":"post-end-export",
            "contractEnd":"2026-03-31",
            "requestDate":"2026-04-30",
            "actor":actor()
        }));
        assert_eq!(expired["status"], 403);
    }
}
