## 目的
`documents/config/cursor-mcp.template.json` は **必須（Filesystem/Git）だけ**を含む安全なテンプレです。
推奨/条件付きのMCPは、ここから **必要なブロックだけ**を `~/.cursor/mcp.json` の `mcpServers` に追記してください。

## GitHub MCP（推奨）
前提: `GITHUB_PERSONAL_ACCESS_TOKEN` を環境変数で渡す（トークン直書きは非推奨）

```json
"github": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"]
}
```

## Terraform MCP（推奨）

```json
"terraform": {
  "command": "npx",
  "args": ["-y", "terraform-mcp-server"]
}
```

## Playwright MCP（条件付き推奨）

```json
"playwright": {
  "command": "npx",
  "args": ["-y", "@playwright/mcp"]
}
```

## Docker MCP（推奨）
前提: Docker Desktop が起動している

```json
"docker": {
  "command": "npx",
  "args": ["-y", "mcp-docker"]
}
```

## MySQL MCP（推奨 / read-only）
前提: 接続先と認証情報の運用を決める

```json
"mysql": {
  "command": "npx",
  "args": ["-y", "@iflow-mcp/mysql-mcp-server"]
}
```

## AWS MCP（条件付き推奨）
前提: 最小権限・監査・秘密情報管理の運用がある

```json
"aws-devops": {
  "command": "npx",
  "args": ["-y", "mcp-aws-devops-server"]
}
```


