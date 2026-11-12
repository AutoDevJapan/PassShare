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
    let parent = out
        .parent()
        .ok_or_else(|| std::io::Error::other("parent required"))?;
    let temp = parent.join(format!(".passshare-export-{}.tmp", uuid::Uuid::new_v4()));
    let mut bytes = Zeroizing::new(Vec::new());
    std::io::stdin()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(std::io::Error::other("output too large"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
        unsafe extern "system" {
            fn SetFileInformationByHandle(
                h: *mut std::ffi::c_void,
                c: u32,
                p: *const std::ffi::c_void,
                n: u32,
            ) -> i32;
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
            let len = offset + target.len() * 2;
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
