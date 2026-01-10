## 運用規約（SSOT）
- `.github/agents/user-clone.agent.md` を必ず遵守する（ターミナル不要/ブランチ分離/1コミット=1責務/PRはGitHub MCP正本）
- フロント（React + TypeScript）を扱う場合は `.github/prompts/react-vite-ts-mindset.md` をSSOTとして遵守する
- バックエンド（FastAPI + MySQL + DDD）を扱う場合は `.github/prompts/fastapi-mysql-ddd-mindset.md` をSSOTとして遵守する

## 目的
開発者（人間）が**自然言語で依頼するだけ**で、Agentが以下を自動で完了するための **開発入口プロンプト（正本）** です。

- 環境/前提チェック（preflight）
- 変更後の品質ゲート（quality-gate）
- PR本文生成（`documents/templates/pr-template.md` 準拠、事実ベース）

## 入力
- **@参照（正本）**（必要なSpec/テンプレ/運用規約。未指定ならAgentが提案して確認する）
- **依頼（何をしたいか）**
- **完了条件（測定可能に）**

### 任意（書ける範囲だけ）
- slug（チケット/短い識別子）
- 制約
- 統合テスト(DB): `yes` | `no` | `unknown`
- 統合実行後のDBクリーンアップ: `down-volumes` | `down` | `none`

## 出力（日本語）
- **実行ログ**: preflight/quality-gate の結果（成功/失敗、ログファイルパス）
- **変更概要**: 何を、なぜ、どこに
- **テスト結果**: 実行コマンドと結果
- **PR本文（完成形）**: `documents/templates/pr-template.md` を完全に埋めたMarkdown
- **PR作成メタ**: base/head/title/body（GitHub MCPでPR作成するための情報）

## ルール（SSOT）
- 仕様は `documents/spec/` がSSOT。曖昧なら先に質問して固める
- Backendの依存方向: Domain → Usecase → Infrastructure → Presentation
- Frontは UIと副作用を分離（hooks/servicesへ）
- フロント変更時は最低限 `pnpm -C electron build` を通す
- CI/CD関連（`.github/workflows` 等）は編集しない

## Agentが必ず行うこと（MUST）
1. Spec確認/補完（必要なら作成/更新し `documents/spec/index.md` に反映）
2. 影響範囲調査 → 必要ならFront/Backブランチ/PR分割
3. preflight実行（必要ならopt-inでDB→API→migration→integration、cleanup方針はSSOT）
4. 実装（Self-documenting code、Whyコメント最小、1コミット=1責務を遵守）
5. quality-gate実行
6. PR本文生成（`documents/templates/pr-template.md` 完全準拠、事実ベース）

