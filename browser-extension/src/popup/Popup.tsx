import { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Key,
  Copy,
  Check,
  ExternalLink,
  RefreshCw,
  Clock,
  Settings,
  AlertCircle,
} from 'lucide-react';
import clsx from 'clsx';

interface Secret {
  name: string;
  password: string;
  data: Record<string, string>;
  hasOtp?: boolean;
}

interface Message {
  action: string;
  payload?: unknown;
}

async function sendMessage(message: Message): Promise<{
  success: boolean;
  data?: unknown;
  error?: string;
}> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || { success: false, error: 'No response' });
    });
  });
}

export default function Popup() {
  const [secrets, setSecrets] = useState<string[]>([]);
  const [matchingSecrets, setMatchingSecrets] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSecret, setSelectedSecret] = useState<Secret | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>('');

  // Load secrets and find matches for current URL
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Get current URL
      const urlResult = await sendMessage({ action: 'getCurrentUrl' });
      if (urlResult.success && urlResult.data) {
        setCurrentUrl(urlResult.data as string);
      }

      // Find matching secrets for current URL
      const matchResult = await sendMessage({ action: 'findForUrl' });
      if (matchResult.success && Array.isArray(matchResult.data)) {
        setMatchingSecrets(matchResult.data);
      }

      // Load all secrets
      const listResult = await sendMessage({ action: 'list' });
      if (listResult.success && Array.isArray(listResult.data)) {
        setSecrets(listResult.data);
      } else {
        setError(listResult.error || 'Failed to load secrets');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
  };

  const handleSelectSecret = async (name: string) => {
    try {
      const result = await sendMessage({ action: 'get', payload: name });
      if (result.success && result.data) {
        setSelectedSecret({ name, ...(result.data as Omit<Secret, 'name'>) });
      }
    } catch (err) {
      console.error('Failed to get secret:', err);
    }
  };

  const handleFill = async (name: string) => {
    await sendMessage({ action: 'fill', payload: name });
    window.close();
  };

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const filteredSecrets = searchQuery
    ? secrets.filter((s) => s.toLowerCase().includes(searchQuery.toLowerCase()))
    : secrets;

  const displaySecrets = matchingSecrets.length > 0 && !searchQuery
    ? matchingSecrets
    : filteredSecrets;

  return (
    <div className="w-80 bg-dark-950 text-white">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-dark-800">
        <div className="flex items-center gap-2">
          <Key className="h-5 w-5 text-primary-400" />
          <span className="font-semibold">PassShare</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={loadData}
            className="p-1.5 text-dark-400 hover:text-white rounded transition-colors"
            title="Refresh"
          >
            <RefreshCw className={clsx('h-4 w-4', isLoading && 'animate-spin')} />
          </button>
          <button
            onClick={() => chrome.runtime.openOptionsPage()}
            className="p-1.5 text-dark-400 hover:text-white rounded transition-colors"
            title="Settings"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-dark-800">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
          <input
            type="text"
            placeholder="Search passwords..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-white placeholder-dark-500 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 outline-none"
            autoFocus
          />
        </div>
      </div>

      {/* Content */}
      <div className="max-h-96 overflow-y-auto">
        {error && (
          <div className="p-4 flex items-center gap-2 text-red-400">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {!error && isLoading && (
          <div className="p-8 flex items-center justify-center">
            <RefreshCw className="h-6 w-6 text-dark-500 animate-spin" />
          </div>
        )}

        {!error && !isLoading && selectedSecret && (
          <SecretDetail
            secret={selectedSecret}
            onBack={() => setSelectedSecret(null)}
            onCopy={handleCopy}
            copied={copied}
          />
        )}

        {!error && !isLoading && !selectedSecret && (
          <>
            {matchingSecrets.length > 0 && !searchQuery && (
              <div className="p-2 bg-primary-500/10 border-b border-dark-800">
                <p className="text-xs text-primary-400 px-2">
                  Matching secrets for this site
                </p>
              </div>
            )}

            {displaySecrets.length === 0 && (
              <div className="p-8 text-center text-dark-500 text-sm">
                {searchQuery ? 'No secrets found' : 'No secrets available'}
              </div>
            )}

            {displaySecrets.map((name) => (
              <SecretItem
                key={name}
                name={name}
                isMatch={matchingSecrets.includes(name)}
                onSelect={() => handleSelectSecret(name)}
                onFill={() => handleFill(name)}
              />
            ))}
          </>
        )}
      </div>

      {/* Footer */}
      {currentUrl && (
        <div className="p-2 border-t border-dark-800 flex items-center gap-2 text-xs text-dark-500">
          <ExternalLink className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{new URL(currentUrl).hostname}</span>
        </div>
      )}
    </div>
  );
}

interface SecretItemProps {
  name: string;
  isMatch: boolean;
  onSelect: () => void;
  onFill: () => void;
}

function SecretItem({ name, isMatch, onSelect, onFill }: SecretItemProps) {
  const parts = name.split('/');
  const displayName = parts[parts.length - 1];
  const folder = parts.slice(0, -1).join('/');

  return (
    <div
      className={clsx(
        'flex items-center gap-2 px-3 py-2 hover:bg-dark-800 cursor-pointer border-b border-dark-800/50',
        isMatch && 'bg-primary-500/5'
      )}
      onClick={onSelect}
    >
      <Key className="h-4 w-4 text-dark-500 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{displayName}</p>
        {folder && <p className="text-xs text-dark-500 truncate">{folder}</p>}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onFill();
        }}
        className="px-2 py-1 text-xs bg-primary-500 hover:bg-primary-600 text-white rounded transition-colors"
      >
        Fill
      </button>
    </div>
  );
}

