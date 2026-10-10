//! Verification-only runner. Not a product CLI or a customer recovery tool.
mod report_validation;
mod scenario;

use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod web_routing_tests;

const BASE: &str = "http://127.0.0.1:8080";
const NATIVE: &str = "/usr/local/bin/passshare-mutations";
const PG_BIN: &str = "/usr/lib/postgresql/16/bin";
const LIMIT: u64 = 16 * 1024 * 1024;
const TABLES: &[&str] = &[
    "connect_vaults",
    "connect_items",
    "connect_item_files",
    "users",
    "sessions",
    "connect_tokens",
    "vault_memberships",
    "vault_invitations",
    "login_failures",
    "login_ip_requests",
    "mutation_operations",
];
// Exact additive tables from backend/native/src/encrypted-schema.sql. This
// legacy plaintext exercise never activates encrypted storage or stages rotation.
const ENCRYPTED_TABLES: &[&str] = &[
    "encrypted_box_state",
    "encrypted_items",
    "encrypted_item_tombstones",
    "encrypted_attachments",
    "encrypted_attachment_tombstones",
    "encrypted_rotation_attachments",
    "encrypted_owner_keys",
    "encrypted_account_identities",
    "encrypted_key_grants",
    "encrypted_rotations",
    "encrypted_rotation_items",
    "encrypted_rotation_grants",
];

fn known_tables() -> impl Iterator<Item = &'static str> {
    TABLES.iter().chain(ENCRYPTED_TABLES).copied()
}

fn schema_inventory_matches(value: &Value) -> bool {
    let mut expected = known_tables().collect::<Vec<_>>();
    expected.sort_unstable();
    // The catalog query orders names; equality rejects unknown, missing and
    // duplicate names, even when an unexpected inventory has the same count.
    *value == json!(expected)
}

fn schema_inventory(database: &str) -> Result<Value> {
    serde_json::from_str(&sql(database,
        "SELECT COALESCE(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public';")?)
        .map_err(|_| Failure::Json)
}

// Only static categories may reach the report. Never format library/child errors.
#[derive(Clone, Copy, Debug)]
enum Failure {
    Input,
    Io,
    Process,
    Timeout,
    Database,
    Http,
    Json,
    Shape,
    Check,
    Cleanup,
    Panic,
}
impl Failure {
    fn class(self) -> &'static str {
        match self {
            Self::Input => "input_guard",
            Self::Io => "io",
            Self::Process => "child_process",
            Self::Timeout => "timeout",
            Self::Database => "database_command",
            Self::Http => "http_transport",
            Self::Json => "json_parse",
            Self::Shape => "response_shape",
            Self::Check => "check_failed",
            Self::Cleanup => "cleanup",
            Self::Panic => "internal_panic",
        }
    }
}
type Result<T> = std::result::Result<T, Failure>;

struct Inputs {
    source_sha: String,
    backend_sha256: String,
    omit_purge: bool,
}

fn is_hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn validate_inputs(argc: usize, container: bool, env: &[(String, String)]) -> Result<Inputs> {
    if argc != 1 || !container {
        return Err(Failure::Input);
    }
    let get = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    if get("PASSSHARE_RESTORE_DRILL") != Some("synthetic-container-v1") {
        return Err(Failure::Input);
    }
    let forbidden = [
        "PGHOST",
        "PGHOSTADDR",
        "PGPORT",
        "PGDATABASE",
        "PGUSER",
        "PGPASSWORD",
        "PGPASSFILE",
        "PGSERVICE",
        "PGSERVICEFILE",
        "PGOPTIONS",
        "PGSSLMODE",
        "PGSSLROOTCERT",
        "PGSSLCERT",
        "PGSSLKEY",
        "PGREQUIRESSL",
        "PGCONNECT_TIMEOUT",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PASSSHARE_MUTATIONS_BIN",
        "APP_ENV",
        "PORT",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
    ];
    for (key, _) in env {
        let upper = key.to_ascii_uppercase();
        if forbidden.contains(&upper.as_str())
            || upper.starts_with("DATABASE_")
            || upper.starts_with("OP_CONNECT_")
            || upper.starts_with("CONNECT_")
            || upper.ends_with("_PASSWORD")
            || upper.ends_with("_TOKEN")
            || upper.ends_with("_SECRET")
            || upper.ends_with("_KEY")
        {
            return Err(Failure::Input);
        }
    }
    let source_sha = get("DRILL_SOURCE_SHA").ok_or(Failure::Input)?;
    let backend_sha256 = get("DRILL_BACKEND_SHA256").ok_or(Failure::Input)?;
    if !is_hex(source_sha, 40) || !is_hex(backend_sha256, 64) {
        return Err(Failure::Input);
    }
    let omit_purge = match get("PASSSHARE_DRILL_CONTROL") {
        None => false,
        Some("omit-credential-purge") => true,
        _ => return Err(Failure::Input),
    };
    Ok(Inputs {
        source_sha: source_sha.into(),
        backend_sha256: backend_sha256.into(),
        omit_purge,
    })
}

