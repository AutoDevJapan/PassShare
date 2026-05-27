# Tauri デスクトップ UI (SSOT)

> 最終更新: 2026-05-27  
> 関連 Issue: #6

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
    tauri.ts              — invoke ラッパー
    types.ts              — LoginItem 等
    components/
      AppHeader.tsx
      SetupPanel.tsx      — 新規作成 / 開く
      MainPanel.tsx       — 検索 / 追加 / 一覧
      ItemList.tsx
  src-tauri/
    tauri.conf.json       — frontendDist: ../dist
  dist/                   — Vite ビルド出力（gitignore）
```

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

## 画面構成

1. **SetupPanel** — ファイルパス + マスターパスワード → 新規作成 / 開く
2. **MainPanel** — 検索、ログイン情報追加フォーム、一覧（コピー / 削除）
3. **閉じる** — `lock_password_box` 呼び出し後 SetupPanel へ戻る

## 受入基準（Issue #6）

- [x] `cargo tauri dev` で React UI が起動する（Vite dev server 連携）
- [x] 参照サイトと同系統のダーク + ネオングリーン UI（`shared/styles/`）
- [x] 既存 Tauri commands が `@tauri-apps/api` 経由で invoke 可能
- [x] `npm run build` + `cargo tauri build` が通る

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
