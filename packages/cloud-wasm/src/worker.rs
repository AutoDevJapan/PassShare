//! Worker-side dispatcher: exact version 1 JSON messages over one private box and identity.
//! No HTTP, filesystem, logging or raw-key message exists. The caller owns UI and Worker
//! lifetime; this module enforces generation, owner/item context and message bounds.
use super::{
    parse, shared::IDENTITY_LOCKED, CloudAccountIdentity, Session, INVALID, LOCKED, MAX_BODY,
};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

pub(crate) const STALE: &str = "PS058: Stale worker generation";
pub(crate) const OPEN: &str = "PS059: Password box is already open";
// Escaped 1 MiB plaintext is at most 6 bytes per input byte.
const MAX_MESSAGE: usize = MAX_BODY * 6 + 4096;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Command {
    Status,
    Generate,
    Unlock,
    Recover,
    RecoveryMaterial,
    Wrap,
    Encrypt,
    Decrypt,
    Create,
    Edit,
    EditAttachmentItem,
    Lock,
    IdentityGenerate,
    IdentityPublic,
    IdentityWrap,
    IdentityUnlock,
    IdentityPrepare,
    VerifyPublicIdentity,
    SharingContext,
    SharedRecipientWrap,
    SharedReceiveUnlock,
    EncryptAttachment,
    DecryptAttachment,
}

// Parsed secret text is wiped on drop. serde_json may leave transient copies while
// unescaping; the whole message buffer is wiped too, but no all-memory wipe is promised.
#[derive(Deserialize)]
#[serde(transparent)]
struct Secret(String);
impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u32,
    request_id: u64,
    command: Command,
    #[serde(default, deserialize_with = "present")]
    expected_generation: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    owner: Option<String>,
    #[serde(default, deserialize_with = "present")]
    context: Option<String>,
    #[serde(default, deserialize_with = "present")]
    bundle: Option<String>,
    #[serde(default, deserialize_with = "present")]
    envelope: Option<String>,
    #[serde(default, deserialize_with = "present")]
    item: Option<Secret>,
    #[serde(default, deserialize_with = "present")]
    password: Option<Secret>,
    #[serde(default, deserialize_with = "present")]
    values: Option<Secret>,
    #[serde(default, deserialize_with = "present")]
    account_context: Option<String>,
    #[serde(default, deserialize_with = "present")]
    expected_key_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    identity_secret: Option<Secret>,
    #[serde(default, deserialize_with = "present")]
    trusted_recipient_public: Option<String>,
    #[serde(default, deserialize_with = "present")]
    trusted_sender_public: Option<String>,
    #[serde(default, deserialize_with = "present")]
    shared_context: Option<String>,
    #[serde(default, deserialize_with = "present")]
    public_identity: Option<String>,
    #[serde(default, deserialize_with = "present")]
    verification_code: Option<String>,
    #[serde(default, deserialize_with = "present")]
    expected_attachment_context: Option<String>,
    #[serde(default, deserialize_with = "present")]
    name: Option<Secret>,
    #[serde(default, deserialize_with = "present")]
    attachment_source: Option<String>,
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

enum Out {
    Empty,
    Bundle(String),
    Envelope(String),
    Item(Zeroizing<String>),
    Recovery(Zeroizing<String>),
    PublicIdentity(String),
    SharedContext(String),
    IdentityPrepared(String),
    Attachment(passshare_core::cloud_crypto::AttachmentPlaintext),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply<'a> {
    version: u32,
    request_id: Option<u64>,
    generation: u64,
    locked: bool,
    identity_locked: bool,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bundle: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    envelope: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    item: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    public_identity: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shared_context: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity_prepared: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
}

pub(crate) struct WorkerSession {
    session: Option<Session>,
    identity: Option<CloudAccountIdentity>,
    generation: u64,
    last_request: u64,
}

impl WorkerSession {
    pub(crate) fn new() -> Self {
        Self {
            session: None,
            identity: None,
            generation: 0,
            last_request: 0,
        }
    }

    pub(crate) fn ready(&self) -> Zeroizing<String> {
        self.reply(None, Ok(Out::Empty))
    }

    /// Always returns a reply. Replies never echo input text; `requestId` is a number.
    #[cfg(test)]
    pub(crate) fn handle(&mut self, message: String) -> Zeroizing<String> {
        self.handle_output(message, None).0
    }

    pub(crate) fn invalid(&self) -> Zeroizing<String> {
        self.reply(None, Err(INVALID))
    }

    pub(crate) fn handle_output(
        &mut self,
        message: String,
        bytes: Option<Vec<u8>>,
    ) -> (
        Zeroizing<String>,
        Option<passshare_core::cloud_crypto::AttachmentPlaintext>,
    ) {
        let bytes = bytes.map(Zeroizing::new);
        let message = Zeroizing::new(message);
        let request: Request = match parse(&message, MAX_MESSAGE) {
            Ok(request) => request,
            Err(error) => return (self.reply(None, Err(error)), None),
        };
        drop(message);
        let id = request.request_id;
        let result = self.dispatch(request, bytes);
        let header = self.reply_ref(Some(id), &result);
        let plaintext = match result {
            Ok(Out::Attachment(plaintext)) => Some(plaintext),
            _ => None,
        };
        (header, plaintext)
    }

