//! Owner-only encrypted CLI. Session identity and revisioned box metadata are
//! authoritative inputs; neither an opaque bundle nor a replay supplies trust.
use std::fmt;
use std::io::{IsTerminal, Read};
use std::time::Duration;

use passshare_connect::{
    BoxState, EncryptedItem, EncryptedSessionClient, EncryptedSessionError, ItemContext,
    OwnerKeyContext, SharingItemSummary, SharingRotationClient, SharingSnapshot,
};
use passshare_core::{
    cloud_crypto::PasswordBoxKey, crypto, storage::file_format::KdfParams, ConnectId,
};
use reqwest::{
    header::{HeaderValue, AUTHORIZATION},
    redirect::Policy,
    Client, Url,
};
use serde_json::{json, Value};
use zeroize::{Zeroize, Zeroizing};

use super::{Cli, Commands, ItemCommands, VaultCommands};

// A maximal Core envelope expands to about 1.4 MiB in JSON/Base64. Allow
// bounded replay input as well as the original one-MiB plaintext DTO.
const MAX_INPUT: u64 = 2 * 1024 * 1024;
const MAX_AUTH: usize = 16 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
pub(super) enum Error {
    Invalid(&'static str),
    Api(EncryptedSessionError),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::Api(error) => match error.status() {
                Some(401) => {
                    f.write_str("HTTP 401: session expired or invalid; authenticate again")
                }
                Some(403) => f.write_str("HTTP 403: current owner permission is required"),
                Some(409) => f.write_str(
                    "HTTP 409: item, key epoch or box metadata changed; no automatic retry",
                ),
                _ => write!(f, "{error}"),
            },
        }
    }
}
impl std::error::Error for Error {}
impl From<EncryptedSessionError> for Error {
    fn from(value: EncryptedSessionError) -> Self {
        Self::Api(value)
    }
}
type Result<T> = std::result::Result<T, Error>;
const INPUT: Error = Error::Invalid("invalid secret input; use bounded JSON via a pipe or dedicated PassShare environment variables");
const CONTEXT: Error = Error::Invalid(
    "current session, owner bundle or password box context differs; refresh metadata",
);
const CRYPTO: Error = Error::Invalid(
    "encrypted data authentication failed; verify the encryption password and current context",
);

/// Keep full JSON, including fields unknown to this CLI. No Debug or diagnostic
/// serialization is implemented; owned plaintext strings are cleared on drop.
struct Plaintext(Value);
fn erase(value: &mut Value) {
    match value {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(erase),
        Value::Object(o) => o.values_mut().for_each(erase),
        _ => {}
    }
}
impl Drop for Plaintext {
    fn drop(&mut self) {
        erase(&mut self.0);
    }
}

fn object_keys(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
}

fn parse_input(bytes: &[u8]) -> Result<Plaintext> {
    let input = Plaintext(serde_json::from_slice(bytes).map_err(|_| INPUT)?);
    if !object_keys(
        &input.0,
        &[
            "sessionToken",
            "encryptionPassword",
            "item",
            "selectedFields",
            "preparedWrite",
        ],
    ) {
        return Err(INPUT);
    }
    Ok(input)
}

fn read_input(stdin: bool) -> Result<Plaintext> {
    if stdin {
        if std::io::stdin().is_terminal() {
            return Err(Error::Invalid(
                "--secret-stdin requires a pipe; terminal input would echo secrets",
            ));
        }
        let mut bytes = Zeroizing::new(Vec::new());
        std::io::stdin()
            .lock()
            .take(MAX_INPUT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| INPUT)?;
        if bytes.len() as u64 > MAX_INPUT {
            return Err(INPUT);
        }
        parse_input(&bytes)
    } else {
        let mut input = match std::env::var("PASSSHARE_INPUT_JSON") {
            Ok(raw) => {
                let raw = Zeroizing::new(raw);
                if raw.len() as u64 > MAX_INPUT {
                    return Err(INPUT);
                }
                let input = parse_input(raw.as_bytes())?;
                // Credentials may come from exactly one input boundary.
                if input.0.get("sessionToken").is_some()
                    || input.0.get("encryptionPassword").is_some()
                {
                    return Err(INPUT);
                }
                input
            }
            Err(std::env::VarError::NotPresent) => Plaintext(json!({})),
            Err(_) => return Err(INPUT),
        };
        for (key, env) in [
            ("sessionToken", "PASSSHARE_SESSION_TOKEN"),
            ("encryptionPassword", "PASSSHARE_ENCRYPTION_PASSWORD"),
        ] {
            input.0[key] = Value::String(std::env::var(env).map_err(|_| INPUT)?);
        }
        Ok(input)
    }
}

