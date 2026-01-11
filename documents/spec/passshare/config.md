# PassShare 設定仕様

## 概要

このドキュメントはPassShareの設定ファイル仕様を定義します。

**互換性**: gopassの設定ファイル形式と完全互換。既存の設定をそのまま利用できます。

## 設定ファイルの場所

| OS | パス |
|----|------|
| Linux | `~/.config/gopass/config` |
| macOS | `~/.config/gopass/config` |
| Windows | `%APPDATA%\gopass\config` |

### 環境変数による上書き

```bash
export GOPASS_CONFIG=/path/to/custom/config
```

---

## 設定ファイル形式

### YAML形式

```yaml
# PassShare/gopass 設定ファイル
autoclip: true
autoimport: true
autopush: true
autosync: true
clipctrl: "xclip"
cliptimeout: 45
concurrency: 10
exportkeys: true
nocolor: false
noconfirm: false
nopager: false
notifications: true
parsing: true
safecontent: false

# ルートストアのパス
path: /home/user/.local/share/gopass/stores/root

# マウントポイント
mounts:
  work: /home/user/.local/share/gopass/stores/work
  personal: /home/user/.local/share/gopass/stores/personal

# 生成設定
generate:
  autoclip: true
  length: 24
  symbols: true
  strict: false

# 監査設定
audit:
  hibp: false
```

---

## 設定項目一覧

### 一般設定

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `autoclip` | bool | `true` | 自動的にクリップボードにコピー |
| `autoimport` | bool | `true` | GPG公開鍵を自動インポート |
| `autopush` | bool | `true` | 変更後に自動プッシュ |
| `autosync` | bool | `true` | 自動同期を有効化 |
| `cliptimeout` | int | `45` | クリップボード保持時間（秒） |
| `concurrency` | int | `10` | 並列処理数 |
| `exportkeys` | bool | `true` | .public-keysに公開鍵をエクスポート |
| `nocolor` | bool | `false` | カラー出力を無効化 |
| `noconfirm` | bool | `false` | 確認プロンプトをスキップ |
| `nopager` | bool | `false` | ページャーを無効化 |
| `notifications` | bool | `true` | デスクトップ通知を有効化 |
| `parsing` | bool | `true` | シークレット内容のパースを有効化 |
| `safecontent` | bool | `false` | 安全なコンテンツ表示 |
| `path` | string | (OS依存) | ルートストアのパス |

### クリップボード設定

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `clipctrl` | string | `""` | クリップボードツール |

**clipctrl の値:**
- `""` - 自動検出
- `xclip` - xclipを使用
- `xsel` - xselを使用
- `wl-copy` - wl-copy（Wayland）を使用
- `pbcopy` - pbcopy（macOS）を使用

### パスワード生成設定

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `generate.autoclip` | bool | `true` | 生成後にクリップボードにコピー |
| `generate.length` | int | `24` | デフォルトのパスワード長 |
| `generate.symbols` | bool | `true` | 記号を含める |
| `generate.strict` | bool | `false` | 厳格モード |

### 監査設定

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `audit.hibp` | bool | `false` | Have I Been Pwnedチェック |

### エディタ設定

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `edit.editor` | string | `$EDITOR` | 使用するエディタ |

---

## マウントポイント

### 構造

```yaml
mounts:
  <alias>: <path>
```

### 例

```yaml
mounts:
  work: /home/user/.local/share/gopass/stores/work
  personal: /home/user/.local/share/gopass/stores/personal
  team: /home/user/.local/share/gopass/stores/team
```

### パス解決

| 入力 | マウント | 解決先 |
|------|---------|--------|
| `work/email` | `work: ...` | `.../work/email.gpg` |
| `email` | - | `.../root/email.gpg` |

---

## 環境変数

### 設定の上書き

| 環境変数 | 設定キー | 説明 |
|---------|---------|------|
| `GOPASS_CONFIG` | - | 設定ファイルパス |
| `PASSWORD_STORE_DIR` | `path` | ルートストアパス |
| `GOPASS_HOMEDIR` | - | ホームディレクトリ（テスト用） |
| `GOPASS_NO_AUTOSYNC` | `autosync` | 自動同期を無効化 |
| `GOPASS_CLIP_TIME` | `cliptimeout` | クリップボード保持時間 |
| `GOPASS_GPG_BINARY` | - | GPGバイナリパス |
| `GOPASS_AGE_BINARY` | - | Ageバイナリパス |
| `EDITOR` | `edit.editor` | エディタ |

