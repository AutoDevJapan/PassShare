# Web ランディングページ コンテンツセクション (SSOT)

> 最終更新: 2026-05-27  
> 関連 Issue: #5  
> シェル UI: [landing-page-shell.md](./landing-page-shell.md)

## 概要

2026-10-04 の修正: 以下は初版の配置仕様。現行コピーは[製品監査](../audits/2026-10-04-product-readiness.md)に合わせ、端末版とクラウド版の保管方式を区別する。緊急キットによる復旧を約束せず、共有と CSV/1PUX 移行は実装済みとして利用条件を示す。未検証の他社形式・無根拠な他社評価・永久無料の約束を掲載しない。Download と称して同じ見出しへ戻す導線は使わず、導入手順 `/docs/user-guide` へ進める。一般向け配布先は署名・導入を確認してから掲載する。

Web ポータルの Hero 以降に、Quick Start / Features / Migration / Comparison / Get Started のコンテンツセクションを配置する。

## セクション順序

1. Hero（Issue #4）
2. Quick Start
3. Features
4. Easy Migration
5. Comparison
6. Get Started Now
7. Footer（Issue #4）

## セクション仕様

### Quick Start

| 要素 | 内容 |
|------|------|
| ステップ | 3 段（デスクトップ DL → パスワードボックス新規作成 → ログイン情報追加） |
| コードブロック | デスクトップ UI の操作例（CLI / GPG コマンドは載せない） |
| 用語 | **パスワードボックス** / **マスターパスワード** |

### Features

8 カードグリッド（4列 → モバイル 1列）:

| カード | MVP |
|--------|-----|
| パスワードボックス | v0.1 |
| ローカル暗号化 | v0.1 |
| パスワード生成 | v0.1 |
| 高速検索 | v0.1 |
| ログイン情報管理 | v0.1 |
| 緊急キット | v0.1 |
| デスクトップアプリ | v0.1 |
| 共有機能 | Coming soon（v0.2） |

### Easy Migration

- 3 ステップ + 対応予定サービスタグ
- 全体を **Coming soon**（v0.2 以降）として表示

### Comparison

PassShare vs 主要 PM 一般の比較テーブル（MVP 機能に限定）。

### Get Started Now

下部 CTA: View Documentation（Primary `/docs`）/ Download（Secondary `#download` — Hero へスクロール）。Primary Download は Hero のみ。

## 受入基準（Issue #5）

### 言語切替の修復（ToDo #1556、親 #1197）

Quick Start / Features / Migration / Comparison / Get Started の見出し、本文、表、操作例、形式ラベルを既存の翻訳機能へ接続する。日本語・英語・ロシア語で同じ利用条件を表示する。端末内の暗号化とサーバーが内容を読めるクラウド方式、緊急キット単独では復旧できない制約、販売前の共有検証、CSV / 1PUX の対応範囲を維持する。他の7言語の追加文言は英語で表示する。

- Given 英語またはロシア語を選択 When 5つの説明欄を読む Then 固定日本語や翻訳キーを表示せず、選択言語で導入・利用条件を確認できる。
- Given 日本語・英語・ロシア語と320px表示 When 説明欄を開く Then ページ全体には横はみ出しがなく、比較表は既存の横スクロール内で読める。
- Given 下部の導入リンク When 選択する Then `/docs/user-guide` へ進み、文書リンクは `/docs` へ進む。

検証結果と未完条件は[言語切替の修復記録](../audits/landing-locale-remediation-1556.md)に分けて保存する。製品全体の販売条件と独立レビュー・CI・main統合は親 #1197 で継続する。

- [x] 参照サイトと同順序・同レイアウトで各セクションが表示される
- [x] Quick Start が [MVP 仕様](./feature-passshare-mvp.md) と矛盾しない
- [x] 禁止用語（Vault / 金庫 / ボルト）を使用していない
- [x] `npm run build` が通る

## 確認方法

```bash
cd frontend && npm install && npm run build && npm run dev
```

## 関連

- [ランディングシェル UI](./landing-page-shell.md)
- [MVP 仕様](./feature-passshare-mvp.md)
