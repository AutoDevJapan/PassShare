# Tauri デスクトップ UI (SSOT)

> 最終更新: 2026-07-03  
> 関連 Issue: #6, #7, #13 (Phase 4), #212 (smoke 回帰)

## 概要

Tauri v2 デスクトップアプリの UI を **Vite + React + TypeScript** で実装する。Web ポータルと同系統のダーク + ネオングリーン UI を `shared/styles/` 経由で共有する。

## 配置

```
apps/desktop/
  index.html              — Vite エントリ
  package.json            — React / Vite / @tauri-apps/api
  vite.config.ts          — dev port 5174
  src/
    main.tsx              — React bootstrap
    App.tsx               — 画面切替（setup / main）
    style.css             — shared/styles import + desktop shell
    errors.ts             — PS001〜PS005 エラー表示ヘルパー
    tauri.ts              — invoke ラッパー
    types.ts              — ConnectItem 型 re-export
    labels.ts             — （廃止 #74）shared/i18n を使用
    components/
      AppHeader.tsx
      SetupPanel.tsx      — 新規作成 / 開く
      RecoveryKitPanel.tsx — 初回作成時の緊急キット表示
      MainPanel.tsx       — 検索 / category CRUD / CSV インポート
      StatusMessage.tsx   — エラー / 成功メッセージ
shared/ui/
  CategoryPicker.tsx      — 7 種 category（LOGIN … CUSTOM）
  ItemForm.tsx            — category 別追加・編集フォーム
  ConnectItemList.tsx     — tags / favorite / category 一覧
shared/types/item.ts      — ConnectItem / ItemFormValues 型
  src-tauri/
    tauri.conf.json       — frontendDist: ../dist
  dist/                   — Vite ビルド出力（gitignore）
```

## 画面構成（Issue #7）

### 1. セットアップ（SetupPanel）

| 要素 | 説明 |
|------|------|
| ファイルパス | パスワードボックス保存先 |
| マスターパスワード | 開く / 新規作成用 |
| 新規作成 / 開く | Primary / Secondary ボタン |
| エラー | PS001〜PS005 をユーザー向け文言で表示 |
| 緊急キット | 初回作成後、RecoveryKitPanel で表示 → 確認後にメインへ |

### 2. メイン（MainPanel — Issue #13 Phase 4）

| 要素 | 説明 |
|------|------|
| 検索バー | タイトル / URL / ユーザー名 / タグ |
| CSV インポート | 1Password CSV → `import_onepassword_csv` |
| 閉じる | `lock_password_box` → SetupPanel |
| 追加 / 編集フォーム | category 別（ログイン情報 / パスワード / セキュアメモ） |
| 一覧 | category チップ、tags、お気に入り、コピー / 編集 / 削除 |

## エラーコード（UI 表示）

Rust 側 `PassShareError` が `PS00N: メッセージ` 形式で返す。`errors.ts` がコードを除いた文言を表示する。

| コード | ユーザー向けメッセージ |
|--------|------------------------|
| PS001 | マスターパスワードが正しくありません |
| PS002 | パスワードボックスファイルが見つかりません |
| PS003 | ファイルが壊れているか、別のパスワードボックスです |
| PS004 | タイトルは必須です |
| PS005 | パスワードは必須です |

## Tauri 連携

| 項目 | 値 |
|------|-----|
| `devUrl` | `http://localhost:5174` |
| `beforeDevCommand` | `pnpm run dev` |
| `beforeBuildCommand` | `pnpm run build` |
| `frontendDist` | `../dist` |
| invoke API | `@tauri-apps/api/core` |

### 利用コマンド

- `get_state`, `create_password_box`, `open_password_box`, `lock_password_box`
- `list_items`, `search_items`, `add_item`, `update_item`, `delete_item`
- `import_onepassword_csv`, `generate_password`

`list_items` / `add_item` は Connect 互換 `ItemDto`（category, tags, favorite 含む）を返す。

## 受入基準

### Issue #13 (Phase 4)

- [x] LOGIN / PASSWORD / SECURE_NOTE の CRUD（Desktop）
- [x] tags / favorite 表示
- [x] 1Password CSV インポート UI
- [x] 共有 UI コンポーネント（`shared/ui/`）
- [ ] Web ポータル Connect API 連携（後続）

### Issue #6

- [x] `cargo tauri dev` で React UI が起動する
- [x] 参照サイトと同系統のダーク + ネオングリーン UI
- [x] 既存 Tauri commands が invoke 可能
- [x] `npm run build` が通る

### Issue #7

- [x] MVP ATDD の操作（作成・開く・追加・検索・生成・コピー・削除・閉じる）が UI から完遂できる
- [x] Primary / Secondary ボタン、入力フィールド、カードスタイルを使用
- [x] 用語: パスワードボックス / マスターパスワード / ログイン情報 / 開く / 閉じる
- [x] 初回作成時に緊急キットを専用パネルで表示
- [x] PS001〜PS005 エラーをインライン表示（`alert` 不使用）

### Issue #212 (MVP smoke 回帰)

`apps/desktop/src-tauri/src/lib.rs` の `smoke_tests` が MVP 必須操作を回帰テストとしてカバーする。
実行: `cargo test -p passshare-desktop smoke_`（quality-gate / desktop-build CI で実行）。

- [x] 作成・開く・追加・一覧・閉じる（`smoke_create_open_add_list_lock`）
- [x] 検索: タイトル / URL / ユーザー名 / タグ（`smoke_search_by_title_url_username_and_tag`）
- [x] パスワード生成: 16 文字・記号込み・非決定性（`smoke_generate_password_16_chars_with_symbols`）
- [x] 削除: 再オープン後も反映、削除済み ID は `PS007`（`smoke_delete_item_persists_after_reopen`）
- [x] 間違ったマスターパスワード: `PS001` で拒否（`smoke_open_with_wrong_master_password_fails`）
- [x] 緊急キット: 作成時に生成・再オープン後も保持・閉じた状態では読めない（`smoke_recovery_kit_available_and_persisted`）
- [x] 7 category（CREDIT_CARD 等）の parse / CRUD（`smoke_all_categories_crud_roundtrip`）

## 開発コマンド

```bash
cd apps/desktop
pnpm install
pnpm run dev          # Vite のみ（ブラウザでは invoke 不可）
cargo tauri dev      # Tauri + Vite（apps/desktop から）
cargo tauri build    # 本番ビルド（MSI/DMG/AppImage）
```

## Epic #32（本番化）

- i18n: `shared/i18n` + `useItemLabels` / `useDesktopLabels`（ja/en）
- 追加 category: CREDIT_CARD / IDENTITY / SSH_KEY / CUSTOM
- CI: `.github/workflows/desktop-build.yml`
- 自動更新: `tauri-plugin-updater` — [desktop-release.md](../runbooks/desktop-release.md)
- クラウド同期（Should）: [desktop-cloud-sync.md](./desktop-cloud-sync.md)

## 関連

- [MVP 仕様](./feature-passshare-mvp.md)
- [デザインシステム](./design-system.md)
