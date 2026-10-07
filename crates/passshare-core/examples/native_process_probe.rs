//! Record only the lifecycle of synthetic Linux native acceptance processes.
use std::process::Command;

fn main() {
    let status = match Command::new("/usr/bin/WebKitWebDriver")
        .args(std::env::args_os().skip(1))
        .status()
    {
        Ok(status) => status,
        Err(_) => {
            eprintln!("native webdriver process probe: spawn failed");
            std::process::exit(1);
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        eprintln!(
            "native webdriver process probe: code={:?}, signal={:?}",
            status.code(),
            status.signal()
        );
    }
    #[cfg(not(unix))]
    eprintln!("native webdriver process probe: code={:?}", status.code());
    std::process::exit(status.code().unwrap_or(1));
}
