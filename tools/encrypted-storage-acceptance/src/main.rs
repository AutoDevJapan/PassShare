//! Separate client-side Core/host contract acceptance; run via the Cargo gate.
//! Owns a disposable Docker PostgreSQL and
//! real Express host. No production configuration, model API or secret files.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
mod account_identity;
mod local_postgres;
mod sharing_rotation;
use passshare_connect::{
    AccountIdentityBundle, EncryptedSessionClient, InitialGrantRequest, SharedKeyExpectation,
    SharingRotationClient,
};
use passshare_core::cloud_crypto::{AccountIdentity, AccountIdentityContext, SharedKeyContext};
use passshare_core::{
    cloud_crypto::{ItemContext, OwnerKeyContext, PasswordBoxKey, WrappedPasswordBoxKey},
    crypto::{derive_master_key_with_params, generate_salt, MasterKey},
    ConnectId, PassShareError,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

mod go_session;

// Usage: <production-native-binary> OR --image <prebuilt-production-image>.
// Both modes require the preloaded pinned PostgreSQL image. Supplied images are never
// mounted over or removed by the tool; the caller owns its build/tag lifecycle.
const POSTGRES_IMAGE: &str =
    "mirror.gcr.io/library/postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
static CLEANUP_FAILED: AtomicBool = AtomicBool::new(false);

enum Mode {
    Node(PathBuf),
    Image(String),
}
impl Mode {
    fn parse(args: &[std::ffi::OsString]) -> Result<Self, &'static str> {
        match args {
            [flag, image] if flag == "--image" => {
                let image = image.to_str().ok_or("image tag must be ASCII")?;
                if image.is_empty()
                    || image.starts_with('-')
                    || !image
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"/._-:@".contains(&b))
                {
                    return Err("invalid image tag");
                }
                Ok(Self::Image(image.to_owned()))
            }
            [binary] if !binary.to_string_lossy().starts_with('-') => Ok(Self::Node(binary.into())),
            _ => Err("usage: <production-native-binary> OR --image <prebuilt-production-image>"),
        }
    }
    fn label(&self) -> &'static str {
        match self {
            Self::Node(_) => "node",
            Self::Image(_) => "image",
        }
    }
}

fn docker_ok(args: &[&str], operation: &str) {
    assert!(
        command("docker")
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success()),
        "{operation} failed"
    );
}
fn cleanup(args: &[&str]) {
    if !command("docker")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
    {
        CLEANUP_FAILED.store(true, Ordering::SeqCst);
        eprintln!("owned Docker resource cleanup failed");
    }
}
struct Network {
    name: String,
}
impl Network {
    fn start() -> Self {
        let network = Self {
            name: format!(
                "passshare1163-encrypted-net-{}",
                ConnectId::generate().unwrap()
            ),
        };
        docker_ok(
            &[
                "network",
                "create",
                "--driver",
                "bridge",
                "--label",
                "passshare.todo=1163",
                "--label",
                "passshare.fixture=encrypted-storage",
                &network.name,
            ],
            "create owned bridge network",
        );
        network
    }
}
impl Drop for Network {
    fn drop(&mut self) {
        if !self.name.is_empty() {
            cleanup(&["network", "rm", &self.name]);
        }
    }
}

fn command(program: &str) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    }
    #[cfg(not(windows))]
    command
}
fn port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
struct Database {
    name: String,
    port: u16,
    local: Option<local_postgres::LocalPostgres>,
    // Caller-owned provenance, never inferred from a dumped public table.
    fixture_owner_id: String,
    fixture_purpose: &'static str,
}
impl Database {
    fn start(network: &Network) -> Self {
        Self::start_owned(network, "source")
    }
    fn start_owned(network: &Network, purpose: &'static str) -> Self {
        assert!(matches!(purpose, "source" | "restore"));
        let random = checked(MasterKey::generate(), "fixture owner entropy");
        let owner = random.as_bytes()[..16]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let db = Self {
            name: format!("passshare1163-encrypted-{}", ConnectId::generate().unwrap()),
            port: port(),
            local: None,
            fixture_owner_id: owner,
            fixture_purpose: purpose,
        };
        let status = command("docker")
            .args([
                "run",
                "--detach",
                "--name",
                &db.name,
                "--pull=never",
                "--network",
                &network.name,
                "--label",
                "passshare.todo=1163",
                "--label",
                "passshare.fixture=encrypted-storage",
                "--publish",
                &format!("127.0.0.1:{}:5432", db.port),
                "--env",
                "POSTGRES_USER=passshare",
                "--env",
                "POSTGRES_PASSWORD=passshare",
                "--env",
                "POSTGRES_DB=passshare",
                POSTGRES_IMAGE,
            ])
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "start isolated PostgreSQL");
        let ready = (0..150).any(|_| {
            let mut probe = command("docker")
                .args([
                    "exec",
                    "--env",
                    "PGPASSWORD=passshare",
                    "--env",
                    "PGCONNECT_TIMEOUT=2",
                    "--env",
                    "PGOPTIONS=-c statement_timeout=2000",
                    &db.name,
                    // The initialization server accepts socket connections
                    // before the selected database exists. Require its final
                    // TCP listener and a successful query in the actual DB.
                    "psql",
                    "-h",
                    "127.0.0.1",
                    "-X",
                    "-w",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-U",
                    "passshare",
                    "-c",
                    "SELECT 1",
                    "-d",
                    "passshare",
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("PostgreSQL readiness probe launch");
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let ready = loop {
                if let Some(status) = probe.try_wait().expect("PostgreSQL readiness probe wait") {
                    break status.success();
                }
                if std::time::Instant::now() >= deadline {
                    let _ = probe.kill();
                    if !reap_before(
                        &mut probe,
                        std::time::Instant::now() + Duration::from_secs(2),
                    ) {
                        CLEANUP_FAILED.store(true, Ordering::SeqCst);
                    }
                    break false;
                }
                thread::sleep(Duration::from_millis(10));
            };
            if !ready {
                thread::sleep(Duration::from_millis(100));
            }
            ready
        });
        assert!(ready, "PostgreSQL readiness");
        // Only this constructor may initialize a fresh Docker-owned database.
        // The catalog marker is outside the whole-public archive.
        assert!(db.sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'") == "0");
        db.sql(&format!(
            "COMMENT ON DATABASE passshare IS '{}'",
            db.catalog_marker()
        ));
        assert!(db.owned(), "created database ownership/purpose");
        if purpose == "source" {
            db.sql(&format!("CREATE TABLE public.passshare_fixture_owner(owner_id text PRIMARY KEY); INSERT INTO public.passshare_fixture_owner VALUES('{}')", db.fixture_owner_id));
            assert!(db.fixture_marker_matches(&db.fixture_owner_id));
        }
        db
    }
    fn from_local(local: local_postgres::LocalPostgres, purpose: &'static str) -> Self {
        assert!(matches!(purpose, "source" | "restore"));
        let db = Self {
            name: local.database.clone(),
            port: local.port,
            fixture_owner_id: local.ownership_id.clone(),
            fixture_purpose: purpose,
            local: Some(local),
        };
        assert!(db.owned(), "local database ownership/purpose");
        if purpose == "source" {
            assert!(db.fixture_marker_matches(&db.fixture_owner_id));
        }
        db
    }
    fn catalog_marker(&self) -> String {
        if self.local.is_some() {
            format!(
                "passshare-acceptance:{}:acceptance-{}:{}",
                self.fixture_owner_id, self.fixture_purpose, self.name
            )
        } else {
            format!(
                "passshare-acceptance:{}:{}:{}:{}",
                self.fixture_owner_id, self.fixture_purpose, self.name, self.port
            )
        }
    }
    fn owned(&self) -> bool {
        if !(self.fixture_owner_id.len() == 32
            && self.fixture_owner_id.bytes().all(|c| c.is_ascii_hexdigit())
            && matches!(self.fixture_purpose, "source" | "restore")
            && self
                .name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            && if self.local.is_some() {
                self.name.starts_with("passshare1163_")
            } else {
                self.name.starts_with("passshare1163-encrypted-")
            })
        {
            return false;
        }
        if let Some(local) = &self.local {
            if self.name != local.database
                || self.port != local.port
                || self.fixture_owner_id != local.ownership_id
            {
                return false;
            }
        }
        let database = self
            .local
            .as_ref()
            .map_or("passshare", |l| l.database.as_str());
        let marker = self.catalog_marker();
        self.sql(&format!("SELECT count(*)=1 FROM pg_database d WHERE datname=current_database() AND datname='{database}' AND datdba=(SELECT oid FROM pg_roles WHERE rolname='passshare') AND shobj_description(d.oid,'pg_database')='{marker}'")) == "t"
    }
    fn fixture_marker_matches(&self, expected: &str) -> bool {
        if !(expected.len() == 32 && expected.bytes().all(|c| c.is_ascii_hexdigit())) {
            return false;
        }
        // Validate the exact ordinary table/column/primary-key shape before
        // selecting caller-untrusted rows. Missing/malformed markers fail closed.
        if self.sql("SELECT count(*)=1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='passshare_fixture_owner' AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid) AND (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=1 AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum=1 AND a.attname='owner_id' AND a.atttypid='text'::regtype AND a.attnotnull AND NOT a.attisdropped) AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid=c.oid)=1 AND EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p' AND k.conkey=ARRAY[1]::smallint[])") != "t" {
            return false;
        }
        self.sql(&format!("SELECT count(*)=1 AND COALESCE(bool_and(owner_id='{expected}'),false) FROM public.passshare_fixture_owner")) == "t"
    }
    #[track_caller]
    fn sql(&self, sql: &str) -> String {
        self.sql_before(sql, std::time::Instant::now() + Duration::from_secs(15))
    }
    #[track_caller]
    fn sql_before(&self, sql: &str, deadline: std::time::Instant) -> String {
        let mut cmd = self.psql(true, None);
        // SQLSTATE is safe diagnostic metadata; verbose text is never logged.
        cmd.args(["-f", "-", "-v", "ECHO=none", "-v", "VERBOSITY=verbose"]);
        match fixture_sql(cmd, sql, deadline) {
            Ok(value) => value,
            Err(reason) => panic!("fixture SQL {reason}"),
        }
    }
    fn psql(&self, interactive: bool, label: Option<&str>) -> Command {
        let mut c = if let Some(local) = &self.local {
            local.client()
        } else {
            let mut c = command("docker");
            c.arg("exec");
            if interactive {
                c.arg("-i");
            }
            if let Some(label) = label {
                c.args(["--env", &format!("PGAPPNAME={label}")]);
            }
            c.args([
                &self.name,
                "psql",
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                "passshare",
                "-d",
                "passshare",
            ]);
            c
        };
        if let Some(label) = label {
            c.env("PGAPPNAME", label);
        }
        c
    }
    fn url(&self) -> String {
        let name = self
            .local
            .as_ref()
            .map_or("passshare", |p| p.database.as_str());
        format!(
            "postgresql://passshare:passshare@127.0.0.1:{}/{name}",
            self.port
        )
    }
}

struct SqlChild(Child);
impl Drop for SqlChild {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            if !reap_before(
                &mut self.0,
                std::time::Instant::now() + Duration::from_secs(2),
            ) {
                CLEANUP_FAILED.store(true, Ordering::SeqCst);
            }
        }
    }
}

// Only SQLSTATE and schema-owned identifiers may leave PostgreSQL stderr.
// Never report arbitrary quoted names, function arguments, SQL or row values.
fn sql_error_metadata(diagnostic: &str) -> Vec<(String, Option<String>)> {
    const SCHEMA: &str = passshare_mutations::encrypted::SCHEMA;
    diagnostic
        .lines()
        .filter_map(|line| {
            let (_, error) = line.split_once("ERROR:  ")?;
            let (code, message) = error.split_once(": ")?;
            if code.len() != 5
                || !code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            {
                return None;
            }
            let name = match code {
                "42P01" => message
                    .strip_prefix("relation \"")
                    .and_then(|m| m.strip_suffix("\" does not exist")),
                "42883" => message
                    .strip_prefix("function ")
                    .and_then(|m| m.split_once('(').map(|(name, _)| name)),
                _ => None,
            };
            let dependency = name
                .map(|n| n.strip_prefix("public.").unwrap_or(n))
                .filter(|name| {
                    *name == "passshare_fixture_owner"
                        || SCHEMA.lines().any(|line| {
                            line.strip_prefix("CREATE TABLE IF NOT EXISTS ")
                                .or_else(|| line.strip_prefix("CREATE OR REPLACE FUNCTION "))
                                .and_then(|definition| definition.split([' ', '(']).next())
                                == Some(*name)
                        })
                })
                .map(str::to_owned);
            Some((code.to_owned(), dependency))
        })
        .collect()
}

