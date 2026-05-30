# PassShare — AI Agent Guide (SSOT)

## 言語

- 報告・Plan・最終出力: **日本語**
- コード・コメント: 英語（Rust 慣習）

## ユーザー向け用語

UI・エラーメッセージ・ドキュメントでは **「パスワードボックス」** を使う。「金庫」「Vault」「ボルト」は禁止。

内部 Rust 型名は `PasswordBox` を使用する。

## 技術スタック

| Layer | Tech |
|-------|------|
| Core | Rust (passshare-core) |
| Desktop | Tauri v2 + React (Vite) |
| Web | Vite (frontend/) |
| API | Node.js + Express (backend/) |
| DB | PostgreSQL (Railway) |
| Hosting | Vercel (frontend) + Railway (backend/DB) |
| Crypto | argon2, chacha20poly1305, zeroize |
| Test | cargo test (Docker 必須) |

## モノレポ構成

```
crates/passshare-core/     — 暗号・ドメイン・ストレージ
crates/passshare-connect/  — Connect API Rust SDK
crates/op-cli/             — `op` 互換 CLI
packages/connect-js/       — TypeScript Connect SDK
packages/extension/        — Browser extension (MV3)
packages/connect-python/   — Python Connect SDK
packages/connect-go/       — Go Connect SDK
apps/desktop/              — Tauri デスクトップ
apps/mobile/               — Tauri Mobile（iOS / Android）
frontend/                  — Web ポータル (Vercel)
backend/                   — API (Railway)
shared/styles/             — 共通デザインシステム (Web / Desktop 共有)
shared/i18n/               — 共通 i18n (ja / en / ru + Should)
shared/ui/                 — 共通 React UI (MatrixBackground, LanguageSwitcher, ItemForm 等)
documents/spec/            — 仕様 SSOT
scripts/                   — インフラセットアップ
```

## 開発コマンド

```bash
# テスト（Docker — passshare-core + Connect SDK + op CLI）
docker compose -f docker/docker-compose.test.yml run --rm test

# Docker E2E（PostgreSQL + Connect API）
docker compose -f docker/docker-compose.test.yml run --rm backend-e2e

# パフォーマンスベンチマーク
node scripts/bench/run.mjs

# ステージング smoke
node scripts/stg-smoke.mjs

# Web ドキュメント（ローカル）
cd frontend && pnpm run dev
# /docs, /terms, /privacy, /faq

# op CLI ビルド（ローカル）
cargo build -p op-cli --release

# Connect SDK（TypeScript）
cd packages/connect-js && pnpm install && pnpm test

# Backend API（Connect / Auth）
cd backend && pnpm install && pnpm test

# Web ポータル
cd frontend && pnpm install && pnpm run build

# i18n キー完全性
pnpm run i18n:check

# Web E2E（Playwright — backend + frontend dev server）
# Runbook: documents/runbooks/local-dev-web.md
node scripts/local-web-e2e.mjs
# または: pnpm exec playwright test

# OpenAPI → SDK 型生成
cd backend && pnpm run generate:types

# ローカル（開発時のみ）
cargo test -p passshare-core

# デスクトップ（Tauri + React）
cd apps/desktop && pnpm install && pnpm --dir ../../packages/connect-js run build && cargo tauri dev

# デスクトップ smoke（Rust）
cargo test -p passshare-desktop smoke_

# モバイル（Tauri Mobile + React）
cd apps/mobile && pnpm install && pnpm --dir ../../packages/connect-js run build && cargo tauri android dev

# モバイル smoke（Rust + mobile auth API）
cargo test -p passshare-mobile smoke_

# ブラウザ拡張（MV3 + React）
cd packages/extension && pnpm install && pnpm --dir ../connect-js run build && pnpm run build

# 拡張 smoke（ユニット + extension auth API）
pnpm --dir packages/extension test
node --test backend/test/extension-auth.test.js
```

## CI 完了報告ルール

PR 作成・push・修正コミット後は、**CI が完了するまで「完了」と報告しない**。

### 完了報告の条件

1. 対象 PR / ブランチの **GitHub Checks がすべて terminal 状態**（pass または意図した skip のみ）
2. **fail / pending が 0 件** であることを `gh pr checks` 等で確認済み
3. 上記を満たした **後** に、変更内容・影響・テスト結果をユーザーへ報告する

### CI が Fail した場合

- **「完了」と報告しない。** 失敗チェック名・ログ・原因を特定し、修正に入る
- 修正は **`/user-godd-a/dev` ワークフロー** に従って実施する（調査 → 修正 → ドキュメント同期 → push）
- push 後、再度 CI 完了まで待機し、**すべて pass するまで上記を繰り返す**
- 同一原因で 3 回以上失敗した場合は Blocker Detection（GoDD dev 共通ルール）に従い、方針を切り替える

### 監視コマンド（例）

```powershell
gh pr checks <PR番号> --watch --interval 20
gh run list --branch <ブランチ名> --limit 5
gh run view <run-id> --log-failed
```

### 例外

- ユーザーが「CI 待たずに報告して」と明示した場合のみ、pending 状態で中間報告可（その旨を明記する）
- 外部サービス（Railway / Vercel 等）の手動操作が必要でエージェントが unblock できない場合は、**未解決の fail として報告**し、必要な手動手順を列挙する

## xDD

Spec: `documents/spec/feature-passshare-mvp.md`, `documents/spec/production-v2.md`
ADR: `documents/adr/003-multi-client-architecture.md`, `documents/adr/004-auth-authorization-model.md`, `documents/adr/005-mobile-platform-tauri.md`, `documents/adr/006-browser-extension-mv3.md`
Design: `documents/spec/design-system.md`, `documents/spec/desktop-ui.md`, `documents/spec/mobile-ui.md`, `documents/spec/extension-ui.md`, `documents/spec/ui-polish.md`
Web UI: `documents/spec/landing-page-shell.md`, `documents/spec/landing-page-content.md`
Infra: `documents/spec/infrastructure.md`, `documents/spec/release-versioning.md`, `documents/spec/performance-benchmarks.md`
Runbooks: `documents/runbooks/production-release.md`, `documents/runbooks/staging-acceptance.md`, `documents/runbooks/operations.md`
Guides: `documents/guides/`, `documents/legal/`

<!-- GoDD:start -->
### GoDD stack snapshot

Auto-detected from this repository (updated when `config` or `godd-a init` runs):

- **programming_languages**: typescript, rust
- **frontend**: react, vite, tauri, liftkit
- **backend**: axum
- **database**: postgresql
- **orm**: diesel
- **infra**: docker, terraform, vercel, github-actions, railway
- **other**: tauri mobile

### NES Context (Next Edit Suggestions)

- **Current phase**: implementation (in_progress)
- **Context**: Scaffolding frontend/backend and infra config for Vercel + Railway
- **Next likely files**: backend/package.json, documents/spec/infrastructure.md, .github/workflows/deploy-preview.yml

_Generated by GoDD MCP α MCP — keep this block for drift detection._
<!-- GoDD:end -->

