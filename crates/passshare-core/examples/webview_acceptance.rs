//! Finite native WebView acceptance in an isolated Linux CI display.
//! No production accounts, browser profiles or credentials are used.

use base64::{engine::general_purpose::STANDARD, Engine};
use passshare_core::PasswordBox;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Child;
#[cfg(unix)]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use zeroize::{Zeroize, Zeroizing};

const LIMIT: usize = 4 * 1024 * 1024;

// serde_json::Value cannot implement Zeroize. Own secret-bearing DTOs and
// transport arguments here so their string leaves are erased even on failure.
struct SecretJson(Value);
impl Drop for SecretJson {
    fn drop(&mut self) {
        fn erase(value: &mut Value) {
            match value {
                Value::String(text) => text.zeroize(),
                Value::Array(values) => values.iter_mut().for_each(erase),
                Value::Object(values) => values.values_mut().for_each(erase),
                _ => {}
            }
        }
        erase(&mut self.0);
    }
}

fn remaining(deadline: Instant, limit: Duration) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
        .map(|left| left.min(limit))
        .ok_or_else(|| "absolute transport deadline".into())
}

fn read_response(socket: &mut TcpStream, deadline: Instant) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        socket
            .set_read_timeout(Some(remaining(deadline, Duration::from_secs(10))?))
            .map_err(|_| "read deadline")?;
        let count = socket.read(&mut buffer).map_err(|_| "response deadline")?;
        if count == 0 {
            if let Some(split) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers =
                    std::str::from_utf8(&bytes[..split]).map_err(|_| "response header encoding")?;
                if headers
                    .lines()
                    .skip(1)
                    .filter_map(|line| line.split_once(':'))
                    .any(|(name, _)| {
                        name.eq_ignore_ascii_case("content-length")
                            || name.eq_ignore_ascii_case("transfer-encoding")
                    })
                {
                    return Err("incomplete framed response".into());
                }
            }
            break;
        }
        if bytes.len() + count > LIMIT {
            return Err("driver output limit".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(split) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let headers =
                std::str::from_utf8(&bytes[..split]).map_err(|_| "response header encoding")?;
            let length = headers
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"));
            if let Some((_, length)) = length {
                let length: usize = length.trim().parse().map_err(|_| "response body length")?;
                let end = split
                    .checked_add(4)
                    .and_then(|start| start.checked_add(length))
                    .ok_or("response length overflow")?;
                if end > LIMIT {
                    return Err("driver output limit".into());
                }
                if bytes.len() >= end {
                    bytes.truncate(end);
                    return Ok(bytes);
                }
            } else if headers.lines().skip(1).any(|line| {
                line.split_once(':').is_some_and(|(name, value)| {
                    name.eq_ignore_ascii_case("transfer-encoding")
                        && value.trim().eq_ignore_ascii_case("chunked")
                })
            }) {
                if let Some(body) = decode_chunks(&bytes[split + 4..])? {
                    bytes.truncate(split + 4);
                    bytes.extend_from_slice(&body);
                    return Ok(bytes);
                }
            }
        }
    }
    Ok(bytes)
}

fn write_request(
    socket: &mut TcpStream,
    mut bytes: &[u8],
    deadline: Instant,
) -> Result<(), String> {
    while !bytes.is_empty() {
        socket
            .set_write_timeout(Some(remaining(deadline, Duration::from_secs(5))?))
            .map_err(|_| "write deadline")?;
        let written = socket.write(bytes).map_err(|_| "request write")?;
        if written == 0 {
            return Err("closed request stream".into());
        }
        bytes = &bytes[written..];
    }
    Ok(())
}

fn decode_chunks(input: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let mut position = 0usize;
    let mut body = Vec::new();
    loop {
        let Some(line) = input[position..]
            .windows(2)
            .position(|part| part == b"\r\n")
        else {
            return Ok(None);
        };
        let header =
            std::str::from_utf8(&input[position..position + line]).map_err(|_| "chunk header")?;
        let size = usize::from_str_radix(header.split(';').next().ok_or("chunk size")?.trim(), 16)
            .map_err(|_| "chunk size")?;
        position += line + 2;
        if size == 0 {
            return Ok(
                if input[position..].starts_with(b"\r\n")
                    || input[position..].windows(4).any(|part| part == b"\r\n\r\n")
                {
                    Some(body)
                } else {
                    None
                },
            );
        }
        let end = position.checked_add(size).ok_or("chunk overflow")?;
        if body
            .len()
            .checked_add(size)
            .is_none_or(|length| length > LIMIT)
        {
            return Err("chunk output limit".into());
        }
        let tail = end.checked_add(2).ok_or("chunk overflow")?;
        if input.len() < tail {
            return Ok(None);
        }
        if &input[end..tail] != b"\r\n" {
            return Err("chunk delimiter".into());
        }
        body.extend_from_slice(&input[position..end]);
        position = tail;
    }
}

fn http(method: &str, path: &str, body: &Value, deadline: Instant) -> Result<Value, String> {
    http_at(
        "127.0.0.1:4444".parse().unwrap(),
        method,
        path,
        body,
        deadline,
    )
}

fn http_at(
    address: SocketAddr,
    method: &str,
    path: &str,
    body: &Value,
    deadline: Instant,
) -> Result<Value, String> {
    let mut socket =
        TcpStream::connect_timeout(&address, remaining(deadline, Duration::from_secs(5))?)
            .map_err(|_| "driver connection failed")?;
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| "read deadline")?;
    socket
        .set_write_timeout(Some(remaining(deadline, Duration::from_secs(5))?))
        .map_err(|_| "write deadline")?;
    let payload = Zeroizing::new(if method == "GET" {
        Vec::new()
    } else {
        serde_json::to_vec(body).map_err(|_| "request encoding")?
    });
    let headers = format!("{method} {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", payload.len());
    write_request(&mut socket, headers.as_bytes(), deadline)?;
    write_request(&mut socket, &payload, deadline)?;
    let bytes = Zeroizing::new(read_response(&mut socket, deadline)?);
    let split = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .ok_or_else(|| {
            format!(
                "driver {method} response headers absent ({} bytes)",
                bytes.len()
            )
        })?;
    let headers = std::str::from_utf8(&bytes[..split]).map_err(|_| "header encoding")?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or("response status")?;
    if status != "200" {
        return Err(format!("driver status {status}"));
    }
    let mut result =
        SecretJson(serde_json::from_slice(&bytes[split + 4..]).map_err(|_| "response JSON")?);
    if result
        .0
        .get("value")
        .and_then(|value| value.get("error"))
        .is_some()
    {
        return Err("driver command rejected".into());
    }
    result
        .0
        .get_mut("value")
        .map(Value::take)
        .ok_or_else(|| "missing driver value".into())
}

#[cfg(any(unix, test))]
fn wait_ready(
    deadline: Instant,
    mut status: impl FnMut(Instant) -> Result<bool, String>,
) -> Result<(), String> {
    let mut last = "not ready".to_owned();
    while Instant::now() < deadline {
        match status(deadline) {
            Ok(true) => return Ok(()),
            Ok(false) => last = "native driver not ready".into(),
            Err(error) => last = error,
        }
        if let Ok(delay) = remaining(deadline, Duration::from_millis(50)) {
            thread::sleep(delay);
        } else {
            break;
        }
    }
    Err(format!("driver startup deadline: {last}"))
}

