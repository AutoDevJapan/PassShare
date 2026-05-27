# Tauri デスクトップ UI (SSOT)

> 最終更新: 2026-05-27  
> 関連 Issue: #6, #7

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
    types.ts              — LoginItem 等
    components/
      AppHeader.tsx
      SetupPanel.tsx      — 新規作成 / 開く
      RecoveryKitPanel.tsx — 初回作成時の緊急キット表示
      MainPanel.tsx       — 検索 / 追加 / 一覧
      ItemList.tsx
      StatusMessage.tsx   — エラー / 成功メッセージ
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

### 2. メイン（MainPanel）

| 要素 | 説明 |
|------|------|
| 検索バー | タイトル / URL / ユーザー名 |
| 閉じる | `lock_password_box` → SetupPanel |
| 追加フォーム | サイト名・URL・ユーザー名・パスワード + 生成 |
| 一覧 | カード形式、コピー / 削除 |

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
| `beforeDevCommand` | `npm run dev` |
| `beforeBuildCommand` | `npm run build` |
| `frontendDist` | `../dist` |
| invoke API | `@tauri-apps/api/core` |

### 利用コマンド

- `get_state`, `create_password_box`, `open_password_box`, `lock_password_box`
- `list_items`, `search_items`, `add_item`, `delete_item`, `generate_password`

## 受入基準

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

## 開発コマンド

```bash
cd apps/desktop
npm install
npm run dev          # Vite のみ（ブラウザでは invoke 不可）
cargo tauri dev      # Tauri + Vite（apps/desktop から）
cargo tauri build    # 本番ビルド
```

## 関連

- [MVP 仕様](./feature-passshare-mvp.md)
- [デザインシステム](./design-system.md)
