//! Execute the actual release WASM, with Node used only as its bindings host.
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
fn main() {
    let bindings = std::env::args_os()
        .nth(1)
        .expect("generated Node bindings path");
    let bindings = std::path::PathBuf::from(bindings).canonicalize().unwrap();
    // Node's CommonJS realpath cannot import Windows extended-length paths.
    // The canonical target remains the same owned file.
    #[cfg(windows)]
    let bindings = {
        let text = bindings.to_string_lossy();
        if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
            std::path::PathBuf::from(format!(r"\\{unc}"))
        } else if let Some(path) = text.strip_prefix(r"\\?\").filter(|path| {
            let bytes = path.as_bytes();
            bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && bytes[2] == b'\\'
        }) {
            std::path::PathBuf::from(path)
        } else {
            bindings
        }
    };
    // Transport glue only. Rust below verifies the returned values.
    const HOST: &str = r#"
const api = require(process.argv[1]);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const f = JSON.parse(input);
  const key = api.CloudPasswordBox.unlock(JSON.stringify(f.bundle), f.password, JSON.stringify(f.owner));
  const item = JSON.parse(key.decrypt_item(JSON.stringify(f.envelope), JSON.stringify(f.context)));
  key.lock();
  const locked = key.is_locked();
  let refused = '';
  try { key.decrypt_item(JSON.stringify(f.envelope), JSON.stringify(f.context)); } catch (e) { refused = String(e); }
  key.free();
  process.stdout.write(JSON.stringify({item, locked, refused}));
});
"#;
    let mut command = Command::new("node");
    command.env_clear();
    for key in ["PATH", "SystemRoot", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .arg("-e")
        .arg(HOST)
        .arg(bindings)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut fixture: Value =
        serde_json::from_str(include_str!("../tests/format1-vector.json")).unwrap();
    fixture["password"] = Value::String("Synthetic format1 e\u{301} password!".into());
    child
        .stdin
        .take()
        .unwrap()
        .write_all(fixture.to_string().as_bytes())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    if !result.status.success() {
        eprintln!(
            "release host exit={:?}, diagnostic bytes={}",
            result.status.code(),
            result.stderr.len()
        );
        let diagnostic = String::from_utf8_lossy(&result.stderr);
        for line in diagnostic
            .lines()
            .filter(|line| {
                [
                    "TypeError",
                    "ReferenceError",
                    "RuntimeError",
                    "PS051",
                    "SyntaxError",
                ]
                .iter()
                .any(|tag| line.contains(tag))
            })
            .take(3)
        {
            eprintln!(
                "release WASM diagnostic: {}",
                line.chars().take(180).collect::<String>()
            );
        }
    }
    assert!(result.status.success(), "actual release WASM host failed");
    let result: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(result["item"], fixture["item"]);
    assert_eq!(result["locked"], true);
    assert_eq!(result["refused"], "PS057: Password box is locked");
    println!("actual release WASM: fixed format1/NFC restoration and locked rejection passed");
}
