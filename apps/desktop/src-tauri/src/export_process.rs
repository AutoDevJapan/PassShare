#[cfg(windows)]
mod windows {
    use std::{
        ffi::c_void,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    unsafe extern "system" {
        fn CreateJobObjectW(a: *const c_void, n: *const u16) -> *mut c_void;
        fn AssignProcessToJobObject(j: *mut c_void, p: *mut c_void) -> i32;
        fn TerminateJobObject(j: *mut c_void, c: u32) -> i32;
        fn QueryInformationJobObject(
            j: *mut c_void,
            c: u32,
            p: *mut c_void,
            n: u32,
            r: *mut u32,
        ) -> i32;
        fn CancelSynchronousIo(t: *mut c_void) -> i32;
        fn NtResumeProcess(p: *mut c_void) -> i32;
    }
    pub struct Tree(OwnedHandle);
    impl Tree {
        pub fn attach(child: &std::process::Child) -> std::io::Result<Self> {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return Err(std::io::Error::last_os_error());
                }
                let tree = Self(OwnedHandle::from_raw_handle(h));
                if AssignProcessToJobObject(tree.0.as_raw_handle(), child.as_raw_handle()) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if NtResumeProcess(child.as_raw_handle()) < 0 {
                    return Err(std::io::Error::other("resume failed"));
                }
                Ok(tree)
            }
        }
        pub fn stop(&self) -> bool {
            unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) != 0 }
        }
        pub fn empty(&self) -> bool {
            let mut data = [0u64; 6];
            unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    1,
                    data.as_mut_ptr().cast(),
                    48,
                    std::ptr::null_mut(),
                ) != 0
                    && *((data.as_ptr().cast::<u8>()).add(40).cast::<u32>()) == 0
            }
        }
    }
    pub fn cancel_writer<T>(writer: &std::thread::JoinHandle<T>) {
        unsafe {
            CancelSynchronousIo(writer.as_raw_handle());
        }
    }
}
#[cfg(windows)]
pub use windows::*;
