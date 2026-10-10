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

pub struct LocalPostgres {
    pub psql: PathBuf,
    pub port: u16,
    pub database: String,
    passfile: PathBuf,
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
        let name = format!("passshare1163_{}", ConnectId::generate().unwrap());
        local.query(&format!("CREATE DATABASE {name}"));
        local.database = name;
        local.query(&format!("CREATE TABLE passshare_fixture_owner(owner_id text PRIMARY KEY); INSERT INTO passshare_fixture_owner VALUES('{owner}')"));
        local
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
        let output = self
            .client()
            .args(["-c", sql])
            .output()
            .expect("owned fixture SQL launch");
        assert!(output.status.success(), "owned fixture SQL failed");
        assert!(
            output.stdout.len() <= 16 * 1024,
            "fixture control reply exceeds bound"
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
}
impl Drop for LocalPostgres {
    fn drop(&mut self) {
        if !self.database.starts_with("passshare1163_") {
            return;
        }
        let name = std::mem::replace(&mut self.database, "passshare".to_owned());
        let status = self
            .client()
            .args(["-c", &format!("DROP DATABASE {name} WITH (FORCE)")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if !status.is_ok_and(|s| s.success()) {
            CLEANUP_FAILED.store(true, Ordering::SeqCst);
            eprintln!("owned local PostgreSQL database cleanup failed");
        }
    }
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
    }
}
