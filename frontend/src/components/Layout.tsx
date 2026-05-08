/**
 * App shell. Two-column layout — sidebar nav + content. Skip-link
 * for keyboard, ARIA landmarks (banner, navigation, main, contentinfo).
 */
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/use-auth';
import { authStore } from '../auth/auth-store';
import { Button } from './Button';
import styles from './Layout.module.css';

export function Layout() {
  const auth = useAuth();
  const nav = useNavigate();

  const signOut = () => {
    authStore.clear();
    nav('/login');
  };

  return (
    <>
      <a href="#main" className="skip-link">Skip to main content</a>

      <header className={styles.header} role="banner">
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden>■</span>
          <strong>BILLING RULES</strong>
          <span className={styles.brandTag}>platform</span>
        </div>
        <div className={styles.headerRight}>
          {auth.userId && (
            <>
              <span className={styles.who} title={auth.userId}>
                <span className={styles.whoRole}>{auth.role ?? 'user'}</span>
                <span className={styles.whoOrg}>org · {auth.orgId?.slice(0, 8)}</span>
              </span>
              <Button variant="secondary" size="sm" onClick={signOut}>Sign out</Button>
            </>
          )}
        </div>
      </header>

      <div className={styles.shell}>
        <nav className={styles.side} aria-label="Primary">
          <NavSection title="Daily">
            <NavItem to="/lookup">Lookup</NavItem>
            <NavItem to="/reconciliation">Reconciliation</NavItem>
            <NavItem to="/alerts">Alerts</NavItem>
            <NavItem to="/denials">Denials</NavItem>
          </NavSection>
          <NavSection title="Account">
            <NavItem to="/settings/privacy">Privacy</NavItem>
            <NavItem to="/settings/billing">Billing</NavItem>
          </NavSection>
          <NavSection title="Admin">
            <NavItem to="/admin/audit">Audit log</NavItem>
            <NavItem to="/admin/scim">SCIM tokens</NavItem>
            <NavItem to="/admin/rate-limits">Rate limits</NavItem>
            <NavItem to="/admin/clearinghouse">Clearinghouse</NavItem>
            <NavItem to="/admin/final-rules">Final Rules</NavItem>
            <NavItem to="/admin/deletion">Tenant deletion</NavItem>
          </NavSection>
        </nav>

        <main id="main" className={styles.main} role="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </>
  );
}

function NavSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.navSection}>
      <h6 className={styles.navHeading}>{title}</h6>
      <ul className={styles.navList}>{children}</ul>
    </div>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <li>
      <NavLink
        to={to}
        className={({ isActive }) => isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
      >
        {children}
      </NavLink>
    </li>
  );
}
