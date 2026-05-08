import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main style={{ padding: 'var(--sp-7)', textAlign: 'center' }}>
      <h1 style={{ fontSize: 96, lineHeight: 1, margin: 0 }}>404</h1>
      <p style={{ marginTop: 'var(--sp-3)', color: 'var(--fg-secondary)' }}>
        That page does not exist.
      </p>
      <p style={{ marginTop: 'var(--sp-5)' }}>
        <Link to="/lookup">Back to lookup →</Link>
      </p>
    </main>
  );
}
