# PassShare プログラマティックAPI仕様

**© 2026 株式会社BM1314. All rights reserved.**

## 概要

このドキュメントはPassShareのプログラマティックAPI仕様を定義します。CLI以外からPassShareを利用する際のインターフェースを規定します。

## API設計原則

1. **gopass互換**: gopassのpkg/gopassパッケージと互換
2. **言語間一貫性**: Python/TypeScript/Nodeで同じAPIシグネチャ
3. **非同期対応**: I/O操作は非同期をサポート
4. **型安全**: 厳密な型定義

---

## コアAPI

### Gopass クラス（メインエントリポイント）

#### Python

```python
from passshare import Gopass, Secret

class Gopass:
    """PassShare メインAPI"""
    
    def __init__(self, config_path: Optional[str] = None):
        """
        Gopassインスタンスを初期化
        
        Args:
            config_path: 設定ファイルパス（省略時はデフォルト）
        """
        pass
    
    # シークレット操作
    def get(self, name: str) -> Secret:
        """
        シークレットを取得
        
        Args:
            name: シークレットのパス（例: "email/gmail"）
        
        Returns:
            Secret: シークレットオブジェクト
        
        Raises:
            NotFoundError: シークレットが見つからない
            DecryptError: 復号に失敗
        """
        pass
    
    def set(self, name: str, secret: Secret) -> None:
        """
        シークレットを保存
        
        Args:
            name: シークレットのパス
            secret: シークレットオブジェクト
        
        Raises:
            EncryptError: 暗号化に失敗
            StorageError: 保存に失敗
        """
        pass
    
    def delete(self, name: str) -> None:
        """
        シークレットを削除
        
        Args:
            name: シークレットのパス
        
        Raises:
            NotFoundError: シークレットが見つからない
        """
        pass
    
    def exists(self, name: str) -> bool:
        """
        シークレットが存在するか確認
        
        Args:
            name: シークレットのパス
        
        Returns:
            bool: 存在すればTrue
        """
        pass
    
    def list(self, prefix: str = "") -> List[str]:
        """
        シークレット一覧を取得
        
        Args:
            prefix: フィルタするプレフィックス
        
        Returns:
            List[str]: シークレットパスのリスト
        """
        pass
    
    # パスワード生成
    def generate(
        self,
        name: str,
        length: int = 24,
        symbols: bool = True,
        xkcd: bool = False
    ) -> str:
        """
        パスワードを生成して保存
        
        Args:
            name: シークレットのパス
            length: パスワード長
            symbols: 記号を含めるか
            xkcd: XKCD形式（単語ベース）
        
        Returns:
            str: 生成されたパスワード
        """
        pass
    
    # 同期
    def sync(self, store: Optional[str] = None) -> None:
        """
        リモートと同期
        
        Args:
            store: ストア名（省略時は全ストア）
        """
        pass
    
    # マウント
    @property
    def mounts(self) -> Dict[str, str]:
        """マウントポイント一覧"""
        pass
    
    def mount(self, alias: str, path: str) -> None:
        """マウントポイントを追加"""
        pass
    
    def unmount(self, alias: str) -> None:
        """マウントポイントを削除"""
        pass
```

#### TypeScript

```typescript
import { Secret } from './secret';

export class Gopass {
  /**
   * Gopassインスタンスを初期化
   * @param configPath - 設定ファイルパス（省略時はデフォルト）
   */
  constructor(configPath?: string);
  
  // シークレット操作
  /**
   * シークレットを取得
   * @param name - シークレットのパス
   * @returns Secret オブジェクト
   * @throws NotFoundError シークレットが見つからない
   * @throws DecryptError 復号に失敗
   */
  async get(name: string): Promise<Secret>;
  
  /**
   * シークレットを保存
   * @param name - シークレットのパス
   * @param secret - シークレットオブジェクト
   */
  async set(name: string, secret: Secret): Promise<void>;
  
  /**
   * シークレットを削除
   * @param name - シークレットのパス
   */
  async delete(name: string): Promise<void>;
  
  /**
   * シークレットが存在するか確認
   * @param name - シークレットのパス
   */
  async exists(name: string): Promise<boolean>;
  
  /**
   * シークレット一覧を取得
   * @param prefix - フィルタするプレフィックス
   */
  async list(prefix?: string): Promise<string[]>;
  
  // パスワード生成
  /**
   * パスワードを生成して保存
   */
  async generate(
    name: string,
    options?: {
      length?: number;
      symbols?: boolean;
      xkcd?: boolean;
    }
  ): Promise<string>;
  
  // 同期
  async sync(store?: string): Promise<void>;
  
  // マウント
  get mounts(): Map<string, string>;
  async mount(alias: string, path: string): Promise<void>;
  async unmount(alias: string): Promise<void>;
}
```

#### Node.js (CommonJS)

```javascript
const { Gopass, Secret } = require('passshare');

const gopass = new Gopass();

// 使用例
async function example() {
  // シークレット取得
  const secret = await gopass.get('email/gmail');
  console.log(secret.password);
  
  // シークレット一覧
  const list = await gopass.list();
  console.log(list);
  
  // パスワード生成
  const password = await gopass.generate('new/secret', { length: 32 });
  console.log(password);
}
```

