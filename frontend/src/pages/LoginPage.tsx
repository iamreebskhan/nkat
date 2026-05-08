/**
 * Sign-in.
 *
 * Two-column desktop layout: left panel pitches the product (brand,
 * tagline, value props); right card is the actual sign-in surface.
 * Mobile collapses to a single column with the brand on top.
 *
 * Three sign-in paths, in order of preference:
 *   1. SSO (when backend OIDC is configured) — primary big button.
 *   2. Quick test-login buttons — one per role; visible only in
 *      dev_header mode. Pre-fills + auto-submits using the seeded test
 *      users (db/seed/0017_test_users.sql).
 *   3. Manual dev-header form — orgId + userId + role for arbitrary IDs.
 *
 * Deep-link `?orgId=&userId=&role=` still auto-signs the user in
 * (via the existing useEffect), as long as backend reports
 * dev_header mode.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import { authStore, type AuthState } from '../auth/auth-store';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import styles from './LoginPage.module.css';

interface AuthMode { mode: 'dev_header' | 'jwt'; sso_configured: boolean }

type Role = NonNullable<AuthState['role']>;

/** Seeded test accounts — see db/seed/0017_test_users.sql. */
interface TestAccount {
  role: Role;
  orgId: string;
  userId: string;
  label: string;
  description: string;
}

const TEST_ACCOUNTS: TestAccount[] = [
  {
    role: 'admin',
    orgId:  '11111111-1111-4111-8111-111111111111',
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    label: 'Admin',
    description: 'Full access — manages tokens, deletion, rate limits',
  },
  {
    role: 'reviewer',
    orgId:  '11111111-1111-4111-8111-111111111111',
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    label: 'Reviewer',
    description: 'Reconciles rule docs; finalizes rulebooks',
  },
  {
    role: 'employee',
    orgId:  '11111111-1111-4111-8111-111111111111',
    userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    label: 'Employee',
    description: 'Daily lookup + denial review',
  },
  {
    role: 'consultant',
    orgId:  '11111111-1111-4111-8111-111111111111',
    userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    label: 'Consultant',
    description: 'Read-only cross-org for design partners',
  },
];

