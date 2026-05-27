# Web ランディングページ シェル UI (SSOT)

> 最終更新: 2026-05-27  
> 関連 Issue: #4  
> デザインシステム: [design-system.md](./design-system.md)

## 概要

Web ポータル（`frontend/`）のランディングページに、Header / Hero / Footer からなるシェル UI を提供する。React + Vite で実装し、Issue #3 の共有デザイントークン（`shared/styles/`）を使用する。

## 構成

```
frontend/src/
  App.tsx
  main.tsx
  components/
    Header.tsx
    Hero.tsx
    Footer.tsx
    MatrixBackground.tsx  — shared/ui へ移行（Issue #8）
    SearchDialog.tsx
  styles/
    landing.css   — ランディング固有レイアウト
  style.css       — shared/styles + landing.css
```

## セクション仕様

### Header

| 要素 | 内容 |
|------|------|
| ロゴ | ロックアイコン + `PassShare` |
| ナビ | Home / Download / Docs（Home がアクティブ） |
| 検索 | ページ内検索ダイアログ + `⌘K` / `Ctrl+K` |
| 言語 | 日本語 / EN 切替（`shared/i18n`） |
| CTA | Download（Primary） |

モバイル（≤960px）ではハンバーガーメニューでナビ・ツールを展開する。

### Hero

| 要素 | 内容 |
|------|------|
| バッジ | `完全無料` |
| 見出し | 白 + ネオングリーンの 2 行（グロー効果） |
| リード | MVP 向け文言（**パスワードボックス** を使用） |
| CTA | Download（Primary）/ View Documentation（Secondary） |
| 背景 | Matrix 風縦ストリーク（`shared/ui/MatrixBackground`） |
| 検索 | `⌘K` / `Ctrl+K` で SearchDialog を開く |
| 言語 | 日本語 / EN 切替（`shared/i18n`） |

### Footer

4 カラム（Product / Resources / Legal + ブランド）。下部にコピーライトと SNS リンク（GitHub / X）。

## 受入基準（Issue #4）

- [x] `npm run dev` で Header / Hero / Footer が表示される
- [x] モバイル幅でレイアウトが崩れない（ハンバーガーメニュー）
- [x] ダーク + ネオングリーンの印象（共有トークン使用）
- [x] MVP 向け文言（GPG/CLI 前提の文言は載せない）

## 確認方法

```bash
cd frontend && npm install && npm run dev
```

ブラウザ幅を 960px / 640px 以下に変更し、ハンバーガーメニューと Footer の折り返しを確認する。

## 関連

- [デザインシステム](./design-system.md)
- [MVP 仕様](./feature-passshare-mvp.md)
