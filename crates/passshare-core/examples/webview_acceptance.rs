//! Finite native WebView acceptance in an isolated Linux CI display.
//! No production accounts, browser profiles or credentials are used.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Child;
#[cfg(unix)]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const LIMIT: usize = 4 * 1024 * 1024;

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
    let mut socket = TcpStream::connect_timeout(
        &"127.0.0.1:4444".parse().unwrap(),
        remaining(deadline, Duration::from_secs(5))?,
    )
    .map_err(|_| "driver connection failed")?;
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| "read deadline")?;
    socket
        .set_write_timeout(Some(remaining(deadline, Duration::from_secs(5))?))
        .map_err(|_| "write deadline")?;
    let payload = serde_json::to_vec(body).map_err(|_| "request encoding")?;
    let headers = format!("{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:4444\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len());
    socket
        .write_all(headers.as_bytes())
        .map_err(|_| "header write")?;
    socket.write_all(&payload).map_err(|_| "body write")?;
    let bytes = read_response(&mut socket, deadline)?;
    let split = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .ok_or("response headers")?;
    let headers = std::str::from_utf8(&bytes[..split]).map_err(|_| "header encoding")?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or("response status")?;
    if status != "200" {
        return Err(format!("driver status {status}"));
    }
    let result: Value = serde_json::from_slice(&bytes[split + 4..]).map_err(|_| "response JSON")?;
    if result
        .get("value")
        .and_then(|value| value.get("error"))
        .is_some()
    {
        return Err("driver command rejected".into());
    }
    result
        .get("value")
        .cloned()
        .ok_or_else(|| "missing driver value".into())
}

struct Driver {
    child: Child,
    session: Option<String>,
    deadline: Instant,
}
impl Driver {
    #[cfg(unix)]
    fn start(profile: &Path) -> Result<Self, String> {
        use std::os::unix::process::CommandExt;
        let mut command = Command::new("tauri-driver");
        command
            .env_clear()
            .process_group(0)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for name in ["PATH", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .env("LANG", "C.UTF-8")
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
        while Instant::now() < deadline {
            if driver
                .child
                .try_wait()
                .map_err(|_| "driver status")?
                .is_some()
            {
                return Err("driver exited".into());
            }
            if TcpStream::connect("127.0.0.1:4444").is_ok() {
                return Ok(driver);
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err("driver startup deadline".into())
    }

    #[cfg(not(unix))]
    fn start(_: &Path) -> Result<Self, String> {
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
        http(
            "POST",
            &self.route("execute/async")?,
            &json!({"script":source,"args":args}),
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
    socket
        .write_all(headers.as_bytes())
        .map_err(|_| "fixture response")?;
    socket
        .write_all(body.as_bytes())
        .map_err(|_| "fixture body")?;
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
                    let _ = serve_fixture(&mut socket, &requests);
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

fn run(application: &Path, flavor: &str, blocked: bool, output: &Path) -> Result<(), String> {
    let temp = tempfile::TempDir::new().map_err(|_| "fixture directory")?;
    std::fs::create_dir_all(output).map_err(|_| "output directory")?;
    let fixture = Fixture::start()?;
    let mut driver = Driver::start(temp.path())?;
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

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 5 {
        eprintln!("usage: webview_acceptance APP desktop|mobile blocked|executed OUTPUT");
        std::process::exit(2);
    }
    let flavor = args[2].to_str().unwrap_or("");
    let mode = args[3].to_str().unwrap_or("");
    if !["desktop", "mobile"].contains(&flavor) || !["blocked", "executed"].contains(&mode) {
        std::process::exit(2);
    }
    let app = PathBuf::from(&args[1]);
    let output = PathBuf::from(&args[4]);
    if let Err(error) = run(&app, flavor, mode == "blocked", &output) {
        eprintln!("native acceptance failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
