import { useState, type FormEvent } from 'react';
import { LogIn, ShieldAlert } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export function SignIn() {
  const { signIn, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await signIn(email, password);
    } catch {
      // The provider has already set the message; nothing to add here.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <h1 className="m-0 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          Fund Reporting &amp; Monitoring
        </h1>
        <p className="mt-1 mb-5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          Sign in to reach your client data.
        </p>

        <label className="mb-1 block text-xs font-medium" htmlFor="email" style={{ color: 'var(--text-secondary)' }}>
          Email
        </label>
        <input
          id="email" type="email" required autoComplete="username"
          className="field mb-3 w-full" value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label className="mb-1 block text-xs font-medium" htmlFor="password" style={{ color: 'var(--text-secondary)' }}>
          Password
        </label>
        <input
          id="password" type="password" required autoComplete="current-password"
          className="field mb-4 w-full" value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error && (
          <p
            className="mb-3 flex items-start gap-2 text-xs"
            style={{ color: 'var(--status-critical)' }}
            role="alert"
          >
            <ShieldAlert size={14} className="mt-px shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <button
          type="submit" disabled={busy}
          className="inline-flex w-full items-center justify-center gap-2 rounded px-3 py-2 text-sm font-medium disabled:opacity-60"
          style={{ background: 'var(--series-1)', color: '#fff' }}
        >
          <LogIn size={14} aria-hidden />
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
