/**
 * Permissions.
 *
 * One capability matrix, consulted everywhere. The alternative — role checks
 * scattered through components — is how a screen ends up showing a button that
 * the database will refuse, or worse, showing data it should not.
 *
 * Three rules govern the design:
 *
 * 1. **The database is the boundary; this file is the explanation.** Every
 *    capability here has a matching row-level-security policy. Nothing is
 *    protected by hiding a button. What this file buys is a UI that matches
 *    what the database will actually allow, and a reason to show when it will
 *    not.
 *
 * 2. **Reading other investors is the line that matters.** A fund's own team
 *    seeing the portfolio is ordinary. One investor seeing another investor's
 *    commitment is a confidentiality incident, so `investors.read.all` and
 *    `investors.read.own` are separate capabilities and an investor login is
 *    bound to exactly one investor row.
 *
 * 3. **Export is a capability, not a side effect of reading.** Anyone who can
 *    read a screen can copy it by hand; anyone who can export can take the
 *    whole history in one click. The two are not the same risk and are not
 *    granted together by default.
 */

/**
 * Roles, ordered from most to least privileged. The order is used to resolve
 * a user who somehow holds two memberships on one client.
 */
export const ROLES = [
  'superuser',
  'owner',
  'editor',
  'analyst',
  'auditor',
  'viewer',
  'investor',
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  superuser: 'Superuser',
  owner: 'Client owner',
  editor: 'Editor',
  analyst: 'Analyst',
  auditor: 'Auditor',
  viewer: 'Viewer',
  investor: 'Investor',
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  superuser:
    'Every client on the platform, and membership management. Not a reporting role — it exists to administer the system.',
  owner:
    'Full control of one client, including who else may reach it.',
  editor:
    'Loads documents and files figures. The role that changes what the reports say.',
  analyst:
    'Reads everything of a client and takes it away — reports and extracts — but cannot file a figure.',
  auditor:
    'Reads everything including who filed what and when. Can never write, by construction rather than by convention.',
  viewer:
    'Reads on screen. No export, because taking the whole history away is a different risk from looking at it.',
  investor:
    'Sees the vehicle they are invested in and their own capital account. Never another investor’s.',
};

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

