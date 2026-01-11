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
# または
npm install -g passshare

# ストアを初期化
passshare init 0xYOURGPGKEY

# パスワードを追加
passshare insert email/gmail

# パスワードを表示
passshare show email/gmail

# パスワードを生成
passshare generate website/example 24`;

export default function Home() {
  return (
    <div>
      {/* Hero Section */}
      <section className="relative overflow-hidden py-20 lg:py-32">
        <div className="absolute inset-0 bg-gradient-to-br from-primary-900/20 via-dark-800 to-secondary-900/20" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary-500/5 rounded-full blur-3xl" />
        
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold mb-6">
              <span className="gradient-text">セキュアな</span>
              <br />
              パスワード管理を
            </h1>
            <p className="text-xl md:text-2xl text-dark-300 max-w-3xl mx-auto mb-8">
              チームと個人のためのオープンソースパスワードマネージャー。
              <br className="hidden md:block" />
              GPG暗号化とGit同期で、どこでも安全にパスワードを共有。
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link to="/download" className="btn btn-primary text-lg px-8 py-4">
                ダウンロード
              </Link>
              <Link to="/docs" className="btn btn-outline text-lg px-8 py-4">
                ドキュメントを見る
              </Link>
            </div>
          </div>

          {/* Code Preview */}
          <div className="mt-16 max-w-3xl mx-auto">
            <div className="code-block border border-dark-600">
              <pre className="text-green-400">{codeExample}</pre>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 bg-dark-900/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="section-title">
            <span className="gradient-text">機能</span>
          </h2>
          <p className="section-subtitle">
            PassShareはpass/gopassと完全互換。既存のワークフローを壊さずに、
            より強力な機能を提供します。
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {features.map((feature) => (
              <FeatureCard key={feature.title} {...feature} />
            ))}
          </div>
        </div>
      </section>

      {/* Comparison Section */}
      <section className="py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="section-title">
            <span className="gradient-text">比較</span>
          </h2>
          <p className="section-subtitle">
            PassShareと他のパスワードマネージャーの比較
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-dark-600">
                  <th className="text-left py-4 px-4">特徴</th>
                  <th className="text-center py-4 px-4">PassShare</th>
                  <th className="text-center py-4 px-4">1Password</th>
                  <th className="text-center py-4 px-4">Bitwarden</th>
                  <th className="text-center py-4 px-4">pass/gopass</th>
                </tr>
              </thead>
              <tbody className="text-dark-300">
                <tr className="border-b border-dark-700">
                  <td className="py-4 px-4">オープンソース</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                  <td className="text-center py-4 px-4 text-red-400">✗</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                </tr>
                <tr className="border-b border-dark-700">
                  <td className="py-4 px-4">セルフホスト</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                  <td className="text-center py-4 px-4 text-red-400">✗</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                </tr>
                <tr className="border-b border-dark-700">
                  <td className="py-4 px-4">GPG暗号化</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                  <td className="text-center py-4 px-4 text-red-400">✗</td>
                  <td className="text-center py-4 px-4 text-red-400">✗</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                </tr>
                <tr className="border-b border-dark-700">
                  <td className="py-4 px-4">Git同期</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                  <td className="text-center py-4 px-4 text-red-400">✗</td>
                  <td className="text-center py-4 px-4 text-red-400">✗</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                </tr>
                <tr className="border-b border-dark-700">
                  <td className="py-4 px-4">プログラマティックAPI</td>
                  <td className="text-center py-4 px-4 text-green-400">✓</td>
                  <td className="text-center py-4 px-4 text-yellow-400">制限あり</td>
                  <td className="text-center py-4 px-4 text-yellow-400">制限あり</td>
                  <td className="text-center py-4 px-4 text-yellow-400">制限あり</td>
                </tr>
                <tr>
                  <td className="py-4 px-4">複数言語SDK</td>
                  <td className="text-center py-4 px-4 text-green-400">Py/TS/Node</td>
                  <td className="text-center py-4 px-4 text-red-400">✗</td>
                  <td className="text-center py-4 px-4 text-red-400">✗</td>
                  <td className="text-center py-4 px-4 text-red-400">✗</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-gradient-to-r from-primary-900/30 to-secondary-900/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            今すぐ始めよう
          </h2>
          <p className="text-dark-300 text-lg mb-8 max-w-2xl mx-auto">
            PassShareは無料でオープンソース。
            既存のpass/gopassストアをそのまま使えます。
          </p>
          <Link to="/download" className="btn btn-secondary text-lg px-8 py-4">
            無料ダウンロード
          </Link>
        </div>
      </section>
    </div>
  );
}
