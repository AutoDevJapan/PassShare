import { Link } from 'react-router-dom';
import { Github, Twitter } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="bg-dark-900 border-t border-dark-700">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-1 md:col-span-2">
            <Link to="/" className="flex items-center gap-3 mb-4">
              <img src="/logo.png" alt="PassShare" className="h-8 w-8" />
              <span className="text-xl font-bold gradient-text">PassShare</span>
            </Link>
            <p className="text-dark-400 text-sm max-w-md">
              チームと個人のためのセキュアなパスワードマネージャー。
              GPG/Age暗号化とGitベースの同期により、安全にパスワードを共有できます。
            </p>
          </div>

          {/* Links */}
          <div>
            <h3 className="font-semibold mb-4">プロダクト</h3>
            <ul className="space-y-2 text-sm text-dark-400">
              <li><Link to="/download" className="hover:text-white transition-colors">ダウンロード</Link></li>
              <li><Link to="/docs" className="hover:text-white transition-colors">ドキュメント</Link></li>
              <li><a href="https://github.com/bm1314/passshare" className="hover:text-white transition-colors">GitHub</a></li>
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="font-semibold mb-4">会社</h3>
            <ul className="space-y-2 text-sm text-dark-400">
              <li><a href="https://bm1314.co.jp" className="hover:text-white transition-colors">株式会社BM1314</a></li>
              <li><a href="/privacy" className="hover:text-white transition-colors">プライバシーポリシー</a></li>
              <li><a href="/terms" className="hover:text-white transition-colors">利用規約</a></li>
            </ul>
          </div>
        </div>

        <div className="border-t border-dark-700 mt-8 pt-8 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-dark-400 text-sm">
            © 2026 株式会社BM1314. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/bm1314/passshare"
              className="text-dark-400 hover:text-white transition-colors"
              aria-label="GitHub"
            >
              <Github className="h-5 w-5" />
            </a>
            <a
              href="https://twitter.com/bm1314"
              className="text-dark-400 hover:text-white transition-colors"
              aria-label="Twitter"
            >
              <Twitter className="h-5 w-5" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
