//! Explicit alternate fixture for the owned Windows PostgreSQL server. This
//! never stands in for the Docker distribution-image acceptance.
use super::*;
use std::ffi::OsString;

pub fn prefix(args: &[OsString]) -> Result<(Option<PathBuf>, &[OsString]), &'static str> {
    if args.first().is_some_and(|a| a == "--local-postgres") {
        let Some(path) = args
            .get(1)
            .filter(|p| !p.to_string_lossy().starts_with('-'))
        else {
            return Err("local PostgreSQL requires an owned fixture manifest");
        };
        if !PathBuf::from(path).is_absolute() {
            return Err("local fixture manifest must be absolute");
        }
        Ok((Some(PathBuf::from(path)), &args[2..]))
    } else if args.iter().any(|a| a == "--local-postgres") {
        Err("local fixture option must be first")
    } else {
        Ok((None, args))
    }
}

pub fn validate_mode(
    local: bool,
    supported_fixture: bool,
    args: &[OsString],
) -> Result<(), &'static str> {
    if local && (!supported_fixture || args.iter().any(|a| a == "--go-session" || a == "--image")) {
        Err("local PostgreSQL supports only the explicit Node sharing/expiry/restore fixtures")
    } else {
        Ok(())
    }
}

pub struct LocalPostgres {
    pub psql: PathBuf,
    pub port: u16,
    pub database: String,
    passfile: PathBuf,
    pub ownership_id: String,
    purpose: &'static str,
}
impl LocalPostgres {
    pub fn start(manifest: &PathBuf) -> Self {
        Self::start_named(manifest, "")
    }
    pub fn start_attachments(manifest: &PathBuf) -> Self {
        Self::start_named(manifest, "attach_")
    }
    pub fn start_migration(manifest: &PathBuf) -> Self {
        let local = Self::start_named(manifest, "migration_");
        local.query(&format!("CREATE SCHEMA passshare_migration_control; CREATE TABLE passshare_migration_control.binding(owner_id text NOT NULL,purpose text NOT NULL,database_name text NOT NULL); INSERT INTO passshare_migration_control.binding VALUES('{}','encrypted-migration-source',current_database())",local.ownership_id));
        println!("migration resource: database={} server_port={} fixture_owner={} purpose=encrypted-migration-source",local.database,local.port,local.ownership_id);
        local
    }
    fn start_named(manifest: &PathBuf, prefix: &str) -> Self {
        let file = std::fs::File::open(manifest).expect("owned fixture manifest must exist");
        let mut bytes = Vec::new();
        file.take(16 * 1024 + 1).read_to_end(&mut bytes).unwrap();
        assert!(bytes.len() <= 16 * 1024, "fixture manifest exceeds bound");
        let value: Value = serde_json::from_slice(&bytes).expect("fixture manifest JSON");
        assert_eq!(
            value["fixtureOnly"], true,
            "only a synthetic fixture is allowed"
        );
        let owner = value["ownershipId"].as_str().expect("fixture ownership id");
        assert!(
            owner.len() == 32
                && owner
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        );
        let root = PathBuf::from(value["runtimeRoot"].as_str().expect("fixture runtime root"));
        assert!(root.is_absolute());
        assert_eq!(
            root.file_name().unwrap(),
            OsString::from(format!("codex-owned-{owner}"))
        );
        assert!(!std::fs::symlink_metadata(&root)
            .unwrap()
            .file_type()
            .is_symlink());
        let psql = root.join("pgsql/bin/psql.exe");
        assert!(psql.is_file(), "owned psql binary missing");
        assert_eq!(
            std::fs::canonicalize(root.join("pgsql/bin/postgres.exe")).unwrap(),
            std::fs::canonicalize(value["binary"].as_str().expect("fixture server binary"))
                .unwrap()
        );
        let pid: u32 = std::fs::read_to_string(root.join("data/postmaster.pid"))
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert!(pid > 0 && value["serverPid"].as_u64() == Some(u64::from(pid)));
        let port = value["port"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p > 0)
            .expect("fixture port");
        let passfile = root.join("fixture-empty.pgpass");
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&passfile)
        {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let meta = std::fs::symlink_metadata(&passfile).unwrap();
                assert!(meta.is_file() && !meta.file_type().is_symlink() && meta.len() == 0);
            }
            Err(_) => panic!("owned empty passfile creation failed"),
        }
        let mut local = Self {
            psql,
            port,
            database: "passshare".to_owned(),
            passfile,
            ownership_id: owner.to_owned(),
            purpose: "acceptance-source",
        };
        // The nonce and server major version prevent accidentally selecting an
        // unrelated DB. No environment DATABASE_URL is read as a fallback.
        assert_eq!(
            local.query("SELECT owner_id FROM passshare_fixture_owner"),
            owner
        );
        let version: u32 = local.query("SHOW server_version_num").parse().unwrap();
        assert!(
            (160000..170000).contains(&version),
            "PostgreSQL 16 fixture required"
        );
        local.create_database(prefix);
        local.query(&format!("CREATE TABLE passshare_fixture_owner(owner_id text PRIMARY KEY); INSERT INTO passshare_fixture_owner VALUES('{owner}')"));
        local
    }
    // A new invocation-owned DB on the verified fixture server, never the
    // parent's UI DB. Keep ownership outside public so restore cannot replace it.
    pub fn restore_target(&self) -> Self {
        let mut local = Self {
            psql: self.psql.clone(),
            port: self.port,
            database: "passshare".to_owned(),
            passfile: self.passfile.clone(),
            ownership_id: self.ownership_id.clone(),
            purpose: "acceptance-restore",
        };
        assert!(local.query("SELECT owner_id FROM passshare_fixture_owner") == self.ownership_id);
        local.create_database(if self.database.starts_with("passshare1163_attach_") {
            "attach_"
        } else {
            ""
        });
        local
    }
    fn create_database(&mut self, prefix: &str) {
        assert!(matches!(prefix, "" | "attach_" | "migration_"));
        let name = format!("passshare1163_{prefix}{}", ConnectId::generate().unwrap());
        self.create_database_named(name);
    }
    fn create_database_named(&mut self, name: String) {
        assert!(
            name.starts_with("passshare1163_")
                && name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        );
        let mut cmd = self.client();
        // Windows fixture creation can exceed the normal 10-second statement
        // limit during filesystem sync. Keep a separate finite creation budget.
        cmd.env(
            "PGOPTIONS",
            "-c statement_timeout=55000 -c lock_timeout=10000",
        );
        self.database = name.clone(); // Register ownership BEFORE launch/failure.
        let catalog = Self {
            psql: self.psql.clone(),
            port: self.port,
            database: "passshare".to_owned(),
            passfile: self.passfile.clone(),
            ownership_id: self.ownership_id.clone(),
            purpose: self.purpose,
        };
        if let Err(reason) = control_with_budget(
            cmd,
            &format!("CREATE DATABASE {name} TEMPLATE template0 STRATEGY WAL_LOG"),
            Duration::from_secs(60),
        ) {
            // CREATE used the catalog connection, not the newly registered
            // target that may never have been created. Keep the first failure.
            catalog.report_readiness();
            panic!("bounded owned database creation failed: {reason}");
        }
        let marker = format!(
            "passshare-acceptance:{}:{}:{}",
            self.ownership_id, self.purpose, self.database
        );
        catalog.query(&format!(
            "COMMENT ON DATABASE {} IS '{marker}'",
            self.database
        ));
        // The catalog marker remains readable even if PostgreSQL has marked a
        // partially dropped database invalid. Do not depend on connecting to it.
        println!(
            "local PostgreSQL resource created: database={} port={} owner={}",
            self.database, self.port, self.ownership_id
        );
    }
    pub fn archive_client(&self, program: &str) -> Command {
        assert!(matches!(program, "pg_dump" | "pg_restore"));
        let mut c = self.client();
        // Preserve the vetted environment, but replace psql-only arguments.
        let env = c
            .get_envs()
            .map(|(k, v)| (k.to_owned(), v.map(ToOwned::to_owned)))
            .collect::<Vec<_>>();
        c = command(
            self.psql
                .with_file_name(format!("{program}.exe"))
                .to_str()
                .unwrap(),
        );
        c.env_clear();
        for (k, v) in env {
            if let Some(v) = v {
                c.env(k, v);
            }
        }
        c.args([
            "-h",
            "127.0.0.1",
            "-p",
            &self.port.to_string(),
            "-w",
            "-U",
            "passshare",
        ]);
        if program == "pg_dump" {
            c.args(["-d", &self.database]);
        }
        c.env(
            "PGOPTIONS",
            "-c statement_timeout=50000 -c lock_timeout=5000",
        );
        c
    }
    pub fn client(&self) -> Command {
        let mut c = command(self.psql.to_str().unwrap());
        c.env_clear();
        for key in ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                c.env(key, value);
            }
        }
        c.env("PGPASSFILE", &self.passfile)
            .env("PGSERVICEFILE", &self.passfile)
            .env("LC_ALL", "C")
            .env("LANG", "C");
        c.args([
            "-h",
            "127.0.0.1",
            "-p",
            &self.port.to_string(),
            "-X",
            "-w",
            "-qAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "passshare",
            "-d",
            &self.database,
        ]);
        c.env("PGCONNECT_TIMEOUT", "5").env(
            "PGOPTIONS",
            "-c statement_timeout=10000 -c lock_timeout=10000",
        );
        c
    }
    #[track_caller]
    fn query(&self, sql: &str) -> String {
        let operation = if sql.starts_with("CREATE DATABASE") {
            "create_database"
        } else if sql.starts_with("SELECT owner_id") {
            "verify_owner"
        } else {
            "fixture_control"
        };
        control(self.client(), sql).unwrap_or_else(|reason| {
            self.report_readiness();
            panic!("bounded owned fixture operation={operation} failed: {reason}")
        })
    }
    #[track_caller]
    fn report_readiness(&self) {
        let mut probe = self.client();
        probe
            .args(["-f", "-", "-v", "ECHO=none", "-v", "VERBOSITY=verbose"])
            .env("PGCONNECT_TIMEOUT", "2")
            .env("PGOPTIONS", "-c statement_timeout=2000");
        let ready = fixture_sql_phase(
            probe,
            "SELECT 1",
            std::time::Instant::now() + Duration::from_secs(3),
            SqlPhase::Readiness,
            16 * 1024,
        );
        eprintln!(
            "fixture SQL readiness selected_db_query_ok={}",
            matches!(&ready, Ok(value) if value == "1")
        );
        if let Err(failure) = ready {
            eprintln!("fixture SQL {failure}");
        }
    }
}
impl Drop for LocalPostgres {
    fn drop(&mut self) {
        if !self.database.starts_with("passshare1163_") {
            return;
        }
        let name = std::mem::replace(&mut self.database, "passshare".to_owned());
        let marker = format!(
            "passshare-acceptance:{}:{}:{name}",
            self.ownership_id, self.purpose
        );
        let guard=format!("SELECT count(*) FROM pg_database d WHERE datname='{name}' AND datdba=(SELECT oid FROM pg_roles WHERE rolname='passshare') AND shobj_description(d.oid,'pg_database')='{marker}'");
        let guarded = control(self.client(), &guard);
        if !matches!(&guarded, Ok(value) if value == "1") {
            CLEANUP_FAILED.store(true, Ordering::SeqCst);
            if let Err(reason) = guarded {
                eprintln!("fixture SQL {reason}");
            }
            eprintln!(
                "local database ownership/purpose catalog guard failed; preserved database={name}"
            );
            return;
        }
        let mut cmd = self.client();
        cmd.env(
            "PGOPTIONS",
            "-c statement_timeout=55000 -c lock_timeout=10000",
        );
        if let Err(reason) = control_with_budget(
            cmd,
            &format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"),
            Duration::from_secs(60),
        ) {
            CLEANUP_FAILED.store(true, Ordering::SeqCst);
            eprintln!(
                "owned local PostgreSQL database cleanup failed database={name} category={reason}"
            );
        } else {
            println!("owned local PostgreSQL resource dropped: database={name}");
        }
    }
}

