/**
 * Authentication.
 *
 * Two modes, and the distinction is deliberate:
 *
 *  - With Supabase configured, a real session is required. Row level security
 *    keys off `auth.uid()`, so an unauthenticated client sees zero rows rather
 *    than an error — which would look like an empty portfolio rather than a
 *    failed login. Gating the UI on a session makes the difference visible.
 *
 *  - Without Supabase, the app runs against the demo dataset and there is
 *    nothing to protect. It says so on screen rather than presenting a login
 *    that would accept anything.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';

export interface AuthUser {
  id: string;
  email?: string;
}

interface AuthValue {
  /** True while the initial session lookup is in flight. */
  loading: boolean;
  /** Undefined in demo mode — there is no user to identify. */
  user?: AuthUser;
  /** False when running against the demo dataset. */
  requiresAuth: boolean;
  error?: string;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const requiresAuth = isSupabaseConfigured();
  const [loading, setLoading] = useState(requiresAuth);
  const [user, setUser] = useState<AuthUser>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!requiresAuth) return;
    const supabase = getSupabase();
    if (!supabase) return;

    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setUser(toUser(data.session?.user));
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(toUser(session?.user));
      setLoading(false);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, [requiresAuth]);

  const signIn = useCallback(async (email: string, password: string) => {
    const supabase = getSupabase();
    if (!supabase) throw new Error('No backend is configured');
    setError(undefined);
    const { error: cause } = await supabase.auth.signInWithPassword({ email, password });
    if (cause) {
      // Deliberately not distinguishing "no such user" from "wrong password":
      // the difference is only useful to someone enumerating accounts.
      setError('Those credentials were not accepted.');
      throw cause;
    }
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.auth.signOut();
    setUser(undefined);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ loading, user, requiresAuth, error, signIn, signOut }),
    [loading, user, requiresAuth, error, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside an AuthProvider');
  return value;
}

function toUser(user: { id: string; email?: string } | undefined): AuthUser | undefined {
  return user ? { id: user.id, email: user.email } : undefined;
}
