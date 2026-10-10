//! Real Go session SDK interoperability. Infrastructure and Core fixtures are
//! private helpers in the parent module; this module adds no service or crypto.
use super::*;
use passshare_connect::{OwnerKeyBundle, OwnerKeyRecord};
use passshare_core::cloud_crypto::EncryptedItem;
use std::{ffi::OsString, path::Path, sync::mpsc, time::Instant};

const INPUT_LIMIT: usize = 128 * 1024;
const OUTPUT_LIMIT: usize = 256 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;
const RESULT_PREFIX: &[u8] = b"PASSSHARE_GO_RESULT=";

// Leave Mode::parse and every legacy argument/test unchanged. Only the new
// prefix is consumed, and paths are never interpreted as shell commands.
pub(super) fn cli(args: &[OsString]) -> Result<(Option<PathBuf>, &[OsString]), &'static str> {
    if args.first().is_none_or(|arg| arg != "--go-session") {
        return Ok((None, args));
    }
    let executable = args
        .get(1)
        .ok_or("missing precompiled Go test executable")?;
    if executable.is_empty() || executable.to_string_lossy().starts_with('-') {
        return Err("Go test executable must be a non-option path");
    }
    let executable = PathBuf::from(executable)
        .canonicalize()
        .map_err(|_| "Go test executable must exist")?;
    if !executable.is_file() {
        return Err("Go test executable must be a file");
    }
    Ok((Some(executable), &args[2..]))
}

// Never format an underlying error or an assertion operand: either may carry
// a session, login password, decrypted DTO or a remote response.
fn checked<T, E>(result: Result<T, E>, step: &str) -> T {
    result.unwrap_or_else(|_| panic!("Go session acceptance: {step} failed (details suppressed)"))
}

enum Phase {
    Roundtrip,
    Denied,
}
struct Auxiliary<'a> {
    session: &'a str,
    owner: &'a OwnerKeyContext,
    bundle: &'a OwnerKeyBundle,
}
struct Denial<'a> {
    status: u16,
    code: &'static str,
    caller_bundle: &'a OwnerKeyBundle,
}
struct Fixture<'a> {
    phase: Phase,
    host: String,
    session: &'a str,
    owner: &'a OwnerKeyContext,
    bundle1: &'a OwnerKeyBundle,
    bundle2: &'a OwnerKeyBundle,
    login_password: &'a str,
    context1: &'a ItemContext,
    context2: &'a ItemContext,
    envelope1: &'a EncryptedItem,
    envelope2: &'a EncryptedItem,
    live_context: &'a ItemContext,
    live_envelope: &'a EncryptedItem,
    auxiliary: Option<Auxiliary<'a>>,
    denial: Option<Denial<'a>>,
}
impl Fixture<'_> {
    fn json(&self) -> Value {
        json!({
            "phase": match self.phase { Phase::Roundtrip => "roundtrip", Phase::Denied => "denied" },
            "host": self.host, "session": self.session, "boxOwnerCtx": self.owner,
            "bundle1": self.bundle1, "bundle2": self.bundle2,
            "syntheticLoginPassword": self.login_password,
            "context1": self.context1, "context2": self.context2,
            "envelope1": self.envelope1, "envelope2": self.envelope2,
            "liveContext": self.live_context, "liveEnvelope": self.live_envelope,
            "auxiliary": self.auxiliary.as_ref().map(|aux| json!({
                "session":aux.session,"boxOwnerCtx":aux.owner,"bundle":aux.bundle
            })),
            "denial": self.denial.as_ref().map(|denial| json!({
                "status":denial.status,"code":denial.code,"callerBundle":denial.caller_bundle
            }))
        })
    }
}

struct PublicResult {
    items: Vec<EncryptedItem>,
    owner_keys: Vec<OwnerKeyRecord>,
}