    fn dispatch(
        &mut self,
        mut r: Request,
        mut bytes: Option<Zeroizing<Vec<u8>>>,
    ) -> Result<Out, &'static str> {
        if r.version != 1 || r.request_id == 0 || r.request_id > MAX_SAFE {
            return Err(INVALID);
        }
        let attachment = matches!(
            r.command,
            Command::EncryptAttachment | Command::DecryptAttachment
        );
        if r.expected_attachment_context.is_some() != attachment
            || r.name.is_some() != (r.command == Command::EncryptAttachment)
            || bytes.is_some() != (r.command == Command::EncryptAttachment)
        {
            return Err(INVALID);
        }
        if r.attachment_source.is_some() != (r.command == Command::DecryptAttachment) {
            return Err(INVALID);
        }
        // A well-formed lock must also erase keys when replayed or delivered late.
        if r.command != Command::Lock && r.request_id <= self.last_request {
            return Err(INVALID);
        }
        self.last_request = self.last_request.max(r.request_id);
        // Exactly the box and identity/sharing fields of each command.
        let have = [
            r.expected_generation.is_some(),
            r.owner.is_some(),
            r.context.is_some(),
            r.bundle.is_some(),
            r.envelope.is_some(),
            r.item.is_some(),
            r.password.is_some(),
            r.values.is_some(),
        ];
        let box_fields = match r.command {
            Command::Status | Command::Lock => [false; 8],
            Command::Generate => [true, true, false, false, false, false, false, false],
            Command::Unlock | Command::Recover => {
                [true, true, false, true, false, false, true, false]
            }
            Command::RecoveryMaterial => [true, false, false, false, false, false, false, false],
            Command::Wrap => [true, false, false, false, false, false, true, false],
            Command::Encrypt => [true, false, true, false, false, true, false, false],
            Command::Create => [true, false, false, false, false, false, false, true],
            Command::SharingContext => [true, false, false, false, false, false, false, true],
            Command::IdentityPrepare => [true, false, false, false, false, false, false, true],
            Command::Edit | Command::EditAttachmentItem => {
                [true, false, true, false, false, true, false, true]
            }
            Command::Decrypt => [true, false, true, false, true, false, false, false],
            Command::EncryptAttachment => [true, false, false, false, false, false, false, false],
            Command::DecryptAttachment => [true, false, false, false, true, false, false, false],
            Command::IdentityGenerate
            | Command::IdentityPublic
            | Command::IdentityWrap
            | Command::VerifyPublicIdentity
            | Command::SharedRecipientWrap => {
                [true, false, false, false, false, false, false, false]
            }
            Command::IdentityUnlock => [true, false, false, true, false, false, false, false],
            Command::SharedReceiveUnlock => [true, false, false, false, true, false, false, false],
        };
        let shared_have = [
            r.account_context.is_some(),
            r.expected_key_id.is_some(),
            r.identity_secret.is_some(),
            r.trusted_recipient_public.is_some(),
            r.trusted_sender_public.is_some(),
            r.shared_context.is_some(),
            r.public_identity.is_some(),
            r.verification_code.is_some(),
        ];
        let shared_want = match r.command {
            Command::IdentityGenerate => [true, false, false, false, false, false, false, false],
            Command::IdentityWrap => [false, false, true, false, false, false, false, false],
            Command::IdentityPrepare => [false, false, true, false, false, false, false, false],
            Command::IdentityUnlock => [true, true, true, false, false, false, false, false],
            Command::SharedRecipientWrap => [false, false, false, true, false, true, false, false],
            Command::SharedReceiveUnlock => [false, false, false, false, true, true, false, false],
            Command::VerifyPublicIdentity => [true, false, false, false, false, false, true, true],
            _ => [false; 8],
        };
        if have != box_fields || shared_have != shared_want {
            return Err(INVALID);
        }
        match r.command {
            Command::Status => return Ok(Out::Empty),
            Command::Lock => {
                // Valid locks bypass generation and request ordering, invalidating pending work.
                if let Some(mut session) = self.session.take() {
                    session.lock();
                }
                if let Some(mut identity) = self.identity.take() {
                    identity.lock();
                }
                self.generation = (self.generation + 1).min(MAX_SAFE);
                return Ok(Out::Empty);
            }
            _ => {}
        }
        if r.expected_generation != Some(self.generation) {
            return Err(STALE);
        }
        let context = r.context.as_deref().unwrap_or_default();
        match r.command {
            Command::Generate | Command::Unlock | Command::Recover => {
                // Account/box switch needs an explicit lock first; an open session is never replaced.
                if self.session.is_some() {
                    return Err(OPEN);
                }
                if self.generation >= MAX_SAFE {
                    return Err(INVALID);
                }
                let owner = r.owner.as_deref().unwrap_or_default();
                // If an account identity is present, box scope must bind to that
                // account. Validate before generating keys or running the KDF.
                if let Some(identity) = &self.identity {
                    if !identity.matches_account(&super::owner(owner)?) {
                        return Err(INVALID);
                    }
                }
                let session = if r.command == Command::Generate {
                    Session::generate(owner)?
                } else {
                    let password = std::mem::take(&mut r.password.as_mut().unwrap().0);
                    if r.command == Command::Recover {
                        Session::recover(r.bundle.as_deref().unwrap_or_default(), password, owner)?
                    } else {
                        Session::unlock(r.bundle.as_deref().unwrap_or_default(), password, owner)?
                    }
                };
                self.session = Some(session);
                self.generation += 1;
                Ok(Out::Empty)
            }
            Command::IdentityGenerate | Command::IdentityUnlock => {
                // Identity may be added to a matching owner box, but never
                // replaced while either account's existing identity is open.
                if self.identity.is_some() {
                    return Err(OPEN);
                }
                if self.generation >= MAX_SAFE {
                    return Err(INVALID);
                }
                let account = r.account_context.as_deref().unwrap_or_default();
                let identity = if r.command == Command::IdentityGenerate {
                    CloudAccountIdentity::generate(account)?
                } else {
                    CloudAccountIdentity::restore(
                        r.bundle.as_deref().unwrap_or_default(),
                        std::mem::take(&mut r.identity_secret.as_mut().unwrap().0),
                        account,
                        r.expected_key_id.as_deref().unwrap_or_default(),
                    )?
                };
                if self
                    .session
                    .as_ref()
                    .is_some_and(|session| !identity.matches_account(&session.owner))
                {
                    return Err(INVALID);
                }
                let public = identity.public()?;
                self.identity = Some(identity);
                self.generation += 1;
                Ok(Out::PublicIdentity(public))
            }
            Command::IdentityPrepare => {
                if self.identity.is_some() {
                    return Err(OPEN);
                }
                if self.generation >= MAX_SAFE {
                    return Err(INVALID);
                }
                let (identity, prepared) = super::shared::prepare_identity(
                    &r.values.as_ref().unwrap().0,
                    std::mem::take(&mut r.identity_secret.as_mut().unwrap().0),
                )?;
                if self
                    .session
                    .as_ref()
                    .is_some_and(|session| !identity.matches_account(&session.owner))
                {
                    return Err(INVALID);
                }
                self.identity = Some(identity);
                self.generation += 1;
                Ok(Out::IdentityPrepared(prepared))
            }
            Command::IdentityPublic => self.identity()?.public().map(Out::PublicIdentity),
            Command::VerifyPublicIdentity => super::shared::verify_public(
                r.public_identity.as_deref().unwrap_or_default(),
                r.account_context.as_deref().unwrap_or_default(),
                r.verification_code.as_deref().unwrap_or_default(),
            )
            .map(Out::PublicIdentity),
            Command::SharingContext => {
                super::shared::sharing_context(&r.values.as_ref().unwrap().0)
                    .map(Out::SharedContext)
            }
            Command::IdentityWrap => self
                .identity()?
                .seal(std::mem::take(&mut r.identity_secret.as_mut().unwrap().0))
                .map(Out::Bundle),
            Command::SharedRecipientWrap => self
                .open()?
                .share(
                    self.identity()?,
                    r.trusted_recipient_public.as_deref().unwrap_or_default(),
                    r.shared_context.as_deref().unwrap_or_default(),
                )
                .map(Out::Envelope),
            Command::SharedReceiveUnlock => {
                if self.session.is_some() {
                    return Err(OPEN);
                }
                if self.generation >= MAX_SAFE {
                    return Err(INVALID);
                }
                let session = Session::receive(
                    r.envelope.as_deref().unwrap_or_default(),
                    self.identity()?,
                    r.trusted_sender_public.as_deref().unwrap_or_default(),
                    r.shared_context.as_deref().unwrap_or_default(),
                )?;
                self.session = Some(session);
                self.generation += 1;
                Ok(Out::Empty)
            }
            Command::Wrap => {
                let session = self.open()?;
                let password = std::mem::take(&mut r.password.as_mut().unwrap().0);
                session.wrap(password).map(Out::Bundle)
            }
            Command::RecoveryMaterial => self.open()?.recovery_material().map(Out::Recovery),
            Command::Encrypt => {
                let session = self.open()?;
                let item = std::mem::take(&mut r.item.as_mut().unwrap().0);
                session.encrypt(item, context).map(Out::Envelope)
            }
            Command::Create => {
                let session = self.open()?;
                let values = std::mem::take(&mut r.values.as_mut().unwrap().0);
                session.create_item(values).map(Out::Envelope)
            }
            Command::Edit => {
                let session = self.open()?;
                let item = std::mem::take(&mut r.item.as_mut().unwrap().0);
                let values = std::mem::take(&mut r.values.as_mut().unwrap().0);
                session.edit_item(item, values, context).map(Out::Envelope)
            }
            Command::EditAttachmentItem => {
                let session = self.open()?;
                let item = std::mem::take(&mut r.item.as_mut().ok_or(INVALID)?.0);
                let values = std::mem::take(&mut r.values.as_mut().ok_or(INVALID)?.0);
                session
                    .edit_attachment_item(item, values, context)
                    .map(Out::Envelope)
            }
            Command::Decrypt => self
                .open()?
                .decrypt(r.envelope.as_deref().unwrap_or_default(), context)
                .map(Out::Item),
            Command::EncryptAttachment => self
                .open()?
                .encrypt_attachment(
                    std::mem::take(&mut r.name.as_mut().unwrap().0),
                    std::mem::take(&mut **bytes.as_mut().unwrap()),
                    r.expected_attachment_context.as_deref().unwrap_or_default(),
                )
                .map(Out::Envelope),
            Command::DecryptAttachment => {
                self.open()?.verify_attachment_source(
                    r.expected_attachment_context.as_deref().unwrap_or_default(),
                    r.attachment_source.as_deref().unwrap_or_default(),
                )?;
                self.open()?
                    .decrypt_attachment(
                        r.envelope.as_deref().unwrap_or_default(),
                        r.expected_attachment_context.as_deref().unwrap_or_default(),
                    )
                    .map(Out::Attachment)
            }
            Command::Status | Command::Lock => unreachable!(),
        }
    }

    fn open(&self) -> Result<&Session, &'static str> {
        self.session.as_ref().ok_or(LOCKED)
    }

    fn identity(&self) -> Result<&CloudAccountIdentity, &'static str> {
        self.identity.as_ref().ok_or(IDENTITY_LOCKED)
    }

    fn reply(&self, id: Option<u64>, result: Result<Out, &'static str>) -> Zeroizing<String> {
        self.reply_ref(id, &result)
    }
    fn reply_ref(&self, id: Option<u64>, result: &Result<Out, &'static str>) -> Zeroizing<String> {
        let mut reply = Reply {
            version: 1,
            request_id: id,
            generation: self.generation,
            locked: self.session.is_none(),
            identity_locked: self.identity.is_none(),
            ok: result.is_ok(),
            error: None,
            bundle: None,
            envelope: None,
            item: None,
            recovery: None,
            public_identity: None,
            shared_context: None,
            identity_prepared: None,
            name: None,
        };
        match result {
            Err(error) => reply.error = Some(*error),
            Ok(Out::Bundle(text)) => reply.bundle = Some(text),
            Ok(Out::Envelope(text)) => reply.envelope = Some(text),
            Ok(Out::Item(text)) => reply.item = Some(text),
            Ok(Out::Recovery(text)) => reply.recovery = Some(text),
            Ok(Out::PublicIdentity(text)) => reply.public_identity = Some(text),
            Ok(Out::SharedContext(text)) => reply.shared_context = Some(text),
            Ok(Out::IdentityPrepared(text)) => reply.identity_prepared = Some(text),
            Ok(Out::Attachment(plaintext)) => reply.name = Some(plaintext.name()),
            Ok(Out::Empty) => {}
        }
        // Exact capacity avoids leaving plaintext in reallocated buffers.
        exact(&reply).unwrap_or_else(|| {
            Zeroizing::new(
                r#"{"version":1,"requestId":null,"ok":false,"error":"PS051: Invalid encrypted data"}"#
                    .to_owned(),
            )
        })
    }
}

fn exact(reply: &Reply) -> Option<Zeroizing<String>> {
    struct Size(usize);
    impl std::io::Write for Size {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut size = Size(0);
    serde_json::to_writer(&mut size, reply).ok()?;
    let mut bytes = Zeroizing::new(Vec::with_capacity(size.0));
    serde_json::to_writer(&mut *bytes, reply).ok()?;
    match String::from_utf8(std::mem::take(&mut *bytes)) {
        Ok(text) => Some(Zeroizing::new(text)),
        Err(error) => {
            error.into_bytes().zeroize();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const PASSWORD: &str = "Synthetic worker password!";

    #[test]
    fn identity_preparation_reconciles_lost_replies_and_never_trusts_unpinned_server_identity() {
        let account =
            json!({"accountId":"11111111-1111-4111-8111-111111111111","identityVersion":1})
                .to_string();
        let empty = json!({"accountContext":account,"ownPin":"","remoteRecord":"","pendingRecord":"","verificationCode":""});
        let prepare = |h: &mut Harness, input: &Value| {
            h.send(json!({"command":"identityPrepare","expectedGeneration":0,
            "values":input.to_string(),"identitySecret":PASSWORD}))
        };
        let mut first = Harness::new();
        let good = prepare(&mut first, &empty);
        assert_eq!(good["ok"], true);
        assert_eq!(good["generation"], 1);
        assert_eq!(good["identityLocked"], false);
        assert_eq!(good["locked"], true);
        assert!(!good.to_string().contains(PASSWORD));
        let prepared: Value =
            serde_json::from_str(good["identityPrepared"].as_str().unwrap()).unwrap();
        assert_eq!(prepared["requiresCreate"], true);
        assert_eq!(prepared["hasPending"], true);
        let record: Value = serde_json::from_str(prepared["record"].as_str().unwrap()).unwrap();
        let pin = prepared["publicIdentity"].as_str().unwrap();
        let mut retry = empty.clone();
        retry["ownPin"] = json!(pin);
        retry["pendingRecord"] = prepared["record"].clone();
        let mut lost = Harness::new();
        let restored = prepare(&mut lost, &retry);
        let restored: Value =
            serde_json::from_str(restored["identityPrepared"].as_str().unwrap()).unwrap();
        assert_eq!(restored["record"], prepared["record"]);
        assert_eq!(restored["publicIdentity"], prepared["publicIdentity"]);
        retry["remoteRecord"] = prepared["record"].clone();
        let mut committed = Harness::new();
        let result = prepare(&mut committed, &retry);
        let result: Value =
            serde_json::from_str(result["identityPrepared"].as_str().unwrap()).unwrap();
        assert_eq!(result["requiresCreate"], false);
        assert_eq!(result["hasPending"], true);
        assert_eq!(result["record"], prepared["record"]);
        let mut unpinned = retry.clone();
        unpinned["ownPin"] = json!("");
        unpinned["pendingRecord"] = json!("");
        let mut rejected = Harness::new();
        assert_eq!(prepare(&mut rejected, &unpinned)["ok"], false);
        assert!(rejected.worker.identity.is_none());
        unpinned["verificationCode"] = record["identity"]["keyId"].clone();
        assert_eq!(prepare(&mut rejected, &unpinned)["ok"], true);
        let alternate = CloudAccountIdentity::generate(&account).unwrap();
        let mut changed = record.clone();
        changed["identity"] = serde_json::from_str(&alternate.public().unwrap()).unwrap();
        changed["bundle"] =
            serde_json::from_str(&alternate.seal(PASSWORD.into()).unwrap()).unwrap();
        for (field, value) in [
            ("remoteRecord", json!(changed.to_string())),
            ("pendingRecord", json!(changed.to_string())),
            (
                "accountContext",
                json!(account.replace("11111111", "22222222")),
            ),
            ("ownPin", Value::Null),
            ("unknown", json!("do-not-echo")),
        ] {
            let mut bad = retry.clone();
            bad[field] = value;
            let mut h = Harness::new();
            let rejected = prepare(&mut h, &bad);
            assert_eq!(rejected["ok"], false);
            assert!(h.worker.identity.is_none());
            assert!(!rejected.to_string().contains("do-not-echo"));
        }
        let mut orphan = empty;
        orphan["ownPin"] = json!(pin);
        let mut h = Harness::new();
        assert_eq!(prepare(&mut h, &orphan)["ok"], false);
        let mut owner_first = Harness::new();
        let g = owner_first.open();
        let reply = owner_first.send(json!({"command":"identityPrepare","expectedGeneration":g,"values":retry.to_string(),"identitySecret":PASSWORD}));
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["locked"], false);
    }

    #[test]
    fn independent_code_checks_canonical_public_identity_without_opening_or_advancing() {
        let account =
            json!({"accountId":"11111111-1111-4111-8111-111111111111","identityVersion":1})
                .to_string();
        let key = CloudAccountIdentity::generate(&account).unwrap();
        let descriptor = key.public().unwrap();
        let public: Value = serde_json::from_str(&descriptor).unwrap();
        let code = public["keyId"].as_str().unwrap();
        let grouped = code
            .as_bytes()
            .chunks(4)
            .map(|c| std::str::from_utf8(c).unwrap().to_uppercase())
            .collect::<Vec<_>>()
            .join(" \r\n");
        let mut h = Harness::new();
        let base = json!({"command":"verifyPublicIdentity","expectedGeneration":0,
            "accountContext":account,"publicIdentity":descriptor,"verificationCode":grouped});
        let good = h.send(base.clone());
        assert_eq!(good["ok"], true);
        assert_eq!(good["publicIdentity"], descriptor);
        assert_eq!(good["generation"], 0);
        assert_eq!(good["locked"], true);
        assert_eq!(good["identityLocked"], true);
        let alternate = CloudAccountIdentity::generate(&account)
            .unwrap()
            .public()
            .unwrap();
        for (field, value) in [
            ("verificationCode", json!("0".repeat(64))),
            ("verificationCode", json!(format!("{code}!"))),
            ("verificationCode", json!(" ".repeat(257))),
            (
                "verificationCode",
                json!(code.replace(&code[..1], "\u{00a0}")),
            ),
            ("verificationCode", Value::Null),
            ("publicIdentity", json!(alternate)),
            (
                "publicIdentity",
                json!(descriptor.replace(
                    "11111111-1111-4111-8111-111111111111",
                    "11111111111141118111111111111111"
                )),
            ),
            (
                "publicIdentity",
                json!(descriptor.replace("\"publicKey\":\"", "\"publicKey\":\" ")),
            ),
            (
                "accountContext",
                json!(account.replace("11111111", "22222222")),
            ),
            (
                "accountContext",
                json!(account.replace("\"identityVersion\":1", "\"identityVersion\":2")),
            ),
            ("unknown", json!("no-echo")),
            ("identitySecret", json!("no-echo")),
        ] {
            let mut bad = base.clone();
            bad[field] = value;
            let reply = h.send(bad);
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["generation"], 0);
            assert!(reply.get("publicIdentity").is_none());
            assert!(!reply.to_string().contains("no-echo"));
        }
        let mut malformed: Value = public;
        malformed["extra"] = json!(1);
        let mut bad = base.clone();
        bad["publicIdentity"] = json!(malformed.to_string());
        assert_eq!(h.send(bad)["ok"], false);
        let g = h.open();
        let mut stale = base;
        stale["expectedGeneration"] = json!(g - 1);
        assert_eq!(h.send(stale)["error"], STALE);
    }

    #[test]
    fn sharing_selection_requires_current_confirmed_single_owner_and_exact_input() {
        let a = json!({"accountId":"11111111-1111-4111-8111-111111111111","identityVersion":1});
        let b = json!({"accountId":"22222222-2222-4222-8222-222222222222","identityVersion":1});
        let sender: Value = serde_json::from_str(
            &CloudAccountIdentity::generate(&a.to_string())
                .unwrap()
                .public()
                .unwrap(),
        )
        .unwrap();
        let recipient: Value = serde_json::from_str(
            &CloudAccountIdentity::generate(&b.to_string())
                .unwrap()
                .public()
                .unwrap(),
        )
        .unwrap();
        let selection = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","callerAccountId":a["accountId"],"keyEpoch":3,
            "sender":sender,"recipient":recipient,"members":[
                {"accountId":a["accountId"],"role":"owner","membershipConfirmed":true},
                {"accountId":b["accountId"],"role":"member","membershipConfirmed":true}]});
        let mut h = Harness::new();
        let good = h.send(json!({"command":"sharingContext","expectedGeneration":0,"values":selection.to_string()}));
        assert_eq!(good["ok"], true);
        let context: Value = serde_json::from_str(good["sharedContext"].as_str().unwrap()).unwrap();
        assert_eq!(context["senderKeyId"], sender["keyId"]);
        assert_eq!(context["recipientKeyId"], recipient["keyId"]);
        assert_eq!(context["keyEpoch"], 3);
        let mut cases = Vec::new();
        for field in ["sender", "recipient"] {
            let mut bad = selection.clone();
            bad[field]["extra"] = json!(1);
            cases.push(bad);
        }
        for index in [0, 1] {
            let mut bad = selection.clone();
            bad["members"][index]["membershipConfirmed"] = json!(false);
            cases.push(bad);
        }
        let mut bad = selection.clone();
        bad["members"][1]["role"] = json!("owner");
        cases.push(bad);
        let mut bad = selection.clone();
        bad["members"].as_array_mut().unwrap().remove(1);
        cases.push(bad);
        let mut bad = selection.clone();
        bad["members"]
            .as_array_mut()
            .unwrap()
            .push(selection["members"][1].clone());
        cases.push(bad);
        let mut bad = selection.clone();
        bad["callerAccountId"] = json!("33333333-3333-4333-8333-333333333333");
        cases.push(bad);
        let mut bad = selection.clone();
        bad["keyEpoch"] = json!(0);
        cases.push(bad);
        for bad in cases {
            let reply = h.send(
                json!({"command":"sharingContext","expectedGeneration":0,"values":bad.to_string()}),
            );
            assert_eq!(reply["error"], INVALID);
            assert!(reply.get("sharedContext").is_none());
        }
        let mut receiving = selection;
        receiving["callerAccountId"] = b["accountId"].clone();
        assert_eq!(h.send(json!({"command":"sharingContext","expectedGeneration":0,"values":receiving.to_string()}))["ok"], true);
    }
    fn owner() -> String {
        json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","ownerAccountId":"11111111-1111-4111-8111-111111111111","keyEpoch":1}).to_string()
    }
    fn context() -> String {
        json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":1,"keyEpoch":1}).to_string()
    }
    fn item() -> Value {
        json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb","version":1,"vault":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa"},"fields":[{"value":"Synthetic worker private value"}]})
    }
    struct Harness {
        worker: WorkerSession,
        id: u64,
    }
    impl Harness {
        fn new() -> Self {
            Self {
                worker: WorkerSession::new(),
                id: 0,
            }
        }
        fn send(&mut self, mut message: Value) -> Value {
            self.id += 1;
            message["version"] = json!(1);
            message["requestId"] = json!(self.id);
            self.raw(message.to_string())
        }
        fn raw(&mut self, text: String) -> Value {
            serde_json::from_str(&self.worker.handle(text)).unwrap()
        }
        fn generation(&mut self) -> u64 {
            self.send(json!({"command":"status"}))["generation"]
                .as_u64()
                .unwrap()
        }
        fn open(&mut self) -> u64 {
            let g = self.generation();
            let reply =
                self.send(json!({"command":"generate","expectedGeneration":g,"owner":owner()}));
            assert_eq!(reply["ok"], true);
            reply["generation"].as_u64().unwrap()
        }
    }

    #[test]
    fn recovery_messages_preserve_key_scope_generation_and_full_document() {
        let mut h = Harness::new();
        let g = h.open();
        for bad in [
            json!({"command":"recoveryMaterial"}),
            json!({"command":"recoveryMaterial","expectedGeneration":g,"password":null}),
            json!({"command":"recoveryMaterial","expectedGeneration":g,"owner":owner()}),
        ] {
            let rejected = h.send(bad);
            assert_eq!(rejected["ok"], false);
            assert_eq!(rejected["locked"], false);
            assert!(rejected.get("recovery").is_none());
        }
        let encrypted = h.send(json!({"command":"encrypt","expectedGeneration":g,"context":context(),"item":item().to_string()}));
        let envelope = encrypted["envelope"].as_str().unwrap().to_owned();
        let generated = h.send(json!({"command":"recoveryMaterial","expectedGeneration":g}));
        assert_eq!(generated["ok"], true);
        let mut text = Zeroizing::new(generated["recovery"].as_str().unwrap().to_owned());
        let mut material: Value = serde_json::from_str(&text).unwrap();
        text.zeroize();
        let mut code = Zeroizing::new(material["recoveryCode"].as_str().unwrap().to_owned());
        super::super::erase(&mut material["recoveryCode"]);
        let bundle = material["bundle"].to_string();
        assert!(!bundle.contains(code.as_str()));
        let replaced = h.send(json!({"command":"recover","expectedGeneration":g,"owner":owner(),"bundle":bundle,"password":code.as_str()}));
        assert_eq!(replaced["ok"], false);
        assert_eq!(replaced["generation"], g);
        h.send(json!({"command":"lock"}));
        let fresh = h.generation();
        let old = h.send(json!({"command":"recover","expectedGeneration":g,"owner":owner(),"bundle":bundle,"password":code.as_str()}));
        assert_eq!(old["ok"], false);
        assert_eq!(old["locked"], true);
        let recovered = h.send(json!({"command":"recover","expectedGeneration":fresh,"owner":owner(),"bundle":bundle,"password":code.as_str()}));
        code.zeroize();
        assert_eq!(recovered["ok"], true);
        let new_g = recovered["generation"].as_u64().unwrap();
        assert_eq!(new_g, fresh + 1);
        let decrypted = h.send(json!({"command":"decrypt","expectedGeneration":new_g,"context":context(),"envelope":envelope}));
        assert_eq!(decrypted["ok"], true);
        assert_eq!(
            serde_json::from_str::<Value>(decrypted["item"].as_str().unwrap()).unwrap(),
            item()
        );
        h.send(json!({"command":"lock"}));
        let locked =
            h.send(json!({"command":"recoveryMaterial","expectedGeneration":h.worker.generation}));
        assert_eq!(locked["ok"], false);
        assert!(locked.get("recovery").is_none());
    }

    #[test]
    fn full_json_round_trip_through_messages() {
        let mut h = Harness::new();
        let status = h.send(json!({"command":"status"}));
        assert_eq!(
            (status["generation"].clone(), status["locked"].clone()),
            (json!(0), json!(true))
        );
        let g = h.open();
        assert_eq!(g, 1);
        let encrypted = h.send(json!({"command":"encrypt","expectedGeneration":g,"context":context(),"item":item().to_string()}));
        assert_eq!(encrypted["requestId"], h.id);
        let envelope = encrypted["envelope"].as_str().unwrap().to_owned();
        assert!(!envelope.contains("Synthetic worker private value"));
        let bundle = h.send(json!({"command":"wrap","expectedGeneration":g,"password":PASSWORD}));
        let bundle = bundle["bundle"].as_str().unwrap().to_owned();
        let decrypted = h.send(json!({"command":"decrypt","expectedGeneration":g,"context":context(),"envelope":envelope}));
        let body: Value = serde_json::from_str(decrypted["item"].as_str().unwrap()).unwrap();
        assert_eq!(body, item());
        // Lock, then restore from the bundle in a fresh generation.
        let locked = h.send(json!({"command":"lock"}));
        assert_eq!(
            (locked["locked"].clone(), locked["generation"].clone()),
            (json!(true), json!(2))
        );
        let restored = h.send(json!({"command":"unlock","expectedGeneration":2,"owner":owner(),"bundle":bundle,"password":PASSWORD}));
        assert_eq!(
            (restored["ok"].clone(), restored["generation"].clone()),
            (json!(true), json!(3))
        );
        let again = h.send(json!({"command":"decrypt","expectedGeneration":3,"context":context(),"envelope":envelope}));
        assert_eq!(
            serde_json::from_str::<Value>(again["item"].as_str().unwrap()).unwrap(),
            item()
        );
    }

    #[test]
    fn old_generation_is_rejected_after_lock_and_lock_is_idempotent() {
        let mut h = Harness::new();
        let g = h.open();
        let envelope = h.send(json!({"command":"encrypt","expectedGeneration":g,"context":context(),"item":item().to_string()}))["envelope"].as_str().unwrap().to_owned();
        let lock = h.send(json!({"command":"lock"}));
        assert_eq!(lock["generation"], g + 1);
        for message in [
            json!({"command":"decrypt","expectedGeneration":g,"context":context(),"envelope":envelope}),
            json!({"command":"encrypt","expectedGeneration":g,"context":context(),"item":item().to_string()}),
            json!({"command":"wrap","expectedGeneration":g,"password":PASSWORD}),
        ] {
            let reply = h.send(message);
            assert_eq!(
                (reply["ok"].clone(), reply["error"].clone()),
                (json!(false), json!(STALE))
            );
            assert!(reply.get("item").is_none() && reply.get("envelope").is_none());
        }
        // Current generation but no session: locked, not reopened implicitly.
        let reply =
            h.send(json!({"command":"wrap","expectedGeneration":g + 1,"password":PASSWORD}));
        assert_eq!(reply["error"], LOCKED);
        assert_eq!(h.send(json!({"command":"lock"}))["generation"], g + 2);
    }

    #[test]
    fn replayed_lock_erases_keys_without_lowering_request_order() {
        let mut h = Harness::new();
        h.open();
        assert_eq!(
            h.raw(json!({"version":1,"requestId":100,"command":"status"}).to_string())["ok"],
            true
        );
        let lock = json!({"version":1,"requestId":1,"command":"lock"}).to_string();
        for generation in [2, 3] {
            let reply = h.raw(lock.clone());
            assert_eq!(
                (
                    reply["ok"].clone(),
                    reply["locked"].clone(),
                    reply["generation"].clone()
                ),
                (json!(true), json!(true), json!(generation))
            );
        }
        assert!(h.worker.session.is_none());
        assert_eq!(h.raw(json!({"version":1,"requestId":99,"command":"generate","expectedGeneration":3,"owner":owner()}).to_string())["error"], INVALID);
        assert_eq!(h.raw(json!({"version":1,"requestId":101,"command":"generate","expectedGeneration":3,"owner":owner()}).to_string())["ok"], true);
        let malformed =
            h.raw(json!({"version":1,"requestId":1,"command":"lock","unknown":true}).to_string());
        assert_eq!(malformed["ok"], false);
        assert!(malformed["requestId"].is_null());
        assert_eq!(malformed["locked"], false);
    }

    #[test]
    fn wrong_scope_or_password_never_replaces_the_open_or_closed_state() {
        let mut h = Harness::new();
        let g = h.open();
        let bundle = h.send(json!({"command":"wrap","expectedGeneration":g,"password":PASSWORD}))
            ["bundle"]
            .as_str()
            .unwrap()
            .to_owned();
        // Open session: any further open (even a valid one) is refused and nothing changes.
        for message in [
            json!({"command":"unlock","expectedGeneration":g,"owner":owner(),"bundle":bundle,"password":"Wrong synthetic password!"}),
            json!({"command":"unlock","expectedGeneration":g,"owner":owner(),"bundle":bundle,"password":PASSWORD}),
            json!({"command":"generate","expectedGeneration":g,"owner":owner().replace("11111111", "22222222")}),
        ] {
            assert_eq!(h.send(message)["error"], OPEN);
        }
        let ok = h.send(json!({"command":"encrypt","expectedGeneration":g,"context":context(),"item":item().to_string()}));
        assert_eq!(
            (ok["ok"].clone(), ok["generation"].clone()),
            (json!(true), json!(g))
        );
        let wrong_context = context().replace("\"keyEpoch\":1", "\"keyEpoch\":2");
        assert_eq!(h.send(json!({"command":"encrypt","expectedGeneration":g,"context":wrong_context,"item":item().to_string()}))["error"], INVALID);
        assert_eq!(h.send(json!({"command":"status"}))["locked"], false);
        // Closed session: wrong password or other owner leaves it closed with the same generation.
        let closed = h.send(json!({"command":"lock"}))["generation"]
            .as_u64()
            .unwrap();
        for (owner, password) in [
            (owner(), "Wrong synthetic password!"),
            (owner().replace("11111111", "22222222"), PASSWORD),
        ] {
            let reply = h.send(json!({"command":"unlock","expectedGeneration":closed,"owner":owner,"bundle":bundle,"password":password}));
            assert_eq!(
                (
                    reply["error"].clone(),
                    reply["generation"].clone(),
                    reply["locked"].clone()
                ),
                (json!(INVALID), json!(closed), json!(true))
            );
        }
    }

    #[test]
    fn replies_never_carry_raw_keys_tokens_or_reflected_secrets() {
        let mut h = Harness::new();
        let g = h.open();
        let bundle = h.send(json!({"command":"wrap","expectedGeneration":g,"password":PASSWORD}));
        let text = bundle.to_string();
        assert!(!text.contains(PASSWORD));
        let mut keys: Vec<_> = bundle.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "bundle",
                "generation",
                "identityLocked",
                "locked",
                "ok",
                "requestId",
                "version"
            ]
        );
        // Rejected messages echo neither field names nor values, including secrets.
        let secret = "Reflected-synthetic-secret";
        for raw in [
            format!(
                r#"{{"version":1,"requestId":99,"command":"wrap","expectedGeneration":{g},"password":"{secret}","{secret}":1}}"#
            ),
            format!(
                r#"{{"version":1,"requestId":100,"command":"wrap","expectedGeneration":"{secret}"}}"#
            ),
            format!(r#"{{"version":1,"requestId":101,"command":"{secret}"}}"#),
            format!(r#"{{"version":1,"requestId":102,"command":"status","password":"{secret}"}}"#),
        ] {
            let reply = h.worker.handle(raw);
            assert!(!reply.contains(secret) && reply.contains(r#""ok":false"#));
        }
    }

    #[test]
    fn identity_and_box_lifetimes_account_switch_and_generation_ceiling() {
        let mut h = Harness::new();
        let account =
            json!({"accountId":"11111111-1111-4111-8111-111111111111","identityVersion":1})
                .to_string();
        let g = h.open();
        // Existing owner-first callers may add the matching identity, but a
        // different account cannot replace or attach to the current box.
        let wrong = h.send(json!({"command":"identityGenerate","expectedGeneration":g,
            "accountContext":account.replace("11111111","22222222")}));
        assert_eq!(wrong["error"], INVALID);
        assert_eq!(wrong["generation"], g);
        assert_eq!(wrong["identityLocked"], true);
        let good = h.send(
            json!({"command":"identityGenerate","expectedGeneration":g,"accountContext":account}),
        );
        assert_eq!(good["ok"], true);
        assert_eq!(good["identityLocked"], false);
        assert_eq!(good["locked"], false);
        let mut keys: Vec<_> = good
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "generation",
                "identityLocked",
                "locked",
                "ok",
                "publicIdentity",
                "requestId",
                "version"
            ]
        );
        let public: Value = serde_json::from_str(good["publicIdentity"].as_str().unwrap()).unwrap();
        assert_eq!(public.as_object().unwrap().len(), 4);
        h.worker.generation = MAX_SAFE - 1;
        let lock = h.raw(r#"{"version":1,"requestId":1,"command":"lock"}"#.into());
        assert_eq!(lock["generation"], MAX_SAFE);
        assert!(h.worker.identity.is_none() && h.worker.session.is_none());
        for request in [
            json!({"command":"identityGenerate","expectedGeneration":MAX_SAFE,"accountContext":account}),
            json!({"command":"generate","expectedGeneration":MAX_SAFE,"owner":owner()}),
            json!({"command":"sharedReceiveUnlock","expectedGeneration":MAX_SAFE,"envelope":"{}","trustedSenderPublic":"{}","sharedContext":"{}"}),
        ] {
            assert_eq!(h.send(request)["error"], INVALID);
        }
        let again = h.raw(r#"{"version":1,"requestId":1,"command":"lock"}"#.into());
        assert_eq!(again["generation"], MAX_SAFE);
        assert_eq!(again["identityLocked"], true);
        assert_eq!(again["locked"], true);
    }

    #[test]
    fn identity_nested_bounds_duplicates_and_failed_restore_keep_closed_state() {
        let mut h = Harness::new();
        let account =
            json!({"accountId":"11111111-1111-4111-8111-111111111111","identityVersion":1})
                .to_string();
        for bad in [
            "x".repeat(257),
            account.replace("\"identityVersion\":1", "\"identityVersion\":null"),
            account.replace(
                "\"identityVersion\":1",
                "\"identityVersion\":1,\"identityVersion\":1",
            ),
            account.replace(
                "\"identityVersion\":1",
                "\"identityVersion\":9007199254740992",
            ),
            account.replace(
                "11111111-1111-4111-8111-111111111111",
                "00000000-0000-0000-0000-000000000000",
            ),
        ] {
            let reply = h.send(
                json!({"command":"identityGenerate","expectedGeneration":0,"accountContext":bad}),
            );
            assert_eq!(reply["error"], INVALID);
            assert_eq!(reply["generation"], 0);
            assert!(h.worker.identity.is_none());
        }
        let identity = CloudAccountIdentity::generate(&account).unwrap();
        let public: Value = serde_json::from_str(&identity.public().unwrap()).unwrap();
        let bundle = identity.seal(PASSWORD.into()).unwrap();
        let restore = json!({"command":"identityUnlock","expectedGeneration":0,"accountContext":account,
            "expectedKeyId":public["keyId"],"identitySecret":PASSWORD,"bundle":bundle});
        for (field, value) in [
            ("bundle", json!("x".repeat(2049))),
            ("expectedKeyId", json!("X".repeat(64))),
            ("identitySecret", json!("x".repeat(1025))),
            ("identitySecret", json!("short")),
        ] {
            let mut bad = restore.clone();
            bad[field] = value;
            let reply = h.send(bad);
            assert_eq!(reply["error"], INVALID);
            assert_eq!(reply["generation"], 0);
            assert_eq!(reply["identityLocked"], true);
        }
        assert_eq!(h.send(restore)["ok"], true);
        let g = h.worker.generation;
        let invalid_lock = h.send(json!({"command":"lock","identitySecret":null}));
        assert_eq!(invalid_lock["error"], INVALID);
        assert_eq!(invalid_lock["generation"], g);
        assert_eq!(invalid_lock["identityLocked"], false);
        h.send(json!({"command":"lock"}));
        let stale = h.send(
            json!({"command":"identityGenerate","expectedGeneration":g,"accountContext":account}),
        );
        assert_eq!(stale["error"], STALE);
        assert!(h.worker.identity.is_none() && h.worker.session.is_none());
    }

    #[test]
    fn unknown_fields_wrong_types_replays_and_oversize_are_rejected() {
        let mut h = Harness::new();
        let g = h.open();
        let base = |id: u64, extra: &str| {
            format!(r#"{{"version":1,"requestId":{id},"command":"status"{extra}}}"#)
        };
        for raw in [
            base(50, r#","unknown":1"#),
            base(51, r#","expectedGeneration":1"#),
            r#"{"version":2,"requestId":52,"command":"status"}"#.to_owned(),
            r#"{"version":1,"requestId":0,"command":"status"}"#.to_owned(),
            r#"{"version":1,"requestId":9007199254740992,"command":"status"}"#.to_owned(),
            r#"{"version":1,"requestId":"53","command":"status"}"#.to_owned(),
            r#"{"version":1,"requestId":54,"command":"exportKey"}"#.to_owned(),
            r#"[1]"#.to_owned(),
            String::new(),
            "x".repeat(MAX_MESSAGE + 1),
        ] {
            let reply: Value = h.raw(raw);
            assert_eq!(reply["ok"], false);
        }
        // The raw cases above consumed ids up to 51.
        h.id = 60;
        // Missing or extra command fields.
        assert_eq!(
            h.send(json!({"command":"decrypt","expectedGeneration":g,"context":context()}))["ok"],
            false
        );
        assert_eq!(h.send(json!({"command":"encrypt","expectedGeneration":g,"context":context(),"item":"{}","password":PASSWORD}))["ok"], false);
        // A consumed id can never be replayed, even for status.
        let replay = h.raw(base(h.id, ""));
        assert_eq!(replay["ok"], false);
        let next = h.raw(base(h.id + 1, ""));
        assert_eq!(next["ok"], true);
        // Oversized plaintext is refused by the existing item limit without closing the session.
        let big = json!({"command":"encrypt","expectedGeneration":g,"context":context(),"item":"x".repeat(MAX_BODY + 1)});
        assert_eq!(h.send(big)["ok"], false);
        assert_eq!(h.generation(), g);
    }

    #[test]
    fn fixed_format1_vector_unlocks_through_the_worker() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/format1-vector.json")).unwrap();
        let mut h = Harness::new();
        let reply = h.send(json!({"command":"unlock","expectedGeneration":0,"owner":fixture["owner"].to_string(),"bundle":fixture["bundle"].to_string(),"password":"Synthetic format1 e\u{301} password!"}));
        assert_eq!(reply["ok"], true);
        let reply = h.send(json!({"command":"decrypt","expectedGeneration":1,"context":fixture["context"].to_string(),"envelope":fixture["envelope"].to_string()}));
        assert_eq!(
            serde_json::from_str::<Value>(reply["item"].as_str().unwrap()).unwrap(),
            fixture["item"]
        );
    }

    fn form() -> Value {
        json!({"title":"Original", "category":"LOGIN", "username":"user", "password":"private",
            "url":"https://example.test/primary", "body":"", "notes":"note", "tags":"b, a", "favorite":false})
    }

    fn full_item() -> Value {
        json!({"id":"bbbbbbbbbbbbbbbbbbbbbbbbbb", "version":1,
            "vault":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa","extra":null}, "title":"Original", "category":"LOGIN",
            "fields":[{"label":"password","value":"hidden"},
                {"purpose":"USERNAME","value":"user","custom":{"keep":null}},
                {"purpose":"PASSWORD","value":"private"}, {"label":"notes","value":"note"},
                {"label":"custom","value":null}],
            "urls":[{"href":"https://example.test/secondary","primary":false,"extra":2},
                {"href":"https://example.test/primary","primary":true,"extra":1}],
            "tags":["b","a"], "favorite":null, "attachments":[{"id":"z"},{"id":"a"}],
            "extra":{"custom":[3,null,1]}, "notesPlain":"hidden native body"})
    }

    #[test]
    fn title_only_edit_is_lossless_and_create_owns_identity_scope_and_version() {
        let mut h = Harness::new();
        let g = h.open();
        let mut values = form();
        values["title"] = json!("Changed");
        let mut next: Value = serde_json::from_str(&context()).unwrap();
        next["itemVersion"] = json!(2);
        let edited = h.send(
            json!({"command":"edit","expectedGeneration":g,"context":next.to_string(),
            "item":full_item().to_string(),"values":values.to_string()}),
        );
        assert_eq!(
            (
                edited["ok"].clone(),
                edited["generation"].clone(),
                edited["locked"].clone()
            ),
            (json!(true), json!(g), json!(false))
        );
        let decrypted = h.send(json!({"command":"decrypt","expectedGeneration":g,"context":next.to_string(),"envelope":edited["envelope"]}));
        let mut expected = full_item();
        expected["title"] = json!("Changed");
        expected["version"] = json!(2);
        assert_eq!(
            serde_json::from_str::<Value>(decrypted["item"].as_str().unwrap()).unwrap(),
            expected
        );
        let mut ids = Vec::new();
        for _ in 0..2 {
            let reply = h.send(
                json!({"command":"create","expectedGeneration":g,"values":form().to_string()}),
            );
            assert_eq!(reply["generation"], g);
            assert_eq!(reply["locked"], false);
            let envelope: Value =
                serde_json::from_str(reply["envelope"].as_str().unwrap()).unwrap();
            let ctx = &envelope["context"];
            passshare_core::ConnectId::validate(ctx["itemId"].as_str().unwrap()).unwrap();
            assert_eq!(ctx["passwordBoxId"], "aaaaaaaaaaaaaaaaaaaaaaaaaa");
            assert_eq!(ctx["keyEpoch"], 1);
            assert_eq!(ctx["itemVersion"], 1);
            ids.push(ctx["itemId"].clone());
            let plain = h.send(json!({"command":"decrypt","expectedGeneration":g,"context":ctx.to_string(),"envelope":reply["envelope"]}));
            let body: Value = serde_json::from_str(plain["item"].as_str().unwrap()).unwrap();
            assert_eq!(body["version"], 1);
            assert_eq!(body["fields"][1]["value"], "private");
            assert_eq!(body["urls"][0]["href"], form()["url"]);
        }
        assert_ne!(ids[0], ids[1]);
        // The final safe integer is allowed as a next version, never an old one.
        let mut original = full_item();
        original["version"] = json!(MAX_SAFE - 1);
        next["itemVersion"] = json!(MAX_SAFE);
        assert_eq!(
            h.send(
                json!({"command":"edit","expectedGeneration":g,"context":next.to_string(),
            "item":original.to_string(),"values":form().to_string()})
            )["ok"],
            true
        );
        for category in [
            "PASSWORD",
            "SECURE_NOTE",
            "CREDIT_CARD",
            "IDENTITY",
            "SSH_KEY",
            "CUSTOM",
        ] {
            let mut values = form();
            values["category"] = json!(category);
            values["body"] = json!("Synthetic body");
            let reply = h.send(
                json!({"command":"create","expectedGeneration":g,"values":values.to_string()}),
            );
            assert_eq!(reply["ok"], true);
        }
    }

    #[test]
    fn attachment_parent_mutations_preserve_full_json_order_and_independent_versions() {
        let mut h = Harness::new();
        h.send(json!({"command":"generate","expectedGeneration":0,"owner":owner()}));
        let generation = h.generation();
        let mut original = full_item();
        original["version"] = json!(17);
        original["attachments"] = json!([
            {"attachmentId":"cccccccccccccccccccccccccc","attachmentVersion":17,"keyEpoch":1,"unknown":{"keep":[null,7]}},
            {"attachmentId":"dddddddddddddddddddddddddd","attachmentVersion":3,"keyEpoch":1}
        ]);
        let context = json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":18,"keyEpoch":1});
        for action in ["add", "replace", "remove"] {
            let mut values = json!({"form":form(),"action":action});
            if action != "add" {
                values["attachmentId"] = json!("cccccccccccccccccccccccccc");
            }
            let reply = h.send(json!({"command":"editAttachmentItem","expectedGeneration":generation,
                "item":original.to_string(),"values":values.to_string(),"context":context.to_string()}));
            assert!(reply["ok"] == true);
            let reply = h.send(json!({"command":"decrypt","expectedGeneration":generation,"envelope":reply["envelope"],"context":context.to_string()}));
            let got: Value = serde_json::from_str(reply["item"].as_str().unwrap()).unwrap();
            let mut expected = original.clone();
            expected["version"] = json!(18);
            if action == "add" {
                let added = &got["attachments"][2];
                passshare_core::ConnectId::validate(added["attachmentId"].as_str().unwrap())
                    .unwrap();
                assert!(added["attachmentVersion"] == 1 && added["keyEpoch"] == 1);
                expected["attachments"]
                    .as_array_mut()
                    .unwrap()
                    .push(added.clone());
            } else if action == "replace" {
                expected["attachments"][0]["attachmentVersion"] = json!(18);
            } else {
                expected["attachments"].as_array_mut().unwrap().remove(0);
            }
            assert!(got == expected);
        }
        for (item, values, context) in [
            (
                original.clone(),
                json!({"form":form(),"action":"replace","attachmentId":"eeeeeeeeeeeeeeeeeeeeeeeeee"}),
                context.clone(),
            ),
            (
                original.clone(),
                json!({"form":form(),"action":"add","extra":null}),
                context.clone(),
            ),
            (
                original.clone(),
                json!({"form":form(),"action":"remove","attachmentId":null}),
                context.clone(),
            ),
            (
                original.clone(),
                json!({"form":form(),"action":"add"}),
                json!({"passwordBoxId":"aaaaaaaaaaaaaaaaaaaaaaaaaa","itemId":"bbbbbbbbbbbbbbbbbbbbbbbbbb","itemVersion":17,"keyEpoch":1}),
            ),
        ] {
            let reply = h.send(
                json!({"command":"editAttachmentItem","expectedGeneration":generation,
                "item":item.to_string(),"values":values.to_string(),"context":context.to_string()}),
            );
            assert!(reply["ok"] == false && reply["error"] == INVALID);
            assert!(h.generation() == generation);
        }
        original["attachments"][0]["attachmentVersion"] = json!(MAX_SAFE);
        let values =
            json!({"form":form(),"action":"replace","attachmentId":"cccccccccccccccccccccccccc"});
        assert!(h.send(json!({"command":"editAttachmentItem","expectedGeneration":generation,"item":original.to_string(),"values":values.to_string(),"context":context.to_string()}))["ok"] == false);
        original["attachments"][0]["attachmentVersion"] = json!(17);
        original["attachments"][1] = original["attachments"][0].clone();
        assert!(h.send(json!({"command":"editAttachmentItem","expectedGeneration":generation,"item":original.to_string(),"values":values.to_string(),"context":context.to_string()}))["ok"] == false);
    }

    #[test]
    fn create_edit_reject_invalid_forms_scope_versions_and_exact_fields_without_echo() {
        let mut h = Harness::new();
        let g = h.open();
        let mut next: Value = serde_json::from_str(&context()).unwrap();
        next["itemVersion"] = json!(2);
        let mut bad_forms = vec![Value::Null, json!({}), form()];
        bad_forms[2]["password"] = Value::Null;
        for key in [
            "title", "category", "username", "password", "url", "body", "notes", "tags", "favorite",
        ] {
            let mut values = form();
            values.as_object_mut().unwrap().remove(key);
            bad_forms.push(values);
        }
        for (key, value) in [
            ("title", json!(" ")),
            ("category", json!("bad")),
            ("favorite", Value::Null),
            ("id", json!("do-not-echo")),
            ("version", json!(3)),
            ("vault", json!({"id":"do-not-echo"})),
        ] {
            let mut values = form();
            values[key] = value;
            bad_forms.push(values);
        }
        for values in bad_forms {
            for command in ["create", "edit"] {
                let mut message =
                    json!({"command":command,"expectedGeneration":g,"values":values.to_string()});
                if command == "edit" {
                    message["item"] = json!(full_item().to_string());
                    message["context"] = json!(next.to_string());
                }
                let reply = h.send(message);
                assert_eq!(reply["error"], INVALID);
                assert_eq!(reply["generation"], g);
                assert_eq!(reply["locked"], false);
                assert!(!reply.to_string().contains("do-not-echo"));
                assert!(reply.get("envelope").is_none());
            }
        }
        for (key, value) in [
            ("id", json!("cccccccccccccccccccccccccc")),
            ("version", json!(0)),
            ("version", json!(1.5)),
            ("version", json!(MAX_SAFE)),
            ("version", json!(MAX_SAFE + 1)),
            ("vault", json!({"id":"cccccccccccccccccccccccccc"})),
        ] {
            let mut item = full_item();
            item[key] = value;
            assert_eq!(h.send(json!({"command":"edit","expectedGeneration":g,"context":next.to_string(),"item":item.to_string(),"values":form().to_string()}))["error"],INVALID);
        }
        for (key, value) in [
            ("itemVersion", json!(1)),
            ("itemVersion", json!(3)),
            ("keyEpoch", json!(2)),
            ("passwordBoxId", json!("cccccccccccccccccccccccccc")),
        ] {
            let mut ctx = next.clone();
            ctx[key] = value;
            assert_eq!(h.send(json!({"command":"edit","expectedGeneration":g,"context":ctx.to_string(),"item":full_item().to_string(),"values":form().to_string()}))["error"],INVALID);
        }
        for command in ["create", "edit"] {
            let mut base =
                json!({"command":command,"expectedGeneration":g,"values":form().to_string()});
            if command == "edit" {
                base["context"] = json!(next.to_string());
                base["item"] = json!(full_item().to_string());
            }
            for key in ["owner", "bundle", "envelope", "password", "unknown"] {
                for value in [json!("do-not-echo"), Value::Null] {
                    let mut message = base.clone();
                    message[key] = value;
                    let reply = h.send(message);
                    assert_eq!(reply["error"], INVALID);
                    assert!(!reply.to_string().contains("do-not-echo"));
                }
            }
            for key in if command == "create" {
                vec!["context", "item"]
            } else {
                vec![]
            } {
                let mut message = base.clone();
                message[key] = json!("do-not-echo");
                assert_eq!(h.send(message)["error"], INVALID);
            }
            let mut missing = base.clone();
            missing.as_object_mut().unwrap().remove("values");
            assert_eq!(h.send(missing)["error"], INVALID);
            let mut null = base.clone();
            null["values"] = Value::Null;
            assert_eq!(h.send(null)["error"], INVALID);
            let mut stale = base.clone();
            stale["expectedGeneration"] = json!(g - 1);
            assert_eq!(h.send(stale)["error"], STALE);
            let mut oversized = base;
            oversized["values"] = json!("x".repeat(MAX_BODY + 1));
            assert_eq!(h.send(oversized)["error"], INVALID);
        }
        h.send(json!({"command":"lock"}));
        for command in ["create", "edit"] {
            let mut message =
                json!({"command":command,"expectedGeneration":g+1,"values":form().to_string()});
            if command == "edit" {
                message["context"] = json!(next.to_string());
                message["item"] = json!(full_item().to_string());
            }
            assert_eq!(h.send(message)["error"], LOCKED);
        }
    }
}
