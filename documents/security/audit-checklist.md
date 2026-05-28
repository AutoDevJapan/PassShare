# PassShare セキュリティ監査チェックリスト

> SSOT for Issue [#50](https://github.com/AutoDevJapan/PassShare/issues/50)  
> 最終更新: 2026-05-28  
> 親 Epic: [#29](https://github.com/AutoDevJapan/PassShare/issues/29)

## 目的

PassShare v2.0 本番公開前に、OWASP Top 10・依存関係脆弱性・ペネトレーションテスト観点を定期的に確認するためのチェックリスト。

## 自動チェック（CI）

| 項目 | コマンド / Workflow | 頻度 |
|------|---------------------|------|
| Rust 依存関係 | `cargo audit` | PR / main push |
| npm 依存関係 | `npm audit --audit-level=high` | PR / main push（backend, frontend, desktop, connect-js） |
| Dependabot | `.github/dependabot.yml` | 日次 / 週次 |

Workflow: `.github/workflows/security-audit.yml`

## OWASP Top 10 (2021) — PassShare マッピング

| # | カテゴリ | PassShare 対策 | 確認方法 | Issue |
|---|---------|---------------|---------|-------|
| A01 | Broken Access Control | per-user Connect トークン + vault ACL | `backend/test/connect-authz.test.js` | #43 |
| A02 | Cryptographic Failures | Argon2id + XChaCha20-Poly1305、マスターパスワード非送信 | `cargo test` crypto | MVP |
| A03 | Injection | パラメータ化 SQL、Connect 入力検証 | backend 統合テスト | #30 |
| A04 | Insecure Design | ADR 003/004 二層認証・ストレージ | ADR レビュー | #28 |
| A05 | Security Misconfiguration | CSP / HSTS / CORS 限定 | `backend/test/security-headers.test.js` | #46 |
| A06 | Vulnerable Components | cargo-audit / npm audit / Dependabot | CI security-audit | #50 |
| A07 | Auth Failures | レート制限、アカウントロック、CSRF | `rate-limit.test.js`, `web-session.test.js` | #42–#45 |
| A08 | Software/Data Integrity | GitHub Actions 署名、依存ロックファイル | リリース前レビュー | #36 |
| A09 | Logging Failures | 秘密情報をログに出さない（backend 方針） | コードレビュー | — |
| A10 | SSRF | Connect API は DB のみ、外部 fetch 最小 | アーキテクチャレビュー | — |

## 認証・認可（Epic #29）

| 項目 | 状態 | 根拠 |
|------|------|------|
| 共有 `OP_CONNECT_TOKEN` 廃止（prd） | ✅ | `require-connect-auth.js` |
| HttpOnly セッション Cookie | ✅ | `auth/session.js` |
| CSRF（状態変更 API） | ✅ | `web-session.test.js` |
| ログイン レート制限 | ✅ | `login-guard.js` |
| クリップボード自動消去 | ✅ | `shared/ui/clipboard-auto-clear.ts` | #48 |
| 生体認証アンロック | ✅ Desktop/Mobile コード | `tauri-plugin-biometry` | #49 |
| 秘密ローテーション Runbook | ✅ | `documents/runbooks/secret-rotation.md` | #47 |

## ペネトレーションテスト観点（手動）

リリース前に stg 環境で実施し、結果を「実施記録」に残す。

| 観点 | 手順 | 期待結果 |
|------|------|---------|
| セッション窃取 | XSS ペイロードを Item タイトルに保存 | CSP により script 実行不可 |
| CSRF | 外部サイトから logout POST | 403 / 401 |
| IDOR | ユーザー A のトークンでユーザー B の Vault | 403 |
| ブルートフォース | 連続 login 失敗 | 429 + アカウントロック |
| クリップボード | パスワードコピー後 N 秒待機 | クリップボードが空 |
| ヘッダー | `curl -I` Backend / Frontend | CSP, HSTS, X-Frame-Options |

## 受入基準 (Issue #50)

```gherkin
Given 本チェックリストが documents/security/ に存在する
When  PR または main push が発生する
Then security-audit workflow が cargo-audit と npm audit を実行する
```

## 実施記録

| 日付 | 実施者 | 環境 | OWASP / pen-test | 依存関係 audit | 備考 |
|------|--------|------|------------------|----------------|------|
| | | | | | |

## 関連

- [production-v2.md](../spec/production-v2.md)
- [ADR 004: 認証・認可](../adr/004-auth-authorization-model.md)
- [secret-rotation.md](../runbooks/secret-rotation.md)
