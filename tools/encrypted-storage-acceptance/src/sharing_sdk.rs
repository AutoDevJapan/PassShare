//! Real sharing SDK hooks for the owned Node/PostgreSQL acceptance fixture.
//! Trust inputs come from generated identities and saved client requests, never
//! from fetched public descriptors. All errors suppress response/secret data.
use super::*;
use passshare_connect::{
    InitialGrantRequest, OwnerKeyBundle, RotationGrantRequest, RotationItemRequest,
    RotationStartReply, RotationStatus, SharedKeyExpectation, SharingItemSummary, SharingMember,
    SharingMemberRole, SharingRotationClient, SharingSnapshot,
};

fn expected(a: &Account, recipient: &Account, epoch: u64) -> SharedKeyExpectation {
    SharedKeyExpectation {
        context: shared_context(a, recipient, epoch),
        sender: a.pin.clone(),
        recipient: recipient.pin.clone(),
    }
}

// The existing multi_thread runtime keeps its reactor alive between block_on
// calls. Clone the existing session transport rather than making a mock client.
pub(super) fn initial_replay(
    db: &Database,
    rt: &tokio::runtime::Runtime,
    session: &EncryptedSessionClient,
    a: &Account,
    recipient: &Account,
    original: &Value,
) {
    let pin = expected(a, recipient, 1);
    let request: InitialGrantRequest = checked(
        serde_json::from_value(original.clone()),
        "SDK saved initial grant request",
    );
    let sdk = SharingRotationClient::new(session);
    let before = state_hash(db, true);
    request_slot();
    let reply = checked(
        rt.block_on(sdk.put_initial_grant(&a.box_id, &recipient.id, &request, &pin)),
        "SDK real initial grant replay",
    );
    assert!(reply.envelope == request.envelope);
    assert_eq!(reply.grant_version, 1);
    assert_eq!(reply.key_epoch, 1);
    assert_eq!(
        state_hash(db, true),
        before,
        "SDK initial replay preserves rows/xmin"
    );
}

