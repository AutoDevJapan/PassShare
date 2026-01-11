import { Link } from 'react-router-dom';
import {
  Shield,
  Users,
  GitBranch,
  Lock,
  Terminal,
  Code,
  Zap,
  Globe,
  ArrowRight,
  Check,
} from 'lucide-react';
import FeatureCard from '../components/FeatureCard';

const features = [
  {
    icon: Shield,
    title: 'GPG/Age暗号化',
    description: '業界標準の暗号化でパスワードを保護。既存のGPG鍵をそのまま利用可能。',
  },
  {
    icon: GitBranch,
    title: 'Git同期',
    description: '自動バージョン管理と複数デバイス間での同期。変更履歴も完全に追跡。',
  },
  {
    icon: Users,
    title: 'チーム共有',
    description: '複数の受信者に対応。チームメンバー間で安全にパスワードを共有。',
  },
  {
    icon: Lock,
    title: 'gopass互換',
    description: '既存のpass/gopassストアをそのまま利用可能。移行コスト不要。',
  },
  {
    icon: Terminal,
    title: 'CLI & API',
    description: 'コマンドラインとプログラマティックAPI両対応。自動化に最適。',
  },
  {
    icon: Code,
    title: 'マルチ言語SDK',
    description: 'Python、TypeScript、Node.jsの3言語でSDKを提供。',
  },
  {
    icon: Zap,
    title: '高速パフォーマンス',
    description: '1000件以上のシークレットでも高速に動作。効率的な設計。',
  },
  {
    icon: Globe,
    title: 'クロスプラットフォーム',
    description: 'Linux、macOS、Windowsに対応。どこでも同じ体験を。',
  },
];

const codeExample = `# インストール
pip install passshare

# ストアを初期化
passshare init YOUR_GPG_KEY

# パスワードを追加
passshare insert email/gmail

# パスワードを表示
passshare show email/gmail`;

export default function Home() {
  return (
    <div className="animate-fade-in">
      {/* Hero Section */}
      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-dark-800 border border-dark-700 text-dark-400 text-sm mb-6">
              <span className="w-2 h-2 rounded-full bg-primary-500"></span>
              オープンソース
            </div>

            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6 leading-tight">
              セキュアな
              <br />
              <span className="gradient-text">パスワード管理</span>を
            </h1>

            <p className="text-lg text-dark-400 mb-8 max-w-2xl">
              チームと個人のためのオープンソースパスワードマネージャー。
              GPG暗号化とGit同期で、どこでも安全にパスワードを共有。
            </p>

            <div className="flex flex-wrap gap-3">
              <Link to="/download" className="btn btn-primary px-6 py-2.5">
                ダウンロード
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
              <Link to="/docs" className="btn btn-secondary px-6 py-2.5">
                ドキュメントを見る
              </Link>
            </div>
          </div>

          {/* Code Preview */}
          <div className="mt-16 max-w-2xl">
            <div className="code-block">
              <div className="flex items-center gap-2 mb-4 pb-3 border-b border-dark-700">
                <div className="w-3 h-3 rounded-full bg-dark-600"></div>
                <div className="w-3 h-3 rounded-full bg-dark-600"></div>
                <div className="w-3 h-3 rounded-full bg-dark-600"></div>
                <span className="ml-2 text-dark-500 text-xs">terminal</span>
              </div>
              <pre className="text-primary-400 text-sm leading-relaxed">{codeExample}</pre>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 border-t border-dark-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-12">
            <h2 className="section-title text-white">
              機能
            </h2>
            <p className="section-subtitle">
              PassShareはpass/gopassと完全互換。既存のワークフローを壊さずに、
              より強力な機能を提供します。
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {features.map((feature) => (
              <FeatureCard key={feature.title} {...feature} />
            ))}
          </div>
        </div>
      </section>

      {/* Comparison Section */}
      <section className="py-16 border-t border-dark-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-12">
            <h2 className="section-title text-white">
              比較
            </h2>
            <p className="section-subtitle">
              PassShareと他のパスワードマネージャーの比較
            </p>
          </div>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-dark-700 bg-dark-800/50">
                    <th className="text-left py-4 px-6 font-medium text-dark-300">特徴</th>
                    <th className="text-center py-4 px-6 font-medium text-primary-400">PassShare</th>
                    <th className="text-center py-4 px-6 font-medium text-dark-400">1Password</th>
                    <th className="text-center py-4 px-6 font-medium text-dark-400">Bitwarden</th>
                    <th className="text-center py-4 px-6 font-medium text-dark-400">pass/gopass</th>
                  </tr>
                </thead>
                <tbody className="text-dark-300">
                  <tr className="border-b border-dark-700/50">
                    <td className="py-4 px-6">オープンソース</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                  </tr>
                  <tr className="border-b border-dark-700/50">
                    <td className="py-4 px-6">セルフホスト</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                  </tr>
                  <tr className="border-b border-dark-700/50">
                    <td className="py-4 px-6">GPG暗号化</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                  </tr>
                  <tr className="border-b border-dark-700/50">
                    <td className="py-4 px-6">Git同期</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                  </tr>
                  <tr className="border-b border-dark-700/50">
                    <td className="py-4 px-6">プログラマティックAPI</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /><span className="text-dark-500 text-xs ml-1">有料</span></td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /><span className="text-dark-500 text-xs ml-1">有料</span></td>
                    <td className="text-center py-4 px-6 text-dark-500">CLI経由</td>
                  </tr>
                  <tr>
                    <td className="py-4 px-6">複数言語SDK</td>
                    <td className="text-center py-4 px-6 text-primary-400">Py/TS/Node</td>
                    <td className="text-center py-4 px-6 text-dark-400">Go/Py/JS</td>
                    <td className="text-center py-4 px-6 text-dark-400">C#/Go/Java/Py</td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 border-t border-dark-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="card p-8 md:p-12 text-center">
            <h2 className="text-2xl md:text-3xl font-bold text-white mb-4">
              今すぐ始めよう
            </h2>
            <p className="text-dark-400 mb-8 max-w-xl mx-auto">
              PassShareは無料でオープンソース。
              既存のpass/gopassストアをそのまま使えます。
            </p>
            <Link to="/download" className="btn btn-primary px-8 py-3">
              無料ダウンロード
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