fn database_url(database: &str) -> Result<String> {
    match database {
        "drill_source" | "drill_restored" => {
            Ok(format!("postgresql://postgres@postgres:5432/{database}"))
        }
        _ => Err(Failure::Input),
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// Fresh credentials exist only in this disposable run's memory and synthetic DB.
fn synthetic_password() -> Result<String> {
    let mut entropy = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut entropy))
        .map_err(|_| Failure::Io)?;
    Ok(entropy
        .into_iter()
        .map(|byte| char::from(33 + byte % 94))
        .collect())
}

struct Report {
    started: u64,
    checks: Vec<Value>,
    metadata: Value,
    measurements: serde_json::Map<String, Value>,
}
impl Report {
    fn new(inputs: Option<&Inputs>) -> Self {
        Self {
            started: unix_ms(),
            checks: Vec::new(),
            measurements: serde_json::Map::new(),
            metadata: inputs.map_or(Value::Null, |i| {
                json!({
                    "source_sha": i.source_sha, "backend_source_sha256": i.backend_sha256,
                    "negative_control": i.omit_purge,
                })
            }),
        }
    }
    fn check(&mut self, name: &'static str, passed: bool) -> Result<()> {
        self.checks
            .push(json!({"name": name, "passed": passed, "at_unix_ms": unix_ms()}));
        if passed {
            Ok(())
        } else {
            Err(Failure::Check)
        }
    }
    fn measurement(&mut self, name: &'static str, value: Value) {
        self.measurements.insert(name.into(), value);
    }
    fn json(&self, completed: bool, failure: Option<Failure>) -> Value {
        json!({
            "schema_version": 1, "synthetic_only": true,
            "tool": "verification_only_not_product_cli",
            "started_at_unix_ms": self.started, "finished_at_unix_ms": unix_ms(),
            "completed": completed, "failure_class": failure.map(Failure::class),
            "metadata": self.metadata, "check_count": self.checks.len(),
            "passed_count": self.checks.iter().filter(|c| c["passed"] == true).count(),
            "checks": self.checks, "measurements": self.measurements,
            "limits": {
                "timing": "synthetic_service_only_not_production_RTO_or_RPO",
                "account_reconciliation": "synthetic_SQL_only_no_identity_verification",
                "owner_reapproval": "synthetic_SQL_only_API_checks_authorization_after_insert",
                "closure": "local_Node_stopped_parent_must_supply_internal_unpublished_network",
                "client": "HTTP_mobile_token_protocol_not_UI_SDK_or_all_clients",
                "encrypted_storage": "empty_tables_only_no_encrypted_recovery_or_rotation_verification",
            }
        })
    }
}

