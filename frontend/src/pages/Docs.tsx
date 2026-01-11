import { useState } from 'react';
import { Book, Terminal, Code, Settings, Users, Shield, ChevronRight } from 'lucide-react';
import clsx from 'clsx';

const sections = [
  {
    id: 'getting-started',
    title: 'クイックスタート',
    icon: Book,
    content: `
## クイックスタート

PassShareを使い始めるための5ステップガイドです。

---

### Step 1: インストール

お好みの方法でPassShareをインストールしてください。

\`\`\`bash
# Python（推奨）
pip install passshare

# Node.js
npm install -g passshare
\`\`\`

---

### Step 2: GPGキーを確認する

PassShareはGPGキーでパスワードを暗号化します。まず、利用可能なGPGキーを確認しましょう。

\`\`\`bash
gpg --list-keys --keyid-format LONG
\`\`\`

出力例:
\`\`\`
pub   ed25519/ABCD1234EFGH5678 2024-01-01 [SC]
      1234567890ABCDEF1234567890ABCDEF12345678
uid           [ultimate] Your Name <your.email@example.com>
\`\`\`

**使えるキーID:**
- \`ABCD1234EFGH5678\` ← ed25519/ の後の部分
- \`your.email@example.com\` ← メールアドレスでもOK

**GPGキーがない場合:**
\`\`\`bash
gpg --full-generate-key
\`\`\`

---

### Step 3: ストアを初期化

GPGキーIDを使ってパスワードストアを作成します。

\`\`\`bash
passshare init ABCD1234EFGH5678
\`\`\`

または、メールアドレスでも初期化できます:
\`\`\`bash
passshare init your.email@example.com
\`\`\`

---

### Step 4: パスワードを追加

最初のパスワードを追加してみましょう。

\`\`\`bash
# 対話形式で入力
passshare insert email/gmail
\`\`\`

パスワードの入力を求められます:
\`\`\`
Enter password for email/gmail:
Retype password for email/gmail:
\`\`\`

---

### Step 5: パスワードを表示

保存したパスワードを確認してみましょう。

\`\`\`bash
# ターミナルに表示
passshare show email/gmail

# クリップボードにコピー（45秒後に自動クリア）
passshare show -c email/gmail
\`\`\`

---

## 🎉 セットアップ完了！

これでPassShareの基本的なセットアップは完了です。

### 次のステップ

- **パスワードを自動生成**: \`passshare generate website/example 24\`
- **一覧を確認**: \`passshare ls\`
- **Git同期を設定**: 「チーム共有」セクションを参照
- **APIから操作**: 「APIリファレンス」セクションを参照
    `,
  },
  {
    id: 'cli',
    title: 'CLIリファレンス',
    icon: Terminal,
    content: `
## CLIリファレンス

### 基本コマンド

#### ストアの初期化
\`\`\`bash
passshare init <gpg-id...>
\`\`\`

#### パスワードの表示
\`\`\`bash
passshare show <name>
passshare show -c <name>  # クリップボードにコピー
\`\`\`

#### パスワードの追加
\`\`\`bash
passshare insert <name>
passshare insert -m <name>  # 複数行入力
\`\`\`

#### パスワードの生成
\`\`\`bash
passshare generate <name> [length]
passshare generate -n <name>  # 記号なし
passshare generate -x <name>  # XKCD形式
\`\`\`

#### 一覧表示
\`\`\`bash
passshare list
passshare ls <folder>
\`\`\`

#### 検索
\`\`\`bash
passshare find <pattern>
passshare grep <regex>
\`\`\`

### 同期
\`\`\`bash
passshare sync
\`\`\`
    `,
  },
  {
    id: 'api',
    title: 'APIリファレンス',
    icon: Code,
    content: `
## APIリファレンス

### Python

\`\`\`python
from passshare import Gopass, Secret

# 初期化
gopass = Gopass()

# シークレット取得
secret = gopass.get("email/gmail")
print(secret.password)
print(secret.get("username"))

# シークレット作成
new_secret = Secret(
    password="super-secret",
    data={"username": "user@example.com"}
)
gopass.set("new/secret", new_secret)

# パスワード生成
password = gopass.generate("another/secret", length=32)

# 一覧
for name in gopass.list():
    print(name)
\`\`\`

### TypeScript

\`\`\`typescript
import { Gopass, Secret } from '@passshare/core';

const gopass = new Gopass();

// シークレット取得
const secret = await gopass.get('email/gmail');
console.log(secret.password);

// シークレット作成
const newSecret = new Secret('super-secret', {
  username: 'user@example.com'
});
await gopass.set('new/secret', newSecret);
\`\`\`
    `,
  },
  {
    id: 'config',
    title: '設定',
    icon: Settings,
    content: `
## 設定

### 設定ファイル

設定ファイルは \`~/.config/gopass/config\` に保存されます（gopassと互換）。

\`\`\`yaml
autoclip: true
cliptimeout: 45
autosync: true
path: ~/.local/share/gopass/stores/root
mounts:
  work: ~/.local/share/gopass/stores/work
\`\`\`

### 設定項目

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| autoclip | bool | true | 自動クリップボードコピー |
| cliptimeout | int | 45 | クリップボード保持時間（秒） |
| autosync | bool | true | 自動同期 |
| autopush | bool | true | 自動プッシュ |

### CLIで設定

\`\`\`bash
passshare config
passshare config autoclip true
\`\`\`
    `,
  },
  {
    id: 'team',
    title: 'チーム共有',
    icon: Users,
    content: `
## チーム共有

### 受信者の追加

\`\`\`bash
# 受信者一覧
passshare recipients

# 受信者を追加
passshare recipients add 0xNEWKEYID

# 受信者を削除
passshare recipients remove 0xOLDKEYID
\`\`\`

### マウントポイント

複数のストアを統一的な名前空間で管理できます。

\`\`\`bash
# マウント一覧
passshare mounts

# マウントを追加
passshare mounts add work ~/.local/share/gopass/stores/work

# マウントを削除
passshare mounts remove work
\`\`\`

### Git同期

\`\`\`bash
# リモートを追加
passshare git remote add origin git@github.com:team/passwords.git

# 同期
passshare sync
\`\`\`
    `,
  },
  {
    id: 'security',
    title: 'セキュリティ',
    icon: Shield,
    content: `
## セキュリティ

### 暗号化バックエンド

PassShareは以下の暗号化バックエンドをサポートしています。

#### GPG（デフォルト）
- GnuPG 2.x互換
- 複数受信者対応
- ファイル拡張子: \`.gpg\`

#### Age
- モダンな暗号化
- シンプルな鍵管理
- ファイル拡張子: \`.age\`

### ベストプラクティス

1. **強力なパスワードを生成**: \`passshare generate\` を使用
2. **定期的な監査**: \`passshare audit\` でパスワード強度を確認
3. **バックアップ**: Gitリポジトリを複数の場所に同期
4. **GPG鍵の保護**: 秘密鍵は安全な場所に保管

### パスワード監査

\`\`\`bash
# 全シークレットを監査
passshare audit

# HIBPチェック
passshare audit --hibp
\`\`\`
    `,
  },
];

