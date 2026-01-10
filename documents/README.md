## ドキュメント入口（Human SSOT）
このディレクトリは **人間向けSSOT**（仕様・方針・手順・テンプレ）を集約します。
実装/レビュー/運用で迷ったら、まずここから辿ってください。

## ルール（ファイル形式）
- **仕様・方針・手順・テンプレ**: `.md`（このリポジトリのSSOT）
- **設定・宣言（機械が読む）**: `.yaml` / `.yml` / `.json`（説明は `.md` に併記）

## Spec（仕様）
- 仕様置き場: `documents/spec/`
- 運用: `documents/spec/README.md`

## 技術スタック（現状）
- 一覧（できる限り完全版）: `documents/tech-stack.md`

## 運用テンプレ
- テンプレ置き場: `documents/templates/`
  - PR: `documents/templates/pr-template.md`
  - 影響分析: `documents/templates/impact-analysis-template.md`
  - テスト計画: `documents/templates/test-plan-template.md`
  - ADR: `documents/templates/adr-template.md`
  - リリースノート: `documents/templates/release-notes-template.md`

## 設定（yaml/json）の説明
- 設定カタログ: `documents/config/README.md`

## 開発の入口
- まずはルート `README.md`（開発者用Agent攻略マニュアル）を参照
- 役割/規約（エージェント含む）: `AGENTS.md`
- **入口統一（実装〜PRまで / @dev推奨）**: `.github/prompts/dev.prompt.md`
- **環境構築（オンボーディング）**: `.github/prompts/setup.prompt.md`
- 環境変数（ローカル開発）: `documents/setup/environment-variables.md`


