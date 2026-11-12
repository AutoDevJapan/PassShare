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
        let bytes = Zeroizing::new(bytes);
        if !name(name_) || bytes.len() > MAX {
            return Err("EXPORT_INPUT".into());
        }
        let sessions = self.destinations.lock().map_err(|_| "EXPORT_SESSION")?;
        let d = sessions
            .get(token)
            .filter(|d| d.epoch == epoch)
            .ok_or("EXPORT_SESSION")?;
        let _held = &d.directory;
        let target = d.root.join(name_);
        let mut command = Command::new(publisher);
        command.arg(target).arg(bytes.len().to_string());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "EXPORT_PUBLISH")?;
        let write = child
            .stdin
            .take()
            .ok_or("EXPORT_PUBLISH")?
            .write_all(&bytes);
        let status = child.wait().map_err(|_| "EXPORT_PUBLISH")?;
        if write.is_err() {
            return Err("EXPORT_PUBLISH".into());
        }
        if status.code() == Some(17) {
            return Err("EXPORT_EXISTS".into());
        }
        if !status.success() {
            return Err("EXPORT_PUBLISH".into());
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
