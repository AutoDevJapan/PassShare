# MCP（Model Context Protocol）運用（Cursor前提 / SSOT）

このドキュメントは、開発体験を安定させるための **MCP導入・運用の正本（SSOT）** です。

## 目的 / 完了条件
- Cursor で MCP を有効化し、**必須（Filesystem/Git）** が再現可能に動作する
- 推奨/条件付き（GitHub/Docker/MySQL/Terraform/AWS/Playwright）を、必要に応じて安全に追加できる
- 秘密情報（APIキー/トークン）を **リポジトリへコミットしない**

## Cursor の MCP 設定ファイル（正本）
- **ユーザー設定（推奨）**: `~/.cursor/mcp.json`
  - Windows: `%USERPROFILE%\.cursor\mcp.json`
  - macOS/Linux: `~/.cursor/mcp.json`

> NOTE: このリポジトリでは、チームで共有できるテンプレを `documents/config/` に置きます。
> 実ファイルは各開発者のホームディレクトリに配置してください。

## テンプレ（このリポジトリ内）
- テンプレ: `documents/config/cursor-mcp.template.json`
- 使い方:
  - テンプレをコピーして `~/.cursor/mcp.json` に配置
  - `<ABSOLUTE_PATH_TO_THIS_REPO>` を各自のパスに置換
- 推奨/条件付きの追記: `documents/config/cursor-mcp.optional.snippets.md` から必要なブロックだけ追加

## MCPサーバ一覧（必須 / 推奨 / 条件付き）

### 必須
#### 1) Filesystem MCP（必須）
- npm: `@modelcontextprotocol/server-filesystem`
- 重要: 許可ディレクトリを指定しないと起動時に失敗する可能性があるため、テンプレでは **リポジトリの絶対パス** を渡します。

#### 2) Git MCP（必須）
- npm: `@cyanheads/git-mcp-server`
- リポジトリ: `git+https://github.com/cyanheads/git-mcp-server.git`

### 推奨
#### GitHub MCP（推奨）
- npm: `@modelcontextprotocol/server-github`
- 必要環境変数: `GITHUB_PERSONAL_ACCESS_TOKEN`
- 注意: README 上は移行案内が出ているため、将来的に別実装へ切替が必要になる可能性があります。

#### Terraform MCP（推奨）
- npm: `terraform-mcp-server`
- 目的: Terraform Registry 操作（例: provider/module検索 等）
- リポジトリ: `https://github.com/thrashr888/terraform-mcp-server`

### 条件付き推奨（権限/運用が前提）
#### Docker MCP（推奨）
- npm候補: `mcp-docker`
- 前提: Docker Desktop が動作していること

#### MySQL MCP（推奨）
- npm候補: `@iflow-mcp/mysql-mcp-server`（read-only）
- 前提: 接続先（ローカル/コンテナ）・認証情報の扱いを決めること

#### AWS MCP（条件付き推奨）
- npm候補: `mcp-aws-devops-server`
- 前提: AWS 権限設計（最小権限）・監査の運用が必要

#### Playwright MCP（条件付き推奨）
- npm: `@playwright/mcp`
- リポジトリ: `git+https://github.com/microsoft/playwright-mcp.git`

## Browser Use / React Grab / Android Use（採用済み）
このモノレポでは、外部レポを `vendor/` に **Git submodule** として固定しています。

- Browser Use: `vendor/browser-use`
  - Cursor設定例（公式）: `vendor/browser-use/docs/customize/integrations/mcp-server.mdx`
  - 例では `~/.cursor/mcp.json` に `mcp-remote` を設定します
- React Grab: `vendor/react-grab`
  - Cursor向け provider のドキュメント: `vendor/react-grab/packages/provider-cursor/README.md`
- Android Use: `vendor/android-use`

## セキュリティ運用（必須）
- **トークン/キーは `mcp.json` に直書きしない**（誤コミット/漏えいの温床）
- 可能なら OS の環境変数や秘密情報管理（1Password/Bitwarden/SSM等）で渡す

## 疎通確認（最小）
1. Cursor を再起動
2. MCPサーバが起動しているか（Cursor側のMCP UI/ログ）を確認
3. Filesystem MCP でリポジトリ配下のファイル読み取りができること
4. Git MCP で `status` / `diff` 相当の操作ができること


