#[cfg(windows)]
fn pin_directory(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .access_mode(1)
        .share_mode(3)
        .custom_flags(0x02000000)
        .open(path)
}
#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn selected_directory_cannot_be_renamed_or_removed_until_handle_is_released() {
        let root =
            std::env::temp_dir().join(format!("passshare-parent-pin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let moved = root.with_extension("moved");
        let held = super::pin_directory(&root).unwrap();
        assert!(std::fs::rename(&root, &moved).is_err());
        assert!(std::fs::remove_dir(&root).is_err());
        drop(held);
        std::fs::rename(&root, &moved).unwrap();
        std::fs::remove_dir(&moved).unwrap();
    }
}
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
};
use zeroize::Zeroizing;
fn run() -> std::io::Result<()> {
    let out = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or_else(|| std::io::Error::other("output required"))?,
    );
    let expected: usize = std::env::args()
        .nth(2)
        .ok_or_else(|| std::io::Error::other("length required"))?
        .parse()
        .map_err(|_| std::io::Error::other("invalid length"))?;
    if expected > 16 * 1024 * 1024 {
        return Err(std::io::Error::other("output too large"));
    }
    let parent = out
        .parent()
        .ok_or_else(|| std::io::Error::other("parent required"))?;
    let temp = parent.join(format!(".passshare-export-{}.tmp", uuid::Uuid::new_v4()));
    let mut bytes = Zeroizing::new(Vec::new());
    std::io::stdin()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() != expected {
        return Err(std::io::Error::other("output too large"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
        unsafe extern "system" {
            fn GetFileInformationByHandle(h: *mut std::ffi::c_void, p: *mut u32) -> i32;
            fn GetFinalPathNameByHandleW(
                h: *mut std::ffi::c_void,
                p: *mut u16,
                n: u32,
                flags: u32,
            ) -> u32;
            fn SetFileInformationByHandle(
                h: *mut std::ffi::c_void,
                c: u32,
                p: *const std::ffi::c_void,
                n: u32,
            ) -> i32;
        }
        // Pin the selected directory against rename/deletion throughout creation,
        // publication and cleanup. No UI or credential capability is added.
        let _directory = pin_directory(parent)?;
        let expected_volume = std::env::args().nth(3).and_then(|s| s.parse::<u64>().ok());
        let expected_index = std::env::args().nth(4).and_then(|s| s.parse::<u64>().ok());
        if let (Some(volume), Some(index)) = (expected_volume, expected_index) {
            let mut info = [0u32; 13];
            if unsafe { GetFileInformationByHandle(_directory.as_raw_handle(), info.as_mut_ptr()) }
                == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let actual_index = ((info[11] as u64) << 32) | info[12] as u64;
            if info[7] as u64 != volume || actual_index != index {
                return Err(std::io::Error::other("selected directory changed"));
            }
        }
        let mut f = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .access_mode(0xC0010000)
            .share_mode(0)
            .open(&temp)?;
        let result = (|| {
            f.write_all(&bytes)?;
            f.sync_all()?;
            let target: Vec<u16> = out.as_os_str().encode_wide().collect();
            // FILE_RENAME_INFO: BOOLEAN + aligned HANDLE + DWORD + WCHAR[].
            let offset = std::mem::size_of::<usize>() * 2 + 4;
            let len = offset + (target.len() + 1) * 2;
            let mut info = vec![0usize; len.div_ceil(std::mem::size_of::<usize>())];
            let p = info.as_mut_ptr().cast::<u8>();
            unsafe {
                p.add(std::mem::size_of::<usize>() * 2)
                    .cast::<u32>()
                    .write_unaligned((target.len() * 2) as u32);
                std::ptr::copy_nonoverlapping(
                    target.as_ptr().cast::<u8>(),
                    p.add(offset),
                    target.len() * 2,
                );
                if SetFileInformationByHandle(f.as_raw_handle(), 3, p.cast(), len as u32) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            let mut final_path = vec![0u16; 32768];
            let count = unsafe {
                GetFinalPathNameByHandleW(
                    f.as_raw_handle(),
                    final_path.as_mut_ptr(),
                    final_path.len() as u32,
                    0,
                )
            };
            if count == 0 || count as usize >= final_path.len() {
                return Err(std::io::Error::last_os_error());
            }
            let actual_path = String::from_utf16_lossy(&final_path[..count as usize]);
            let expected_path = std::fs::canonicalize(&out)?.to_string_lossy().into_owned();
            if !actual_path.eq_ignore_ascii_case(&expected_path) {
                return Err(std::io::Error::other("published path differs"));
            }
            f.seek(SeekFrom::Start(0))?;
            let mut actual = Zeroizing::new(Vec::new());
            f.read_to_end(&mut actual)?;
            if *actual != *bytes {
                return Err(std::io::Error::other("published output differs"));
            }
            Ok(())
        })();
        if result.is_err() {
            let delete = 1u8;
            unsafe {
                if SetFileInformationByHandle(
                    f.as_raw_handle(),
                    4,
                    (&delete as *const u8).cast(),
                    1,
                ) == 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            }
        }
        result?;
    }
    #[cfg(not(windows))]
    {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        std::fs::hard_link(&temp, &out)?;
        std::fs::remove_file(&temp)?;
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("Atomic export publication failed");
        std::process::exit(if matches!(error.raw_os_error(), Some(80 | 183)) {
            17
        } else {
            1
        });
    }
}
