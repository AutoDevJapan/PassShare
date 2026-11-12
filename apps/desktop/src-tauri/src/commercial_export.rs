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
    pending: Option<PendingFlight>,
}
struct PendingFlight {
    child: std::process::Child,
    writer: std::thread::JoinHandle<std::io::Result<()>>,
    #[cfg(windows)]
    tree: Option<export_process::Tree>,
}
impl PendingFlight {
    fn reclaim(&mut self) -> bool {
        #[cfg(windows)]
        {
            if let Some(tree) = self.tree.as_ref() {
                let _ = tree.stop();
            }
            export_process::cancel_writer(&self.writer);
        }
        let _ = self.child.kill();
        let reaped = matches!(self.child.try_wait(), Ok(Some(_)));
        #[cfg(windows)]
        let empty = self.tree.as_ref().is_none_or(|tree| tree.empty());
        #[cfg(not(windows))]
        let empty = reaped;
        reaped && empty && self.writer.is_finished()
    }
}
#[derive(Default)]
pub struct ExportSessions {
    cancelled: Mutex<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
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
        let mut destinations = self.destinations.lock().map_err(|_| "EXPORT_SESSION")?;
        if destinations
            .values()
            .any(|d| d.root == root && d.pending.is_some())
        {
            return Err("EXPORT_DRAIN_UNCONFIRMED".into());
        }
        destinations.insert(
            token.clone(),
            Destination {
                root,
                directory,
                epoch,
                pending: None,
            },
        );
        drop(destinations);
        self.cancelled.lock().map_err(|_| "EXPORT_SESSION")?.insert(
            token.clone(),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        Ok(token)
    }
    pub fn cancel(&self, token: &str, gate: &Mutex<()>) -> Result<(), String> {
        let flag = self
            .cancelled
            .lock()
            .map_err(|_| "EXPORT_SESSION")?
            .get(token)
            .cloned()
            .ok_or("EXPORT_SESSION")?;
        let _commit = gate.lock().map_err(|_| "EXPORT_SESSION")?;
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
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
    pub fn recover(&self, token: &str) -> Result<bool, String> {
        let mut sessions = self.destinations.lock().map_err(|_| "EXPORT_SESSION")?;
        let d = sessions.get_mut(token).ok_or("EXPORT_SESSION")?;
        if let Some(f) = d.pending.as_mut() {
            if !f.reclaim() {
                return Ok(false);
            }
        }
        if let Some(f) = d.pending.take() {
            let _ = f.writer.join();
        }
        Ok(true)
    }
    pub fn close(&self, token: &str) -> Result<(), String> {
        let mut sessions = self.destinations.lock().map_err(|_| "EXPORT_SESSION")?;
        if sessions.get(token).is_some_and(|d| d.pending.is_some()) {
            return Err("EXPORT_DRAIN_UNCONFIRMED".into());
        }
        sessions.remove(token);
        self.cancelled
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
    #[cfg(test)]
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
    #[cfg(test)]
    pub fn publish_checked(
        &self,
        token: &str,
        name_: &str,
        bytes: Vec<u8>,
        epoch: u64,
        publisher: &Path,
        current: impl Fn() -> bool,
    ) -> Result<(), String> {
        self.publish_ordered(
            token,
            name_,
            bytes,
            epoch,
            publisher,
            current,
            &Mutex::new(()),
        )
    }
    pub fn publish_ordered(
        &self,
        token: &str,
        name_: &str,
        bytes: Vec<u8>,
        epoch: u64,
        publisher: &Path,
        current: impl Fn() -> bool,
        commit_gate: &Mutex<()>,
    ) -> Result<(), String> {
        self.publish_with_ready(
            token,
            name_,
            bytes,
            epoch,
            publisher,
            current,
            commit_gate,
            || {},
        )
    }
    pub fn publish_with_ready(
        &self,
        token: &str,
        name_: &str,
        bytes: Vec<u8>,
        epoch: u64,
        publisher: &Path,
        current: impl Fn() -> bool,
        commit_gate: &Mutex<()>,
        on_ready: impl Fn(),
    ) -> Result<(), String> {
        let cancelled = self
            .cancelled
            .lock()
            .map_err(|_| "EXPORT_SESSION")?
            .get(token)
            .cloned()
            .ok_or("EXPORT_SESSION")?;
        let input_current = current;
        let current = || input_current() && !cancelled.load(std::sync::atomic::Ordering::SeqCst);
        let bytes = Zeroizing::new(bytes);
        if !name(name_) || bytes.len() > MAX {
            return Err("EXPORT_INPUT".into());
        }
        let mut sessions = self.destinations.lock().map_err(|_| "EXPORT_SESSION")?;
        let target_root = sessions.get(token).ok_or("EXPORT_SESSION")?.root.clone();
        if sessions
            .values()
            .any(|entry| entry.root == target_root && entry.pending.is_some())
        {
            return Err("EXPORT_DRAIN_UNCONFIRMED".into());
        }
        let d = sessions
            .get_mut(token)
            .filter(|d| d.epoch == epoch)
            .ok_or("EXPORT_SESSION")?;
        if d.pending.is_some() {
            return Err("EXPORT_DRAIN_UNCONFIRMED".into());
        }
        if !current() {
            return Err("EXPORT_SESSION".into());
        }
        let _held = &d.directory;
        let target = d.root.join(name_);
        let mut command = Command::new(publisher);
        command
            .arg(target)
            .arg(bytes.len().to_string())
            .arg("--commit-handshake");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000004);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
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
                if !matches!(child.try_wait(), Ok(Some(_))) {
                    d.pending = Some(PendingFlight {
                        child,
                        writer: std::thread::spawn(|| Ok(())),
                        tree: None,
                    });
                    return Err("EXPORT_DRAIN_UNCONFIRMED".into());
                }
                return Err("EXPORT_TREE".into());
            }
        };
        let mut stdin = match child.stdin.take() {
            Some(pipe) => pipe,
            None => {
                d.pending = Some(PendingFlight {
                    child,
                    writer: std::thread::spawn(|| Ok(())),
                    #[cfg(windows)]
                    tree: Some(tree),
                });
                return Err("EXPORT_DRAIN_UNCONFIRMED".into());
            }
        };
        let payload = Zeroizing::new(bytes.to_vec());
        let mut stdout = match child.stdout.take() {
            Some(pipe) => pipe,
            None => {
                drop(stdin);
                d.pending = Some(PendingFlight {
                    child,
                    writer: std::thread::spawn(|| Ok(())),
                    #[cfg(windows)]
                    tree: Some(tree),
                });
                return Err("EXPORT_DRAIN_UNCONFIRMED".into());
            }
        };
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let (permit_tx, permit_rx) = std::sync::mpsc::sync_channel(1);
        let writer = std::thread::spawn(move || {
            stdin.write_all(&payload)?;
            let mut ready = [0u8; 1];
            stdout.read_exact(&mut ready)?;
            if ready != [b'R'] {
                return Err(std::io::Error::other("invalid publisher readiness"));
            }
            ready_tx
                .send(())
                .map_err(|_| std::io::Error::other("permit channel closed"))?;
            let permit = permit_rx
                .recv_timeout(std::time::Duration::from_secs(13))
                .map_err(|_| std::io::Error::other("permit expired"))?;
            stdin.write_all(&[permit])
        });
        let mut authorized = false;
        let mut commit_guard = None;
        let mut interrupted = false;
        let status = loop {
            if !authorized && ready_rx.try_recv().is_ok() {
                on_ready();
                commit_guard = loop {
                    match commit_gate.try_lock() {
                        Ok(g) => break Some(g),
                        Err(std::sync::TryLockError::WouldBlock) => {
                            if !current()
                                || std::time::Instant::now() + std::time::Duration::from_secs(2)
                                    >= deadline
                            {
                                break None;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(1));
                        }
                        Err(_) => break None,
                    }
                };
                if commit_guard.is_none() {
                    interrupted = true;
                    break None;
                }
                if !current() {
                    interrupted = true;
                    break None;
                }
                authorized = true;
                let _ = permit_tx.send(b'C');
            }
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(_) => {
                    interrupted = true;
                    break None;
                }
            }
            if std::time::Instant::now() + std::time::Duration::from_secs(2) >= deadline
                || (!authorized && !current())
            {
                interrupted = true;
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        drop(permit_tx);
        #[cfg(windows)]
        let _stop_requested = tree.stop();
        #[cfg(not(windows))]
        let _stop_requested = child.kill().is_ok() || status.is_some();
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
            d.pending = Some(PendingFlight {
                child,
                writer,
                #[cfg(windows)]
                tree: Some(tree),
            });
            return Err("EXPORT_DRAIN_UNCONFIRMED".into());
        }
        let write_ok = matches!(writer.join(), Ok(Ok(())));
        #[cfg(test)]
        eprintln!("export_flight reaped={reaped} writer_joined=true tree_empty={tree_empty} stop_requested={_stop_requested}");
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
        if d.pending.is_some() {
            return Err("EXPORT_DRAIN_UNCONFIRMED".into());
        }
        drop(commit_guard);
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
        let identity = s.identity(&id).unwrap();
        s.close(&id).unwrap();
        let moved = root.with_extension("moved");
        std::fs::rename(&root, &moved).unwrap();
        std::fs::create_dir(&root).unwrap();
        let replacement = s.open(root.clone(), 7).unwrap();
        assert_ne!(s.identity(&replacement).unwrap(), identity);
        s.close(&replacement).unwrap();
        std::fs::remove_dir_all(moved).unwrap();
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
            Err("EXPORT_INTERRUPTED_CHECK_OUTPUT".into())
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

#[cfg(all(test, windows))]
mod retained_tests {
    use super::*;
    #[test]
    #[ignore = "requires owned fault publisher fixture"]
    fn uncertain_flight_retains_identity_and_recovers_before_close() {
        use std::os::windows::process::CommandExt;
        let exe = std::env::var_os("PASSSHARE_FAULT_PUBLISHER").expect("fixture");
        let root =
            std::env::temp_dir().join(format!("passshare-retained-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let sessions = ExportSessions::default();
        let token = sessions.open(root.clone(), 1).unwrap();
        let other = sessions.open(root.clone(), 1).unwrap();
        let identity = sessions.identity(&token).unwrap();
        let mut child = Command::new(exe)
            .arg("item-noread-v1.json")
            .arg("0")
            .creation_flags(0x08000004)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let tree = export_process::Tree::attach(&child).unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let writer = std::thread::spawn(move || stdin.write_all(&vec![0; 1024 * 1024]));
        sessions
            .destinations
            .lock()
            .unwrap()
            .get_mut(&token)
            .unwrap()
            .pending = Some(PendingFlight {
            child,
            writer,
            tree: Some(tree),
        });
        assert_eq!(
            sessions.close(&token),
            Err("EXPORT_DRAIN_UNCONFIRMED".into())
        );
        assert_eq!(sessions.identity(&token).unwrap(), identity);
        assert!(
            matches!(sessions.open(root.clone(),1),Err(ref e) if e=="EXPORT_DRAIN_UNCONFIRMED")
        );
        assert_eq!(
            sessions.publish(
                &other,
                "item-other-v1.json",
                vec![1],
                1,
                Path::new("not-launched.exe")
            ),
            Err("EXPORT_DRAIN_UNCONFIRMED".into())
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let recovered = loop {
            if sessions.recover(&token).unwrap() {
                break true;
            }
            if std::time::Instant::now() > deadline {
                break false;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        };
        assert!(recovered);
        assert_eq!(sessions.identity(&token).unwrap(), identity);
        sessions.close(&other).unwrap();
        sessions.close(&token).unwrap();
        assert!(sessions.identity(&token).is_err());
        std::fs::remove_dir(root).unwrap();
    }
}

#[cfg(all(test, windows))]
mod commit_order_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    #[test]
    #[ignore = "requires current handshake publisher"]
    fn invalidation_before_permit_leaves_no_output_and_authorized_commit_is_readable() {
        let exe = PathBuf::from(std::env::var_os("PASSSHARE_TEST_PUBLISHER").expect("fixture"));
        let root = std::env::temp_dir().join(format!("passshare-order-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let sessions = Arc::new(ExportSessions::default());
        let id = sessions.open(root.clone(), 1).unwrap();
        let gate = Arc::new(Mutex::new(()));
        let valid = Arc::new(AtomicBool::new(true));
        let held = gate.lock().unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let s = sessions.clone();
        let i = id.clone();
        let g = gate.clone();
        let v = valid.clone();
        let e = exe.clone();
        let d = done.clone();
        let worker = std::thread::spawn(move || {
            let r = s.publish_ordered(
                &i,
                "item-denied-v1.json",
                vec![1],
                1,
                &e,
                || v.load(Ordering::SeqCst),
                &g,
            );
            d.store(true, Ordering::SeqCst);
            r
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!done.load(Ordering::SeqCst));
        valid.store(false, Ordering::SeqCst);
        drop(held);
        assert!(worker.join().unwrap().is_err());
        assert!(!root.join("item-denied-v1.json").exists());
        valid.store(true, Ordering::SeqCst);
        sessions
            .publish_ordered(
                &id,
                "item-allowed-v1.json",
                vec![0, 255, 7],
                1,
                &exe,
                || valid.load(Ordering::SeqCst),
                &gate,
            )
            .unwrap();
        {
            let _held = gate.lock().unwrap();
            valid.store(false, Ordering::SeqCst);
        }
        assert_eq!(
            std::fs::read(root.join("item-allowed-v1.json")).unwrap(),
            vec![0, 255, 7]
        );
        sessions.close(&id).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(all(test, windows))]
mod cancel_permit_tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    #[ignore = "requires current handshake publisher"]
    fn opaque_session_cancel_precedes_permit_without_affecting_other_session() {
        let exe = PathBuf::from(std::env::var_os("PASSSHARE_TEST_PUBLISHER").unwrap());
        let root =
            std::env::temp_dir().join(format!("passshare-cancel-permit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let sessions = Arc::new(ExportSessions::default());
        let token = sessions.open(root.clone(), 1).unwrap();
        let other = sessions.open(root.clone(), 1).unwrap();
        let gate = Arc::new(Mutex::new(()));
        sessions.cancel(&token, &gate).unwrap();
        assert!(sessions
            .publish_ordered(
                &token,
                "item-cancelled-v1.json",
                vec![1],
                1,
                &exe,
                || true,
                &gate
            )
            .is_err());
        assert!(!root.join("item-cancelled-v1.json").exists());
        sessions
            .publish_ordered(
                &other,
                "item-other-v1.json",
                vec![0, 255],
                1,
                &exe,
                || true,
                &gate,
            )
            .unwrap();
        assert_eq!(
            std::fs::read(root.join("item-other-v1.json")).unwrap(),
            vec![0, 255]
        );
        assert!(sessions.cancel("unknown", &gate).is_err());
        sessions.close(&token).unwrap();
        sessions.close(&other).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