### 環境変数の優先順位

```
1. コマンドラインフラグ（最優先）
2. 環境変数
3. 設定ファイル
4. デフォルト値
```

---

## CLIによる設定管理

### 設定の表示

```bash
# 全設定を表示
passshare config

# 特定の設定を表示
passshare config autoclip
passshare config cliptimeout
passshare config generate.length
```

### 設定の変更

```bash
# 設定を変更
passshare config autoclip true
passshare config cliptimeout 60
passshare config generate.length 32

# ストア固有の設定
passshare config --store work autosync false
```

---

## 設定インターフェース

### Go互換インターフェース

```go
type Config interface {
    // 値の取得
    Get(key string) string
    GetBool(key string) bool
    GetInt(key string) int
    
    // 値の設定
    Set(key string, value string) error
    SetBool(key string, value bool) error
    SetInt(key string, value int) error
    
    // マウント
    Mounts() map[string]string
    AddMount(alias, path string) error
    RemoveMount(alias string) error
    
    // 永続化
    Save() error
    Load() error
    
    // パス
    Path() string
    ConfigPath() string
}
```

### Python互換インターフェース

```python
from typing import Dict, Optional, Any
from pathlib import Path

class Config:
    """設定管理クラス"""
    
    def __init__(self, path: Optional[Path] = None):
        self._path = path or self._default_path()
        self._data: Dict[str, Any] = {}
    
    def get(self, key: str, default: Any = None) -> Any:
        """設定値を取得"""
        pass
    
    def set(self, key: str, value: Any) -> None:
        """設定値を設定"""
        pass
    
    @property
    def mounts(self) -> Dict[str, str]:
        """マウントポイント一覧"""
        pass
    
    def add_mount(self, alias: str, path: str) -> None:
        """マウントポイントを追加"""
        pass
    
    def remove_mount(self, alias: str) -> None:
        """マウントポイントを削除"""
        pass
    
    def save(self) -> None:
        """設定を保存"""
        pass
    
    def load(self) -> None:
        """設定を読み込み"""
        pass
    
    @staticmethod
    def _default_path() -> Path:
        """デフォルトの設定ファイルパス"""
        pass
```

### TypeScript互換インターフェース

```typescript
interface Config {
  // 値の取得
  get(key: string): string | undefined;
  getBool(key: string): boolean;
  getInt(key: string): number;
  
  // 値の設定
  set(key: string, value: string): void;
  setBool(key: string, value: boolean): void;
  setInt(key: string, value: number): void;
  
  // マウント
  mounts: Map<string, string>;
  addMount(alias: string, path: string): void;
  removeMount(alias: string): void;
  
  // 永続化
  save(): Promise<void>;
  load(): Promise<void>;
  
  // パス
  readonly path: string;
  readonly configPath: string;
}
```

---

## 設定のバリデーション

### 必須項目

- `path`: 有効なディレクトリパス

### 型チェック

| キー | 型 | 有効な値 |
|------|-----|---------|
| `autoclip` | bool | `true`, `false` |
| `cliptimeout` | int | `1` - `3600` |
| `concurrency` | int | `1` - `100` |
| `generate.length` | int | `1` - `1024` |

### エラーハンドリング

```
設定エラー時:
1. 警告を表示
2. デフォルト値を使用
3. 動作を継続
```

---

## 設定の移行

### pass → PassShare

passは設定ファイルを使用しないため、環境変数から移行:

```bash
# passの環境変数
export PASSWORD_STORE_DIR=~/.password-store
export PASSWORD_STORE_CLIP_TIME=45

# PassShareの設定
passshare config path ~/.password-store
passshare config cliptimeout 45
```

### gopass v1.x → PassShare

設定ファイルはそのまま互換:

```yaml
# gopass v1.x の設定
autoclip: true
cliptimeout: 45
path: ~/.local/share/gopass/stores/root

# PassShare でそのまま使用可能
```

---

## デバッグ

### 現在の設定を確認

```bash
passshare config
```

### 設定ファイルの場所を確認

```bash
echo $GOPASS_CONFIG
# または
passshare config path
```

### 設定のリセット

```bash
rm ~/.config/gopass/config
passshare setup
```
