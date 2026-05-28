import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuthSession } from "../hooks/useAuthSession";

export function ProtectedRoute() {
  const { user, loading } = useAuthSession();
  const location = useLocation();

  if (loading) {
    return (
      <div className="app-loading" role="status">
        Loading…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/app/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
