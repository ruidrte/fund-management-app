/**
 * Access.
 *
 * What the acting role is, what it permits, and what every other role permits.
 * A permissions model nobody can see is one nobody can check, and "why can't I
 * do X" is otherwise answered by asking somebody.
 *
 * In demo mode this page also switches role, so what a limited partner sees can
 * be checked before anyone is granted that role.
 */

import { AlertTriangle, Check, Eye, Minus, ShieldCheck } from 'lucide-react';
import { useScope } from '../context/ScopeContext';
import { useAuth } from '../context/AuthContext';
import { Card } from '../components/common/Card';
import { StatusPill } from '../components/common/Badges';
import { DataTable } from '../components/common/DataTable';
import {
  CAPABILITIES, ROLES, ROLE_DESCRIPTION, ROLE_LABEL,
  can, type Capability, type Principal, type Role,
} from '../auth/permissions';

const CAPABILITY_LABEL: Record<Capability, string> = {
  'client.read': 'Open the client',
  'client.manage': 'Change client settings',
  'members.manage': 'Grant and revoke access',
  'portfolio.read': 'See the holding register',
  'investors.read.all': 'See every capital account',
  'investors.read.own': 'See own capital account',
  'documents.upload': 'Load documents',
  'facts.commit': 'File figures',
  'reports.generate': 'Generate reports',
  export: 'Export the history',
  'audit.read': 'Coverage and controls',
  'esg.read': 'Sustainability metrics',
};

/** The capabilities worth calling out as confidentiality-sensitive. */
const SENSITIVE: Capability[] = ['investors.read.all', 'export', 'members.manage', 'facts.commit'];

