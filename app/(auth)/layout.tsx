/**
 * Auth layout — minimal shell for /login, /signup, /forgot-password.
 * No sidebar, centered card, glass-on-empty pattern OK here per
 * playbook §1.4 (marketing/empty-state surfaces only).
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-teal-50 px-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
