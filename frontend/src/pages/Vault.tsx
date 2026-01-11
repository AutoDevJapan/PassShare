import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  Plus,
  RefreshCw,
  Key,
  Shield,
  FolderTree,
  List,
  Settings,
  LogOut,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSecrets, useSearch, useSync } from '../hooks/useSecrets';
import SecretList from '../components/vault/SecretList';
import SecretDetail from '../components/vault/SecretDetail';
import SecretForm from '../components/vault/SecretForm';
import PasswordGenerator from '../components/vault/PasswordGenerator';
import AuditPanel from '../components/vault/AuditPanel';
import SettingsPanel from '../components/vault/SettingsPanel';
import clsx from 'clsx';

type ViewMode = 'list' | 'tree';
type Panel = 'detail' | 'add' | 'generate' | 'audit' | 'settings' | null;

export default function Vault() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const { secrets, isLoading, error, refetch } = useSecrets();
  const { results, isSearching, search, clearResults } = useSearch();
  const { isSyncing, sync } = useSync();

  const [selectedSecret, setSelectedSecret] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [activePanel, setActivePanel] = useState<Panel>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (query.trim()) {
      search(query);
    } else {
      clearResults();
    }
  };

  const handleSelectSecret = (name: string) => {
    setSelectedSecret(name);
    setActivePanel('detail');
  };

  const handleSync = async () => {
    await sync();
    refetch();
  };

  const handleSecretCreated = () => {
    setActivePanel(null);
    refetch();
  };

  const handleSecretDeleted = () => {
    setSelectedSecret(null);
    setActivePanel(null);
    refetch();
  };

  const displaySecrets = searchQuery.trim()
    ? secrets.filter((s) => results.includes(s.name))
    : secrets;

  return (
    <div className="min-h-screen bg-dark-950 flex">
      {/* Sidebar */}
      <aside className="w-64 bg-dark-900 border-r border-dark-800 flex flex-col">
        {/* User info */}
        <div className="p-4 border-b border-dark-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary-500/20 flex items-center justify-center">
              <Key className="h-5 w-5 text-primary-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.username}</p>
              <p className="text-xs text-dark-500 truncate">
                {user?.gpg_key_id || 'No GPG key'}
              </p>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="p-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500" />
            <input
              type="text"
              placeholder={t('common.search')}
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-white placeholder-dark-500 focus:border-primary-500 focus:ring-1 focus:ring-primary-500 outline-none"
            />
            {isSearching && (
              <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-dark-500 animate-spin" />
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="px-3 pb-3 flex gap-2">
          <button
            onClick={() => setActivePanel('add')}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-primary-500 hover:bg-primary-600 text-white text-sm rounded-lg transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span>Add</span>
          </button>
          <button
            onClick={() => setActivePanel('generate')}
            className="flex items-center justify-center px-3 py-2 bg-dark-800 hover:bg-dark-700 text-dark-300 text-sm rounded-lg transition-colors"
            title="Generate Password"
          >
            <Shield className="h-4 w-4" />
          </button>
        </div>

        {/* View toggle */}
        <div className="px-3 pb-3 flex gap-1">
          <button
            onClick={() => setViewMode('list')}
            className={clsx(
              'flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-xs rounded-lg transition-colors',
              viewMode === 'list'
                ? 'bg-dark-700 text-white'
                : 'text-dark-400 hover:bg-dark-800'
            )}
          >
            <List className="h-3 w-3" />
            List
          </button>
          <button
            onClick={() => setViewMode('tree')}
            className={clsx(
              'flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-xs rounded-lg transition-colors',
              viewMode === 'tree'
                ? 'bg-dark-700 text-white'
                : 'text-dark-400 hover:bg-dark-800'
            )}
          >
            <FolderTree className="h-3 w-3" />
            Tree
          </button>
        </div>

        {/* Secret list */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-5 w-5 text-dark-500 animate-spin" />
            </div>
          ) : error ? (
            <div className="p-4 text-center text-red-400 text-sm">{error}</div>
          ) : (
            <SecretList
              secrets={displaySecrets}
              selectedSecret={selectedSecret}
              viewMode={viewMode}
              onSelect={handleSelectSecret}
            />
          )}
        </div>

        {/* Bottom actions */}
        <div className="p-3 border-t border-dark-800 space-y-2">
          <button
            onClick={handleSync}
            disabled={isSyncing}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-dark-800 hover:bg-dark-700 text-dark-300 text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={clsx('h-4 w-4', isSyncing && 'animate-spin')} />
            <span>Sync</span>
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => setActivePanel('audit')}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-dark-800 hover:bg-dark-700 text-dark-300 text-sm rounded-lg transition-colors"
            >
              <Shield className="h-4 w-4" />
              Audit
            </button>
            <button
              onClick={() => setActivePanel('settings')}
              className="flex items-center justify-center px-3 py-2 bg-dark-800 hover:bg-dark-700 text-dark-300 text-sm rounded-lg transition-colors"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              onClick={logout}
              className="flex items-center justify-center px-3 py-2 bg-dark-800 hover:bg-red-500/20 text-dark-300 hover:text-red-400 text-sm rounded-lg transition-colors"
              title="Logout"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col">
        {/* Header */}
        <header className="h-14 bg-dark-900 border-b border-dark-800 flex items-center px-6">
          <h1 className="text-lg font-semibold text-white">
            {activePanel === 'add' && 'Add Secret'}
            {activePanel === 'generate' && 'Generate Password'}
            {activePanel === 'audit' && 'Password Audit'}
            {activePanel === 'settings' && 'Settings'}
            {activePanel === 'detail' && selectedSecret}
            {!activePanel && 'PassShare Vault'}
          </h1>
          <div className="ml-auto flex items-center gap-2 text-sm text-dark-500">
            <span>{secrets.length} secrets</span>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activePanel === 'detail' && selectedSecret && (
            <SecretDetail
              name={selectedSecret}
              onClose={() => setActivePanel(null)}
              onDeleted={handleSecretDeleted}
            />
          )}

          {activePanel === 'add' && (
            <SecretForm
              onSuccess={handleSecretCreated}
              onCancel={() => setActivePanel(null)}
            />
          )}

          {activePanel === 'generate' && (
            <PasswordGenerator onGenerated={handleSecretCreated} />
          )}

          {activePanel === 'audit' && <AuditPanel />}

          {activePanel === 'settings' && <SettingsPanel />}

          {!activePanel && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Key className="h-16 w-16 text-dark-700 mb-4" />
              <h2 className="text-xl font-semibold text-dark-400 mb-2">
                Select a secret
              </h2>
              <p className="text-dark-500 text-sm">
                Choose a secret from the sidebar or create a new one
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