pub(super) fn self_grant(
    rt: &tokio::runtime::Runtime,
    session: &EncryptedSessionClient,
    a: &Account,
    recipient: &Account,
    epoch: u64,
) -> PasswordBoxKey {
    let pin = expected(a, recipient, epoch);
    let sdk = SharingRotationClient::new(session);
    request_slot();
    let reply = checked(
        rt.block_on(sdk.get_self_grant(&a.box_id, &pin)),
        "SDK real self grant with independent pins",
    );
    assert_eq!(reply.key_epoch, epoch);
    assert_eq!(reply.grant_version, 1);
    checked(
        PasswordBoxKey::unwrap_for_recipient(
            &reply.envelope,
            &recipient.identity,
            &pin.sender,
            &pin.context,
        ),
        "Core authenticated self grant unwrap",
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn snapshot_reads(
    db: &Database,
    rt: &tokio::runtime::Runtime,
    session: &EncryptedSessionClient,
    a: &Account,
    recipients: [&Account; 3],
    rotation: &Rotation,
    old: &PasswordBoxKey,
    items: &BTreeMap<String, Value>,
) {
    let sdk = SharingRotationClient::new(session);
    let saved: SharingSnapshot = checked(
        serde_json::from_value(rotation.snapshot.clone()),
        "SDK saved original snapshot",
    );
    assert!(saved.owner_account_id == a.id);
    assert_eq!(saved.key_epoch, 1);
    let before = state_hash(db, true);
    request_slot();
    let fetched = checked(
        rt.block_on(sdk.sharing_snapshot(&a.box_id, &a.id)),
        "SDK real sharing snapshot",
    );
    assert!(
        fetched == saved,
        "SDK snapshot equals original pinned revision"
    );

    // Formal confirmations and initial grants are already proved by the parent.
    // Build the exact expected public member DTOs from those known actions.
    let mut expected_members = vec![SharingMember {
        account_id: a.id.clone(),
        role: SharingMemberRole::Owner,
        membership_confirmed: true,
        key_granted: false,
    }];
    for (index, recipient) in recipients.iter().enumerate() {
        expected_members.push(SharingMember {
            account_id: recipient.id.clone(),
            role: SharingMemberRole::Member,
            membership_confirmed: true,
            key_granted: index < 2,
        });
    }
    expected_members.sort_by(|l, r| l.account_id.cmp(&r.account_id));
    let mut members = Vec::new();
    let mut after = None::<String>;
    loop {
        request_slot();
        let page = checked(
            rt.block_on(sdk.snapshot_members(&a.box_id, &saved, after.as_deref())),
            "SDK real pinned member page",
        );
        assert_eq!(page.state_revision, saved.state_revision);
        members.extend(page.members);
        match page.next_cursor {
            None => break,
            Some(next) => {
                assert!(after.as_ref().is_none_or(|previous| &next > previous));
                after = Some(next);
            }
        }
        assert!(
            members.len() <= expected_members.len(),
            "bounded SDK member pagination"
        );
    }
    checked(
        saved.validate_complete_members(&members),
        "SDK complete members",
    );
    assert!(
        members == expected_members,
        "SDK full public member DTO equality"
    );

    // Item IDs, versions and contexts are held outside every SDK response.
    let expected_items: Vec<SharingItemSummary> = items
        .iter()
        .map(|(id, dto)| SharingItemSummary {
            item_id: checked(id.parse(), "SDK independently held item ID"),
            item_version: number(dto, "version"),
            key_epoch: 1,
        })
        .collect();
    let mut summaries = Vec::new();
    let mut after = None::<String>;
    let mut pages = 0;
    loop {
        request_slot();
        let page = checked(
            rt.block_on(sdk.snapshot_items(&a.box_id, &saved, after.as_deref())),
            "SDK real pinned item page",
        );
        assert_eq!(page.state_revision, saved.state_revision);
        summaries.extend(page.items);
        pages += 1;
        match page.next_cursor {
            None => break,
            Some(next) => {
                let next = next.to_string();
                assert!(after.as_ref().is_none_or(|previous| &next > previous));
                after = Some(next);
            }
        }
        assert!(
            pages < 10 && summaries.len() <= items.len(),
            "bounded SDK item pagination"
        );
    }
    checked(
        saved.validate_complete_items(&summaries),
        "SDK complete items",
    );
    assert!(
        pages >= 2 && summaries == expected_items,
        "SDK exact pinned metadata set"
    );
    for item in &expected_items {
        request_slot();
        let envelope = checked(
            rt.block_on(sdk.snapshot_item(&a.box_id, &saved, item)),
            "SDK real pinned item envelope",
        );
        let plaintext = checked(
            old.decrypt_item(
                &envelope,
                &context(a, item.item_id.as_str(), item.item_version, 1),
            ),
            "Core SDK snapshot full DTO decrypt",
        );
        assert!(
            items.get(item.item_id.as_str()) == Some(&plaintext),
            "SDK whole DTO equality"
        );
    }
    assert_eq!(
        state_hash(db, true),
        before,
        "SDK pinned reads preserve whole DB"
    );
}

pub(super) fn start_replay(
    db: &Database,
    rt: &tokio::runtime::Runtime,
    session: &EncryptedSessionClient,
    rotation: &Rotation,
) {
    let sdk = SharingRotationClient::new(session);
    let bundle: OwnerKeyBundle = checked(
        serde_json::from_value(rotation.header["bundle"].clone()),
        "SDK original typed owner bundle",
    );
    let before = state_hash(db, true);
    request_slot();
    let reply = checked(
        rt.block_on(sdk.start_rotation(&rotation.sdk_expectation, &bundle)),
        "SDK real immutable rotation start replay",
    );
    assert!(matches!(reply, RotationStartReply::Pending { operation_id }
        if operation_id == rotation.sdk_expectation.operation_id));
    assert_eq!(
        state_hash(db, true),
        before,
        "SDK start replay preserves rows/xmin"
    );
}

pub(super) fn item_replay(
    db: &Database,
    rt: &tokio::runtime::Runtime,
    session: &EncryptedSessionClient,
    rotation: &Rotation,
    candidate: &Candidate,
) {
    let sdk = SharingRotationClient::new(session);
    let request = RotationItemRequest {
        expected_version: candidate.previous,
        envelope: candidate.envelope.clone(),
    };
    let before = state_hash(db, true);
    request_slot();
    checked(
        rt.block_on(sdk.stage_item(&rotation.sdk_expectation, &request)),
        "SDK real identical staged item replay",
    );
    assert_eq!(
        state_hash(db, true),
        before,
        "SDK item replay preserves counters/rows/xmin"
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn grant_replay(
    db: &Database,
    rt: &tokio::runtime::Runtime,
    session: &EncryptedSessionClient,
    a: &Account,
    c: &Account,
    rotation: &Rotation,
    original: &Value,
) {
    let sdk = SharingRotationClient::new(session);
    let pin = expected(a, c, 2);
    let request = RotationGrantRequest {
        envelope: checked(
            serde_json::from_value(original.clone()),
            "SDK original stage grant",
        ),
    };
    let before = state_hash(db, true);
    request_slot();
    checked(
        rt.block_on(sdk.stage_grant(&rotation.sdk_expectation, &request, &pin)),
        "SDK real identical staged grant replay",
    );
    assert_eq!(
        state_hash(db, true),
        before,
        "SDK grant replay preserves counters/rows/xmin"
    );
}

pub(super) fn pending_status(
    db: &Database,
    rt: &tokio::runtime::Runtime,
    session: &EncryptedSessionClient,
    rotation: &Rotation,
) {
    let sdk = SharingRotationClient::new(session);
    let before = state_hash(db, true);
    request_slot();
    let reply = checked(
        rt.block_on(sdk.rotation_status(&rotation.sdk_expectation)),
        "SDK real pending rotation status",
    );
    assert_eq!(reply.status, RotationStatus::Pending);
    assert_eq!(reply.item_count, rotation.candidates.len() as u64);
    assert_eq!(reply.grant_count, 1);
    assert!(reply.result.is_none() && reply.staged_bytes > 0);
    assert_eq!(
        state_hash(db, true),
        before,
        "SDK pending status preserves rows/xmin"
    );
}

pub(super) fn abort_pending(
    db: &Database,
    rt: &tokio::runtime::Runtime,
    session: &EncryptedSessionClient,
    rotation: &Rotation,
) {
    let sdk = SharingRotationClient::new(session);
    let before = state_hash(db, false);
    let op = &rotation.sdk_expectation.operation_id;
    assert_eq!(db.sql(&format!("SELECT count(*) FROM encrypted_rotations WHERE operation_id='{op}' AND status='pending'")), "1");
    request_slot();
    checked(
        rt.block_on(sdk.abort_rotation(&rotation.sdk_expectation)),
        "SDK real prepared pending abort",
    );
    assert_eq!(db.sql(&format!("SELECT (SELECT count(*) FROM encrypted_rotations WHERE operation_id='{op}')+(SELECT count(*) FROM encrypted_rotation_items WHERE operation_id='{op}')+(SELECT count(*) FROM encrypted_rotation_grants WHERE operation_id='{op}')")), "0", "SDK abort removes operation and all stages");
    assert_eq!(
        state_hash(db, false),
        before,
        "SDK abort preserves every business row/xmin"
    );
}

pub(super) fn committed_status(
    db: &Database,
    rt: &tokio::runtime::Runtime,
    session: &EncryptedSessionClient,
    rotation: &Rotation,
    result: &Value,
) {
    let sdk = SharingRotationClient::new(session);
    let before = state_hash(db, true);
    request_slot();
    let reply = checked(
        rt.block_on(sdk.rotation_status(&rotation.sdk_expectation)),
        "SDK real immediately committed status",
    );
    assert_eq!(reply.status, RotationStatus::Committed);
    let stored = reply.result.expect("SDK committed result present");
    assert!(
        json!(stored) == *result,
        "SDK status equals recorded commit result"
    );
    assert_eq!(reply.staged_bytes, 0);
    assert_eq!(
        state_hash(db, true),
        before,
        "SDK committed status preserves rows/xmin"
    );
}

pub(super) fn committed_replay(
    db: &Database,
    rt: &tokio::runtime::Runtime,
    session: &EncryptedSessionClient,
    a: &Account,
    rotation: &Rotation,
    result: &Value,
) -> Value {
    let sdk = SharingRotationClient::new(session);
    let before = state_hash(db, true);
    request_slot();
    let reply = checked(
        rt.block_on(sdk.commit_rotation(&rotation.sdk_expectation, &a.login_password)),
        "SDK real reauthenticated historical commit replay",
    );
    let reply = json!(reply);
    assert!(
        reply == *result,
        "SDK commit equals recorded immutable result"
    );
    assert_eq!(
        state_hash(db, true),
        before,
        "SDK commit replay preserves whole DB/xmin"
    );
    reply
}
