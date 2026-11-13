# Updater public verification vectors

`updater-public-vectors.json` contains a synthetic payload, two disposable public
keys and signatures made with one disposable key using `aead.dev/minisign`.
No private key is retained. These are unrelated to the deployed updater key and
are not Windows Authenticode signatures or executable installers.

`updater_download.rs` uses the lockfile-pinned Tauri updater with MockRuntime and
a bounded loopback HTTP server. It checks online compatibility with unversioned
signatures, strict version rejection, matching signed versions, mismatched
manifest versions, altered bytes and a different verification key. Cached
metadata cannot disable strict validation or replace the runtime key. Every
case must request the manifest and payload exactly once. The server joins on
success and failure. No window, install, extract or restart API is called.

The test name starts with `smoke_`, so the existing Desktop smoke command runs
it. Run it independently with:

```powershell
cargo test --locked -p passshare-desktop --test updater_download
```

The production configuration is unchanged. These tests do not establish that
an old Electron installation can update to Tauri, that a production signing key
or certificate is available, or that installation and retained data work.
