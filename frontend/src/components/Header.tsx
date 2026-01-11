import { Link, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
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
    <header className="sticky top-0 z-50 bg-dark-800/80 backdrop-blur-lg border-b border-dark-700">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3">
            <img src="/logo.png" alt="PassShare" className="h-8 w-8" />
            <span className="text-xl font-bold gradient-text">PassShare</span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className={clsx(
                  'text-sm font-medium transition-colors',
                  location.pathname === link.href
                    ? 'text-primary-400'
                    : 'text-dark-300 hover:text-white'
                )}
              >
                {link.label}
              </Link>
            ))}
            <a
              href="https://github.com/bm1314/passshare"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary text-sm py-2"
            >
              GitHub
            </a>
          </nav>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden p-2"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            aria-label="Toggle menu"
          >
            {isMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Navigation */}
      {isMenuOpen && (
        <div className="md:hidden border-t border-dark-700">
          <nav className="px-4 py-4 space-y-4">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className={clsx(
                  'block text-sm font-medium',
                  location.pathname === link.href
                    ? 'text-primary-400'
                    : 'text-dark-300'
                )}
                onClick={() => setIsMenuOpen(false)}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}
