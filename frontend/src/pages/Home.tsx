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
} from 'lucide-react';
import FeatureCard from '../components/FeatureCard';

const codeExample = `# Install
pip install passshare

# Initialize store
passshare init YOUR_GPG_KEY

# Add password
passshare insert email/gmail

# Show password
passshare show email/gmail`;

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
