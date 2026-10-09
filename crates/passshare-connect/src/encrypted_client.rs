//! Session-authenticated client for the encrypted storage and owner key bundle
//! APIs (`/api/encrypted`). Contracts: `documents/spec/encrypted-storage-api.md`
//! and `documents/spec/owner-key-bundle-api.md`.
//!
//! The client only moves opaque ciphertext. It holds no key, never decrypts and
//! never accepts an encryption password. Callers must verify every response with
//! Core (`decrypt_item` / `unwrap_for_owner`) against a context they trust; the
//! server's answer is never used as the source of the expected context.
use base64::{engine::general_purpose::STANDARD, Engine};
use std::fmt;
use std::time::Duration;

use passshare_core::cloud_crypto::{EncryptedItem, OwnerKeyContext, WrappedPasswordBoxKey};
use passshare_core::ConnectId;
use reqwest::header::{
    HeaderValue, ACCEPT, AUTHORIZATION, CONNECTION, CONTENT_LENGTH, TRANSFER_ENCODING,
};
use reqwest::redirect::Policy;
use reqwest::{Client, Method, Response, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

const MAX_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CIPHERTEXT_BYTES: usize = 1024 * 1024 + 16;
/// Largest legitimate body: a maximal envelope as base64 plus JSON framing.
const MAX_RESPONSE_BYTES: usize = 4 * MAX_CIPHERTEXT_BYTES.div_ceil(3) + 4096;
const MAX_ERROR_BYTES: usize = 16 * 1024;
const MAX_LIST_ITEMS: usize = 100;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EncryptedSessionError {
    #[error("invalid base URL: {0}")]
    InvalidBaseUrl(&'static str),
    #[error("invalid session token")]
    InvalidToken,
    #[error("invalid argument: {0}")]
    InvalidArgument(&'static str),
    /// Only the HTTP status and the `PSxxx` code are kept; never the body.
    #[error("encrypted API error (HTTP {status}, code {})", .code.as_deref().unwrap_or("none"))]
    Api { status: u16, code: Option<String> },
    #[error("transport error: {0}")]
    Transport(&'static str),
    #[error("response exceeds the allowed size")]
    ResponseTooLarge,
    #[error("invalid response: {0}")]
    InvalidResponse(&'static str),
    /// The server returned a bundle whose context differs from the expected one.
    #[error("response context differs from the expected context")]
    ContextMismatch,
}

impl EncryptedSessionError {
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Api { status, .. } => Some(*status),
            _ => None,
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Api { code, .. } => code.as_deref(),
            _ => None,
        }
    }
}

pub type EncryptedSessionResult<T> = Result<T, EncryptedSessionError>;
use EncryptedSessionError as Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoxState {
    Compatibility,
    Encrypted { key_epoch: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemSummary {
    pub item_id: ConnectId,
    pub item_version: u64,
    pub key_epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemPage {
    pub items: Vec<ItemSummary>,
    pub next_cursor: Option<ConnectId>,
}

/// Public owner key bundle: a KDF salt and the wrapped box key. Built by the
/// client from Core output; this crate never sees the key or the password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerKeyBundle {
    pub format: u32,
    /// Canonical standard Base64 of a 16-byte salt.
    pub salt: String,
    pub wrapped: WrappedPasswordBoxKey,
}

impl OwnerKeyBundle {
    pub fn new(salt: String, wrapped: WrappedPasswordBoxKey) -> EncryptedSessionResult<Self> {
        let bundle = Self {
            format: 1,
            salt,
            wrapped,
        };
        bundle.validate()?;
        Ok(bundle)
    }

    /// Structural check mirroring the server's public-header validation.
    pub fn validate(&self) -> EncryptedSessionResult<()> {
        self.problem()
            .map_or(Ok(()), |m| Err(Error::InvalidArgument(m)))
    }

    fn problem(&self) -> Option<&'static str> {
        let w = &self.wrapped;
        let c = &w.context;
        if self.format != 1 || w.format != 1 {
            Some("unsupported bundle format")
        } else if b64_len(&self.salt) != Some(16) {
            Some("salt must be canonical Base64 of 16 bytes")
        } else if ConnectId::validate(c.password_box_id.as_str()).is_err() {
            Some("invalid password box id in bundle")
        } else if c.owner_account_id.is_nil() {
            Some("nil owner account id")
        } else if !(1..=MAX_INTEGER).contains(&c.key_epoch) {
            Some("key epoch out of range")
        } else if b64_len(&w.nonce) != Some(24) {
            Some("nonce must be canonical Base64 of 24 bytes")
        } else if b64_len(&w.ciphertext) != Some(48) {
            Some("wrapped key must be canonical Base64 of 48 bytes")
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerKeyRecord {
    pub bundle_version: u64,
    pub bundle: OwnerKeyBundle,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawState {
    mode: String,
    key_epoch: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawEnable {
    mode: String,
    key_epoch: u64,
}

#[derive(Clone)]
pub struct EncryptedSessionClient {
    base: Url,
    auth: HeaderValue,
    http: Client,
}

// Manual Debug so the session token never reaches logs or panic output.
impl fmt::Debug for EncryptedSessionClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EncryptedSessionClient")
            .field("base", &self.base.as_str())
            .field("session_token", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl EncryptedSessionClient {
    /// `session_token` is the session bearer (not a Connect token), supplied by
    /// the caller. `base_url` is the origin (optionally with a path prefix);
    /// `/api/encrypted` is appended.
    pub fn new(base_url: &str, session_token: &str) -> EncryptedSessionResult<Self> {
        let base = parse_base_url(base_url)?;
        if session_token.is_empty() || session_token.bytes().any(|b| b.is_ascii_whitespace()) {
            return Err(Error::InvalidToken);
        }
        let mut auth = HeaderValue::from_str(&format!("Bearer {session_token}"))
            .map_err(|_| Error::InvalidToken)?;
        auth.set_sensitive(true);
        let http = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| Error::Transport("failed to build HTTP client"))?;
        Ok(Self { base, auth, http })
    }

    pub async fn state(&self, box_id: &str) -> EncryptedSessionResult<BoxState> {
        check_id(box_id)?;
        let bytes = self
            .send(Method::GET, self.endpoint(&["boxes", box_id])?, None)
            .await?;
        let raw: RawState = decode(&bytes)?;
        if !decode::<Value>(&bytes)?
            .as_object()
            .is_some_and(|object| object.contains_key("keyEpoch"))
        {
            return Err(Error::InvalidResponse("missing key epoch"));
        }
        match (raw.mode.as_str(), raw.key_epoch) {
            ("compatibility", None) => Ok(BoxState::Compatibility),
            ("encrypted", Some(key_epoch)) if (1..=MAX_INTEGER).contains(&key_epoch) => {
                Ok(BoxState::Encrypted { key_epoch })
            }
            _ => Err(Error::InvalidResponse("unexpected box state")),
        }
    }

    /// Switches an empty compatibility box to encrypted. Returns the key epoch (1).
    pub async fn enable_empty_box(&self, box_id: &str) -> EncryptedSessionResult<u64> {
        check_id(box_id)?;
        let url = self.endpoint(&["boxes", box_id, "enable"])?;
        let bytes = self
            .send(Method::POST, url, Some(&json!({"keyEpoch": 1})))
            .await?;
        let raw: RawEnable = decode(&bytes)?;
        if raw.mode != "encrypted" || raw.key_epoch != 1 {
            return Err(Error::InvalidResponse("unexpected key epoch"));
        }
        Ok(raw.key_epoch)
    }

    pub async fn list(
        &self,
        box_id: &str,
        after: Option<&str>,
    ) -> EncryptedSessionResult<ItemPage> {
        check_id(box_id)?;
        let mut url = self.endpoint(&["boxes", box_id, "items"])?;
        if let Some(after) = after {
            check_id(after)?;
            url.query_pairs_mut().append_pair("after", after);
        }
        let page: ItemPage = decode(&self.send(Method::GET, url, None).await?)?;
        let mut previous = after;
        if page.items.len() > MAX_LIST_ITEMS {
            return Err(Error::InvalidResponse("too many list entries"));
        }
        for item in &page.items {
            let id = item.item_id.as_str();
            if check_id(id).is_err()
                || previous.is_some_and(|p| id <= p)
                || !(1..=MAX_INTEGER).contains(&item.item_version)
                || !(1..=MAX_INTEGER).contains(&item.key_epoch)
            {
                return Err(Error::InvalidResponse("invalid or unordered list entry"));
            }
            previous = Some(id);
        }
        if let Some(cursor) = &page.next_cursor {
            if page.items.len() != MAX_LIST_ITEMS || previous != Some(cursor.as_str()) {
                return Err(Error::InvalidResponse("invalid next cursor"));
            }
        } else if page.items.len() == MAX_LIST_ITEMS {
            return Err(Error::InvalidResponse("invalid next cursor"));
        }
        Ok(page)
    }

    /// Returns the stored envelope untouched. The caller must run Core
    /// `decrypt_item` with the context it expects (version and epoch included).
    pub async fn get_item(
        &self,
        box_id: &str,
        item_id: &str,
    ) -> EncryptedSessionResult<EncryptedItem> {
        check_id(box_id)?;
        check_id(item_id)?;
        let url = self.endpoint(&["boxes", box_id, "items", item_id])?;
        let item: EncryptedItem = decode(&self.send(Method::GET, url, None).await?)?;
        if let Some(problem) = envelope_problem(&item, box_id, item_id) {
            return Err(Error::InvalidResponse(problem));
        }
        Ok(item)
    }

    /// Compare-and-set write. A stale `expected_version` surfaces as
    /// `Api { status: 409, code: PS015 }`; there is no retry or fallback.
    pub async fn put_item(
        &self,
        box_id: &str,
        item_id: &str,
        expected_version: u64,
        envelope: &EncryptedItem,
    ) -> EncryptedSessionResult<EncryptedItem> {
        check_id(box_id)?;
        check_id(item_id)?;
        if expected_version >= MAX_INTEGER {
            return Err(Error::InvalidArgument("expected version out of range"));
        }
        if let Some(m) = envelope_problem(envelope, box_id, item_id) {
            return Err(Error::InvalidArgument(m));
        }
        if envelope.context.item_version != expected_version + 1 {
            return Err(Error::InvalidArgument(
                "item version must be expected version + 1",
            ));
        }
        let url = self.endpoint(&["boxes", box_id, "items", item_id])?;
        let body = json!({"expectedVersion": expected_version, "envelope": envelope});
        let stored: EncryptedItem = decode(&self.send(Method::PUT, url, Some(&body)).await?)?;
        if &stored != envelope {
            return Err(Error::InvalidResponse(
                "stored item differs from the request",
            ));
        }
        Ok(stored)
    }

    /// Compare-and-set deletion. Only HTTP 204 with an empty response succeeds.
    /// There is no automatic retry; an explicit replay needs the same metadata.
    pub async fn delete_item(
        &self,
        box_id: &str,
        item_id: &str,
        expected_version: u64,
        key_epoch: u64,
    ) -> EncryptedSessionResult<()> {
        check_id(box_id)?;
        check_id(item_id)?;
        if !(1..=MAX_INTEGER).contains(&expected_version) {
            return Err(Error::InvalidArgument("expected version out of range"));
        }
        if !(1..=MAX_INTEGER).contains(&key_epoch) {
            return Err(Error::InvalidArgument("key epoch out of range"));
        }
        let url = self.endpoint(&["boxes", box_id, "items", item_id])?;
        let body = json!({"expectedVersion":expected_version,"keyEpoch":key_epoch});
        self.send_expected(Method::DELETE, url, Some(&body), 204)
            .await?;
        Ok(())
    }

    /// `expected` is the caller's trusted context; the response must match it.
    pub async fn get_owner_key(
        &self,
        box_id: &str,
        expected: &OwnerKeyContext,
    ) -> EncryptedSessionResult<OwnerKeyRecord> {
        check_id(box_id)?;
        check_expected_context(box_id, expected)?;
        let url = self.endpoint(&["boxes", box_id, "owner-key"])?;
        let record = decode_record(&self.send(Method::GET, url, None).await?)?;
        if record.bundle.wrapped.context != *expected {
            return Err(Error::ContextMismatch);
        }
        Ok(record)
    }

    /// `expected_version` 0 creates the bundle and must not carry a password; any
    /// later version replaces it and requires `current_login_password` (the
    /// account's login password, never the encryption password).
    pub async fn put_owner_key(
        &self,
        box_id: &str,
        expected_version: u64,
        bundle: &OwnerKeyBundle,
        current_login_password: Option<&str>,
    ) -> EncryptedSessionResult<OwnerKeyRecord> {
        check_id(box_id)?;
        if expected_version >= MAX_INTEGER {
            return Err(Error::InvalidArgument("expected version out of range"));
        }
        bundle.validate()?;
        if bundle.wrapped.context.password_box_id.as_str() != box_id {
            return Err(Error::InvalidArgument(
                "bundle targets a different password box",
            ));
        }
        let mut body = json!({"expectedVersion": expected_version, "bundle": bundle});
        match (expected_version, current_login_password) {
            (0, None) => {}
            (0, Some(_)) => {
                return Err(Error::InvalidArgument(
                    "initial bundle must not carry a password",
                ))
            }
            (_, Some(password)) if !password.is_empty() => {
                body["currentPassword"] = Value::String(password.to_owned());
            }
            _ => {
                return Err(Error::InvalidArgument(
                    "replacing a bundle requires the login password",
                ))
            }
        }
        let url = self.endpoint(&["boxes", box_id, "owner-key"])?;
        let record = decode_record(&self.send(Method::PUT, url, Some(&body)).await?)?;
        if record.bundle != *bundle || record.bundle_version != expected_version + 1 {
            return Err(Error::InvalidResponse(
                "stored bundle differs from the request",
            ));
        }
        Ok(record)
    }

    fn endpoint(&self, segments: &[&str]) -> EncryptedSessionResult<Url> {
        let mut url = self.base.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| Error::InvalidBaseUrl("cannot be a base"))?;
            path.pop_if_empty().extend(["api", "encrypted"]);
            path.extend(segments);
        }
        Ok(url)
    }

    async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
    ) -> EncryptedSessionResult<Vec<u8>> {
        self.send_expected(method, url, body, 200).await
    }

    async fn send_expected(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        expected_status: u16,
    ) -> EncryptedSessionResult<Vec<u8>> {
        let mut request = self
            .http
            .request(method, url)
            .header(AUTHORIZATION, self.auth.clone())
            .header(ACCEPT, "application/json");
        if let Some(body) = body {
            request = request.json(body);
        }
        if expected_status == 204 {
            // Do not reuse this connection if a peer emits forbidden bytes
            // that the HTTP parser does not expose as a 204 response body.
            request = request.header(CONNECTION, "close");
        }
        let mut response = request.send().await.map_err(transport)?;
        let status = response.status();
        if status.as_u16() != expected_status {
            // 3xx lands here too: redirects are never followed.
            let body = read_limited(&mut response, MAX_ERROR_BYTES).await.ok();
            return Err(Error::Api {
                status: status.as_u16(),
                code: body.as_deref().and_then(error_code),
            });
        }
        if expected_status == 204 {
            // HTTP parsers can discard a forbidden 204 body. Inspect the raw
            // framing headers as well as all bytes exposed by the transport.
            if response.headers().contains_key(TRANSFER_ENCODING)
                || response
                    .headers()
                    .get_all(CONTENT_LENGTH)
                    .iter()
                    .any(|v| v.as_bytes() != b"0")
            {
                return Err(Error::InvalidResponse("delete response must be empty"));
            }
            return read_limited(&mut response, 0).await.map_err(|error| {
                if error == Error::ResponseTooLarge {
                    Error::InvalidResponse("delete response must be empty")
                } else {
                    error
                }
            });
        }
        read_limited(&mut response, MAX_RESPONSE_BYTES).await
    }
}

fn parse_base_url(raw: &str) -> EncryptedSessionResult<Url> {
    let bad = Error::InvalidBaseUrl;
    // Url::parse resolves `..` silently, so inspect the raw text first.
    let lower = raw.to_ascii_lowercase();
    if raw.bytes().any(|b| b.is_ascii_control() || b == b'\\')
        || lower.contains("%2f")
        || lower.contains("%5c")
        || lower
            .split('/')
            .any(|s| matches!(s.replace("%2e", ".").as_str(), "." | ".."))
    {
        return Err(bad("path traversal or control characters"));
    }
    let url = Url::parse(raw).map_err(|_| bad("unparseable"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("credentials are not allowed"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad("query or fragment is not allowed"));
    }
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" if url.host_str().is_some() => Ok(url),
        "http" if loopback => Ok(url),
        _ => Err(bad("https is required (http only for loopback)")),
    }
}

fn check_id(id: &str) -> EncryptedSessionResult<()> {
    ConnectId::validate(id)
        .map_err(|_| Error::InvalidArgument("identifier must be 26 lowercase alphanumerics"))
}

fn check_expected_context(box_id: &str, expected: &OwnerKeyContext) -> EncryptedSessionResult<()> {
    if expected.password_box_id.as_str() != box_id {
        Err(Error::InvalidArgument(
            "expected context targets a different password box",
        ))
    } else if expected.owner_account_id.is_nil() || !(1..=MAX_INTEGER).contains(&expected.key_epoch)
    {
        Err(Error::InvalidArgument("invalid expected owner context"))
    } else {
        Ok(())
    }
}

/// Public-shape check of an envelope bound for / returned from `box_id`/`item_id`.
fn envelope_problem(e: &EncryptedItem, box_id: &str, item_id: &str) -> Option<&'static str> {
    let c = &e.context;
    if e.format != 1 {
        Some("unsupported envelope format")
    } else if c.password_box_id.as_str() != box_id || c.item_id.as_str() != item_id {
        Some("envelope targets a different box or item")
    } else if !(1..=MAX_INTEGER).contains(&c.item_version)
        || !(1..=MAX_INTEGER).contains(&c.key_epoch)
    {
        Some("envelope version or epoch out of range")
    } else if b64_len(&e.nonce) != Some(24) {
        Some("nonce must be canonical Base64 of 24 bytes")
    } else if !b64_len(&e.ciphertext).is_some_and(|n| (16..=MAX_CIPHERTEXT_BYTES).contains(&n)) {
        Some("ciphertext must be canonical Base64 of 16..=1048592 bytes")
    } else {
        None
    }
}

fn decode_record(bytes: &[u8]) -> EncryptedSessionResult<OwnerKeyRecord> {
    let value: Value = decode(bytes)?;
    // Typed UUID parsing would accept upper case; the contract says canonical.
    let canonical = value
        .pointer("/bundle/wrapped/context/ownerAccountId")
        .and_then(Value::as_str)
        .is_some_and(|s| s.len() == 36 && !s.bytes().any(|b| b.is_ascii_uppercase()));
    if !canonical {
        return Err(Error::InvalidResponse("owner account id is not canonical"));
    }
    let record: OwnerKeyRecord = serde_json::from_value(value)
        .map_err(|_| Error::InvalidResponse("malformed owner key record"))?;
    if !(1..=MAX_INTEGER).contains(&record.bundle_version) {
        return Err(Error::InvalidResponse("bundle version out of range"));
    }
    if let Some(problem) = record.bundle.problem() {
        return Err(Error::InvalidResponse(problem));
    }
    Ok(record)
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> EncryptedSessionResult<T> {
    // serde errors can echo input fragments, so none is propagated.
    serde_json::from_slice(bytes)
        .map_err(|_| Error::InvalidResponse("malformed or unexpected JSON"))
}

fn error_code(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let code = value.get("error")?.as_str()?;
    let digits = code.strip_prefix("PS")?;
    (digits.len() == 3 && digits.bytes().all(|b| b.is_ascii_digit())).then(|| code.to_owned())
}

fn transport(e: reqwest::Error) -> Error {
    Error::Transport(if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect failed"
    } else {
        "request failed"
    })
}

async fn read_limited(response: &mut Response, max: usize) -> EncryptedSessionResult<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err(Error::ResponseTooLarge);
    }
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport)? {
        if out.len() + chunk.len() > max {
            return Err(Error::ResponseTooLarge);
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Decoded length of canonical padded standard Base64 (zero trailing bits), else None.
fn b64_len(text: &str) -> Option<usize> {
    if text.len() > 4 * MAX_CIPHERTEXT_BYTES.div_ceil(3) {
        return None;
    }
    let bytes = STANDARD.decode(text).ok()?;
    (!bytes.is_empty() && STANDARD.encode(&bytes) == text).then_some(bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use passshare_core::cloud_crypto::{ItemContext, PasswordBoxKey};
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::Instant;

    const TOKEN: &str = "synthetic-session-token";
    const PASSWORD: &str = "synthetic-login-password";
    const SECRET_BODY: &str = "synthetic-secret-body";
    const OWNER: &str = "7b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10";

    struct Seen {
        request_line: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Seen {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.as_str())
        }
        fn json(&self) -> Value {
            serde_json::from_slice(&self.body).unwrap()
        }
    }

    /// Blocking one-connection-per-response server on loopback with finite deadlines.
    struct Fixture {
        addr: SocketAddr,
        stop: Arc<AtomicBool>,
        handle: JoinHandle<Vec<Seen>>,
    }

    impl Fixture {
        fn start(responses: Vec<Vec<u8>>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let addr = listener.local_addr().unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let handle = thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(20);
                let mut seen = Vec::new();
                for response in responses {
                    let mut stream = loop {
                        if flag.load(Ordering::SeqCst) || Instant::now() > deadline {
                            return seen;
                        }
                        match listener.accept() {
                            Ok((stream, _)) => break stream,
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                thread::sleep(Duration::from_millis(5))
                            }
                            Err(_) => return seen,
                        }
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    if let Some(request) = read_request(&mut stream, deadline) {
                        seen.push(request);
                    }
                    let _ = stream.write_all(&response);
                    let _ = stream.flush();
                }
                seen
            });
            Self { addr, stop, handle }
        }

        fn url(&self) -> String {
            format!("http://{}", self.addr)
        }

        fn client(&self) -> EncryptedSessionClient {
            EncryptedSessionClient::new(&self.url(), TOKEN).unwrap()
        }

        fn finish(self) -> Vec<Seen> {
            self.stop.store(true, Ordering::SeqCst);
            self.handle.join().unwrap()
        }
    }

    fn read_request(stream: &mut std::net::TcpStream, deadline: Instant) -> Option<Seen> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut fill = |buf: &mut Vec<u8>| -> Option<()> {
            if Instant::now() > deadline {
                return None;
            }
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => None,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    Some(())
                }
            }
        };
        let head_end = loop {
            if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break p + 4;
            }
            fill(&mut buf)?;
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let mut lines = head.split("\r\n");
        let request_line = lines.next()?.to_owned();
        let headers: Vec<(String, String)> = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_owned()))
            .collect();
        let length: usize = headers
            .iter()
            .find(|(n, _)| n == "content-length")
            .and_then(|(_, v)| v.parse().ok())
            .unwrap_or(0);
        while buf.len() < head_end + length {
            fill(&mut buf)?;
        }
        Some(Seen {
            request_line,
            headers,
            body: buf[head_end..head_end + length].to_vec(),
        })
    }

    fn http(status: u16, body: &Value) -> Vec<u8> {
        let body = body.to_string();
        format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn box_id() -> String {
        "b".repeat(26)
    }
    fn item_id() -> String {
        "i".repeat(26)
    }

    fn item_context(version: u64) -> ItemContext {
        ItemContext {
            password_box_id: box_id().parse().unwrap(),
            item_id: item_id().parse().unwrap(),
            item_version: version,
            key_epoch: 1,
        }
    }

    fn item_json(version: u64) -> Value {
        json!({"id": item_id(), "version": version, "vault": {"id": box_id()}, "title": "Synthetic"})
    }

    fn owner_context(epoch: u64) -> OwnerKeyContext {
        OwnerKeyContext {
            password_box_id: box_id().parse().unwrap(),
            owner_account_id: OWNER.parse().unwrap(),
            key_epoch: epoch,
        }
    }

    fn bundle() -> OwnerKeyBundle {
        OwnerKeyBundle::new(
            format!("{}==", "A".repeat(22)),
            WrappedPasswordBoxKey {
                format: 1,
                context: owner_context(1),
                nonce: "A".repeat(32),
                ciphertext: "A".repeat(64),
            },
        )
        .unwrap()
    }

    fn assert_api(err: EncryptedSessionError, status: u16, code: Option<&str>) {
        assert_eq!(err.status(), Some(status));
        assert_eq!(err.code(), code);
    }

    #[test]
    fn base_url_rules() {
        for ok in [
            "https://example.test",
            "https://example.test/prefix/",
            "http://localhost:8080",
            "http://127.0.0.1:1",
            "http://[::1]:1",
        ] {
            assert!(EncryptedSessionClient::new(ok, TOKEN).is_ok(), "{ok}");
        }
        for bad in [
            "http://example.test",
            "http://127.0.0.1.example.test",
            "ftp://example.test",
            "https://user:pw@example.test",
            "https://user@example.test",
            "https://example.test/?a=1",
            "https://example.test/#frag",
            "https://example.test/a/../b",
            "https://example.test/%2e%2E/b",
            "https://example.test/a%2fb",
            "https://example.test\\a",
            "not a url",
        ] {
            assert!(
                matches!(
                    EncryptedSessionClient::new(bad, TOKEN),
                    Err(EncryptedSessionError::InvalidBaseUrl(_))
                ),
                "{bad}"
            );
        }
        for token in ["", "a b", "a\r\nX: y"] {
            assert_eq!(
                EncryptedSessionClient::new("https://example.test", token).unwrap_err(),
                EncryptedSessionError::InvalidToken
            );
        }
    }

    #[test]
    fn debug_redacts_token() {
        let client = EncryptedSessionClient::new("https://example.test", TOKEN).unwrap();
        assert!(!format!("{client:?}").contains(TOKEN));
    }

    #[test]
    fn base64_must_be_canonical_with_exact_length() {
        assert_eq!(b64_len(&"A".repeat(32)), Some(24));
        assert_eq!(b64_len(&format!("{}==", "A".repeat(22))), Some(16));
        assert_eq!(b64_len(&format!("{}B=", "A".repeat(26))), None); // stray trailing bits
        assert_eq!(b64_len(&format!("{}B==", "A".repeat(21))), None);
        assert_eq!(b64_len("AAA"), None);
        assert_eq!(b64_len("AA=A"), None);
        assert_eq!(b64_len("AA-_"), None);
        assert_eq!(b64_len(""), None);
    }

    #[tokio::test]
    async fn invalid_arguments_never_reach_the_network() {
        let server = Fixture::start(vec![http(200, &json!({}))]);
        let client = server.client();
        let key = PasswordBoxKey::generate().unwrap();
        let good = key.encrypt_item(&item_json(1), &item_context(1)).unwrap();
        let (b, i) = (box_id(), item_id());

        for id in [
            "short",
            &"B".repeat(26),
            &format!("{}/", "b".repeat(25)),
            "../etc",
        ] {
            assert!(matches!(
                client.state(id).await,
                Err(EncryptedSessionError::InvalidArgument(_))
            ));
            assert!(client.list(&b, Some(id)).await.is_err());
            assert!(client.get_item(&b, id).await.is_err());
        }
        // Version shape: expected must be < 2^53-1 and envelope version expected+1.
        assert!(client
            .put_item(&b, &i, 9_007_199_254_740_991, &good)
            .await
            .is_err());
        assert!(client.put_item(&b, &i, 1, &good).await.is_err());
        // Destination mismatch and malformed ciphertext.
        assert!(client
            .put_item(&b, &"j".repeat(26), 0, &good)
            .await
            .is_err());
        let mut short = good.clone();
        short.ciphertext = format!("{}==", "A".repeat(10));
        assert!(client.put_item(&b, &i, 0, &short).await.is_err());
        let mut wrong_nonce = good.clone();
        wrong_nonce.nonce = "A".repeat(28);
        assert!(client.put_item(&b, &i, 0, &wrong_nonce).await.is_err());
        // Owner bundle rules.
        assert!(client
            .put_owner_key(&b, 0, &bundle(), Some(PASSWORD))
            .await
            .is_err());
        assert!(client.put_owner_key(&b, 1, &bundle(), None).await.is_err());
        assert!(client
            .put_owner_key(&b, 1, &bundle(), Some(""))
            .await
            .is_err());
        assert!(client
            .put_owner_key(&"c".repeat(26), 0, &bundle(), None)
            .await
            .is_err());
        assert!(client
            .get_owner_key(&"c".repeat(26), &owner_context(1))
            .await
            .is_err());
        assert!(client.get_owner_key(&b, &owner_context(0)).await.is_err());
        let mut bad = bundle();
        bad.salt = format!("{}==", "A".repeat(18));
        assert!(bad.validate().is_err());
        assert!(client.put_owner_key(&b, 0, &bad, None).await.is_err());

        assert!(server.finish().is_empty(), "no request may be sent");
    }

    #[tokio::test]
    async fn item_flow_uses_exact_paths_headers_and_bodies() {
        let key = PasswordBoxKey::generate().unwrap();
        let first = key.encrypt_item(&item_json(1), &item_context(1)).unwrap();
        let (b, i) = (box_id(), item_id());
        let server = Fixture::start(vec![
            http(200, &json!({"mode": "compatibility", "keyEpoch": null})),
            http(200, &json!({"mode":"encrypted","keyEpoch": 1})),
            http(200, &json!({"mode": "encrypted", "keyEpoch": 1})),
            http(
                200,
                &json!({"items": [{"itemId": i, "itemVersion": 1, "keyEpoch": 1}], "nextCursor": null}),
            ),
            http(200, &json!(first)),
            http(200, &json!(first)),
        ]);
        let client =
            EncryptedSessionClient::new(&format!("{}/base/", server.url()), TOKEN).unwrap();

        assert_eq!(client.state(&b).await.unwrap(), BoxState::Compatibility);
        assert_eq!(client.enable_empty_box(&b).await.unwrap(), 1);
        assert_eq!(
            client.state(&b).await.unwrap(),
            BoxState::Encrypted { key_epoch: 1 }
        );
        let after = "a".repeat(26);
        let page = client.list(&b, Some(&after)).await.unwrap();
        assert_eq!(page.items.len(), 1);
        let stored = client.put_item(&b, &i, 0, &first).await.unwrap();
        assert_eq!(stored, first);
        let got = client.get_item(&b, &i).await.unwrap();
        // Core, not the SDK, authenticates the ciphertext against the trusted context.
        assert_eq!(
            key.decrypt_item(&got, &item_context(1)).unwrap(),
            item_json(1)
        );

        let seen = server.finish();
        let prefix = "/base/api/encrypted/boxes";
        let lines: Vec<&str> = seen.iter().map(|s| s.request_line.as_str()).collect();
        assert_eq!(
            lines,
            [
                format!("GET {prefix}/{b} HTTP/1.1"),
                format!("POST {prefix}/{b}/enable HTTP/1.1"),
                format!("GET {prefix}/{b} HTTP/1.1"),
                format!("GET {prefix}/{b}/items?after={after} HTTP/1.1"),
                format!("PUT {prefix}/{b}/items/{i} HTTP/1.1"),
                format!("GET {prefix}/{b}/items/{i} HTTP/1.1"),
            ]
        );
        for request in &seen {
            assert_eq!(
                request.header("authorization"),
                Some("Bearer synthetic-session-token")
            );
            assert_eq!(request.header("cookie"), None);
        }
        assert_eq!(seen[1].json(), json!({"keyEpoch": 1}));
        assert_eq!(seen[4].header("content-type"), Some("application/json"));
        assert_eq!(
            seen[4].json(),
            json!({"expectedVersion": 0, "envelope": first})
        );
        assert!(seen[0].body.is_empty() && seen[5].body.is_empty());
    }

    #[tokio::test]
    async fn responses_are_validated_structurally() {
        let key = PasswordBoxKey::generate().unwrap();
        let sent = key.encrypt_item(&item_json(1), &item_context(1)).unwrap();
        let mut altered = sent.clone();
        altered.ciphertext = key
            .encrypt_item(&item_json(1), &item_context(1))
            .unwrap()
            .ciphertext;
        let mut other_item = sent.clone();
        other_item.context.item_id = "j".repeat(26).parse().unwrap();
        let mut with_extra = json!(sent);
        with_extra["plaintext"] = json!("x");
        let (b, i) = (box_id(), item_id());

        let server = Fixture::start(vec![
            http(200, &json!(altered)),    // put echoes other ciphertext
            http(200, &json!(other_item)), // get returns other item
            http(200, &with_extra),        // unknown field
            http(200, &json!({"mode": "encrypted", "keyEpoch": null})), // inconsistent state
            http(
                200,
                &json!({"items": [{"itemId": "b".repeat(26), "itemVersion": 1, "keyEpoch": 1}], "nextCursor": null}),
            ), // not after cursor
            http(200, &json!({"mode":"encrypted","keyEpoch": 2})),
        ]);
        let client = server.client();
        let invalid = |r: Result<_, EncryptedSessionError>| {
            assert!(matches!(
                r.map(|_: ()| ()),
                Err(EncryptedSessionError::InvalidResponse(_))
            ))
        };
        invalid(client.put_item(&b, &i, 0, &sent).await.map(|_| ()));
        invalid(client.get_item(&b, &i).await.map(|_| ()));
        invalid(client.get_item(&b, &i).await.map(|_| ()));
        invalid(client.state(&b).await.map(|_| ()));
        invalid(client.list(&b, Some(&"c".repeat(26))).await.map(|_| ()));
        invalid(client.enable_empty_box(&b).await.map(|_| ()));
        server.finish();
    }

    #[tokio::test]
    async fn api_errors_expose_status_and_code_only() {
        let body = |code: Value| json!({"error": code, "message": SECRET_BODY, "token": TOKEN});
        let cases = [
            (401, json!("PS024"), Some("PS024")),
            (403, json!("PS032"), Some("PS032")),
            (404, json!("PS044"), Some("PS044")),
            (409, json!("PS015"), Some("PS015")),
            (429, json!("PS028"), Some("PS028")),
            (503, json!("not-a-code"), None),
        ];
        let server = Fixture::start(
            cases
                .iter()
                .map(|(s, c, _)| http(*s, &body(c.clone())))
                .collect(),
        );
        let client = server.client();
        for (status, _, code) in &cases {
            let err = client.state(&box_id()).await.unwrap_err();
            let shown = format!("{err} {err:?}");
            for secret in [SECRET_BODY, TOKEN] {
                assert!(!shown.contains(secret), "{shown}");
            }
            assert_api(err, *status, *code);
        }
        server.finish();
    }

    #[tokio::test]
    async fn missing_state_epoch_and_noncontract_success_are_rejected() {
        let server = Fixture::start(vec![
            http(200, &json!({"mode":"compatibility"})),
            http(201, &json!({"mode":"encrypted","keyEpoch":1})),
            http(200, &json!({"mode":"compatibility","keyEpoch":null})),
            http(200, &json!({"keyEpoch":1})),
            http(200, &json!({"mode":"compatibility","keyEpoch":1})),
            http(200, &json!({"mode":"encrypted","keyEpoch":1})),
        ]);
        let client = server.client();
        assert_eq!(
            client.state(&box_id()).await,
            Err(Error::InvalidResponse("missing key epoch"))
        );
        assert_api(
            client.enable_empty_box(&box_id()).await.unwrap_err(),
            201,
            None,
        );
        assert_eq!(
            client.state(&box_id()).await.unwrap(),
            BoxState::Compatibility
        );
        for _ in 0..2 {
            assert!(matches!(
                client.enable_empty_box(&box_id()).await,
                Err(Error::InvalidResponse(_))
            ));
        }
        assert_eq!(client.enable_empty_box(&box_id()).await.unwrap(), 1);
        assert_eq!(server.finish().len(), 6);
    }

    #[tokio::test]
    async fn cursor_must_equal_the_last_entry_of_a_full_page() {
        let items: Vec<_> = (1..=100)
            .map(|n| json!({"itemId":format!("{n:026}"),"itemVersion":1,"keyEpoch":1}))
            .collect();
        let last = items[99]["itemId"].clone();
        let server = Fixture::start(vec![
            http(
                200,
                &json!({"items":items,"nextCursor":format!("{:026}", 101)}),
            ),
            http(
                200,
                &json!({"items":items,"nextCursor":items[50]["itemId"]}),
            ),
            http(200, &json!({"items":items,"nextCursor":last})),
            http(200, &json!({"items":[],"nextCursor":last})),
            http(200, &json!({"items":items,"nextCursor":null})),
        ]);
        let client = server.client();
        for _ in 0..2 {
            assert_eq!(
                client.list(&box_id(), None).await,
                Err(Error::InvalidResponse("invalid next cursor"))
            );
        }
        assert_eq!(client.list(&box_id(), None).await.unwrap().items.len(), 100);
        assert_eq!(
            client.list(&box_id(), None).await,
            Err(Error::InvalidResponse("invalid next cursor"))
        );
        assert_eq!(
            client.list(&box_id(), None).await,
            Err(Error::InvalidResponse("invalid next cursor"))
        );
        assert_eq!(server.finish().len(), 5);
    }

    #[tokio::test]
    async fn cas_conflict_is_returned_without_retry() {
        let key = PasswordBoxKey::generate().unwrap();
        let envelope = key.encrypt_item(&item_json(2), &item_context(2)).unwrap();
        let server = Fixture::start(vec![
            http(409, &json!({"error": "PS015"})),
            http(200, &json!(envelope)), // would be consumed only by an automatic retry
        ]);
        let err = server
            .client()
            .put_item(&box_id(), &item_id(), 1, &envelope)
            .await
            .unwrap_err();
        assert_api(err, 409, Some("PS015"));
        assert_eq!(server.finish().len(), 1);
    }

    fn empty_delete_reply() -> Vec<u8> {
        b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_vec()
    }

    #[tokio::test]
    async fn delete_validates_before_http_and_sends_exact_method_body_and_auth() {
        let server = Fixture::start(vec![
            empty_delete_reply(),
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        ]);
        let client = server.client();
        for (box_arg, item_arg, version, epoch) in [
            ("bad".to_owned(), item_id(), 1, 1),
            (box_id(), "I".repeat(26), 1, 1),
            (box_id(), item_id(), 0, 1),
            (box_id(), item_id(), MAX_INTEGER + 1, 1),
            (box_id(), item_id(), 1, 0),
            (box_id(), item_id(), 1, MAX_INTEGER + 1),
        ] {
            assert!(matches!(
                client
                    .delete_item(&box_arg, &item_arg, version, epoch)
                    .await,
                Err(Error::InvalidArgument(_))
            ));
        }
        for version in [1, MAX_INTEGER] {
            client
                .delete_item(&box_id(), &item_id(), version, MAX_INTEGER)
                .await
                .unwrap();
        }
        let seen = server.finish();
        assert_eq!(seen.len(), 2, "invalid arguments must not reach HTTP");
        for (request, version) in seen.iter().zip([1, MAX_INTEGER]) {
            assert_eq!(
                request.request_line,
                format!(
                    "DELETE /api/encrypted/boxes/{}/items/{} HTTP/1.1",
                    box_id(),
                    item_id()
                )
            );
            assert_eq!(
                request.header("authorization"),
                Some(format!("Bearer {TOKEN}").as_str())
            );
            assert_eq!(request.header("content-type"), Some("application/json"));
            assert_eq!(request.header("connection"), Some("close"));
            assert_eq!(
                request.json(),
                json!({"expectedVersion":version,"keyEpoch":MAX_INTEGER})
            );
            assert!(!String::from_utf8_lossy(&request.body).contains(TOKEN));
        }
    }

    #[tokio::test]
    async fn delete_rejects_nonempty_204_framing_and_all_other_success_statuses() {
        for response in [
            http(204, &json!({"secret":SECRET_BODY})),
            b"HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\nx\r\n0\r\n\r\n".to_vec(),
        ] {
            let server = Fixture::start(vec![response]);
            assert!(server
                .client()
                .delete_item(&box_id(), &item_id(), 1, 1)
                .await
                .is_err());
            assert_eq!(server.finish().len(), 1);
        }
        for status in [200, 201, 202, 205, 206, 299] {
            let server = Fixture::start(vec![http(status, &json!({}))]);
            assert_api(
                server
                    .client()
                    .delete_item(&box_id(), &item_id(), 1, 1)
                    .await
                    .unwrap_err(),
                status,
                None,
            );
            assert_eq!(server.finish().len(), 1);
        }
    }

    #[tokio::test]
    async fn delete_conflicts_are_bounded_redacted_and_never_retried() {
        for code in ["PS015", "PS056"] {
            let server = Fixture::start(vec![
                http(
                    409,
                    &json!({"error":code,"message":SECRET_BODY,"token":TOKEN}),
                ),
                empty_delete_reply(), // an automatic retry would consume this
            ]);
            let error = server
                .client()
                .delete_item(&box_id(), &item_id(), 1, 1)
                .await
                .unwrap_err();
            let shown = format!("{error} {error:?}");
            assert!(!shown.contains(SECRET_BODY));
            assert!(!shown.contains(TOKEN));
            assert_api(error, 409, Some(code));
            assert_eq!(server.finish().len(), 1);
        }
        let server = Fixture::start(vec![format!(
            "HTTP/1.1 503 Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{SECRET_BODY}",
            MAX_ERROR_BYTES + 1
        )
        .into_bytes()]);
        assert_api(
            server
                .client()
                .delete_item(&box_id(), &item_id(), 1, 1)
                .await
                .unwrap_err(),
            503,
            None,
        );
        assert_eq!(server.finish().len(), 1);
    }

    #[tokio::test]
    async fn delete_redirect_never_forwards_session_or_body() {
        let target = Fixture::start(vec![empty_delete_reply()]);
        let origin = Fixture::start(vec![format!(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: {}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", target.url()
        )
        .into_bytes()]);
        assert_api(
            origin
                .client()
                .delete_item(&box_id(), &item_id(), 1, 1)
                .await
                .unwrap_err(),
            307,
            None,
        );
        assert_eq!(origin.finish().len(), 1);
        assert!(target.finish().is_empty());
    }

    #[tokio::test]
    async fn redirects_are_not_followed_and_authorization_is_not_forwarded() {
        let target = Fixture::start(vec![http(
            200,
            &json!({"mode": "compatibility", "keyEpoch": null}),
        )]);
        let origin = Fixture::start(vec![format!(
            "HTTP/1.1 302 Found\r\nLocation: {}/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            target.url()
        )
        .into_bytes()]);
        let err = origin.client().state(&box_id()).await.unwrap_err();
        assert_api(err, 302, None);
        assert_eq!(origin.finish().len(), 1);
        assert!(
            target.finish().is_empty(),
            "redirect target must see no request"
        );
    }

    #[tokio::test]
    async fn oversized_responses_are_rejected() {
        let declared = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\nx",
            MAX_RESPONSE_BYTES + 1
        );
        let mut streamed = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        streamed.extend(std::iter::repeat_n(b'a', MAX_RESPONSE_BYTES + 1));
        let server = Fixture::start(vec![declared.into_bytes(), streamed]);
        let client = server.client();
        for _ in 0..2 {
            assert_eq!(
                client.state(&box_id()).await.unwrap_err(),
                EncryptedSessionError::ResponseTooLarge
            );
        }
        server.finish();
    }

    #[tokio::test]
    async fn owner_key_get_requires_the_callers_expected_context() {
        let record = |b: &OwnerKeyBundle| json!({"bundleVersion": 1, "bundle": b});
        let mut other_owner = bundle();
        other_owner.wrapped.context.owner_account_id =
            "8b1f3c52-0a4e-4c1d-9a55-3f2d6e8b9c10".parse().unwrap();
        let mut upper = record(&bundle());
        upper["bundle"]["wrapped"]["context"]["ownerAccountId"] = json!(OWNER.to_uppercase());
        let mut extra = record(&bundle());
        extra["bundle"]["kdf"] = json!("argon2");

        let server = Fixture::start(vec![
            http(200, &record(&bundle())),
            http(200, &record(&bundle())),    // caller expects epoch 2
            http(200, &record(&other_owner)), // server swaps the owner
            http(200, &upper),
            http(200, &extra),
            http(404, &json!({"error": "PS012"})),
        ]);
        let client = server.client();
        let b = box_id();
        let got = client.get_owner_key(&b, &owner_context(1)).await.unwrap();
        assert_eq!((got.bundle_version, got.bundle), (1, bundle()));
        assert_eq!(
            client
                .get_owner_key(&b, &owner_context(2))
                .await
                .unwrap_err(),
            EncryptedSessionError::ContextMismatch
        );
        assert_eq!(
            client
                .get_owner_key(&b, &owner_context(1))
                .await
                .unwrap_err(),
            EncryptedSessionError::ContextMismatch
        );
        for _ in 0..2 {
            assert!(matches!(
                client.get_owner_key(&b, &owner_context(1)).await,
                Err(EncryptedSessionError::InvalidResponse(_))
            ));
        }
        assert_api(
            client
                .get_owner_key(&b, &owner_context(1))
                .await
                .unwrap_err(),
            404,
            Some("PS012"),
        );
        let seen = server.finish();
        assert_eq!(
            seen[0].request_line,
            format!("GET /api/encrypted/boxes/{b}/owner-key HTTP/1.1")
        );
    }

    #[tokio::test]
    async fn owner_key_put_sends_password_only_when_replacing() {
        let reply =
            |version: u64| http(200, &json!({"bundleVersion": version, "bundle": bundle()}));
        let server = Fixture::start(vec![
            reply(1),
            reply(2),
            reply(5), // wrong version for expected 1
            http(401, &json!({"error": "PS026", "message": PASSWORD})),
        ]);
        let client = server.client();
        let b = box_id();

        assert_eq!(
            client
                .put_owner_key(&b, 0, &bundle(), None)
                .await
                .unwrap()
                .bundle_version,
            1
        );
        assert_eq!(
            client
                .put_owner_key(&b, 1, &bundle(), Some(PASSWORD))
                .await
                .unwrap()
                .bundle_version,
            2
        );
        assert!(matches!(
            client.put_owner_key(&b, 1, &bundle(), Some(PASSWORD)).await,
            Err(EncryptedSessionError::InvalidResponse(_))
        ));
        let err = client
            .put_owner_key(&b, 1, &bundle(), Some(PASSWORD))
            .await
            .unwrap_err();
        assert!(!format!("{err} {err:?}").contains(PASSWORD));
        assert_api(err, 401, Some("PS026"));

        let seen = server.finish();
        assert_eq!(
            seen[0].request_line,
            format!("PUT /api/encrypted/boxes/{b}/owner-key HTTP/1.1")
        );
        assert_eq!(
            seen[0].json(),
            json!({"expectedVersion": 0, "bundle": bundle()})
        );
        assert_eq!(
            seen[1].json(),
            json!({"expectedVersion": 1, "bundle": bundle(), "currentPassword": PASSWORD})
        );
    }
}
