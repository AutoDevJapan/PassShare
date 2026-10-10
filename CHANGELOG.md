# Changelog

All notable changes to PassShare are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Recovery-enabled `.pbox` files and Desktop emergency-kit recovery with explicit new-password saving; existing v1 files upgrade only after authenticated opt-in.
- Desktop recovery cancellation guards and real native-form acceptance for content preservation and old-password rejection.

- Web documentation hub (`/docs`) with user guide, extension install, FAQ, terms, and privacy pages
- Legal documents (draft) with footer links and legal review table
- Operations runbook for incidents and DB backup verification
- Developer SDK documentation and expanded Connect SDK READMEs
- Docker E2E: PostgreSQL + Connect API integration tests
- Staging acceptance checklist and smoke script
- Production release runbook (promote / rollback / hotfix)
- Dependabot for npm, cargo, and GitHub Actions
- Vulnerability response SLA documentation
- Performance benchmark suite (KDF timing, API health p95)
- Multi-client sync MVP (Desktop cloud sync, 1PUX import, CSV export, conflict resolution)
- Browser extension MV3 (Chrome / Edge / Firefox / Safari scaffold)
- Tauri Mobile scaffold (iOS / Android)
- Web portal responsive UI and Playwright E2E
- Connect API production hardening and OpenAPI alignment

### Changed

- Backend accepts client-specified Connect item IDs for sync upsert

## [0.1.0] - 2026-05-28

### Added

- Initial monorepo: passshare-core, Connect API backend, Web portal, Desktop (Tauri)
- Argon2id + XChaCha20-Poly1305 password box encryption
- Connect-compatible REST API (`/v1/*`)
- Multi-user web authentication with HttpOnly sessions

[Unreleased]: https://github.com/AutoDevJapan/PassShare/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AutoDevJapan/PassShare/releases/tag/v0.1.0
