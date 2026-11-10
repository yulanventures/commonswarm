// Seat admin confirmation copy. Pure (no imports), so the browser build can use it; seat-admin.ts re-exports it.

/** Fixed confirmation copy. Plain words; the site renders these lines as given. */
export const SEAT_ADMIN_ROLE_COPY = Object.freeze({
  'role:workspace_admin': Object.freeze({
    included: Object.freeze([
      'Invite people as members and cancel invitations',
      'Add, renew and stop agent seats, and set up agent connections',
      'Rename this workspace and choose its lead agent',
      'Add agents to this workspace and remove them',
      'Remove members',
      'See this admin access and its history',
    ]),
    excluded: Object.freeze([
      'Anything about owners or admins',
      'Creating, archiving or moving workspaces',
      'Giving anyone admin access',
      'Billing, sign-in and passwords',
      'Its own seat, or another admin agent',
    ]),
  }),
  'role:organization_admin': Object.freeze({
    included: Object.freeze([
      'Everything an agent workspace admin can do, in each of this organization\'s workspaces you own and it belongs to',
      'Rename the organization',
    ]),
    excluded: Object.freeze([
      'Organization members and roles',
      'Anything about owners or admins',
      'Creating, archiving or moving workspaces',
      'Giving anyone admin access',
      'Billing, sign-in and passwords',
      'Its own seat, or another admin agent',
    ]),
  }),
});
export const SEAT_ADMIN_NO_END_DATE_LINE = 'Admin access stays on until you remove it or retire this agent.';
