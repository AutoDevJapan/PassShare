# UI 仕上げ — 背景アニメーション・検索・i18n (SSOT)

> 最終更新: 2026-05-27  
> 関連 Issue: #8

## 概要

参照 UI の仕上げ要素（Matrix 背景、検索ショートカット、i18n 骨格、アクセシビリティ）を Web / デスクトップ共通で整える。

## 共有配置

```
shared/
  i18n/
    locales/ja.json
    locales/en.json
    index.ts           — getMessages / resolveInitialLocale
    I18nProvider.tsx   — React Context + useI18n()
  ui/
    MatrixBackground.tsx
  styles/
    matrix.css         — Matrix 雨 + prefers-reduced-motion
```

## 背景アニメーション

| 項目 | 内容 |
|------|------|
| コンポーネント | `shared/ui/MatrixBackground.tsx` |
| Web | Hero 背景 |
| Desktop | `ps-app-shell` 固定背景（`matrix-rain--fixed`） |
| reduced motion | `prefers-reduced-motion: reduce` でアニメーション停止 |

## 検索ショートカット（Web）

| 項目 | 内容 |
|------|------|
| ショートカット | `⌘K` (macOS) / `Ctrl+K` (Windows) |
| UI | `SearchDialog` — ページ内セクションへのジャンプ |
| 実装 | `frontend/src/hooks/useSearchShortcut.ts` |

## i18n 骨格

| 項目 | 内容 |
|------|------|
| デフォルト | `ja` |
| 対応 | `en` |
| 永続化 | `localStorage` key: `passshare.locale` |
| 対象（MVP） | Header / Hero / Footer / Desktop AppHeader |
| 拡張 | `shared/i18n/locales/*.json` にキー追加 |

## アクセシビリティ

- フォーカスリング: `.ps-button`, `.ps-input`, `.landing-lang__btn`, `.search-dialog__result`
- 検索ダイアログ: `role="dialog"`, `aria-modal`, Escape で閉じる
- 言語切替: `aria-pressed` / `role="group"`
- フィードバック: `role="status"` / `role="alert"`（StatusMessage / SearchDialog）

## 受入基準（Issue #8）

- [x] `prefers-reduced-motion: reduce` で Matrix アニメーションが無効化される
- [x] Web Header の `⌘K` / `Ctrl+K` で検索 UI が開く
- [x] 主要 UI 文言が ja で表示され、en 切替の拡張ポイントがある
- [ ] Lighthouse Accessibility 90+（Web ランディング — 手動計測）

## 関連

- [ランディングシェル UI](./landing-page-shell.md)
- [デスクトップ UI](./desktop-ui.md)
- [デザインシステム](./design-system.md)
