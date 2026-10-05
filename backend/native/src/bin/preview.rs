//! Loopback-only acceptance proxy. A one-shot 502 discards a committed create
//! response without logging its body, cookies or authorization headers.
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Default)]
struct State {
    fail: AtomicBool,
    creates: AtomicU64,
    dropped: AtomicU64,
}

fn response(client: &mut TcpStream, status: &str, mime: &str, body: &[u8]) {
    let _=write!(client,"HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
    let _ = client.write_all(body);
}

fn handle(
    mut client: TcpStream,
    root: PathBuf,
    backend: u16,
    state: Arc<State>,
) -> std::io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut request = Vec::new();
    let mut byte = [0];
    while !request.ends_with(b"\r\n\r\n") {
        client.read_exact(&mut byte)?;
        request.push(byte[0]);
        if request.len() > 32 * 1024 {
            return Ok(());
        }
    }
    let header = String::from_utf8_lossy(&request).into_owned();
    let mut first = header.lines().next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("");
    let path = first.next().unwrap_or("/");
    let length = header
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if length > 2 * 1024 * 1024 {
        return Ok(());
    }
    let mut body = vec![0; length];
    client.read_exact(&mut body)?;
    if path == "/__test/fail-response" && method == "POST" {
        state.fail.store(true, Ordering::SeqCst);
        response(&mut client, "204 No Content", "text/plain", &[]);
        return Ok(());
    }
    if path == "/__test/state" {
        let output = format!(
            "{{\"creates\":{},\"dropped\":{},\"armed\":{}}}",
            state.creates.load(Ordering::SeqCst),
            state.dropped.load(Ordering::SeqCst),
            state.fail.load(Ordering::SeqCst)
        );
        response(&mut client, "200 OK", "application/json", output.as_bytes());
        return Ok(());
    }
    if path.starts_with("/v1/") || path.starts_with("/api/") || path.starts_with("/health") {
        let create =
            method == "POST" && path.starts_with("/v1/vaults/") && path.ends_with("/items");
        if create {
            state.creates.fetch_add(1, Ordering::SeqCst);
        }
        let mut upstream = TcpStream::connect(("127.0.0.1", backend))?;
        upstream.set_read_timeout(Some(Duration::from_secs(15)))?;
        // Replace only Connection, retaining the exact body and auth/CSRF headers.
        for line in header.lines().filter(|line| !line.is_empty()) {
            if line
                .split_once(':')
                .is_some_and(|(key, _)| key.eq_ignore_ascii_case("connection"))
            {
                continue;
            }
            write!(upstream, "{line}\r\n")?;
        }
        upstream.write_all(b"Connection: close\r\n\r\n")?;
        upstream.write_all(&body)?;
        let mut received = Vec::new();
        upstream.take(4 * 1024 * 1024).read_to_end(&mut received)?;
        let success = received.starts_with(b"HTTP/1.1 201 ");
        if create && success && state.fail.swap(false, Ordering::SeqCst) {
            state.dropped.fetch_add(1, Ordering::SeqCst);
            response(
                &mut client,
                "502 Bad Gateway",
                "text/plain",
                b"Synthetic committed response discarded",
            );
        } else {
            client.write_all(&received)?;
        }
        return Ok(());
    }
    let clean = path
        .split('?')
        .next()
        .unwrap_or("/")
        .trim_start_matches('/');
    if PathBuf::from(clean)
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        response(&mut client, "400 Bad Request", "text/plain", &[]);
        return Ok(());
    }
    let file = root.join(clean);
    let file = if file.is_file() {
        file
    } else {
        root.join("index.html")
    };
    let mime = match file.extension().and_then(|value| value.to_str()) {
        Some("js") => "application/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => "text/html; charset=utf-8",
    };
    response(&mut client, "200 OK", mime, &std::fs::read(file)?);
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(
        args.len() == 4,
        "preview <dist path> <backend port> <preview port>"
    );
    let root = PathBuf::from(&args[1])
        .canonicalize()
        .expect("owned dist directory");
    let backend = args[2].parse::<u16>().expect("backend port");
    let port = args[3].parse::<u16>().expect("preview port");
    let state = Arc::new(State::default());
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("exclusive loopback port");
    for client in listener.incoming().flatten() {
        let root = root.clone();
        let state = state.clone();
        std::thread::spawn(move || {
            let _ = handle(client, root, backend, state);
        });
    }
}
