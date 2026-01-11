import { Terminal, Package, Copy, Check } from 'lucide-react';
import { useState } from 'react';

interface DownloadOption {
  name: string;
  platform: string;
  command: string;
  description: string;
}

const downloadOptions: DownloadOption[] = [
  {
    name: 'Python (PyPI)',
    platform: 'python',
    command: 'pip install passshare',
    description: 'Python 3.11以上。CLI & ライブラリ。',
  },
  {
    name: 'Node.js (npm)',
    platform: 'nodejs',
    command: 'npm install -g passshare',
    description: 'Node.js 18以上。CLI。',
  },
  {
    name: 'TypeScript (npm)',
    platform: 'typescript',
    command: 'npm install @passshare/core',
    description: 'TypeScript/JavaScript ライブラリ。',
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-2 hover:bg-dark-600 rounded transition-colors"
      title="コピー"
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-400" />
      ) : (
        <Copy className="h-4 w-4 text-dark-400" />
      )}
    </button>
  );
}

export default function Download() {
  return (
    <div className="py-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            <span className="gradient-text">ダウンロード</span>
          </h1>
          <p className="text-dark-300 text-lg max-w-2xl mx-auto">
            お好みの言語・プラットフォームに合わせてインストール方法を選んでください。
          </p>
        </div>

        {/* Download Options */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
          {downloadOptions.map((option) => (
            <div key={option.platform} className="card p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-primary-500/10 flex items-center justify-center">
                  <Package className="h-5 w-5 text-primary-400" />
                </div>
                <h3 className="font-semibold">{option.name}</h3>
              </div>
              <p className="text-dark-400 text-sm mb-4">{option.description}</p>
              <div className="flex items-center gap-2 bg-dark-900 rounded-lg p-3">
                <Terminal className="h-4 w-4 text-dark-500 flex-shrink-0" />
                <code className="text-sm text-green-400 flex-grow">{option.command}</code>
                <CopyButton text={option.command} />
              </div>
            </div>
          ))}
        </div>

        {/* Requirements */}
        <div className="card p-8 mb-16">
          <h2 className="text-2xl font-bold mb-6">システム要件</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h3 className="font-semibold mb-4 text-primary-400">必須</h3>
              <ul className="space-y-2 text-dark-300">
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-400" />
                  <span>GPG 2.x または Age</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-400" />
                  <span>Git（同期機能を使用する場合）</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-400" />
                  <span>Python 3.11+ / Node.js 18+</span>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold mb-4 text-primary-400">対応OS</h3>
              <ul className="space-y-2 text-dark-300">
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-400" />
                  <span>Linux (Ubuntu, Fedora, Arch等)</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-400" />
                  <span>macOS 12以上</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-400" />
                  <span>Windows 10/11</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Quick Start */}
        <div className="card p-8">
          <h2 className="text-2xl font-bold mb-6">クイックスタート</h2>
          <div className="space-y-6">
            <div>
              <h3 className="font-semibold mb-2">1. インストール</h3>
              <div className="code-block">
                <pre className="text-green-400">pip install passshare</pre>
              </div>
            </div>
            <div>
              <h3 className="font-semibold mb-2">2. GPG鍵の確認</h3>
              <div className="code-block">
                <pre className="text-green-400">gpg --list-secret-keys --keyid-format long</pre>
              </div>
            </div>
            <div>
              <h3 className="font-semibold mb-2">3. ストアを初期化</h3>
              <div className="code-block">
                <pre className="text-green-400">passshare init YOUR_GPG_KEY_ID</pre>
              </div>
            </div>
            <div>
              <h3 className="font-semibold mb-2">4. パスワードを追加</h3>
              <div className="code-block">
                <pre className="text-green-400">passshare insert email/gmail</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
