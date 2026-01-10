## 目的
コミュニケーションの粒度・形式を統一し、誤解と認知負荷を減らす。

## 原則（MUST）
- **日本語で報告**する
- **結論→理由→次アクション**の順に書く
- **曖昧な仕様は実装前に質問**し、Spec（`documents/spec/`）を固める
- 重要な判断は「代替案/トレードオフ/残リスク」をセットで残す（ADR対象なら `documents/templates/adr-template.md`）

## 進捗報告（短文テンプレ）
- **いま何をしているか**:
- **分かったこと**:
- **次にやること**:
- **詰まり（あれば）**:

## 完了報告（テンプレ）
- **変更概要**:
- **影響範囲**: Front/Back/Agent/Infra
- **実行した確認**: コマンド/結果
- **互換性/移行**: 破壊的変更の有無、移行/ロールバック
- **残リスク/未決事項**:

## 質問テンプレ（最小）
1. 現状理解（前提）
2. 不明点（質問）
3. 選択肢（標準/保守的/大胆）
4. 推奨案と理由
5. 追加でほしい情報

## テンプレ参照
- PR本文: `documents/templates/pr-template.md`
- 影響分析: `documents/templates/impact-analysis-template.md`
- テスト計画: `documents/templates/test-plan-template.md`
- ADR: `documents/templates/adr-template.md`
- リリースノート: `documents/templates/release-notes-template.md`

