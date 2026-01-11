import { useState } from 'react';
import { Copy, Check, RefreshCw, Wand2 } from 'lucide-react';
import { useSecretActions } from '../../hooks/useSecrets';
import api from '../../api/client';
import clsx from 'clsx';

interface PasswordGeneratorProps {
  onGenerated?: () => void;
}

export default function PasswordGenerator({ onGenerated }: PasswordGeneratorProps) {
  const { generatePassword, isLoading } = useSecretActions();

  const [mode, setMode] = useState<'save' | 'standalone'>('standalone');
  const [name, setName] = useState('');
  const [length, setLength] = useState(24);
  const [symbols, setSymbols] = useState(true);
  const [xkcd, setXkcd] = useState(false);
  const [passwords, setPasswords] = useState<string[]>([]);
  const [copied, setCopied] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setError(null);
    try {
      if (mode === 'save') {
        if (!name.trim()) {
          setError('Name is required');
          return;
        }
        const result = await generatePassword({
          name: name.trim(),
          length,
          symbols,
          xkcd,
        });
        setPasswords([result.password]);
        onGenerated?.();
      } else {
        const result = await api.generateStandalonePassword({
          length,
          symbols,
          xkcd,
          count: 5,
        });
        setPasswords(result.passwords);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    }
  };

  const copyToClipboard = async (password: string, index: number) => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(index);
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="max-w-xl">
      <h2 className="text-xl font-bold text-white mb-6">Password Generator</h2>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Mode Toggle */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setMode('standalone')}
          className={clsx(
            'flex-1 py-2 px-4 rounded-lg text-sm transition-colors',
            mode === 'standalone'
              ? 'bg-primary-500 text-white'
              : 'bg-dark-800 text-dark-400 hover:bg-dark-700'
          )}
        >
          Generate Only
        </button>
        <button
          onClick={() => setMode('save')}
          className={clsx(
            'flex-1 py-2 px-4 rounded-lg text-sm transition-colors',
            mode === 'save'
              ? 'bg-primary-500 text-white'
              : 'bg-dark-800 text-dark-400 hover:bg-dark-700'
          )}
        >
          Generate & Save
        </button>
      </div>

      {/* Name (only for save mode) */}
      {mode === 'save' && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-dark-300 mb-2">
            Secret Name / Path
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="website/example"
            className="w-full bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-white placeholder-dark-500 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 outline-none"
          />
        </div>
      )}

      {/* Options */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-dark-300 mb-2">
            Length
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="8"
              max="64"
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
              disabled={xkcd}
              className="flex-1"
            />
            <span className="w-8 text-center text-white text-sm">{length}</span>
          </div>
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={symbols}
              onChange={(e) => setSymbols(e.target.checked)}
              disabled={xkcd}
              className="w-4 h-4 rounded border-dark-600 bg-dark-800 text-primary-500 focus:ring-primary-500"
            />
            <span className="text-sm text-dark-300">Include symbols</span>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={xkcd}
              onChange={(e) => setXkcd(e.target.checked)}
              className="w-4 h-4 rounded border-dark-600 bg-dark-800 text-primary-500 focus:ring-primary-500"
            />
            <span className="text-sm text-dark-300">XKCD style (words)</span>
          </label>
        </div>
      </div>

      {/* Generate Button */}
      <button
        onClick={handleGenerate}
        disabled={isLoading}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors disabled:opacity-50"
      >
        {isLoading ? (
          <RefreshCw className="h-5 w-5 animate-spin" />
        ) : (
          <Wand2 className="h-5 w-5" />
        )}
        <span>{isLoading ? 'Generating...' : 'Generate Password'}</span>
      </button>

      {/* Results */}
      {passwords.length > 0 && (
        <div className="mt-6">
          <label className="block text-sm font-medium text-dark-300 mb-3">
            Generated Password{passwords.length > 1 ? 's' : ''}
          </label>
          <div className="space-y-2">
            {passwords.map((password, index) => (
              <div
                key={index}
                className="flex items-center gap-2 p-3 bg-dark-800 rounded-lg"
              >
                <code className="flex-1 font-mono text-sm text-white break-all">
                  {password}
                </code>
                <button
                  onClick={() => copyToClipboard(password, index)}
                  className={clsx(
                    'p-2 rounded-lg transition-colors',
                    copied === index
                      ? 'bg-green-500/20 text-green-400'
                      : 'hover:bg-dark-700 text-dark-400 hover:text-white'
                  )}
                >
                  {copied === index ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
