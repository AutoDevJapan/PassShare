# PassShare ストレージ仕様

## 概要

このドキュメントはPassShareのストレージバックエンド仕様を定義します。

**互換性**: pass/gopass形式と完全互換のファイル形式とディレクトリ構造を使用します。既存のpass/gopassストアをそのまま利用できます。

## ディレクトリ構造

### デフォルトパス

| OS | パス |
|----|------|
| Linux | `~/.local/share/gopass/stores/root` |
| macOS | `~/.local/share/gopass/stores/root` |
| Windows | `%APPDATA%\gopass\stores\root` |

### ストア構造

```
~/.local/share/gopass/stores/root/
├── .gpg-id                     # 受信者GPG鍵ID一覧
├── .gopass-recipients          # 受信者メタデータ（オプション）
├── .public-keys/               # エクスポートされた公開鍵（オプション）
│   ├── 0xFEEDBEEF.asc
│   └── 0xDEADBEEF.asc
├── .gitattributes              # Git属性
├── .extensions/                # カスタム拡張（オプション）
├── email/
│   ├── gmail.gpg               # 暗号化されたシークレット
│   └── work.gpg
├── social/
│   ├── twitter.gpg
│   └── facebook.gpg
├── .templates/                 # テンプレートディレクトリ
│   └── website.yml
└── .git/                       # Gitリポジトリ（gitfsバックエンド）
```

## ファイル形式

### .gpg-id

受信者のGPG鍵IDを1行1IDで記載。

```
0xFEEDBEEF
0xDEADBEEF
0xCAFEBABE
```

**仕様:**
- 行コメント: `#`で始まる行は無視
- 空行: 無視
- 形式: 16進数の鍵ID（0x接頭辞あり/なし）

---

### .gopass-recipients

受信者の追加メタデータ（オプション）。

```yaml
version: 1
recipients:
  - id: 0xFEEDBEEF
    name: John Doe
    email: john@example.com
    added: 2024-01-10T14:30:00Z
  - id: 0xDEADBEEF
    name: Jane Smith
    email: jane@example.com
    added: 2024-01-05T09:15:00Z
```

---

### .gitattributes

```
*.gpg diff=gpg
*.gpg filter=gpg
```

---

### シークレットファイル（*.gpg / *.age）

暗号化されたシークレットのファイル。

**命名規則:**
- パス: `category/subcategory/name.gpg`
- 拡張子: `.gpg`（GPG）または `.age`（Age）
- ディレクトリ: サブカテゴリとして使用

**例:**
```
email/gmail.gpg        → gopass show email/gmail
social/twitter.gpg     → gopass show social/twitter
bank/checking/main.gpg → gopass show bank/checking/main
```

---

## ストレージバックエンド

### 1. gitfs（デフォルト）

Gitリポジトリ + ファイルシステム

**特徴:**
- バージョン管理
- リモート同期
- 履歴追跡

**初期化:**
```bash
git init
echo "*.gpg diff=gpg" >> .gitattributes
git add .gitattributes
git commit -m "Initialize password store"
```

**操作とコミット:**

| 操作 | コミットメッセージ |
|------|-------------------|
| insert | `Add secret for {path}` |
| edit | `Edit secret for {path}` |
| delete | `Remove secret for {path}` |
| generate | `Generate password for {path}` |
| recipients add | `Add recipient {id}` |
| recipients remove | `Remove recipient {id}` |
| copy | `Copy {from} to {to}` |
| move | `Move {from} to {to}` |

**同期フロー:**
```
1. git fetch origin
2. git rebase origin/master
3. 必要に応じてコンフリクト解決
4. git push origin master
```

---

### 2. fs

プレーンファイルシステム（バージョン管理なし）

**特徴:**
- シンプル
- 外部依存なし
- 履歴なし

**初期化:**
```bash
mkdir -p ~/.local/share/gopass/stores/root
echo "0xFEEDBEEF" > ~/.local/share/gopass/stores/root/.gpg-id
```

---

### 3. fossil（オプション）

Fossil SCM バックエンド

**特徴:**
- 組み込みWebUI
- チケット管理
- Wiki機能

---

### 4. cryptfs（実験的）

暗号化されたファイル名

**特徴:**
- ファイル名もAES-GCMで暗号化
- ディレクトリ構造は保持

**ファイル名暗号化:**
```
original: email/gmail.gpg
encrypted: a3f2c1d4e5b6/7f8e9d0c1b2a.gpg
```

---

## ストレージインターフェース

### Go互換インターフェース

