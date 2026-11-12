#[cfg(windows)]
#[path = "export_process.rs"]
mod export_process;
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use zeroize::Zeroizing;
const MAX: usize = 16 * 1024 * 1024;
struct Destination {
    root: PathBuf,
    directory: File,
    epoch: u64,
}
#[derive(Default)]
pub struct ExportSessions {
    destinations: Mutex<HashMap<String, Destination>>,
}
#[cfg(windows)]
fn pin(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .access_mode(1)
        .share_mode(3)
        .custom_flags(0x02000000)
        .open(path)
}
#[cfg(not(windows))]
fn pin(path: &Path) -> std::io::Result<File> {
    File::open(path)
}
fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 240
        && !value.contains(['/', '\\', ':'])
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        && (value.starts_with("item-") || value.starts_with("attachment-"))
        && (value.ends_with(".json") || value.ends_with(".bin"))
}
impl ExportSessions {
    pub fn open(&self, path: PathBuf, epoch: u64) -> Result<String, String> {
        let info = std::fs::symlink_metadata(&path).map_err(|_| "EXPORT_DIRECTORY")?;
        if !info.is_dir() || info.file_type().is_symlink() {
            return Err("EXPORT_DIRECTORY".into());
        }
        let root = path.canonicalize().map_err(|_| "EXPORT_DIRECTORY")?;
        let directory = pin(&root).map_err(|_| "EXPORT_DIRECTORY")?;
        let token = uuid::Uuid::new_v4().to_string();
        self.destinations
            .lock()
            .map_err(|_| "EXPORT_SESSION")?
            .insert(
                token.clone(),
                Destination {
                    root,
                    directory,
                    epoch,
                },
            );
        Ok(token)
    }
    pub fn identity(&self, token: &str) -> Result<String, String> {
        let sessions = self.destinations.lock().map_err(|_| "EXPORT_SESSION")?;
        let d = sessions.get(token).ok_or("EXPORT_SESSION")?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            unsafe extern "system" {
                fn GetFileInformationByHandle(h: *mut std::ffi::c_void, p: *mut u32) -> i32;
            }
            let mut info = [0u32; 13];
            if unsafe { GetFileInformationByHandle(d.directory.as_raw_handle(), info.as_mut_ptr()) }
                == 0
            {
                return Err("EXPORT_DIRECTORY".into());
            }
            return Ok(format!(
                "{}:{}",
                info[7],
                ((info[11] as u64) << 32) | info[12] as u64
            ));
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::MetadataExt;
            let m = d.directory.metadata().map_err(|_| "EXPORT_DIRECTORY")?;
            Ok(format!("{}:{}", m.dev(), m.ino()))
        }
    }
    pub fn close(&self, token: &str) -> Result<(), String> {
        self.destinations
            .lock()
            .map_err(|_| "EXPORT_SESSION")?
            .remove(token);
        Ok(())
    }
    pub fn read(&self, token: &str, name_: &str, epoch: u64) -> Result<Option<Vec<u8>>, String> {
        if !name(name_) {
            return Err("EXPORT_NAME".into());
        }
        let sessions = self.destinations.lock().map_err(|_| "EXPORT_SESSION")?;
        let d = sessions
            .get(token)
            .filter(|d| d.epoch == epoch)
            .ok_or("EXPORT_SESSION")?;
        let path = d.root.join(name_);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("EXPORT_READ".into()),
        };
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX as u64 {
            return Err("EXPORT_READ".into());
        }
        let mut opts = OpenOptions::new();
        opts.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            opts.share_mode(0).custom_flags(0x00200000);
        }
        let mut file = opts.open(path).map_err(|_| "EXPORT_READ")?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "EXPORT_READ")?;
        if bytes.len() > MAX {
            return Err("EXPORT_READ".into());
        }
        Ok(Some(bytes))
    }
    pub fn publish(
        &self,
        token: &str,
        name_: &str,
        bytes: Vec<u8>,
        epoch: u64,
        publisher: &Path,
    ) -> Result<(), String> {
        self.publish_checked(token, name_, bytes, epoch, publisher, || true)
    }
    pub fn publish_checked(
        &self,
        token: &str,
        name_: &str,
        bytes: Vec<u8>,
        epoch: u64,
        publisher: &Path,
        current: impl Fn() -> bool,
    ) -> Result<(), String> {
        let bytes = Zeroizing::new(bytes);
        if !name(name_) || bytes.len() > MAX {
            return Err("EXPORT_INPUT".into());
        }
        let sessions = self.destinations.lock().map_err(|_| "EXPORT_SESSION")?;
        let d = sessions
            .get(token)
            .filter(|d| d.epoch == epoch)
            .ok_or("EXPORT_SESSION")?;
        if !current() {
            return Err("EXPORT_SESSION".into());
        }
        let _held = &d.directory;
        let target = d.root.join(name_);
        let mut command = Command::new(publisher);
        command.arg(target).arg(bytes.len().to_string());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000004);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "EXPORT_PUBLISH")?;
        #[cfg(windows)]
        let tree = match export_process::Tree::attach(&child) {
            Ok(t) => t,
            Err(_) => {
                let _ = child.kill();
                while matches!(child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                return Err("EXPORT_TREE".into());
            }
        };
        if !current() {
            #[cfg(windows)]
            let _ = tree.stop();
            let _ = child.kill();
            while matches!(child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            return Err("EXPORT_SESSION".into());
        }
        let mut stdin = child.stdin.take().ok_or("EXPORT_PUBLISH")?;
        let payload = Zeroizing::new(bytes.to_vec());
        let writer = std::thread::spawn(move || stdin.write_all(&payload));
        let mut interrupted = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(_) => {
                    interrupted = true;
                    break None;
                }
            }
            if std::time::Instant::now() + std::time::Duration::from_secs(2) >= deadline
                || !current()
            {
                interrupted = true;
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        #[cfg(windows)]
        let stop_requested = tree.stop();
        #[cfg(not(windows))]
        let stop_requested = child.kill().is_ok() || status.is_some();
        if interrupted {
            let _ = child.kill();
        }
        let mut reaped = status.is_some();
        while std::time::Instant::now() < deadline {
            if !reaped {
                reaped = matches!(child.try_wait(), Ok(Some(_)));
            }
            #[cfg(windows)]
            export_process::cancel_writer(&writer);
            #[cfg(windows)]
            let tree_empty = tree.empty();
            #[cfg(not(windows))]
            let tree_empty = reaped;
            if reaped && writer.is_finished() && tree_empty {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        #[cfg(windows)]
        let tree_empty = tree.empty();
        #[cfg(not(windows))]
        let tree_empty = reaped;
        if !reaped || !writer.is_finished() || !tree_empty {
            return Err("EXPORT_DRAIN_UNCONFIRMED".into());
        }
        let write_ok = matches!(writer.join(), Ok(Ok(())));
        #[cfg(test)]
        eprintln!("export_flight reaped={reaped} writer_joined=true tree_empty={tree_empty} stop_requested={stop_requested}");
        if interrupted {
            return Err("EXPORT_INTERRUPTED_CHECK_OUTPUT".into());
        }
        let status = status.ok_or("EXPORT_PUBLISH")?;
        if !write_ok {
            return Err("EXPORT_PUBLISH".into());
        }
        if status.code() == Some(17) {
            return Err("EXPORT_EXISTS".into());
        }
        if !status.success() {
            return Err("EXPORT_PUBLISH".into());
        }
        if !current() {
            return Err("EXPORT_COMMITTED_SESSION_EXPIRED".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filenames_are_bounded_single_components() {
        for p in [
            "../x",
            "item-a/other.json",
            "item-a:stream.json",
            "",
            "other.json",
        ] {
            assert!(!name(p));
        }
        assert!(name("item-a-v1.json"));
        assert!(name("attachment-a-b-v1.name.json"));
    }
    #[test]
    fn closed_and_wrong_epoch_are_rejected() {
        let root =
            std::env::temp_dir().join(format!("passshare-native-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let s = ExportSessions::default();
        let id = s.open(root.clone(), 7).unwrap();
        assert!(s.read(&id, "item-a.json", 8).is_err());
        assert!(s.read(&id, "item-a.json", 7).unwrap().is_none());
        s.close(&id).unwrap();
        assert!(s.read(&id, "item-a.json", 7).is_err());
        std::fs::remove_dir(root).unwrap();
    }
}

#[cfg(all(test, windows))]
mod publisher_tests {
    use super::*;
    #[test]
    #[ignore = "requires exact packaged publisher fixture; run explicitly with PASSSHARE_TEST_PUBLISHER"]
    fn real_packaged_publisher_preserves_existing_data_and_readback() {
        let Some(exe) = std::env::var_os("PASSSHARE_TEST_PUBLISHER") else {
            panic!("packaged publisher fixture required")
        };
        let root =
            std::env::temp_dir().join(format!("passshare-native-session-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let sessions = ExportSessions::default();
        let token = sessions.open(root.clone(), 9).unwrap();
        assert_eq!(
            sessions.publish_checked(
                &token,
                "item-cancel-v1.json",
                vec![1],
                9,
                Path::new(&exe),
                || false
            ),
            Err("EXPORT_SESSION".into())
        );
        assert!(!root.join("item-cancel-v1.json").exists());
        let checks = std::cell::Cell::new(0);
        assert_eq!(
            sessions.publish_checked(
                &token,
                "item-race-v1.json",
                vec![1],
                9,
                Path::new(&exe),
                || {
                    let n = checks.get();
                    checks.set(n + 1);
                    n == 0
                }
            ),
            Err("EXPORT_SESSION".into())
        );
        assert!(!root.join("item-race-v1.json").exists());
        let result = sessions.publish_checked(
            &token,
            "item-committed-v1.json",
            vec![1],
            9,
            Path::new(&exe),
            || !root.join("item-committed-v1.json").exists(),
        );
        assert!(matches!(
            result.as_ref().map_err(String::as_str),
            Err("EXPORT_COMMITTED_SESSION_EXPIRED" | "EXPORT_INTERRUPTED_CHECK_OUTPUT")
        ));
        assert_eq!(
            std::fs::read(root.join("item-committed-v1.json")).unwrap(),
            vec![1]
        );
        let expected = vec![0, 255, 3, 0, 128];
        sessions
            .publish(
                &token,
                "attachment-a-b-v1.bin",
                expected.clone(),
                9,
                Path::new(&exe),
            )
            .unwrap();
        assert_eq!(
            sessions.read(&token, "attachment-a-b-v1.bin", 9).unwrap(),
            Some(expected.clone())
        );
        assert_eq!(
            sessions.publish(&token, "attachment-a-b-v1.bin", vec![7], 9, Path::new(&exe)),
            Err("EXPORT_EXISTS".into())
        );
        assert_eq!(
            sessions.read(&token, "attachment-a-b-v1.bin", 9).unwrap(),
            Some(expected)
        );
        std::fs::write(root.join("item-foreign-v1.json"), []).unwrap();
        assert_eq!(
            sessions.publish(&token, "item-foreign-v1.json", vec![7], 9, Path::new(&exe)),
            Err("EXPORT_EXISTS".into())
        );
        assert_eq!(
            std::fs::metadata(root.join("item-foreign-v1.json"))
                .unwrap()
                .len(),
            0
        );
        sessions.close(&token).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, windows))]
mod fault_tests {
    use super::*;
    #[test]
    #[ignore = "requires owned fault publisher fixture"]
    fn blocked_partial_and_descendant_pipe_are_reaped_within_one_flight() {
        let exe = std::env::var_os("PASSSHARE_FAULT_PUBLISHER").expect("fault fixture");
        for mode in ["noread", "partial", "descendant"] {
            let root =
                std::env::temp_dir().join(format!("passshare-fault-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let s = ExportSessions::default();
            let token = s.open(root.clone(), 1).unwrap();
            let start = std::time::Instant::now();
            let result = s.publish(
                &token,
                &format!("item-{mode}-v1.json"),
                vec![7; 1024 * 1024],
                1,
                Path::new(&exe),
            );
            assert!(result.is_err());
            assert!(
                start.elapsed() < std::time::Duration::from_secs(16),
                "{mode} exceeded deadline"
            );
            s.close(&token).unwrap();
            println!(
                "mode={mode} elapsed_ms={} result={result:?}",
                start.elapsed().as_millis()
            );
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
