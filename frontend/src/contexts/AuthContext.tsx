import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import api from '../api/client';

interface User {
  id: number;
  username: string;
  gpg_key_id: string | null;
  created_at: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, gpgKeyId?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check if user is already authenticated
    const checkAuth = async () => {
      if (api.isAuthenticated()) {
        try {
          const userData = await api.getMe();
          setUser(userData);
        } catch {
          api.logout();
        }
      }
      setIsLoading(false);
    };

    checkAuth();

    // Listen for logout events
    const handleLogout = () => {
      setUser(null);
    };
    window.addEventListener('auth:logout', handleLogout);
    return () => window.removeEventListener('auth:logout', handleLogout);
  }, []);

  const login = async (username: string, password: string) => {
    await api.login(username, password);
    const userData = await api.getMe();
    setUser(userData);
  };

  const register = async (username: string, password: string, gpgKeyId?: string) => {
    await api.register(username, password, gpgKeyId);
    await login(username, password);
  };

  const logout = () => {
    api.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
