// Seat admin confirmation copy. Pure (no imports), so the browser build can use it; seat-admin.ts re-exports it.

// Presentation availability only. The pinned registry and grant manifests do not change with this copy.
const DEFERRED_ACTIONS = Object.freeze([
  'Invite people as members',
  'Create or renew agent seats',
  'Stop agent seats or revoke their credentials',
  'Set up agent connections',
  'Change member roles',
]);

/** Fixed confirmation copy. Plain words; the site renders these lines as given. */
export const SEAT_ADMIN_ROLE_COPY = Object.freeze({
  'role:workspace_admin': Object.freeze({
    included: Object.freeze([
      'Rename this workspace',
      'Choose one of your agents in this workspace as its lead',
      'Add your agents to this workspace or remove them',
      'Remove members, including their agents and Lists & docs access in this workspace',
      'Cancel member invitations you created',
    ]),
    deferred: DEFERRED_ACTIONS,
    excluded: Object.freeze([
      'Changes to owners or admins',
      'Other people\'s agents',
      'Changing itself or another agent with admin access',
      'Removing members who own an agent with admin access',
      'Creating, archiving or moving workspaces',
      'Giving anyone admin access',
      'Billing, sign-in and passwords',
    ]),
  }),
  'role:organization_admin': Object.freeze({
    included: Object.freeze([
      'Everything available now to a workspace admin, in this organization\'s workspaces you own and this agent belongs to',
      'Rename the organization\'s display name',
    ]),
    deferred: DEFERRED_ACTIONS,
    excluded: Object.freeze([
      'Organization members and roles',
      'Changes to owners or admins',
      'Other people\'s agents',
      'Changing itself or another agent with admin access',
      'Removing members who own an agent with admin access',
      'Creating, archiving or moving workspaces',
      'Giving anyone admin access',
      'Billing, sign-in and passwords',
    ]),
  }),
});
export const SEAT_ADMIN_NO_END_DATE_LINE = 'Admin access stays on until you remove it or retire this agent.';