#[track_caller]
fn control(cmd: Command, sql: &str) -> Result<String, Box<SqlFailure>> {
    control_with_budget(cmd, sql, Duration::from_secs(15))
}
#[track_caller]
fn control_with_budget(
    mut cmd: Command,
    sql: &str,
    budget: Duration,
) -> Result<String, Box<SqlFailure>> {
    cmd.args(["-f", "-", "-v", "ECHO=none", "-v", "VERBOSITY=verbose"]);
    let phase = if sql.starts_with("CREATE DATABASE") {
        SqlPhase::CreateDatabase
    } else if sql.starts_with("DROP DATABASE") {
        SqlPhase::DropDatabase
    } else if sql.starts_with("SELECT owner_id")
        || sql.starts_with("SELECT count(*) FROM pg_database")
    {
        SqlPhase::Ownership
    } else {
        SqlPhase::Control
    };
    fixture_sql_phase(
        cmd,
        sql,
        std::time::Instant::now() + budget,
        phase,
        16 * 1024,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires PASSSHARE_SQL_FIXTURE_MANIFEST naming an owned PostgreSQL 16 fixture"]
    fn create_failure_observes_catalog_and_preserves_original_failure_and_owned_database() {
        let manifest = PathBuf::from(
            std::env::var_os("PASSSHARE_SQL_FIXTURE_MANIFEST").expect("explicit fixture manifest"),
        );
        let local = LocalPostgres::start_attachments(&manifest);
        let name = local.database.clone();
        let mut duplicate = LocalPostgres {
            psql: local.psql.clone(),
            port: local.port,
            database: "passshare".to_owned(),
            passfile: local.passfile.clone(),
            ownership_id: local.ownership_id.clone(),
            purpose: local.purpose,
        };
        // Inject only a duplicate name belonging to this test; no permissions,
        // templates, server settings or another caller's databases are changed.
        let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            duplicate.create_database_named(name.clone())
        }));
        duplicate.database = "passshare".to_owned(); // The original owner retains Drop responsibility.
        let panic = rejected.expect_err("duplicate owned database creation must fail");
        let report = panic
            .downcast_ref::<String>()
            .expect("safe failure metadata");
        assert!(
            report.contains("phase=create_database")
                && report.contains("category=object_already_exists")
                && report.contains("42P04")
        );
        assert_eq!(local.query("SELECT 1"), "1");
        drop(local);
        assert_eq!(
            duplicate.query(&format!(
                "SELECT count(*) FROM pg_database WHERE datname='{name}'"
            )),
            "0"
        );
        assert!(!CLEANUP_FAILED.load(Ordering::SeqCst));
        println!("SQL control live: duplicate owned CREATE remains failed; catalog readiness and exact DB recovery passed");
    }
    #[test]
    fn explicit_absolute_manifest_prefix_preserves_the_fixture_mode() {
        let absolute = std::env::current_dir().unwrap().join("fixture.json");
        let args = vec![
            "--local-postgres".into(),
            absolute.into_os_string(),
            "--sharing-rotation".into(),
            "native".into(),
        ];
        let (local, rest) = prefix(&args).unwrap();
        assert!(local.is_some());
        assert!(fixture_prefix(rest).unwrap().1);
        for invalid in [
            vec!["--local-postgres"],
            vec!["--local-postgres", "relative.json"],
            vec!["--local-postgres", "--image"],
            vec!["native", "--local-postgres"],
        ] {
            assert!(prefix(&invalid.into_iter().map(OsString::from).collect::<Vec<_>>()).is_err());
        }
        assert!(prefix(&["native".into()]).unwrap().0.is_none());
        assert!(validate_mode(true, true, &["native".into()]).is_ok());
        for args in [
            vec!["--go-session", "unused.exe", "native"],
            vec!["--image", "image"],
        ] {
            assert!(validate_mode(
                true,
                true,
                &args.into_iter().map(OsString::from).collect::<Vec<_>>()
            )
            .is_err());
        }
        assert!(validate_mode(true, false, &["native".into()]).is_err());
    }
}
