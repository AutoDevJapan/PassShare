import { Link, useLocation } from 'react-router-dom';
import { Menu, X, Search } from 'lucide-react';
import { useState } from 'react';
import clsx from 'clsx';

const navLinks = [
  { href: '/', label: 'ホーム' },
  { href: '/download', label: 'ダウンロード' },
  { href: '/docs', label: 'ドキュメント' },
];

export default function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const location = useLocation();

  return (
    <header className="sticky top-0 z-50 bg-dark-900/95 backdrop-blur-sm border-b border-dark-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo.png" alt="PassShare" className="h-7 w-7" />
            <span className="text-lg font-semibold text-white">PassShare</span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm transition-colors',
                  location.pathname === link.href
                    ? 'text-white bg-dark-800'
                    : 'text-dark-400 hover:text-white hover:bg-dark-800'
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Right side */}
          <div className="hidden md:flex items-center gap-3">
            {/* Search hint */}
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-dark-800 border border-dark-700 text-dark-500 text-sm hover:border-dark-600 transition-colors">
              <Search className="h-4 w-4" />
              <span>検索...</span>
              <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded bg-dark-700 text-dark-400 text-xs font-mono">
                ⌘K
              </kbd>
            </button>

            {/* GitHub */}
            <a
              href="https://github.com/bm1314/passshare"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary py-1.5"
            >
              GitHub
            </a>
          </div>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden p-2 text-dark-400 hover:text-white"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            aria-label="Toggle menu"
          >
            {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Navigation */}
      {isMenuOpen && (
        <div className="md:hidden border-t border-dark-800 bg-dark-900">
          <nav className="px-4 py-3 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className={clsx(
                  'block px-3 py-2 rounded-lg text-sm',
                  location.pathname === link.href
                    ? 'text-white bg-dark-800'
                    : 'text-dark-400 hover:text-white hover:bg-dark-800'
                )}
                onClick={() => setIsMenuOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <a
              href="https://github.com/bm1314/passshare"
              target="_blank"
              rel="noopener noreferrer"
              className="block px-3 py-2 text-sm text-primary-400 hover:text-primary-300"
            >
              GitHub
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
