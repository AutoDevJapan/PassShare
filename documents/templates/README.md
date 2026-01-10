## documents/templates（運用テンプレ / SSOT）

このフォルダは、開発運用で繰り返し作る文書の **テンプレ（正本）** です。
Agentに「このテンプレを完全に埋めて」と指示すれば、常に同じ構造で出力できることを目的にしています。

### 正本（必読）
- 文書の記述方針（AI最適化）: `documents/spec/writing-guidelines.md`
- 運用規約（ターミナル不要/ブランチ分離等）: `.github/agents/user-clone.agent.md`
- 入口統一（開発サイクル / @dev推奨）: `.github/prompts/dev.prompt.md`

### 使い分け
- **ADR**: `documents/templates/adr-template.md`
  - 設計判断を残す（代替案/トレードオフ/ロールバック）
- **影響範囲分析**: `documents/templates/impact-analysis-template.md`
  - 変更前に、影響範囲/移行/リスクを洗い出す
- **テスト計画**: `documents/templates/test-plan-template.md`
  - テストの層/ケース/実行コマンド/手動検証を固定する
- **PR本文**: `documents/templates/pr-template.md`
  - PR作成時の本文（レビューしやすさ最優先）
- **リリースノート**: `documents/templates/release-notes-template.md`
  - リリース時の変更点/互換性/既知問題を固定する