export const CAPABILITIES = [
  /** See the client exists and open it. */
  'client.read',
  /** Rename the client, set its conventions. */
  'client.manage',
  /** Grant and revoke other people's access. */
  'members.manage',

  /** The gross tier: the holding register and per-position valuations. */
  'portfolio.read',
  /** Every investor's capital account. */
  'investors.read.all',
  /** Only the capital account this login is bound to. */
  'investors.read.own',

  /** Upload a document and see what was read from it. */
  'documents.upload',
  /** Turn reviewed candidates into facts. */
  'facts.commit',

  /** Generate a report from a predefined layout. */
  'reports.generate',
  /** Take the historical database away as a file. */
  'export',

  /** Coverage, identity checks, and who filed what. */
  'audit.read',
  /** Sustainability metrics. */
  'esg.read',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The matrix. Read it as the whole authorisation model, because it is.
 *
 * `investor` deliberately holds `portfolio.read`: a limited partner receives
 * the portfolio listing in their quarterly report, so withholding it on screen
 * would be theatre. What they must never hold is `investors.read.all`.
 */
const MATRIX: Record<Role, readonly Capability[]> = {
  superuser: CAPABILITIES,

  owner: [
    'client.read', 'client.manage', 'members.manage',
    'portfolio.read', 'investors.read.all', 'investors.read.own',
    'documents.upload', 'facts.commit',
    'reports.generate', 'export', 'audit.read', 'esg.read',
  ],

  editor: [
    'client.read',
    'portfolio.read', 'investors.read.all', 'investors.read.own',
    'documents.upload', 'facts.commit',
    'reports.generate', 'export', 'audit.read', 'esg.read',
  ],

  analyst: [
    'client.read',
    'portfolio.read', 'investors.read.all', 'investors.read.own',
    'documents.upload',
    'reports.generate', 'export', 'audit.read', 'esg.read',
  ],

  auditor: [
    'client.read',
    'portfolio.read', 'investors.read.all', 'investors.read.own',
    'reports.generate', 'export', 'audit.read', 'esg.read',
  ],

  viewer: [
    'client.read',
    'portfolio.read', 'investors.read.all', 'investors.read.own',
    'reports.generate', 'audit.read', 'esg.read',
  ],

  investor: [
    'client.read',
    'portfolio.read',
    'investors.read.own',
    'reports.generate',
  ],
};

/* ------------------------------------------------------------------ *
 * Principals
 * ------------------------------------------------------------------ */

export interface Membership {
  clientId: string;
  role: Role;
  /**
   * Set only for the `investor` role: the capital account this login may see.
   * A membership without it grants nothing, which is the safe failure.
   */
  investorId?: string;
  /**
   * Restricts the membership to specific vehicles. Empty means every vehicle of
   * the client.
   */
  vehicleIds?: string[];
}

export interface Principal {
  userId: string;
  email?: string;
  displayName?: string;
  /** Every client on the platform, bypassing membership. */
  isSuperuser: boolean;
  memberships: Membership[];
}

/** The demo dataset has nobody to authenticate, so it runs as a superuser. */
export const DEMO_PRINCIPAL: Principal = {
  userId: 'demo',
  displayName: 'Demo (superuser)',
  isSuperuser: true,
  memberships: [],
};

/* ------------------------------------------------------------------ *
 * Asking
 * ------------------------------------------------------------------ */

export interface Scope {
  clientId?: string;
  vehicleId?: string;
}

/** The role a principal holds on a client, or undefined for no access. */
export function roleOn(principal: Principal, clientId: string | undefined): Role | undefined {
  if (principal.isSuperuser) return 'superuser';
  if (!clientId) return undefined;

  const held = principal.memberships.filter((m) => m.clientId === clientId);
  if (held.length === 0) return undefined;

  // Two memberships on one client should not happen, but if it does the more
  // privileged one wins rather than whichever was read first.
  return held
    .map((m) => m.role)
    .sort((a, b) => ROLES.indexOf(a) - ROLES.indexOf(b))[0];
}

export function can(
  principal: Principal,
  capability: Capability,
  scope: Scope = {},
): boolean {
  const role = roleOn(principal, scope.clientId);
  if (!role) return false;

  if (!MATRIX[role].includes(capability)) return false;

  // A membership narrowed to certain vehicles grants nothing outside them.
  if (scope.vehicleId && !principal.isSuperuser) {
    const membership = principal.memberships.find((m) => m.clientId === scope.clientId);
    const allowed = membership?.vehicleIds;
    if (allowed && allowed.length > 0 && !allowed.includes(scope.vehicleId)) return false;
  }

  return true;
}

/** Capabilities a principal holds on a client — for showing what a role is. */
export function capabilitiesOn(principal: Principal, clientId: string | undefined): Capability[] {
  const role = roleOn(principal, clientId);
  return role ? [...MATRIX[role]] : [];
}

/** The clients a principal may open at all. `undefined` means every client. */
export function visibleClientIds(principal: Principal): string[] | undefined {
  if (principal.isSuperuser) return undefined;
  return [...new Set(principal.memberships.map((m) => m.clientId))];
}

/**
 * The investor a principal is bound to on a client, if any.
 *
 * Present for an `investor` login and undefined for everyone else — which is
 * what the difference between "one account" and "all accounts" turns on.
 */
export function boundInvestorId(
  principal: Principal, clientId: string | undefined,
): string | undefined {
  if (!clientId || principal.isSuperuser) return undefined;
  const membership = principal.memberships.find(
    (m) => m.clientId === clientId && m.role === 'investor',
  );
  return membership?.investorId;
}

/**
 * Why a capability is unavailable, phrased for the person reading it.
 *
 * A disabled control with no explanation reads as a bug, and the user's next
 * move is to ask someone whether the system is broken.
 */
export function denialReason(
  principal: Principal,
  capability: Capability,
  scope: Scope = {},
): string | undefined {
  if (can(principal, capability, scope)) return undefined;

  const role = roleOn(principal, scope.clientId);
  if (!role) {
    return 'You do not have access to this client. A client owner can grant it.';
  }

  const label = ROLE_LABEL[role];
  switch (capability) {
    case 'facts.commit':
      return `${label} can review what a document says but not file it. An editor or the client owner commits.`;
    case 'documents.upload':
      return `${label} cannot load documents. An analyst, editor or the client owner can.`;
    case 'export':
      return `${label} can read on screen but not take the history away as a file. An analyst or above can export.`;
    case 'investors.read.all':
      return role === 'investor'
        ? 'You see your own capital account. Other investors’ accounts are not visible to you.'
        : `${label} cannot see investor capital accounts.`;
    case 'members.manage':
      return `${label} cannot change who has access. Only the client owner can.`;
    case 'client.manage':
      return `${label} cannot change the client’s settings.`;
    case 'audit.read':
      return `${label} cannot see coverage and control detail.`;
    case 'esg.read':
      return `${label} cannot see sustainability metrics.`;
    default:
      return `${label} does not have this permission.`;
  }
}
