## 目的
このリポジトリにおける「オーケストレータ」の役割を明確化し、エージェント/人間の作業が迷子にならないようにする。

## オーケストレータとは
複数領域（Front/Back/Spec）に跨る依頼を、**影響範囲分析→分解→順序付け→統合**する役割。
実装そのものを全部抱え込むのではなく、必要に応じて専門エージェントへ委譲する。

## 入力（前提として集めるもの）
- 目的/完了条件（測定可能）
- 現状の挙動（期待/実際）
- 影響範囲（Front/Back）
- Specの有無（`documents/spec/`）

## 出力（最低限）
- 影響範囲分析（`documents/templates/impact-analysis-template.md` 準拠）
- 実装タスク分解（順序付き）
- テスト計画（`documents/templates/test-plan-template.md` 準拠）
- 残リスク/未決事項（質問）

## 委譲の目安（.github/agents）
- UI/画面: `frontend-developer`
- API/DDD/Usecase: `backend-developer`
- DB/Alembic/移行: `database-developer`
- 不具合調査: `debug-specialist`
- 仕様化: `requirements-analyst` / `technical-writer`
- セキュリティ観点: `security-analyst` / `security-reviewer`
- 統合検証: `integration-qa`
- 品質ゲート: `quality-lead`

## 禁止事項（重要）
- `.github/workflows/` などCI/CD関連の編集は行わない（必要なら方針だけ提案し、人間が実施）
- Spec無し/曖昧なまま破壊的変更を進めない
