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
}
impl LocalPostgres {
    pub fn start(manifest: &PathBuf) -> Self {
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
        local.create_database();
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
        };
        assert!(local.query("SELECT owner_id FROM passshare_fixture_owner") == self.ownership_id);
        local.create_database();
        local
    }
    fn create_database(&mut self) {
        let name = format!("passshare1163_{}", ConnectId::generate().unwrap());
        let mut cmd = self.client();
        // Windows fixture creation can exceed the normal 10-second statement
        // limit during filesystem sync. Keep a separate finite creation budget.
        cmd.env(
            "PGOPTIONS",
            "-c statement_timeout=55000 -c lock_timeout=10000",
        );
        self.database = name.clone(); // Register ownership BEFORE launch/failure.
        control_with_budget(
            cmd,
            &format!("CREATE DATABASE {name} TEMPLATE template0 STRATEGY WAL_LOG"),
            Duration::from_secs(60),
        )
        .expect("bounded owned database creation failed");
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
            .env("PGSERVICEFILE", &self.passfile);
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
    fn query(&self, sql: &str) -> String {
        let operation = if sql.starts_with("CREATE DATABASE") {
            "create_database"
        } else if sql.starts_with("SELECT owner_id") {
            "verify_owner"
        } else {
            "fixture_control"
        };
        control(self.client(), sql).unwrap_or_else(|reason| {
            panic!("bounded owned fixture operation={operation} failed: {reason}")
        })
    }
}
impl Drop for LocalPostgres {
    fn drop(&mut self) {
        if !self.database.starts_with("passshare1163_") {
            return;
        }
        let name = std::mem::replace(&mut self.database, "passshare".to_owned());
        if control(
            self.client(),
            &format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"),
        )
        .is_err()
        {
            CLEANUP_FAILED.store(true, Ordering::SeqCst);
            eprintln!("owned local PostgreSQL database cleanup failed");
        }
    }
}

fn control(cmd: Command, sql: &str) -> Result<String, &'static str> {
    control_with_budget(cmd, sql, Duration::from_secs(15))
}

fn control_with_budget(
    mut cmd: Command,
    sql: &str,
    budget: Duration,
) -> Result<String, &'static str> {
    let deadline = std::time::Instant::now() + budget;
    let mut child = cmd
        .args(["-c", sql])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "control launch failed")?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let mut readers = Vec::new();
    for (stdout, pipe) in [
        (true, Box::new(out) as Box<dyn Read + Send>),
        (false, Box::new(err) as Box<dyn Read + Send>),
    ] {
        let send = send.clone();
        readers.push(thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take(16 * 1024 + 1).read_to_end(&mut bytes);
            let _ = send.send((stdout, result, bytes));
        }));
    }
    drop(send);
    let mut timed_out = false;
    let mut wait_failed = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => wait_failed = true,
        }
        if wait_failed || std::time::Instant::now() >= deadline {
            timed_out = !wait_failed;
            let _ = child.kill();
            if !reap_before(
                &mut child,
                std::time::Instant::now() + Duration::from_secs(2),
            ) {
                CLEANUP_FAILED.store(true, Ordering::SeqCst);
                break None;
            }
            match child.wait() {
                Ok(status) => break Some(status),
                Err(_) => {
                    CLEANUP_FAILED.store(true, Ordering::SeqCst);
                    break None;
                }
            }
        }
        thread::sleep(Duration::from_millis(10));
    };
    let drain = std::time::Instant::now() + Duration::from_secs(2);
    let mut stdout = Vec::new();
    let mut failure = "control rejected or exceeded output bound";
    let mut invalid = false;
    for _ in 0..2 {
        let (is_stdout, result, bytes) = match receive
            .recv_timeout(drain.saturating_duration_since(std::time::Instant::now()))
        {
            Ok(reply) => reply,
            Err(_) => {
                CLEANUP_FAILED.store(true, Ordering::SeqCst);
                return Err("control drain deadline exceeded");
            }
        };
        invalid |= result.is_err() || bytes.len() > 16 * 1024;
        if is_stdout {
            stdout = bytes;
        } else {
            let diagnostic = String::from_utf8_lossy(&bytes);
            if diagnostic.contains("canceling statement due to statement timeout") {
                failure = "control statement timeout";
            } else if diagnostic.contains("being accessed by other users") {
                failure = "control template database in use";
            } else if diagnostic.contains("already exists") {
                failure = "control object already exists";
            } else if diagnostic.contains("could not connect")
                || diagnostic.contains("connection refused")
            {
                failure = "control connection unavailable";
            }
        }
    }
    for reader in readers {
        if reader.join().is_err() {
            CLEANUP_FAILED.store(true, Ordering::SeqCst);
            invalid = true;
        }
    }
    if wait_failed || status.is_none() {
        return Err("control child wait or reap failed");
    }
    if timed_out {
        return Err("control deadline exceeded");
    }
    if invalid || !status.is_some_and(|status| status.success()) {
        return Err(failure);
    }
    Ok(String::from_utf8(stdout)
        .map_err(|_| "control reply encoding")?
        .trim()
        .to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
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