fn secret(input: &Plaintext, key: &str) -> Result<Zeroizing<String>> {
    let value = input
        .0
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= MAX_AUTH)
        .ok_or(INPUT)?;
    Ok(Zeroizing::new(value.to_owned()))
}

/// The SDK currently exposes only encrypted endpoints. This bounded GET is
/// solely for /api/auth/me, with the same deadlines and redirect/proxy policy.
/// Construct the SDK first so its complete origin and token validation applies.
async fn live_account(host: &str, token: &str) -> Result<String> {
    let mut url = Url::parse(host).map_err(|_| INPUT)?;
    let path = format!("{}/api/auth/me", url.path().trim_end_matches('/'));
    url.set_path(&path);
    let mut auth = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| INPUT)?;
    auth.set_sensitive(true);
    let http = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| Error::Invalid("failed to initialize session transport"))?;
    let mut response = http
        .get(url)
        .header(AUTHORIZATION, auth)
        .send()
        .await
        .map_err(|_| Error::Invalid("session transport failed; no automatic retry"))?;
    if response.status().as_u16() != 200 {
        return Err(EncryptedSessionError::Api {
            status: response.status().as_u16(),
            code: None,
        }
        .into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_AUTH as u64)
    {
        return Err(INPUT);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| INPUT)? {
        if bytes.len().saturating_add(chunk.len()) > MAX_AUTH {
            return Err(INPUT);
        }
        bytes.extend_from_slice(&chunk);
    }
    let account = Plaintext(serde_json::from_slice(&bytes).map_err(|_| INPUT)?);
    let id = account
        .0
        .pointer("/user/id")
        .and_then(Value::as_str)
        .ok_or(CONTEXT)?;
    // Core's context deserializer provides the UUID type without another dependency.
    let context: OwnerKeyContext = serde_json::from_value(json!({
        "passwordBoxId": "aaaaaaaaaaaaaaaaaaaaaaaaaa", "ownerAccountId": id, "keyEpoch": 1
    }))
    .map_err(|_| CONTEXT)?;
    if context.owner_account_id.is_nil() || context.owner_account_id.to_string() != id {
        return Err(CONTEXT);
    }
    Ok(id.to_owned())
}

struct Session {
    sdk: EncryptedSessionClient,
    sharing: SharingRotationClient,
    snapshot: SharingSnapshot,
    owner: OwnerKeyContext,
    key: PasswordBoxKey,
    // Binding replay to the same origin and path prefix is independent of bundles.
    host: String,
}
impl Session {
    async fn open(host: &str, token: &str, password: &str, box_id: &str) -> Result<Self> {
        let id: ConnectId = box_id
            .parse()
            .map_err(|_| Error::Invalid("encrypted mode requires a password box ID, not a name"))?;
        let sdk = EncryptedSessionClient::new(host, token)?;
        let account = live_account(host, token).await?;
        let epoch =
            match sdk.state(box_id).await? {
                BoxState::Encrypted { key_epoch } => key_epoch,
                _ => return Err(Error::Invalid(
                    "password box is not encrypted; choose its compatible Connect mode explicitly",
                )),
            };
        let sharing = SharingRotationClient::new(&sdk);
        let snapshot = sharing.sharing_snapshot(box_id, &account).await?;
        if snapshot.key_epoch != epoch {
            return Err(CONTEXT);
        }
        let owner: OwnerKeyContext = serde_json::from_value(json!({
            "passwordBoxId": id, "ownerAccountId": account, "keyEpoch": epoch,
        }))
        .map_err(|_| CONTEXT)?;
        let record = sdk.get_owner_key(box_id, &owner).await?;
        if record.bundle_version != snapshot.owner_bundle_version {
            return Err(CONTEXT);
        }
        let salt = KdfParams {
            algorithm: "argon2id".into(),
            salt: record.bundle.salt,
            memory_kib: crypto::KDF_MEMORY_KIB,
            time_cost: crypto::KDF_TIME_COST,
            parallelism: crypto::KDF_PARALLELISM,
        }
        .salt_bytes()
        .map_err(|_| CRYPTO)?;
        let root = crypto::derive_master_key(password, &salt).map_err(|_| CRYPTO)?;
        let key = PasswordBoxKey::unwrap_for_owner(&record.bundle.wrapped, &root, &owner)
            .map_err(|_| CRYPTO)?;
        Ok(Self {
            sdk,
            sharing,
            snapshot,
            owner,
            key,
            host: Url::parse(host).map_err(|_| INPUT)?.to_string(),
        })
    }

