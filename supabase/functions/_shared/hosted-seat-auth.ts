import type postgres from "npm:postgres@3.4.9";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const HOSTED_GRANT_TOOLS = ["claim_hosted_seat"] as const;
export const HOSTED_SEAT_COMMAND_TOOLS = ["ask", "note", "reply", "working_on"] as const;
export const HOSTED_SEAT_READ_TOOLS = ["whoami", "members", "check"] as const;

export type HostedGrantTool = typeof HOSTED_GRANT_TOOLS[number];
export type HostedSeatCommandTool = typeof HOSTED_SEAT_COMMAND_TOOLS[number];
export type HostedSeatReadTool = typeof HOSTED_SEAT_READ_TOOLS[number];
export type HostedSeatTool = HostedSeatCommandTool | HostedSeatReadTool;

export type ProviderGrantStatus = (
  providerGrantId: string,
) => Promise<{ active: boolean }>;

declare const hostedCapabilityBrand: unique symbol;

export interface HostedGrantCapability {
  readonly kind: "hosted_grant";
  readonly [hostedCapabilityBrand]: true;
}

export interface HostedSeatCapability {
  readonly kind: "hosted_seat";
  readonly [hostedCapabilityBrand]: true;
}

export type HostedCapability = HostedGrantCapability | HostedSeatCapability;

interface GrantBinding {
  kind: "hosted_grant";
  grantId: string;
  ownerUserId: string;
  providerGrantId: string;
  workspaceId: string;
  tool: HostedGrantTool;
  providerStatus: ProviderGrantStatus;
}

interface SeatBinding {
  kind: "hosted_seat";
  grantId: string;
  providerGrantId: string;
  handle: string;
  tool: HostedSeatTool;
  providerStatus: ProviderGrantStatus;
}

const bindings = new WeakMap<object, GrantBinding | SeatBinding>();

export interface ResolvedHostedGrant {
  grant_id: string;
  owner_user_id: string;
  provider_grant_id: string;
  workspace_id: string;
  stream_id: string;
  manifest_digest: string;
}

export interface ResolvedHostedSeat {
  grant_id: string;
  provider_grant_id: string;
  seat_id: string;
  handle: string;
  workspace_id: string;
  stream_id: string;
  owner_user_id: string;
  principal_id: string;
  name: string;
}

function grantTool(value: string): value is HostedGrantTool {
  return (HOSTED_GRANT_TOOLS as readonly string[]).includes(value);
}

function seatTool(value: string): value is HostedSeatTool {
  return (HOSTED_SEAT_COMMAND_TOOLS as readonly string[]).includes(value) ||
    (HOSTED_SEAT_READ_TOOLS as readonly string[]).includes(value);
}

async function providerActive(binding: GrantBinding | SeatBinding): Promise<boolean> {
  const status = await binding.providerStatus(binding.providerGrantId);
  return status.active === true;
}

async function resolveGrant(
  tx: Sql,
  binding: GrantBinding,
): Promise<ResolvedHostedGrant | null> {
  if (!grantTool(binding.tool) || !await providerActive(binding)) return null;
  const rows = await tx<ResolvedHostedGrant[]>`
    SELECT grant_id, owner_user_id, provider_grant_id, workspace_id,
           stream_id, encode(manifest_digest, 'hex') AS manifest_digest
    FROM swarm.resolve_hosted_grant_authorization(
      ${binding.grantId}::uuid,
      ${binding.ownerUserId}::uuid,
      ${binding.workspaceId}::uuid,
      ${binding.tool}
    )
  `;
  const row = rows[0];
  return row?.provider_grant_id === binding.providerGrantId ? row : null;
}

async function resolveSeat(
  tx: Sql,
  binding: SeatBinding,
  use: "command" | "read",
): Promise<ResolvedHostedSeat | null> {
  const allowed = use === "command"
    ? (HOSTED_SEAT_COMMAND_TOOLS as readonly string[]).includes(binding.tool)
    : (HOSTED_SEAT_READ_TOOLS as readonly string[]).includes(binding.tool);
  if (!allowed || !seatTool(binding.tool) || !await providerActive(binding)) return null;
  const rows = use === "command"
    ? await tx<ResolvedHostedSeat[]>`
      SELECT * FROM swarm.resolve_hosted_seat_command_authorization(
        ${binding.grantId}::uuid,
        ${binding.handle},
        ${binding.tool}
      )
    `
    : await tx<ResolvedHostedSeat[]>`
      SELECT * FROM swarm.resolve_hosted_seat_read_authorization(
        ${binding.grantId}::uuid,
        ${binding.handle},
        ${binding.tool}
      )
    `;
  const row = rows[0];
  return row?.provider_grant_id === binding.providerGrantId ? row : null;
}

/**
 * Trusted MCP authentication calls these constructors only after JWT/provider
 * verification. The returned object contains no identifiers and is accepted
 * only while it remains in this module's WeakMap, so JSON/HTTP input cannot
 * manufacture a capability by matching a TypeScript shape.
 */
export async function authenticateHostedGrantCapability(
  tx: Sql,
  input: Omit<GrantBinding, "kind">,
): Promise<HostedGrantCapability | null> {
  const binding: GrantBinding = { kind: "hosted_grant", ...input };
  if (await resolveGrant(tx, binding) === null) return null;
  const capability = Object.freeze({ kind: "hosted_grant" }) as HostedGrantCapability;
  bindings.set(capability, binding);
  return capability;
}

export async function authenticateHostedSeatCapability(
  tx: Sql,
  input: Omit<SeatBinding, "kind">,
  use: "command" | "read",
): Promise<HostedSeatCapability | null> {
  const binding: SeatBinding = { kind: "hosted_seat", ...input };
  if (await resolveSeat(tx, binding, use) === null) return null;
  const capability = Object.freeze({ kind: "hosted_seat" }) as HostedSeatCapability;
  bindings.set(capability, binding);
  return capability;
}

export async function revalidateHostedGrantCommand(
  tx: Sql,
  capability: HostedGrantCapability,
): Promise<ResolvedHostedGrant | null> {
  const binding = bindings.get(capability);
  return binding?.kind === "hosted_grant" ? await resolveGrant(tx, binding) : null;
}

export async function revalidateHostedSeatCommand(
  tx: Sql,
  capability: HostedSeatCapability,
): Promise<ResolvedHostedSeat | null> {
  const binding = bindings.get(capability);
  return binding?.kind === "hosted_seat" ? await resolveSeat(tx, binding, "command") : null;
}

export async function revalidateHostedSeatRead(
  tx: Sql,
  capability: HostedSeatCapability,
): Promise<ResolvedHostedSeat | null> {
  const binding = bindings.get(capability);
  return binding?.kind === "hosted_seat" ? await resolveSeat(tx, binding, "read") : null;
}

export function hostedCapabilityTool(capability: HostedCapability): string | null {
  return bindings.get(capability)?.tool ?? null;
}