```go
type Storage interface {
    // ストア操作
    Init(ctx context.Context, path string) error
    Initialized(ctx context.Context) bool
    
    // ファイル操作
    Get(ctx context.Context, name string) ([]byte, error)
    Set(ctx context.Context, name string, value []byte) error
    Delete(ctx context.Context, name string) error
    Exists(ctx context.Context, name string) bool
    
    // 一覧
    List(ctx context.Context, prefix string) ([]string, error)
    IsDir(ctx context.Context, name string) bool
    Prune(ctx context.Context, prefix string) error
    
    // Git操作（オプション）
    Add(ctx context.Context, files ...string) error
    Commit(ctx context.Context, msg string) error
    Push(ctx context.Context, remote, branch string) error
    Pull(ctx context.Context, remote, branch string) error
    
    // メタデータ
    Name() string
    Path() string
    Version(ctx context.Context) string
}
```

### Python互換インターフェース

```python
from abc import ABC, abstractmethod
from typing import List, Optional
from pathlib import Path

class StorageBackend(ABC):
    """ストレージバックエンドの抽象基底クラス"""
    
    @abstractmethod
    def init(self, path: Path) -> None:
        """ストアを初期化"""
        pass
    
    @abstractmethod
    def initialized(self) -> bool:
        """初期化済みかどうか"""
        pass
    
    @abstractmethod
    def get(self, name: str) -> bytes:
        """シークレットを取得"""
        pass
    
    @abstractmethod
    def set(self, name: str, value: bytes) -> None:
        """シークレットを保存"""
        pass
    
    @abstractmethod
    def delete(self, name: str) -> None:
        """シークレットを削除"""
        pass
    
    @abstractmethod
    def exists(self, name: str) -> bool:
        """シークレットが存在するか"""
        pass
    
    @abstractmethod
    def list(self, prefix: str = "") -> List[str]:
        """シークレット一覧"""
        pass
    
    @abstractmethod
    def is_dir(self, name: str) -> bool:
        """ディレクトリかどうか"""
        pass
```

### TypeScript互換インターフェース

```typescript
interface StorageBackend {
  // ストア操作
  init(path: string): Promise<void>;
  initialized(): Promise<boolean>;
  
  // ファイル操作
  get(name: string): Promise<Buffer>;
  set(name: string, value: Buffer): Promise<void>;
  delete(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
  
  // 一覧
  list(prefix?: string): Promise<string[]>;
  isDir(name: string): Promise<boolean>;
  prune(prefix: string): Promise<void>;
  
  // Git操作（オプション）
  add?(files: string[]): Promise<void>;
  commit?(message: string): Promise<void>;
  push?(remote: string, branch: string): Promise<void>;
  pull?(remote: string, branch: string): Promise<void>;
  
  // メタデータ
  name: string;
  path: string;
  version(): Promise<string>;
}
```

---

## パス解決

### ルール

1. 先頭/末尾のスラッシュを削除
2. 連続スラッシュを単一に
3. `.`と`..`を解決
4. マウントポイントを適用
5. ファイル拡張子を追加（`.gpg`または`.age`）

### 例

| 入力パス | マウント | 解決後のファイルパス |
|---------|---------|---------------------|
| `foo/bar` | - | `~/.../root/foo/bar.gpg` |
| `work/email` | `work: ~/.../work` | `~/.../work/email.gpg` |
| `/foo/bar/` | - | `~/.../root/foo/bar.gpg` |
| `foo//bar` | - | `~/.../root/foo/bar.gpg` |

---

## ファイル権限

### Unix/Linux/macOS

| ファイル/ディレクトリ | 権限 |
|---------------------|------|
| ストアディレクトリ | `0700` |
| サブディレクトリ | `0700` |
| シークレットファイル | `0600` |
| .gpg-id | `0600` |
| 一時ファイル | `0600` |

### Windows

- ACLでユーザーのみ読み書き可能に設定

---

## エラー処理

### エラーコード

| エラー | 説明 |
|--------|------|
| `ErrNotFound` | シークレットが見つからない |
| `ErrExists` | シークレットが既に存在 |
| `ErrPermission` | 権限エラー |
| `ErrNotInitialized` | ストアが初期化されていない |
| `ErrGitOperation` | Git操作エラー |
| `ErrInvalidPath` | 不正なパス |

---

## 移行

### pass → PassShare

```bash
# passのストアをPassShareとして使用
passshare clone ~/.password-store

# または設定でパスを指定
passshare config path ~/.password-store
```

### gopass → PassShare

```bash
# 既存のgopassストアをそのまま使用可能
# 設定ファイルも互換
```