---

## Secret クラス

### Python

```python
from typing import Optional, Dict, List
from datetime import datetime

class Secret:
    """シークレットを表すクラス"""
    
    def __init__(
        self,
        password: str = "",
        data: Optional[Dict[str, str]] = None,
        body: str = ""
    ):
        """
        シークレットを初期化
        
        Args:
            password: パスワード（1行目）
            data: キーバリューデータ
            body: 自由形式のノート
        """
        self._password = password
        self._data = data or {}
        self._body = body
    
    @property
    def password(self) -> str:
        """パスワード（1行目）"""
        return self._password
    
    @password.setter
    def password(self, value: str) -> None:
        self._password = value
    
    def get(self, key: str, default: str = "") -> str:
        """
        キーに対応する値を取得
        
        Args:
            key: キー名
            default: デフォルト値
        
        Returns:
            str: 値
        """
        return self._data.get(key, default)
    
    def set(self, key: str, value: str) -> None:
        """
        キーバリューを設定
        
        Args:
            key: キー名
            value: 値
        """
        self._data[key] = value
    
    def keys(self) -> List[str]:
        """全キーを取得"""
        return list(self._data.keys())
    
    @property
    def body(self) -> str:
        """自由形式のノート"""
        return self._body
    
    @body.setter
    def body(self, value: str) -> None:
        self._body = value
    
    @property
    def otp_uri(self) -> Optional[str]:
        """OTP URI（存在する場合）"""
        for key, value in self._data.items():
            if value.startswith("otpauth://"):
                return value
        return None
    
    def otp(self) -> Optional[str]:
        """
        現在のOTPコードを生成
        
        Returns:
            str: OTPコード（6桁）
            None: OTP URIがない場合
        """
        pass
    
    def to_bytes(self) -> bytes:
        """シークレットをバイト列にシリアライズ"""
        pass
    
    @classmethod
    def from_bytes(cls, data: bytes) -> "Secret":
        """バイト列からシークレットをデシリアライズ"""
        pass
    
    def __str__(self) -> str:
        """文字列表現"""
        lines = [self._password]
        if self._data:
            lines.append("---")
            for key, value in self._data.items():
                lines.append(f"{key}: {value}")
        if self._body:
            lines.append("---")
            lines.append(self._body)
        return "\n".join(lines)
```

### TypeScript

```typescript
export class Secret {
  private _password: string;
  private _data: Map<string, string>;
  private _body: string;
  
  constructor(
    password: string = "",
    data?: Map<string, string> | Record<string, string>,
    body: string = ""
  );
  
  // パスワード
  get password(): string;
  set password(value: string);
  
  // キーバリュー
  get(key: string, defaultValue?: string): string;
  set(key: string, value: string): void;
  keys(): string[];
  
  // ノート
  get body(): string;
  set body(value: string);
  
  // OTP
  get otpUri(): string | null;
  otp(): string | null;
  
  // シリアライズ
  toBuffer(): Buffer;
  static fromBuffer(data: Buffer): Secret;
  
  toString(): string;
}
```

---

## エラークラス

### Python

```python
class PassShareError(Exception):
    """PassShare基底エラー"""
    pass

class NotFoundError(PassShareError):
    """シークレットが見つからない"""
    def __init__(self, name: str):
        self.name = name
        super().__init__(f"Secret not found: {name}")

class DecryptError(PassShareError):
    """復号エラー"""
    def __init__(self, message: str = "Decryption failed"):
        super().__init__(message)

class EncryptError(PassShareError):
    """暗号化エラー"""
    def __init__(self, message: str = "Encryption failed"):
        super().__init__(message)

class StorageError(PassShareError):
    """ストレージエラー"""
    pass

class ConfigError(PassShareError):
    """設定エラー"""
    pass

class NotInitializedError(PassShareError):
    """ストアが初期化されていない"""
    pass
```

### TypeScript

```typescript
export class PassShareError extends Error {
  constructor(message: string);
}

export class NotFoundError extends PassShareError {
  constructor(public readonly name: string);
}

export class DecryptError extends PassShareError {
  constructor(message?: string);
}

export class EncryptError extends PassShareError {
  constructor(message?: string);
}

export class StorageError extends PassShareError {
  constructor(message: string);
}

export class ConfigError extends PassShareError {
  constructor(message: string);
}

export class NotInitializedError extends PassShareError {
  constructor(storePath?: string);
}
```

---

## パスワード生成API

### Python

