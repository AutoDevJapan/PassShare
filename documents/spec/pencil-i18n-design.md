# Pencil 多言語デザイン検証 SSOT

> Issue: [#130](https://github.com/AutoDevJapan/PassShare/issues/130)  
> 親 Epic: [#38](https://github.com/AutoDevJapan/PassShare/issues/38) — i18n/l10n  
> 関連: [production-i18n.md](./production-i18n.md), [design-system.md](./design-system.md)

## 目的

主要 Web 画面を **ja / en / ru** の実文言長で Pencil フレーム化し、jp-ui-contracts に準拠したタイポグラフィ・密度・アイコン方針を設計段階で検証する。

コード実装が SSOT。Pencil フレームはコードと同期した設計アーティファクト。

## 対象画面

Visual Regression SSOT（`e2e/web/i18n-visual.spec.ts`）と同一:

| 画面 | パス | Pencil frame ID 例 |
|------|------|-------------------|
| ランディング | `/` | `landing-ja-1440` |
| ドキュメント | `/docs` | `docs-en-375` |
| ログイン | `/app/login` | `login-ru-1440` |
| FAQ | `/faq` | `faq-ja-375` |
| 利用規約 | `/terms` | `terms-en-1440` |

## フレーム仕様

| 項目 | 値 |
|------|-----|
| デスクトップ幅 | **1440px** |
| モバイル幅 | **375px** |
| ロケール | `ja`, `en`, `ru` |
| フレーム総数 | **30**（5 × 3 × 2） |
| 密度プロファイル | `saas`（フォーム・ナビ・リスト） |
| アイコン | **Lucide 相当**（24px outline）。**emoji 禁止** |

成果物:

- `design/pencil-i18n/frames-manifest.yaml` — フレーム一覧
- `design/pencil-i18n/locale-copy.json` — フレーム用文言（`pnpm run design:export-copy`）
- `design/pencil-i18n/tokens.json` — デザイントークン
- `design/pencil-i18n/checklist-results.json` — 検証結果
- `design/pencil-i18n/passshare-i18n.pen` — Pencil バイナリ（MCP 接続時に生成）

## jp-ui-contracts 7 項目

[jp-ui-contracts](https://github.com/hirokaji/jp-ui-contracts) リジェクト条件 6 件 + アイコン方針 1 件。

| # | 項目 | 判定 | 根拠 |
|---|------|------|------|
| 1 | グローバル `word-break: break-all` 禁止 | ✅ pass | `shared/styles/locale.css` |
| 2 | body の強い `letter-spacing` (>0.02em) 禁止 | ✅ pass | `shared/styles/typography.css` |
| 3 | 日本語 body `line-height` 1.7–2.0 | ✅ pass | `--ps-leading-ja: 1.75` |
| 4 | 日本語 font fallback 明示 | ✅ pass | `--ps-font-sans-cjk` |
| 5 | body への global `palt` 禁止 | ✅ pass | 該当ルールなし |
| 6 | フォーム/テーブルの密度分離 | ✅ pass | `--ps-leading-form`, vault card min-height |
| 7 | Lucide 相当アイコン（emoji 禁止） | ✅ pass | `scripts/jp-ui-contracts-check.mjs` |

自動検証:

```bash
pnpm run design:jp-ui-check
```

## 設計レビュー（Phase 4 補足）

| 観点 | 結果 |
|------|------|
| 長文段落（ja body） | line-height 1.75、Visual Regression overflow ≤ 1px |
| 見出し（狭幅 375px） | Hero / Doc 見出しが折返し可能（clamp 見出し） |
| URL / 長英単語 | `.ps-break-word`, `.ps-meta dd` overflow-wrap |
| フォーム | label `--ps-leading-form`, button min-height |
| テーブル/リスト | `.app-vault-card` min-height 3.25rem |
| 混合スクリプト | `.ps-mixed-script` keep-all + anywhere |
| モバイル余白 | 375px Playwright で horizontal overflow なし |

## Pencil 生成手順

Pencil MCP（`user-highagency.pencildev-extension-pencil`）が Cursor に接続されている場合:

1. `/user-godd-a/design` を `target: i18n`, `output: pencil` で実行
2. `design/pencil-i18n/locale-copy.json` の文言を各フレームに適用
3. `design/pencil-i18n/tokens.json` を Pencil 変数にマップ
4. Lucide 相当アイコンは Pencil `G()` で生成（emoji 不可）
5. 各フレームを `get_screenshot` で確認

MCP 未接続時は、本 SSOT + CI（`design:jp-ui-check` + i18n Visual Regression）で設計-コード整合を担保する。

## 受入基準（Issue #130）

- [x] 1440px + 375px フレーム定義（30 フレーム manifest）
- [x] jp-ui-contracts 7 項目 pass（自動 + checklist JSON）
- [x] アイコン Lucide 相当（emoji / Unicode 記号アイコン除去）
- [ ] バイナリ `.pen` ファイル（Pencil MCP 接続後に生成）

## CI

| チェック | コマンド | Workflow |
|---------|---------|----------|
| jp-ui-contracts | `pnpm run design:jp-ui-check` | `quality-gate.yml` → `i18n` job |
| locale レイアウト | `playwright test e2e/web/i18n-visual.spec.ts` | `frontend` job |