// -f alone splits statements and changes the former single -c transaction/result
// semantics. One gexec cell sends the ENTIRE SQL literally as one server request.
// Base64 keeps quotes, newlines, dollar bodies and backslashes out of psql's lexer.
// Audited callers include explicit BEGIN/COMMIT/ROLLBACK and multi-statement DDL;
// CREATE/DROP DATABASE use the separate local fixture control, without wrapping.
fn fixture_sql(
    mut cmd: Command,
    sql: &str,
    deadline: std::time::Instant,
) -> Result<String, &'static str> {
    const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
    if std::time::Instant::now() >= deadline {
        return Err("exceeded its deadline");
    }
    let input = format!(
        "SELECT pg_catalog.convert_from(pg_catalog.decode('{}','base64'),'UTF8') \\gexec\n",
        BASE64.encode(sql)
    );
    if std::time::Instant::now() >= deadline {
        return Err("exceeded its deadline");
    }
    let mut child = SqlChild(
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "launch failed")?,
    );
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut workers = Vec::new();
    let mut stdin = child.0.stdin.take().unwrap();
    let writer_sender = sender.clone();
    workers.push(thread::spawn(move || {
        let result = stdin.write_all(input.as_bytes());
        drop(stdin); // EOF is part of completion, not deferred until after wait.
        let _ = writer_sender.send((0, result.map(|_| 0), Vec::new()));
    }));
    for (kind, pipe) in [
        (
            1,
            Box::new(child.0.stdout.take().unwrap()) as Box<dyn Read + Send>,
        ),
        (
            2,
            Box::new(child.0.stderr.take().unwrap()) as Box<dyn Read + Send>,
        ),
    ] {
        let sender = sender.clone();
        workers.push(thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take(OUTPUT_LIMIT as u64 + 1).read_to_end(&mut bytes);
            let _ = sender.send((kind, result, bytes));
        }));
    }
    drop(sender);
    let mut status = None;
    let mut output = Vec::new();
    let mut events = 0;
    let mut failure = "failed category=other";
    loop {
        if std::time::Instant::now() >= deadline {
            return Err("exceeded its deadline");
        }
        if status.is_none() {
            status = child.0.try_wait().map_err(|_| "child wait failed")?;
        }
        while let Ok((kind, result, bytes)) = receiver.try_recv() {
            result.map_err(|_| {
                if kind == 0 {
                    "input write failed"
                } else {
                    "output read failed"
                }
            })?;
            if bytes.len() > OUTPUT_LIMIT {
                return Err("output exceeded bound");
            }
            events += 1;
            if kind == 1 {
                output = bytes;
            } else if kind == 2 {
                // PostgreSQL diagnostics can contain SQL/row values. Classify only.
                let diagnostic = String::from_utf8_lossy(&bytes);
                for (code, dependency) in sql_error_metadata(&diagnostic) {
                    eprintln!(
                        "fixture SQL SQLSTATE={code} dependency={}",
                        dependency.as_deref().unwrap_or("suppressed")
                    );
                }
                if diagnostic.contains("canceling statement due to statement timeout") {
                    failure = "failed category=statement_timeout";
                } else if diagnostic.contains("does not exist") {
                    failure = "failed category=missing_dependency";
                } else if diagnostic.contains("could not connect")
                    || diagnostic.contains("connection refused")
                {
                    failure = "failed category=connection_unavailable";
                } else if diagnostic.contains("server closed the connection unexpectedly") {
                    failure = "failed category=server_closed_connection";
                } else if diagnostic.contains("could not receive data from server") {
                    failure = "failed category=receive_connection_lost";
                } else if diagnostic.contains("could not send data to server") {
                    failure = "failed category=send_connection_lost";
                } else if diagnostic.contains("terminating connection due to administrator command")
                {
                    failure = "failed category=administrator_termination";
                } else if diagnostic.contains("could not create shared memory segment") {
                    failure = "failed category=shared_memory_creation";
                } else if diagnostic.contains("could not fork new process") {
                    failure = "failed category=server_process_creation";
                } else if diagnostic.contains("too many clients")
                    || diagnostic.contains("remaining connection slots")
                {
                    failure = "failed category=connections_exhausted";
                } else {
                    for (code, category) in [
                        ("55P03", "failed category=lock_timeout"),
                        ("40P01", "failed category=deadlock"),
                        ("42601", "failed category=syntax_error"),
                        ("22021", "failed category=invalid_encoding"),
                        ("22012", "failed category=division_by_zero"),
                        ("53100", "failed category=disk_full"),
                        ("53200", "failed category=out_of_memory"),
                        ("53300", "failed category=connections_exhausted"),
                        ("55006", "failed category=object_in_use"),
                        ("42501", "failed category=permission_denied"),
                        ("XX000", "failed category=internal_error"),
                    ] {
                        if diagnostic.contains(&format!("ERROR:  {code}:"))
                            || diagnostic.contains(&format!("FATAL:  {code}:"))
                        {
                            failure = category;
                            break;
                        }
                    }
                }
                if failure == "failed category=other" && !diagnostic.is_empty() {
                    // Diagnostic values may be secret. Emit only its byte count
                    // and canonical SQLSTATE tokens immediately after severity.
                    let fields = diagnostic.split_ascii_whitespace().collect::<Vec<_>>();
                    let codes = fields
                        .windows(2)
                        .filter(|w| matches!(w[0], "ERROR:" | "FATAL:"))
                        .filter_map(|w| w[1].strip_suffix(':'))
                        .filter(|code| {
                            code.len() == 5
                                && code
                                    .bytes()
                                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
                        })
                        .collect::<Vec<_>>();
                    eprintln!(
                        "fixture SQL diagnostic bytes={} SQLSTATE={codes:?}",
                        bytes.len()
                    );
                }
            }
        }
        // Even after a worker sends its event it may not have returned yet.
        // Join only finished workers; never introduce an unbounded writer join.
        if status.is_some() && events == 3 && workers.iter().all(|w| w.is_finished()) {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    for worker in workers {
        worker.join().map_err(|_| "I/O worker failed")?;
    }
    if !status.unwrap().success() {
        // Preserve safe process metadata for fixture startup/OS failures that
        // do not produce PostgreSQL SQLSTATE diagnostics. Never print stderr.
        if failure == "control rejected or exceeded output bound"
            || failure == "failed category=other"
        {
            eprintln!("fixture SQL nonzero exit={:?}", status.unwrap().code());
        }
        return Err(failure);
    }
    let output = String::from_utf8(output)
        .map_err(|_| "output encoding failed")?
        .trim()
        .to_owned();
    if std::time::Instant::now() >= deadline {
        return Err("exceeded its deadline");
    }
    Ok(output)
}
impl Drop for Database {
    fn drop(&mut self) {
        if self.local.is_none() {
            cleanup(&["rm", "--force", "--volumes", &self.name]);
        }
    }
}
enum HostProcess {
    Node(Child),
    Container(String),
}
struct Host {
    process: HostProcess,
    port: u16,
}
impl Host {
    fn start(db: &Database, network: &Network, mode: &Mode) -> Self {
        Self::with_storage(db, network, mode, true)
    }
    fn with_storage(db: &Database, network: &Network, mode: &Mode, enabled: bool) -> Self {
        let port = port();
        let host = match mode {
            Mode::Image(image) => {
                let host = Self {
                    process: HostProcess::Container(format!(
                        "passshare1163-encrypted-api-{}",
                        ConnectId::generate().unwrap()
                    )),
                    port,
                };
                let HostProcess::Container(name) = &host.process else {
                    unreachable!()
                };
                // All values are separate CLI arguments. No shell interpolation,
                // host native mount, native ENV override, or external secrets.
                docker_ok(
                    &[
                        "run",
                        "--detach",
                        "--name",
                        name,
                        "--pull=never",
                        "--network",
                        &network.name,
                        "--label",
                        "passshare.todo=1163",
                        "--label",
                        "passshare.fixture=encrypted-storage",
                        "--publish",
                        &format!("127.0.0.1:{port}:8080"),
                        "--env",
                        "APP_ENV=test",
                        "--env",
                        "DEV_SEED=false",
                        "--env",
                        if enabled {
                            "PASSSHARE_ENCRYPTED_STORAGE=true"
                        } else {
                            "PASSSHARE_ENCRYPTED_STORAGE=false"
                        },
                        "--env",
                        "PORT=8080",
                        "--env",
                        &format!(
                            "DATABASE_URL=postgresql://passshare:passshare@{}:5432/passshare",
                            db.name
                        ),
                        "--env",
                        &format!("DATABASE_TRUSTED_PRIVATE_HOSTS={}", db.name),
                        image,
                    ],
                    "start owned production API image",
                );
                host
            }
            Mode::Node(binary) => Self::start_node(db, binary, port, enabled),
        };
        // Published container ports can accept TCP before the application has
        // completed migrations. Observe HTTP health from the real entrypoint.
        assert!(
            (0..200).any(|_| {
                if ready(port) {
                    true
                } else {
                    thread::sleep(Duration::from_millis(100));
                    false
                }
            }),
            "formal API HTTP readiness"
        );
        host
    }
    fn start_node(db: &Database, binary: &std::path::Path, port: u16, enabled: bool) -> Self {
        let backend = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("backend");
        let mut cmd = command("node");
        cmd.env_clear();
        for key in ["PATH", "SystemRoot", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        let child = cmd
            .arg("src/index.js")
            .current_dir(backend)
            .env("PORT", port.to_string())
            .env("APP_ENV", "test")
            .env("DEV_SEED", "false")
            .env("PASSSHARE_MUTATIONS_BIN", binary)
            .env(
                "PASSSHARE_ENCRYPTED_STORAGE",
                if enabled { "true" } else { "false" },
            )
            .env("DATABASE_URL", db.url())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self {
            process: HostProcess::Node(child),
            port,
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        match &mut self.process {
            HostProcess::Node(child) => {
                let _ = child.kill();
                if !reap_before(child, std::time::Instant::now() + Duration::from_secs(2)) {
                    CLEANUP_FAILED.store(true, Ordering::SeqCst);
                }
            }
            HostProcess::Container(name) => cleanup(&["rm", "--force", "--volumes", name]),
        }
    }
}
fn ready(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(500),
    ) else {
        return false;
    };
    if stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .is_err()
        || stream
            .set_write_timeout(Some(Duration::from_millis(500)))
            .is_err()
        || write!(
            stream,
            "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        )
        .is_err()
    {
        return false;
    }
    let mut bytes = Vec::new();
    if stream.take(65536).read_to_end(&mut bytes).is_err() {
        return false;
    }
    let Some(split) = bytes.windows(4).position(|p| p == b"\r\n\r\n") else {
        return false;
    };
    std::str::from_utf8(&bytes[..split]).is_ok_and(|headers| {
        headers
            .lines()
            .next()
            .is_some_and(|h| h.split_whitespace().nth(1) == Some("200"))
    }) && serde_json::from_slice::<Value>(&bytes[split + 4..])
        .is_ok_and(|body| body["status"] == "ok")
}
fn http(port: u16, method: &str, path: &str, headers: &str, body: &Value) -> (u16, Value) {
    let (status, bytes) = http_bytes(port, method, path, headers, body);
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, body)
}
fn http_bytes(port: u16, method: &str, path: &str, headers: &str, body: &Value) -> (u16, Vec<u8>) {
    let payload = if body.is_null() {
        String::new()
    } else {
        body.to_string()
    };
    http_payload(port, method, path, headers, &payload)
}
fn http_payload(
    port: u16,
    method: &str,
    path: &str,
    headers: &str,
    payload: &str,
) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    write!(stream,"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\n\r\n{payload}",payload.len()).unwrap();
    let mut bytes = Vec::new();
    stream
        .take(4 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .unwrap();
    let split = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let header = std::str::from_utf8(&bytes[..split]).unwrap();
    let status = header
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, bytes[split + 4..].to_vec())
}
fn signup(port: u16) -> (String, String, String) {
    let (refresh, connect, box_id, _) = signup_with_password(port);
    (refresh, connect, box_id)
}
fn signup_with_password(port: u16) -> (String, String, String, String) {
    let password = format!("{}Aa!", ConnectId::generate().unwrap());
    let (status, session) = http(
        port,
        "POST",
        "/api/auth/signup",
        "x-passshare-client: mobile\r\n",
        &json!({"email":format!("{}@example.test",ConnectId::generate().unwrap()),"password":password}),
    );
    assert_eq!(status, 201, "synthetic signup");
    let connect = session["connectAccessToken"].as_str().unwrap().to_owned();
    let refresh = session["refreshToken"].as_str().unwrap().to_owned();
    let (status, boxes) = http(
        port,
        "GET",
        "/v1/vaults",
        &format!("Authorization: Bearer {connect}\r\n"),
        &Value::Null,
    );
    assert_eq!(status, 200);
    (
        refresh,
        connect,
        boxes[0]["id"].as_str().unwrap().to_owned(),
        password,
    )
}
// Client-side owner key bundle, as packages/cloud-wasm builds it: a fixed
// Format-1 Argon2id costs are fixed independently of Core defaults.
// The password, salt-derived
// master key and raw box key stay in this process; the server sees the bundle only.
fn owner_context(box_id: &str, owner: &str, epoch: u64) -> OwnerKeyContext {
    serde_json::from_value(json!({"passwordBoxId":box_id,"ownerAccountId":owner,"keyEpoch":epoch}))
        .unwrap()
}
fn owner_master(password: &str, salt: &[u8]) -> Result<MasterKey, PassShareError> {
    derive_master_key_with_params(password, salt, 65_536, 3, 4)
}
fn owner_bundle(
    key: &PasswordBoxKey,
    master: &MasterKey,
    salt: [u8; 16],
    context: &OwnerKeyContext,
) -> Value {
    json!({"format":1,"salt":BASE64.encode(salt),
        "wrapped":key.wrap_for_owner(master,context).unwrap()})
}
// Re-derives the master key from the FETCHED salt, as a fresh client would.
fn unwrap_bundle(
    bundle: &Value,
    password: &str,
    context: &OwnerKeyContext,
) -> Result<PasswordBoxKey, PassShareError> {
    let salt = BASE64.decode(bundle["salt"].as_str().unwrap()).unwrap();
    let master = owner_master(password, &salt)?;
    let wrapped: WrappedPasswordBoxKey = serde_json::from_value(bundle["wrapped"].clone()).unwrap();
    PasswordBoxKey::unwrap_for_owner(&wrapped, &master, context)
        .map_err(|_| PassShareError::CorruptFile)
}

fn acceptance_result<T, E>(result: Result<T, E>, step: &str) -> T {
    result.unwrap_or_else(|_| {
        panic!("encrypted storage acceptance: {step} failed (details suppressed)")
    })
}

// Reuse existing registrations and session transports. Pins originate in Core,
// before any identity response; neither invitation proof nor HTTP establishes them.
struct AcceptanceIdentity {
    id: String,
    email: String,
    identity: AccountIdentity,
    sdk: EncryptedSessionClient,
}
impl AcceptanceIdentity {
    fn register(
        p: u16,
        rt: &tokio::runtime::Runtime,
        session: &str,
        sdk: &EncryptedSessionClient,
        login_password: &str,
    ) -> Self {
        let (status, me) = http(
            p,
            "GET",
            "/api/auth/me",
            &format!("Authorization: Bearer {session}\r\n"),
            &Value::Null,
        );
        assert_eq!(status, 200);
        let id = me["user"]["id"].as_str().unwrap().to_owned();
        let email = me["user"]["email"].as_str().unwrap().to_owned();
        let context: AccountIdentityContext = acceptance_result(
            serde_json::from_value(json!({"accountId":id,"identityVersion":1})),
            "identity context",
        );
        let identity = acceptance_result(
            AccountIdentity::generate(context),
            "Core identity generation",
        );
        let pin = identity.public_identity();
        let password = BASE64.encode(acceptance_result(generate_salt(), "identity password"));
        assert!(password != login_password);
        let salt = acceptance_result(generate_salt(), "identity salt");
        let master = acceptance_result(owner_master(&password, &salt), "identity KDF");
        let bundle = acceptance_result(
            AccountIdentityBundle::new(
                BASE64.encode(salt),
                acceptance_result(identity.wrap(&master), "Core identity wrap"),
            ),
            "identity bundle",
        );
        let stored = acceptance_result(
            rt.block_on(sdk.put_account_identity(0, &pin, &bundle, None)),
            "identity PUT",
        );
        // AccountIdentityRecord is Deserialize-only: compare its exact wire fields.
        assert!(
            json!({"bundleVersion":stored.bundle_version,"identity":stored.identity,"bundle":stored.bundle})
                == json!({"bundleVersion":1,"identity":pin,"bundle":bundle})
        );
        let fetched = acceptance_result(
            rt.block_on(sdk.get_account_identity(identity.context(), &pin.key_id)),
            "pinned identity GET",
        );
        assert!(fetched == stored);
        let restored = acceptance_result(
            AccountIdentity::unwrap(
                &fetched.bundle.wrapped,
                &master,
                identity.context(),
                &pin.key_id,
            ),
            "pinned Core identity unwrap",
        );
        assert!(restored.public_identity() == pin);
        Self {
            id,
            email,
            identity,
            sdk: sdk.clone(),
        }
    }
}

fn confirm_acceptance_member(
    p: u16,
    box_id: &str,
    owner_headers: &str,
    member_headers: &str,
    email: &str,
) {
    let (status, invitation) = http(
        p,
        "POST",
        &format!("/api/auth/vaults/{box_id}/invitations"),
        owner_headers,
        &json!({"email":email,"role":"member"}),
    );
    assert_eq!(status, 201, "formal invitation creation");
    // Deliver the owner-obtained proof inside the client fixture, without logging it.
    assert_eq!(
        http(
            p,
            "POST",
            &format!(
                "/api/auth/invitations/{}/accept",
                invitation["id"].as_str().unwrap()
            ),
            member_headers,
            &json!({"confirmationCode":invitation["confirmationCode"]})
        )
        .0,
        200,
        "formal proof-confirmed membership"
    );
}

fn acceptance_state_hash(db: &Database) -> String {
    // Every full account/box row and xmin, across ALL boxes, including stages.
    // Request-throttle bookkeeping is not stored account/box state.
    let tables = [
        "users",
        "sessions",
        "connect_vaults",
        "connect_items",
        "connect_item_files",
        "vault_memberships",
        "vault_invitations",
        "connect_tokens",
        "encrypted_box_state",
        "encrypted_owner_keys",
        "encrypted_key_grants",
        "encrypted_items",
        "encrypted_attachments",
        "encrypted_attachment_tombstones",
        "encrypted_item_tombstones",
        "encrypted_account_identities",
        "encrypted_rotations",
        "encrypted_rotation_items",
        "encrypted_rotation_grants",
        "encrypted_rotation_attachments",
        "encrypted_migration_sources",
        "encrypted_migrations",
        "encrypted_migration_items",
        "encrypted_migration_files",
    ];
    let parts: Vec<_> = tables.iter().map(|t| format!("SELECT '{t}' AS name, COALESCE(string_agg(md5(jsonb_build_object('row',to_jsonb(r),'xmin',r.xmin::text)::text),',' ORDER BY md5(jsonb_build_object('row',to_jsonb(r),'xmin',r.xmin::text)::text)),'') AS digest FROM {t} r")).collect();
    db.sql(&format!(
        "SELECT md5(string_agg(name||':'||digest,'|' ORDER BY name)) FROM ({}) fixture_rows",
        parts.join(" UNION ALL ")
    ))
}

fn grant_acceptance_member(
    db: &Database,
    rt: &tokio::runtime::Runtime,
    box_id: &str,
    key: &PasswordBoxKey,
    owner: &AcceptanceIdentity,
    member: &AcceptanceIdentity,
) -> PasswordBoxKey {
    let sender = owner.identity.public_identity();
    let recipient = member.identity.public_identity();
    assert!(
        acceptance_result(
            rt.block_on(owner.sdk.get_member_identity(box_id, &recipient)),
            "pinned recipient GET"
        ) == recipient
    );
    assert!(
        acceptance_result(
            rt.block_on(member.sdk.get_member_identity(box_id, &sender)),
            "pinned sender GET"
        ) == sender
    );
    let sharing = SharingRotationClient::new(&owner.sdk);
    let snapshot = acceptance_result(
        rt.block_on(sharing.sharing_snapshot(box_id, &owner.id)),
        "sharing snapshot",
    );
    assert_eq!(snapshot.key_epoch, 1);
    let context = SharedKeyContext {
        password_box_id: box_id.parse().unwrap(),
        sender_account_id: sender.account_id,
        recipient_account_id: recipient.account_id,
        key_epoch: 1,
        sender_identity_version: sender.identity_version,
        recipient_identity_version: recipient.identity_version,
        sender_key_id: sender.key_id.clone(),
        recipient_key_id: recipient.key_id.clone(),
    };
    let envelope = acceptance_result(
        key.wrap_for_recipient(&owner.identity, &recipient, &context),
        "Core HPKE grant",
    );
    let expected = SharedKeyExpectation {
        context,
        sender,
        recipient,
    };
    let request = InitialGrantRequest {
        expected_state_revision: snapshot.state_revision,
        key_epoch: 1,
        expected_version: 0,
        envelope,
    };
    let stored = acceptance_result(
        rt.block_on(sharing.put_initial_grant(box_id, &member.id, &request, &expected)),
        "initial grant PUT",
    );
    assert!(
        stored.envelope == request.envelope && stored.grant_version == 1 && stored.key_epoch == 1
    );
    let before = acceptance_state_hash(db);
    let replay = acceptance_result(
        rt.block_on(sharing.put_initial_grant(box_id, &member.id, &request, &expected)),
        "initial grant replay",
    );
    assert!(replay == stored);
    let fetched = acceptance_result(
        rt.block_on(SharingRotationClient::new(&member.sdk).get_self_grant(box_id, &expected)),
        "pinned self grant GET",
    );
    assert!(
        fetched.envelope == request.envelope
            && fetched.grant_version == 1
            && fetched.key_epoch == 1
    );
    assert_eq!(
        acceptance_state_hash(db),
        before,
        "grant replay and reads preserve all rows/xmin"
    );
    acceptance_result(
        PasswordBoxKey::unwrap_for_recipient(
            &fetched.envelope,
            &member.identity,
            &expected.sender,
            &expected.context,
        ),
        "Core HPKE grant unwrap",
    )
}

// Validate fixture exclusivity before any filesystem inspection or Docker call.
fn fixture_prefix(
    args: &[std::ffi::OsString],
) -> Result<(bool, bool, &[std::ffi::OsString]), &'static str> {
    let flags = ["--account-identity", "--sharing-rotation", "--go-session"];
    let count = args
        .iter()
        .filter(|arg| {
            flags
                .iter()
                .any(|flag| arg.as_os_str() == std::ffi::OsStr::new(flag))
        })
        .count();
    if count > 1 {
        return Err("fixture modes are mutually exclusive");
    }
    let identity = args.first().is_some_and(|arg| arg == "--account-identity");
    let sharing = args.first().is_some_and(|arg| arg == "--sharing-rotation");
    if count == 1
        && !args.first().is_some_and(|arg| {
            flags
                .iter()
                .any(|flag| arg.as_os_str() == std::ffi::OsStr::new(flag))
        })
    {
        return Err("fixture flag must be first");
    }
    Ok((
        identity,
        sharing,
        if identity || sharing {
            &args[1..]
        } else {
            args
        },
    ))
}