pub(super) fn run(db: &Database, network: &Network, mode: &Mode, executable: &Path) {
    let host = Host::start(db, network, mode);
    let (session, _, box_id, login_password) = signup_with_password(host.port);
    let (stranger_session, _, stranger_box, _) = signup_with_password(host.port);
    let (aux_session, _, aux_box, _) = signup_with_password(host.port);
    let owner_id = lookup_owner(db, &box_id);
    let stranger_id = lookup_owner(db, &stranger_box);
    let aux_id = lookup_owner(db, &aux_box);
    let owner = owner_context(&box_id, &owner_id, 1);
    let aux_owner = owner_context(&aux_box, &aux_id, 1);
    let stranger_owner = owner_context(&box_id, &stranger_id, 1);
    let key = checked(PasswordBoxKey::generate(), "Core box key");
    let salt = checked(generate_salt(), "Core owner salt");
    let owner_password = format!(
        "synthetic-encryption-password-{}",
        checked(ConnectId::generate(), "synthetic ID")
    );
    let master = checked(owner_master(&owner_password, &salt), "Core owner master");
    let bundle1: OwnerKeyBundle = checked(
        serde_json::from_value(owner_bundle(&key, &master, salt, &owner)),
        "first Core bundle",
    );
    let bundle2: OwnerKeyBundle = checked(
        serde_json::from_value(owner_bundle(&key, &master, salt, &owner)),
        "second Core bundle",
    );
    assert!(bundle1 != bundle2, "independent owner wraps must differ");
    let aux_bundle: OwnerKeyBundle = checked(
        serde_json::from_value(owner_bundle(&key, &master, salt, &aux_owner)),
        "auxiliary Core bundle",
    );
    // Owner PUT/setup planners bind their public bundle to the actual caller
    // before SQL authorization. A real stranger's own context reaches 403;
    // falsely claiming the owner's context would only exercise a 400 planner.
    let stranger_bundle: OwnerKeyBundle = checked(
        serde_json::from_value(owner_bundle(&key, &master, salt, &stranger_owner)),
        "stranger Core bundle",
    );
    let context1 = ItemContext {
        password_box_id: checked(box_id.parse(), "box ID"),
        item_id: checked(ConnectId::generate(), "item ID"),
        item_version: 1,
        key_epoch: 1,
    };
    let context2 = ItemContext {
        item_version: 2,
        ..context1.clone()
    };
    let live_context = ItemContext {
        item_id: checked(ConnectId::generate(), "live item ID"),
        ..context1.clone()
    };
    let sentinel = format!(
        "synthetic-private-{}",
        checked(ConnectId::generate(), "plaintext sentinel")
    );
    let dto1 = full_dto(&context1, &sentinel);
    let dto2 = full_dto(&context2, &sentinel);
    let live_dto = full_dto(&live_context, &sentinel);
    assert!(dto1 != dto2, "full DTO revisions must differ");
    let envelope1 = checked(key.encrypt_item(&dto1, &context1), "first Core encryption");
    let envelope2 = checked(key.encrypt_item(&dto2, &context2), "second Core encryption");
    let live_envelope = checked(
        key.encrypt_item(&live_dto, &live_context),
        "live Core encryption",
    );
    let mut fixture = Fixture {
        phase: Phase::Roundtrip,
        host: format!("http://127.0.0.1:{}", host.port),
        session: &session,
        owner: &owner,
        bundle1: &bundle1,
        bundle2: &bundle2,
        login_password: &login_password,
        context1: &context1,
        context2: &context2,
        envelope1: &envelope1,
        envelope2: &envelope2,
        live_context: &live_context,
        live_envelope: &live_envelope,
        auxiliary: Some(Auxiliary {
            session: &aux_session,
            owner: &aux_owner,
            bundle: &aux_bundle,
        }),
        denial: None,
    };
    let observed = invoke(executable, &fixture);
    assert!(
        observed.items.len() == 3 && observed.owner_keys.len() == 3,
        "public roundtrip result cardinality"
    );
    for (got, expected_envelope, context, dto) in [
        (&observed.items[0], &envelope1, &context1, &dto1),
        (&observed.items[1], &envelope2, &context2, &dto2),
        (&observed.items[2], &live_envelope, &live_context, &live_dto),
    ] {
        assert!(got == expected_envelope, "observed ciphertext equality");
        let decrypted = checked(key.decrypt_item(got, context), "Core observed item decrypt");
        assert!(&decrypted == dto, "full DTO equality (details suppressed)");
    }
    for (record, bundle, expected_owner, version) in [
        (&observed.owner_keys[0], &bundle1, &owner, 1),
        (&observed.owner_keys[1], &bundle2, &owner, 2),
        (&observed.owner_keys[2], &aux_bundle, &aux_owner, 1),
    ] {
        assert!(
            record.bundle_version == version && &record.bundle == bundle,
            "observed owner record equality"
        );
        // Use the original master and independently held owner context, never
        // an expected context or salt reconstructed from the received headers.
        let recovered = checked(
            PasswordBoxKey::unwrap_for_owner(&record.bundle.wrapped, &master, expected_owner),
            "Core received owner key unwrap",
        );
        for (got, context, dto) in [
            (&observed.items[0], &context1, &dto1),
            (&observed.items[1], &context2, &dto2),
            (&observed.items[2], &live_context, &live_dto),
        ] {
            let decrypted = checked(
                recovered.decrypt_item(got, context),
                "received key full DTO decrypt",
            );
            assert!(
                &decrypted == dto,
                "received key full DTO equality (details suppressed)"
            );
        }
    }
    let snapshot = storage_snapshot(db, &box_id, &aux_box);
    verify_storage(&snapshot, &fixture, &aux_bundle, &sentinel);
    fixture.phase = Phase::Denied;
    fixture.session = &stranger_session;
    fixture.login_password = "";
    fixture.auxiliary = None;
    fixture.denial = Some(Denial {
        status: 403,
        code: "PS016",
        caller_bundle: &stranger_bundle,
    });
    assert_denied_result(invoke(executable, &fixture));
    assert!(
        storage_snapshot(db, &box_id, &aux_box) == snapshot,
        "stranger denial preserves stored bytes"
    );
    // Commit revocation in this isolated fixture DB, not a rollback or a fake
    // bearer. The next process recreates the Go client with the SAME token.
    assert!(
        db.sql(&format!(
            "SELECT count(*) FROM sessions WHERE user_id='{owner_id}'"
        )) == "1",
        "one original signed-up session"
    );
    db.sql(&format!("DELETE FROM sessions WHERE user_id='{owner_id}'"));
    assert!(
        db.sql(&format!(
            "SELECT count(*) FROM sessions WHERE user_id='{owner_id}'"
        )) == "0",
        "session revocation committed"
    );
    fixture.session = &session;
    fixture.denial = Some(Denial {
        status: 401,
        code: "PS024",
        caller_bundle: &bundle1,
    });
    assert_denied_result(invoke(executable, &fixture));
    assert!(
        storage_snapshot(db, &box_id, &aux_box) == snapshot,
        "revocation preserves live item, tombstone and owner records"
    );
    println!("Go session acceptance: Core full DTO roundtrip, exact replay, owner reauthentication, deletion, scope and committed session revocation passed");
}