const VALUE_PROPS = [
  { kbd: '01', title: 'Citation-grounded lookup',
    body: 'Every payer-rule answer ships with the LCD/NCD/companion-guide source it came from.' },
  { kbd: '02', title: 'Pre-flight every CARC class',
    body: 'NCCI, modifiers, COB, timely filing, MHPAEA, ABN — flagged before the claim leaves your office.' },
  { kbd: '03', title: 'Reconcile against authoritative',
    body: 'Upload your rule doc; we redact PHI then diff it row-by-row against the authoritative truth.' },
  { kbd: '04', title: 'Measure outcomes from your 835s',
    body: 'Pre-flight catch rate per CARC. Watch denials drop month over month.' },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const next = searchParams.get('next') ?? '/lookup';
  const nav = useNavigate();
  const orgIdRef = useRef<HTMLInputElement>(null);

  const [orgId, setOrgId]   = useState('');
  const [userId, setUserId] = useState('');
  const [role, setRole]     = useState<Role>('admin');
  const [touched, setTouched] = useState(false);

  const mode = useQuery<AuthMode>({
    queryKey: ['auth-mode'],
    queryFn: () => apiGet<AuthMode>('/v1/auth/mode'),
    retry: false,
    staleTime: Infinity,
  });
  const isLoading = mode.isPending;
  const probeFailed = mode.isError;
  const isDevMode = isLoading ? true : mode.data?.mode === 'dev_header';
  const ssoAvailable = Boolean(mode.data?.sso_configured);

  const orgValid  = useMemo(() => UUID_RE.test(orgId), [orgId]);
  const userValid = useMemo(() => UUID_RE.test(userId), [userId]);

  // Deep-link auto-login: ?orgId=&userId=&role=. Only when backend is
  // in dev_header mode; production stacks ignore the query string.
  useEffect(() => {
    if (!isDevMode || mode.isPending) return;
    const qOrg  = searchParams.get('orgId');
    const qUser = searchParams.get('userId');
    const qRole = (searchParams.get('role') as Role | null) ?? 'admin';
    if (qOrg && qUser && UUID_RE.test(qOrg) && UUID_RE.test(qUser)) {
      signInDevHeader(qOrg, qUser, qRole);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDevMode, mode.isPending]);

  // SSO callback completion — backend redirects here with the session
  // JWT in the URL fragment (`#token=...&next=...`). We pull it out,
  // store it, and route to `next`. Using the fragment (not query
  // string) keeps the token out of server access logs + referrer
  // headers.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const token = params.get('token');
    // Real RS256 JWTs always start with the base64url of `{"alg":"RS256","typ":"JWT"...}`,
    // which begins with "eyJ". This is a cheap pre-check; the backend
    // already verified the token before issuing the redirect.
    if (!token || !token.startsWith('eyJ')) return;
    const nextDest = params.get('next') || '/lookup';
    let claims: { sub?: string; org_id?: string; role?: Role | null } = {};
    try {
      const payload = token.split('.')[1];
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      claims = JSON.parse(json);
    } catch {
      return; // malformed → user re-tries SSO
    }
    if (!claims.sub || !claims.org_id) return;
    authStore.set({
      token,
      orgId: claims.org_id,
      userId: claims.sub,
      role: claims.role ?? 'employee',
    });
    // Strip the fragment from the URL bar so the token isn't visible.
    window.history.replaceState(null, '', window.location.pathname);
    nav(nextDest, { replace: true });
  }, [nav]);

  // Autofocus the first input once we know what to render.
  useEffect(() => {
    if (!isLoading && isDevMode) orgIdRef.current?.focus();
  }, [isLoading, isDevMode]);

  function signInDevHeader(o: string, u: string, r: Role) {
    const fakeToken = `devheader.${o}.${u}.${r}`;
    authStore.set({ token: fakeToken, orgId: o, userId: u, role: r });
    nav(decodeURIComponent(next), { replace: true });
  }

  function onDev(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!orgValid || !userValid) return;
    signInDevHeader(orgId, userId, role);
  }

  function quickLogin(acct: TestAccount) {
    setOrgId(acct.orgId);
    setUserId(acct.userId);
    setRole(acct.role);
    signInDevHeader(acct.orgId, acct.userId, acct.role);
  }

  return (
    <div className={styles.page}>
      <main className={styles.shell} role="main">
        {/* Left: brand + value props */}
        <aside className={styles.brand} aria-label="Product summary">
          <header className={styles.brandHead}>
            <span className={styles.brandMark} aria-hidden>■</span>
            <div>
              <strong className={styles.brandName}>BILLING RULES</strong>
              <span className={styles.brandTag}>platform</span>
            </div>
          </header>

          <h1 className={styles.brandHeadline}>
            Pre-flight every claim<br />
            against every payer rule.<br />
            <span className={styles.brandHeadlineAccent}>With citations.</span>
          </h1>

          <ul className={styles.props} role="list">
            {VALUE_PROPS.map((p) => (
              <li key={p.kbd} className={styles.prop}>
                <kbd className={styles.propKbd} aria-hidden>{p.kbd}</kbd>
                <div>
                  <div className={styles.propTitle}>{p.title}</div>
                  <p className={styles.propBody}>{p.body}</p>
                </div>
              </li>
            ))}
          </ul>

          <footer className={styles.brandFoot}>
            {!isLoading && (
              <span className={styles.envBadge} title="Auth mode reported by /v1/auth/mode">
                {isDevMode ? 'DEV-HEADER' : 'JWT'} · {ssoAvailable ? 'SSO READY' : 'NO SSO'}
              </span>
            )}
            <div>
              <a href="/.well-known/wmhmda-policy">WMHMDA</a> ·
              {' '}<a href="/legal/privacy">Privacy</a> ·
              {' '}<a href="/legal/tos">Terms</a> ·
              {' '}<a href="/.well-known/security.txt">Security</a>
            </div>
          </footer>
        </aside>

        {/* Right: sign-in card */}
        <section className={styles.card} aria-label="Sign in">
          <header className={styles.cardHead}>
            <h2 className={styles.title}>Sign in</h2>
            <p className={styles.sub}>
              {isLoading
                ? 'Detecting auth configuration…'
                : ssoAvailable
                  ? 'Use your SSO provider, or sign in as a test user below.'
                  : isDevMode
                    ? 'This stack is in dev-header mode. Use a quick test login or paste IDs manually.'
                    : 'Sign in with your IdP.'}
            </p>
          </header>

          {isLoading && <div className={styles.skeleton} role="status" aria-label="Loading">…</div>}

          {!isLoading && ssoAvailable && (
            <a
              href={`/v1/auth/sso/start?next=${encodeURIComponent(next)}`}
              className={styles.ssoLink}
              aria-label="Continue with single sign-on"
            >
              <Button variant="primary" size="lg" block>Continue with SSO →</Button>
            </a>
          )}

          {!isLoading && isDevMode && ssoAvailable && (
            <div className={styles.divider}><span>or</span></div>
          )}

          {!isLoading && !probeFailed && isDevMode && (
            <>
              <div className={styles.section}>
                <h3 className={styles.h3}>Quick test login</h3>
                <p className={styles.sectionHint}>
                  Pre-seeded users in <code>Design&nbsp;Partner&nbsp;Co</code>. One click to sign in.
                </p>
                <div className={styles.quickGrid} role="group" aria-label="Test accounts">
                  {TEST_ACCOUNTS.map((a) => (
                    <button
                      key={a.role}
                      type="button"
                      className={styles.quick}
                      onClick={() => quickLogin(a)}
                      aria-label={`Sign in as ${a.label}`}
                    >
                      <span className={styles.quickRole}>{a.label.toUpperCase()}</span>
                      <span className={styles.quickWho}>{a.role}@design-partner.test</span>
                      <span className={styles.quickWhy}>{a.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              <details className={styles.advanced}>
                <summary>Advanced — paste UUIDs manually</summary>
                <form className={styles.form} onSubmit={onDev} aria-label="Dev-header sign in">
                  <Input
                    label="Org ID (UUID)"
                    value={orgId}
                    onChange={(e) => setOrgId(e.target.value.trim())}
                    placeholder="11111111-1111-4111-8111-111111111111"
                    autoComplete="off"
                    spellCheck={false}
                    error={touched && orgId.length > 0 && !orgValid ? 'Invalid UUID' : undefined}
                    trailing={orgId.length > 0 ? (orgValid ? '✓' : '✕') : undefined}
                  />
                  <Input
                    label="User ID (UUID)"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value.trim())}
                    placeholder="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                    autoComplete="off"
                    spellCheck={false}
                    error={touched && userId.length > 0 && !userValid ? 'Invalid UUID' : undefined}
                    trailing={userId.length > 0 ? (userValid ? '✓' : '✕') : undefined}
                  />
                  <fieldset className={styles.roles}>
                    <legend className={styles.rolesLabel}>Role</legend>
                    {(['admin', 'reviewer', 'employee', 'consultant'] as const).map((r) => (
                      <label key={r} className={styles.roleOpt}>
                        <input
                          type="radio"
                          name="role"
                          value={r}
                          checked={role === r}
                          onChange={() => setRole(r)}
                        />
                        {r}
                      </label>
                    ))}
                  </fieldset>
                  <Button
                    type="submit"
                    variant="primary"
                    block
                    disabled={!orgValid || !userValid}
                  >
                    Sign in
                  </Button>
                </form>
              </details>
            </>
          )}

          {!isLoading && probeFailed && (
            <div className={styles.alert} role="alert">
              <strong>Backend unreachable.</strong>
              <p>
                <code>GET /v1/auth/mode</code> failed — the API server isn't
                responding on <code>localhost:3000</code>. Start it with{' '}
                <code>docker compose up</code> or{' '}
                <code>npm --prefix backend run start:dev</code>, then reload.
              </p>
              <p>
                <Button size="sm" variant="secondary" onClick={() => mode.refetch()}>
                  Retry
                </Button>
              </p>
            </div>
          )}

          {!isLoading && !probeFailed && !isDevMode && !ssoAvailable && (
            <div className={styles.alert} role="alert">
              <strong>No auth method available.</strong>
              <p>
                The backend is in <code>jwt</code> mode but no IdP is configured.
                Set <code>OIDC_AUTHORIZATION_URL</code> + <code>OIDC_CLIENT_ID</code>
                {' '}+ <code>OIDC_REDIRECT_URI</code> in the backend env, or set
                {' '}<code>AUTH_MODE=dev_header</code> for local development.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