fn main() {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let (local_manifest, args) =
        local_postgres::prefix(&args).expect("explicit local fixture prefix");
    let attachment_fixture = args.first().is_some_and(|a| a == "--encrypted-attachments");
    let migration_fixture = args.first().is_some_and(|a| a == "--encrypted-migration");
    let args = if attachment_fixture || migration_fixture {
        &args[1..]
    } else {
        args
    };
    let (restore_fixture, args) = sharing_rotation::encrypted_restore::prefix(args)
        .expect("explicit encrypted restore fixture prefix");
    let legacy_expiry = args.first().is_some_and(|a| a == "--legacy-expiry");
    let args = if legacy_expiry {
        assert!(
            !args[1..].iter().any(|a| [
                "--legacy-expiry",
                "--sharing-rotation",
                "--account-identity",
                "--go-session"
            ]
            .iter()
            .any(|flag| a == flag)),
            "fixture modes are mutually exclusive"
        );
        &args[1..]
    } else {
        assert!(
            !args.iter().any(|a| a == "--legacy-expiry"),
            "legacy expiry flag must be first"
        );
        args
    };
    // Consume a valueless fixture prefix before the unchanged Node/image parser.
    let (identity_fixture, sharing_fixture, mode_args) =
        fixture_prefix(args).unwrap_or_else(|reason| panic!("{reason}"));
    local_postgres::validate_mode(
        local_manifest.is_some(),
        sharing_fixture
            || legacy_expiry
            || restore_fixture
            || attachment_fixture
            || migration_fixture,
        mode_args,
    )
    .expect("local PostgreSQL requires an explicit supported Node fixture");
    let (go_executable, host_args) =
        go_session::cli(mode_args).unwrap_or_else(|reason| panic!("{reason}"));
    assert!(
        !identity_fixture || go_executable.is_none(),
        "fixture modes are mutually exclusive"
    );
    let mode = Mode::parse(host_args).unwrap_or_else(|reason| panic!("{reason}"));
    assert!(
        local_manifest.is_none()
            || ((sharing_fixture || legacy_expiry || restore_fixture || attachment_fixture || migration_fixture)
                && matches!(mode, Mode::Node(_))),
        "local PostgreSQL is explicitly supported only for Node sharing, expiry or restore acceptance"
    );
    let mode = match mode {
        Mode::Node(binary) => {
            let binary = binary
                .canonicalize()
                .expect("production native binary must exist");
            assert!(binary.is_file(), "production native binary must be a file");
            Mode::Node(binary)
        }
        Mode::Image(image) => {
            docker_ok(
                &["image", "inspect", &image],
                "inspect prebuilt production image",
            );
            Mode::Image(image)
        }
    };
    let (network, db) = if let Some(manifest) = local_manifest {
        let local = if migration_fixture {
            local_postgres::LocalPostgres::start_migration(&manifest)
        } else if attachment_fixture {
            local_postgres::LocalPostgres::start_attachments(&manifest)
        } else {
            local_postgres::LocalPostgres::start(&manifest)
        };
        let db = Database::from_local(local, "source");
        (
            Network {
                name: String::new(),
            },
            db,
        )
    } else {
        docker_ok(
            &["image", "inspect", POSTGRES_IMAGE],
            "inspect preloaded PostgreSQL base image",
        );
        let network = Network::start();
        let db = Database::start(&network);
        (network, db)
    };
    assert!(
        !(attachment_fixture || migration_fixture)
            || !(restore_fixture
                || sharing_fixture
                || identity_fixture
                || legacy_expiry
                || go_executable.is_some()),
        "fixture modes are mutually exclusive"
    );
    if migration_fixture {
        sharing_rotation::encrypted_migration::run(&db, &network, &mode);
    } else if attachment_fixture {
        sharing_rotation::encrypted_attachments::run(&db, &network, &mode);
    } else if restore_fixture {
        sharing_rotation::encrypted_restore::run(&db, &network, &mode);
    } else if legacy_expiry {
        sharing_rotation::run_legacy_expiry(&db, &network, &mode);
    } else if let Some(executable) = go_executable {
        go_session::run(&db, &network, &mode, &executable);
    } else if identity_fixture {
        account_identity::run(&db, &network, &mode);
    } else if sharing_fixture {
        sharing_rotation::run(&db, &network, &mode);
    } else {
        run_acceptance(&db, &network, &mode);
    }
    drop(db);
    drop(network);
    assert!(
        !CLEANUP_FAILED.load(Ordering::SeqCst),
        "owned fixture cleanup must succeed"
    );
    println!(
        "encrypted storage mode={} acceptance and owned fixture cleanup passed",
        mode.label()
    );
}
fn run_acceptance(db: &Database, network: &Network, mode: &Mode) {
    let mut host = Host::start(db, network, mode);
    let p = host.port;
    accept_atomic_setup(db, p);
    let (refresh, connect, box_id, auth_password) = signup_with_password(p);
    let (stranger, _, stranger_box, stranger_auth_password) = signup_with_password(p);
    let headers = format!("Authorization: Bearer {refresh}\r\n");
    let stranger_headers = format!("Authorization: Bearer {stranger}\r\n");
    let connect_headers = format!("Authorization: Bearer {connect}\r\n");
    let root = format!("/api/encrypted/boxes/{box_id}");
    // Keep the pooled HTTP connection reactor alive between synchronous Core/HTTP steps.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let sdk =
        passshare_connect::EncryptedSessionClient::new(&format!("http://127.0.0.1:{p}"), &refresh)
            .unwrap();
    assert_eq!(
        runtime.block_on(sdk.state(&box_id)).unwrap(),
        passshare_connect::BoxState::Compatibility
    );
    assert_eq!(
        http(p, "GET", &root, &connect_headers, &Value::Null).0,
        401,
        "Connect credentials are not account sessions"
    );
    assert_eq!(
        http(p, "GET", &root, &headers, &Value::Null).1["mode"],
        "compatibility"
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            "",
            &json!({"keyEpoch":1})
        )
        .0,
        401
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &stranger_headers,
            &json!({"keyEpoch":1})
        )
        .0,
        403
    );
    // Cookie writes require the same CSRF protection as account routes.
    for client in ["mobile", "extension"] {
        assert_eq!(
            http(
                p,
                "POST",
                &format!("{root}/enable"),
                &format!("Cookie: passshare_session={refresh}\r\nx-passshare-client: {client}\r\n"),
                &json!({"keyEpoch":1})
            )
            .0,
            403
        );
    }
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &format!("Cookie: passshare_session={refresh}\r\n"),
            &json!({"keyEpoch":1})
        )
        .0,
        403
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &headers,
            &json!({"keyEpoch":1})
        )
        .0,
        200
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &headers,
            &json!({"keyEpoch":1})
        )
        .0,
        200
    );
    let context = ItemContext {
        password_box_id: box_id.parse().unwrap(),
        item_id: ConnectId::generate().unwrap(),
        item_version: 1,
        key_epoch: 1,
    };
    let item = json!({"id":context.item_id,"version":1,"vault":{"id":context.password_box_id},"title":"Synthetic title","fields":[{"type":"CONCEALED","value":ConnectId::generate().unwrap()}],"retained":{"array":[1,2,3]}});
    let key = PasswordBoxKey::generate().unwrap();
    let envelope = key.encrypt_item(&item, &context).unwrap();
    let payload = json!({"expectedVersion":0,"envelope":envelope});
    let path = format!("{root}/items/{}", context.item_id);
    // Keys and plaintext are forbidden even if all public headers are valid.
    for pointer in ["", "/envelope", "/envelope/context"] {
        for field in ["key", "password", "plaintext", "fields"] {
            let mut bad = payload.clone();
            bad.pointer_mut(pointer).unwrap()[field] = json!("must-not-enter-storage");
            assert_eq!(http(p, "PUT", &path, &headers, &bad).0, 400);
        }
    }
    assert_eq!(runtime.block_on(sdk.enable_empty_box(&box_id)).unwrap(), 1);
    assert_eq!(
        runtime.block_on(sdk.state(&box_id)).unwrap(),
        passshare_connect::BoxState::Encrypted { key_epoch: 1 }
    );
    assert_eq!(
        runtime
            .block_on(sdk.put_item(&box_id, context.item_id.as_str(), 0, &envelope))
            .unwrap(),
        envelope
    );
    assert_eq!(
        runtime
            .block_on(sdk.get_item(&box_id, context.item_id.as_str()))
            .unwrap(),
        envelope
    );
    let sdk_page = runtime.block_on(sdk.list(&box_id, None)).unwrap();
    assert_eq!(sdk_page.items.len(), 1);
    assert_eq!(sdk_page.items[0].item_id, context.item_id);
    assert!(sdk_page.next_cursor.is_none());
    let different_envelope = key.encrypt_item(&item, &context).unwrap();
    assert_ne!(different_envelope, envelope);
    let sdk_conflict = runtime
        .block_on(sdk.put_item(&box_id, context.item_id.as_str(), 0, &different_envelope))
        .unwrap_err();
    assert_eq!(sdk_conflict.status(), Some(409));
    assert_eq!(sdk_conflict.code(), Some("PS015"));
    let (status, stored) = http(p, "GET", &path, &headers, &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(stored, serde_json::to_value(&envelope).unwrap());
    assert_eq!(
        key.decrypt_item(&serde_json::from_value(stored.clone()).unwrap(), &context)
            .unwrap(),
        item
    );
    assert_eq!(
        http(p, "GET", &path, &stranger_headers, &Value::Null).0,
        403
    );
    let before_replay = db.sql(&format!(
        "SELECT to_jsonb(i)::text FROM encrypted_items i WHERE box_id='{box_id}' AND item_id='{}'",
        context.item_id
    ));
    assert_eq!(
        http(p, "PUT", &path, &headers, &payload),
        (200, stored.clone())
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT to_jsonb(i)::text FROM encrypted_items i WHERE box_id='{box_id}' AND item_id='{}'",
            context.item_id
        )),
        before_replay,
        "exact create replay preserves updated_at and the full row"
    );
    let claimant = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{stranger_box}'"
    ));
    // Owner key bundle: synthetic password and bundles are derived by Core here.
    let owner_id = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner'"
    ));
    let owner_path = format!("{root}/owner-key");
    let owner_password = format!(
        "synthetic-owner-password-{}",
        ConnectId::generate().unwrap()
    );
    let salt = generate_salt().unwrap();
    let master = owner_master(&owner_password, &salt).unwrap();
    let owner_ctx = owner_context(&box_id, &owner_id, 1);
    let bundle1 = owner_bundle(&key, &master, salt, &owner_ctx);
    let put1 = json!({"expectedVersion":0,"bundle":bundle1});
    let stranger_put = json!({"expectedVersion":0,"bundle":owner_bundle(&key,&master,salt,&owner_context(&box_id,&claimant,1))});
    for (credentials, expected) in [
        ("", 401),
        (connect_headers.as_str(), 401),
        (stranger_headers.as_str(), 403),
    ] {
        assert_eq!(
            http(p, "GET", &owner_path, credentials, &Value::Null).0,
            expected
        );
        let body = if expected == 403 {
            &stranger_put
        } else {
            &put1
        };
        assert_eq!(http(p, "PUT", &owner_path, credentials, body).0, expected);
    }
    // Cookie writes need CSRF; a claimed client type is not a bypass.
    for client in [
        "",
        "x-passshare-client: mobile\r\n",
        "x-passshare-client: extension\r\n",
    ] {
        assert_eq!(
            http(
                p,
                "PUT",
                &owner_path,
                &format!("Cookie: passshare_session={refresh}\r\n{client}"),
                &put1
            )
            .0,
            403
        );
    }
    assert_eq!(
        http(p, "GET", &owner_path, &headers, &Value::Null).0,
        404,
        "missing bundle"
    );
    for pointer in ["/bundle", "/bundle/wrapped", "/bundle/wrapped/context"] {
        for field in ["password", "key", "kdf"] {
            let mut bad = put1.clone();
            bad.pointer_mut(pointer).unwrap()[field] = json!("must-not-enter-storage");
            assert_eq!(http(p, "PUT", &owner_path, &headers, &bad).0, 400);
        }
    }
    for (pointer, value) in [
        ("/bundle/format", json!(2)),
        ("/bundle/salt", json!(BASE64.encode([1u8; 15]))),
        (
            "/bundle/wrapped/ciphertext",
            json!(BASE64.encode([0u8; 47])),
        ),
        (
            "/bundle/wrapped/context/passwordBoxId",
            json!(ConnectId::generate().unwrap()),
        ),
        ("/bundle/wrapped/context/ownerAccountId", json!(claimant)),
        ("/expectedVersion", json!(9_007_199_254_740_991u64)),
    ] {
        let mut bad = put1.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert_eq!(
            http(p, "PUT", &owner_path, &headers, &bad).0,
            400,
            "{pointer}"
        );
    }
    let other_epoch = json!({"expectedVersion":0,"bundle":owner_bundle(&key,&master,salt,&owner_context(&box_id,&owner_id,2))});
    let (status, rejection) = http(p, "PUT", &owner_path, &headers, &other_epoch);
    assert_eq!((status, &rejection["error"]), (409, &json!("PS056")));
    assert_eq!(
        http(p, "GET", &owner_path, &headers, &Value::Null).0,
        404,
        "rejections store nothing"
    );
    let csrf = ConnectId::generate().unwrap();
    let cookie_headers = format!(
        "Cookie: passshare_session={refresh}; passshare_csrf={csrf}\r\nx-csrf-token: {csrf}\r\n"
    );
    let (status, created) = http(p, "PUT", &owner_path, &cookie_headers, &put1);
    assert_eq!(status, 200);
    assert_eq!(created, json!({"bundleVersion":1,"bundle":bundle1}));
    let (status, fetched) = http(p, "GET", &owner_path, &headers, &Value::Null);
    assert_eq!((status, &fetched), (200, &created));
    let sdk_bundle = runtime
        .block_on(sdk.get_owner_key(&box_id, &owner_ctx))
        .unwrap();
    assert_eq!(sdk_bundle.bundle_version, 1);
    assert_eq!(serde_json::to_value(&sdk_bundle.bundle).unwrap(), bundle1);
    let sdk_replay = runtime
        .block_on(sdk.put_owner_key(&box_id, 0, &sdk_bundle.bundle, None))
        .unwrap_err();
    assert_eq!(sdk_replay.status(), Some(409));
    assert_eq!(sdk_replay.code(), Some("PS015"));
    let recovered = unwrap_bundle(&fetched["bundle"], &owner_password, &owner_ctx).unwrap();
    assert_eq!(
        recovered
            .decrypt_item(&serde_json::from_value(stored.clone()).unwrap(), &context)
            .unwrap(),
        item,
        "bundle unwraps to the key that decrypts the stored item"
    );
    let wrong_password = format!("incorrect-{}", ConnectId::generate().unwrap());
    assert!(unwrap_bundle(&fetched["bundle"], &wrong_password, &owner_ctx).is_err());
    assert!(unwrap_bundle(
        &fetched["bundle"],
        &owner_password,
        &owner_context(&box_id, &claimant, 1)
    )
    .is_err());
    let (status, replay) = http(p, "PUT", &owner_path, &headers, &put1);
    assert_eq!((status, &replay["error"]), (409, &json!("PS015")));
    let bundle2 = owner_bundle(&key, &master, salt, &owner_ctx);
    // A session alone must not replace the only key wrapper with structurally
    // valid garbage. Missing/wrong reauthentication leaves all bytes intact.
    let mut garbage = bundle2.clone();
    garbage["wrapped"]["ciphertext"] = json!(BASE64.encode([0u8; 48]));
    for body in [
        json!({"expectedVersion":1,"bundle":garbage}),
        json!({"expectedVersion":1,"bundle":garbage,"currentPassword":format!("wrong-{}",ConnectId::generate().unwrap())}),
    ] {
        let (status, error) = http(p, "PUT", &owner_path, &headers, &body);
        assert_eq!((status, &error["error"]), (401, &json!("PS026")));
        assert_eq!(
            http(p, "GET", &owner_path, &headers, &Value::Null).1,
            created
        );
    }
    let (status, updated) = http(
        p,
        "PUT",
        &owner_path,
        &headers,
        &json!({"expectedVersion":1,"bundle":bundle2,"currentPassword":auth_password}),
    );
    assert_eq!(
        (status, &updated),
        (200, &json!({"bundleVersion":2,"bundle":bundle2}))
    );
    assert_eq!(http(p, "PUT", &owner_path, &headers, &put1).0, 409);
    assert_eq!(
        http(
            p,
            "PUT",
            &owner_path,
            &headers,
            &json!({"expectedVersion":1,"bundle":bundle1,"currentPassword":auth_password})
        )
        .0,
        409,
        "stale update preserves the current bundle"
    );
    assert_eq!(
        http(p, "GET", &owner_path, &headers, &Value::Null).1,
        updated
    );
    let bundle3 = owner_bundle(&key, &master, salt, &owner_ctx);
    let contenders: Vec<_> = (0..4)
        .map(|_| {
            let (h, path) = (headers.clone(), owner_path.clone());
            let body =
                json!({"expectedVersion":2,"bundle":bundle3,"currentPassword":auth_password});
            thread::spawn(move || http(p, "PUT", &path, &h, &body).0)
        })
        .collect();
    let statuses: Vec<_> = contenders.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(statuses.iter().filter(|s| **s == 200).count(), 1);
    assert_eq!(statuses.iter().filter(|s| **s == 409).count(), 3);
    let current_bundle = json!({"bundleVersion":3,"bundle":bundle3});
    assert_eq!(
        http(p, "GET", &owner_path, &headers, &Value::Null).1,
        current_bundle
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_owner_keys WHERE bundle::text LIKE '%{owner_password}%'"
        )),
        "0"
    );
    let member_sdk =
        EncryptedSessionClient::new(&format!("http://127.0.0.1:{p}"), &stranger).unwrap();
    let owner_identity = AcceptanceIdentity::register(p, &runtime, &refresh, &sdk, &auth_password);
    let member_identity =
        AcceptanceIdentity::register(p, &runtime, &stranger, &member_sdk, &stranger_auth_password);
    assert!(owner_identity.id == owner_id && member_identity.id == claimant);
    accept_encrypted_put_replay(
        db,
        p,
        (&refresh, &connect, &stranger),
        &context,
        &item,
        &key,
        (&owner_identity, &member_identity),
    );
    accept_encrypted_delete(
        db,
        p,
        (&refresh, &connect, &stranger),
        &context,
        &item,
        &key,
        (&owner_identity, &member_identity),
    );
    // Synthetic unconfirmed membership is a denial fixture only. Confirmation
    // and HPKE key distribution below use the formal APIs and real Core.
    db.sql(&format!("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES('{claimant}','{box_id}','member')"));
    assert_eq!(
        http(p, "GET", &path, &stranger_headers, &Value::Null).0,
        403
    );
    confirm_acceptance_member(
        p,
        &box_id,
        &headers,
        &stranger_headers,
        &member_identity.email,
    );
    let before = acceptance_state_hash(db);
    let missing_grant = http(p, "GET", &path, &stranger_headers, &Value::Null);
    assert_eq!(
        (missing_grant.0, missing_grant.1["error"].as_str()),
        (403, Some("PS016"))
    );
    assert_eq!(
        acceptance_state_hash(db),
        before,
        "confirmed membership alone grants no item access"
    );
    let shared_key = grant_acceptance_member(
        db,
        &runtime,
        &box_id,
        &key,
        &owner_identity,
        &member_identity,
    );
    assert_eq!(
        http(p, "GET", &path, &stranger_headers, &Value::Null),
        (200, stored.clone())
    );
    assert!(shared_key.decrypt_item(&envelope, &context).unwrap() == item);
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &stranger_headers,
            &json!({"keyEpoch":1})
        )
        .0,
        403
    );
    // A confirmed non-owner member can neither read nor write an owner bundle.
    let member_put = json!({"expectedVersion":0,"bundle":owner_bundle(&key,&master,salt,&owner_context(&box_id,&claimant,1))});
    let before_member_owner_denial = acceptance_state_hash(db);
    assert_eq!(
        http(p, "GET", &owner_path, &stranger_headers, &Value::Null).0,
        403
    );
    assert_eq!(acceptance_state_hash(db), before_member_owner_denial);
    assert_eq!(
        http(p, "PUT", &owner_path, &stranger_headers, &member_put).0,
        403
    );
    assert_eq!(acceptance_state_hash(db), before_member_owner_denial);
    // Encrypted ownership requires its own complete transfer protocol. Legacy
    // reassignment is fenced BEFORE changing any account/box/token/key row.
    let before = acceptance_state_hash(db);
    let denied = http(
        p,
        "POST",
        &format!("/api/auth/vaults/{box_id}/ownership"),
        &headers,
        &json!({"currentPassword":auth_password,"targetUserId":claimant}),
    );
    assert_eq!((denied.0, denied.1["error"].as_str()), (409, Some("PS015")));
    assert_eq!(
        acceptance_state_hash(db),
        before,
        "encrypted legacy transfer preserves all full rows/xmin"
    );
    assert_eq!(
        http(p, "GET", &owner_path, &headers, &Value::Null).1,
        current_bundle,
        "current owner retains the exact bundle after refused transfer"
    );
    assert_eq!(
        http(p, "GET", &owner_path, &stranger_headers, &Value::Null).0,
        403
    );
    assert_eq!(
        http(p, "PUT", &owner_path, &stranger_headers, &member_put).0,
        403
    );
    // Synthetic removal tests live authorization and grant FK cascade; it is
    // not the production participant-removal/rotation protocol.
    db.sql(&format!(
        "DELETE FROM vault_memberships WHERE user_id='{claimant}' AND vault_id='{box_id}'"
    ));
    assert_eq!(
        http(p, "GET", &path, &stranger_headers, &Value::Null).0,
        403
    );
    assert_eq!(
        http(p, "GET", &owner_path, &stranger_headers, &Value::Null).0,
        403
    );
    for (pointer, value) in [
        ("/envelope/format", json!(2)),
        ("/envelope/nonce", json!("bad")),
        (
            "/envelope/context/passwordBoxId",
            json!(ConnectId::generate().unwrap()),
        ),
        (
            "/envelope/context/itemId",
            json!(ConnectId::generate().unwrap()),
        ),
        ("/envelope/context/itemVersion", json!(3)),
        ("/envelope/ciphertext", json!("malformed")),
    ] {
        let mut bad = payload.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert_eq!(http(p, "PUT", &path, &headers, &bad).0, 400, "{pointer}");
        assert_eq!(
            http(p, "GET", &path, &headers, &Value::Null).1,
            stored,
            "rejection preserves original"
        );
    }
    let mut generation = payload.clone();
    generation["expectedVersion"] = json!(1);
    generation["envelope"]["context"]["itemVersion"] = json!(2);
    generation["envelope"]["context"]["keyEpoch"] = json!(2);
    let (status, rejection) = http(p, "PUT", &path, &headers, &generation);
    assert_eq!(status, 409);
    assert_eq!(rejection["error"], "PS056");
    let mut next = context.clone();
    next.item_version = 2;
    let mut next_item = item.clone();
    next_item["version"] = json!(2);
    next_item["title"] = json!("Updated client title");
    // Different prepared ciphertexts must still compete through CAS. Identical
    // prepared requests are exercised separately by accept_encrypted_put_replay.
    let candidates = (0..4)
        .map(|_| key.encrypt_item(&next_item, &next).unwrap())
        .collect::<Vec<_>>();
    for (index, candidate) in candidates.iter().enumerate() {
        assert!(candidates[..index].iter().all(|other| other != candidate));
    }
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(5));
    let workers: Vec<_> = candidates
        .into_iter()
        .map(|candidate| {
            let h = headers.clone();
            let path = path.clone();
            let barrier = barrier.clone();
            let body = json!({"expectedVersion":1,"envelope":candidate});
            thread::spawn(move || {
                barrier.wait();
                (http(p, "PUT", &path, &h, &body), candidate)
            })
        })
        .collect();
    barrier.wait();
    let outcomes: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(
        outcomes.iter().filter(|(reply, _)| reply.0 == 200).count(),
        1
    );
    assert_eq!(
        outcomes.iter().filter(|(reply, _)| reply.0 == 409).count(),
        3
    );
    for (reply, _) in outcomes.iter().filter(|(reply, _)| reply.0 == 409) {
        assert_eq!(reply.1["error"], "PS015");
    }
    let (reply, next_envelope) = outcomes
        .into_iter()
        .find(|(reply, _)| reply.0 == 200)
        .unwrap();
    assert_eq!(reply.1, serde_json::to_value(&next_envelope).unwrap());
    assert_eq!(
        http(p, "GET", &format!("{root}/items"), &headers, &Value::Null).1["items"],
        json!([{"itemId":context.item_id,"itemVersion":2,"keyEpoch":1}])
    );
    assert_eq!(
        http(
            p,
            "GET",
            &format!("{root}/items?after={}", context.item_id),
            &headers,
            &Value::Null
        )
        .1["items"],
        json!([])
    );
    // Host rejects old reads/import/forms/files, including encoded/case aliases.
    for path in [
        format!("/v1/vaults/{box_id}/items"),
        format!(
            "/v1/vaults/%{:02x}{}/items",
            box_id.as_bytes()[0],
            &box_id[1..]
        ),
        format!("/V1/VAULTS/{box_id}/ITEMS/"),
        format!("/v1/vaults/{box_id}/imports/1pux"),
        format!("/v1/vaults/{box_id}/items/{}/form", context.item_id),
        format!("/v1/vaults/{box_id}/items/{}/files", context.item_id),
    ] {
        assert_eq!(http(p, "GET", &path, &connect_headers, &Value::Null).0, 409);
        assert_eq!(
            http(
                p,
                "POST",
                &path,
                &connect_headers,
                &json!({"title":"Plaintext"})
            )
            .0,
            409
        );
    }
    // Verify the DB itself rejects old writes when middleware is bypassed.
    let denied = command("docker")
        .args([
            "exec",
            &db.name,
            "psql",
            "-X",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "passshare",
            "-d",
            "passshare",
            "-c",
            &format!(
                "INSERT INTO connect_items(id,vault_id,document) VALUES('{}','{box_id}','{{}}')",
                ConnectId::generate().unwrap()
            ),
        ])
        .output()
        .unwrap();
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("PS055"));
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM connect_items WHERE vault_id='{box_id}'"
        )),
        "0"
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT envelope::text FROM encrypted_items WHERE box_id='{box_id}' AND item_id='{}'",
            context.item_id
        ))
        .parse::<Value>()
        .unwrap(),
        serde_json::to_value(&next_envelope).unwrap()
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_items WHERE envelope::text LIKE '%{}%'",
            item["fields"][0]["value"].as_str().unwrap()
        )),
        "0"
    );
    // A nonempty compatibility box remains usable, and activation fails intact.
    let (compat_refresh, compat_connect, compat_box) = signup(p);
    let compat_path = format!("/v1/vaults/{compat_box}/items");
    assert_eq!(
        http(
            p,
            "POST",
            &compat_path,
            &format!("Authorization: Bearer {compat_connect}\r\n"),
            &json!({"title":"Compatibility fixture","category":"LOGIN"})
        )
        .0,
        201
    );
    assert_eq!(
        http(
            p,
            "POST",
            &format!("/api/encrypted/boxes/{compat_box}/enable"),
            &format!("Authorization: Bearer {compat_refresh}\r\n"),
            &json!({"keyEpoch":1})
        )
        .0,
        409
    );
    assert_eq!(
        http(
            p,
            "GET",
            &compat_path,
            &format!("Authorization: Bearer {compat_connect}\r\n"),
            &Value::Null
        )
        .1
        .as_array()
        .unwrap()
        .len(),
        1
    );
    // An empty second box races activation with the old plaintext writer. No
    // schedule may commit BOTH modes. Each run owns an empty fresh DB, so the
    // ordinary signup limit is kept intact (five registrations total).
    let (race_refresh, race_connect, race_box) = signup(p);
    let race_enable = format!("/api/encrypted/boxes/{race_box}/enable");
    let race_legacy = format!("/v1/vaults/{race_box}/items");
    let enabling = thread::spawn(move || {
        http(
            p,
            "POST",
            &race_enable,
            &format!("Authorization: Bearer {race_refresh}\r\n"),
            &json!({"keyEpoch":1}),
        )
        .0
    });
    let writing = thread::spawn(move || {
        http(
            p,
            "POST",
            &race_legacy,
            &format!("Authorization: Bearer {race_connect}\r\n"),
            &json!({"title":"Race fixture","category":"LOGIN"}),
        )
        .0
    });
    let enabled = enabling.join().unwrap();
    let written = writing.join().unwrap();
    assert!(
        (enabled == 200 && written == 409) || (enabled == 409 && written == 201),
        "activation/legacy race: {enabled}/{written}"
    );
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_box_state WHERE box_id='{race_box}')+(SELECT count(*) FROM connect_items WHERE vault_id='{race_box}')")),"1");
    // Account retirement deletes private boxes. Both levels cascade without
    // purging another box. There is no separate memory map to purge.
    let (private_refresh, _, private_box) = signup(p);
    let private_headers = format!("Authorization: Bearer {private_refresh}\r\n");
    let private_root = format!("/api/encrypted/boxes/{private_box}");
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{private_root}/enable"),
            &private_headers,
            &json!({"keyEpoch":1})
        )
        .0,
        200
    );
    let private_context = ItemContext {
        password_box_id: private_box.parse().unwrap(),
        ..context.clone()
    };
    let mut private_item = item.clone();
    private_item["vault"]["id"] = json!(private_box);
    assert_eq!(http(p,"PUT",&format!("{private_root}/items/{}",context.item_id),&private_headers,
        &json!({"expectedVersion":0,"envelope":key.encrypt_item(&private_item,&private_context).unwrap()})).0,200);
    let private_owner = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{private_box}'"
    ));
    assert_eq!(
        http(
            p,
            "PUT",
            &format!("{private_root}/owner-key"),
            &private_headers,
            &json!({"expectedVersion":0,"bundle":owner_bundle(&key,&master,salt,&owner_context(&private_box,&private_owner,1))})
        )
        .0,
        200
    );
    assert_eq!(
        http_bytes(
            p,
            "DELETE",
            &format!("{private_root}/items/{}", context.item_id),
            &private_headers,
            &json!({"expectedVersion":1,"keyEpoch":1})
        ),
        (204, Vec::new())
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{private_box}'"
        )),
        "1"
    );
    let retained_context = ItemContext {
        item_id: ConnectId::generate().unwrap(),
        ..private_context.clone()
    };
    private_item["id"] = json!(retained_context.item_id);
    assert_eq!(http(p,"PUT",&format!("{private_root}/items/{}",retained_context.item_id),&private_headers,
        &json!({"expectedVersion":0,"envelope":key.encrypt_item(&private_item,&retained_context).unwrap()})).0,200);
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_items WHERE box_id='{private_box}')::text || ':' || (SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{private_box}')::text")),"1:1", "both live ciphertext and deletion metadata must exist before cascade");
    db.sql(&format!(
        "DELETE FROM connect_vaults WHERE id='{private_box}'"
    ));
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_box_state WHERE box_id='{private_box}')+(SELECT count(*) FROM encrypted_items WHERE box_id='{private_box}')+(SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{private_box}')+(SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{private_box}')")),"0");
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_items WHERE box_id='{box_id}'"
        )),
        "1"
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{box_id}'"
        )),
        "1",
        "another box's current owner bundle is retained"
    );
    // Restart proves persistence; client decrypts the unchanged opaque body.
    drop(host);
    host = Host::with_storage(db, network, mode, false);
    assert_eq!(
        http_bytes(host.port, "GET", &path, &headers, &Value::Null).0,
        404
    );
    assert_eq!(
        http_bytes(host.port, "GET", &owner_path, &headers, &Value::Null).0,
        404,
        "owner key API is disabled with the encrypted storage flag"
    );
    assert_eq!(
        http(
            host.port,
            "GET",
            &format!("/v1/vaults/{box_id}/items"),
            &connect_headers,
            &Value::Null
        )
        .0,
        409,
        "disabled storage cannot make an encrypted box look empty"
    );
    drop(host);
    host = Host::start(db, network, mode);
    let restored = http(host.port, "GET", &path, &headers, &Value::Null);
    assert_eq!(restored.0, 200);
    assert_eq!(restored.1, serde_json::to_value(&next_envelope).unwrap());
    assert_eq!(
        key.decrypt_item(&serde_json::from_value(restored.1).unwrap(), &next)
            .unwrap(),
        next_item
    );
    // The bundle is durable across restart and still unwraps to the item key.
    let restored_bundle = http(host.port, "GET", &owner_path, &headers, &Value::Null);
    assert_eq!(
        (restored_bundle.0, &restored_bundle.1),
        (200, &current_bundle)
    );
    assert_eq!(
        unwrap_bundle(&restored_bundle.1["bundle"], &owner_password, &owner_ctx)
            .unwrap()
            .decrypt_item(&next_envelope, &next)
            .unwrap(),
        next_item
    );
    // Give the other account a bundle for its OWN box through formal setup.
    // No synthetic owner reassignment is needed for account-FK cascade coverage.
    let stranger_key = PasswordBoxKey::generate().unwrap();
    let stranger_bundle = owner_bundle(
        &stranger_key,
        &master,
        salt,
        &owner_context(&stranger_box, &claimant, 1),
    );
    assert_eq!(
        http(
            host.port,
            "POST",
            &format!("/api/encrypted/boxes/{stranger_box}/setup"),
            &stranger_headers,
            &json!({"bundle":stranger_bundle})
        )
        .0,
        200
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_owner_keys WHERE owner_id='{claimant}'"
        )),
        "1"
    );
    // Synthetic account deletion removes only its own identity and bundles.
    db.sql(&format!("DELETE FROM users WHERE id='{claimant}'"));
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_account_identities WHERE account_id='{claimant}'"
        )),
        "0"
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_account_identities WHERE account_id='{owner_id}'"
        )),
        "1"
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_owner_keys WHERE owner_id='{claimant}'"
        )),
        "0"
    );
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{box_id}'"
        )),
        "1"
    );
    // Session/membership revocation is checked against live DB state.
    db.sql(&format!(
        "DELETE FROM vault_memberships WHERE vault_id='{box_id}'"
    ));
    assert_eq!(http(host.port, "GET", &path, &headers, &Value::Null).0, 403);
    assert_eq!(
        http(host.port, "GET", &owner_path, &headers, &Value::Null).0,
        403
    );
    assert_eq!(http(host.port, "PUT", &owner_path, &headers, &put1).0, 403);
    let committed_payload = json!({"expectedVersion":1,"envelope":next_envelope});
    let committed_snapshot = || {
        db.sql(&format!(
            "SELECT to_jsonb(i)::text FROM encrypted_items i WHERE box_id='{box_id}' AND item_id='{}'",
            context.item_id
        ))
    };
    let committed_row = committed_snapshot();
    let before_revoked_membership = acceptance_state_hash(db);
    assert_eq!(
        http(host.port, "PUT", &path, &headers, &committed_payload).0,
        403
    );
    assert_eq!(committed_snapshot(), committed_row);
    assert_eq!(acceptance_state_hash(db), before_revoked_membership);
    db.sql("DELETE FROM sessions");
    let before_revoked_session = acceptance_state_hash(db);
    assert_eq!(http(host.port, "GET", &path, &headers, &Value::Null).0, 401);
    assert_eq!(
        http(host.port, "PUT", &path, &headers, &committed_payload).0,
        401
    );
    assert_eq!(committed_snapshot(), committed_row);
    assert_eq!(acceptance_state_hash(db), before_revoked_session);
    assert_eq!(
        http(host.port, "GET", &owner_path, &headers, &Value::Null).0,
        401
    );
    println!("encrypted storage acceptance: Core roundtrip, rejection preservation, CAS 1/4, epoch, scope, confirmed membership with formal HPKE grant, CSRF, host/DB plaintext boundary, compatibility/activation race, restart, revocation, private-box cascade, and owner key bundle unwrap/CAS/legacy transfer denial/restart/cascade passed");
}

