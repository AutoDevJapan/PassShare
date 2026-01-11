import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Header from './components/Header';
import Footer from './components/Footer';
import Home from './pages/Home';
import Download from './pages/Download';
import Docs from './pages/Docs';
import Login from './pages/Login';
import Vault from './pages/Vault';
import { AuthProvider, useAuth } from './contexts/AuthContext';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-dark-950 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-primary-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  const location = useLocation();
  const isVaultRoute = location.pathname.startsWith('/vault');
  const isLoginRoute = location.pathname === '/login';
  const showLayout = !isVaultRoute && !isLoginRoute;

  return (
    <div className="min-h-screen flex flex-col">
      {showLayout && <Header />}
      <main className={showLayout ? 'flex-grow' : ''}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/download" element={<Download />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/login" element={<Login />} />
          <Route
            path="/vault"
            element={
              <ProtectedRoute>
                <Vault />
              </ProtectedRoute>
            }
          />
        </Routes>
      </main>
      {showLayout && <Footer />}
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}

export default App;
