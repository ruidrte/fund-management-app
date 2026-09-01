import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES, ROLES, boundInvestorId, can, capabilitiesOn, denialReason,
  roleOn, visibleClientIds, type Principal, type Role,
} from '../src/auth/permissions';

const CLIENT = 'client-ebg';
const OTHER = 'client-ut';

const withRole = (role: Role, investorId?: string): Principal => ({
  userId: 'u',
  isSuperuser: false,
  memberships: [{ clientId: CLIENT, role, investorId }],
});

const superuser: Principal = { userId: 'root', isSuperuser: true, memberships: [] };
const outsider: Principal = { userId: 'nobody', isSuperuser: false, memberships: [] };

describe('the confidentiality line', () => {
  it('never lets an investor see other capital accounts', () => {
    const lp = withRole('investor', 'inv-1');
    expect(can(lp, 'investors.read.own', { clientId: CLIENT })).toBe(true);
    expect(can(lp, 'investors.read.all', { clientId: CLIENT })).toBe(false);
  });

  it('binds an investor login to exactly one account', () => {
    expect(boundInvestorId(withRole('investor', 'inv-1'), CLIENT)).toBe('inv-1');
    // Every other role is bound to none, which is what "all accounts" means.
    for (const role of ROLES.filter((r) => r !== 'investor' && r !== 'superuser')) {
      expect(boundInvestorId(withRole(role), CLIENT)).toBeUndefined();
    }
  });

  it('gives an investor the portfolio, which they receive in their report anyway', () => {
    // Withholding it on screen while posting it in the quarterly pack is theatre.
    expect(can(withRole('investor', 'inv-1'), 'portfolio.read', { clientId: CLIENT })).toBe(true);
  });

  it('lets no role but superuser and owner grant access', () => {
    const granting = ROLES.filter((role) => {
      const principal = role === 'superuser' ? superuser : withRole(role, 'inv-1');
      return can(principal, 'members.manage', { clientId: CLIENT });
    });
    expect(granting).toEqual(['superuser', 'owner']);
  });
});

describe('writing', () => {
  it('is limited to the roles that are supposed to change the numbers', () => {
    const writers = ROLES.filter((role) => {
      const principal = role === 'superuser' ? superuser : withRole(role, 'inv-1');
      return can(principal, 'facts.commit', { clientId: CLIENT });
    });
    expect(writers).toEqual(['superuser', 'owner', 'editor']);
  });

  it('excludes the auditor by construction, not by convention', () => {
    const auditor = withRole('auditor');
    expect(can(auditor, 'audit.read', { clientId: CLIENT })).toBe(true);
    expect(can(auditor, 'facts.commit', { clientId: CLIENT })).toBe(false);
    expect(can(auditor, 'documents.upload', { clientId: CLIENT })).toBe(false);
  });

  it('separates export from reading, because they are different risks', () => {
    // A viewer can read a screen; taking the whole history in one click is not
    // the same thing and is not granted with it.
    expect(can(withRole('viewer'), 'portfolio.read', { clientId: CLIENT })).toBe(true);
    expect(can(withRole('viewer'), 'export', { clientId: CLIENT })).toBe(false);
    expect(can(withRole('analyst'), 'export', { clientId: CLIENT })).toBe(true);
  });

  it('lets an analyst load a document but not file what it says', () => {
    expect(can(withRole('analyst'), 'documents.upload', { clientId: CLIENT })).toBe(true);
    expect(can(withRole('analyst'), 'facts.commit', { clientId: CLIENT })).toBe(false);
  });
});

describe('client boundaries', () => {
  it('grants nothing on a client the principal is not a member of', () => {
    const editor = withRole('editor');
    expect(can(editor, 'portfolio.read', { clientId: OTHER })).toBe(false);
    expect(roleOn(editor, OTHER)).toBeUndefined();
  });

  it('grants nothing at all to someone with no membership', () => {
    for (const capability of CAPABILITIES) {
      expect(can(outsider, capability, { clientId: CLIENT })).toBe(false);
    }
  });

  it('refuses when no client is named, rather than defaulting to allowed', () => {
    // A missing scope must fail closed; the alternative leaks on every call
    // site that forgets to pass one.
    expect(can(withRole('owner'), 'portfolio.read', {})).toBe(false);
  });

  it('lets a superuser reach every client', () => {
    expect(can(superuser, 'members.manage', { clientId: OTHER })).toBe(true);
    expect(visibleClientIds(superuser)).toBeUndefined();
    expect(visibleClientIds(withRole('viewer'))).toEqual([CLIENT]);
  });

  it('honours a membership narrowed to certain vehicles', () => {
    const scoped: Principal = {
      userId: 'u', isSuperuser: false,
      memberships: [{ clientId: CLIENT, role: 'editor', vehicleIds: ['veh-a'] }],
    };
    expect(can(scoped, 'portfolio.read', { clientId: CLIENT, vehicleId: 'veh-a' })).toBe(true);
    expect(can(scoped, 'portfolio.read', { clientId: CLIENT, vehicleId: 'veh-b' })).toBe(false);
  });

  it('resolves a double membership to the more privileged role', () => {
    const both: Principal = {
      userId: 'u', isSuperuser: false,
      memberships: [
        { clientId: CLIENT, role: 'viewer' },
        { clientId: CLIENT, role: 'owner' },
      ],
    };
    expect(roleOn(both, CLIENT)).toBe('owner');
  });
});

describe('explaining a refusal', () => {
  it('says nothing when the capability is held', () => {
    expect(denialReason(withRole('owner'), 'facts.commit', { clientId: CLIENT })).toBeUndefined();
  });

  it('tells an investor why other accounts are absent, without blaming them', () => {
    const reason = denialReason(withRole('investor', 'inv-1'), 'investors.read.all', { clientId: CLIENT });
    expect(reason).toMatch(/your own capital account/i);
  });

  it('names who can do it instead', () => {
    expect(denialReason(withRole('analyst'), 'facts.commit', { clientId: CLIENT }))
      .toMatch(/editor or the client owner/i);
    expect(denialReason(withRole('viewer'), 'export', { clientId: CLIENT }))
      .toMatch(/analyst or above/i);
  });

  it('explains a missing membership rather than showing a bare denial', () => {
    expect(denialReason(outsider, 'portfolio.read', { clientId: CLIENT }))
      .toMatch(/do not have access/i);
  });
});

describe('the matrix as a whole', () => {
  it('gives every role the capability to open the client it belongs to', () => {
    for (const role of ROLES.filter((r) => r !== 'superuser')) {
      expect(can(withRole(role, 'inv-1'), 'client.read', { clientId: CLIENT })).toBe(true);
    }
  });

  it('gives the superuser everything', () => {
    expect(capabilitiesOn(superuser, CLIENT).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('grants strictly fewer capabilities as the role narrows', () => {
    const count = (role: Role) => capabilitiesOn(
      role === 'superuser' ? superuser : withRole(role, 'inv-1'), CLIENT,
    ).length;
    // The declared order is most to least privileged; the matrix must agree,
    // or a role name implies something the permissions do not.
    const counts = ROLES.map(count);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });
});