    async fn metadata(&self) -> Result<Vec<SharingItemSummary>> {
        let mut items = Vec::new();
        let mut cursor: Option<ConnectId> = None;
        loop {
            let page = self
                .sharing
                .snapshot_items(
                    self.box_id(),
                    &self.snapshot,
                    cursor.as_ref().map(ConnectId::as_str),
                )
                .await?;
            items.extend(page.items);
            if items.len() as u64 > self.snapshot.live_item_count {
                return Err(CONTEXT);
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        self.snapshot.validate_complete_items(&items)?;
        Ok(items)
    }
    fn box_id(&self) -> &str {
        self.owner.password_box_id.as_str()
    }
    async fn get(&self, id: &str) -> Result<Plaintext> {
        ConnectId::validate(id)
            .map_err(|_| Error::Invalid("encrypted mode requires an item ID, not a title"))?;
        let item = self
            .metadata()
            .await?
            .into_iter()
            .find(|i| i.item_id.as_str() == id)
            .ok_or(Error::Invalid(
                "item is absent from the current password box snapshot",
            ))?;
        let envelope = self
            .sharing
            .snapshot_item(self.box_id(), &self.snapshot, &item)
            .await?;
        let expected = ItemContext {
            password_box_id: self.owner.password_box_id.clone(),
            item_id: item.item_id,
            item_version: item.item_version,
            key_epoch: self.owner.key_epoch,
        };
        Ok(Plaintext(
            self.key
                .decrypt_item(&envelope, &expected)
                .map_err(|_| CRYPTO)?,
        ))
    }

    fn prepare(&self, mut item: Plaintext, expected: u64) -> Result<Value> {
        let version = expected
            .checked_add(1)
            .filter(|v| *v <= MAX_SAFE)
            .ok_or(CONTEXT)?;
        let id: ConnectId = item
            .0
            .get("id")
            .and_then(Value::as_str)
            .ok_or(INPUT)?
            .parse()
            .map_err(|_| INPUT)?;
        item.0["version"] = json!(version);
        let context = ItemContext {
            password_box_id: self.owner.password_box_id.clone(),
            item_id: id,
            item_version: version,
            key_epoch: self.owner.key_epoch,
        };
        // Encrypt and choose the identity once. All retries reuse this envelope.
        let envelope = self
            .key
            .encrypt_item(&item.0, &context)
            .map_err(|_| CRYPTO)?;
        Ok(self.prepared("put", expected, context.item_id.as_str(), Some(envelope)))
    }
    fn prepared(
        &self,
        operation: &str,
        expected: u64,
        id: &str,
        envelope: Option<EncryptedItem>,
    ) -> Value {
        json!({ "format": 1, "server": self.host, "operation": operation,
            "ownerAccountId": self.owner.owner_account_id, "passwordBoxId": self.owner.password_box_id,
            "keyEpoch": self.owner.key_epoch, "ownerBundleVersion": self.snapshot.owner_bundle_version,
            "itemId": id, "expectedVersion": expected, "envelope": envelope })
    }
    async fn submit(&self, prepared: &Value) -> Result<String> {
        if !object_keys(
            prepared,
            &[
                "format",
                "server",
                "operation",
                "ownerAccountId",
                "passwordBoxId",
                "keyEpoch",
                "ownerBundleVersion",
                "itemId",
                "expectedVersion",
                "envelope",
            ],
        ) || prepared["format"].as_u64() != Some(1)
            || prepared["server"].as_str() != Some(&self.host)
            || prepared["passwordBoxId"].as_str() != Some(self.box_id())
            || prepared["ownerAccountId"].as_str()
                != Some(self.owner.owner_account_id.to_string().as_str())
            || prepared["keyEpoch"].as_u64() != Some(self.owner.key_epoch)
            || prepared["ownerBundleVersion"].as_u64() != Some(self.snapshot.owner_bundle_version)
        {
            return Err(CONTEXT);
        }
        let id = prepared["itemId"].as_str().ok_or(INPUT)?;
        let expected = prepared["expectedVersion"]
            .as_u64()
            .filter(|v| *v <= MAX_SAFE)
            .ok_or(INPUT)?;
        match prepared["operation"].as_str() {
            Some("put") => {
                if expected == MAX_SAFE {
                    return Err(INPUT);
                }
                let envelope: EncryptedItem =
                    serde_json::from_value(prepared["envelope"].clone()).map_err(|_| INPUT)?;
                let context = ItemContext {
                    password_box_id: self.owner.password_box_id.clone(),
                    item_id: id.parse().map_err(|_| INPUT)?,
                    item_version: expected + 1,
                    key_epoch: self.owner.key_epoch,
                };
                let _checked = Plaintext(
                    self.key
                        .decrypt_item(&envelope, &context)
                        .map_err(|_| CRYPTO)?,
                );
                self.sdk
                    .put_item(self.box_id(), id, expected, &envelope)
                    .await?;
            }
            Some("delete") if expected > 0 && prepared.get("envelope") == Some(&Value::Null) => {
                self.sdk
                    .delete_item(self.box_id(), id, expected, self.owner.key_epoch)
                    .await?;
            }
            _ => return Err(INPUT),
        }
        Ok(id.to_owned())
    }
}

/// Selected field updates operate on the complete DTO, never a reconstructed
/// projection. Labels follow the legacy CLI purpose/label lookup policy.
fn field_index(item: &Value, name: &str) -> Result<usize> {
    let fields = item.get("fields").and_then(Value::as_array).ok_or(INPUT)?;
    let purpose = match name.to_ascii_lowercase().as_str() {
        "password" => Some("PASSWORD"),
        "username" => Some("USERNAME"),
        _ => None,
    };
    let matches: Vec<usize> = fields
        .iter()
        .enumerate()
        .filter(|(_, field)| match purpose {
            Some(p) => field["purpose"].as_str() == Some(p),
            None => {
                field["label"]
                    .as_str()
                    .is_some_and(|s| s.eq_ignore_ascii_case(name))
                    || field["id"].as_str() == Some(name)
            }
        })
        .map(|(i, _)| i)
        .collect();
    if matches.len() != 1 {
        return Err(Error::Invalid("selected field is absent or ambiguous"));
    }
    Ok(matches[0])
}
fn edit_selected(original: &mut Plaintext, selected: &Value) -> Result<()> {
    let fields = selected
        .as_object()
        .filter(|o| !o.is_empty())
        .ok_or(INPUT)?;
    let mut targets = std::collections::HashSet::new();
    // Validate the whole selection before applying any mutation.
    for (name, value) in fields {
        let value = value.as_str().ok_or(INPUT)?;
        let target = if name.eq_ignore_ascii_case("title") {
            if value.trim().is_empty() {
                return Err(INPUT);
            }
            None
        } else {
            Some(field_index(&original.0, name)?)
        };
        if !targets.insert(target) {
            return Err(Error::Invalid("multiple selections address the same field"));
        }
    }
    for (name, value) in fields {
        if name.eq_ignore_ascii_case("title") {
            original.0["title"] = value.clone();
        } else {
            let index = field_index(&original.0, name)?;
            original.0["fields"][index]["value"] = value.clone();
        }
    }
    Ok(())
}

fn create_item(input: &Plaintext, box_id: &str) -> Result<Plaintext> {
    let mut item = Plaintext(
        input
            .0
            .get("item")
            .filter(|v| v.is_object())
            .ok_or(INPUT)?
            .clone(),
    );
    if item.0.get("id").is_some()
        || item.0.get("version").is_some()
        || item.0.get("vault").is_some()
    {
        return Err(INPUT);
    }
    if item.0["title"].as_str().is_none_or(|t| t.trim().is_empty())
        || item.0["category"].as_str().is_none_or(|c| {
            !matches!(
                c,
                "LOGIN"
                    | "PASSWORD"
                    | "SECURE_NOTE"
                    | "CREDIT_CARD"
                    | "IDENTITY"
                    | "SSH_KEY"
                    | "CUSTOM"
            )
        })
        || item
            .0
            .get("fields")
            .and_then(Value::as_array)
            .is_none_or(|f| f.iter().any(|v| !v.is_object()))
    {
        return Err(INPUT);
    }
    item.0["id"] = json!(ConnectId::generate().map_err(|_| CRYPTO)?);
    item.0["version"] = json!(1);
    item.0["vault"] = json!({"id":box_id});
    Ok(item)
}

pub(super) async fn run(cli: Cli) -> Result<()> {
    // Reject argv secret assignments before reading credentials or making HTTP calls.
    match &cli.command {
        Commands::Item { command: ItemCommands::Create { title, category, assignments, .. } } if title.is_some() || category.is_some() || !assignments.is_empty() => return Err(Error::Invalid("encrypted create uses secret JSON item input; argv assignments, title and category are forbidden")),
        Commands::Item { command: ItemCommands::Edit { assignments, .. } } if !assignments.is_empty() => return Err(Error::Invalid("encrypted edit uses secret JSON selectedFields; argv assignments are forbidden")),
        _ => {},
    }
    let mut input = read_input(cli.secret_stdin)?;
    let token = secret(&input, "sessionToken")?;
    let password = secret(&input, "encryptionPassword")?;
    let host = cli
        .passshare_host
        .or_else(|| std::env::var("PASSSHARE_HOST").ok())
        .ok_or(Error::Invalid(
            "set --passshare-host or PASSSHARE_HOST; OP_CONNECT_HOST is not used",
        ))?;
    let box_id = match &cli.command {
        Commands::Vault { .. } => cli.password_box.or_else(|| std::env::var("PASSSHARE_PASSWORD_BOX").ok()).ok_or(Error::Invalid("encrypted vault list requires --password-box or PASSSHARE_PASSWORD_BOX; account-wide discovery is unsupported"))?,
        Commands::Item { command } => match command {
            ItemCommands::List { vault } | ItemCommands::Get { vault, .. } | ItemCommands::Create { vault, .. }
            | ItemCommands::Edit { vault, .. } | ItemCommands::Delete { vault, .. } | ItemCommands::Retry { vault } => vault.clone(),
        },
        Commands::Read { reference } => passshare_connect::parse_op_reference(reference).ok_or(INPUT)?.vault,
    };
    let session = Session::open(&host, &token, &password, &box_id).await?;
    // Keys and credentials are kept only in memory for this invocation.
    drop(token);
    drop(password);
    if let Some(s) = input.0.get_mut("sessionToken") {
        erase(s);
    }
    if let Some(s) = input.0.get_mut("encryptionPassword") {
        erase(s);
    }
    let prepared = match cli.command {
        Commands::Vault {
            command: VaultCommands::List,
        } => {
            if cli.prepare_only {
                return Err(INPUT);
            }
            println!("{}\t{}", session.box_id(), session.owner.key_epoch);
            return Ok(());
        }
        Commands::Item { command } => match command {
            ItemCommands::List { .. } => {
                if cli.prepare_only {
                    return Err(INPUT);
                }
                for item in session.metadata().await? {
                    println!("{}\t{}", item.item_id, item.item_version);
                }
                return Ok(());
            }
            ItemCommands::Get { item, fields, .. } => {
                if cli.prepare_only {
                    return Err(INPUT);
                }
                let detail = session.get(&item).await?;
                if let Some(name) = fields {
                    let index = field_index(&detail.0, &name)?;
                    println!(
                        "{}",
                        detail.0["fields"][index]["value"].as_str().ok_or(INPUT)?
                    );
                } else {
                    println!(
                        "{}",
                        Zeroizing::new(serde_json::to_string_pretty(&detail.0).map_err(|_| INPUT)?)
                            .as_str()
                    );
                }
                return Ok(());
            }
            ItemCommands::Create { .. } => {
                if input.0.get("selectedFields").is_some() || input.0.get("preparedWrite").is_some()
                {
                    return Err(INPUT);
                }
                session.prepare(create_item(&input, &box_id)?, 0)?
            }
            ItemCommands::Edit { item, .. } => {
                if input.0.get("item").is_some() || input.0.get("preparedWrite").is_some() {
                    return Err(INPUT);
                }
                let mut detail = session.get(&item).await?;
                let expected = detail.0["version"].as_u64().ok_or(INPUT)?;
                edit_selected(&mut detail, input.0.get("selectedFields").ok_or(INPUT)?)?;
                session.prepare(detail, expected)?
            }
            ItemCommands::Delete { item, .. } => {
                if input.0.get("item").is_some()
                    || input.0.get("selectedFields").is_some()
                    || input.0.get("preparedWrite").is_some()
                {
                    return Err(INPUT);
                }
                let detail = session.get(&item).await?;
                session.prepared(
                    "delete",
                    detail.0["version"].as_u64().ok_or(INPUT)?,
                    &item,
                    None,
                )
            }
            ItemCommands::Retry { .. } => {
                if cli.prepare_only
                    || input.0.get("item").is_some()
                    || input.0.get("selectedFields").is_some()
                {
                    return Err(INPUT);
                }
                input.0.get("preparedWrite").ok_or(INPUT)?.clone()
            }
        },
        Commands::Read { reference } => {
            if cli.prepare_only {
                return Err(INPUT);
            }
            let reference = passshare_connect::parse_op_reference(&reference).ok_or(INPUT)?;
            let detail = session.get(&reference.item).await?;
            let index = field_index(&detail.0, &reference.field)?;
            println!(
                "{}",
                detail.0["fields"][index]["value"].as_str().ok_or(INPUT)?
            );
            return Ok(());
        }
    };
    if cli.prepare_only {
        println!("{}", serde_json::to_string(&prepared).map_err(|_| INPUT)?);
    } else {
        println!("{}", session.submit(&prepared).await?);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_fields_preserve_every_other_dto_property_and_reject_aliases() {
        let original = json!({"id":"a", "version":4, "title":"t", "category":"CUSTOM",
            "future":{"blob":"hidden"}, "sections":[{"id":"s"}], "urls":[{"href":"x","future":1}],
            "fields":[{"id":"p","label":"secret","purpose":"PASSWORD","value":"before","future":{"n":2}},
            {"id":"q","label":"other","value":"retained","section":{"id":"s"}}]});
        let mut edited = Plaintext(original.clone());
        edit_selected(&mut edited, &json!({"password":"after"})).unwrap();
        let mut expected = original.clone();
        expected["fields"][0]["value"] = json!("after");
        assert!(edited.0 == expected);
        assert!(edit_selected(&mut edited, &json!({"missing":"x"})).is_err());
        assert!(edit_selected(&mut edited, &json!({"password":"x","p":"y"})).is_err());
        assert!(edited.0 == expected);
    }

    #[test]
    fn secret_parse_and_crypto_errors_never_contain_input() {
        for raw in [
            b"{malformed-sensitive-marker".as_slice(),
            b"{\"tokenFile\":\"sensitive-marker\"}".as_slice(),
        ] {
            let error = match parse_input(raw) {
                Ok(_) => panic!("unexpected acceptance"),
                Err(e) => e,
            };
            assert!(!format!("{error:?} {error}").contains("sensitive-marker"));
        }
    }
}
