import { lazy, Suspense, useEffect, useRef } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { apiGet } from './api/client';
import { authStore, type AuthState } from './auth/auth-store';
import { Layout } from './components/Layout';
import { useAuth, isAuthed } from './auth/use-auth';

const LoginPage          = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const LookupPage         = lazy(() => import('./pages/LookupPage').then(m => ({ default: m.LookupPage })));
const ReconciliationPage = lazy(() => import('./pages/ReconciliationPage').then(m => ({ default: m.ReconciliationPage })));
const AlertsPage         = lazy(() => import('./pages/AlertsPage').then(m => ({ default: m.AlertsPage })));
const DenialsPage        = lazy(() => import('./pages/DenialsPage').then(m => ({ default: m.DenialsPage })));
const PrivacyPage        = lazy(() => import('./pages/PrivacyPage').then(m => ({ default: m.PrivacyPage })));
const BillingPage        = lazy(() => import('./pages/BillingPage').then(m => ({ default: m.BillingPage })));
const AuditLogPage       = lazy(() => import('./pages/admin/AuditLogPage').then(m => ({ default: m.AuditLogPage })));
const ScimTokenPage      = lazy(() => import('./pages/admin/ScimTokenPage').then(m => ({ default: m.ScimTokenPage })));
const RateLimitPage      = lazy(() => import('./pages/admin/RateLimitPage').then(m => ({ default: m.RateLimitPage })));
const ClearinghousePage  = lazy(() => import('./pages/admin/ClearinghousePage').then(m => ({ default: m.ClearinghousePage })));
const FinalRulesPage     = lazy(() => import('./pages/admin/FinalRulesPage').then(m => ({ default: m.FinalRulesPage })));
const DeletionPage       = lazy(() => import('./pages/admin/DeletionPage').then(m => ({ default: m.DeletionPage })));
const NotFoundPage       = lazy(() => import('./pages/NotFoundPage').then(m => ({ default: m.NotFoundPage })));

export function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/lookup" replace />} />
            <Route path="/lookup" element={<LookupPage />} />
            <Route path="/reconciliation" element={<ReconciliationPage />} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/denials" element={<DenialsPage />} />
            <Route path="/settings/privacy" element={<PrivacyPage />} />
            <Route path="/settings/billing" element={<BillingPage />} />
            <Route path="/admin/audit" element={<AuditLogPage />} />
            <Route path="/admin/scim" element={<ScimTokenPage />} />
            <Route path="/admin/rate-limits" element={<RateLimitPage />} />
            <Route path="/admin/clearinghouse" element={<ClearinghousePage />} />
            <Route path="/admin/final-rules" element={<FinalRulesPage />} />
            <Route path="/admin/deletion" element={<DeletionPage />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}

function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();
  // Background re-validate the locally-cached identity against the
  // backend on first render. If the token is stale or revoked, the
  // api/client's 401-redirect handler kicks the user to /login
  // automatically; otherwise a role-change in another session shows
  // up here without requiring a sign-out.
  useHydrateAuthOnce(Boolean(auth.token));
  if (!isAuthed(auth)) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <Outlet />;
}

function useHydrateAuthOnce(enabled: boolean): void {
  const ran = useRef(false);
  useEffect(() => {
    if (!enabled || ran.current) return;
    ran.current = true;
    apiGet<{ orgId: string | null; userId: string | null; role: AuthState['role'] }>('/v1/auth/me')
      .then((me) => {
        const cur = authStore.get();
        if (
          me.orgId &&
          me.userId &&
          (me.orgId !== cur.orgId || me.userId !== cur.userId || me.role !== cur.role)
        ) {
          authStore.set({
            token: cur.token,
            orgId: me.orgId,
            userId: me.userId,
            role: me.role ?? cur.role,
          });
        }
      })
      .catch(() => { /* api/client already handled 401; other errors are non-fatal */ });
  }, [enabled]);
}

function PageFallback() {
  return (
    <div role="status" aria-live="polite" style={{ padding: 'var(--sp-6)' }}>
      Loading…
    </div>
  );
}
