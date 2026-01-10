## Usecase Spec Template（DDD / Clean Architecture）

### 概要
- **ユースケース名**:
- **目的**:
- **呼び出し元**: （API/UI/バッチ等）

### 入力
- 入力DTO:
- バリデーション:

### 出力
- 出力DTO:
- 返すべき情報:

### 主要フロー
1.
2.

### 例外/エラー
- ドメインエラー:
- ユースケースエラー:
- HTTPマッピング（必要なら）:

### トランザクション境界
- どこで開始/終了するか:
- リトライ/冪等性:

### リポジトリ/外部依存
- Repository IF:
- 外部I/O:

### テスト観点
- unit（Domain/Usecase）:
- integration（DB/API）:

### 実装参照（必須）
- Usecase実装:
- Presentation（API/UI）:
- Repository実装（Infra）:

### テスト/検証参照（必須）
- 実行コマンド:
- 手動検証手順（必要なら）:


