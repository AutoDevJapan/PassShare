## 目的
**SDD（Spec-Driven Development）x ATDD（Acceptance Test-Driven Development）** のための仕様置き場です。
ここを「単一の信頼できる情報源（SSOT）」とし、仕様→テスト→実装の順序を守ります。

### 開発フロー
```
1. Spec確定（このディレクトリ）
   ↓
2. 受け入れ条件を Given-When-Then で定義
   ↓
3. 受け入れテストを先に書く
   ↓
4. 実装
   ↓
5. 回帰テストとして維持
```

## 運用ルール
- Specが曖昧なまま実装を進めない（先に仕様を補完する）
- 実装とSpecに差分が出たら、必ずSpecへフィードバックする
- 破壊的変更（API/DB/UI）は、移行方針とロールバックをSpecに書く
- UIのデザイン画像は更新頻度が高いため **Specには保存しない**（UI実装時は、開発者がチャットに貼り付けた画像を正本として参照する）

## 記述方針（SSOT）
- **文書の書き方（AI最適化）**: `documents/spec/writing-guidelines.md`

## トレーサビリティ（必須）
- すべてのSpecは、少なくとも以下を含める
  - **実装参照**（ファイル/ディレクトリ）
  - **テスト/検証参照**（コマンド、または手動手順）
- 台帳: `documents/spec/index.md`

## テンプレ
- API: `documents/spec/api-template.md`
- UI: `documents/spec/ui-template.md`
- DB: `documents/spec/db-template.md`
- Feature: `documents/spec/feature-template.md`
- Usecase: `documents/spec/usecase-template.md`
- Error Codes: `documents/spec/error-codes-template.md`

## 補助テンプレ（運用）
`documents/templates/` 配下に、影響分析/テスト計画/ADR/PR/リリースノートのテンプレがあります。


