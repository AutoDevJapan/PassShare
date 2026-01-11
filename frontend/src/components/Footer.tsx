import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function Footer() {
  const { t } = useTranslation();

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
              © 2026 BM1314 Inc.
              <br />
              {t('common.allRightsReserved')}
            </p>
          </div>

          {/* Discover */}
          <div>
            <h3 className="font-medium text-white mb-4">{t('common.product')}</h3>
            <ul className="space-y-3 text-sm">
              <li>
                <Link to="/" className="text-dark-400 hover:text-white transition-colors">
                  {t('common.home')}
                </Link>
              </li>
              <li>
                <Link to="/download" className="text-dark-400 hover:text-white transition-colors">
                  {t('common.download')}
                </Link>
              </li>
              <li>
                <Link to="/docs" className="text-dark-400 hover:text-white transition-colors">
                  {t('common.docs')}
                </Link>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h3 className="font-medium text-white mb-4">{t('common.resources')}</h3>
            <ul className="space-y-3 text-sm">
              <li>
                <Link to="/docs" className="text-dark-400 hover:text-white transition-colors">
                  {t('common.apiReference')}
                </Link>
              </li>
              <li>
                <a
                  href="https://bm1314.co.jp/support"
                  className="text-dark-400 hover:text-white transition-colors"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('common.support')}
                </a>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="font-medium text-white mb-4">{t('common.legal')}</h3>
            <ul className="space-y-3 text-sm">
              <li>
                <a href="/terms" className="text-dark-400 hover:text-white transition-colors">
                  {t('common.termsOfService')}
                </a>
              </li>
              <li>
                <a href="/privacy" className="text-dark-400 hover:text-white transition-colors">
                  {t('common.privacyPolicy')}
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom */}
        <div className="border-t border-dark-800 mt-10 pt-8 flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-6">
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
              BM1314 Inc.
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
