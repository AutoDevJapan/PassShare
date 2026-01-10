## Error Codes Spec Template

### 方針
- **ユーザーに返すエラー**と**内部エラー**を分ける
- APIの `detail` は「利用者が行動できる粒度」にする（内部情報はログへ）

### エラーコード一覧（例）
| code | http_status | user_message | retryable | notes |
|------|-------------|--------------|----------|-------|
| VALIDATION_ERROR | 422 | 入力内容を確認してください | false | Pydanticバリデーション |
| NOT_FOUND | 404 | 対象が見つかりません | false | |
| CONFLICT | 409 | 競合が発生しました | true | 楽観ロック等 |
| INTERNAL_ERROR | 500 | 予期せぬエラーが発生しました | true | 追跡IDをログに残す |

### ログ方針
- logger名:
- log level:
- 追跡ID:


