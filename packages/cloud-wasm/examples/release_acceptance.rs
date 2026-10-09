//! Execute the actual release WASM, with Node used only as its bindings host.
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let web = args.first().is_some_and(|arg| arg == "--web");
    let bindings = args.get(usize::from(web)).expect("generated bindings path");
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
  const accountA = {accountId: f.owner.ownerAccountId, identityVersion: 1};
  const accountB = {accountId: '22222222-2222-4222-8222-222222222222', identityVersion: 1};
  const accountC = {accountId: '33333333-3333-4333-8333-333333333333', identityVersion: 1};
  const a = new api.CloudAccountIdentity(JSON.stringify(accountA));
  const b = new api.CloudAccountIdentity(JSON.stringify(accountB));
  const c = new api.CloudAccountIdentity(JSON.stringify(accountC));
  const aPublic = a.publicIdentity(), bPublic = b.publicIdentity();
  const pinnedA = JSON.parse(aPublic), pinnedB = JSON.parse(bPublic);
  const identityBundle = a.wrap(f.password);
  a.lock();
  const restoredA = api.CloudAccountIdentity.unlock(identityBundle, f.password, JSON.stringify(accountA), pinnedA.keyId);
  const ownerBox = new api.CloudPasswordBox(JSON.stringify(f.owner));
  const sharedContext = {
    passwordBoxId: f.owner.passwordBoxId, keyEpoch: f.owner.keyEpoch,
    senderAccountId: accountA.accountId, recipientAccountId: accountB.accountId,
    senderIdentityVersion: 1, recipientIdentityVersion: 1,
    senderKeyId: pinnedA.keyId, recipientKeyId: pinnedB.keyId
  };
  const wrapped = ownerBox.wrapForRecipient(restoredA, bPublic, JSON.stringify(sharedContext));
  const recipientBox = api.CloudPasswordBox.unlockForRecipient(wrapped, b, aPublic, JSON.stringify(sharedContext));
  const complete = {...f.item, releaseRetained: [3, 1, 2, {unknown: ['kept', null, true]}]};
  const sharedCiphertext = ownerBox.encrypt_item(JSON.stringify(complete), JSON.stringify(f.context));
  const sharedItem = JSON.parse(recipientBox.decrypt_item(sharedCiphertext, JSON.stringify(f.context)));
  let ownerWrapRefused = '', wrongRecipientRefused = '', lockedIdentityRefused = '', sharedLockedRefused = '';
  try { recipientBox.wrap_for_owner(f.password); } catch (e) { ownerWrapRefused = String(e); }
  try { api.CloudPasswordBox.unlockForRecipient(wrapped, c, aPublic, JSON.stringify(sharedContext)); } catch (e) { wrongRecipientRefused = String(e); }
  b.lock();
  try { b.publicIdentity(); } catch (e) { lockedIdentityRefused = String(e); }
  recipientBox.lock();
  try { recipientBox.decrypt_item(sharedCiphertext, JSON.stringify(f.context)); } catch (e) { sharedLockedRefused = String(e); }
  for (const handle of [a, b, c, restoredA, ownerBox, recipientBox]) handle.free();
  process.stdout.write(JSON.stringify({item, locked, refused, sharedItem, ownerWrapRefused, wrongRecipientRefused, lockedIdentityRefused, sharedLockedRefused}));
});
"#;
    let loader = if web {
        r#"
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const api = await import(pathToFileURL(process.argv[1]).href);
await api.default({ module_or_path: readFileSync(process.argv[1].replace(/\.js$/, '_bg.wasm')) });
"#
    } else {
        "const api = require(process.argv[1]);\n"
    };
    let host = format!("{loader}{HOST}");
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
    if web {
        command.args(["--input-type=module", "--experimental-default-type=module"]);
    }
    let mut child = command
        .arg("-e")
        .arg(host)
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
    let mut complete = fixture["item"].clone();
    complete["releaseRetained"] = serde_json::json!([3, 1, 2, {"unknown":["kept",null,true]}]);
    assert_eq!(result["sharedItem"], complete);
    assert_eq!(result["ownerWrapRefused"], "PS051: Invalid encrypted data");
    assert_eq!(
        result["wrongRecipientRefused"],
        "PS051: Invalid encrypted data"
    );
    assert_eq!(
        result["lockedIdentityRefused"],
        "PS057: Account identity is locked"
    );
    assert_eq!(
        result["sharedLockedRefused"],
        "PS057: Password box is locked"
    );
    println!("actual release WASM: format1/NFC, generated JS identity/shared API, full DTO, recipient owner restriction and lock rejection passed");
}
