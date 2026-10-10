# Encrypted item preparation in the cloud Worker

This specification covers client-only item preparation. It adds no UI, HTTP,
storage, retry, assets, boot changes, key export, crypto or KDF changes.

## Version 1 protocol

Every request includes `version: 1`, a positive safe-integer `requestId`, and
`command`. The additional fields below are exhaustive. Missing, extra, unknown,
wrong-type and explicitly null fields are rejected.

| Command | Additional fields | Successful payload |
| --- | --- | --- |
| create | expectedGeneration, values | envelope (JSON string) |
| edit | expectedGeneration, context, item, values | envelope (JSON string) |

`values` is a JSON string containing the complete shared ItemForm: string fields
`title`, `category`, `username`, `password`, `url`, `body`, `notes`, `tags`, and
boolean `favorite`. Caller identity, version, password box and readonly metadata
are prohibited. Title must be nonempty after trimming. Category is one of LOGIN,
PASSWORD, SECURE_NOTE, CREDIT_CARD, IDENTITY, SSH_KEY, CUSTOM; edits retain category.

`item` is the complete original JSON DTO, never a display projection.
`context` is a JSON string with exactly `passwordBoxId`, `itemId`, `itemVersion`,
`keyEpoch`. The held session binds password box and epoch. Edit requires matching
original identity, integer original version in 1..9007199254740991 (exclusive
upper bound), next version exactly old + 1, and a matching original vault.id when
present. Core validates context and encrypted payload as before.

Creation generates a random Core ConnectId and context version 1 using the held
password box and key epoch. Its seed contains only id, version, vault.id, title,
category, empty fields/urls/tags, and favorite false. The shared native edit helper
fills the seed. Editing uses that same helper and changes only version afterward.
Unknown/custom properties, attachments, hidden credentials, array order, and
optional nulls survive when not changed by the submitted form.

Success keeps generation unchanged and locked false. Validation/crypto failures
use generic PS051 without reflecting input, and retain the session. Closed
sessions return PS057; stale generations return PS058. Existing open/lock,
request ordering, Encrypt/Decrypt and bundle behavior remain in effect.

## Bridge

`frontend/src/lib/cloud-worker.ts` exports ItemContext and these methods:

- createItem(valuesJSON): Promise<string> (envelope JSON)
- editItem(originalFullJSON, valuesJSON, nextItemContext): Promise<string> (envelope JSON)
- encrypt(itemJSON, ItemContext): Promise<string> (envelope JSON)
- decrypt(envelopeJSON, ItemContext): Promise<string> (full item JSON)

Replies are checked for field types, command payload, scope generation/lock
state, and bounds. Body input/output is at most 1 MiB, envelopes 1,500,000 bytes,
and the escaped message limit stays 6 MiB + 4096 bytes. Core's body bound remains
1 MiB. The caller retains a successful envelope for retries; it resends the same
prepared ciphertext rather than issuing another create or edit preparation.

Owned Rust input strings and parsed plaintext guards use the existing zeroize
pattern. Bridge-owned values/item/password fields are cleared in finally.
JavaScript strings and serde/helper transient allocations cannot be promised a
memory-wide wipe. Errors do not include plaintext, and no raw secret logging is
added.

## Source provenance and verification

The private WASM module references `backend/native/src/edit.rs` directly through
`#[path = "../../../backend/native/src/edit.rs"]`; there is no copy or dependency
change. **Parent integration must add backend/native/src/edit.rs to WASM source
fingerprinting**, because it is a new external WASM build input. This job does not
change generated asset provenance or publish assets.

Worker tests cover lossless full-DTO title edits, random creation identity/scope,
form validation, exact fields, context/version limits, locking and stale state.
The wasm-bindgen Node test invokes exported start_worker with a minimal Node
worker message-surface fixture and exercises real WASM create/edit/decrypt plus
wrong password and generic errors. Existing native helper tests are also compiled
by the direct module reference. These tests were added but not run in this job.
