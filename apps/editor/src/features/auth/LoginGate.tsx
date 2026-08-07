import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import {
  AutoLoginFailedError,
  getAccessToken,
  login,
  refreshAccessToken,
  register,
} from '../../entities/auth';

/**
 * Minimal auth gate: renders a login/register form until an access token is
 * available, then renders the app. Session persistence relies on the httpOnly
 * refresh cookie (apiClient refreshes on 401), so no token is stored locally.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(() => getAccessToken() !== null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Non-error informational message (e.g. "registered, please sign in"). */
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(() => getAccessToken() === null);

  // On mount, try the httpOnly refresh cookie once so a page reload does not
  // force a re-login.
  useEffect(() => {
    if (!checking) return;
    let cancelled = false;
    void refreshAccessToken().then((ok) => {
      if (cancelled) return;
      if (ok) setAuthed(true);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [checking]);

  if (authed) return <>{children}</>;
  if (checking) {
    return <div className="flex h-screen items-center justify-center bg-surface-0 text-fg/50">...</div>;
  }

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    // Stale errors/notices from the other mode are confusing — clear them.
    setError(null);
    setNotice(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'register') {
        await register(email, password, displayName || email.split('@')[0]);
      } else {
        await login(email, password);
      }
      setAuthed(true);
    } catch (err) {
      if (err instanceof AutoLoginFailedError) {
        // The account WAS created — send the user to the login form instead of
        // implying the registration failed.
        setMode('login');
        setNotice('Kayıt başarılı — lütfen giriş yapın.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-surface-0 text-fg">
      <form onSubmit={submit} className="w-80 space-y-3 rounded-lg border border-edge bg-surface-1 p-6">
        <h1 className="text-lg font-semibold">VideoEdit</h1>
        {mode === 'register' && (
          <input
            className="w-full rounded border border-edge bg-surface-2 px-3 py-2 text-sm"
            name="name"
            autoComplete="name"
            placeholder="Görünen ad"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            data-testid="auth-displayname"
          />
        )}
        <input
          className="w-full rounded border border-edge bg-surface-2 px-3 py-2 text-sm"
          type="email"
          name="email"
          autoComplete="email"
          required
          placeholder="E-posta"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="auth-email"
        />
        <input
          className="w-full rounded border border-edge bg-surface-2 px-3 py-2 text-sm"
          type="password"
          name="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
          placeholder="Şifre"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="auth-password"
        />
        {notice && <p className="text-sm text-emerald-400">{notice}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-accent px-3 py-2 text-sm font-medium disabled:opacity-50"
          data-testid="auth-submit"
        >
          {busy ? '...' : mode === 'login' ? 'Giriş yap' : 'Kayıt ol'}
        </button>
        <button
          type="button"
          className="w-full text-xs text-fg/60 hover:text-fg"
          onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'Hesabın yok mu? Kayıt ol' : 'Zaten hesabın var mı? Giriş yap'}
        </button>
      </form>
    </div>
  );
}
