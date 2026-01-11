import { useCallback, useEffect, useState } from 'react';
import api, {
  type SecretListItem,
  type SecretDetail,
  type CreateSecretData,
  type UpdateSecretData,
  type GeneratePasswordData,
  type AuditResponse,
  type HistoryEntry,
} from '../api/client';

export function useSecrets(prefix = '') {
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSecrets = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.listSecrets(prefix);
      setSecrets(response.secrets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load secrets');
    } finally {
      setIsLoading(false);
    }
  }, [prefix]);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

  return { secrets, isLoading, error, refetch: fetchSecrets };
}

export function useSecret(name: string | null) {
  const [secret, setSecret] = useState<SecretDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSecret = useCallback(async () => {
    if (!name) {
      setSecret(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const data = await api.getSecret(name);
      setSecret(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load secret');
      setSecret(null);
    } finally {
      setIsLoading(false);
    }
  }, [name]);

  useEffect(() => {
    fetchSecret();
  }, [fetchSecret]);

  return { secret, isLoading, error, refetch: fetchSecret };
}

export function useSecretActions() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createSecret = async (data: CreateSecretData) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await api.createSecret(data);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create secret';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const updateSecret = async (name: string, data: UpdateSecretData) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await api.updateSecret(name, data);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update secret';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const deleteSecret = async (name: string) => {
    setIsLoading(true);
    setError(null);
    try {
      await api.deleteSecret(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete secret';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const generatePassword = async (data: GeneratePasswordData) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await api.generatePassword(data);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate password';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLoading,
    error,
    createSecret,
    updateSecret,
    deleteSecret,
    generatePassword,
  };
}

export function useSearch() {
  const [results, setResults] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const search = async (query: string, searchContent = false) => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const response = await api.searchSecrets(query, searchContent);
      setResults(response.matches);
    } catch {
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const clearResults = () => setResults([]);

  return { results, isSearching, search, clearResults };
}

export function useAudit() {
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAudit = async (folder = '') => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await api.auditPasswords(folder);
      setAudit(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Audit failed';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  return { audit, isLoading, error, runAudit };
}

export function useHistory(name: string | null) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!name) {
      setHistory([]);
      return;
    }

    const fetchHistory = async () => {
      setIsLoading(true);
      try {
        const entries = await api.getHistory(name);
        setHistory(entries);
      } catch {
        setHistory([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchHistory();
  }, [name]);

  return { history, isLoading };
}

export function useSync() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sync = async (store?: string) => {
    setIsSyncing(true);
    setError(null);
    try {
      const result = await api.syncStore(store);
      if (result.success) {
        setLastSync(new Date());
      } else {
        setError(result.message);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      setError(message);
      throw err;
    } finally {
      setIsSyncing(false);
    }
  };

  return { isSyncing, lastSync, error, sync };
}
