/**
 * Authentication and the acting principal.
 *
 * Two modes, and the distinction is deliberate:
 *
 *  - With Supabase configured, a real session is required and the principal's
 *    memberships are read from the database. Row-level security keys off
 *    `auth.uid()`, so an unauthenticated client sees zero rows rather than an
 *    error — which would look like an empty portfolio rather than a failed
 *    login. Gating the UI on a session makes the difference visible.
 *
 *  - Without Supabase the app runs on the demo dataset as a superuser, and
 *    offers a role simulator. Being able to see what a limited partner sees,
 *    before granting anyone that role, is worth more than a permissions
 *    document nobody reads.
 *
 * What this file decides is what the *interface* offers. What a user may
 * actually reach is decided by the database, every time.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { getSupabase, isSupabaseConfigured } from '../lib/supabase';
import {
  DEMO_PRINCIPAL, can, capabilitiesOn, denialReason, roleOn,
  type Capability, type Membership, type Principal, type Role, type Scope,
} from '../auth/permissions';

export interface AuthUser {
  id: string;
  email?: string;
}

interface AuthValue {
  loading: boolean;
  user?: AuthUser;
  /** False when running against the demo dataset. */
  requiresAuth: boolean;
  error?: string;

  /** Who is acting. In demo mode this reflects the simulated role. */
  principal: Principal;
  /** True when a role is being simulated rather than actually held. */
  simulating: boolean;
  /**
   * Demo mode only: view the application as another role, on one client.
   *
   * The client matters. A real EBG analyst holds one membership and sees EBG's
   * products and no sign that other clients exist; simulating the role across
   * every client would show the opposite and prove nothing.
   */
  simulateRole(role: Role | undefined, on?: { clientId: string; investorId?: string }): void;

  /** The role held on a client, or undefined for no access. */
  roleOn(clientId: string | undefined): Role | undefined;
  can(capability: Capability, scope?: Scope): boolean;
  /** Why a capability is unavailable, phrased for the person reading it. */
  why(capability: Capability, scope?: Scope): string | undefined;
  capabilities(clientId: string | undefined): Capability[];

  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const requiresAuth = isSupabaseConfigured();
  const [loading, setLoading] = useState(requiresAuth);
  const [user, setUser] = useState<AuthUser>();
  const [error, setError] = useState<string>();
  const [real, setReal] = useState<Principal>(DEMO_PRINCIPAL);
  const [simulated, setSimulated] = useState<{ role: Role; clientId: string; investorId?: string }>();

  useEffect(() => {
    if (!requiresAuth) return;
    const supabase = getSupabase();
    if (!supabase) return;

    let cancelled = false;

    const adopt = async (session: { user: { id: string; email?: string } } | null) => {
      if (cancelled) return;
      setUser(session ? { id: session.user.id, email: session.user.email } : undefined);
      setReal(session ? await loadPrincipal(session.user) : DEMO_PRINCIPAL);
      setLoading(false);
    };

    supabase.auth.getSession().then(({ data }) => void adopt(data.session ?? null));
    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, session) => void adopt(session ?? null),
    );

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
    setReal(DEMO_PRINCIPAL);
    setSimulated(undefined);
  }, []);

  const simulateRole = useCallback((
    role: Role | undefined,
    on?: { clientId: string; investorId?: string },
  ) => {
    // Simulation is a demo-mode affordance only. Against a backend it would be
    // a lie: the database would keep answering for the real principal, and the
    // screen would show one thing while every query returned another.
    if (requiresAuth) return;
    if (!role || role === 'superuser' || !on?.clientId) {
      setSimulated(undefined);
      return;
    }
    setSimulated({ role, clientId: on.clientId, investorId: on.investorId });
  }, [requiresAuth]);

  /**
   * The acting principal. A simulated role produces a principal holding exactly
   * one membership, so the whole application — navigation, tabs, buttons, data —
   * answers as it would for someone who belongs to that one client.
   */
  const principal = useMemo<Principal>(() => {
    if (!simulated) return real;
    const membership: Membership = {
      clientId: simulated.clientId,
      role: simulated.role,
      investorId: simulated.investorId,
    };
    return {
      ...real,
      displayName: `Simulating ${simulated.role}`,
      isSuperuser: false,
      memberships: [membership],
    };
  }, [real, simulated]);

  const value = useMemo<AuthValue>(() => ({
    loading,
    user,
    requiresAuth,
    error,
    principal,
    simulating: simulated !== undefined,
    simulateRole,
    roleOn: (clientId) => roleOn(principal, clientId),
    can: (capability, scope) => can(principal, capability, scope),
    why: (capability, scope) => denialReason(principal, capability, scope),
    capabilities: (clientId) => capabilitiesOn(principal, clientId),
    signIn,
    signOut,
  }), [loading, user, requiresAuth, error, principal, simulated, simulateRole, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside an AuthProvider');
  return value;
}

/** Convenience for the common case: gate one control on one capability. */
export function useCan(capability: Capability, scope?: Scope): {
  allowed: boolean;
  reason?: string;
} {
  const { can: check, why } = useAuth();
  return { allowed: check(capability, scope), reason: why(capability, scope) };
}

/**
 * Reads the principal's platform role and memberships.
 *
 * Failing closed matters here: an error loading memberships must produce a
 * principal with none, not one that is assumed privileged. The user sees an
 * empty client list and can retry, which is the safe direction to be wrong in.
 */
async function loadPrincipal(user: { id: string; email?: string }): Promise<Principal> {
  const supabase = getSupabase();
  const base: Principal = {
    userId: user.id,
    email: user.email,
    isSuperuser: false,
    memberships: [],
  };
  if (!supabase) return base;

  const [admin, members] = await Promise.all([
    supabase.from('platform_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
    supabase.from('client_members').select('client_id, role, investor_id, vehicle_ids'),
  ]);

  return {
    ...base,
    isSuperuser: Boolean(admin.data),
    memberships: (members.data ?? []).map((row: Record<string, unknown>): Membership => ({
      clientId: String(row.client_id),
      role: String(row.role) as Role,
      investorId: row.investor_id ? String(row.investor_id) : undefined,
      vehicleIds: Array.isArray(row.vehicle_ids) ? row.vehicle_ids.map(String) : undefined,
    })),
  };
}