interface SecretDetailProps {
  secret: Secret;
  onBack: () => void;
  onCopy: (text: string, label: string) => void;
  copied: string | null;
}

function SecretDetail({ secret, onBack, onCopy, copied }: SecretDetailProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [otp, setOtp] = useState<string | null>(null);

  useEffect(() => {
    if (secret.hasOtp) {
      const fetchOtp = async () => {
        const result = await sendMessage({ action: 'otp', payload: secret.name });
        if (result.success && result.data) {
          setOtp(result.data as string);
        }
      };
      fetchOtp();
      const interval = setInterval(fetchOtp, 30000);
      return () => clearInterval(interval);
    }
  }, [secret.name, secret.hasOtp]);

  return (
    <div className="p-3">
      <button
        onClick={onBack}
        className="text-sm text-primary-400 hover:text-primary-300 mb-3"
      >
        ← Back
      </button>

      <h2 className="font-semibold text-lg mb-3">{secret.name}</h2>

      {/* Password */}
      <div className="mb-3">
        <label className="text-xs text-dark-500 uppercase">Password</label>
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1 bg-dark-800 rounded px-3 py-2 font-mono text-sm">
            {showPassword ? secret.password : '••••••••'}
          </div>
          <button
            onClick={() => setShowPassword(!showPassword)}
            className="p-2 text-dark-400 hover:text-white"
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
          <button
            onClick={() => onCopy(secret.password, 'password')}
            className={clsx(
              'p-2 transition-colors',
              copied === 'password' ? 'text-green-400' : 'text-dark-400 hover:text-white'
            )}
          >
            {copied === 'password' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* OTP */}
      {otp && (
        <div className="mb-3">
          <label className="text-xs text-dark-500 uppercase flex items-center gap-1">
            <Clock className="h-3 w-3" />
            OTP
          </label>
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 bg-dark-800 rounded px-3 py-2 font-mono text-lg font-bold text-primary-400">
              {otp}
            </div>
            <button
              onClick={() => onCopy(otp, 'otp')}
              className={clsx(
                'p-2 transition-colors',
                copied === 'otp' ? 'text-green-400' : 'text-dark-400 hover:text-white'
              )}
            >
              {copied === 'otp' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}

      {/* Metadata */}
      {Object.keys(secret.data).length > 0 && (
        <div className="space-y-2">
          {Object.entries(secret.data).map(([key, value]) => (
            <div key={key}>
              <label className="text-xs text-dark-500 uppercase">{key}</label>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 text-sm truncate">{value}</div>
                <button
                  onClick={() => onCopy(value, key)}
                  className={clsx(
                    'p-1 transition-colors',
                    copied === key ? 'text-green-400' : 'text-dark-500 hover:text-white'
                  )}
                >
                  {copied === key ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
