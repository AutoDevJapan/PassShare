# PassShare 暗号化仕様

## 概要

このドキュメントはPassShareの暗号化バックエンド仕様を定義します。

**互換性**: pass/gopass形式と完全互換の暗号化方式を使用します。GPG/Ageで暗号化された既存ストアをそのまま利用できます。

## サポートする暗号化バックエンド

| バックエンド | 拡張子 | 説明 |
|-------------|--------|------|
| GPG | `.gpg` | GnuPG 2.x（デフォルト） |
| Age | `.age` | age encryption |
| Plain | なし | 暗号化なし（テスト用） |

---

## 1. GPG バックエンド（デフォルト）

### 概要

GnuPG 2.xを使用した非対称暗号化。

### 依存関係

- `gpg` (GnuPG) 2.x
- `gpg-agent`

### 暗号化フロー

```
1. .gpg-idから受信者鍵IDを読み込み
2. 各受信者の公開鍵を取得
3. gpgで暗号化（複数受信者対応）
4. 暗号化データをファイルに書き込み
```

### 暗号化コマンド

```bash
gpg --encrypt \
    --recipient 0xFEEDBEEF \
    --recipient 0xDEADBEEF \
    --armor \
    --batch \
    --yes \
    --output secret.gpg \
    plaintext.txt
```

**オプション説明:**
- `--encrypt`: 暗号化モード
- `--recipient`: 受信者の鍵ID（複数指定可能）
- `--armor`: ASCII armor出力（テキスト形式）
- `--batch`: 非インタラクティブモード
- `--yes`: 自動確認
- `--output`: 出力ファイル

### 復号コマンド

```bash
gpg --decrypt \
    --batch \
    --yes \
    --output plaintext.txt \
    secret.gpg
```

### 鍵管理

#### 鍵のインポート

```bash
gpg --import public-key.asc
```

#### 鍵の信頼設定

```bash
gpg --edit-key 0xFEEDBEEF trust
```

#### 鍵の一覧

```bash
gpg --list-keys --keyid-format long
gpg --list-secret-keys --keyid-format long
```

### 受信者ファイル（.gpg-id）

```
# 受信者GPG鍵ID
0xFEEDBEEF
0xDEADBEEF

# コメント行は無視
# 空行も無視
```

### エラーハンドリング

| エラー | 原因 | 対処 |
|--------|------|------|
| `gpg: decryption failed: No secret key` | 秘密鍵がない | 秘密鍵をインポート |
| `gpg: public key not found` | 公開鍵がない | 公開鍵をインポート |
| `gpg: unusable public key` | 鍵が期限切れ/失効 | 鍵を更新 |
| `gpg: signing failed: Inappropriate ioctl` | gpg-agentの問題 | `GPG_TTY=$(tty); export GPG_TTY` |

---

## 2. Age バックエンド

### 概要