fn lookup_owner(db: &Database, box_id: &str) -> String {
    db.sql(&format!(
        "SELECT user_id::text FROM vault_memberships WHERE vault_id='{box_id}' AND role='owner'"
    ))
}

fn full_dto(context: &ItemContext, sentinel: &str) -> Value {
    let revision = context.item_version;
    json!({
        "id":context.item_id,"version":revision,"vault":{"id":context.password_box_id},
        "category":"LOGIN","title":format!("{sentinel}-title-{revision}"),
        "notesPlain":format!("{sentinel}-notes-{revision}"),
        "tags":[format!("{sentinel}-tag"),"synthetic"],
        "urls":[{"label":format!("{sentinel}-url"),"href":"https://example.test/login","primary":true}],
        "fields":[
            {"id":"username","type":"STRING","purpose":"USERNAME","value":format!("{sentinel}-user-{revision}")},
            {"id":"password","type":"CONCEALED","purpose":"PASSWORD","value":format!("{sentinel}-secret-{revision}")},
            {"id":"custom","type":"STRING","section":{"id":"section-one"},"value":format!("{sentinel}-custom-{revision}")}
        ],
        "sections":[{"id":"section-one","label":format!("{sentinel}-section-{revision}"),
            "unknown":{"values":[null,true,revision,{"nested":["retained",false]}]}}],
        "attachments":[{"id":"synthetic-attachment","name":format!("{sentinel}-file-{revision}.bin"),
            "size":3,"contentType":"application/octet-stream","unknown":{"checks":[1,2,3]}}],
        "opaque":{"marker":format!("{sentinel}-opaque-{revision}"),
            "arrays":[[],[null,false,revision,{"unicode":"日本語 — preserved"}]],
            "object":{"empty":{},"optional":null,"flag":true}}
    })
}

fn storage_snapshot(db: &Database, box_id: &str, aux_box: &str) -> Value {
    checked(serde_json::from_str(&db.sql(&format!(
        "SELECT jsonb_build_object(\
        'items',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY box_id,item_id) FROM encrypted_items i WHERE box_id IN ('{box_id}','{aux_box}')),'[]'::jsonb),\
        'tombstones',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY box_id,item_id) FROM encrypted_item_tombstones t WHERE box_id IN ('{box_id}','{aux_box}')),'[]'::jsonb),\
        'ownerKeys',COALESCE((SELECT jsonb_agg(to_jsonb(k) ORDER BY box_id,owner_id) FROM encrypted_owner_keys k WHERE box_id IN ('{box_id}','{aux_box}')),'[]'::jsonb),\
        'states',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY box_id) FROM encrypted_box_state s WHERE box_id IN ('{box_id}','{aux_box}')),'[]'::jsonb),\
        'plaintextItems',(SELECT count(*) FROM connect_items WHERE vault_id IN ('{box_id}','{aux_box}')))::text"
    ))), "public DB snapshot decode")
}

fn verify_storage(
    snapshot: &Value,
    fixture: &Fixture<'_>,
    aux_bundle: &OwnerKeyBundle,
    sentinel: &str,
) {
    assert!(
        !snapshot.to_string().contains(sentinel),
        "no full DTO plaintext in storage"
    );
    assert!(
        snapshot["plaintextItems"] == 0,
        "no compatibility plaintext rows"
    );
    let items = snapshot["items"]
        .as_array()
        .unwrap_or_else(|| panic!("DB item shape"));
    assert!(items.len() == 1, "only the preservation item remains live");
    assert!(
        items[0]["item_id"] == fixture.live_context.item_id.as_str()
            && items[0]["box_id"] == fixture.owner.password_box_id.as_str()
            && items[0]["revision"] == 1
            && items[0]["key_epoch"] == 1
            && items[0]["envelope"] == json!(fixture.live_envelope),
        "live ciphertext and metadata"
    );
    let tombstones = snapshot["tombstones"]
        .as_array()
        .unwrap_or_else(|| panic!("DB tombstone shape"));
    assert!(
        tombstones
            == &vec![json!({
                "box_id":fixture.owner.password_box_id,"item_id":fixture.context1.item_id,
                "last_live_version":2,"key_epoch":1
            })],
        "zero deleted live rows, one exact metadata-only tombstone"
    );
    let owners = snapshot["ownerKeys"]
        .as_array()
        .unwrap_or_else(|| panic!("DB owner shape"));
    assert!(owners.len() == 2, "two actual owner records");
    for (expected, version) in [(fixture.bundle2, 2), (aux_bundle, 1)] {
        let matching: Vec<_> = owners
            .iter()
            .filter(|row| row["box_id"] == expected.wrapped.context.password_box_id.as_str())
            .collect();
        assert!(matching.len() == 1, "one owner record per fixture box");
        let row = matching[0];
        assert!(
            row["owner_id"] == expected.wrapped.context.owner_account_id.to_string()
                && row["revision"] == version
                && row["key_epoch"] == 1
                && row["bundle"] == json!(expected),
            "owner record version and ciphertext"
        );
    }
    let states = snapshot["states"]
        .as_array()
        .unwrap_or_else(|| panic!("DB state shape"));
    assert!(
        states.len() == 2 && states.iter().all(|state| state["key_epoch"] == 1),
        "active epoch remains one"
    );
}

fn assert_denied_result(result: PublicResult) {
    assert!(
        result.items.is_empty() && result.owner_keys.is_empty(),
        "denied calls return no ciphertext or owner bundle"
    );
}

// An owned direct child is killed/reaped on every exit, including input/output
// failure and panic. There is no shell, command string or indefinite wait.
struct GoChild(Child);
impl Drop for GoChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        if !reap_before(&mut self.0, Instant::now() + Duration::from_secs(2)) {
            CLEANUP_FAILED.store(true, Ordering::SeqCst);
        }
    }
}
enum PipeEvent {
    Input(bool),
    Output(Result<Vec<u8>, ()>),
    Error(bool),
}

