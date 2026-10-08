//! Browser acceptance for the actual Worker. Serves the `--target web` bindings plus the
//! fixed script on 127.0.0.1, waits for a real browser to post the raw replies, and verifies
//! them here. Open the printed URL in Chrome. Not part of the product; Node is not a browser proof.
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, Instant};

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

/// Returns the posted result body once `/result` is received.
fn serve(
    mut stream: TcpStream,
    pkg: &Path,
    fixture: &str,
    run: &str,
) -> Option<(String, TcpStream)> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 || buf.len() > 65_536 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut first = head.lines().next()?.split(' ');
    let (method, path) = (first.next()?, first.next()?);
    let length = head
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            if !key.eq_ignore_ascii_case("content-length") {
                return None;
            }
            value.trim().parse::<usize>().ok()
        })
        .unwrap_or(0);
    if length > 1 << 20 {
        return None;
    }
    while buf.len() < head_end + length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    const JS: &str = "text/javascript";
    let result_path = format!("/result/{run}");
    // Fixed route table: no client-controlled path ever reaches the filesystem.
    match (method, path) {
        ("POST", path) if path == result_path => {
            return Some((
                String::from_utf8_lossy(&buf[head_end..head_end + length]).into_owned(),
                stream,
            ));
        }
        ("GET", path) if path == format!("/?run={run}") => respond(
            &mut stream,
            "200 OK",
            "text/html",
            include_bytes!("../worker/acceptance.html"),
        ),
        ("GET", "/acceptance.mjs") => respond(
            &mut stream,
            "200 OK",
            JS,
            include_bytes!("../worker/acceptance.mjs"),
        ),
        ("GET", "/boot.mjs") => respond(
            &mut stream,
            "200 OK",
            JS,
            include_bytes!("../worker/boot.mjs"),
        ),
        ("GET", "/fixture.json") => respond(
            &mut stream,
            "200 OK",
            "application/json",
            fixture.as_bytes(),
        ),
        ("GET", "/passshare_cloud_wasm.js") => {
            match std::fs::read(pkg.join("passshare_cloud_wasm.js")) {
                Ok(body) => respond(&mut stream, "200 OK", JS, &body),
                Err(_) => respond(&mut stream, "404 Not Found", "text/plain", b""),
            }
        }
        ("GET", "/passshare_cloud_wasm_bg.wasm") => {
            match std::fs::read(pkg.join("passshare_cloud_wasm_bg.wasm")) {
                Ok(body) => respond(&mut stream, "200 OK", "application/wasm", &body),
                Err(_) => respond(&mut stream, "404 Not Found", "text/plain", b""),
            }
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", b""),
    }
    None
}

fn verify(result: &Value, fixture: &Value) {
    assert!(
        result["mainThread"].as_str().unwrap().contains("PS060"),
        "main thread import must not start a worker"
    );
    let r = result["replies"].as_array().unwrap();
    assert_eq!(r.len(), 13, "reply count");
    let text = result["replies"].to_string();
    assert!(
        !text.contains(fixture["password"].as_str().unwrap()),
        "password reflected"
    );
    // (ok, generation, locked) per step of worker/acceptance.mjs.
    let expected = [
        (true, 0, true),  // ready
        (true, 0, true),  // status
        (true, 1, false), // unlock fixed format 1
        (true, 1, false), // decrypt
        (true, 2, true),  // lock
        (false, 2, true), // decrypt with the pre-lock generation
        (true, 3, false), // generate
        (true, 3, false), // encrypt
        (true, 3, false), // wrap
        (true, 4, true),  // lock
        (true, 5, false), // unlock the wrapped bundle
        (true, 5, false), // decrypt
        (true, 6, true),  // lock
    ];
    for (i, (ok, generation, locked)) in expected.into_iter().enumerate() {
        if i > 0 {
            assert_eq!(r[i]["requestId"].as_u64(), Some(i as u64), "request id {i}");
        }
        assert_eq!(
            (
                r[i]["ok"].as_bool(),
                r[i]["generation"].as_u64(),
                r[i]["locked"].as_bool()
            ),
            (Some(ok), Some(generation), Some(locked)),
            "reply {i}"
        );
    }
    assert!(r[0]["requestId"].is_null());
    assert!(r[5]["error"].as_str().unwrap().starts_with("PS058"));
    assert!(r[5].get("item").is_none());
    for i in [3, 11] {
        let item: Value = serde_json::from_str(r[i]["item"].as_str().unwrap()).unwrap();
        assert_eq!(item, fixture["item"], "reply {i}");
    }
    assert!(r[7]["envelope"].is_string() && r[8]["bundle"].is_string());
    let negative = result["negative"].as_array().unwrap();
    assert_eq!(negative.len(), 6);
    for (i, (id, ok, generation, locked)) in [
        (Some(13), true, 7, false),
        (Some(4), true, 8, true),
        (Some(4), true, 9, true),
        (Some(13), false, 9, true),
        (None, false, 9, true),
        (None, false, 9, true),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(negative[i]["requestId"].as_u64(), id, "negative id {i}");
        assert_eq!(negative[i]["ok"].as_bool(), Some(ok));
        assert_eq!(negative[i]["generation"].as_u64(), Some(generation));
        assert_eq!(negative[i]["locked"].as_bool(), Some(locked));
        assert!(negative[i].get("item").is_none());
        if !ok {
            assert!(negative[i]["error"].as_str().unwrap().starts_with("PS051"));
        }
    }
}

fn main() {
    let pkg = std::env::args_os()
        .nth(1)
        .expect("wasm-bindgen --target web output directory");
    let pkg = Path::new(&pkg);
    let mut fixture: Value =
        serde_json::from_str(include_str!("../tests/format1-vector.json")).unwrap();
    fixture["password"] = Value::String("Synthetic format1 e\u{301} password!".into());
    let body = fixture.to_string();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let run = passshare_core::domain::connect_id::ConnectId::generate()
        .unwrap()
        .to_string();
    println!(
        "open in Chrome: http://127.0.0.1:{}/?run={run}",
        listener.local_addr().unwrap().port()
    );
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        assert!(
            Instant::now() < deadline,
            "no browser result before the timeout"
        );
        let Ok((stream, _)) = listener.accept() else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        if let Some((posted, mut stream)) = serve(stream, pkg, &body, &run) {
            if let Some(evidence) = std::env::args_os().nth(2) {
                std::fs::write(evidence, &posted).expect("write synthetic browser evidence");
            }
            verify(&serde_json::from_str(&posted).unwrap(), &fixture);
            respond(&mut stream, "200 OK", "text/plain", b"verified");
            println!("actual browser Worker: dispatcher, generation and lock rejection passed");
            return;
        }
    }
}