```python
def generate_password(
    length: int = 24,
    symbols: bool = True,
    no_symbols: bool = False,
    xkcd: bool = False,
    xkcd_separator: str = "-",
    xkcd_lang: str = "en"
) -> str:
    """
    パスワードを生成（スタンドアロン）
    
    Args:
        length: パスワード長（文字数または単語数）
        symbols: 記号を含める
        no_symbols: 記号を除外（symbolsより優先）
        xkcd: XKCD形式（単語ベース）
        xkcd_separator: 単語の区切り文字
        xkcd_lang: 単語リストの言語
    
    Returns:
        str: 生成されたパスワード
    """
    pass

# 使用例
password = generate_password(length=32, symbols=True)
xkcd_password = generate_password(xkcd=True, length=4, xkcd_separator="-")
```

### TypeScript

```typescript
export function generatePassword(options?: {
  length?: number;
  symbols?: boolean;
  noSymbols?: boolean;
  xkcd?: boolean;
  xkcdSeparator?: string;
  xkcdLang?: string;
}): string;

// 使用例
const password = generatePassword({ length: 32, symbols: true });
const xkcdPassword = generatePassword({ xkcd: true, length: 4 });
```

---

## OTP API

### Python

```python
from passshare.otp import TOTP, HOTP, parse_otp_uri

class TOTP:
    """TOTP (Time-based One-Time Password)"""
    
    def __init__(
        self,
        secret: str,  # Base32エンコード
        digits: int = 6,
        period: int = 30,
        algorithm: str = "SHA1"
    ):
        pass
    
    def generate(self) -> str:
        """現在のTOTPコードを生成"""
        pass
    
    def verify(self, code: str, window: int = 1) -> bool:
        """コードを検証"""
        pass
    
    @property
    def remaining_seconds(self) -> int:
        """現在のコードの残り有効時間"""
        pass

class HOTP:
    """HOTP (HMAC-based One-Time Password)"""
    
    def __init__(
        self,
        secret: str,
        digits: int = 6,
        counter: int = 0,
        algorithm: str = "SHA1"
    ):
        pass
    
    def generate(self) -> str:
        """現在のHOTPコードを生成"""
        pass
    
    def verify(self, code: str, window: int = 10) -> bool:
        """コードを検証"""
        pass

def parse_otp_uri(uri: str) -> Union[TOTP, HOTP]:
    """
    OTP URIをパースしてTOTP/HOTPオブジェクトを返す
    
    Args:
        uri: otpauth://totp/... または otpauth://hotp/...
    
    Returns:
        TOTP または HOTP オブジェクト
    """
    pass
```

---

## クリップボードAPI

### Python

```python
from passshare.clipboard import copy_to_clipboard, clear_clipboard

def copy_to_clipboard(
    text: str,
    timeout: int = 45,
    clear_previous: bool = True
) -> None:
    """
    テキストをクリップボードにコピー
    
    Args:
        text: コピーするテキスト
        timeout: 自動クリアまでの秒数（0で無効）
        clear_previous: 以前のタイマーをキャンセル
    """
    pass

def clear_clipboard() -> None:
    """クリップボードをクリア"""
    pass
```

---

## 使用例

### Python

```python
from passshare import Gopass, Secret

# 初期化
gopass = Gopass()

# シークレット取得
secret = gopass.get("email/gmail")
print(f"Password: {secret.password}")
print(f"Username: {secret.get('username')}")

# OTPコード生成
if secret.otp_uri:
    print(f"OTP: {secret.otp()}")

# 新しいシークレットを作成
new_secret = Secret(
    password="super-secure-password",
    data={"username": "john@example.com", "url": "https://example.com"}
)
gopass.set("new/secret", new_secret)

# パスワード生成
password = gopass.generate("another/secret", length=32, symbols=True)
print(f"Generated: {password}")

# 一覧表示
for name in gopass.list():
    print(name)

# 同期
gopass.sync()
```

### TypeScript

```typescript
import { Gopass, Secret } from 'passshare';

async function main() {
  const gopass = new Gopass();
  
  // シークレット取得
  const secret = await gopass.get('email/gmail');
  console.log(`Password: ${secret.password}`);
  console.log(`Username: ${secret.get('username')}`);
  
  // OTPコード生成
  if (secret.otpUri) {
    console.log(`OTP: ${secret.otp()}`);
  }
  
  // 新しいシークレットを作成
  const newSecret = new Secret(
    'super-secure-password',
    { username: 'john@example.com', url: 'https://example.com' }
  );
  await gopass.set('new/secret', newSecret);
  
  // パスワード生成
  const password = await gopass.generate('another/secret', { length: 32 });
  console.log(`Generated: ${password}`);
  
  // 一覧表示
  const list = await gopass.list();
  list.forEach(name => console.log(name));
  
  // 同期
  await gopass.sync();
}

main().catch(console.error);
```

---

## テスト用モック

### Python

```python
from passshare.mock import MockGopass

# テスト用モック
mock = MockGopass()
mock.add_secret("test/secret", Secret(password="test123"))

# テスト
secret = mock.get("test/secret")
assert secret.password == "test123"
```

### TypeScript

```typescript
import { MockGopass, Secret } from 'passshare/testing';

// テスト用モック
const mock = new MockGopass();
mock.addSecret('test/secret', new Secret('test123'));

// テスト
const secret = await mock.get('test/secret');
expect(secret.password).toBe('test123');
```
