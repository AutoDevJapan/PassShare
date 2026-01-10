## AI Agent / Contributors Guide（SSOT）
このリポジトリは **Cursor IDE 前提**で開発します。
本ファイルは「今後実装するにあたって迷わない入口（Single Source of Truth / SSOT）」です。仕様（Spec）と実装とテストの同期を最優先します。

## 目的
AIエージェントを含む全員が同じ前提・同じ仕様（Spec）を参照できるように、入口（Single Source of Truth）をここに集約します。

## 言語
- 報告/Plan/最終出力は **日本語**。

## コア姿勢

- 常に「なぜ」を掘り、目的/制約/完了条件を先に確定する。
- 正常系だけでなく異常系・境界値・運用時の振る舞いも同等に扱う。
- 技術/ビジネス/UX/セキュリティ/運用の多方面的視点で影響を評価する。
- 95% 以上確信できない前提は質問で潰し、推測で進めない。

## 作業開始前の整理（必須）

1. 目的と完了条件（測定可能な形で）
2. 既存構造・パターン・制約
3. 影響範囲とリスク（機能/性能/UX/セキュリティ/運用）
4. 実装案の候補（標準/保守的/大胆）と比較、推奨理由
5. 不要点・確認事項

必要ならこの時点で質問を投げ、回答を待ってから進める。

## 計画（Plan）

- 3ステップ以上、複数領域に跨る、選択肢がある、高リスクの場合は Plan を作る。
- Plan は 1-2時間程度の粒度で小さく分解し、テスト方針とリスク対策も含める。
- 実行中に前提が変わったら Plan を更新して共有する。

Plan テンプレート:

- ゴール/完了条件
- インプット（仕様/制約/依存）
- スコープ（やる/やらない）
- 手順（小さなステップ）
- テスト方針
- リスクと確認点

## 実装ガイド（全体）

- 既存の型/ユーティリティ/実装パターンを最優先で再利用する。
- 変更は小さく段階的に。局所修正→検証→次の順で進める。
- SOLID/KISS/YAGNI/DRY を自己レビュー基準にする。
- 型安全を徹底し `any`・型無効化（`ts-ignore`など）を原則禁止する。
- 入力は型とバリデーションで検証し、失敗パスを先に書く。
- 早期 return でネストを浅くし、読みやすさと責務を守る。
- ログ/エラーメッセージは具体的かつ最小限。秘密情報を含めない。
- N+1 や不要な全件取得を避け、必要ならバッチ/キャッシュ/差分取得を検討する。
- 既存パターンから逸脱する場合は、理由・代替案・影響を明記する。

## デザイン/UXの観点（フロント）

- ユーザー行動と必須入力、エラー時の導線が定義されているか確認する。
- 状態は最小限にし、責務ごとに hooks/コンポーネントを分割する。
- アクセシビリティや国際化が必要な場合は初期設計に含める。
- 大きなリスト/重い描画は避け、必要ならメモ化やページングを設計する。

## 調査・デバッグ

- まず事象を再現し、期待/実際/環境を記録する。
- 影響範囲を特定し、仮説を列挙して優先度順に検証する。
- 再現テスト追加→修正→再実行で副作用も確認する。
- 報告は「事象/再現/期待・実際/環境/調査結果/修正/テスト/残リスク」。

## テスト・検証（SDD x ATDD）

### ATDDフロー（新機能開発時）
```
1. Spec確定 → 受け入れ条件を Given-When-Then で定義
2. 受け入れテストを先に書く（Red）
3. 実装（Green）
4. リファクタリング → 回帰テストとして維持
```

### Given-When-Then の書き方
```gherkin
Given [前提条件：システムの初期状態]
When [操作/イベント：ユーザーまたはシステムの行動]
Then [期待結果：検証可能な結果]
```

### テスト順序
- **新機能**: 受け入れ条件からテストを先に書く
- **バグ修正**: 再現テストを先に書く
- **リファクタリング**: 既存テストがあれば不要、なければ先に追加

### テスト層の優先順位
1. **unit**（Domain/Usecase）を最優先：ビジネスルールを最短で固定
2. **integration**（API/DB）は要所のみ：境界の検証
3. **e2e** は重要フローのみ：ログイン/主要CRUD

### 実行と報告
- 実行コマンドと結果（成功/失敗）を必ず報告する。
- 実行できない場合は理由と代替確認手段を書く。
- **全エージェント共通（絶対）**: 可能な限り **APIテストとE2Eテストが通るまで**、諦めずに原因を潰して実装/修正を続ける。
  - テストが未整備/環境要因で実行不能な場合は、「実行できない理由」「代替の検証手段（integration/手動手順など）」「残リスク」を必ず明記し、ユーザーに判断を仰ぐ。
