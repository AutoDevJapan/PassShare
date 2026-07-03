# Desktop ローカル開発 Runbook

> Issue [#213](https://github.com/AutoDevJapan/PassShare/issues/213)  
> 親 Epic: [#205](https://github.com/AutoDevJapan/PassShare/issues/205)

## 目的

開発者が **`cargo tauri dev`** で PassShare デスクトップアプリを起動し、MVP 操作（パスワードボックス作成 → 解錠 → 項目追加）を UI から完遂できることを担保する。あわせて、ローカル backend に対するクラウド同期 smoke の手順を明文化する。

用語は MVP 仕様に従う（[feature-passshare-mvp.md](../spec/feature-passshare-mvp.md)）: パスワードボックス / マスターパスワード / ログイン情報 / 開く / 閉じる。

## 前提

| ツール | バージョン | 備考 |
|--------|-----------|------|
| Node.js | 22.x | |
| pnpm | 10.11.0 | `corepack enable` 推奨 |
| Rust | stable | `rustup default stable` |
| Tauri CLI | v2 | `cargo install tauri-cli --version "^2"`（または devDependency の `@tauri-apps/cli`） |

### OS 別 Tauri 前提（[公式](https://tauri.app/start/prerequisites/)）

| OS | 追加インストール |
|----|-----------------|
| **Linux** | `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`（CI と同一 — `quality-gate.yml` desktop-smoke） |
| **macOS** | Xcode Command Line Tools（`xcode-select --install`） |
| **Windows** | Microsoft C++ Build Tools + WebView2 Runtime（Win11 は同梱） |

## クイックスタート

リポジトリ root から:

```powershell
# 1. connect-js を事前ビルド（Desktop が @passshare/connect に依存）
pnpm --dir packages/connect-js install --frozen-lockfile
pnpm --dir packages/connect-js run build

# 2. Desktop 依存インストール
pnpm --dir apps/desktop install --frozen-lockfile

# 3. Tauri + Vite 起動（apps/desktop から）
cd apps/desktop
cargo tauri dev
```

`cargo tauri dev` は `beforeDevCommand`（`pnpm run dev` → Vite dev port 5174）を自動起動し、ネイティブウィンドウを開く。

> **connect-js の事前ビルドは必須。** 未ビルドだと Vite が `@passshare/connect`（`packages/connect-js`）を解決できずに起動失敗する。

## MVP 動作確認（UI から）

| # | 操作 | 期待結果 |
|---|------|---------|
| 1 | ファイルパス + マスターパスワードを入力し「新規作成」 | 緊急キット（リカバリ用シークレット）が専用パネルで表示される |
| 2 | 緊急キットを確認して進む | メイン画面に遷移 |
| 3 | ログイン情報を追加（タイトル / URL / ユーザー名 / パスワード） | 一覧に表示される |
| 4 | 検索バーにタイトルの一部を入力 | 一致する項目のみ表示 |
| 5 | パスワード生成（16 文字・記号込み） | 推測困難な文字列が入力される |
| 6 | 項目を削除 | 一覧から消える |
| 7 | 「閉じる」→ 同じマスターパスワードで「開く」 | 追加した項目が残っている |
| 8 | 間違ったマスターパスワードで「開く」 | PS001 エラーがインライン表示される |

回帰は Rust smoke でも担保される（[desktop-ui.md](../spec/desktop-ui.md) #212）:

```powershell
cargo test -p passshare-desktop smoke_
```

## クラウド同期 smoke（ローカル backend）

Desktop 設定画面から backend にログインし、push / pull を確認する。

### 1. Backend 起動（ターミナル 1）

```powershell
$env:APP_ENV = "local"
$env:PORT = "8080"
node backend/src/index.js
```

`APP_ENV=local` でデモユーザーが自動 seed される（[local-dev-web.md](./local-dev-web.md)）:

| 項目 | 値 |
|------|-----|
| Email | `dev@passshare.local` |
| Password | `DevPassShare1!` |

### 2. API ベース URL を指定して Desktop 起動（ターミナル 2）

`CloudSyncSettings` は `VITE_API_BASE_URL` を同期先の初期値として読む（`apps/desktop/src/components/CloudSyncSettings.tsx`）。

```powershell
cd apps/desktop
$env:VITE_API_BASE_URL = "http://127.0.0.1:8080"
cargo tauri dev
```

### 3. 設定画面で同期

1. 設定 → クラウド同期を有効化
2. API ベース URL（`http://127.0.0.1:8080`）/ Email / Password / Vault ID を入力
   - Vault ID は backend `GET /v1/vaults`（Connect トークン）で確認できる。新規ユーザーは vault が 1 件
3. 同期を実行 → **push（ローカルのみの項目を送信）/ pull（リモートのみの項目を取得）** の件数が表示される
4. 競合がある場合は keep-local / keep-remote を選択

> 同期ロジックの詳細は `apps/desktop/src/lib/cloud-sync.ts`（`runCloudSync` / 競合解決）。CI では backend cloud-sync 統合テスト（`backend/test/cloud-sync.integration.test.js`、Docker + PostgreSQL）でカバーされる。

## 本番ビルド

```powershell
cd apps/desktop
cargo tauri build    # MSI / DMG / AppImage
```

## CI との対応

| ローカル | CI |
|---------|-----|
| `cargo test -p passshare-desktop smoke_` | Quality Gate `Desktop smoke`（Rust smoke） |
| `pnpm --dir apps/desktop run test` | Quality Gate `Desktop smoke`（cloud-sync unit） |
| クラウド同期 smoke（手動） | Quality Gate `Docker E2E` — `cloud-sync.integration.test.js` |
| `cargo tauri build` | `desktop-build.yml` |

## トラブルシュート

| 症状 | 対処 |
|------|------|
| Vite が `@passshare/connect` を解決できない | `pnpm --dir packages/connect-js run build` を先に実行 |
| `cargo tauri` が見つからない | `cargo install tauri-cli --version "^2"` |
| Linux でウィンドウが起動しない | Tauri 前提パッケージ（webkit2gtk 等）を導入 |
| 同期で 401 / ログイン失敗 | backend が 8080 で起動しているか、Email/Password が seed と一致するか確認 |
| Vault ID が不明 | `GET /v1/vaults`（Bearer: Connect トークン）で取得 |
| port 5174 / 8080 が使用中 | プロセス停止、または `PORT` / vite `--port` を変更 |

## 関連

- [feature-passshare-mvp.md](../spec/feature-passshare-mvp.md) — MVP 仕様
- [desktop-ui.md](../spec/desktop-ui.md) — Desktop UI SSOT
- [desktop-cloud-sync.md](../spec/desktop-cloud-sync.md) — クラウド同期仕様
- [desktop-release.md](./desktop-release.md) — リリース / 自動更新
- [local-dev-web.md](./local-dev-web.md) — Web ローカル開発
- [staging-acceptance.md](./staging-acceptance.md) — 受入テスト