// Reap on every normal error/unwind, including timeout and failed readiness.
struct OwnedChild {
    child: Child,
    reaped: bool,
}
impl OwnedChild {
    fn spawn(command: &mut Command) -> Result<Self> {
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        Ok(Self {
            child: command.spawn().map_err(|_| Failure::Process)?,
            reaped: false,
        })
    }
    #[cfg(all(test, target_os = "linux"))]
    fn pid(&self) -> u32 {
        self.child.id()
    }
    fn stop(&mut self) -> Result<()> {
        if self.reaped {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        {
            // Each owned child leads a new process group. Include native helpers
            // if a failed HTTP request left one running when Node is stopped.
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            let pid = i32::try_from(self.child.id()).map_err(|_| Failure::Cleanup)?;
            // SAFETY: negative pid addresses only our still-owned process group;
            // SIGKILL=9 on Linux. The direct child is always waited below.
            unsafe {
                kill(-pid, 9);
            }
        }
        if self
            .child
            .try_wait()
            .map_err(|_| Failure::Cleanup)?
            .is_none()
        {
            // If the child exited between try_wait and kill, wait still reaps it.
            let _ = self.child.kill();
        }
        self.child.wait().map_err(|_| Failure::Cleanup)?;
        self.reaped = true;
        Ok(())
    }
    fn alive(&mut self) -> Result<bool> {
        Ok(self
            .child
            .try_wait()
            .map_err(|_| Failure::Process)?
            .is_none())
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct Temporary {
    path: PathBuf,
}
impl Temporary {
    fn create() -> Result<Self> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Failure::Io)?
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "passshare-restore-1177-{}-{nonce}",
            std::process::id()
        ));
        // create_dir rejects pre-existing paths, so cleanup only owns our directory.
        std::fs::create_dir(&path).map_err(|_| Failure::Io)?;
        let temporary = Self { path };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary.path, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| Failure::Io)?;
        }
        Ok(temporary)
    }
    fn cleanup(&self) -> Result<()> {
        if !self.path.exists() {
            return Ok(());
        }
        std::fs::remove_dir_all(&self.path).map_err(|_| Failure::Cleanup)
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

fn clean_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("TZ", "UTC")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

// Read concurrently so a full stdout pipe cannot deadlock psql snapshots.
// Commands have no shell, no inherited credentials, bounded output and a deadline.
fn command_output(mut command: Command, input: Option<Vec<u8>>) -> Result<Vec<u8>> {
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = OwnedChild::spawn(&mut command)?;
    let stdout = child.child.stdout.take().ok_or(Failure::Process)?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    // Writer runs concurrently and is joined after the child is reaped on all paths.
    let writer = input.map(|bytes| {
        let stdin = child.child.stdin.take();
        std::thread::spawn(move || match stdin {
            Some(mut stdin) => stdin.write_all(&bytes),
            None => Err(std::io::Error::other("stdin missing")),
        })
    });
    let start = Instant::now();
    let status = loop {
        match child.child.try_wait() {
            Ok(Some(status)) => {
                child.reaped = true;
                break Ok(status);
            }
            Ok(None) if start.elapsed() < Duration::from_secs(60) => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => break Err(Failure::Timeout),
            Err(_) => break Err(Failure::Process),
        }
    };
    let stopped = child.stop();
    let bytes = reader
        .join()
        .map_err(|_| Failure::Process)?
        .map_err(|_| Failure::Io)?;
    if let Some(writer) = writer {
        writer
            .join()
            .map_err(|_| Failure::Process)?
            .map_err(|_| Failure::Io)?;
    }
    stopped?;
    if !status?.success() {
        return Err(Failure::Process);
    }
    if bytes.len() as u64 > LIMIT {
        return Err(Failure::Io);
    }
    Ok(bytes)
}

fn pg_command(tool: &str, database: &str) -> Result<Command> {
    if !matches!(database, "postgres" | "drill_source" | "drill_restored") {
        return Err(Failure::Input);
    }
    if !matches!(tool, "psql" | "pg_dump" | "pg_restore") {
        return Err(Failure::Input);
    }
    let mut command = clean_command(&format!("{PG_BIN}/{tool}"));
    command
        .env("PGHOST", "postgres")
        .env("PGPORT", "5432")
        .env("PGUSER", "postgres")
        .env("PGDATABASE", database)
        .env("PGCONNECT_TIMEOUT", "5")
        .env(
            "PGOPTIONS",
            "-c statement_timeout=45000 -c lock_timeout=5000 -c timezone=UTC -c bytea_output=hex",
        )
        .arg("--no-password");
    Ok(command)
}

fn sql(database: &str, statement: &str) -> Result<String> {
    let mut command = pg_command("psql", database)?;
    // SQL on stdin keeps response IDs and authentication-bearing SQL off argv.
    command.args(["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"]);
    let bytes = command_output(command, Some(statement.as_bytes().to_vec()))
        .map_err(|_| Failure::Database)?;
    String::from_utf8(bytes)
        .map(|s| s.trim().to_owned())
        .map_err(|_| Failure::Json)
}

fn snapshot_sql() -> String {
    let entries = known_tables().map(|table| format!(
        "'{table}', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) FROM public.{table} t)"
    )).collect::<Vec<_>>().join(",");
    format!("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT jsonb_build_object({entries}); COMMIT;")
}
fn snapshot(database: &str) -> Result<Value> {
    serde_json::from_str(&sql(database, &snapshot_sql())?).map_err(|_| Failure::Json)
}
fn snapshot_populated(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.len() == TABLES.len() + ENCRYPTED_TABLES.len())
        && TABLES.iter().all(|table| {
            value[*table]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
        })
        && encrypted_tables_empty(value)
}
fn encrypted_tables_empty(value: &Value) -> bool {
    ENCRYPTED_TABLES
        .iter()
        .all(|table| value[*table].as_array().is_some_and(|rows| rows.is_empty()))
}
fn exact_json(expected: &Value, actual: &Value) -> bool {
    expected == actual
}
fn status_matches(actual: Option<u16>, expected: u16) -> bool {
    actual == Some(expected)
}
fn attachment_matches(status: u16, bytes: &[u8]) -> bool {
    status == 200 && bytes == [0, 1, 254, 255]
}

