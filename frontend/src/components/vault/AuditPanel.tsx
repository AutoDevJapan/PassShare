import { useState } from 'react';
import { Shield, AlertTriangle, Copy, RefreshCw } from 'lucide-react';
import { useAudit } from '../../hooks/useSecrets';
import clsx from 'clsx';

export default function AuditPanel() {
  const { audit, isLoading, error, runAudit } = useAudit();
  const [folder, setFolder] = useState('');

  const handleRunAudit = () => {
    runAudit(folder);
  };

  const getStrengthColor = (strength: string) => {
    switch (strength) {
      case 'weak':
        return 'text-red-400 bg-red-500/10';
      case 'fair':
        return 'text-yellow-400 bg-yellow-500/10';
      case 'good':
        return 'text-green-400 bg-green-500/10';
      case 'strong':
        return 'text-primary-400 bg-primary-500/10';
      default:
        return 'text-dark-400 bg-dark-700';
    }
  };

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold text-white mb-6">Password Audit</h2>

      {/* Controls */}
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="Folder to audit (optional)"
          className="flex-1 bg-dark-800 border border-dark-700 rounded-lg px-4 py-2.5 text-white placeholder-dark-500 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 outline-none"
        />
        <button
          onClick={handleRunAudit}
          disabled={isLoading}
          className="flex items-center gap-2 px-6 py-2.5 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {isLoading ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Shield className="h-4 w-4" />
          )}
          <span>Run Audit</span>
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {audit && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="card p-4 text-center">
              <p className="text-3xl font-bold text-white">{audit.total_secrets}</p>
              <p className="text-sm text-dark-500">Total Secrets</p>
            </div>
            <div className="card p-4 text-center">
              <p className={clsx(
                'text-3xl font-bold',
                audit.weak_passwords.length > 0 ? 'text-red-400' : 'text-green-400'
              )}>
                {audit.weak_passwords.length}
              </p>
              <p className="text-sm text-dark-500">Weak Passwords</p>
            </div>
            <div className="card p-4 text-center">
              <p className={clsx(
                'text-3xl font-bold',
                audit.duplicates.length > 0 ? 'text-yellow-400' : 'text-green-400'
              )}>
                {audit.duplicates.length}
              </p>
              <p className="text-sm text-dark-500">Duplicate Groups</p>
            </div>
          </div>

          {/* All good message */}
          {audit.weak_passwords.length === 0 && audit.duplicates.length === 0 && (
            <div className="card p-6 text-center">
              <Shield className="h-12 w-12 text-green-400 mx-auto mb-3" />
              <h3 className="text-lg font-semibold text-white mb-2">
                All passwords look good!
              </h3>
              <p className="text-dark-400">
                No weak passwords or duplicates were found.
              </p>
            </div>
          )}

          {/* Weak Passwords */}
          {audit.weak_passwords.length > 0 && (
            <div className="mb-6">
              <h3 className="flex items-center gap-2 text-lg font-semibold text-white mb-4">
                <AlertTriangle className="h-5 w-5 text-red-400" />
                Weak Passwords
              </h3>
              <div className="space-y-2">
                {audit.weak_passwords.map((item) => (
                  <div
                    key={item.name}
                    className="card p-4 flex items-center justify-between"
                  >
                    <div>
                      <p className="text-white font-medium">{item.name}</p>
                      {item.issues.length > 0 && (
                        <p className="text-sm text-dark-500">
                          {item.issues.join(', ')}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-dark-500">
                        Entropy: {item.entropy.toFixed(1)}
                      </span>
                      <span
                        className={clsx(
                          'px-2 py-1 rounded text-xs font-medium uppercase',
                          getStrengthColor(item.strength)
                        )}
                      >
                        {item.strength}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Duplicates */}
          {audit.duplicates.length > 0 && (
            <div>
              <h3 className="flex items-center gap-2 text-lg font-semibold text-white mb-4">
                <Copy className="h-5 w-5 text-yellow-400" />
                Duplicate Passwords
              </h3>
              <div className="space-y-3">
                {audit.duplicates.map((group, index) => (
                  <div key={index} className="card p-4">
                    <p className="text-sm text-dark-500 mb-2">
                      {group.length} secrets share the same password:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {group.map((name) => (
                        <span
                          key={name}
                          className="px-2 py-1 bg-dark-700 rounded text-sm text-white"
                        >
                          {name}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {!audit && !isLoading && (
        <div className="card p-8 text-center">
          <Shield className="h-12 w-12 text-dark-600 mx-auto mb-3" />
          <p className="text-dark-400">
            Click "Run Audit" to check your password security
          </p>
        </div>
      )}
    </div>
  );
}
