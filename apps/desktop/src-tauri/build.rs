fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!(r#"cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"#);
    }
}