fn accept_encrypted_put_replay(
    db: &Database,
    p: u16,
    credentials: (&str, &str, &str),
    original_context: &ItemContext,
    original_item: &Value,
    key: &PasswordBoxKey,
    identities: (&AcceptanceIdentity, &AcceptanceIdentity),
) {
    let (session, connect, member_session) = credentials;
    let (owner_identity, member_identity) = identities;
    let box_id = original_context.password_box_id.as_str();
    let headers = format!("Authorization: Bearer {session}\r\n");
    let member_headers = format!("Authorization: Bearer {member_session}\r\n");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let sdk = &owner_identity.sdk;
    let member_sdk = &member_identity.sdk;
    let mut context = ItemContext {
        item_id: ConnectId::generate().unwrap(),
        ..original_context.clone()
    };
    let item_id = context.item_id.as_str().to_owned();
    let race_id = ConnectId::generate().unwrap();
    let path = format!("/api/encrypted/boxes/{box_id}/items/{item_id}");
    let snapshot = |id: &str| {
        db.sql(&format!(
            "SELECT jsonb_build_object('row',to_jsonb(i),'xmin',i.xmin::text)::text FROM encrypted_items i WHERE box_id='{box_id}' AND item_id='{id}'"
        ))
    };
    let actor = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner'"
    ));
    let session_id = db.sql(&format!(
        "SELECT id::text FROM sessions WHERE user_id='{actor}' ORDER BY created_at LIMIT 1"
    ));
    let member = &member_identity.id;
    let csrf = ConnectId::generate().unwrap();
    let cookie = format!(
        "Cookie: passshare_session={session}; passshare_csrf={csrf}\r\nx-csrf-token: {csrf}\r\n"
    );
    let mut item = original_item.clone();
    item["id"] = json!(item_id);
    if item.get("attachments").is_none() {
        item["attachments"] =
            json!([{"id":"synthetic-replay-attachment","name":"retained.bin","size":3}]);
    }
    if item.get("payload").is_none() {
        item["payload"] = json!({"ordered":[3,1,2],"unknown":{"null":null,"value":ConnectId::generate().unwrap()}});
    }

    // Synthetic fixture instrumentation: fail any redundant UPDATE, even if
    // it writes the same timestamp/values. No ledger or additional table is used.
    // Real version advances are allowed; exact replay must never reach UPDATE.
    db.sql(&format!("CREATE FUNCTION passshare_put_replay_write_fault() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic redundant replay update'; END $$; CREATE TRIGGER passshare_put_replay_write_fault BEFORE UPDATE ON encrypted_items FOR EACH ROW WHEN (OLD.box_id='{box_id}' AND OLD.item_id IN ('{item_id}','{race_id}') AND OLD.revision=NEW.revision) EXECUTE FUNCTION passshare_put_replay_write_fault();"));
    let mut first_payload = Value::Null;
    let mut last_payload = Value::Null;
    let mut member_key: Option<PasswordBoxKey> = None;
    for version in [1, 2] {
        context.item_version = version;
        item["version"] = json!(version);
        item["title"] = json!(format!("Full DTO replay version {version}"));
        let writer_key = if version == 1 {
            key
        } else {
            member_key.as_ref().unwrap()
        };
        let envelope = writer_key.encrypt_item(&item, &context).unwrap();
        let public = serde_json::to_value(&envelope).unwrap();
        let payload = json!({"expectedVersion":version-1,"envelope":public});
        // A different confirmed writer commits version 2. The original actor
        // may replay the identical stored public envelope regardless of author.
        let writer = if version == 1 { sdk } else { member_sdk };
        assert_eq!(
            runtime
                .block_on(writer.put_item(box_id, &item_id, version - 1, &envelope))
                .unwrap(),
            envelope
        );
        let before = snapshot(&item_id);
        if version == 1 {
            // Verify the fixture observer is armed; only its exact injected
            // error is accepted, and the redundant write must roll back.
            db.sql(&format!("DO $$ BEGIN BEGIN UPDATE encrypted_items SET revision=revision WHERE box_id='{box_id}' AND item_id='{item_id}'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='synthetic redundant replay update' THEN RETURN; END IF; RAISE; END; RAISE EXCEPTION 'replay write observer did not fire'; END $$;"));
            assert_eq!(snapshot(&item_id), before);
        }
        let row: Value = serde_json::from_str(&before).unwrap();
        assert_eq!(row["row"]["revision"], version);
        assert_eq!(row["row"]["key_epoch"], 1);
        assert_eq!(row["row"]["envelope"], public);
        assert!(row["row"]["updated_at"].as_str().is_some());
        assert_eq!(
            runtime
                .block_on(sdk.put_item(box_id, &item_id, version - 1, &envelope))
                .unwrap(),
            envelope
        );
        let fetched = runtime.block_on(sdk.get_item(box_id, &item_id)).unwrap();
        assert_eq!(fetched, envelope);
        assert_eq!(key.decrypt_item(&fetched, &context).unwrap(), item);
        assert_eq!(
            http(p, "GET", &path, &headers, &Value::Null),
            (200, public.clone())
        );
        assert_eq!(
            snapshot(&item_id),
            before,
            "SDK replay preserves updated_at and xmin"
        );

        // Serialize in a different order on the wire, including context keys.
        // A Value-only comparison would never exercise JSONB normalization.
        let reordered = format!(
            "{{ \"envelope\": {{ \"nonce\": {}, \"format\": 1, \"context\": {{ \"passwordBoxId\": {}, \"keyEpoch\": 1, \"itemVersion\": {version}, \"itemId\": {} }}, \"ciphertext\": {} }}, \"expectedVersion\": {} }}",
            public["nonce"],
            public["context"]["passwordBoxId"],
            public["context"]["itemId"],
            public["ciphertext"],
            version - 1
        );
        assert_ne!(reordered, payload.to_string());
        assert_eq!(serde_json::from_str::<Value>(&reordered).unwrap(), payload);
        let (status, bytes) = http_payload(p, "PUT", &path, &cookie, &reordered);
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), public);
        assert_eq!(
            snapshot(&item_id),
            before,
            "JSONB replay does not update the row"
        );

        let reject = |body: &Value, status, code| {
            let all_before = acceptance_state_hash(db);
            let reply = http(p, "PUT", &path, &headers, body);
            assert_eq!((reply.0, reply.1["error"].as_str()), (status, Some(code)));
            assert_eq!(acceptance_state_hash(db), all_before);
            assert_eq!(
                snapshot(&item_id),
                before,
                "rejection preserves the full row and time"
            );
            assert_eq!(
                http(p, "GET", &path, &headers, &Value::Null),
                (200, public.clone())
            );
        };
        // Canonical, same-length encodings differing in just one public value.
        for field in ["nonce", "ciphertext"] {
            let mut changed = payload.clone();
            let mut bytes = BASE64.decode(public[field].as_str().unwrap()).unwrap();
            bytes[0] ^= 1;
            changed["envelope"][field] = json!(BASE64.encode(bytes));
            reject(&changed, 409, "PS015");
        }
        let fresh = key.encrypt_item(&item, &context).unwrap();
        assert_ne!(fresh, envelope);
        reject(
            &json!({"expectedVersion":version-1,"envelope":fresh}),
            409,
            "PS015",
        );
        let mut different_item = item.clone();
        different_item["title"] = json!("Different full DTO at the same revision");
        let different_body = key.encrypt_item(&different_item, &context).unwrap();
        reject(
            &json!({"expectedVersion":version-1,"envelope":different_body}),
            409,
            "PS015",
        );
        if version == 2 {
            reject(&first_payload, 409, "PS015");
        }
        let mut other_epoch = payload.clone();
        other_epoch["envelope"]["context"]["keyEpoch"] = json!(2);
        reject(&other_epoch, 409, "PS056");
        for (pointer, value) in [
            ("/expectedVersion", json!(version)),
            ("/expectedVersion", json!("0")),
            ("/envelope/format", json!(2)),
            ("/envelope/format", json!("1")),
            ("/envelope/context/itemVersion", json!("1")),
            ("/envelope/context/keyEpoch", json!(0)),
            (
                "/envelope/context/itemId",
                json!(ConnectId::generate().unwrap()),
            ),
            (
                "/envelope/context/passwordBoxId",
                json!(ConnectId::generate().unwrap()),
            ),
            ("/envelope/nonce", json!("bad")),
            ("/envelope/ciphertext", json!("malformed")),
        ] {
            let mut bad = payload.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            reject(&bad, 400, "PS051");
        }
        for pointer in ["", "/envelope", "/envelope/context"] {
            let mut bad = payload.clone();
            bad.pointer_mut(pointer).unwrap()["plaintext"] = json!("forbidden");
            reject(&bad, 400, "PS051");
        }
        for (credentials, status) in [
            (String::new(), 401),
            (format!("Authorization: Bearer {connect}\r\n"), 401),
            (format!("Cookie: passshare_session={session}\r\n"), 403),
            (
                format!("Cookie: passshare_session={session}\r\nx-passshare-client: mobile\r\n"),
                403,
            ),
            (
                format!("Cookie: passshare_session={session}\r\nx-passshare-client: extension\r\n"),
                403,
            ),
        ] {
            assert_eq!(http(p, "PUT", &path, &credentials, &payload).0, status);
            assert_eq!(snapshot(&item_id), before);
        }

        // Synthetic active-epoch change: an otherwise exact old envelope is
        // rejected before replay recognition. This does not implement rotation.
        db.sql(&format!(
            "UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id='{box_id}'"
        ));
        reject(&payload, 409, "PS056");
        db.sql(&format!(
            "UPDATE encrypted_box_state SET key_epoch=1 WHERE box_id='{box_id}'"
        ));

        // Exercise the authoritative DB checks on a validated exact envelope,
        // independently of the HTTP middleware. Fixture changes roll back.
        let sql_body = public.to_string().replace('\'', "''");
        let operation = format!("SELECT passshare_encrypted_operation('{actor}','{session_id}','{box_id}','put','{item_id}',{},'{sql_body}'::jsonb,1)", version - 1);
        for (mutation, status, code) in [
            (
                format!("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id='{session_id}'"),
                401,
                "PS024",
            ),
            (
                format!("DELETE FROM sessions WHERE id='{session_id}'"),
                401,
                "PS024",
            ),
            (
                format!("DELETE FROM vault_memberships WHERE user_id='{actor}' AND vault_id='{box_id}'"),
                403,
                "PS016",
            ),
        ] {
            let reply: Value = serde_json::from_str(
                &db.sql(&format!("BEGIN; {mutation}; {operation}; ROLLBACK;")),
            )
            .unwrap();
            assert_eq!(
                (reply["status"].as_u64(), reply["code"].as_str()),
                (Some(status), Some(code))
            );
            assert_eq!(snapshot(&item_id), before);
        }
        if version == 1 {
            assert_eq!(http(p, "PUT", &path, &member_headers, &payload).0, 403);
            // Synthetic unconfirmed membership only supplies a negative control.
            db.sql(&format!("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES('{member}','{box_id}','member')"));
            assert_eq!(http(p, "PUT", &path, &member_headers, &payload).0, 403);
            confirm_acceptance_member(p, box_id, &headers, &member_headers, &member_identity.email);
            let before_grant = acceptance_state_hash(db);
            let reply = http(p, "PUT", &path, &member_headers, &payload);
            assert_eq!(
                (reply.0, reply.1["error"].as_str()),
                (403, Some("PS016")),
                "confirmed writer still requires a current grant"
            );
            assert_eq!(acceptance_state_hash(db), before_grant);
            let recovered =
                grant_acceptance_member(db, &runtime, box_id, key, owner_identity, member_identity);
            let fetched = acceptance_result(
                runtime.block_on(member_sdk.get_item(box_id, &item_id)),
                "granted member item GET",
            );
            assert!(
                fetched == envelope && recovered.decrypt_item(&fetched, &context).unwrap() == item
            );
            // Synthetic readonly role isolates the write boundary AFTER grant
            // distribution. This is not a role-change API acceptance claim.
            db.sql(&format!("UPDATE vault_memberships SET role='readonly' WHERE user_id='{member}' AND vault_id='{box_id}'"));
            let before_role_denial = acceptance_state_hash(db);
            let reply = http(p, "PUT", &path, &member_headers, &payload);
            assert_eq!((reply.0, reply.1["error"].as_str()), (403, Some("PS032")));
            assert_eq!(acceptance_state_hash(db), before_role_denial);
            assert!(
                acceptance_result(
                    runtime.block_on(member_sdk.get_item(box_id, &item_id)),
                    "readonly member item GET"
                ) == envelope
            );
            db.sql(&format!("UPDATE vault_memberships SET role='member' WHERE user_id='{member}' AND vault_id='{box_id}'"));
            let before_member_replay = acceptance_state_hash(db);
            assert!(
                acceptance_result(
                    runtime.block_on(member_sdk.put_item(box_id, &item_id, 0, &envelope)),
                    "granted member exact replay"
                ) == envelope
            );
            assert_eq!(
                http(p, "PUT", &path, &member_headers, &payload),
                (200, public.clone())
            );
            assert_eq!(acceptance_state_hash(db), before_member_replay);
            assert_eq!(snapshot(&item_id), before);
            member_key = Some(recovered);
            first_payload = payload.clone();
        } else {
            // Synthetic removal rechecks the author of the stored ciphertext.
            db.sql(&format!(
                "DELETE FROM vault_memberships WHERE user_id='{member}' AND vault_id='{box_id}'"
            ));
            let before_removed = acceptance_state_hash(db);
            assert_eq!(http(p, "PUT", &path, &member_headers, &payload).0, 403);
            assert_eq!(acceptance_state_hash(db), before_removed);
            assert_eq!(
                snapshot(&item_id),
                before,
                "removed writer cannot replay its own envelope"
            );
        }
        last_payload = payload;
    }

    // Identical prepared create AND update requests start at one barrier. This
    // synchronizes HTTP request starts, not observation of a DB lock waiter.
    // The synthetic trigger above detects a second UPDATE even if snapshots
    // would otherwise miss a fast redundant write before either response.
    let race_path = format!("/api/encrypted/boxes/{box_id}/items/{race_id}");
    let mut race_context = ItemContext {
        item_id: race_id,
        ..original_context.clone()
    };
    item["id"] = json!(race_context.item_id);
    for version in [1, 2] {
        race_context.item_version = version;
        item["version"] = json!(version);
        let envelope = key.encrypt_item(&item, &race_context).unwrap();
        let public = serde_json::to_value(&envelope).unwrap();
        let payload = json!({"expectedVersion":version-1,"envelope":public});
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let requests = (0..2)
            .map(|_| {
                let barrier = barrier.clone();
                let path = race_path.clone();
                let headers = headers.clone();
                let body = payload.clone();
                thread::spawn(move || {
                    barrier.wait();
                    http(p, "PUT", &path, &headers, &body)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        for request in requests {
            assert_eq!(request.join().unwrap(), (200, public.clone()));
        }
        assert_eq!(
            db.sql(&format!(
                "SELECT count(*) FROM encrypted_items WHERE box_id='{box_id}' AND item_id='{}'",
                race_context.item_id
            )),
            "1"
        );
        let before = snapshot(race_context.item_id.as_str());
        let row: Value = serde_json::from_str(&before).unwrap();
        assert_eq!(row["row"]["revision"], version);
        assert_eq!(row["row"]["key_epoch"], 1);
        assert_eq!(row["row"]["envelope"], public);
        assert!(row["row"]["updated_at"].as_str().is_some());
        let fetched = runtime
            .block_on(sdk.get_item(box_id, race_context.item_id.as_str()))
            .unwrap();
        assert_eq!(fetched, envelope);
        assert_eq!(key.decrypt_item(&fetched, &race_context).unwrap(), item);
        assert_eq!(
            http(p, "GET", &race_path, &headers, &Value::Null),
            (200, public.clone())
        );
        assert_eq!(
            http(p, "PUT", &race_path, &headers, &payload),
            (200, public)
        );
        assert_eq!(snapshot(race_context.item_id.as_str()), before);
    }
    db.sql("DROP TRIGGER passshare_put_replay_write_fault ON encrypted_items; DROP FUNCTION passshare_put_replay_write_fault();");
    runtime
        .block_on(sdk.delete_item(box_id, &item_id, 2, 1))
        .unwrap();
    let tombstone = db.sql(&format!("SELECT to_jsonb(t)::text FROM encrypted_item_tombstones t WHERE box_id='{box_id}' AND item_id='{item_id}'"));
    for payload in [&first_payload, &last_payload] {
        let reply = http(p, "PUT", &path, &headers, payload);
        assert_eq!((reply.0, reply.1["error"].as_str()), (409, Some("PS015")));
        assert!(snapshot(&item_id).is_empty());
        assert_eq!(db.sql(&format!("SELECT to_jsonb(t)::text FROM encrypted_item_tombstones t WHERE box_id='{box_id}' AND item_id='{item_id}'")), tombstone);
    }
    let error = runtime
        .block_on(sdk.get_item(box_id, &item_id))
        .unwrap_err();
    assert_eq!((error.status(), error.code()), (Some(404), Some("PS012")));
    runtime
        .block_on(sdk.delete_item(box_id, race_context.item_id.as_str(), 2, 1))
        .unwrap();
    println!("encrypted PUT replay: full Core DTO create/update, SDK/JSONB replay without writes/time changes, different ciphertext/nonce CAS, later writer rejection, auth/CSRF/live DB guards, barrier-started identical create/update, and deleted ID rejection passed");
}

fn accept_encrypted_delete(
    db: &Database,
    p: u16,
    credentials: (&str, &str, &str),
    original_context: &ItemContext,
    original_item: &Value,
    key: &PasswordBoxKey,
    identities: (&AcceptanceIdentity, &AcceptanceIdentity),
) {
    let (session, connect, stranger) = credentials;
    let (owner_identity, member_identity) = identities;
    let box_id = original_context.password_box_id.as_str();
    let root = format!("/api/encrypted/boxes/{box_id}");
    let headers = format!("Authorization: Bearer {session}\r\n");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let sdk = &owner_identity.sdk;
    // Retain the complete original DTO and arbitrary nested values. Every new
    // nonce/key is generated by real Core, never reused static ciphertext.
    let context = ItemContext {
        item_id: ConnectId::generate().unwrap(),
        ..original_context.clone()
    };
    let item_id = context.item_id.as_str();
    let path = format!("{root}/items/{item_id}");
    let mut item = original_item.clone();
    item["id"] = json!(item_id);
    if item.get("attachments").is_none() {
        item["attachments"] = json!([{"id":"synthetic-attachment","name":"retained.bin","size":3}]);
    }
    if item.get("payload").is_none() {
        item["payload"] = json!({"ordered":[3,1,2],"unknown":{"null":null,"value":ConnectId::generate().unwrap()}});
    }
    let envelope = key.encrypt_item(&item, &context).unwrap();
    runtime
        .block_on(sdk.put_item(box_id, item_id, 0, &envelope))
        .unwrap();
    let fetched = runtime.block_on(sdk.get_item(box_id, item_id)).unwrap();
    assert_eq!(key.decrypt_item(&fetched, &context).unwrap(), item);
    let deletion = json!({"expectedVersion":1,"keyEpoch":1});
    let live_snapshot = || {
        db.sql(&format!(
        "SELECT to_jsonb(i)::text FROM encrypted_items i WHERE box_id='{box_id}' AND item_id='{item_id}'"
    ))
    };
    let before = live_snapshot();
    let reject = |body: &Value, status, code| {
        let all_before = acceptance_state_hash(db);
        let reply = http(p, "DELETE", &path, &headers, body);
        assert_eq!(reply.0, status);
        assert_eq!(reply.1["error"], code);
        assert_eq!(acceptance_state_hash(db), all_before);
        assert_eq!(
            live_snapshot(),
            before,
            "rejection must preserve the complete ciphertext row"
        );
    };
    reject(&json!({"expectedVersion":2,"keyEpoch":1}), 409, "PS015");
    reject(&json!({"expectedVersion":1,"keyEpoch":2}), 409, "PS056");
    for body in [
        json!({"expectedVersion":0,"keyEpoch":1}),
        json!({"expectedVersion":9007199254740992u64,"keyEpoch":1}),
        json!({"expectedVersion":1,"keyEpoch":0}),
        json!({"expectedVersion":1,"keyEpoch":9007199254740992u64}),
        json!({"expectedVersion":"1","keyEpoch":1}),
        json!({"expectedVersion":1,"keyEpoch":true}),
        json!({"expectedVersion":1}),
        json!({"expectedVersion":1,"keyEpoch":1,"envelope":envelope}),
        json!({"expectedVersion":1,"keyEpoch":1,"plaintext":"forbidden"}),
    ] {
        reject(&body, 400, "PS051");
    }
    for (credentials, status) in [
        (String::new(), 401),
        (format!("Authorization: Bearer {connect}\r\n"), 401),
        (format!("Authorization: Bearer {stranger}\r\n"), 403),
        (format!("Cookie: passshare_session={session}\r\n"), 403),
        (
            format!("Cookie: passshare_session={session}\r\nx-passshare-client: mobile\r\n"),
            403,
        ),
        (
            format!("Cookie: passshare_session={session}\r\nx-passshare-client: extension\r\n"),
            403,
        ),
    ] {
        assert_eq!(http(p, "DELETE", &path, &credentials, &deletion).0, status);
        assert_eq!(live_snapshot(), before);
    }
    let missing = ConnectId::generate().unwrap();
    let error = runtime
        .block_on(sdk.delete_item(box_id, missing.as_str(), 1, 1))
        .unwrap_err();
    assert_eq!((error.status(), error.code()), (Some(404), Some("PS044")));

    // Synthetic role/session state also exercises the DB recheck directly,
    // bypassing middleware claims without bypassing the operation's locks.
    let actor = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner'"
    ));
    let session_id = db.sql(&format!(
        "SELECT id::text FROM sessions WHERE user_id='{actor}' ORDER BY created_at LIMIT 1"
    ));
    let sql_operation = format!("SELECT passshare_encrypted_operation('{actor}','{session_id}','{box_id}','delete','{item_id}',1,NULL,1)");
    let reply: Value = serde_json::from_str(&db.sql(&format!("BEGIN; UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id='{session_id}'; {sql_operation}; ROLLBACK;"))).unwrap();
    assert_eq!(
        (reply["status"].as_u64(), reply["code"].as_str()),
        (Some(401), Some("PS024"))
    );
    let reply: Value = serde_json::from_str(&db.sql(&format!("BEGIN; DELETE FROM vault_memberships WHERE vault_id='{box_id}' AND user_id='{actor}'; {sql_operation}; ROLLBACK;"))).unwrap();
    assert_eq!(
        (reply["status"].as_u64(), reply["code"].as_str()),
        (Some(403), Some("PS016"))
    );
    assert_eq!(live_snapshot(), before);
    let member = &member_identity.id;
    let member_headers = format!("Authorization: Bearer {stranger}\r\n");
    // Synthetic unconfirmed membership remains a distinct denial case.
    db.sql(&format!("INSERT INTO vault_memberships(user_id,vault_id,role) VALUES('{member}','{box_id}','member')"));
    assert_eq!(http(p, "DELETE", &path, &member_headers, &deletion).0, 403);
    confirm_acceptance_member(p, box_id, &headers, &member_headers, &member_identity.email);
    let before_grant = acceptance_state_hash(db);
    let reply = http(p, "DELETE", &path, &member_headers, &deletion);
    assert_eq!((reply.0, reply.1["error"].as_str()), (403, Some("PS016")));
    assert_eq!(acceptance_state_hash(db), before_grant);
    let shared_key =
        grant_acceptance_member(db, &runtime, box_id, key, owner_identity, member_identity);
    // Synthetic readonly role isolates role denial with a genuine current grant.
    db.sql(&format!("UPDATE vault_memberships SET role='readonly' WHERE user_id='{member}' AND vault_id='{box_id}'"));
    let before_role_denial = acceptance_state_hash(db);
    let reply = http(p, "DELETE", &path, &member_headers, &deletion);
    assert_eq!((reply.0, reply.1["error"].as_str()), (403, Some("PS032")));
    assert_eq!(acceptance_state_hash(db), before_role_denial);
    assert!(
        acceptance_result(
            runtime.block_on(member_identity.sdk.get_item(box_id, item_id)),
            "readonly member item GET"
        ) == envelope
    );
    assert_eq!(live_snapshot(), before);
    // Keep the granted member for the later delete/replay positive control.
    db.sql(&format!("UPDATE vault_memberships SET role='member' WHERE user_id='{member}' AND vault_id='{box_id}'"));

    // Direct SQL fault injection is SYNTHETIC fixture setup only. A tombstone
    // insert trigger fails after the function has executed the live-row DELETE.
    // This proves transactional rollback, not an actual production outage.
    db.sql(&format!("CREATE FUNCTION passshare_delete_fault() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.box_id='{box_id}' AND NEW.item_id='{item_id}' THEN RAISE EXCEPTION 'synthetic tombstone insert failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER passshare_delete_fault BEFORE INSERT ON encrypted_item_tombstones FOR EACH ROW EXECUTE FUNCTION passshare_delete_fault();"));
    reject(&deletion, 503, "PS019");
    assert_eq!(db.sql(&format!("SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{box_id}' AND item_id='{item_id}'")), "0");
    let fetched = runtime.block_on(sdk.get_item(box_id, item_id)).unwrap();
    assert_eq!(key.decrypt_item(&fetched, &context).unwrap(), item);
    db.sql("DROP TRIGGER passshare_delete_fault ON encrypted_item_tombstones; DROP FUNCTION passshare_delete_fault();");

    // State/row epoch inconsistencies are also synthetic setup, never a claim
    // that rotation exists. Both sides must match the active epoch to delete.
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id='{box_id}'"
    ));
    reject(&json!({"expectedVersion":1,"keyEpoch":2}), 409, "PS056");
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=1 WHERE box_id='{box_id}'"
    ));

    // DB constraints defend direct metadata writes independently of the HTTP
    // planner. All statements here touch only this disposable fixture's box.
    for values in [
        format!("'{box_id}','{item_id}',0,1"),
        format!("'{box_id}','{item_id}',9007199254740992,1"),
        format!("'{box_id}','{item_id}',1,0"),
        format!("'{box_id}','{item_id}',1,9007199254740992"),
        format!("'{box_id}','INVALID',1,1"),
        format!("'INVALID','{item_id}',1,1"),
    ] {
        db.sql(&format!("DO $$ BEGIN BEGIN INSERT INTO encrypted_item_tombstones(box_id,item_id,last_live_version,key_epoch) VALUES({values}); RAISE EXCEPTION 'invalid tombstone accepted'; EXCEPTION WHEN check_violation THEN NULL; END; END $$;"));
    }
    runtime
        .block_on(sdk.delete_item(box_id, item_id, 1, 1))
        .unwrap();
    let error = runtime.block_on(sdk.get_item(box_id, item_id)).unwrap_err();
    assert_eq!(
        (error.status(), error.code()),
        (Some(404), Some("PS012")),
        "GET retains its existing error code"
    );
    assert!(!runtime
        .block_on(sdk.list(box_id, None))
        .unwrap()
        .items
        .iter()
        .any(|entry| entry.item_id.as_str() == item_id));
    assert!(live_snapshot().is_empty());
    let tombstone: Value = serde_json::from_str(&db.sql(&format!(
        "SELECT to_jsonb(t)::text FROM encrypted_item_tombstones t WHERE box_id='{box_id}' AND item_id='{item_id}'"
    ))).unwrap();
    assert_eq!(
        tombstone,
        json!({"box_id":box_id,"item_id":item_id,"last_live_version":1,"key_epoch":1})
    );
    assert_eq!(db.sql("SELECT string_agg(column_name,',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='encrypted_item_tombstones'"), "box_id,item_id,last_live_version,key_epoch", "no envelope, nonce, secret, ciphertext or key column");
    // The SDK accepts the replay, and the independent raw HTTP helper observes
    // that the formal Node adapter sends exactly zero bytes after its headers.
    runtime
        .block_on(sdk.delete_item(box_id, item_id, 1, 1))
        .unwrap();
    assert_eq!(
        http_bytes(p, "DELETE", &path, &headers, &deletion),
        (204, Vec::new())
    );
    let csrf = ConnectId::generate().unwrap();
    let cookie = format!(
        "Cookie: passshare_session={session}; passshare_csrf={csrf}\r\nx-csrf-token: {csrf}\r\n"
    );
    assert_eq!(
        http_bytes(p, "DELETE", &path, &cookie, &deletion),
        (204, Vec::new())
    );
    for (version, epoch, code) in [(2, 1, "PS015"), (1, 2, "PS056")] {
        let error = runtime
            .block_on(sdk.delete_item(box_id, item_id, version, epoch))
            .unwrap_err();
        assert_eq!((error.status(), error.code()), (Some(409), Some(code)));
    }
    let error = runtime
        .block_on(sdk.put_item(box_id, item_id, 0, &envelope))
        .unwrap_err();
    assert_eq!((error.status(), error.code()), (Some(409), Some("PS015")));
    let updated_context = ItemContext {
        item_version: 2,
        ..context.clone()
    };
    let mut updated_item = item.clone();
    updated_item["version"] = json!(2);
    let updated_envelope = key.encrypt_item(&updated_item, &updated_context).unwrap();
    let error = runtime
        .block_on(sdk.put_item(box_id, item_id, 1, &updated_envelope))
        .unwrap_err();
    assert_eq!((error.status(), error.code()), (Some(409), Some("PS015")));
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id='{box_id}'"
    ));
    let error = runtime
        .block_on(sdk.delete_item(box_id, item_id, 1, 2))
        .unwrap_err();
    assert_eq!(
        (error.status(), error.code()),
        (Some(409), Some("PS056")),
        "old tombstone must not replay in a new epoch"
    );
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=1 WHERE box_id='{box_id}'"
    ));
    assert_eq!(
        runtime.block_on(sdk.state(box_id)).unwrap(),
        passshare_connect::BoxState::Encrypted { key_epoch: 1 }
    );
    assert_eq!(
        http(
            p,
            "GET",
            &format!("/v1/vaults/{box_id}/items"),
            &format!("Authorization: Bearer {connect}\r\n"),
            &Value::Null
        )
        .0,
        409
    );
    let retained: Value = serde_json::from_str(&db.sql(&format!("SELECT to_jsonb(t)::text FROM encrypted_item_tombstones t WHERE box_id='{box_id}' AND item_id='{item_id}'"))).unwrap();
    assert_eq!(
        retained, tombstone,
        "replays and conflicts leave metadata unchanged"
    );

    // Both HTTP requests begin from one barrier with the same live revision.
    // Only one wins; a winning update must be decryptable as the complete DTO,
    // and a winning delete must leave a tombstone and no live ciphertext.
    let race_context = ItemContext {
        item_id: ConnectId::generate().unwrap(),
        ..context.clone()
    };
    let race_id = race_context.item_id.as_str();
    let race_path = format!("{root}/items/{race_id}");
    let mut race_item = item.clone();
    race_item["id"] = json!(race_id);
    let race_envelope = key.encrypt_item(&race_item, &race_context).unwrap();
    runtime
        .block_on(sdk.put_item(box_id, race_id, 0, &race_envelope))
        .unwrap();
    let race_next_context = ItemContext {
        item_version: 2,
        ..race_context.clone()
    };
    let mut race_next_item = race_item.clone();
    race_next_item["version"] = json!(2);
    let race_next_envelope = key
        .encrypt_item(&race_next_item, &race_next_context)
        .unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let requests = [
        ("DELETE", deletion.clone()),
        (
            "PUT",
            json!({"expectedVersion":1,"envelope":race_next_envelope}),
        ),
    ];
    let handles = requests
        .into_iter()
        .map(|(method, body)| {
            let path = race_path.clone();
            let headers = headers.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                http(p, method, &path, &headers, &body)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    let raced_live = runtime.block_on(sdk.get_item(box_id, race_id));
    let raced_tombstone = db.sql(&format!("SELECT last_live_version::text || ':' || key_epoch::text FROM encrypted_item_tombstones WHERE box_id='{box_id}' AND item_id='{race_id}'"));
    match (outcomes[0].0, outcomes[1].0) {
        (204, 409) => {
            assert!(outcomes[0].1.is_null());
            assert_eq!(outcomes[1].1["error"], "PS015");
            assert_eq!(raced_live.unwrap_err().status(), Some(404));
            assert_eq!(raced_tombstone, "1:1");
            assert!(!runtime
                .block_on(sdk.list(box_id, None))
                .unwrap()
                .items
                .iter()
                .any(|entry| entry.item_id.as_str() == race_id));
        }
        (409, 200) => {
            assert_eq!(outcomes[0].1["error"], "PS015");
            let stored = raced_live.unwrap();
            assert_eq!(stored, race_next_envelope);
            assert_eq!(
                key.decrypt_item(&stored, &race_next_context).unwrap(),
                race_next_item
            );
            assert!(raced_tombstone.is_empty());
            runtime
                .block_on(sdk.delete_item(box_id, race_id, 2, 1))
                .unwrap();
        }
        statuses => panic!("delete/update CAS must have one winner: {statuses:?}"),
    }
    assert_eq!(db.sql(&format!("SELECT count(*) FROM encrypted_items WHERE box_id='{box_id}' AND item_id IN ('{item_id}','{race_id}')")), "0");
    // A confirmed member with the formal current grant can delete/replay.
    // Synthetic removal then denies replay despite the matching tombstone.
    let member_context = ItemContext {
        item_id: ConnectId::generate().unwrap(),
        ..context.clone()
    };
    let mut member_item = item.clone();
    member_item["id"] = json!(member_context.item_id);
    let member_envelope = shared_key
        .encrypt_item(&member_item, &member_context)
        .unwrap();
    runtime
        .block_on(sdk.put_item(box_id, member_context.item_id.as_str(), 0, &member_envelope))
        .unwrap();
    let fetched = acceptance_result(
        runtime.block_on(
            member_identity
                .sdk
                .get_item(box_id, member_context.item_id.as_str()),
        ),
        "granted member item GET before delete",
    );
    assert!(
        fetched == member_envelope
            && shared_key.decrypt_item(&fetched, &member_context).unwrap() == member_item
    );
    let member_path = format!("{root}/items/{}", member_context.item_id);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let concurrent = (0..2)
        .map(|_| {
            let barrier = barrier.clone();
            let path = member_path.clone();
            let headers = member_headers.clone();
            let body = deletion.clone();
            thread::spawn(move || {
                barrier.wait();
                http_bytes(p, "DELETE", &path, &headers, &body)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    for response in concurrent {
        assert_eq!(response.join().unwrap(), (204, Vec::new()));
    }
    assert_eq!(db.sql(&format!("SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{box_id}' AND item_id='{}'",member_context.item_id)),"1");
    let before_replay = acceptance_state_hash(db);
    acceptance_result(
        runtime.block_on(member_identity.sdk.delete_item(
            box_id,
            member_context.item_id.as_str(),
            1,
            1,
        )),
        "granted member DELETE replay",
    );
    assert_eq!(
        acceptance_state_hash(db),
        before_replay,
        "member DELETE replay preserves all rows/xmin"
    );
    db.sql(&format!(
        "DELETE FROM vault_memberships WHERE user_id='{member}' AND vault_id='{box_id}'"
    ));
    let before_removed = acceptance_state_hash(db);
    assert_eq!(
        http(p, "DELETE", &member_path, &member_headers, &deletion).0,
        403
    );
    assert_eq!(acceptance_state_hash(db), before_removed);
    accept_waiting_delete_revocation(db, p, key, original_item);
    println!("encrypted delete: SDK 204, empty wire reply, full DTO preservation, strict metadata, auth/CSRF, synthetic rollback/epoch/DB constraints, GET/list absence, replay, reserved ID, encrypted boundary and synchronized delete/update CAS passed");
}

struct HeldBox {
    child: Child,
}
impl HeldBox {
    fn start(db: &Database, box_id: &str, label: &str) -> Self {
        let mut child = db
            .psql(true, Some(label))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        writeln!(child.stdin.as_mut().unwrap(), "SET statement_timeout=12000; SET idle_in_transaction_session_timeout=15000; BEGIN; SELECT id FROM connect_vaults WHERE id='{box_id}' FOR UPDATE;").unwrap();
        child.stdin.as_mut().unwrap().flush().unwrap();
        Self { child }
    }
    fn commit(&mut self) {
        writeln!(self.child.stdin.as_mut().unwrap(), "COMMIT;\\q").unwrap();
        self.child.stdin.as_mut().unwrap().flush().unwrap();
        drop(self.child.stdin.take());
    }
}
impl Drop for HeldBox {
    fn drop(&mut self) {
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = writeln!(stdin, "ROLLBACK;\\q");
        }
        if !reap_before(
            &mut self.child,
            std::time::Instant::now() + Duration::from_secs(3),
        ) {
            let _ = self.child.kill();
            if !reap_before(
                &mut self.child,
                std::time::Instant::now() + Duration::from_secs(2),
            ) {
                CLEANUP_FAILED.store(true, Ordering::SeqCst);
                eprintln!("owned SQL holder did not exit within cleanup deadline");
            }
        }
    }
}
fn reap_before(child: &mut Child, deadline: std::time::Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Err(_) => return false,
            Ok(None) => {}
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
}
fn wait_db(db: &Database, sql: &str) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if db.sql_before(sql, deadline) == "t" {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
}
fn accept_waiting_delete_revocation(db: &Database, p: u16, key: &PasswordBoxKey, original: &Value) {
    let (session, _, box_id) = signup(p);
    let headers = format!("Authorization: Bearer {session}\r\n");
    let root = format!("/api/encrypted/boxes/{box_id}");
    assert_eq!(
        http(
            p,
            "POST",
            &format!("{root}/enable"),
            &headers,
            &json!({"keyEpoch":1})
        )
        .0,
        200
    );
    let context = ItemContext {
        password_box_id: box_id.parse().unwrap(),
        item_id: ConnectId::generate().unwrap(),
        item_version: 1,
        key_epoch: 1,
    };
    let mut item = original.clone();
    item["id"] = json!(context.item_id);
    item["vault"]["id"] = json!(box_id);
    item["version"] = json!(1);
    let envelope = key.encrypt_item(&item, &context).unwrap();
    let path = format!("{root}/items/{}", context.item_id);
    assert_eq!(
        http(
            p,
            "PUT",
            &path,
            &headers,
            &json!({"expectedVersion":0,"envelope":envelope})
        )
        .0,
        200
    );
    let label = format!("passshare-delete-held-{}", context.item_id);
    let mut held = HeldBox::start(db, &box_id, &label);
    assert!(wait_db(db,&format!("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{label}' AND state='idle in transaction')")),"synthetic holder must have acquired the box lock");
    let request = thread::spawn(move || {
        http(
            p,
            "DELETE",
            &path,
            &headers,
            &json!({"expectedVersion":1,"keyEpoch":1}),
        )
    });
    let waiting=wait_db(db,"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT passshare_encrypted_operation(%')");
    // Synthetic direct session revocation, committed while DELETE demonstrably
    // waits before its authoritative session check. This is not a logout claim.
    db.sql(&format!("DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner')"));
    held.commit();
    let reply = request.join().unwrap();
    assert!(
        waiting,
        "the API must be waiting on the held DB lock before revocation"
    );
    assert_eq!((reply.0, reply.1["error"].as_str()), (401, Some("PS024")));
    let stored: Value = serde_json::from_str(&db.sql(&format!(
        "SELECT envelope::text FROM encrypted_items WHERE box_id='{box_id}' AND item_id='{}'",
        context.item_id
    )))
    .unwrap();
    assert_eq!(stored, serde_json::to_value(envelope).unwrap());
    assert_eq!(
        db.sql(&format!(
            "SELECT count(*) FROM encrypted_item_tombstones WHERE box_id='{box_id}'"
        )),
        "0"
    );
    println!("encrypted delete: DB-observed waiter rejects committed synthetic session revocation and preserves ciphertext without a tombstone");
}

fn accept_atomic_setup(db: &Database, p: u16) {
    let (session, connect, box_id, _) = signup_with_password(p);
    let actor = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner'"
    ));
    let headers = format!("Authorization: Bearer {session}\r\n");
    let root = format!("/api/encrypted/boxes/{box_id}");
    let setup = format!("{root}/setup");
    let key = PasswordBoxKey::generate().unwrap();
    let password = format!("setup-password-{}", ConnectId::generate().unwrap());
    let salt = generate_salt().unwrap();
    let master = owner_master(&password, &salt).unwrap();
    let ctx = owner_context(&box_id, &actor, 1);
    let bundle = owner_bundle(&key, &master, salt, &ctx);
    let body = json!({"bundle":bundle});
    for credentials in [
        String::new(),
        format!("Authorization: Bearer {connect}\r\n"),
    ] {
        assert_eq!(http(p, "POST", &setup, &credentials, &body).0, 401);
    }
    let (stranger, stranger_connect, stranger_box) = signup(p);
    let stranger_actor=db.sql(&format!("SELECT user_id::text FROM vault_memberships WHERE vault_id='{stranger_box}' AND role='owner'"));
    let stranger_body =
        json!({"bundle":owner_bundle(&key,&master,salt,&owner_context(&box_id,&stranger_actor,1))});
    assert_eq!(
        http(
            p,
            "POST",
            &setup,
            &format!("Authorization: Bearer {stranger}\r\n"),
            &stranger_body
        )
        .0,
        403
    );
    for client in [
        "",
        "x-passshare-client: mobile\r\n",
        "x-passshare-client: extension\r\n",
    ] {
        assert_eq!(
            http(
                p,
                "POST",
                &setup,
                &format!("Cookie: passshare_session={session}\r\n{client}"),
                &body
            )
            .0,
            403
        );
    }
    for pointer in ["", "/bundle", "/bundle/wrapped", "/bundle/wrapped/context"] {
        let mut bad = body.clone();
        bad.pointer_mut(pointer).unwrap()["password"] = json!("forbidden");
        assert_eq!(http(p, "POST", &setup, &headers, &bad).0, 400);
    }
    // This failure occurs AFTER activation's INSERT, inside the same function.
    db.sql(&format!("CREATE FUNCTION passshare_setup_fault() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN IF NEW.box_id='{box_id}' THEN RAISE EXCEPTION 'synthetic bundle insert failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER passshare_setup_fault BEFORE INSERT ON encrypted_owner_keys FOR EACH ROW EXECUTE FUNCTION passshare_setup_fault();"));
    assert_eq!(http(p, "POST", &setup, &headers, &body).0, 503);
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_box_state WHERE box_id='{box_id}')+(SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{box_id}')")),"0","failed bundle write must roll back activation");
    assert_eq!(
        http(p, "GET", &root, &headers, &Value::Null).1["mode"],
        "compatibility"
    );
    db.sql("DROP TRIGGER passshare_setup_fault ON encrypted_owner_keys; DROP FUNCTION passshare_setup_fault();");
    let csrf = ConnectId::generate().unwrap();
    let cookie = format!(
        "Cookie: passshare_session={session}; passshare_csrf={csrf}\r\nx-csrf-token: {csrf}\r\n"
    );
    let (status, created) = http(p, "POST", &setup, &cookie, &body);
    assert_eq!(status, 200);
    assert_eq!(
        created,
        json!({"mode":"encrypted","keyEpoch":1,"bundleVersion":1,"bundle":bundle})
    );
    // A lost first response is reconciled with the identical ciphertext. New
    // random wrapping or key generation is a conflicting operation.
    assert_eq!(
        http(p, "POST", &setup, &headers, &body),
        (200, created.clone())
    );
    let different = json!({"bundle":owner_bundle(&key,&master,salt,&ctx)});
    assert_eq!(http(p, "POST", &setup, &headers, &different).0, 409);
    let fetched = http(
        p,
        "GET",
        &format!("{root}/owner-key"),
        &headers,
        &Value::Null,
    );
    assert_eq!(fetched, (200, json!({"bundleVersion":1,"bundle":bundle})));
    let reopened = unwrap_bundle(&fetched.1["bundle"], &password, &ctx).unwrap();
    let item_ctx = ItemContext {
        password_box_id: box_id.parse().unwrap(),
        item_id: ConnectId::generate().unwrap(),
        item_version: 1,
        key_epoch: 1,
    };
    let item = json!({"id":item_ctx.item_id,"version":item_ctx.item_version,
        "vault":{"id":item_ctx.password_box_id},"title":"Atomic setup",
        "fields":[{"value":ConnectId::generate().unwrap()}],"retained":[3,1,2]});
    let envelope = key.encrypt_item(&item, &item_ctx).unwrap();
    let item_path = format!("{root}/items/{}", item_ctx.item_id);
    assert_eq!(
        http(
            p,
            "PUT",
            &item_path,
            &headers,
            &json!({"expectedVersion":0,"envelope":envelope})
        )
        .0,
        200
    );
    let (status, stored_item) = http(p, "GET", &item_path, &headers, &Value::Null);
    assert_eq!(status, 200);
    assert_eq!(
        reopened
            .decrypt_item(&serde_json::from_value(stored_item).unwrap(), &item_ctx)
            .unwrap(),
        item
    );
    assert_eq!(
        http(p, "POST", &setup, &headers, &body),
        (200, created),
        "exact replay remains safe after item writes"
    );

    // Different initial keys race from the same barrier; the losing key must
    // never replace the winner or produce an orphaned activation.
    let (race_session, _, race_box, race_password) = signup_with_password(p);
    let race_actor = db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{race_box}' AND role='owner'"
    ));
    let race_ctx = owner_context(&race_box, &race_actor, 1);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let bodies = [
        json!({"bundle":owner_bundle(&key,&master,salt,&race_ctx)}),
        json!({"bundle":owner_bundle(&PasswordBoxKey::generate().unwrap(),&master,salt,&race_ctx)}),
    ];
    let handles = bodies
        .iter()
        .map(|body| {
            let body = body.clone();
            let path = format!("/api/encrypted/boxes/{race_box}/setup");
            let headers = format!("Authorization: Bearer {race_session}\r\n");
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                http(p, "POST", &path, &headers, &body)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(outcomes.iter().filter(|o| o.0 == 200).count(), 1);
    assert_eq!(outcomes.iter().filter(|o| o.0 == 409).count(), 1);
    let winner = outcomes.iter().find(|o| o.0 == 200).unwrap();
    let persisted = http(
        p,
        "GET",
        &format!("/api/encrypted/boxes/{race_box}/owner-key"),
        &format!("Authorization: Bearer {race_session}\r\n"),
        &Value::Null,
    );
    assert_eq!(persisted.1["bundle"], winner.1["bundle"]);
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_box_state WHERE box_id='{race_box}')+(SELECT count(*) FROM encrypted_owner_keys WHERE box_id='{race_box}')")),"2");

    // These states are separate from the older enable function's acceptance.
    let stranger_headers = format!("Authorization: Bearer {stranger}\r\n");
    assert_eq!(
        http(
            p,
            "POST",
            &format!("/v1/vaults/{stranger_box}/items"),
            &format!("Authorization: Bearer {stranger_connect}\r\n"),
            &json!({"title":"Retained compatibility fixture","category":"LOGIN"})
        )
        .0,
        201
    );
    let nonempty = json!({"bundle":owner_bundle(&key,&master,salt,&owner_context(&stranger_box,&stranger_actor,1))});
    assert_setup_rejected_intact(db, p, &stranger_box, &stranger_headers, &nonempty, "PS055");

    // Synthetic epoch/state inconsistency isolates setup's generation boundary.
    db.sql(&format!(
        "UPDATE encrypted_box_state SET key_epoch=2 WHERE box_id='{box_id}'"
    ));
    assert_setup_rejected_intact(db, p, &box_id, &headers, &body, "PS056");
    db.sql(&format!("UPDATE encrypted_box_state SET key_epoch=1 WHERE box_id='{box_id}'; DELETE FROM encrypted_owner_keys WHERE box_id='{box_id}'"));
    assert_setup_rejected_intact(db, p, &box_id, &headers, &body, "PS015");

    // The old synthetic owner reassignment is not a successful encrypted
    // transfer. Confirm a real member, then require the formal legacy fence.
    let (status, me) = http(p, "GET", "/api/auth/me", &stranger_headers, &Value::Null);
    assert_eq!(status, 200);
    let race_headers = format!("Authorization: Bearer {race_session}\r\n");
    confirm_acceptance_member(
        p,
        &race_box,
        &race_headers,
        &stranger_headers,
        me["user"]["email"].as_str().unwrap(),
    );
    let before_transfer = acceptance_state_hash(db);
    let denied = http(
        p,
        "POST",
        &format!("/api/auth/vaults/{race_box}/ownership"),
        &race_headers,
        &json!({"currentPassword":race_password,"targetUserId":stranger_actor}),
    );
    assert_eq!((denied.0, denied.1["error"].as_str()), (409, Some("PS015")));
    assert_eq!(
        acceptance_state_hash(db),
        before_transfer,
        "refused setup-box transfer preserves all full rows/xmin"
    );
    let replacement = json!({"bundle":owner_bundle(&key,&master,salt,&owner_context(&race_box,&stranger_actor,1))});
    assert_eq!(
        http(
            p,
            "POST",
            &format!("/api/encrypted/boxes/{race_box}/setup"),
            &stranger_headers,
            &replacement
        )
        .0,
        403,
        "confirmed target cannot replace the retained owner's setup"
    );
    assert_eq!(acceptance_state_hash(db), before_transfer);
    assert_eq!(
        http(
            p,
            "GET",
            &format!("/api/encrypted/boxes/{race_box}/owner-key"),
            &race_headers,
            &Value::Null
        ),
        persisted
    );
    println!("atomic setup: authorization/CSRF, strict public headers, post-activation failure rollback, exact replay, different-key rejection, full item decrypt and synchronized concurrent initialization passed");
}

fn assert_setup_rejected_intact(
    db: &Database,
    p: u16,
    box_id: &str,
    headers: &str,
    body: &Value,
    code: &str,
) {
    let before = acceptance_state_hash(db);
    let (status, error) = http(
        p,
        "POST",
        &format!("/api/encrypted/boxes/{box_id}/setup"),
        headers,
        body,
    );
    assert_eq!((status, error["error"].as_str()), (409, Some(code)));
    assert_eq!(
        acceptance_state_hash(db),
        before,
        "rejected setup must preserve every full account/box row and xmin"
    );
}

#[cfg(test)]
mod contract_tests {
    #[test]
    fn sql_diagnostics_emit_only_states_and_allowlisted_dependencies() {
        let errors = sql_error_metadata("psql:<stdin>:1: ERROR:  42P01: relation \"passshare_fixture_owner\" does not exist\nCONTEXT: secret token\npsql:<stdin>:2: ERROR:  42883: function public.passshare_attachment_shape(secret arguments) does not exist\npsql:<stdin>:3: ERROR:  42P01: relation \"secret_value\" does not exist\npsql:<stdin>:4: ERROR:  22012: secret_value");
        assert_eq!(
            errors,
            vec![
                ("42P01".into(), Some("passshare_fixture_owner".into())),
                ("42883".into(), Some("passshare_attachment_shape".into())),
                ("42P01".into(), None),
                ("22012".into(), None),
            ]
        );
        assert!(sql_error_metadata("CONTEXT: relation \"passshare_fixture_owner\" does not exist\nERROR:  secret: parameters").is_empty());
    }
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64;

    fn sql_child(mode: &str) -> Command {
        let mut cmd = command(std::env::current_exe().unwrap().to_str().unwrap());
        cmd.args([
            "--ignored",
            "--exact",
            "contract_tests::sql_transport_child",
            "--nocapture",
        ])
        .env("PASSSHARE_SQL_CHILD_CONTROL", mode);
        cmd
    }

    #[test]
    #[ignore = "subprocess control invoked only by the SQL transport tests"]
    fn sql_transport_child() {
        match std::env::var("PASSSHARE_SQL_CHILD_CONTROL")
            .expect("explicit SQL child control")
            .as_str()
        {
            "drain" => {
                // Fill BOTH output pipes before consuming input. Sequential I/O
                // deadlocks on this control even though the process is healthy.
                std::io::stdout()
                    .write_all(&vec![b'Z'; 300 * 1024])
                    .unwrap();
                std::io::stderr()
                    .write_all(&vec![b'E'; 300 * 1024])
                    .unwrap();
                let mut input = Vec::new();
                std::io::stdin().read_to_end(&mut input).unwrap();
                assert!(input.len() > 256 * 1024);
                assert!(input.ends_with(b" \\gexec\n"));
            }
            "blocked" => thread::sleep(Duration::from_secs(30)),
            "reject" => std::process::exit(7),
            "overflow" => {
                let _ = std::io::stdout().write_all(&vec![b'Z'; 8 * 1024 * 1024 + 1]);
            }
            _ => panic!("unknown SQL child control"),
        }
    }

    #[test]
    fn sql_transport_drains_both_outputs_while_writing_large_input() {
        let reply = fixture_sql(
            sql_child("drain"),
            &"x".repeat(300 * 1024),
            std::time::Instant::now() + Duration::from_secs(5),
        )
        .expect("concurrent transport success control");
        assert_eq!(reply.bytes().filter(|b| *b == b'Z').count(), 300 * 1024);
    }

    #[test]
    fn sql_transport_deadline_covers_a_blocked_writer_and_reaps_child() {
        let start = std::time::Instant::now();
        let reply = fixture_sql(
            sql_child("blocked"),
            &"x".repeat(2 * 1024 * 1024),
            start + Duration::from_millis(400),
        );
        assert!(matches!(reply, Err("exceeded its deadline")));
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn sql_transport_rejects_early_exit_and_output_overflow() {
        for (mode, expected) in [
            ("reject", "input write failed"),
            ("overflow", "output exceeded bound"),
        ] {
            let input = if mode == "overflow" {
                "SELECT 1".to_owned()
            } else {
                "x".repeat(2 * 1024 * 1024)
            };
            let reply = fixture_sql(
                sql_child(mode),
                &input,
                std::time::Instant::now() + Duration::from_secs(5),
            );
            assert!(matches!(reply, Err(reason) if reason == expected));
        }
        assert!(matches!(
            fixture_sql(
                command("unused-sql-client"),
                "SELECT 1",
                std::time::Instant::now()
            ),
            Err("exceeded its deadline")
        ));
    }

    #[test]
    #[ignore = "requires PASSSHARE_SQL_FIXTURE_MANIFEST naming an owned PostgreSQL 16 fixture"]
    fn sql_transport_live_large_sql_preserves_single_request_semantics() {
        let manifest = PathBuf::from(
            std::env::var_os("PASSSHARE_SQL_FIXTURE_MANIFEST")
                .expect("explicit owned PostgreSQL fixture manifest required"),
        );
        assert!(manifest.is_absolute());
        let local = local_postgres::LocalPostgres::start(&manifest);
        let db = Database::from_local(local, "source");
        // The invocation owns this fresh DB. Bind its purpose outside public,
        // just as restore acceptance does, and retain the standard Drop cleanup.
        println!("SQL transport live owned_database={}", db.name);
        println!("SQL transport live step=bind");
        db.sql("CREATE SCHEMA passshare_acceptance_control; CREATE TABLE passshare_acceptance_control.binding AS SELECT 'sql-transport-regression'::text AS purpose, owner_id, current_database() AS database_name FROM passshare_fixture_owner; CREATE TABLE sql_transport_fixture(id integer PRIMARY KEY, payload text)");
        assert_eq!(db.sql("SELECT purpose='sql-transport-regression' AND database_name=current_database() AND owner_id=(SELECT owner_id FROM passshare_fixture_owner) FROM passshare_acceptance_control.binding"), "t");
        let payload = format!(
            "';\\q\n$$ :name /* BEGIN; COMMIT */ 日本語{}",
            "x".repeat(300 * 1024)
        );
        let quoted = payload.replace('\'', "''");
        let sql = format!("INSERT INTO sql_transport_fixture VALUES(1,'{quoted}'); SELECT octet_length(payload)::text || ':' || md5(payload) FROM sql_transport_fixture WHERE id=1");
        assert!(sql.len() > 256 * 1024);
        println!("SQL transport live step=large_insert");
        let reply = db.sql(&sql);
        assert!(reply.starts_with(&format!("{}:", payload.len())));
        // Compare the full stored value without putting it in assertion output.
        println!("SQL transport live step=large_compare");
        assert_eq!(
            db.sql(&format!(
                "SELECT payload='{quoted}' FROM sql_transport_fixture WHERE id=1"
            )),
            "t"
        );
        println!("SQL transport live step=transaction_ids");
        let txids = db.sql("SELECT txid_current(); SELECT txid_current()");
        let txids = txids.lines().collect::<Vec<_>>();
        assert!(txids.len() == 2 && txids[0] == txids[1]);
        assert_eq!(
            db.sql("SELECT 'first'; SELECT 'last'")
                .lines()
                .collect::<Vec<_>>(),
            ["first", "last"]
        );
        println!("SQL transport live: large input and multi-results passed");

        let execute = |sql: &str| {
            let mut cmd = db.psql(true, None);
            cmd.args(["-f", "-", "-v", "ECHO=none", "-v", "VERBOSITY=verbose"]);
            fixture_sql(
                cmd,
                sql,
                std::time::Instant::now() + Duration::from_secs(15),
            )
        };
        assert!(
            execute("INSERT INTO sql_transport_fixture VALUES(2,'implicit'); SELECT 1/0").is_err()
        );
        assert_eq!(
            db.sql("SELECT count(*) FROM sql_transport_fixture WHERE id=2"),
            "0"
        );
        assert!(execute("CREATE TABLE sql_transport_rollback(id integer); SELECT 1/0").is_err());
        assert_eq!(
            db.sql("SELECT to_regclass('sql_transport_rollback') IS NULL"),
            "t"
        );
        println!("SQL transport live: implicit DML/DDL rollback passed");
        assert_eq!(db.sql("BEGIN; INSERT INTO sql_transport_fixture VALUES(3,'rollback'); SELECT 'rollback-result'; ROLLBACK"), "rollback-result");
        assert_eq!(
            db.sql("SELECT count(*) FROM sql_transport_fixture WHERE id=3"),
            "0"
        );
        assert!(execute(
            "BEGIN; INSERT INTO sql_transport_fixture VALUES(4,'committed'); COMMIT; SELECT 1/0"
        )
        .is_err());
        assert_eq!(
            db.sql("SELECT count(*) FROM sql_transport_fixture WHERE id=4"),
            "1"
        );
        println!("SQL transport live: explicit rollback/commit passed");
        assert_eq!(db.sql("VACUUM sql_transport_fixture"), "");
        println!("SQL transport live: nontransaction operation passed");
        db.sql("DO $$ BEGIN IF (SELECT count(*) FROM sql_transport_fixture)<>2 THEN RAISE EXCEPTION 'synthetic count mismatch'; END IF; END $$");
        drop(db);
        assert!(!CLEANUP_FAILED.load(Ordering::SeqCst));
        println!("SQL transport: >256KiB payload, exact bytes, one implicit transaction, multi-results, DDL rollback, explicit rollback/commit, nontransaction command and owned DB cleanup passed");
    }

    #[test]
    fn cli_modes_are_exact_and_image_values_cannot_be_docker_options() {
        assert!(matches!(
            Mode::parse(&["native.exe".into()]),
            Ok(Mode::Node(_))
        ));
        assert!(matches!(
            Mode::parse(&["--image".into(), "passshare1163-api:fixture".into()]),
            Ok(Mode::Image(_))
        ));
        for args in [
            vec![],
            vec!["--image"],
            vec!["--image", "--privileged"],
            vec!["--image", "tag --env extra"],
            vec!["--image", "tag", "extra"],
            vec!["binary", "extra"],
            vec!["--unknown"],
        ] {
            assert!(Mode::parse(&args.into_iter().map(Into::into).collect::<Vec<_>>()).is_err());
        }
    }

    fn native_plan(context: &ItemContext, envelope: &Value) -> Value {
        passshare_mutations::dispatch(&json!({"command":"encrypted-plan","operation":"put",
            "actor":"synthetic","session":"synthetic","boxId":context.password_box_id,
            "itemId":context.item_id,"request":{"expectedVersion":context.item_version-1,"envelope":envelope}}))
    }
    fn context(version: u64, epoch: u64) -> ItemContext {
        ItemContext {
            password_box_id: ConnectId::generate().unwrap(),
            item_id: ConnectId::generate().unwrap(),
            item_version: version,
            key_epoch: epoch,
        }
    }
    fn item(context: &ItemContext) -> Value {
        json!({"id":context.item_id,"version":context.item_version,"vault":{"id":context.password_box_id},"payload":""})
    }
    #[test]
    fn core_real_envelopes_match_host_contract_at_numeric_and_size_boundaries() {
        let key = PasswordBoxKey::generate().unwrap();
        for context in [
            context(1, 1),
            context(9_007_199_254_740_991, 9_007_199_254_740_991),
        ] {
            let original = item(&context);
            let envelope = key.encrypt_item(&original, &context).unwrap();
            let plan = native_plan(&context, &serde_json::to_value(&envelope).unwrap());
            assert_eq!(plan["status"], 200);
            assert_eq!(
                plan["body"]["params"][6],
                serde_json::to_value(&envelope).unwrap()
            );
            assert_eq!(key.decrypt_item(&envelope, &context).unwrap(), original);
        }
        let context = context(1, 1);
        let mut original = item(&context);
        let overhead = serde_json::to_vec(&original).unwrap().len();
        original["payload"] = json!("a".repeat(1024 * 1024 - overhead));
        assert_eq!(serde_json::to_vec(&original).unwrap().len(), 1024 * 1024);
        let envelope = key.encrypt_item(&original, &context).unwrap();
        assert_eq!(
            BASE64.decode(&envelope.ciphertext).unwrap().len(),
            1024 * 1024 + 16
        );
        assert_eq!(
            native_plan(&context, &serde_json::to_value(&envelope).unwrap())["status"],
            200
        );
        original["payload"] = json!("a".repeat(1024 * 1024 - overhead + 1));
        assert!(key.encrypt_item(&original, &context).is_err());
        let mut too_large = serde_json::to_value(&envelope).unwrap();
        too_large["ciphertext"] = json!(BASE64.encode(vec![0u8; 1024 * 1024 + 17]));
        assert_eq!(native_plan(&context, &too_large)["status"], 400);
    }
    #[test]
    fn core_real_owner_bundle_matches_host_contract_and_rejects_scope_changes() {
        let owner = "7b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10";
        let box_id = ConnectId::generate().unwrap();
        let key = PasswordBoxKey::generate().unwrap();
        let salt = generate_salt().unwrap();
        let password = format!("synthetic-{}", ConnectId::generate().unwrap());
        let master = owner_master(&password, &salt).unwrap();
        let context = owner_context(box_id.as_str(), owner, 1);
        let bundle = owner_bundle(&key, &master, salt, &context);
        let plan = |actor: &str, bundle: &Value| {
            passshare_mutations::dispatch(&json!({"command":"owner-key-plan","operation":"put",
                "actor":actor,"session":"synthetic","boxId":box_id,
                "request":{"expectedVersion":0,"bundle":bundle}}))
        };
        let accepted = plan(owner, &bundle);
        assert_eq!(accepted["status"], 200);
        assert_eq!(accepted["body"]["params"][5], bundle);
        assert!(unwrap_bundle(&bundle, &password, &context).is_ok());
        assert_eq!(
            plan("8b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10", &bundle)["status"],
            400
        );
        let mut extra = bundle.clone();
        extra["kdf"] = json!({"memoryKiB":8});
        assert_eq!(plan(owner, &extra)["status"], 400);
    }
    #[test]
    fn host_rejects_extra_fields_and_malformed_types_on_real_core_envelopes() {
        let context = context(1, 1);
        let key = PasswordBoxKey::generate().unwrap();
        let envelope =
            serde_json::to_value(key.encrypt_item(&item(&context), &context).unwrap()).unwrap();
        for pointer in ["", "/context"] {
            for name in ["key", "plaintext", "realm"] {
                let mut changed = envelope.clone();
                changed.pointer_mut(pointer).unwrap()[name] = json!("forbidden");
                assert_eq!(native_plan(&context, &changed)["status"], 400);
            }
        }
        for (pointer, value) in [
            ("/format", json!(1.0)),
            ("/context/itemVersion", json!("1")),
            ("/context/keyEpoch", json!(0)),
        ] {
            let mut changed = envelope.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert_eq!(native_plan(&context, &changed)["status"], 400);
        }
    }
    #[test]
    #[ignore = "requires PASSSHARE_SQL_FIXTURE_MANIFEST naming the owned PostgreSQL 16 fixture"]
    fn sql_transport_repeated_owned_reads_diagnose_connection_failures() {
        let manifest = PathBuf::from(
            std::env::var_os("PASSSHARE_SQL_FIXTURE_MANIFEST").expect("owned manifest required"),
        );
        let local = local_postgres::LocalPostgres::start_attachments(&manifest);
        let db = Database::from_local(local, "source");
        // Finite probes of THIS invocation's DB. No retry of a write whose
        // commit might be unknown; no other connection/resource is terminated.
        for probe in 0..100 {
            assert!(db.sql("SELECT 1") == "1", "owned connection probe {probe}");
        }
    }
}
