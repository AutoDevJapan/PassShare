import { useEffect, useState } from 'react';
import { Save, Plus, Trash2, RefreshCw, User, Key, FolderTree, Users } from 'lucide-react';
import api, { type ConfigResponse, type MountResponse, type RecipientResponse } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import clsx from 'clsx';

type Tab = 'general' | 'mounts' | 'recipients' | 'account';

export default function SettingsPanel() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Config state
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configDraft, setConfigDraft] = useState({
    autoclip: true,
    cliptimeout: 45,
    autosync: true,
    autopush: true,
  });

  // Mounts state
  const [mounts, setMounts] = useState<MountResponse[]>([]);
  const [newMount, setNewMount] = useState({ alias: '', path: '' });

  // Recipients state
  const [recipients, setRecipients] = useState<RecipientResponse[]>([]);
  const [newRecipient, setNewRecipient] = useState('');

  useEffect(() => {
    loadConfig();
    loadMounts();
    loadRecipients();
  }, []);

  const loadConfig = async () => {
    try {
      const data = await api.getConfig();
      setConfig(data);
      setConfigDraft({
        autoclip: data.autoclip,
        cliptimeout: data.cliptimeout,
        autosync: data.autosync,
        autopush: data.autopush,
      });
    } catch (err) {
      console.error('Failed to load config:', err);
    }
  };

  const loadMounts = async () => {
    try {
      const data = await api.getMounts();
      setMounts(data);
    } catch (err) {
      console.error('Failed to load mounts:', err);
    }
  };

  const loadRecipients = async () => {
    try {
      const data = await api.getRecipients();
      setRecipients(data);
    } catch (err) {
      console.error('Failed to load recipients:', err);
    }
  };

  const handleSaveConfig = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await api.updateConfig(configDraft);
      setSuccess('Settings saved');
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddMount = async () => {
    if (!newMount.alias.trim() || !newMount.path.trim()) {
      setError('Both alias and path are required');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      await api.addMount(newMount.alias.trim(), newMount.path.trim());
      setNewMount({ alias: '', path: '' });
      loadMounts();
      setSuccess('Mount added');
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add mount');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveMount = async (alias: string) => {
    setIsLoading(true);
    setError(null);
    try {
      await api.removeMount(alias);
      loadMounts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove mount');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddRecipient = async () => {
    if (!newRecipient.trim()) {
      setError('Key ID is required');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      await api.addRecipient(newRecipient.trim());
      setNewRecipient('');
      loadRecipients();
      setSuccess('Recipient added');
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add recipient');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveRecipient = async (keyId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      await api.removeRecipient(keyId);
      loadRecipients();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove recipient');
    } finally {
      setIsLoading(false);
    }
  };

  const tabs = [
    { id: 'general' as Tab, label: 'General', icon: Key },
    { id: 'mounts' as Tab, label: 'Mounts', icon: FolderTree },
    { id: 'recipients' as Tab, label: 'Recipients', icon: Users },
    { id: 'account' as Tab, label: 'Account', icon: User },
  ];

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold text-white mb-6">Settings</h2>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors',
                activeTab === tab.id
                  ? 'bg-primary-500 text-white'
                  : 'bg-dark-800 text-dark-400 hover:bg-dark-700'
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Messages */}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-green-400 text-sm">
          {success}
        </div>
      )}

      {/* General Settings */}
      {activeTab === 'general' && (
        <div className="card p-6 space-y-6">
          <div>
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Store Path
            </label>
            <p className="text-white font-mono text-sm bg-dark-800 rounded-lg px-4 py-2">
              {config?.path || 'Not set'}
            </p>
          </div>

          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={configDraft.autoclip}
                onChange={(e) =>
                  setConfigDraft({ ...configDraft, autoclip: e.target.checked })
                }
                className="w-4 h-4 rounded border-dark-600 bg-dark-800 text-primary-500 focus:ring-primary-500"
              />
              <div>
                <span className="text-white">Auto-copy to clipboard</span>
                <p className="text-xs text-dark-500">
                  Automatically copy password when viewing
                </p>
              </div>
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Clipboard timeout (seconds)
            </label>
            <input
              type="number"
              min="10"
              max="300"
              value={configDraft.cliptimeout}
              onChange={(e) =>
                setConfigDraft({ ...configDraft, cliptimeout: Number(e.target.value) })
              }
              className="w-32 bg-dark-800 border border-dark-700 rounded-lg px-4 py-2 text-white focus:border-primary-500 outline-none"
            />
          </div>

          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={configDraft.autosync}
                onChange={(e) =>
                  setConfigDraft({ ...configDraft, autosync: e.target.checked })
                }
                className="w-4 h-4 rounded border-dark-600 bg-dark-800 text-primary-500 focus:ring-primary-500"
              />
              <div>
                <span className="text-white">Auto-sync</span>
                <p className="text-xs text-dark-500">
                  Automatically sync with Git remote
                </p>
              </div>
            </label>
          </div>

          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={configDraft.autopush}
                onChange={(e) =>
                  setConfigDraft({ ...configDraft, autopush: e.target.checked })
                }
                className="w-4 h-4 rounded border-dark-600 bg-dark-800 text-primary-500 focus:ring-primary-500"
              />
              <div>
                <span className="text-white">Auto-push</span>
                <p className="text-xs text-dark-500">
                  Automatically push changes after save
                </p>
              </div>
            </label>
          </div>

          <button
            onClick={handleSaveConfig}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {isLoading ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save Settings
          </button>
        </div>
      )}

      {/* Mounts */}
      {activeTab === 'mounts' && (
        <div className="space-y-4">
          <div className="card p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Add Mount Point</h3>
            <div className="flex gap-3">
              <input
                type="text"
                value={newMount.alias}
                onChange={(e) => setNewMount({ ...newMount, alias: e.target.value })}
                placeholder="Alias (e.g., work)"
                className="w-32 bg-dark-800 border border-dark-700 rounded-lg px-4 py-2 text-white placeholder-dark-500 focus:border-primary-500 outline-none"
              />
              <input
                type="text"
                value={newMount.path}
                onChange={(e) => setNewMount({ ...newMount, path: e.target.value })}
                placeholder="Path (e.g., ~/.password-store-work)"
                className="flex-1 bg-dark-800 border border-dark-700 rounded-lg px-4 py-2 text-white placeholder-dark-500 focus:border-primary-500 outline-none"
              />
              <button
                onClick={handleAddMount}
                disabled={isLoading}
                className="flex items-center gap-2 px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Add
              </button>
            </div>
          </div>

          {mounts.length > 0 && (
            <div className="card p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Current Mounts</h3>
              <div className="space-y-2">
                {mounts.map((mount) => (
                  <div
                    key={mount.alias}
                    className="flex items-center justify-between p-3 bg-dark-800 rounded-lg"
                  >
                    <div>
                      <span className="text-white font-medium">{mount.alias}</span>
                      <span className="text-dark-500 mx-2">→</span>
                      <span className="text-dark-400 font-mono text-sm">{mount.path}</span>
                    </div>
                    <button
                      onClick={() => handleRemoveMount(mount.alias)}
                      className="p-2 text-dark-500 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {mounts.length === 0 && (
            <div className="card p-8 text-center">
              <FolderTree className="h-12 w-12 text-dark-600 mx-auto mb-3" />
              <p className="text-dark-400">No mount points configured</p>
            </div>
          )}
        </div>
      )}

      {/* Recipients */}
      {activeTab === 'recipients' && (
        <div className="space-y-4">
          <div className="card p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Add Recipient</h3>
            <div className="flex gap-3">
              <input
                type="text"
                value={newRecipient}
                onChange={(e) => setNewRecipient(e.target.value)}
                placeholder="GPG Key ID (e.g., ABCD1234EFGH5678)"
                className="flex-1 bg-dark-800 border border-dark-700 rounded-lg px-4 py-2 text-white placeholder-dark-500 focus:border-primary-500 outline-none"
              />
              <button
                onClick={handleAddRecipient}
                disabled={isLoading}
                className="flex items-center gap-2 px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Add
              </button>
            </div>
          </div>

          {recipients.length > 0 && (
            <div className="card p-6">
              <h3 className="text-lg font-semibold text-white mb-4">Current Recipients</h3>
              <div className="space-y-2">
                {recipients.map((recipient) => (
                  <div
                    key={recipient.key_id}
                    className="flex items-center justify-between p-3 bg-dark-800 rounded-lg"
                  >
                    <div>
                      <span className="text-white font-mono">{recipient.key_id}</span>
                      {recipient.name && (
                        <span className="text-dark-400 ml-2">({recipient.name})</span>
                      )}
                    </div>
                    <button
                      onClick={() => handleRemoveRecipient(recipient.key_id)}
                      className="p-2 text-dark-500 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {recipients.length === 0 && (
            <div className="card p-8 text-center">
              <Users className="h-12 w-12 text-dark-600 mx-auto mb-3" />
              <p className="text-dark-400">No recipients configured</p>
            </div>
          )}
        </div>
      )}

      {/* Account */}
      {activeTab === 'account' && (
        <div className="card p-6 space-y-6">
          <div>
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Username
            </label>
            <p className="text-white font-medium">{user?.username}</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-dark-300 mb-2">
              GPG Key ID
            </label>
            <p className="text-white font-mono">
              {user?.gpg_key_id || 'Not configured'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Account Created
            </label>
            <p className="text-dark-400">
              {user?.created_at
                ? new Date(user.created_at).toLocaleDateString()
                : 'Unknown'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
