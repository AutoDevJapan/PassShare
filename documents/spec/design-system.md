# PassShare デザインシステム (SSOT)

> 最終更新: 2026-05-27  
> 関連 Issue: #3

## 概要

[参照 UI](https://pass-share.bm1314.net/) に合わせたダークテーマ + ネオングリーンアクセントのデザインシステム。Web ポータル（`frontend/`）とデスクトップ UI（`apps/desktop/`）で共有する。

## 配置

```
shared/styles/
  tokens.css        — CSS 変数（カラー・タイポ・余白・角丸・シャドウ）
  typography.css    — 見出し・本文・補助テキスト
  components.css    — ボタン・バッジ・コードブロック・フォーム等
  index.css         — 上記をまとめて import
```

各アプリから `@import` で参照する:

| アプリ | 参照元 |
|--------|--------|
| Web | `frontend/src/style.css` → `../../shared/styles/index.css` |
| Desktop | `apps/desktop/src/style.css` → `../../../shared/styles/index.css` |
| Matrix | `shared/styles/matrix.css`（`index.css` 経由） |

## デザイントークン

### カラー

| トークン | 用途 | 値 |
|----------|------|-----|
| `--ps-bg-base` | ページ背景 | `#0f172a` |
| `--ps-bg-surface` | カード・パネル | `#111827` |
| `--ps-bg-elevated` | Secondary ボタン等 | `#1e293b` |
| `--ps-accent` | Primary アクセント | `#22c55e` |
| `--ps-accent-bright` | ホバー・バッジ文字 | `#4ade80` |
| `--ps-text-primary` | 見出し・本文 | `#e2e8f0` |
| `--ps-text-secondary` | リード文 | `#cbd5e1` |
| `--ps-text-muted` | 補助・ラベル | `#94a3b8` |
| `--ps-border` | 枠線 | `#334155` |

### タイポグラフィ

| クラス | 用途 |
|--------|------|
| `.ps-eyebrow` | ブランド名・セクションラベル（大文字・字間広め） |
| `.ps-heading-1` | ページタイトル（グロー付き `text-shadow`） |
| `.ps-heading-2` / `.ps-heading-3` | セクション見出し |
| `.ps-lead` | リード文 |
| `.ps-text-muted` | 補助テキスト |

### スペーシング・形状

- 余白: `--ps-space-1` … `--ps-space-16`（0.25rem 刻み〜4rem）
- 角丸: `--ps-radius-sm` … `--ps-radius-xl`, `--ps-radius-pill`
- シャドウ: `--ps-shadow-sm/md/lg`, `--ps-shadow-glow`, `--ps-shadow-glow-heading`

## コンポーネント

| クラス | 説明 |
|--------|------|
| `.ps-button.ps-button--primary` | 緑背景・グロー付き Primary ボタン |
| `.ps-button.ps-button--secondary` | ダークグレー背景・枠線 Secondary ボタン |
| `.ps-badge` | ピル型バッジ（例: 「完全無料」） |
| `.ps-code-block` | Quick Start 用モノスペース領域 |
| `.ps-panel` | 汎用パネル |
| `.ps-meta` | キー・値の定義リスト |

## ユーザー向け用語（MUST）

UI ラベルは [MVP 仕様](./feature-passshare-mvp.md) の用語表に従う。

| 例 | 使用 |
|----|------|
| パスワードボックス | OK |
| マスターパスワード | OK |
| 金庫 / Vault / ボルト | **禁止** |

## 受入基準（Issue #3）

- [x] CSS 変数としてトークンが定義されている（`shared/styles/tokens.css`）
- [x] Primary / Secondary ボタン、見出し、バッジのサンプルで確認できる（`frontend/src/components/Hero.tsx`）
- [x] MVP 用語に沿ったラベル例が含まれる
- [x] 参照サイト同等のダークテーマがデフォルト

## 確認方法

```bash
cd frontend && npm install && npm run dev
```

ブラウザで Primary / Secondary ボタン、見出しグロー、バッジ、コードブロックを確認する。
