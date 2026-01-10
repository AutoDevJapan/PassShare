## 環境変数（ローカル開発）
このリポジトリでは、ルート `docker-compose.yml` が **`.env`（リポジトリ直下）** を参照します。
`.env` は秘密情報を含むため **Git管理しません**。

## テンプレ（正本）
- ルート `.env` → `env.example` をコピーして作成
- フロント（Vite）`.env.local` → `env.electron.example` を `electron/.env.local` としてコピー

## 作り方
### PowerShell（Windows）

```powershell
Copy-Item env.example .env
Copy-Item env.electron.example electron/.env.local
# 必要に応じて API キーを編集
notepad .env
```

### bash（macOS/Linux/WSL）

```bash
cp env.example .env
cp env.electron.example electron/.env.local
# 必要に応じて API キーを編集
```

## 最低限設定すべき項目
- `OPENAI_API_KEY` または `ANTHROPIC_API_KEY`（LLM機能を使う場合）
- `VITE_API_BEARER_TOKEN`（管理者に共有してもらう）

## 主な環境変数（参考）

### `.env`（ルート直下）
| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `MYSQL_ROOT_PASSWORD` | MySQL root パスワード | `password` |
| `MYSQL_USER` | MySQL ユーザー | `rpa_user` |
| `MYSQL_PASSWORD` | MySQL パスワード | `password` |
| `MYSQL_DATABASE` | データベース名 | `rpa_backend` |
| `DB_HOST` | DB ホスト | `localhost` |
| `DB_PORT` | DB ポート | `3306` |
| `API_HOST` | API ホスト | `0.0.0.0` |
| `API_PORT` | API ポート | `8000` |
| `ALLOWED_ORIGINS` | CORS許可オリジン | `http://localhost:5173,...` |
| `LLM_PROVIDER` | LLMプロバイダ | `anthropic` |
| `OPENAI_API_KEY` | OpenAI APIキー | （要設定） |
| `ANTHROPIC_API_KEY` | Anthropic APIキー | （要設定） |

### `electron/.env.local`（フロント用）
| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `VITE_API_BASE_URL` | Backend API URL | `http://127.0.0.1:8000` |
| `VITE_API_BEARER_TOKEN` | Bearer Token | （管理者に確認） |

