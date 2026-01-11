import { Terminal, Package, Copy, Check, ArrowRight, Monitor, Globe, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

interface DownloadOption {
  name: string;
  platform: string;
  command: string;
  description: string;
  badge: string;
}

interface AppDownload {
  name: string;
  platform: string;
  icon: React.ReactNode;
  description: string;
  downloads: {
    label: string;
    url: string;
    badge?: string;
  }[];
  comingSoon?: boolean;
}

const downloadOptions: DownloadOption[] = [
  {
    name: 'Python (PyPI)',
    platform: 'python',
    command: 'pip install passshare',
    description: 'Python 3.11以上。CLI & ライブラリ。',
    badge: 'Recommended',
  },
  {
    name: 'Node.js (npm)',
    platform: 'nodejs',
    command: 'npm install -g passshare',
    description: 'Node.js 18以上。CLI。',
    badge: '',
  },
  {
    name: 'TypeScript (npm)',
    platform: 'typescript',
    command: 'npm install @passshare/core',
    description: 'TypeScript/JavaScript ライブラリ。',
    badge: '',
  },
];

const API_BASE = import.meta.env.VITE_API_URL || '';

const appDownloads: AppDownload[] = [
  {
    name: 'デスクトップアプリ',
    platform: 'desktop',
    icon: <Monitor className="h-6 w-6" />,
    description: 'Windows, macOS, Linux対応。ローカルGPG/Gitを直接使用。システムトレイ常駐、グローバルホットキー対応。',
    downloads: [
      { label: 'Windows (.exe)', url: `${API_BASE}/api/v1/downloads/desktop/windows`, badge: 'Windows 10+' },
      { label: 'macOS (.dmg)', url: `${API_BASE}/api/v1/downloads/desktop/macos`, badge: 'macOS 12+' },
      { label: 'Linux (.AppImage)', url: `${API_BASE}/api/v1/downloads/desktop/linux`, badge: 'Ubuntu 20.04+' },
    ],
  },
  {
    name: 'ブラウザ拡張',
    platform: 'browser',
    icon: <Globe className="h-6 w-6" />,
    description: 'ログインフォーム自動検出、ワンクリック入力。デスクトップアプリと連携。',
    downloads: [
      { label: 'Chrome Web Store', url: `${API_BASE}/api/v1/downloads/extension/chrome`, badge: 'Chrome / Edge / Brave' },
      { label: 'Firefox Add-ons', url: `${API_BASE}/api/v1/downloads/extension/firefox`, badge: 'Firefox' },
    ],
  },
  {
    name: 'モバイルアプリ',
    platform: 'mobile',
    icon: <Smartphone className="h-6 w-6" />,
    description: '外出先でもパスワードにアクセス。生体認証対応。',
    downloads: [
      { label: 'App Store', url: `${API_BASE}/api/v1/downloads/mobile/ios`, badge: 'iOS 15+' },
      { label: 'Google Play', url: `${API_BASE}/api/v1/downloads/mobile/android`, badge: 'Android 10+' },
    ],
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
      className="p-1.5 hover:bg-dark-700 rounded transition-colors"
      title="コピー"
    >
      {copied ? (
        <Check className="h-4 w-4 text-primary-400" />
      ) : (
        <Copy className="h-4 w-4 text-dark-500 hover:text-dark-300" />
      )}
    </button>
  );
}

export default function Download() {
  return (
    <div className="py-16 animate-fade-in">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-4">
            ダウンロード
          </h1>
          <p className="text-dark-400 max-w-2xl">
            お好みのプラットフォームに合わせてダウンロードしてください。
          </p>
        </div>

        {/* App Downloads */}
        <div className="mb-16">
          <h2 className="text-2xl font-bold text-white mb-6">アプリケーション</h2>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {appDownloads.map((app) => (
              <div key={app.platform} className="card p-6">
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-12 h-12 rounded-xl bg-primary-500/10 flex items-center justify-center text-primary-400">
                    {app.icon}
                  </div>
                  <h3 className="text-lg font-bold text-white">{app.name}</h3>
                </div>
                <p className="text-dark-400 text-sm mb-6">{app.description}</p>
                <div className="space-y-3">
                  {app.downloads.map((dl) => (
                    <a
                      key={dl.label}
                      href={dl.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between p-3 bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors group"
                    >
                      <span className="text-white font-medium text-sm">{dl.label}</span>
                      <div className="flex items-center gap-2">
                        {dl.badge && (
                          <span className="text-xs text-dark-500">{dl.badge}</span>
                        )}
                        <ArrowRight className="h-4 w-4 text-dark-500 group-hover:text-primary-400 transition-colors" />
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CLI Section */}
        <div className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-6">コマンドライン (CLI)</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {downloadOptions.map((option) => (
            <div key={option.platform} className="card-hover p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-lg bg-primary-500/10 flex items-center justify-center">
                  <Package className="h-4 w-4 text-primary-400" />
                </div>
                <div>
                  <h3 className="font-medium text-white">{option.name}</h3>
                  {option.badge && (
                    <span className="badge badge-primary text-xs">{option.badge}</span>
                  )}
                </div>
              </div>
              <p className="text-dark-500 text-sm mb-4">{option.description}</p>
              <div className="flex items-center gap-2 bg-dark-900 rounded-lg px-3 py-2 border border-dark-700/50">
                <Terminal className="h-3.5 w-3.5 text-dark-600 flex-shrink-0" />
                <code className="text-sm text-primary-400 flex-grow font-mono">{option.command}</code>
                <CopyButton text={option.command} />
              </div>
            </div>
          ))}
          </div>
        </div>

        {/* Requirements */}
        <div className="card p-6 mb-12">
          <h2 className="text-xl font-bold text-white mb-6">システム要件</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h3 className="font-medium text-primary-400 mb-4 text-sm uppercase tracking-wide">必須</h3>
              <ul className="space-y-3">
                <li className="flex items-center gap-3 text-dark-300">
                  <Check className="h-4 w-4 text-primary-400 flex-shrink-0" />
                  <span className="text-sm">GPG 2.x または Age</span>
                </li>
                <li className="flex items-center gap-3 text-dark-300">
                  <Check className="h-4 w-4 text-primary-400 flex-shrink-0" />
                  <span className="text-sm">Git（同期機能を使用する場合）</span>
                </li>
                <li className="flex items-center gap-3 text-dark-300">
                  <Check className="h-4 w-4 text-primary-400 flex-shrink-0" />
                  <span className="text-sm">Python 3.11+ / Node.js 18+</span>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="font-medium text-primary-400 mb-4 text-sm uppercase tracking-wide">対応OS</h3>
              <ul className="space-y-3">
                <li className="flex items-center gap-3 text-dark-300">
                  <Check className="h-4 w-4 text-primary-400 flex-shrink-0" />
                  <span className="text-sm">Linux (Ubuntu, Fedora, Arch等)</span>
                </li>
                <li className="flex items-center gap-3 text-dark-300">
                  <Check className="h-4 w-4 text-primary-400 flex-shrink-0" />
                  <span className="text-sm">macOS 12以上</span>
                </li>
                <li className="flex items-center gap-3 text-dark-300">
                  <Check className="h-4 w-4 text-primary-400 flex-shrink-0" />
                  <span className="text-sm">Windows 10/11</span>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Quick Start */}
        <div className="card p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-white">クイックスタート</h2>
            <Link to="/docs" className="text-primary-400 hover:text-primary-300 text-sm flex items-center gap-1">
              詳細を見る
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="space-y-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-6 h-6 rounded-full bg-primary-500/10 flex items-center justify-center text-xs text-primary-400 font-medium">1</span>
                <h3 className="font-medium text-white text-sm">インストール</h3>
              </div>
              <div className="code-block ml-8">
                <pre className="text-primary-400">pip install passshare</pre>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-6 h-6 rounded-full bg-primary-500/10 flex items-center justify-center text-xs text-primary-400 font-medium">2</span>
                <h3 className="font-medium text-white text-sm">GPG鍵の確認</h3>
              </div>
              <div className="code-block ml-8">
                <pre className="text-primary-400">gpg --list-secret-keys --keyid-format long</pre>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-6 h-6 rounded-full bg-primary-500/10 flex items-center justify-center text-xs text-primary-400 font-medium">3</span>
                <h3 className="font-medium text-white text-sm">ストアを初期化</h3>
              </div>
              <div className="code-block ml-8">
                <pre className="text-primary-400">passshare init YOUR_GPG_KEY_ID</pre>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-6 h-6 rounded-full bg-primary-500/10 flex items-center justify-center text-xs text-primary-400 font-medium">4</span>
                <h3 className="font-medium text-white text-sm">パスワードを追加</h3>
              </div>
              <div className="code-block ml-8">
                <pre className="text-primary-400">passshare insert email/gmail</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
