import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="bg-dark-900 border-t border-dark-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <Link to="/" className="flex items-center gap-2 mb-4">
              <img src="/logo.png" alt="PassShare" className="h-6 w-6" />
              <span className="text-lg font-semibold text-white">PassShare</span>
            </Link>
            <p className="text-dark-500 text-sm">
              © 2026 株式会社BM1314.
              <br />
              All rights reserved.
            </p>
          </div>

          {/* Discover */}
          <div>
            <h3 className="font-medium text-white mb-4">プロダクト</h3>
            <ul className="space-y-3 text-sm">
              <li>
                <Link to="/" className="text-dark-400 hover:text-white transition-colors">
                  ホーム
                </Link>
              </li>
              <li>
                <Link to="/download" className="text-dark-400 hover:text-white transition-colors">
                  ダウンロード
                </Link>
              </li>
              <li>
                <Link to="/docs" className="text-dark-400 hover:text-white transition-colors">
                  ドキュメント
                </Link>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h3 className="font-medium text-white mb-4">リソース</h3>
            <ul className="space-y-3 text-sm">
              <li>
                <a
                  href="https://github.com/bm1314/passshare"
                  className="text-dark-400 hover:text-white transition-colors"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
              </li>
              <li>
                <Link to="/docs" className="text-dark-400 hover:text-white transition-colors">
                  APIリファレンス
                </Link>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="font-medium text-white mb-4">リーガル</h3>
            <ul className="space-y-3 text-sm">
              <li>
                <a href="/terms" className="text-dark-400 hover:text-white transition-colors">
                  利用規約
                </a>
              </li>
              <li>
                <a href="/privacy" className="text-dark-400 hover:text-white transition-colors">
                  プライバシーポリシー
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="border-t border-dark-800 mt-10 pt-8 flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-6">
            <a
              href="https://github.com/bm1314/passshare"
              className="text-dark-500 hover:text-white transition-colors text-sm"
            >
              GitHub
            </a>
            <a
              href="https://twitter.com/bm1314"
              className="text-dark-500 hover:text-white transition-colors text-sm"
            >
              Twitter / X
            </a>
          </div>
          <div className="flex items-center gap-2 text-dark-500 text-sm">
            <a
              href="https://bm1314.co.jp"
              className="hover:text-white transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              株式会社BM1314
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