export default function Docs() {
  const [activeSection, setActiveSection] = useState(sections[0].id);

  const currentSection = sections.find((s) => s.id === activeSection) || sections[0];

  return (
    <div className="py-12 animate-fade-in">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col lg:flex-row gap-8">
          {/* Sidebar */}
          <nav className="lg:w-56 flex-shrink-0">
            <div className="sticky top-20">
              <h2 className="font-medium text-dark-500 uppercase text-xs tracking-wider mb-4">
                ドキュメント
              </h2>
              <ul className="space-y-0.5">
                {sections.map((section) => {
                  const Icon = section.icon;
                  return (
                    <li key={section.id}>
                      <button
                        onClick={() => setActiveSection(section.id)}
                        className={clsx(
                          'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition-colors',
                          activeSection === section.id
                            ? 'bg-dark-800 text-white'
                            : 'text-dark-400 hover:bg-dark-800/50 hover:text-white'
                        )}
                      >
                        <Icon className="h-4 w-4 flex-shrink-0" />
                        <span className="flex-grow">{section.title}</span>
                        <ChevronRight
                          className={clsx(
                            'h-3.5 w-3.5 transition-transform',
                            activeSection === section.id && 'rotate-90'
                          )}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </nav>

          {/* Content */}
          <main className="flex-grow min-w-0">
            <div className="card p-6 md:p-8">
              <article className="prose prose-invert prose-primary max-w-none">
                <div
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(currentSection.content),
                  }}
                />
              </article>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

// Simple markdown renderer
function renderMarkdown(content: string): string {
  return content
    .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre class="code-block"><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code class="bg-dark-800 px-1.5 py-0.5 rounded text-primary-400 text-sm">$1</code>')
    .replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold mt-8 mb-3 text-white">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold mt-6 mb-4 text-white">$1</h2>')
    .replace(/^\| (.+) \|$/gm, (match) => {
      const cells = match.split('|').filter(Boolean).map((c) => c.trim());
      return `<tr>${cells.map((c) => `<td class="border border-dark-700 px-4 py-2 text-sm">${c}</td>`).join('')}</tr>`;
    })
    .replace(/^- (.+)$/gm, '<li class="ml-4 text-dark-300">$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal text-dark-300">$1</li>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white">$1</strong>')
    .replace(/\n\n/g, '</p><p class="mb-3 text-dark-300">')
    .replace(/^(.+)$/gm, (match) => {
      if (match.startsWith('<')) return match;
      return `<p class="mb-3 text-dark-300">${match}</p>`;
    });
}