// The parent currently has no collect_output/ReaderPump helper. These pumps
// bound bytes AND completion through a deadline channel. Stderr is discarded;
// stdout retains only a single public result line, never test/panic diagnostics.
fn public_output(mut pipe: impl Read) -> Result<Vec<u8>, ()> {
    let mut total = 0usize;
    let mut prefix = 0usize;
    let mut discard_line = false;
    let mut line = Vec::new();
    let mut result = None;
    let mut buffer = [0u8; 4096];
    loop {
        let n = pipe.read(&mut buffer).map_err(|_| ())?;
        if n == 0 {
            break;
        }
        total += n;
        if total > OUTPUT_LIMIT {
            buffer.fill(0);
            return Err(());
        }
        for &byte in &buffer[..n] {
            if byte == b'\n' {
                if !discard_line && prefix == RESULT_PREFIX.len() {
                    if result.is_some() {
                        return Err(());
                    }
                    result = Some(std::mem::take(&mut line));
                }
                prefix = 0;
                discard_line = false;
                continue;
            }
            if discard_line {
                continue;
            }
            if prefix < RESULT_PREFIX.len() {
                if byte == RESULT_PREFIX[prefix] {
                    prefix += 1;
                } else {
                    discard_line = true;
                }
            } else {
                line.push(byte);
            }
        }
        buffer.fill(0);
    }
    // A marker must be newline-terminated and unique, even at EOF.
    if !discard_line && prefix != 0 {
        return Err(());
    }
    result.ok_or(())
}

fn discard_output(mut pipe: impl Read) -> bool {
    let mut total = 0usize;
    let mut buffer = [0u8; 4096];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => return true,
            Ok(n) => {
                total += n;
                buffer.fill(0);
                if total > STDERR_LIMIT {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
}

fn invoke(executable: &Path, fixture: &Fixture<'_>) -> PublicResult {
    let mut input = checked(serde_json::to_vec(&fixture.json()), "fixture encode");
    assert!(input.len() <= INPUT_LIMIT, "Go fixture input bound");
    let deadline = Instant::now() + Duration::from_secs(35);
    let mut cmd = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.env_clear();
    for name in ["PATH", "SystemRoot", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            cmd.env(name, value);
        }
    }
    let mut child = GoChild(checked(
        cmd.args(["-test.run=^TestEncryptedSessionFormal$", "-test.v"])
            .env("PASSSHARE_GO_SESSION_FORMAL", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn(),
        "direct precompiled Go test spawn",
    ));
    let mut stdin = child
        .0
        .stdin
        .take()
        .unwrap_or_else(|| panic!("Go stdin unavailable"));
    let stdout = child
        .0
        .stdout
        .take()
        .unwrap_or_else(|| panic!("Go stdout unavailable"));
    let stderr = child
        .0
        .stderr
        .take()
        .unwrap_or_else(|| panic!("Go stderr unavailable"));
    let (sender, receiver) = mpsc::channel();
    let input_sender = sender.clone();
    thread::spawn(move || {
        let ok = stdin.write_all(&input).is_ok();
        input.fill(0);
        drop(stdin); // ONE JSON fixture followed by EOF.
        let _ = input_sender.send(PipeEvent::Input(ok));
    });
    let output_sender = sender.clone();
    thread::spawn(move || {
        let _ = output_sender.send(PipeEvent::Output(public_output(stdout)));
    });
    thread::spawn(move || {
        let _ = sender.send(PipeEvent::Error(discard_output(stderr)));
    });
    let mut status = None;
    let mut events = 0;
    let mut output = None;
    while status.is_none() || events < 3 {
        assert!(
            Instant::now() < deadline,
            "Go session child or output exceeded deadline (details suppressed)"
        );
        if status.is_none() {
            status = checked(child.0.try_wait(), "Go child status");
        }
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(event) => {
                events += 1;
                match event {
                    PipeEvent::Input(ok) => {
                        assert!(ok, "Go fixture input failed (details suppressed)")
                    }
                    PipeEvent::Error(ok) => {
                        assert!(ok, "Go stderr read/bound failed (details suppressed)")
                    }
                    PipeEvent::Output(result) => {
                        output = Some(checked(result, "bounded public result read"))
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) if events == 3 => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(_) => panic!("Go pipe completion failed (details suppressed)"),
        }
    }
    assert!(
        status.is_some_and(|status| status.success()),
        "Go formal test failed (diagnostics suppressed)"
    );
    let output = output.unwrap_or_else(|| panic!("Go result marker missing"));
    let value: Value = checked(serde_json::from_slice(&output), "public result JSON");
    let object = value
        .as_object()
        .unwrap_or_else(|| panic!("Go public result object required"));
    assert!(
        object.len() == 2 && object.contains_key("items") && object.contains_key("ownerKeys"),
        "Go public result shape"
    );
    PublicResult {
        items: checked(
            serde_json::from_value(value["items"].clone()),
            "public item result shape",
        ),
        owner_keys: checked(
            serde_json::from_value(value["ownerKeys"].clone()),
            "public owner result shape",
        ),
    }
}