struct Driver {
    child: Child,
    session: Option<String>,
    deadline: Instant,
}
impl Driver {
    #[cfg(unix)]
    fn start(profile: &Path, trace: &Path) -> Result<Self, String> {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new("tauri-driver");
        let probe = std::env::current_exe()
            .map_err(|_| "acceptance executable")?
            .with_file_name("native_process_probe");
        command.args([
            "--native-driver",
            probe.to_str().ok_or("native probe path")?,
        ]);
        command
            .env_clear()
            .process_group(0)
            .stdout(Stdio::from(
                std::fs::File::create(trace.with_extension("stdout.log"))
                    .map_err(|_| "driver output trace file")?,
            ))
            .stderr(Stdio::from(
                std::fs::File::create(trace).map_err(|_| "driver trace file")?,
            ));
        // XAUTHORITY is the ephemeral display cookie created by xvfb-run in CI,
        // not an account credential or an owner browser profile.
        for name in ["PATH", "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("LANG", "C.UTF-8")
            .env("HOME", profile)
            .env("XDG_DATA_HOME", profile.join("data"))
            .env("XDG_CACHE_HOME", profile.join("cache"))
            .env("XDG_CONFIG_HOME", profile.join("config"))
            .env("LIBGL_ALWAYS_SOFTWARE", "1")
            .env("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
            .env("GDK_BACKEND", "x11");
        let child = command.spawn().map_err(|_| "driver spawn failed")?;
        let mut driver = Self {
            child,
            session: None,
            deadline: Instant::now() + Duration::from_secs(120),
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        wait_ready(deadline, |deadline| {
            if driver
                .child
                .try_wait()
                .map_err(|_| "driver status")?
                .is_some()
            {
                return Err("driver exited".into());
            }
            // The proxy can accept TCP before WebKitWebDriver is listening.
            // Only read-only W3C status probes may be repeated; session POSTs
            // must never be retried after a possibly committed response loss.
            Ok(http("GET", "/status", &json!({}), deadline)?["ready"] == true)
        })?;
        Ok(driver)
    }

    #[cfg(not(unix))]
    fn start(_: &Path, _: &Path) -> Result<Self, String> {
        Err("native acceptance requires isolated Linux CI".into())
    }

    fn open(&mut self, application: &Path) -> Result<(), String> {
        let response = http(
            "POST",
            "/session",
            &json!({"capabilities":{"alwaysMatch":{"browserName":"wry","tauri:options":{"application":application}}}}),
            self.deadline,
        )?;
        let id = response["sessionId"]
            .as_str()
            .ok_or("missing session id")?
            .to_owned();
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("invalid session id".into());
        }
        self.session = Some(id);
        http(
            "POST",
            &self.route("timeouts")?,
            &json!({"script":5000,"pageLoad":10000,"implicit":0}),
            self.deadline,
        )?;
        Ok(())
    }
    fn route(&self, endpoint: &str) -> Result<String, String> {
        Ok(format!(
            "/session/{}/{}",
            self.session.as_deref().ok_or("session absent")?,
            endpoint
        ))
    }
    fn script(&self, source: &str, args: Value) -> Result<Value, String> {
        if Instant::now() >= self.deadline {
            return Err("native acceptance total deadline".into());
        }
        let request = SecretJson(json!({"script":source,"args":args}));
        http(
            "POST",
            &self.route("execute/async")?,
            &request.0,
            self.deadline,
        )
    }
    fn invoke(&self, command: &str, args: Value) -> Result<Value, String> {
        self.script("const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value}),()=>done({ok:false}));", json!([command, args]))
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        if let Some(id) = self.session.take() {
            let _ = http(
                "DELETE",
                &format!("/session/{id}"),
                &json!({}),
                Instant::now() + Duration::from_secs(2),
            );
        }
        #[cfg(unix)]
        {
            // Only this driver's process group, created at spawn, is addressed.
            let group = format!("-{}", self.child.id());
            let _ = Command::new("/bin/kill")
                .args(["-TERM", "--", &group])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            thread::sleep(Duration::from_millis(100));
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &group])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn serve_fixture(socket: &mut TcpStream, requests: &AtomicUsize) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut input = Vec::new();
    let mut buffer = [0u8; 1024];
    while !input.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
        socket
            .set_read_timeout(Some(remaining(deadline, Duration::from_secs(2))?))
            .map_err(|_| "fixture deadline")?;
        let count = socket.read(&mut buffer).map_err(|_| "fixture request")?;
        if count == 0 || input.len() + count > 4096 {
            return Err("incomplete fixture headers".into());
        }
        input.extend_from_slice(&buffer[..count]);
    }
    let line = input
        .split(|byte| *byte == b'\n')
        .next()
        .ok_or("fixture request line")?;
    let (status, content_type, body) = if line.starts_with(b"GET /script.js HTTP/") {
        requests.fetch_add(1, Ordering::Relaxed);
        (
            "200 OK",
            "application/javascript",
            "window.__external_probe=1;",
        )
    } else if line.starts_with(b"GET /probe HTTP/") {
        ("200 OK", "text/plain", "probe-ok")
    } else {
        ("404 Not Found", "text/plain", "not-found")
    };
    socket
        .set_write_timeout(Some(remaining(deadline, Duration::from_secs(2))?))
        .map_err(|_| "fixture write deadline")?;
    let headers = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    write_request(socket, headers.as_bytes(), deadline)?;
    write_request(socket, body.as_bytes(), deadline)?;
    Ok(())
}

struct Fixture {
    stop: Arc<AtomicBool>,
    script_requests: Arc<AtomicUsize>,
    thread: Option<thread::JoinHandle<()>>,
    port: u16,
}
impl Fixture {
    fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "fixture bind")?;
        let port = listener.local_addr().map_err(|_| "fixture address")?.port();
        listener.set_nonblocking(true).map_err(|_| "fixture mode")?;
        let stop = Arc::new(AtomicBool::new(false));
        let script_requests = Arc::new(AtomicUsize::new(0));
        let stopping = stop.clone();
        let requests = script_requests.clone();
        let thread = thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                if let Ok((mut socket, _)) = listener.accept() {
                    // Winsock accept inherits the listener's nonblocking mode.
                    // Restore blocking I/O before applying finite read deadlines.
                    if socket.set_nonblocking(false).is_ok() {
                        let _ = serve_fixture(&mut socket, &requests);
                    }
                } else {
                    thread::sleep(Duration::from_millis(10));
                }
            }
        });
        Ok(Self {
            stop,
            script_requests,
            thread: Some(thread),
            port,
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn ensure(value: bool, label: &str) -> Result<(), String> {
    if value {
        Ok(())
    } else {
        Err(label.into())
    }
}

fn open_desktop_ui(driver: &Driver, path: &Path, master: &str) -> Result<(), String> {
    let opened = driver.script("const done=arguments[arguments.length-1];const inputs=document.querySelectorAll('#setup-heading~label input');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;inputs.forEach((el,i)=>{setter.call(el,arguments[i]);el.dispatchEvent(new Event('input',{bubbles:true}));});setTimeout(()=>{const button=document.querySelector('[data-testid=\"open-password-box\"]');if(!button || button.disabled){done(false);return;}button.click();const end=Date.now()+3000;const probe=()=>{if(document.querySelector('.ps-item-card__title')?.textContent==='Lock fixture')done(true);else if(Date.now()<end)setTimeout(probe,25);else done(false);};probe();},50);", json!([path,master]))?;
    ensure(
        opened == true,
        "actual desktop unlock screen did not show fixture",
    )?;
    let before = driver.script("const done=arguments[arguments.length-1];const input=document.querySelector('input[type=password]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,arguments[0]);input.dispatchEvent(new Event('input',{bubbles:true}));done(input.value===arguments[0] && !!document.querySelector('.ps-item-card'));", json!([master]))?;
    ensure(before == true, "secret UI precondition absent")
}

fn assert_locked_ui(driver: &Driver) -> Result<(), String> {
    ensure(driver.script("const done=arguments[arguments.length-1];const end=Date.now()+2000;const probe=()=>{if(document.querySelector('#setup-heading') && !document.querySelector('[type=password]')?.value && !document.querySelector('.ps-item-card'))done(true);else if(Date.now()<end)setTimeout(probe,25);else done(false);};probe();", json!([]))? == true, "lock retained password input or list")
}

fn random_secret() -> Result<Zeroizing<String>, String> {
    let mut entropy = Zeroizing::new([0u8; 32]);
    getrandom::fill(entropy.as_mut()).map_err(|_| "recovery fixture entropy")?;
    Ok(Zeroizing::new(STANDARD.encode(entropy.as_ref())))
}

fn full_payload(path: &Path, password: &str) -> Result<SecretJson, String> {
    use passshare_core::crypto::{decrypt, derive_master_key_with_params};
    use passshare_core::storage::file_format::PasswordBoxFile;
    let file = PasswordBoxFile::load_from_path(path).map_err(|_| "recovery fixture file")?;
    let key = derive_master_key_with_params(
        password,
        &file.kdf.salt_bytes().map_err(|_| "recovery fixture salt")?,
        file.kdf.memory_kib,
        file.kdf.time_cost,
        file.kdf.parallelism,
    )
    .map_err(|_| "recovery fixture key")?;
    let plaintext = Zeroizing::new(
        decrypt(
            &file.ciphertext,
            &key,
            &file
                .cipher
                .nonce_bytes()
                .map_err(|_| "recovery fixture nonce")?,
        )
        .map_err(|_| "recovery fixture decrypt")?,
    );
    serde_json::from_slice(&plaintext)
        .map(SecretJson)
        .map_err(|_| "recovery fixture payload".into())
}

fn successful_value(driver: &Driver, command: &str, args: Value) -> Result<SecretJson, String> {
    let mut reply = SecretJson(driver.invoke(command, args)?);
    ensure(
        reply.0["ok"] == true,
        "recovery fixture native command failed",
    )?;
    reply
        .0
        .get_mut("value")
        .map(Value::take)
        .map(SecretJson)
        .ok_or_else(|| "recovery fixture native value absent".into())
}

fn unchanged_file(path: &Path, original: &[u8]) -> Result<bool, String> {
    let current = std::fs::read(path).map_err(|_| "recovery fixture bytes absent")?;
    Ok(current == original && Sha256::digest(&current) == Sha256::digest(original))
}

fn wait_dom(driver: &Driver, condition: &str, label: &str) -> Result<(), String> {
    // Conditions are static source, never credentials. The driver's absolute
    // deadline also bounds this finite renderer poll.
    let source = format!("const done=arguments[arguments.length-1];const end=Date.now()+3000;const probe=()=>{{if({condition})done(true);else if(Date.now()<end)setTimeout(probe,25);else done(false);}};probe();");
    ensure(driver.script(&source, json!([]))? == true, label)
}

fn open_recovery_ui(driver: &Driver) -> Result<(), String> {
    wait_dom(
        driver,
        "!!document.querySelector('[data-testid=\"recover-password-box\"]:not(:disabled)')",
        "recovery setup button absent",
    )?;
    ensure(
        driver.script(
            r#"
        const done=arguments[arguments.length-1];
        const button=document.querySelector('[data-testid="recover-password-box"]');
        if(!button || button.disabled){done(false);return;}
        button.click();done(true);
    "#,
            json!([]),
        )? == true,
        "recovery setup click failed",
    )?;
    wait_dom(driver, "!!document.querySelector('#local-recovery-heading')?.closest('section')?.querySelector('form button[type=submit]:not(:disabled)')", "recovery form not ready")
}

fn fill_recovery_ui(
    driver: &Driver,
    path: &Path,
    code: &str,
    password: &str,
    confirmation: &str,
) -> Result<(), String> {
    ensure(driver.script(r#"
        const done=arguments[arguments.length-1];
        const form=document.querySelector('#local-recovery-heading')?.closest('section')?.querySelector('form');
        const inputs=form?.querySelectorAll('input');
        if(!inputs || inputs.length!==4 || [...inputs].some(el=>el.disabled)) {done(false);return;}
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        inputs.forEach((el,i)=>{setter.call(el,arguments[i]);el.dispatchEvent(new Event('input',{bubbles:true}));});
        done([...inputs].every((el,i)=>el.value===arguments[i]) && inputs[0].type==='text'
            && [...inputs].slice(1).every(el=>el.type==='password') && form.checkValidity());
    "#, json!([path, code, password, confirmation]))? == true, "recovery form fill precondition failed")
}

fn submit_recovery_ui(driver: &Driver) -> Result<(), String> {
    ensure(driver.script(r#"
        const done=arguments[arguments.length-1];
        const form=document.querySelector('#local-recovery-heading')?.closest('section')?.querySelector('form');
        const submit=form?.querySelector('button[type=submit]');
        if(!submit || submit.disabled || !form.checkValidity()){done(false);return;}
        submit.click();done(true);
    "#, json!([]))? == true, "recovery form submit precondition failed")
}

fn cancel_recovery_ui(driver: &Driver) -> Result<(), String> {
    ensure(driver.script(r#"
        const done=arguments[arguments.length-1];
        const section=document.querySelector('#local-recovery-heading')?.closest('section');
        const inputs=section?.querySelectorAll('form input');
        const output=section?.querySelector('textarea');
        const cancel=section?.querySelector(':scope > .ps-actions button');
        if(!inputs || inputs.length!==4 || ![...inputs].every(el=>el.value) || !cancel || cancel.disabled){done(false);return;}
        // Keep the real detached refs in this callback, not on window. Merely
        // removing the form cannot satisfy the erasure assertion.
        const secrets=[...inputs].slice(1);
        cancel.click();
        const end=Date.now()+3000;
        const probe=()=>{
            const setup=document.querySelector('#setup-heading')?.closest('section');
            if(setup && !document.querySelector('#local-recovery-heading')
                && !document.querySelector('.ps-recovery-secret') && !document.querySelector('.ps-item-card')
                && [...setup.querySelectorAll('input')].every(el=>!el.value)
                && secrets.every(el=>!el.isConnected && !el.value) && (!output || !output.value))done(true);
            else if(Date.now()<end)setTimeout(probe,25);else done(false);
        };probe();
    "#, json!([]))? == true, "recovery cancellation retained form or secrets")
}

fn assert_native_locked(driver: &Driver) -> Result<(), String> {
    let status = successful_value(driver, "native_session_status", json!({}))?;
    ensure(
        status.0["unlocked"] == false,
        "recovery rejection unlocked native state",
    )?;
    ensure(
        driver.invoke("list_items", json!({}))?["ok"] == false,
        "recovery rejection allowed secret read",
    )
}

fn run_local_recovery(application: &Path, output: &Path) -> Result<(), String> {
    let temp = tempfile::TempDir::new().map_err(|_| "recovery fixture directory")?;
    std::fs::create_dir_all(output).map_err(|_| "recovery output directory")?;
    let mut driver = Driver::start(temp.path(), &output.join("desktop-recovery-driver.log"))?;
    driver.open(application)?;
    // No production idle override. This entire mode ends inside 120 seconds.
    assert_locked_ui(&driver)?;
    assert_native_locked(&driver)?;
    let old_password = random_secret()?;
    let new_password = random_secret()?;
    let item_password = random_secret()?;
    let note_body = random_secret()?;
    let mismatch = random_secret()?;
    ensure(
        old_password != new_password && mismatch != new_password,
        "recovery entropy collision",
    )?;
    let path = temp.path().join("recovery.pbox");
    let mut created = successful_value(
        &driver,
        "create_password_box",
        json!({"path":path,"masterPassword":old_password.as_str()}),
    )?;
    let code = match created.0.take() {
        Value::String(code) if !code.is_empty() => Zeroizing::new(code),
        _ => return Err("create did not return recovery code".into()),
    };
    let added = successful_value(
        &driver,
        "add_item",
        json!({
            "category":"LOGIN", "title":"Lock fixture", "password":item_password.as_str(),
            "username":"synthetic-user", "url":"https://synthetic.invalid/recovery",
            "notes":"Synthetic recovery notes", "tags":["synthetic","recovery"], "favorite":true,
            "masterPassword":old_password.as_str()
        }),
    )?;
    let saved = successful_value(&driver, "list_items", json!({}))?;
    let added_note = successful_value(
        &driver,
        "add_item",
        json!({
            "category":"SECURE_NOTE", "title":"Recovery body fixture", "body":note_body.as_str(),
            "tags":["recovery","body"], "favorite":false, "masterPassword":old_password.as_str()
        }),
    )?;
    let expected = SecretJson(json!([
        {"id":added.0["id"], "title":"Lock fixture", "category":"LOGIN",
         "tags":["synthetic","recovery"], "favorite":true, "url":"https://synthetic.invalid/recovery",
         "username":"synthetic-user", "password":item_password.as_str(), "body":null,
         "notes":"Synthetic recovery notes"},
        {"id":added_note.0["id"], "title":"Recovery body fixture", "category":"SECURE_NOTE",
         "tags":["recovery","body"], "favorite":false, "url":null, "username":null,
         "password":null, "body":note_body.as_str(), "notes":null}
    ]));
    for item in [&added.0, &added_note.0] {
        let id = item["id"]
            .as_str()
            .ok_or("recovery generated item ID missing")?;
        id.parse::<passshare_core::ConnectId>()
            .map_err(|_| "invalid recovery generated item ID")?;
    }
    ensure(
        added.0["id"] != added_note.0["id"]
            && added.0 == expected.0[0]
            && added_note.0 == expected.0[1]
            && saved.0 == json!([expected.0[0]]),
        "recovery full DTO precondition failed",
    )?;
    let saved = successful_value(&driver, "list_items", json!({}))?;
    ensure(saved.0 == expected.0, "recovery stored input DTO mismatch")?;
    let original_payload = full_payload(&path, &old_password)?;
    let original = std::fs::read(&path).map_err(|_| "recovery original bytes")?;
    successful_value(&driver, "lock_password_box", json!({}))?;
    assert_locked_ui(&driver)?;

    // Independent cancellation while locked, before any successful rekey.
    open_recovery_ui(&driver)?;
    fill_recovery_ui(&driver, &path, &code, &new_password, &new_password)?;
    cancel_recovery_ui(&driver)?;
    assert_native_locked(&driver)?;
    ensure(
        unchanged_file(&path, &original)?,
        "cancel changed recovery file",
    )?;
    // Capture only the cleared synthetic setup screen; never the code form.
    let screenshot = http(
        "GET",
        &driver.route("screenshot")?,
        &json!({}),
        driver.deadline,
    )?;
    let png = STANDARD
        .decode(screenshot.as_str().ok_or("recovery screenshot response")?)
        .map_err(|_| "recovery screenshot encoding")?;
    std::fs::write(output.join("desktop-local-recovery-cancel.png"), png)
        .map_err(|_| "recovery screenshot write")?;

    open_recovery_ui(&driver)?;
    fill_recovery_ui(&driver, &path, &code, &new_password, &mismatch)?;
    submit_recovery_ui(&driver)?;
    wait_dom(&driver, "!!document.querySelector('#local-recovery-heading')?.closest('section')?.querySelector('[role=alert]')?.textContent && !document.querySelector('.ps-item-card')", "mismatch UI error absent")?;
    assert_native_locked(&driver)?;
    ensure(
        unchanged_file(&path, &original)?,
        "mismatch changed recovery file",
    )?;

    // Only the confirmation changes. The actual React form invokes recovery.
    ensure(driver.script(r#"
        const done=arguments[arguments.length-1];
        const inputs=document.querySelector('#local-recovery-heading')?.closest('section')?.querySelectorAll('form input');
        if(!inputs || inputs.length!==4 || inputs[3].disabled){done(false);return;}
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        setter.call(inputs[3],arguments[0]);inputs[3].dispatchEvent(new Event('input',{bubbles:true}));
        done(inputs[3].value===arguments[0]);
    "#, json!([new_password.as_str()]))? == true, "recovery confirmation correction failed")?;
    submit_recovery_ui(&driver)?;
    wait_dom(&driver, "!document.querySelector('#local-recovery-heading') && document.querySelector('.ps-item-card__title')?.textContent==='Lock fixture' && !document.querySelector('.ps-recovery-secret')", "recovery UI did not show saved item")?;
    ensure(driver.script("const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(()=>done(true),0)));", json!([]))? == true,
        "recovery renderer cleanup did not settle")?;
    // Flush renderer effects and a native round-trip after the form unmounts:
    // a cleanup that relocks the box must fail this read/status observation.
    ensure(
        successful_value(&driver, "list_items", json!({}))?.0 == saved.0,
        "recovery changed full UI DTO",
    )?;
    let status = successful_value(&driver, "native_session_status", json!({}))?;
    ensure(
        status.0["unlocked"] == true,
        "successful form cleanup relocked native state",
    )?;
    wait_dom(
        &driver,
        "!document.querySelector('#setup-heading') && !!document.querySelector('.ps-item-card')",
        "recovery cleanup removed unlocked UI",
    )?;

    // Authenticate the same existing original path before the old-password
    // negative check, so a missing/corrupt file cannot masquerade as rejection.
    let reopened = PasswordBox::open(&path, &new_password)
        .map_err(|_| "new recovery password cannot open original file")?;
    ensure(
        reopened
            .list_connect_items()
            .map_err(|_| "recovery reopened items")?
            .len()
            == 2,
        "recovery reopened fixture missing",
    )?;
    ensure(
        full_payload(&path, &new_password)?.0 == original_payload.0,
        "recovery changed full encrypted payload",
    )?;
    ensure(
        !unchanged_file(&path, &original)?,
        "successful recovery did not rekey file",
    )?;
    ensure(
        matches!(
            PasswordBox::open(&path, &old_password),
            Err(passshare_core::PassShareError::InvalidMasterPassword)
        ),
        "old recovery password was not rejected by authentication",
    )?;
    let rekeyed = std::fs::read(&path).map_err(|_| "rekeyed recovery bytes")?;
    let reused =
        PasswordBox::recover(&path, &code).map_err(|_| "recovery code was unexpectedly rotated")?;
    let reopened_items = SecretJson(
        serde_json::to_value(reopened.list_connect_items().map_err(|_| "reopened DTO")?)
            .map_err(|_| "reopened DTO encoding")?,
    );
    let reused_items = SecretJson(
        serde_json::to_value(
            reused
                .list_connect_items()
                .map_err(|_| "reused recovery DTO")?,
        )
        .map_err(|_| "reused DTO encoding")?,
    );
    ensure(
        reused_items.0 == reopened_items.0 && unchanged_file(&path, &rekeyed)?,
        "read-only code reuse changed contents",
    )?;

    successful_value(&driver, "lock_password_box", json!({}))?;
    assert_locked_ui(&driver)?;
    ensure(
        driver.invoke(
            "open_password_box",
            json!({"path":path,"masterPassword":old_password.as_str()}),
        )?["ok"]
            == false,
        "native open accepted old recovery password",
    )?;
    assert_native_locked(&driver)?;
    open_desktop_ui(&driver, &path, &new_password)?;
    ensure(
        successful_value(&driver, "list_items", json!({}))?.0 == saved.0,
        "new password UI reopen lost DTO",
    )?;
    successful_value(&driver, "lock_password_box", json!({}))?;
    assert_locked_ui(&driver)?;
    ensure(
        unchanged_file(&path, &rekeyed)?,
        "authentication checks changed recovery file",
    )?;
    std::fs::write(output.join("desktop-local-recovery.json"), serde_json::to_vec_pretty(&json!({
        "realLinuxRenderer":true, "desktopOnly":true, "syntheticOnly":true, "physicalAndroid":false,
        "actualRecoveryForm":true, "fixtureItems":2, "independentInputDto":true, "mismatchRejected":true,
        "mismatchBytesAndHashPreserved":true, "mismatchRemainedLocked":true,
        "cancelErasedDetachedRefs":true, "cancelSetupBlank":true, "cancelBytesAndHashPreserved":true,
        "cancelRemainedLocked":true, "successfulUnmountRemainedUnlocked":true,
        "newPasswordOpenedOriginalFile":true, "oldPasswordAuthenticationRejected":true,
        "fullDtoPreserved":true, "fullPayloadPreserved":true, "reusableCodePreserved":true
    })).map_err(|_| "recovery proof encoding")?).map_err(|_| "recovery proof write")?;
    println!("native desktop local recovery acceptance succeeded");
    Ok(())
}

fn run_auto_lock(application: &Path, output: &Path) -> Result<(), String> {
    let temp = tempfile::TempDir::new().map_err(|_| "lock fixture directory")?;
    std::fs::create_dir_all(output).map_err(|_| "lock output directory")?;
    let mut driver = Driver::start(temp.path(), &output.join("desktop-lock-driver.log"))?;
    driver.open(application)?;
    driver.deadline = Instant::now() + Duration::from_secs(360);
    ensure(
        driver.invoke("native_is_unlocked", json!({}))?["value"] == false,
        "restart did not begin locked",
    )?;
    let mut entropy = [0u8; 32];
    getrandom::fill(&mut entropy).map_err(|_| "lock fixture entropy")?;
    let master = STANDARD.encode(entropy);
    let path = temp.path().join("lock.pbox");
    ensure(
        driver.invoke(
            "create_password_box",
            json!({"path":path,"masterPassword":master}),
        )?["ok"]
            == true,
        "lock create failed",
    )?;
    ensure(driver.invoke("add_item", json!({"category":"LOGIN","title":"Lock fixture","password":master,"masterPassword":master}))?["ok"] == true, "lock item failed")?;
    let saved = driver.invoke("list_items", json!({}))?["value"].clone();
    ensure(
        saved.as_array().is_some_and(|items| items.len() == 1),
        "lock fixture count",
    )?;
    // Fixture IPC leaves the native box unlocked. The renderer can correctly
    // observe that state during startup and show its main screen. Begin the
    // actual unlock-screen checks from a proven locked UI/native boundary.
    ensure(
        driver.invoke("lock_password_box", json!({}))?["ok"] == true,
        "lock fixture preparation did not lock",
    )?;
    assert_locked_ui(&driver)?;
    assert_native_locked(&driver)?;
    // Reopen and close twice. Each native transition has its own epoch and
    // must destroy the secret-bearing UI; the UI may also observe its poll.
    for _ in 0..2 {
        open_desktop_ui(&driver, &path, &master)?;
        ensure(
            driver.invoke("lock_password_box", json!({}))?["ok"] == true,
            "manual lock failed",
        )?;
        assert_locked_ui(&driver)?;
    }
    open_desktop_ui(&driver, &path, &master)?;
    ensure(
        driver.invoke("list_items", json!({}))?["value"] == saved,
        "manual reopen changed contents",
    )?;
    let ciphertext = std::fs::read(&path).map_err(|_| "lock ciphertext")?;
    // Measure the production five-minute duration, without test-only overrides.
    let started = Instant::now();
    thread::sleep(Duration::from_secs(298));
    ensure(
        driver.invoke("native_is_unlocked", json!({}))?["value"] == true,
        "session expired before five minutes",
    )?;
    ensure(
        driver.invoke("list_items", json!({}))?["value"] == saved,
        "read during idle changed contents",
    )?;
    thread::sleep(Duration::from_secs(4));
    ensure(
        driver.invoke("native_is_unlocked", json!({}))?["value"] == false,
        "production idle deadline did not lock",
    )?;
    ensure(
        driver.invoke("native_activity", json!({}))?["value"] == false,
        "late activity reopened session",
    )?;
    ensure(
        driver.invoke("list_items", json!({}))?["ok"] == false,
        "idle secret read accepted",
    )?;
    for command in ["search_items", "export_onepassword_csv", "add_item"] {
        let args = if command == "search_items" {
            json!({"query":"fixture"})
        } else if command == "add_item" {
            json!({"category":"LOGIN","title":"Blocked","password":master,"masterPassword":master})
        } else {
            json!({})
        };
        ensure(
            driver.invoke(command, args)?["ok"] == false,
            "idle secret command accepted",
        )?;
    }
    assert_locked_ui(&driver)?;
    ensure(
        std::fs::read(&path).map_err(|_| "idle ciphertext")? == ciphertext,
        "idle lock changed ciphertext",
    )?;
    open_desktop_ui(&driver, &path, &master)?;
    ensure(
        driver.invoke("list_items", json!({}))?["value"] == saved,
        "idle reopen contents changed",
    )?;
    driver.invoke("lock_password_box", json!({}))?;
    assert_locked_ui(&driver)?;
    std::fs::write(output.join("desktop-auto-lock.json"), serde_json::to_vec_pretty(&json!({"nativeFlavor":"desktop","productionIdleSeconds":300,"measuredIdleSeconds":started.elapsed().as_secs_f64(),"manualRelockObserved":2,"secretUiBeforeLock":true,"secretUiAfterLock":false,"idleRequiresAuthentication":true,"lockedSecretCommandsRejected":true,"ciphertextPreserved":true,"backgroundAccepted":false,"physicalMobile":false,"syntheticOnly":true})).map_err(|_| "lock result encode")?).map_err(|_| "lock result write")?;
    println!("native desktop production idle acceptance succeeded");
    Ok(())
}
fn run_mobile_lock(application: &Path, output: &Path) -> Result<(), String> {
    let temp = tempfile::TempDir::new().map_err(|_| "mobile lock fixture directory")?;
    std::fs::create_dir_all(output).map_err(|_| "mobile lock output directory")?;
    let mut driver = Driver::start(temp.path(), &output.join("mobile-lock-driver.log"))?;
    driver.deadline = Instant::now() + Duration::from_secs(420);
    driver.open(application)?;
    let boot = driver.script("const done=arguments[arguments.length-1];const end=Date.now()+5000;const probe=()=>{if(document.querySelector('input'))done(true);else if(Date.now()<end)setTimeout(probe,25);else done(false)};probe();", json!([]))?;
    ensure(boot == true, "mobile startup restoration did not settle")?;
    ensure(
        driver.invoke("native_foreground", json!({}))?["ok"] == true,
        "mobile initial foreground sync failed",
    )?;
    let before = driver.invoke("native_session_status", json!({}))?;
    ensure(
        before["ok"] == true && before["value"]["unlocked"] == false,
        "mobile starts locked",
    )?;
    let account = driver.invoke(
        "native_account",
        json!({"id":"synthetic-mobile-user","epoch":before["value"]["epoch"]}),
    )?;
    ensure(
        account["ok"] == true && account["value"]["accepted"] == true,
        "mobile account CAS failed",
    )?;
    let epoch = driver.invoke("native_begin_unlock", json!({}))?["value"].clone();
    ensure(
        driver.invoke("native_complete_unlock", json!({"epoch":epoch}))?["value"]["unlocked"]
            == true,
        "mobile IPC unlock failed",
    )?;
    let inflight = driver.invoke("native_begin_unlock", json!({}))?["value"].clone();
    ensure(
        driver.invoke("native_background", json!({}))?["ok"] == true,
        "mobile IPC background failed",
    )?;
    ensure(
        driver.invoke("native_complete_unlock", json!({"epoch":inflight}))?["value"]["unlocked"]
            == false,
        "mobile accepted stale background proof",
    )?;
    let hidden = driver.invoke("native_begin_unlock", json!({}))?["value"].clone();
    ensure(
        driver.invoke("native_complete_unlock", json!({"epoch":hidden}))?["value"]["unlocked"]
            == false,
        "mobile accepted background unlock",
    )?;
    ensure(
        driver.invoke("native_foreground", json!({}))?["ok"] == true,
        "mobile IPC resume failed",
    )?;
    ensure(
        driver.invoke("native_complete_unlock", json!({"epoch":hidden}))?["value"]["unlocked"]
            == false,
        "mobile restored pre-resume proof",
    )?;
    let epoch = driver.invoke("native_begin_unlock", json!({}))?["value"].clone();
    ensure(
        driver.invoke("native_complete_unlock", json!({"epoch":epoch}))?["value"]["unlocked"]
            == true,
        "mobile fresh foreground unlock failed",
    )?;
    ensure(
        driver.invoke("native_activity", json!({}))?["value"] == true,
        "mobile foreground activity failed",
    )?;
    let idle_start = Instant::now();
    while idle_start.elapsed() < Duration::from_secs(301) {
        // This calls the real status IPC. Polling must not extend the deadline.
        let status = driver.invoke("native_session_status", json!({}))?;
        ensure(status["ok"] == true, "mobile idle status failed")?;
        if idle_start.elapsed() < Duration::from_secs(299) {
            ensure(
                status["value"]["unlocked"] == true,
                "mobile expired before production deadline",
            )?;
        }
        thread::sleep(Duration::from_secs(1));
    }
    ensure(
        driver.invoke("native_session_status", json!({}))?["value"]["unlocked"] == false,
        "mobile polling extended idle deadline",
    )?;
    ensure(
        driver.invoke("native_activity", json!({}))?["value"] == false,
        "mobile late input reopened session",
    )?;
    let stale = driver.invoke("native_begin_unlock", json!({}))?["value"].clone();
    ensure(
        driver.invoke("native_logout", json!({}))?["ok"] == true,
        "mobile IPC logout failed",
    )?;
    ensure(
        driver.invoke(
            "native_account",
            json!({"id":"synthetic-old-user","epoch":stale}),
        )?["value"]["accepted"]
            == false,
        "mobile stale account restored after logout",
    )?;
    let epoch = driver.invoke("native_begin_unlock", json!({}))?["value"].clone();
    ensure(
        driver.invoke("native_complete_unlock", json!({"epoch":epoch}))?["value"]["unlocked"]
            == false,
        "mobile accountless unlock succeeded",
    )?;
    std::fs::write(
        output.join("mobile-lock.json"),
        serde_json::to_vec_pretty(&json!({
            "nativeIpc":true,"backgroundAndResumeCommands":true,"staleAccountRejected":true,
        "measuredIdleSeconds":idle_start.elapsed().as_secs_f64(),"productionIdleSeconds":300,
        "nativeLogout":true,"accountlessUnlockRejected":true,"backgroundAccepted":false,"physicalMobile":false,
            "osBackgroundEvents":false,"pinOrBiometricUi":false,"syntheticOnly":true
        }))
        .map_err(|_| "mobile lock result encoding")?,
    )
    .map_err(|_| "mobile lock result write")?;
    println!("native mobile IPC and production idle acceptance succeeded");
    Ok(())
}

fn run(application: &Path, flavor: &str, blocked: bool, output: &Path) -> Result<(), String> {
    let temp = tempfile::TempDir::new().map_err(|_| "fixture directory")?;
    std::fs::create_dir_all(output).map_err(|_| "output directory")?;
    let fixture = Fixture::start()?;
    let mut driver = Driver::start(
        temp.path(),
        &output.join(format!(
            "{flavor}-{}-driver.log",
            if blocked { "protected" } else { "baseline" }
        )),
    )?;
    driver.open(application)?;
    let boot = driver.script("const done=arguments[arguments.length-1]; const end=Date.now()+3000; const probe=()=>{const cols=document.querySelectorAll('.matrix-rain__column');if(document.querySelector('input')&&cols.length===24){const css=getComputedStyle(cols[1]);const animation=matchMedia('(prefers-reduced-motion: reduce)').matches?'none':'matrix-fall';const el=document.createElement('div');el.setAttribute('style','color:rgb(1, 2, 3);position:fixed;left:7px;');document.body.append(el);const attr=getComputedStyle(el);const styleAttribute=attr.color==='rgb(1, 2, 3)'&&attr.left==='7px';el.remove();done({bridge:!!window.__TAURI_INTERNALS__,styleSheet:css.position==='absolute'&&css.animationName===animation,styleAttribute,inputs:document.querySelectorAll('input').length});}else if(Date.now()<end){setTimeout(probe,25)}else{done({failed:true})}};probe();", json!([]))?;
    ensure(
        boot["bridge"] == true
            && boot["styleSheet"] == true
            && boot["styleAttribute"] == true
            && boot["inputs"].as_u64().unwrap_or(0) > 0,
        "native UI or styles unavailable",
    )?;
    let probe_url = format!("http://127.0.0.1:{}/probe", fixture.port);
    let network = driver.script("const done=arguments[arguments.length-1];fetch(arguments[0]).then(r=>r.text()).then(text=>done({text}),()=>done({failed:true}));", json!([probe_url]))?;
    ensure(
        network["text"] == "probe-ok",
        "required loopback connection blocked",
    )?;
    let inline = driver.script("const done=arguments[arguments.length-1];window.__inline_probe=0;const s=document.createElement('script');s.textContent='window.__inline_probe=1;';document.head.append(s);setTimeout(()=>done(window.__inline_probe),200);", json!([]))?;
    ensure(
        inline == if blocked { 0 } else { 1 },
        "inline policy did not match expected behavior",
    )?;
    let external_url = format!("http://127.0.0.1:{}/script.js", fixture.port);
    let external = driver.script("const done=arguments[arguments.length-1];window.__external_probe=0;const s=document.createElement('script');s.src=arguments[0];s.onload=()=>done(window.__external_probe);s.onerror=()=>done(window.__external_probe);document.head.append(s);", json!([external_url]))?;
    ensure(
        external == if blocked { 0 } else { 1 },
        "external script policy did not match expected behavior",
    )?;
    ensure(
        fixture.script_requests.load(Ordering::Relaxed) == if blocked { 0 } else { 1 },
        "script request reached fixture unexpectedly",
    )?;
    let evaluated = driver.script(
        "const done=arguments[arguments.length-1];try{done(window.eval('1+2'))}catch{done(null)}",
        json!([]),
    )?;
    ensure(
        if blocked {
            evaluated.is_null()
        } else {
            evaluated == 3
        },
        "eval policy did not match expected behavior",
    )?;
    if flavor == "desktop" {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| "fixture entropy")?;
        let master = STANDARD.encode(bytes);
        let path = temp.path().join("native.pbox");
        let backup = temp.path().join("before.pbox");
        ensure(
            driver.invoke(
                "create_password_box",
                json!({"path":path,"masterPassword":master}),
            )?["ok"]
                == true,
            "native create failed",
        )?;
        let original = std::fs::read(&path).map_err(|_| "native file absent")?;
        std::fs::rename(&path, &backup).map_err(|_| "fixture backup")?;
        std::fs::create_dir(&path).map_err(|_| "fixture persist failure")?;
        let item = json!({"category":"LOGIN","title":"Native fixture","password":master,"masterPassword":master});
        ensure(
            driver.invoke("add_item", item.clone())?["ok"] == false,
            "native save failure was accepted",
        )?;
        ensure(
            driver.invoke("list_items", json!({}))?["value"] == json!([]),
            "failed native save changed memory",
        )?;
        ensure(
            std::fs::read(&backup).map_err(|_| "fixture bytes")? == original,
            "original ciphertext changed",
        )?;
        std::fs::remove_dir(&path).map_err(|_| "fixture restore")?;
        std::fs::rename(&backup, &path).map_err(|_| "fixture restore file")?;
        ensure(
            driver.invoke("add_item", item)?["ok"] == true,
            "native retry failed",
        )?;
        let saved = driver.invoke("list_items", json!({}))?["value"].clone();
        ensure(
            saved.as_array().is_some_and(|items| items.len() == 1)
                && saved[0]["title"] == "Native fixture"
                && saved[0]["category"] == "LOGIN"
                && saved[0]["password"] == master,
            "native retry duplicate",
        )?;
        ensure(
            driver.invoke("lock_password_box", json!({}))?["ok"] == true,
            "native lock failed",
        )?;
        ensure(
            driver.invoke("get_state", json!({}))?["value"] == "locked",
            "native state did not lock",
        )?;
        ensure(
            driver.invoke("list_items", json!({}))?["ok"] == false,
            "native locked read succeeded",
        )?;
        ensure(
            driver.invoke(
                "open_password_box",
                json!({"path":path,"masterPassword":master}),
            )?["ok"]
                == true,
            "native reopen failed",
        )?;
        ensure(
            driver.invoke("list_items", json!({}))?["value"] == saved,
            "native reopen content missing",
        )?;
        ensure(
            driver.invoke("lock_password_box", json!({}))?["ok"] == true,
            "native final lock failed",
        )?;
    }
    let screenshot = http(
        "GET",
        &driver.route("screenshot")?,
        &json!({}),
        driver.deadline,
    )?;
    let png = STANDARD
        .decode(screenshot.as_str().ok_or("screenshot response")?)
        .map_err(|_| "screenshot encoding")?;
    std::fs::write(
        output.join(format!(
            "{flavor}-{}.png",
            if blocked { "protected" } else { "baseline" }
        )),
        png,
    )
    .map_err(|_| "screenshot write")?;
    std::fs::write(output.join(format!("{flavor}-{}.json", if blocked { "protected" } else { "baseline" })), serde_json::to_vec_pretty(&json!({"flavor":flavor,"policyBlocked":blocked,"nativeUi":true,"styles":true,"loopback":true,"inline":inline,"external":external,"eval":evaluated,"externalRequests":fixture.script_requests.load(Ordering::Relaxed),"nativeSave":flavor=="desktop","syntheticOnly":true})).map_err(|_| "result encoding")?).map_err(|_| "result write")?;
    println!("native {flavor} acceptance succeeded, protected={blocked}");
    Ok(())
}

fn valid_mode(flavor: &str, mode: &str) -> bool {
    ["desktop", "mobile"].contains(&flavor)
        && [
            "blocked",
            "executed",
            "auto-lock",
            "mobile-lock",
            "local-recovery",
        ]
        .contains(&mode)
        && (!["auto-lock", "local-recovery"].contains(&mode) || flavor == "desktop")
        && (mode != "mobile-lock" || flavor == "mobile")
}

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 5 {
        eprintln!("usage: webview_acceptance APP desktop|mobile blocked|executed|auto-lock|mobile-lock|local-recovery OUTPUT");
        std::process::exit(2);
    }
    let flavor = args[2].to_str().unwrap_or("");
    let mode = args[3].to_str().unwrap_or("");
    if !valid_mode(flavor, mode) {
        std::process::exit(2);
    }
    let app = PathBuf::from(&args[1]);
    let output = PathBuf::from(&args[4]);
    let result = if mode == "local-recovery" {
        run_local_recovery(&app, &output)
    } else if mode == "mobile-lock" {
        run_mobile_lock(&app, &output)
    } else if mode == "auto-lock" {
        run_auto_lock(&app, &output)
    } else {
        run(&app, flavor, mode == "blocked", &output)
    };
    if let Err(error) = result {
        eprintln!("native acceptance failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_recovery_mode_is_desktop_only_and_retains_prior_modes() {
        assert!(valid_mode("desktop", "local-recovery"));
        assert!(!valid_mode("mobile", "local-recovery"));
        assert!(!valid_mode("desktop", "mobile-lock"));
        assert!(!valid_mode("mobile", "auto-lock"));
        assert!(valid_mode("desktop", "auto-lock"));
        assert!(valid_mode("mobile", "mobile-lock"));
        for flavor in ["desktop", "mobile"] {
            for mode in ["blocked", "executed"] {
                assert!(valid_mode(flavor, mode));
            }
        }
        assert!(!valid_mode("desktop", "unknown"));
    }

    #[test]
    fn unchanged_recovery_file_requires_existing_identical_bytes() {
        let temp = tempfile::TempDir::new().expect("synthetic directory");
        let path = temp.path().join("bytes.pbox");
        let bytes = b"synthetic ciphertext";
        std::fs::write(&path, bytes).expect("synthetic file");
        assert!(unchanged_file(&path, bytes).expect("existing file"));
        std::fs::write(&path, b"synthetic ciphertext changed").expect("mutated file");
        assert!(!unchanged_file(&path, bytes).expect("mutated existing file"));
        std::fs::remove_file(&path).expect("remove synthetic file");
        assert!(unchanged_file(&path, bytes).is_err());
    }

    #[test]
    fn recovery_rekey_preserves_full_content_and_reusable_code_on_existing_file() {
        use passshare_core::{Item, SavedChange};
        let temp = tempfile::TempDir::new().expect("synthetic directory");
        let path = temp.path().join("semantic-recovery.pbox");
        let old = random_secret().expect("old entropy");
        let new = random_secret().expect("new independent entropy");
        let secret = random_secret().expect("item entropy");
        assert!(old != new, "independent passwords");
        let mut pb = PasswordBox::create(&path, &old).expect("synthetic create");
        let code = Zeroizing::new(
            pb.recovery_secret()
                .expect("unlocked code")
                .expect("created recovery code")
                .to_owned(),
        );
        let mut login = Item::new_login(
            pb.vault().expect("unlocked box").id.clone(),
            "Lock fixture",
            secret.as_str(),
        )
        .expect("synthetic login")
        .with_optional_fields(
            Some("https://synthetic.invalid/recovery".into()),
            Some("synthetic-user".into()),
            Some("Synthetic notes".into()),
        )
        .expect("optional fields");
        login.set_tags(vec!["synthetic".into(), "recovery".into()]);
        login.set_favorite(true);
        pb.apply_and_save(SavedChange::Add(&login), &old)
            .expect("persist login");
        let note = Item::new_secure_note(
            pb.vault().expect("unlocked box").id.clone(),
            "Synthetic note",
            secret.as_str(),
        )
        .expect("synthetic note");
        pb.apply_and_save(SavedChange::Add(&note), &old)
            .expect("persist body");
        let dto = SecretJson(
            serde_json::to_value(pb.list_connect_items().expect("fixture DTO"))
                .expect("fixture DTO encoding"),
        );
        assert!(
            dto.0.as_array().is_some_and(|items| items.len() == 2),
            "nonempty full DTO precondition"
        );
        let payload = full_payload(&path, &old).expect("fixture full payload");
        let original = std::fs::read(&path).expect("fixture exists before recovery");
        pb.lock();
        assert!(
            PasswordBox::recover(&path, &random_secret().expect("wrong entropy")).is_err(),
            "wrong code rejected"
        );
        assert!(unchanged_file(&path, &original).expect("wrong-code file exists"));
        let mut recovered = PasswordBox::recover(&path, &code).expect("valid read-only recovery");
        assert!(unchanged_file(&path, &original).expect("read-only file exists"));
        recovered.rekey_recovered(&new).expect("synthetic rekey");
        let reopened =
            PasswordBox::open(&path, &new).expect("new password authenticates existing file");
        let after = SecretJson(
            serde_json::to_value(reopened.list_connect_items().expect("reopened full DTO"))
                .expect("reopened DTO encoding"),
        );
        assert!(after.0 == dto.0, "all item fields preserved");
        assert!(
            full_payload(&path, &new).expect("new payload").0 == payload.0,
            "all payload fields preserved"
        );
        assert!(!unchanged_file(&path, &original).expect("rekey file exists"));
        assert!(
            matches!(
                PasswordBox::open(&path, &old),
                Err(passshare_core::PassShareError::InvalidMasterPassword)
            ),
            "old password fails authentication, not file lookup"
        );
        let rekeyed = std::fs::read(&path).expect("rekey fixture exists");
        let reusable = PasswordBox::recover(&path, &code).expect("same code still authenticates");
        let reusable_dto = SecretJson(
            serde_json::to_value(reusable.list_connect_items().expect("code reuse DTO"))
                .expect("code reuse DTO encoding"),
        );
        assert!(reusable_dto.0 == dto.0, "code reuse preserves full DTO");
        assert!(unchanged_file(&path, &rekeyed).expect("code reuse file exists"));
        // Equal counts are insufficient: the oracle must detect lost fields.
        let mut lost_field = SecretJson(dto.0.clone());
        lost_field.0[0]["fields"][0]["value"] = json!("changed synthetic username");
        assert!(
            lost_field.0 != dto.0,
            "full DTO detects changed content at equal counts"
        );
    }

    #[test]
    fn native_proxy_status_must_be_ready_after_early_eof_and_not_ready() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            for attempt in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut header = Vec::new();
                let mut byte = [0u8; 1];
                while !header.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    header.push(byte[0]);
                }
                assert!(
                    header.starts_with(b"GET /status HTTP/1.1\r\n"),
                    "startup never creates a session"
                );
                assert!(header
                    .windows(b"Content-Length: 0\r\n".len())
                    .any(|part| part == b"Content-Length: 0\r\n"));
                if attempt == 0 {
                    continue;
                } // Proxy bound, native driver unavailable.
                let body = if attempt == 1 {
                    r#"{"value":{"ready":false,"message":"starting"}}"#
                } else {
                    r#"{"value":{"ready":true,"message":"ready"}}"#
                };
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        wait_ready(Instant::now() + Duration::from_secs(3), |deadline| {
            Ok(http_at(address, "GET", "/status", &json!({}), deadline)?["ready"] == true)
        })
        .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn native_bridge_generations_reject_late_results_without_polling() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let result = std::process::Command::new("node")
            .current_dir(root)
            .args(["--experimental-strip-types", "--input-type=module", "-e", "import {bindNativeLock} from './shared/lib/native-lock.ts';let cleared=0;const binding=bindNativeLock(null,()=>{cleared+=1});const counts=[];binding.accept({epoch:0,unlocked:false});counts.push(cleared);binding.accept({epoch:1,unlocked:true});binding.accept({epoch:2,unlocked:false});counts.push(cleared);binding.accept({epoch:3,unlocked:true});binding.accept({epoch:2,unlocked:false});counts.push(cleared);binding.accept({epoch:4,unlocked:false});binding.accept({epoch:4,unlocked:false});counts.push(cleared);binding.accept({epoch:5,unlocked:true});binding.accept({epoch:6,unlocked:false});counts.push(cleared);binding.dispose();binding.accept({epoch:7,unlocked:false});counts.push(cleared);process.stdout.write(JSON.stringify(counts));"])
            .output().expect("Node bridge process");
        assert!(
            result.status.success(),
            "native bridge process must succeed"
        );
        let counts: Vec<usize> = serde_json::from_slice(&result.stdout).expect("bridge counts");
        assert_eq!(counts, vec![0, 1, 1, 2, 3, 3]);
        let result = std::process::Command::new("node")
            .current_dir(root)
            .args(["--experimental-strip-types", "--input-type=module", "-e", "import {bindNativeLock} from './shared/lib/native-lock.ts';let cleared=0;const binding=bindNativeLock(null,()=>{cleared+=1});binding.accept({epoch:3,unlocked:true});binding.accept({epoch:2,unlocked:false});const stale=cleared;binding.accept({epoch:4,unlocked:false});process.stdout.write(JSON.stringify([stale,cleared]));"])
            .output().expect("late native result process");
        assert!(
            result.status.success(),
            "late native result process must succeed"
        );
        let counts: Vec<usize> =
            serde_json::from_slice(&result.stdout).expect("late native result counts");
        assert_eq!(counts, vec![0, 1]);
    }

    #[test]
    fn fragmented_script_headers_are_counted_once() {
        let fixture = Fixture::start().unwrap();
        let mut socket = TcpStream::connect(("127.0.0.1", fixture.port)).unwrap();
        socket.write_all(b"GET /scr").unwrap();
        socket
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let mut byte = [0];
        assert!(
            matches!(socket.read(&mut byte), Err(error) if matches!(error.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock))
        );
        for part in [
            &b"ipt.js HTTP/1.1\r"[..],
            b"\nHost: fixture\r",
            b"\n\r",
            b"\n",
        ] {
            socket.write_all(part).unwrap();
            thread::sleep(Duration::from_millis(5));
        }
        let reply = read_response(&mut socket, Instant::now() + Duration::from_secs(2)).unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 200 OK\r\n"));
        assert!(reply
            .windows(b"Content-Type: application/javascript".len())
            .any(|bytes| bytes == b"Content-Type: application/javascript"));
        assert!(reply.ends_with(b"window.__external_probe=1;"));
        assert_eq!(fixture.script_requests.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn unknown_route_is_not_a_successful_probe() {
        let fixture = Fixture::start().unwrap();
        let mut socket = TcpStream::connect(("127.0.0.1", fixture.port)).unwrap();
        socket
            .write_all(b"GET /unknown HTTP/1.1\r\nHost: fixture\r\n\r\n")
            .unwrap();
        let reply = read_response(&mut socket, Instant::now() + Duration::from_secs(2)).unwrap();
        assert!(reply.starts_with(b"HTTP/1.1 404 Not Found\r\n"));
        assert_eq!(fixture.script_requests.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn response_deadline_is_absolute_even_when_bytes_arrive() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            for _ in 0..50 {
                if socket.write_all(b"x").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        });
        let mut socket = TcpStream::connect(address).unwrap();
        let start = Instant::now();
        assert!(read_response(&mut socket, start + Duration::from_millis(75)).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(socket);
        thread.join().unwrap();
    }

    #[test]
    fn complete_content_length_does_not_wait_for_connection_close() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}",
                )
                .unwrap();
            thread::sleep(Duration::from_millis(250));
        });
        let mut socket = TcpStream::connect(address).unwrap();
        let reply =
            read_response(&mut socket, Instant::now() + Duration::from_millis(150)).unwrap();
        assert!(reply.ends_with(b"\r\n\r\n{}"));
        drop(socket);
        thread.join().unwrap();
    }

    #[test]
    fn chunked_response_waits_for_complete_terminal_chunk() {
        assert_eq!(
            decode_chunks(b"2\r\n{}\r\n0\r\n\r\n").unwrap(),
            Some(b"{}".to_vec())
        );
        for prefix in [b"2\r".as_slice(), b"2\r\n{", b"2\r\n{}\r\n0\r\n"] {
            assert_eq!(decode_chunks(prefix).unwrap(), None);
        }
        assert!(decode_chunks(b"garbage\r\n").is_err());
    }

    #[test]
    fn premature_eof_rejects_valid_json_in_an_incomplete_frame() {
        for reply in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"value\":null}".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\ne\r\n{\"value\":null}\r\n",
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let data = reply.to_vec();
            let thread = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket.write_all(&data).unwrap();
            });
            let mut socket = TcpStream::connect(address).unwrap();
            assert!(read_response(&mut socket, Instant::now() + Duration::from_secs(2)).is_err());
            thread.join().unwrap();
        }
    }

    #[test]
    fn expired_write_deadline_does_not_send_any_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        assert!(write_request(
            &mut client,
            b"must-not-send",
            Instant::now() - Duration::from_millis(1)
        )
        .is_err());
        drop(client);
        let mut bytes = Vec::new();
        server.read_to_end(&mut bytes).unwrap();
        assert!(bytes.is_empty());
    }
}