- **フロント（TypeScript）を変更したら**: `frontend` には `format:check` / `lint` / `check-types` が用意されています。最低限 `pnpm -C frontend check-types` を通し、必要に応じて `pnpm -C frontend build` まで実行してビルドが破綻しないことを確認してください。
- **品質ゲート（必須）**: 開発時は `pnpm quality-gate`（クロスプラットフォーム共通）を通してください。
  - フロント: `pnpm -C frontend format:check` / `lint` / `check-types` / `build`
  - バックエンド: `cd backend && uv run ruff check . && uv run pytest -q`

### 詳細ガイド
- テスト指針（ATDD詳細）: `.instruction/01_specialties/testing.md`

## 品質評価/自動化

- 正確性/安全性/性能/運用性/可読性の観点でリリース可否を判断する。
- 自動チェックの優先度は Lint/Format → 型 → テスト → メトリクス監視。
- カバレッジ、複雑度、重複度、性能劣化などの変化を意識する。

## コミュニケーション

- 不明点や分岐判断が必要な場合、即相談し最小限の質問で具体化する。
- 30分以上かかりそうな作業は途中経過を短く共有する。
- 完了時は「変更概要/影響範囲/実行テスト/残リスク」を箇条書きで報告する。
- トーンは簡潔に（要点4行以内を目安、コード/ログ除く）。

質問テンプレート:

1. 現状理解
2. 不明点
3. 選択肢
4. 推奨案と理由
5. 追加でほしい情報

## サブエージェント/分担（必要時）

- 役割が明確なサブエージェントがいる場合は委譲を検討する。
- Plan で担当範囲を分け、結合後に必ず全体テスト/整合確認を行う。

## `.instruction` ドキュメント参照ガイド（ユースケース）

### Universal（常に前提）

- 思考・分析の型: `.instruction\00_universal\thinking.md`
- 品質基準/自信度/レビュー報告: `.instruction\00_universal\quality.md`
- 質問/確認/進捗/完了報告の型: `.instruction\00_universal\communication.md`
- SOLID/KISS/YAGNI/DRY チェック: `.instruction\00_universal\development-principles-checklist.md`

### 計画/設計系

- 計画の立て方: `.instruction\01_specialties\planning.md`
- 相談・レビューの進め方: `.instruction\01_specialties\consultation.md`
- 設計レビュー指針（UI/UX/API）: `.instruction\01_specialties\design.md`

### 実装/原則

- 実装ガイド: `.instruction\01_specialties\implementation.md`
- 開発原則チェックリスト（詳細）: `.instruction\00_universal\development-principles-checklist.md`
- 品質自動化ガイド（CI/ゲート）: `.instruction\01_specialties\development-principles-automation.md`
- 開発原則の測定指標: `.instruction\01_specialties\development-principles-metrics.md`

### テスト/品質判断

- テスト指針: `.instruction\01_specialties\testing.md`
- 品質評価の観点（リリース判断）: `.instruction\01_specialties\quality-evaluation.md`

### 調査/障害対応

- 調査・デバッグ手順: `.instruction\01_specialties\investigation-debug.md`

### プロジェクト理解（このリポジトリ限定）

- プロジェクト構成: `.instruction\02_project\architecture.md`
- 採用技術一覧（言語/フレームワーク/ライブラリなど）: `.instruction\02_project\tech-stack.md`
- 開発手順とコマンド: `.instruction\02_project\development.md`
- ドメイン概要: `.instruction\02_project\domain.md`
- 実装パターン: `.instruction\02_project\patterns.md`

## 必読ドキュメント（現行）
- Cursor ルール: `.cursor/rules/rules.mdc`
- 思考の型: `.instruction/00_universal/thinking.md`
- 品質基準: `.instruction/00_universal/quality.md`
- コミュニケーション: `.instruction/00_universal/communication.md`

## Spec（仕様）置き場
仕様（Spec）は `documents/spec/` 配下に集約します（SSOT）。

- `documents/spec/README.md`（運用）
- `documents/spec/writing-guidelines.md`（記述方針SSOT / AI最適化）
- `documents/spec/api-template.md`（API仕様テンプレ）
- `documents/spec/ui-template.md`（UI仕様テンプレ）
- `documents/spec/db-template.md`（DB仕様テンプレ）
- `documents/spec/feature-template.md`（Feature仕様テンプレ）
- `documents/spec/usecase-template.md`（Usecase仕様テンプレ）
- `documents/spec/error-codes-template.md`（エラーコード仕様テンプレ）

補助テンプレ（運用）:
- `documents/templates/`（影響分析/テスト計画/ADR/PR/リリースノート）

## 実装リファレンス
- バックエンド: `backend/`
- フロント: `frontend/`
