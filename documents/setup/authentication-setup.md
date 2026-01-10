# 認証機能セットアップ手順書

ユーザーログイン機能（US-063 / US-064）のセットアップ手順です。

## 目次

1. [開発環境セットアップ](#開発環境セットアップ)
2. [本番環境セットアップ](#本番環境セットアップ)
3. [パスワード再設定メール送信の実装](#パスワード再設定メール送信の実装)
4. [トラブルシューティング](#トラブルシューティング)

---

## 開発環境セットアップ

### 1. 依存関係のインストール

```bash
cd backend
uv sync
```

これにより、以下のパッケージがインストールされます：
- `bcrypt>=4.3.0` - パスワードハッシュ化
- `PyJWT>=2.10.0` - JWTトークン生成・検証

### 2. 環境変数の設定

`.env` ファイルに以下を追加（`env.example` を参照）：

```bash
# JWT Authentication Settings
JWT_SECRET_KEY=rpa-ai-jwt-secret-key-change-me-in-production
JWT_ACCESS_TOKEN_EXPIRE_MINUTES=60
```

> ⚠️ **注意**: 開発環境でもセキュアなキーを使用することを推奨します。

### 3. DBコンテナの起動

```bash
# プロジェクトルートで実行
docker compose up -d
```

### 4. マイグレーションの実行

```bash
cd backend
uv run alembic upgrade head
```

成功すると、`users` テーブルが作成されます。

### 5. テストユーザーの作成

```bash
cd backend
uv run python scripts/seed_all.py
```

以下のテストアカウントが作成されます：

| 表示名 | メールアドレス | パスワード | 権限 |
|--------|---------------|-----------|------|
| 田中太郎 | tanaka@example.com | password123 | 法人管理者 |
| 佐藤花子 | sato@example.com | password123 | 法人管理者 |
| 鈴木一郎 | group-admin@example.com | password123 | グループ管理者 |
| 佐藤直樹 | sato.naoki@example.com | password123 | 一般 |

> **ロール仕様** (参照: `documents/spec/features/roles-and-permissions.md`)
> - **法人管理者**: デスクトップアプリ + 管理画面ログイン可
> - **グループ管理者**: デスクトップアプリ + 管理画面ログイン可
> - **一般**: デスクトップアプリのみ（管理画面ログイン不可）

### 6. 動作確認

#### APIテスト（curlコマンド）

```bash
# ログイン
curl -X POST http://localhost:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "tanaka@example.com", "password": "password123"}'

# 期待レスポンス
{
  "access_token": "eyJhbG...",
  "token_type": "bearer",
  "expires_in": 3600,
  "admin": {
    "id": "a0000000-0000-0000-0000-000000000001",
    "email": "admin@example.com",
    "role": "corporate_admin",
    ...
  }
}
```

```bash
# パスワード再設定リクエスト
curl -X POST http://localhost:8000/api/v1/auth/password-reset \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com"}'

# 期待レスポンス（メールアドレスの存在有無に関わらず同じ）
{
  "message": "登録されているメールアドレスの場合、パスワード再設定用のメールを送信しました。"
}
```

#### フロントエンド確認

1. フロントエンドを起動: `pnpm -C electron dev`
2. ブラウザで `http://localhost:5173/#/login` にアクセス
3. テストアカウントでログイン

---

## 本番環境セットアップ

### 1. JWT秘密鍵の生成

**必須**: 本番環境では安全なランダムキーを使用してください。

```bash
# Pythonでセキュアなキーを生成
python -c "import secrets; print(secrets.token_urlsafe(32))"

# 出力例: xJ7kL9mN2pQ4rS6tU8vW0yZ1aB3cD5eF
```

### 2. 環境変数の設定

本番環境では以下の方法で設定します：

#### AWS Parameter Store（推奨）

```bash
# Parameter Storeに登録
aws ssm put-parameter \
  --name "/rpa-ai/prd/JWT_SECRET_KEY" \
  --value "生成したキー" \
  --type "SecureString"

aws ssm put-parameter \
  --name "/rpa-ai/prd/JWT_ACCESS_TOKEN_EXPIRE_MINUTES" \
  --value "60" \
  --type "String"
```

#### ECS タスク定義

```json
{
  "containerDefinitions": [
    {
      "secrets": [
        {
          "name": "JWT_SECRET_KEY",
          "valueFrom": "arn:aws:ssm:ap-northeast-1:ACCOUNT_ID:parameter/rpa-ai/prd/JWT_SECRET_KEY"
        }
      ],
      "environment": [
        {
          "name": "JWT_ACCESS_TOKEN_EXPIRE_MINUTES",
          "value": "60"
        }
      ]
    }
  ]
}
```

### 3. マイグレーションの実行

本番環境でのマイグレーション実行手順：

```bash
# 1. ECSタスクに接続（Session Manager経由）
aws ecs execute-command \
  --cluster rpa-ai-prd \
  --task TASK_ID \
  --container api \
  --interactive \
  --command "/bin/sh"

# 2. マイグレーション実行
cd /app
alembic upgrade head
```

### 4. 初期管理者アカウントの作成

本番環境では `seed_all.py` を使用せず、個別にアカウントを作成してください：

```python
# backend/scripts/create_admin.py として保存
import asyncio
import bcrypt
from uuid import uuid4
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.infrastructure.database.config import get_database_settings
from app.infrastructure.database.dto.corporate_admin import CorporateAdminDTO
from app.domain.entities.corporate_admin import AdminRole


async def create_admin(email: str, password: str, role: str = "corporate_admin"):
    settings = get_database_settings()
    engine = create_async_engine(settings.get_database_url(), echo=False)
    session_local = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")

    admin_role = AdminRole.CORPORATE_ADMIN if role == "corporate_admin" else AdminRole.GROUP_ADMIN

    async with session_local() as session:
        admin = CorporateAdminDTO(
            id=uuid4().bytes,
            email=email,
            hashed_password=hashed,
            role=admin_role,
            company_id=None,
            is_active=True,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        session.add(admin)
        await session.commit()
        print(f"Created admin: {email}")

    await engine.dispose()


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python create_admin.py <email> <password> [role]")
        sys.exit(1)

    email = sys.argv[1]
    password = sys.argv[2]
    role = sys.argv[3] if len(sys.argv) > 3 else "corporate_admin"

    asyncio.run(create_admin(email, password, role))
```

実行例：

```bash
uv run python scripts/create_admin.py admin@yourcompany.com SecurePassword123!
```

### 5. セキュリティチェックリスト

- [ ] JWT_SECRET_KEY は32文字以上のランダムな値
- [ ] JWT_SECRET_KEY は Parameter Store で SecureString として保存
- [ ] パスワードポリシーを設定（最小8文字、複雑さ要件など）
- [ ] HTTPS のみでアクセス可能
- [ ] ログにパスワードやトークンが出力されていない
- [ ] 認証失敗時のレート制限を設定（将来実装）

---

## パスワード再設定メール送信の実装

現在、パスワード再設定メール送信は TODO 状態です。以下の手順で実装してください。

### 1. メール送信サービスの選定

推奨オプション：
- **Amazon SES** - AWS環境での利用に最適
- **SendGrid** - 信頼性の高いメール配信サービス
- **Mailgun** - 開発者向けのシンプルなAPI

### 2. 実装ファイル構成

```
backend/app/infrastructure/
├── email/
│   ├── __init__.py
│   ├── config.py          # メール設定
│   ├── templates/          # メールテンプレート
│   │   └── password_reset.html
│   └── service.py          # メール送信サービス
```

### 3. 実装手順

#### Step 1: メール設定を追加

```python
# backend/app/infrastructure/email/config.py
import os
from pydantic_settings import BaseSettings


class EmailSettings(BaseSettings):
    smtp_host: str = os.getenv("SMTP_HOST", "")
    smtp_port: int = int(os.getenv("SMTP_PORT", "587"))
    smtp_user: str = os.getenv("SMTP_USER", "")
    smtp_password: str = os.getenv("SMTP_PASSWORD", "")
    from_email: str = os.getenv("FROM_EMAIL", "noreply@example.com")
    from_name: str = os.getenv("FROM_NAME", "RPA AI")

    # パスワードリセットトークンの有効期限（分）
    password_reset_token_expire_minutes: int = 30
```

#### Step 2: パスワードリセットトークンの生成

```python
# backend/app/usecase/auth.py に追加

import secrets
from datetime import datetime, timedelta, timezone

# トークン保存用（本番ではRedisなどを使用）
_password_reset_tokens: dict[str, tuple[UUID, datetime]] = {}


def _generate_reset_token(admin_id: UUID) -> str:
    """パスワードリセットトークンを生成."""
    token = secrets.token_urlsafe(32)
    expire = datetime.now(timezone.utc) + timedelta(minutes=30)
    _password_reset_tokens[token] = (admin_id, expire)
    return token


def _verify_reset_token(token: str) -> UUID | None:
    """トークンを検証し、有効なら管理者IDを返す."""
    if token not in _password_reset_tokens:
        return None

    admin_id, expire = _password_reset_tokens[token]
    if datetime.now(timezone.utc) > expire:
        del _password_reset_tokens[token]
        return None

    return admin_id
```

#### Step 3: メール送信サービス

```python
# backend/app/infrastructure/email/service.py
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from app.infrastructure.email.config import EmailSettings


class EmailService:
    def __init__(self):
        self.settings = EmailSettings()

    async def send_password_reset_email(self, to_email: str, reset_token: str) -> None:
        """パスワードリセットメールを送信."""
        reset_url = f"https://your-domain.com/password-reset/confirm?token={reset_token}"

        msg = MIMEMultipart("alternative")
        msg["Subject"] = "【RPA AI】パスワード再設定のご案内"
        msg["From"] = f"{self.settings.from_name} <{self.settings.from_email}>"
        msg["To"] = to_email

        html = f"""
        <html>
        <body>
            <p>パスワード再設定のリクエストを受け付けました。</p>
            <p>以下のリンクをクリックして、新しいパスワードを設定してください：</p>
            <p><a href="{reset_url}">{reset_url}</a></p>
            <p>このリンクは30分間有効です。</p>
            <p>このメールに心当たりがない場合は、無視してください。</p>
        </body>
        </html>
        """
        msg.attach(MIMEText(html, "html"))

        with smtplib.SMTP(self.settings.smtp_host, self.settings.smtp_port) as server:
            server.starttls()
            server.login(self.settings.smtp_user, self.settings.smtp_password)
            server.sendmail(self.settings.from_email, to_email, msg.as_string())
```

#### Step 4: ユースケースを更新

```python
# backend/app/usecase/auth.py の request_password_reset を更新

async def request_password_reset(
    self, input_data: PasswordResetRequestInput
) -> PasswordResetRequestOutput:
    """パスワード再設定リクエスト."""
    admin = await self._admin_repository.find_by_email(input_data.email)

    if admin:
        reset_token = _generate_reset_token(admin.id)
        email_service = EmailService()
        await email_service.send_password_reset_email(admin.email, reset_token)

    # セキュリティ: メールの存在有無に関わらず同じレスポンス
    return PasswordResetRequestOutput(
        message="登録されているメールアドレスの場合、パスワード再設定用のメールを送信しました。"
    )
```

### 4. 環境変数の追加

```bash
# .env に追加
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
FROM_EMAIL=noreply@yourcompany.com
FROM_NAME=RPA AI
```

---

## トラブルシューティング

### マイグレーションエラー

**エラー**: `Can't locate revision identified by '9c2d6f4e1a0b'`

**解決策**: マイグレーション履歴を確認し、down_revision を修正

```bash
uv run alembic history
```

### ログインできない

**確認項目**:
1. DBにユーザーが存在するか
2. パスワードが正しいか
3. `is_active` が `True` か

```sql
SELECT email, is_active FROM corporate_admins WHERE email = 'admin@example.com';
```

### JWTトークンエラー

**エラー**: `InvalidSignatureError`

**原因**: JWT_SECRET_KEY が環境間で異なる

**解決策**: 同じ秘密鍵を使用しているか確認

---

## 関連ドキュメント

- [認証API仕様](../spec/api/auth.md)
- [ログイン画面仕様](../spec/products/corporate-admin/screens/login/requirements.md)
- [環境変数設定](./environment-variables.md)

