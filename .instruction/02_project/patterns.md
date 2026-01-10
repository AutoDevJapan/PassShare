## 目的
実装パターンを標準化し、レビュー負荷と偶発的なバグを減らす。

## 共通パターン
- **ガード節（早期return）**でネストを浅くする
- **失敗パスを先に書く**（バリデーション→即return）
- **変換は純関数**として切り出す（DTO→ViewModel、Domain→Schema等）
- **マジック値は禁止**（定数/Enumへ）

## バックエンド（FastAPI + DDD）
### Presentation（API）は薄く
- 入力: Pydanticで検証
- 処理: Usecaseを呼ぶ
- 出力: Schemaへ変換
- 例外: HTTPへ変換（内部例外の握り潰し禁止）

### Usecaseは「トランザクション境界」
- 1ユースケース=1責務
- リポジトリIFを使い、Infrastructure実装に直接依存しない

### InfrastructureにIOを閉じ込める
- DBアクセス/外部HTTP/ファイルはInfrastructureへ
- クエリ最適化（N+1回避）を意識し、変更前後の説明可能性を保つ

## フロント（React + TypeScript）
### UIと副作用を分離
- データ取得/保存: hooks/services
- UI: props受け取り + 描画（状態表現を揃える）

### 状態設計
- loading/error/empty/normal を必ず持つ
- エラー表示は「ユーザーが行動できる」文言に寄せる

## 例外/エラー設計（共通）
- **利用者に返すべきエラー**と**内部例外**を分ける
- ログは調査可能な粒度にし、秘密情報は出さない
