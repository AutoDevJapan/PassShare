---
name: user-clone
description: "**SSOT（運用規約）/ MUST BE FOLLOWED** 本リポジトリでコードを書く全てのAgent/Prompt/人間が、同じ認識で開発を進めるための“運用規約の正本”。ターミナル不要運用、Front/Backブランチ分離、1コミット=1責務、GitHub PRのみレビュー、PR作成はGitHub MCP正本を強制します。"
tools:
  [
    "search",
    "readFile",
    "usages",
    "codebase",
    "runSubagent",
    "runCommands",
    "runTasks",
    "runTests",
    "testFailure",
    "problems",
    "terminalLastCommand",
    "edit",
  ]
target: cursor
---

> **重要：言語指示 / CRITCAL LANGUAGE INSTRUCTION**:
>
> - **Reporting Language**: 報告・コミュニケーション・出力は日本語
> - **Plan mode**: Plan も日本語

## このドキュメントの位置付け（SSOT / 規約）
このファイル（`.github/agents/user-clone.agent.md`）は、本リポジトリにおける **開発運用規約のSSOT（Single Source of Truth）** です。

- **対象**: ブランチ運用 / コミット運用 / PR運用 / 「ターミナル不要」運用 / 品質ゲートの最低ライン
- **非対象**: プロダクトの機能仕様そのもの（それは `documents/spec/` がSSOT）
  - フロント実装時の詳細な技術判断（React + TypeScript の境界/型/安全/観測の指針）は、別SSOT（`.github/prompts/react-vite-ts-mindset.md`）を参照する
  - バックエンド実装時の詳細な技術判断（FastAPI + MySQL + DDD の境界/テスト/移行/例外設計の指針）は、別SSOT（`.github/prompts/fastapi-mysql-ddd-mindset.md`）を参照する

### 優先順位（矛盾が出た場合の解決ルール）
1. **プロダクト仕様SSOT**: `documents/spec/index.md` および参照される各Spec
2. **運用SSOT**: 本ファイル（ブランチ/コミット/PR/品質ゲートのルール）
3. それ以外（READMEや口頭、過去メッセージ等）

矛盾がある場合は **推測で進めない**。必ず「Spec/運用SSOT/実装/テスト」のどこを直すかを決め、SSOTに反映してから進める。

## 用語定義（曖昧さを禁止）
- **ターミナル不要**: 人間がターミナルでコマンドを打つ必要が一切ないこと。コマンド実行はAgentが行う。
- **@メンション運用**: 開発者は必要な `prompt.md` / Spec / テンプレを **@参照**してAgentに“確認させ”、目的/完了条件だけ伝える。影響範囲の調査・手順選定・実行はAgentの責務。
- **画面実装**: UIの追加/変更、画面遷移、フォーム、表示文言、スタイル、Viteの描画に影響する変更。
- **Front/Backブランチ分離**: 画面実装を含むタスクでは、フロントとバックで **別ブランチ**、原則 **別PR** に分けること。
- **1コミット=1責務**: ステージングされた変更が複数ドメインに跨がないこと。機械的判定は `scripts/git/agent_git.py check-commit` を正本とする。
- **GitHub PRのみレビュー**: 人間はローカルの差分確認を原則しない。レビュー可能性（PR本文/差分の読みやすさ）を最優先する。
- **PR作成はGitHub MCP正本**: PR作成の自動化はGitHub MCPで行う。`gh` 依存を前提にしない。

## 絶対ルール（MUST）
### MUST-1: 人間にターミナル操作を要求しない
- 依頼者が行う操作は「自然言語で依頼」「PR上でレビュー」のみ。

### MUST-2: 画面実装を含む場合、Front/Backブランチを必ず分ける
- ブランチ命名は以下:
  - フロント: `feat/<slug>-frontend`
  - バック: `feat/<slug>-backend`
- 1つの依頼がFront/Backに跨る場合は **原則PRを2本**（frontend/backend）に分ける。

### MUST-3: 1コミット=1責務（混在コミット禁止）
機械的判定（正本）: `python scripts/git/agent_git.py check-commit`

#### ドメイン分類（正本: `scripts/git/agent_git.py`）
- **hard scope（同一コミットで複数混在するとNG）**
  - `frontend`: `frontend/**`
  - `backend`: `backend/**`
  - `repo-root`: 上記以外
- **soft scope（同一コミットに同梱可能）**
  - `docs`: `documents/**`
  - `scripts`: `scripts/**`

> 例: `frontend + docs` はOK、`frontend + backend` はNG。

### MUST-4: PR作成はGitHub MCPを正本とする
- `scripts/git/agent_git.py pr` は **GitHub MCP用のメタ情報を出力**する。
- 実際のPR作成もAgentがGitHub MCPで行う。

### MUST-5: `.github/workflows` を作成/編集/追加しない
- 運用上禁止。必要な品質担保はローカルスクリプト（例: `scripts/quality-gate.*`）で行う。

## 品質ゲート（最低ライン / MUST）
- **フロント**: `pnpm -C frontend format:check` は必須（greenであること）
- **Python**: `uv run ruff check .` は必須（greenであること）

## 標準手順（Default Workflow / MUST）
1. 開発者は **入口統一**の正本プロンプト（`.github/prompts/dev-cycle.prompt.md`）で依頼する（@参照＋目的＋完了条件）
2. Agentは依頼内容を **Specへ落とす**（曖昧なら質問→確定）
3. Agentは影響範囲を調査し、必要ならブランチ/PRを分割する（画面実装を含む場合はFront/Back分離）
4. Agentは preflight → 実装 → 品質ゲート →（必要なら統合）テストを実行する
5. Agentは責務単位でコミット分割し、適切なタイミングでpushする
6. Agentは PR本文（テンプレ完全準拠）とPR作成メタを提示し、GitHub MCPでPR作成する

> NOTE: `scripts/git/agent_git.py` や `preflight/quality-gate` の各コマンドは **Agent内部の実行手段**です。
> 人間がコマンドを覚えたり、手で打つ必要はありません。

## 入力（依頼時に最低限必要）
- **@参照（正本）**（Spec/テンプレ/運用規約。未指定ならAgentが提案し確認する）
- 目的と完了条件（測定可能に）

## 出力（必ず返す）
- PRリンク（frontend/backend別。1本のみの場合は理由を明記）
- PR本文（変更概要/背景/変更内容/影響範囲/移行/動作確認/補足）
- 実行したテストコマンドと結果（成功/失敗）

