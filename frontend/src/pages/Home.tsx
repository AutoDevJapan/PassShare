import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
  Download,
  Upload,
  CheckCircle,
  Key,
  FolderOpen,
  Plus,
  Eye,
  Copy,
} from 'lucide-react';
import FeatureCard from '../components/FeatureCard';

export default function Home() {
  const { t } = useTranslation();

  const features = [
    {
      icon: Shield,
      title: t('features.gpgEncryption.title'),
      description: t('features.gpgEncryption.description'),
    },
    {
      icon: GitBranch,
      title: t('features.gitSync.title'),
      description: t('features.gitSync.description'),
    },
    {
      icon: Users,
      title: t('features.teamSharing.title'),
      description: t('features.teamSharing.description'),
    },
    {
      icon: Lock,
      title: t('features.gopassCompat.title'),
      description: t('features.gopassCompat.description'),
    },
    {
      icon: Terminal,
      title: t('features.cliApi.title'),
      description: t('features.cliApi.description'),
    },
    {
      icon: Code,
      title: t('features.multiLangSdk.title'),
      description: t('features.multiLangSdk.description'),
    },
    {
      icon: Zap,
      title: t('features.performance.title'),
      description: t('features.performance.description'),
    },
    {
      icon: Globe,
      title: t('features.crossPlatform.title'),
      description: t('features.crossPlatform.description'),
    },
  ];

  return (
    <div className="animate-fade-in">
      {/* Hero Section */}
      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-dark-800 border border-dark-700 text-dark-400 text-sm mb-6">
              <span className="w-2 h-2 rounded-full bg-primary-500"></span>
              {t('hero.badge')}
            </div>

            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6 leading-tight">
              {t('hero.title1')}
              <br />
              <span className="gradient-text">{t('hero.title2')}</span>{t('hero.title3')}
            </h1>

            <p className="text-lg text-dark-400 mb-8 max-w-2xl">
              {t('hero.description')}
            </p>

            <div className="flex flex-wrap gap-3">
              <Link to="/download" className="btn btn-primary px-6 py-2.5">
                {t('common.download')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
              <Link to="/docs" className="btn btn-secondary px-6 py-2.5">
                {t('hero.viewDocs')}
              </Link>
            </div>
          </div>

          {/* Quick Start Steps */}
          <div className="mt-16 max-w-3xl">
            <div className="card p-6 md:p-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold text-white">{t('quickstart.title')}</h2>
                <Link to="/docs" className="text-primary-400 hover:text-primary-300 text-sm flex items-center gap-1">
                  {t('quickstart.viewDetails')}
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>

              <div className="space-y-6">
                {/* Step 1: Install */}
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-500/20 flex items-center justify-center text-primary-400 font-bold text-sm">
                    1
                  </div>
                  <div className="flex-grow min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <Download className="h-4 w-4 text-primary-400" />
                      <span className="font-medium text-white">{t('quickstart.step1.title')}</span>
                    </div>
                    <div className="code-block text-sm">
                      <code className="text-primary-400">pip install passshare</code>
                    </div>
                  </div>
                </div>

                {/* Step 2: Check GPG Key */}
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-500/20 flex items-center justify-center text-primary-400 font-bold text-sm">
                    2
                  </div>
                  <div className="flex-grow min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <Key className="h-4 w-4 text-primary-400" />
                      <span className="font-medium text-white">{t('quickstart.step2.title')}</span>
                    </div>
                    <div className="code-block text-sm mb-2">
                      <code className="text-primary-400">gpg --list-keys --keyid-format LONG</code>
                    </div>
                    <p className="text-dark-500 text-xs">{t('quickstart.step2.hint')}</p>
                    <div className="mt-2 p-3 rounded-lg bg-dark-800/50 border border-dark-700 text-xs">
                      <p className="text-dark-500 mb-1">{t('quickstart.step2.output')}</p>
                      <pre className="text-dark-400 font-mono overflow-x-auto">
{`pub   ed25519/ABCD1234EFGH5678 2024-01-01 [SC]
uid           [ultimate] Your Name <you@example.com>`}
                      </pre>
                      <p className="text-dark-500 mt-2">
                        → <span className="text-primary-400 font-mono">ABCD1234EFGH5678</span> {t('quickstart.step2.useThis')}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Step 3: Initialize Store */}
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-500/20 flex items-center justify-center text-primary-400 font-bold text-sm">
                    3
                  </div>
                  <div className="flex-grow min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <FolderOpen className="h-4 w-4 text-primary-400" />
                      <span className="font-medium text-white">{t('quickstart.step3.title')}</span>
                    </div>
                    <div className="code-block text-sm">
                      <code className="text-primary-400">passshare init ABCD1234EFGH5678</code>
                    </div>
                    <p className="text-dark-500 text-xs mt-2">{t('quickstart.step3.hint')}</p>
                  </div>
                </div>

                {/* Step 4: Add Password */}
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-500/20 flex items-center justify-center text-primary-400 font-bold text-sm">
                    4
                  </div>
                  <div className="flex-grow min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <Plus className="h-4 w-4 text-primary-400" />
                      <span className="font-medium text-white">{t('quickstart.step4.title')}</span>
                    </div>
                    <div className="code-block text-sm">
                      <code className="text-primary-400">passshare insert email/gmail</code>
                    </div>
                    <p className="text-dark-500 text-xs mt-2">{t('quickstart.step4.hint')}</p>
                  </div>
                </div>

                {/* Step 5: Show Password */}
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-500/20 flex items-center justify-center text-primary-400 font-bold text-sm">
                    5
                  </div>
                  <div className="flex-grow min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <Eye className="h-4 w-4 text-primary-400" />
                      <span className="font-medium text-white">{t('quickstart.step5.title')}</span>
                    </div>
                    <div className="code-block text-sm space-y-1">
                      <div className="flex items-center gap-2">
                        <code className="text-primary-400">passshare show email/gmail</code>
                        <span className="text-dark-600">|</span>
                        <span className="text-dark-500 text-xs">{t('quickstart.step5.terminal')}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="text-primary-400">passshare show -c email/gmail</code>
                        <span className="text-dark-600">|</span>
                        <Copy className="h-3 w-3 text-dark-500" />
                        <span className="text-dark-500 text-xs">{t('quickstart.step5.clipboard')}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Success */}
                <div className="flex gap-4 pt-4 border-t border-dark-700">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                    <CheckCircle className="h-4 w-4 text-green-400" />
                  </div>
                  <div>
                    <span className="font-medium text-green-400">{t('quickstart.done.title')}</span>
                    <p className="text-dark-500 text-sm mt-1">{t('quickstart.done.description')}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 border-t border-dark-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-12">
            <h2 className="section-title text-white">
              {t('features.title')}
            </h2>
            <p className="section-subtitle">
              {t('features.description')}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {features.map((feature) => (
              <FeatureCard key={feature.title} {...feature} />
            ))}
          </div>
        </div>
      </section>

      {/* Migration Section */}
      <section className="py-16 border-t border-dark-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-12">
            <h2 className="section-title text-white">
              {t('migration.title')}
            </h2>
            <p className="section-subtitle">
              {t('migration.description')}
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Supported Services */}
            <div className="card p-6">
              <h3 className="text-lg font-semibold text-white mb-4">{t('migration.supported')}</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { name: t('migration.onePassword'), icon: '1️⃣' },
                  { name: t('migration.bitwarden'), icon: '🔐' },
                  { name: t('migration.passGopass'), icon: '🔑' },
                  { name: t('migration.lastpass'), icon: '🔒' },
                  { name: t('migration.keepass'), icon: '🗝️' },
                ].map((service) => (
                  <div
                    key={service.name}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-dark-700/50 text-dark-300"
                  >
                    <span>{service.icon}</span>
                    <span className="text-sm">{service.name}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Migration Steps */}
            <div className="card p-6">
              <h3 className="text-lg font-semibold text-white mb-4">{t('migration.fromAny')}</h3>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-500/10 flex items-center justify-center">
                    <Download className="h-4 w-4 text-primary-400" />
                  </div>
                  <div>
                    <p className="text-white font-medium">1. {t('migration.steps.export')}</p>
                    <p className="text-dark-500 text-sm">CSV / JSON</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-500/10 flex items-center justify-center">
                    <Upload className="h-4 w-4 text-primary-400" />
                  </div>
                  <div>
                    <p className="text-white font-medium">2. {t('migration.steps.import')}</p>
                    <p className="text-dark-500 text-sm font-mono text-xs">passshare import --from bitwarden export.json</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-500/10 flex items-center justify-center">
                    <CheckCircle className="h-4 w-4 text-primary-400" />
                  </div>
                  <div>
                    <p className="text-white font-medium">3. {t('migration.steps.done')}</p>
                  </div>
                </div>
              </div>
              <Link to="/docs" className="btn btn-outline mt-6 w-full">
                {t('migration.cta')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Comparison Section */}
      <section className="py-16 border-t border-dark-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-12">
            <h2 className="section-title text-white">
              {t('comparison.title')}
            </h2>
            <p className="section-subtitle">
              {t('comparison.description')}
            </p>
          </div>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-dark-700 bg-dark-800/50">
                    <th className="text-left py-4 px-6 font-medium text-dark-300">{t('comparison.feature')}</th>
                    <th className="text-center py-4 px-6 font-medium text-primary-400">PassShare</th>
                    <th className="text-center py-4 px-6 font-medium text-dark-400">1Password</th>
                    <th className="text-center py-4 px-6 font-medium text-dark-400">Bitwarden</th>
                    <th className="text-center py-4 px-6 font-medium text-dark-400">pass/gopass</th>
                  </tr>
                </thead>
                <tbody className="text-dark-300">
                  <tr className="border-b border-dark-700/50">
                    <td className="py-4 px-6">{t('comparison.freePlan')}</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /><span className="text-dark-500 text-xs ml-1">{t('comparison.allFeatures')}</span></td>
                    <td className="text-center py-4 px-6 text-dark-500">{t('comparison.limited')}</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /><span className="text-dark-500 text-xs ml-1">{t('comparison.limited')}</span></td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                  </tr>
                  <tr className="border-b border-dark-700/50">
                    <td className="py-4 px-6">{t('comparison.selfHost')}</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                  </tr>
                  <tr className="border-b border-dark-700/50">
                    <td className="py-4 px-6">{t('comparison.gpgEncryption')}</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                  </tr>
                  <tr className="border-b border-dark-700/50">
                    <td className="py-4 px-6">{t('comparison.gitSync')}</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6 text-dark-500">—</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                  </tr>
                  <tr className="border-b border-dark-700/50">
                    <td className="py-4 px-6">{t('comparison.programmaticApi')}</td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /></td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /><span className="text-dark-500 text-xs ml-1">{t('comparison.paid')}</span></td>
                    <td className="text-center py-4 px-6"><Check className="inline h-4 w-4 text-primary-400" /><span className="text-dark-500 text-xs ml-1">{t('comparison.paid')}</span></td>
                    <td className="text-center py-4 px-6 text-dark-500">{t('comparison.viaCli')}</td>
                  </tr>
                  <tr>
                    <td className="py-4 px-6">{t('comparison.multiLangSdk')}</td>
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
              {t('cta.title')}
            </h2>
            <p className="text-dark-400 mb-8 max-w-xl mx-auto">
              {t('cta.description')}
            </p>
            <Link to="/download" className="btn btn-primary px-8 py-3">
              {t('cta.freeDownload')}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