export function Access() {
  const { clientId, clients, dataset } = useScope();
  const {
    principal, requiresAuth, roleOn, capabilities, simulating, simulateRole,
  } = useAuth();

  const role = roleOn(clientId);
  const held = new Set(capabilities(clientId));
  const client = clients.find((c) => c.id === clientId);

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Your access"
        subtitle={client ? `On ${client.name}` : 'No client selected'}
        actions={
          <div className="flex items-center gap-2">
            {simulating && <StatusPill tone="warning">Simulating a role</StatusPill>}
            <StatusPill tone={role === 'superuser' ? 'serious' : 'good'}>
              {role ? ROLE_LABEL[role] : 'No access'}
            </StatusPill>
          </div>
        }
      >
        <p className="m-0 text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {role ? ROLE_DESCRIPTION[role] : 'You hold no membership on this client.'}
        </p>

        {principal.isSuperuser && !simulating && (
          <p className="mt-2 mb-0 flex items-start gap-2 text-xs" style={{ color: 'var(--status-serious)' }}>
            <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
            Superuser reaches every client on the platform and bypasses membership entirely. It exists to
            administer the system, not to report from it — day-to-day work should use a client role.
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5">
          {CAPABILITIES.map((capability) => {
            const has = held.has(capability);
            return (
              <span
                key={capability}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px]"
                style={{
                  background: 'var(--surface-2)',
                  color: has ? 'var(--text-primary)' : 'var(--text-muted)',
                  opacity: has ? 1 : 0.6,
                }}
              >
                {has
                  ? <Check size={11} aria-hidden style={{ color: 'var(--status-good)' }} />
                  : <Minus size={11} aria-hidden />}
                {CAPABILITY_LABEL[capability]}
              </span>
            );
          })}
        </div>
      </Card>

      {!requiresAuth && (
        <Card
          title="View as another role"
          subtitle={client
            ? `Demo only — see the application as this role on ${client.name}`
            : 'Demo only'}
          note="A simulated role holds one membership, on this client, like a real user would. The client
                row disappears, because someone who belongs to one client should see no sign that others
                exist. Against a backend this is not offered: the database keeps answering for the real
                login, so the screen would show one thing while every query returned another."
        >
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => simulateRole(undefined)}
              aria-pressed={!simulating}
              className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs"
              style={{
                background: !simulating ? 'var(--series-1)' : 'var(--surface-2)',
                color: !simulating ? '#fff' : 'var(--text-secondary)',
              }}
            >
              <ShieldCheck size={13} aria-hidden /> Superuser (you)
            </button>

            {ROLES.filter((r) => r !== 'superuser').map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => simulateRole(option, {
                  clientId,
                  // An investor login is bound to exactly one account; without
                  // one the role grants nothing, which is the safe failure.
                  investorId: option === 'investor' ? dataset?.investors[0]?.id : undefined,
                })}
                disabled={!clientId || (option === 'investor' && !dataset?.investors[0])}
                aria-pressed={simulating && roleOn(clientId) === option}
                className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs disabled:opacity-40"
                style={{
                  background: simulating && roleOn(clientId) === option ? 'var(--series-1)' : 'var(--surface-2)',
                  color: simulating && roleOn(clientId) === option ? '#fff' : 'var(--text-secondary)',
                }}
              >
                <Eye size={13} aria-hidden /> {ROLE_LABEL[option]}
              </button>
            ))}
          </div>

          {simulating && roleOn(clientId) === 'investor' && dataset?.investors[0] && (
            <p className="mt-3 mb-0 text-xs" style={{ color: 'var(--text-secondary)' }}>
              Bound to <strong>{dataset.investors[0].name}</strong>. Every other capital account has been
              removed from the data before it reaches any screen — not hidden by a component, so no chart
              or export can reintroduce it. Open <em>Investors</em> to see the effect.
            </p>
          )}
        </Card>
      )}

      <Card
        title="What each role permits"
        subtitle="The whole authorisation model, because it fits on one page"
        note="Every capability below has a matching row-level-security policy. Nothing here is protected by
              hiding a button — the interface only matches what the database will already allow, and
              explains what it will not."
      >
        <DataTable
          rows={CAPABILITIES.map((capability) => ({ capability }))}
          rowKey={(row) => row.capability}
          dense
          columns={[
            {
              key: 'capability',
              header: 'Capability',
              render: (row) => (
                <span className="flex items-center gap-1.5">
                  {SENSITIVE.includes(row.capability) && (
                    <AlertTriangle size={11} aria-hidden style={{ color: 'var(--status-warning)' }} />
                  )}
                  {CAPABILITY_LABEL[row.capability]}
                </span>
              ),
            },
            ...ROLES.map((r) => ({
              key: r,
              header: ROLE_LABEL[r],
              align: 'left' as const,
              render: (row: { capability: Capability }) =>
                (can(principalFor(r), row.capability, { clientId: 'x' })
                  ? <Check size={13} aria-hidden style={{ color: 'var(--status-good)' }} />
                  : <Minus size={13} aria-hidden style={{ color: 'var(--text-muted)' }} />),
            })),
          ]}
        />
        <p className="mt-3 mb-0 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Marked rows are the ones worth thinking about before granting. Seeing every capital account is
          the confidentiality line — one investor learning another&rsquo;s commitment is an incident, not a
          preference. Export is separate from reading because taking the whole history away in one click
          is a different risk from looking at a screen. Filing figures changes what every future report
          says. Granting access compounds all three.
        </p>
      </Card>

      <Card title="Not built yet" subtitle="So the gaps are explicit rather than discovered">
        <ul className="m-0 list-disc space-y-1.5 pl-4 text-xs leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}>
          <li>
            <strong>Managing membership from the interface.</strong> The policies and the table grants are
            in place; the screen to add and remove people is not. Today it is a SQL insert.
          </li>
          <li>
            <strong>Per-vehicle membership.</strong> `client_members.vehicle_ids` narrows a membership to
            named vehicles and the permission check honours it, but no policy enforces it in the database
            yet — so treat it as an interface convenience, not a boundary.
          </li>
          <li>
            <strong>Export auditing.</strong> Anyone with the capability can take everything they can see.
            The extract already carries a manifest describing exactly what it contains; recording who
            asked for it is the missing half.
          </li>
          <li>
            <strong>Multi-factor authentication.</strong> Supabase supports it; nothing here requires it.
            For roles that can file figures or grant access it should be mandatory.
          </li>
        </ul>
      </Card>
    </div>
  );
}

/** A principal holding exactly one role, for rendering the matrix. */
function principalFor(role: Role): Principal {
  return {
    userId: 'matrix',
    isSuperuser: role === 'superuser',
    memberships: [{ clientId: 'x', role, investorId: 'i' }],
  };
}
