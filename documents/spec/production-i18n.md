# PassShare 本番 i18n / l10n SSOT

> 最終更新: 2026-05-28  
> 親 Epic: [#38](https://github.com/AutoDevJapan/PassShare/issues/38)  
> 関連: [production-v2.md](./production-v2.md), [ui-polish.md](./ui-polish.md), [design-system.md](./design-system.md)

## 概要

PassShare v2.0 の多言語対応 SSOT。`shared/i18n/` を全クライアント（Web / Desktop / Mobile / Extension）の翻訳カタログの単一ソースとする。

## 対応言語

| 優先度 | 言語 | ロケール | ファイル |
|--------|------|---------|---------|
| Must | 日本語 | `ja` | `shared/i18n/locales/ja.json` |
| Must | 英語 | `en` | `shared/i18n/locales/en.json` |
| Must | ロシア語 | `ru` | `shared/i18n/locales/ru.json` |
| Should | ドイツ語 | `de` | `shared/i18n/locales/de.json` |
| Should | フランス語 | `fr` | `shared/i18n/locales/fr.json` |
| Should | スペイン語 | `es` | `shared/i18n/locales/es.json` |
| Should | 中国語（簡体） | `zh-CN` | `shared/i18n/locales/zh-CN.json` |
| Should | 中国語（繁体） | `zh-TW` | `shared/i18n/locales/zh-TW.json` |
| Should | 韓国語 | `ko` | `shared/i18n/locales/ko.json` |
| Should | ポルトガル語（BR） | `pt-BR` | `shared/i18n/locales/pt-BR.json` |

## Fallback チェーン

| ロケール | フォールバック順 |
|---------|----------------|
| `ja` | — |
| `en` | `ja` |
| `ru` | `en` → `ja` |
| Should 言語 | `en` → `ja` |

実装: `shared/i18n/index.ts` の `mergeWithFallback()`。

## 永続化

| 項目 | 値 |
|------|-----|
| ストレージキー | `passshare.locale` |
| 対象 | Web / Desktop / Mobile（`localStorage`） |
| `<html lang>` | `applyDocumentLocale()` で `lang` + `data-locale` を設定 |

## キー命名規約

```
{domain}.{section}.{key}
```

| プレフィックス | 用途 |
|----------------|------|
| `header.*` | 共通ヘッダー・言語切替 |
| `session.*` | 認証セッション |
| `hero.*` / `footer.*` | Web ランディング |
| `desktop.*` | デスクトップアプリ |
| `app.*` | Web `/app` ポータル |
| `mobile.*` | モバイルアプリ |
| `extension.*` | ブラウザ拡張 |
| `item.*` | 項目カテゴリ・フィールド（全クライアント共有） |

`MessageKey` 型は `ja.json` から自動導出。新キー追加時は **全 locale ファイル** に追加すること。

## 言語切替 UI

| クライアント | コンポーネント | 方式 |
|-------------|---------------|------|
| Web Header | `shared/ui/LanguageSwitcher.tsx` | ボタン（ja / en / ru） |
| Web `/app` | `AppShell` | 同上 |
| Desktop | `AppHeader` | 同上 |
| Mobile Settings | `SettingsPanel` | `<select>`（全 UI ロケール） |
| Extension Settings | `SettingsPanel` | `<select>`（全 UI ロケール） |

A11y: `role="group"`, `aria-pressed`, `aria-label`（[ui-polish.md](./ui-polish.md) 準拠）。

## Intl フォーマット

`shared/i18n/intl.ts`:

| 関数 | 用途 |
|------|------|
| `formatDate()` | `Intl.DateTimeFormat` |
| `formatNumber()` | `Intl.NumberFormat` |
| `formatRelativeTime()` | `Intl.RelativeTimeFormat` |

## 複数形（ICU 相当）

`shared/i18n/plural.ts`:

| 関数 | 用途 |
|------|------|
| `formatVaultItemCount()` | パスワードボックス内件数（ru 複数形対応） |
| `formatListItemCount()` | 項目リスト件数 |
| `formatMessage()` | `{name}` プレースホルダ置換 |

## 疑似ロケール

`shared/i18n/pseudo.ts` — Microsoft `qps-ploc` 方式の文字伸長。レイアウトストレステスト用。

手順: `elongatePseudoString()` で UI 文字列を ~30% 伸長し Visual Regression でオーバーフローを検出。

## タイポグラフィ・表示保全（jp-ui-contracts）

| ルール | 実装 |
|--------|------|
| 日本語 body line-height 1.7–2.0 | `shared/styles/locale.css` `:lang(ja)` |
| スクリプト別 font-stack | `shared/styles/tokens.css` + `locale.css` |
| **`word-break: break-all` グローバル禁止** | `overflow-wrap: anywhere` + `word-break: normal` |
| フォーム label line-height 1.4–1.6 | `--ps-leading-form` |
| 拡張 320px 密度 | `.ext-panel` ルール in `locale.css` |

詳細: [design-system.md](./design-system.md#i18n--タイポグラフィ)。

## CI

| チェック | コマンド | Workflow |
|---------|---------|----------|
| キー完全性 | `pnpm run i18n:check` | `quality-gate.yml` → `i18n` job |
| jp-ui-contracts（#130） | `pnpm run design:jp-ui-check` | `quality-gate.yml` → `i18n` job |
| Visual Regression | `pnpm exec playwright test e2e/web/i18n-visual.spec.ts` | `frontend` job |

## 翻訳ワークフロー

1. `ja.json` にキー追加（SSOT）
2. `en.json` / `ru.json` / Should locale に同キー追加
3. `pnpm run i18n:check` で検証
4. PR にスクリーンショット差分を確認（locale 別 Visual Regression）

`ru.json` 再生成: `node scripts/generate-ru-locale.mjs`（`scripts/generate-ru-locale.mjs` 内の辞書を更新）。

## ユーザー向け用語（MUST）

| 使用可 | 禁止 |
|--------|------|
| パスワードボックス | 金庫 / Vault / ボルト |

ロシア語 UI でも「password box」概念は **«парольный бокс»** を使用。

## ドキュメント長文

Web ドキュメント（`/docs/*`）は `frontend/src/content/docs/{ja,en}.ts` で管理。`ru` / Should 言語は `en` にフォールバック（`content/docs/index.ts`）。

## 受入基準（Epic #38）

- [x] ja / en / ru 全クライアント切替
- [x] Should 言語 locale ファイル + fallback
- [x] 翻訳キー CI（`i18n:check`）
- [x] スクリプト別タイポグラフィ SSOT
- [x] jp-ui-contracts（`break-all` 除去）
- [x] Intl / 複数形ヘルパー
- [x] 疑似ロケールユーティリティ
- [x] locale 別 Visual Regression テスト
- [x] 言語切替 UI 統一（4 クライアント）
- [x] Pencil 多言語デザイン検証（Issue #130 — [pencil-i18n-design.md](./pencil-i18n-design.md)）

## 子 Issue トレーサビリティ

| Issue | 内容 |
|-------|------|
| [#117](https://github.com/AutoDevJapan/PassShare/issues/117) | 本 SSOT |
| [#118](https://github.com/AutoDevJapan/PassShare/issues/118) | `ru.json` + 切替 |
| [#119](https://github.com/AutoDevJapan/PassShare/issues/119) | Should 言語 |
| [#120](https://github.com/AutoDevJapan/PassShare/issues/120) | タイポグラフィ SSOT |
| [#121](https://github.com/AutoDevJapan/PassShare/issues/121) | font-stack CSS |
| [#122](https://github.com/AutoDevJapan/PassShare/issues/122) | 行分割・オーバーフロー CSS |
| [#123](https://github.com/AutoDevJapan/PassShare/issues/123) | 混合スクリプト検証 |
| [#124](https://github.com/AutoDevJapan/PassShare/issues/124) | Intl フォーマット |
| [#125](https://github.com/AutoDevJapan/PassShare/issues/125) | ICU / 複数形 |
| [#126](https://github.com/AutoDevJapan/PassShare/issues/126) | キー完全性 CI |
| [#127](https://github.com/AutoDevJapan/PassShare/issues/127) | 疑似ロケール |
| [#128](https://github.com/AutoDevJapan/PassShare/issues/128) | Visual Regression |
| [#129](https://github.com/AutoDevJapan/PassShare/issues/129) | 言語切替 UI 統一 |
| [#130](https://github.com/AutoDevJapan/PassShare/issues/130) | Pencil 検証 — [pencil-i18n-design.md](./pencil-i18n-design.md) |
| [#131](https://github.com/AutoDevJapan/PassShare/issues/131) | 密度プロファイル |