[age](https://age-encryption.org/)を使用したモダンな暗号化。

### 依存関係

- `age`コマンドラインツール
- `age-keygen`（鍵生成用）

### 鍵形式

#### 秘密鍵

```
# created: 2024-01-10T14:30:00Z
# public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
AGE-SECRET-KEY-1QFGSK7Y3XNFXW4L87SWJV7FHKA0ZXQWE2HFZQQ6DRQTXPE8W7SQPRNGWE
```

#### 公開鍵

```
age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
```

### 受信者ファイル（.age-recipients）

```
# Age公開鍵
age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
age1hzp7rgx84d9q8n5fvwyvl9jnqt2p0h3xj8zq8y5v6m4d2r7s0c3a5f6g7h
```

### 暗号化コマンド

```bash
age --encrypt \
    --recipient age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p \
    --recipient age1hzp7rgx84d9q8n5fvwyvl9jnqt2p0h3xj8zq8y5v6m4d2r7s0c3a5f6g7h \
    --output secret.age \
    plaintext.txt
```

### 復号コマンド

```bash
age --decrypt \
    --identity ~/.config/age/key.txt \
    --output plaintext.txt \
    secret.age
```

### 鍵生成

```bash
age-keygen -o ~/.config/age/key.txt
```

### GPGとAgeの比較

| 特徴 | GPG | Age |
|------|-----|-----|
| 暗号方式 | RSA/ECDSA | X25519/ChaCha20-Poly1305 |
| 鍵サイズ | 2048-4096 bit | 256 bit |
| 複雑さ | 高 | 低 |
| 信頼の輪 | あり | なし |
| 署名 | あり | なし |
| 互換性 | 広い | 限定的 |

---

## 3. Plain バックエンド（テスト用）

### 概要

暗号化なしでファイルを保存。**本番環境での使用は禁止**。

### 用途

- 単体テスト
- 開発/デバッグ

### 警告

```
⚠️ WARNING: Plain backend is not secure!
Do not use in production.
```

---

## 暗号化インターフェース

### Go互換インターフェース

```go
type Crypto interface {
    // 暗号化/復号
    Encrypt(ctx context.Context, plaintext []byte, recipients []string) ([]byte, error)
    Decrypt(ctx context.Context, ciphertext []byte) ([]byte, error)
    
    // 受信者
    RecipientIDs(ctx context.Context, ciphertext []byte) ([]string, error)
    
    // 鍵管理
    ListPublicKeys(ctx context.Context) ([]string, error)
    ListPrivateKeys(ctx context.Context) ([]string, error)
    FindPublicKeys(ctx context.Context, search ...string) ([]string, error)
    FindPrivateKeys(ctx context.Context, search ...string) ([]string, error)
    
    // メタデータ
    Name() string
    Version(ctx context.Context) string
    Ext() string
    IDFile() string
}
```

### Python互換インターフェース

```python
from abc import ABC, abstractmethod
from typing import List
from pathlib import Path

class CryptoBackend(ABC):
    """暗号化バックエンドの抽象基底クラス"""
    
    @abstractmethod
    def encrypt(self, plaintext: bytes, recipients: List[str]) -> bytes:
        """平文を暗号化"""
        pass
    
    @abstractmethod
    def decrypt(self, ciphertext: bytes) -> bytes:
        """暗号文を復号"""
        pass
    
    @abstractmethod
    def recipient_ids(self, ciphertext: bytes) -> List[str]:
        """暗号文から受信者IDを取得"""
        pass
    
    @abstractmethod
    def list_public_keys(self) -> List[str]:
        """利用可能な公開鍵一覧"""
        pass
    
    @abstractmethod
    def list_private_keys(self) -> List[str]:
        """利用可能な秘密鍵一覧"""
        pass
    
    @property
    @abstractmethod
    def name(self) -> str:
        """バックエンド名"""
        pass
    
    @property
    @abstractmethod
    def ext(self) -> str:
        """ファイル拡張子（例: .gpg）"""
        pass
    
    @property
    @abstractmethod
    def id_file(self) -> str:
        """受信者IDファイル名（例: .gpg-id）"""
        pass
```

### TypeScript互換インターフェース

```typescript
interface CryptoBackend {
  // 暗号化/復号
  encrypt(plaintext: Buffer, recipients: string[]): Promise<Buffer>;
  decrypt(ciphertext: Buffer): Promise<Buffer>;
  
  // 受信者
  recipientIDs(ciphertext: Buffer): Promise<string[]>;
  
  // 鍵管理
  listPublicKeys(): Promise<string[]>;
  listPrivateKeys(): Promise<string[]>;
  findPublicKeys(search: string[]): Promise<string[]>;
  findPrivateKeys(search: string[]): Promise<string[]>;
  
  // メタデータ
  readonly name: string;
  readonly ext: string;
  readonly idFile: string;
  version(): Promise<string>;
}
```

---

## シークレット形式（復号後）

### 基本形式

```
password-on-first-line
key1: value1
key2: value2
```

### 拡張形式（YAML境界付き）

```
password-on-first-line
---
username: john@example.com
url: https://example.com
totp: otpauth://totp/...
---
Additional notes can go here.
This is freeform text.
```

### パース規則

1. 1行目は常にパスワード
2. `---`で区切られたセクションはYAML/KV形式
3. 2つ目の`---`以降は自由形式のノート
4. `otpauth://`で始まる行はOTP URI

---

## セキュリティ考慮事項

### メモリ管理

- 復号後の平文はメモリに最小限の時間のみ保持
- 使用後は明示的にゼロクリア
- スワップへの書き込みを防ぐ（mlock等）

### 一時ファイル

- 一時ファイルは`0600`権限で作成
- 可能であればtmpfs（メモリファイルシステム）を使用
- 使用後は安全に削除（shred等）

### プロセスセキュリティ

- 環境変数でパスワードを渡さない
- コマンドライン引数に秘密情報を含めない
- GPG_TTYを適切に設定

### クリップボード

- デフォルト45秒後に自動クリア
- 他のプロセスからのアクセスに注意
- Waylandでは制限あり

---

## バックエンド検出

### 自動検出ロジック

```
1. .gpg-idが存在 → GPGバックエンド
2. .age-recipientsが存在 → Ageバックエンド
3. どちらもない → 初期化が必要
4. 両方存在 → .gpg-idを優先（警告を表示）
```

### 明示的指定

```bash
passshare init --crypto gpg 0xFEEDBEEF
passshare init --crypto age age1...
```

---

## 鍵ローテーション

### 受信者追加時

```
1. .gpg-id（または.age-recipients）に新しい鍵を追加
2. 全シークレットを復号
3. 新しい受信者リストで再暗号化
4. コミット
```

### 受信者削除時

```
1. .gpg-id（または.age-recipients）から鍵を削除
2. 全シークレットを復号
3. 新しい受信者リストで再暗号化（削除された鍵では復号不可に）
4. コミット
5. リモートにプッシュ
```

---

## トラブルシューティング

### GPG

```bash
# gpg-agentを再起動
gpgconf --kill gpg-agent
gpg-agent --daemon

# TTYを設定
export GPG_TTY=$(tty)

# キャッシュをクリア
gpg-connect-agent reloadagent /bye
```

### Age

```bash
# 鍵の場所を確認
ls -la ~/.config/age/

# 環境変数で鍵を指定
export AGE_KEY_FILE=~/.config/age/key.txt
```