fn item_fixture(title: &str) -> Value {
    json!({"title": title, "category": "LOGIN",
        "fields": [
            {"label": "username", "type": "STRING", "purpose": "USERNAME", "value": "synthetic-user"},
            {"label": "extra", "type": "STRING", "value": "日本語の追加欄"},
            {"label": "password", "type": "CONCEALED", "purpose": "PASSWORD", "value": "SyntheticItemOnly!"}
        ],
        "urls": [{"href": "https://example.invalid/one", "primary": true},
            {"href": "https://example.invalid/two", "primary": false}],
        "tags": ["synthetic", "restore"],
        "sections": [{"id": "synthetic-section", "label": "追加セクション"}]
    })
}

// A mandatory closed-service gate, also exercised by the omit-purge negative control.
fn reopen_state_clean(state: &Value) -> bool {
    ["sessions", "tokens", "memberships", "pending"]
        .iter()
        .all(|k| state[*k].as_u64() == Some(0))
        && state["current_password_matches"] == true
        && state["deleted_account_absent"] == true
}

fn sha256(input: Option<Vec<u8>>, file: Option<&Path>) -> Result<String> {
    let mut command = clean_command("/usr/bin/sha256sum");
    if let Some(path) = file {
        command.arg(path);
    }
    let raw = command_output(command, input)?;
    let text = String::from_utf8(raw).map_err(|_| Failure::Shape)?;
    let digest = text.split_whitespace().next().ok_or(Failure::Shape)?;
    if !is_hex(digest, 64) {
        return Err(Failure::Shape);
    }
    Ok(digest.to_ascii_lowercase())
}

struct Api {
    client: Client,
}
impl Api {
    fn new() -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| Failure::Http)?,
        })
    }
    fn request(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Option<&Value>,
        key: Option<&str>,
    ) -> Result<(u16, Vec<u8>)> {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(Failure::Input);
        }
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| Failure::Input)?;
        let mut request = self
            .client
            .request(method, format!("{BASE}{path}"))
            .header("X-PassShare-Client", "mobile");
        if !token.is_empty() {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(key) = key {
            request = request.header("Idempotency-Key", key);
        }
        let response = request.send().map_err(|_| Failure::Http)?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        response
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Failure::Http)?;
        if bytes.len() as u64 > LIMIT {
            return Err(Failure::Http);
        }
        Ok((status, bytes))
    }
    // Acceptance calls deliberately keep transport, expected status, and report
    // label together so every scenario states its full independent assertion.
    #[allow(clippy::too_many_arguments)]
    fn json(
        &self,
        report: &mut Report,
        name: &'static str,
        method: &str,
        path: &str,
        token: &str,
        body: Option<&Value>,
        expected: u16,
        key: Option<&str>,
    ) -> Result<Value> {
        let response = self.request(method, path, token, body, key);
        report.check(
            name,
            status_matches(response.as_ref().ok().map(|(status, _)| *status), expected),
        )?;
        let (_, bytes) = response?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        // Negative responses need only status; their bodies are discarded entirely.
        if expected >= 400 {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| Failure::Json)
    }
}

struct Runner {
    api: Api,
    node: Option<OwnedChild>,
    temporary: Temporary,
    source_created: bool,
    restored_created: bool,
}
impl Runner {
    fn new() -> Result<Self> {
        Ok(Self {
            api: Api::new()?,
            node: None,
            temporary: Temporary::create()?,
            source_created: false,
            restored_created: false,
        })
    }
    fn start_api(&mut self, database: &str, report: &mut Report, name: &'static str) -> Result<()> {
        if self.node.is_some() {
            return Err(Failure::Process);
        }
        let mut command = clean_command("/usr/local/bin/node");
        command
            .current_dir("/app")
            .arg("/app/src/index.js")
            .env("DATABASE_URL", database_url(database)?)
            .env("NODE_ENV", "production")
            .env("APP_ENV", "prd")
            .env("PORT", "8080")
            .env("TRUST_PROXY_HOPS", "0")
            .env("PASSSHARE_MUTATIONS_BIN", NATIVE)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        self.node = Some(OwnedChild::spawn(&mut command)?);
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if !self.node.as_mut().ok_or(Failure::Process)?.alive()? {
                break;
            }
            if let Ok((200, bytes)) = self.api.request("GET", "/health/db", "", None, None) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    if value["database"] == "connected" && value["environment"] == "prd" {
                        return report.check(name, true);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        report.check(name, false)
    }
    fn stop_api(&mut self, report: &mut Report, name: &'static str) -> Result<()> {
        self.node.as_mut().ok_or(Failure::Process)?.stop()?;
        self.node = None;
        // A 500/503 does not prove closure. Require a connection refusal after reaping.
        let refused = self
            .api
            .client
            .get(format!("{BASE}/health/db"))
            .send()
            .is_err_and(|e| e.is_connect());
        report.check(name, refused)
    }
    fn cleanup(&mut self, report: &mut Report) -> bool {
        let stopped = self.node.as_mut().map_or(Ok(()), OwnedChild::stop).is_ok();
        self.node = None;
        let _ = report.check("cleanup_node_reaped", stopped);
        let mut databases = true;
        // Only databases created successfully by this invocation can be removed.
        if self.restored_created {
            let removed = sql("postgres", "DROP DATABASE drill_restored WITH (FORCE);").is_ok();
            if removed {
                self.restored_created = false;
            }
            databases &= removed;
        }
        if self.source_created {
            let removed = sql("postgres", "DROP DATABASE drill_source WITH (FORCE);").is_ok();
            if removed {
                self.source_created = false;
            }
            databases &= removed;
        }
        let _ = report.check("cleanup_owned_synthetic_databases", databases);
        let files = self.temporary.cleanup().is_ok();
        let _ = report.check("cleanup_temporary_dump_removed", files);
        stopped && databases && files
    }
}

fn execute(report: &mut Report, inputs: &Inputs) -> Result<()> {
    let mut runner = Runner::new()?;
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runner.run(report, inputs)))
            .unwrap_or(Err(Failure::Panic));
    let cleanup = runner.cleanup(report);
    if !cleanup {
        return Err(Failure::Cleanup);
    }
    result
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() == 3 && args[1] == "--validate-report" {
        let mode = args[2].as_str();
        let mut bytes = Vec::new();
        let read = std::io::stdin().take(LIMIT + 1).read_to_end(&mut bytes);
        let valid = read.is_ok()
            && bytes.len() as u64 <= LIMIT
            && matches!(mode, "positive" | "negative")
            && serde_json::from_slice::<Value>(&bytes)
                .is_ok_and(|r| report_validation::validate(&r, mode == "negative"));
        std::process::exit(if valid { 0 } else { 1 });
    }
    // Panic diagnostics can contain input values; report only the static class.
    std::panic::set_hook(Box::new(|_| {}));
    let env = std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect::<Vec<_>>();
    let container = cfg!(target_os = "linux") && Path::new("/.dockerenv").is_file();
    let inputs = validate_inputs(std::env::args_os().count(), container, &env);
    let mut report = Report::new(inputs.as_ref().ok());
    let result = match inputs {
        Ok(inputs) => execute(&mut report, &inputs),
        Err(error) => Err(error),
    };
    let encoded = report.json(result.is_ok(), result.err());
    let mut stdout = std::io::stdout().lock();
    let written = serde_json::to_writer(&mut stdout, &encoded).is_ok()
        && stdout.write_all(b"\n").is_ok()
        && stdout.flush().is_ok();
    std::process::exit(if result.is_ok() && written { 0 } else { 1 });
}
