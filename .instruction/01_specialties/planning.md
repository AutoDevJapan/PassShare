## 目的
タスク計画・分割・優先順位付けのやり方を統一する。

## 方針（MUST）
- **Specが曖昧なら、実装より先に仕様化**する（`documents/spec/` がSSOT）
- **影響範囲が大きいほど、段階的に分割**する（安全な小変更 → 検証 → 次）
- “最初に動く最小” を優先するが、**レイヤ境界は守る**（近道で技術負債を増やさない）

## 典型の手順（テンプレ）
1. **目的/完了条件**（測定可能）
2. **影響範囲分析**（Front/Back/Agent/Infra、互換性/移行）
3. **タスク分解**（順序付き、依存関係を明記）
4. **テスト計画**（unit/integration/e2e、手動手順）
5. **残リスク/未確定**（質問）

## 出力フォーマット（推奨）
- 影響範囲: `documents/templates/impact-analysis-template.md`
- テスト計画: `documents/templates/test-plan-template.md`
- PR本文: `documents/templates/pr-template.md`

