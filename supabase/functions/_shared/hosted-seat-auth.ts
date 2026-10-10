import type postgres from "npm:postgres@3.4.9";

import { HOUSEHOLD_TOOL_REGISTRY, hostedContextErrorMessage, decideHostedContextLifecycle } from "./protocol.js";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const HOSTED_GRANT_TOOLS = ["claim_hosted_seat", "whoami"] as const;
export const HOSTED_SEAT_COMMAND_TOOLS = ["close_session", "ask", "note", "reply", "working_on", "check", ...HOUSEHOLD_TOOL_REGISTRY.filter(row => row.effect !== "read").map(row => row.name)] as const;
export const HOSTED_SEAT_READ_TOOLS = ["whoami", "members", ...HOUSEHOLD_TOOL_REGISTRY.filter(row => row.effect === "read").map(row => row.name)] as const;

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
  workspaceId?: string;
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
  context_id: string; client_id: string; seat: string;
  workspace: { id: string; name: string };
  display_name: string; disambiguator: string | null; assurance: 'portable';
  lifetime: 'ephemeral' | 'durable'; kind: 'chat' | 'task' | 'scheduled' | 'subagent';
  origin: 'new' | 'continue' | 'legacy'; created_at: string; last_business_at: string;
  idle_expires_at: string | null; absolute_expires_at: string | null;
  closed_at: string | null; close_reason: string | null; database_now: string;
  context_error: 'context_expired' | 'context_closed' | null;
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
  if (!grantTool(binding.tool)) return null;
  if (!await providerActive(binding)) { await auditAuthorizationDenial(tx,binding); return null; }
  if (binding.tool === 'whoami') {
    const [row] = await tx<{ data: Record<string, unknown> }[]>`SELECT swarm.resolve_hosted_discovery(${binding.grantId}::uuid,${binding.ownerUserId}::uuid) AS data`;
    if (!row?.data || row.data.provider_grant_id !== binding.providerGrantId) return null;
    return { grant_id: binding.grantId, owner_user_id: binding.ownerUserId, provider_grant_id: binding.providerGrantId,
      workspace_id: '', stream_id: '', manifest_digest: '' };
  }
  if (!binding.workspaceId) return null;
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
  if (row?.provider_grant_id !== binding.providerGrantId) { await auditAuthorizationDenial(tx,binding); return null; }
  return row;
}

async function resolveSeat(
  tx: Sql,
  binding: SeatBinding,
  use: "command" | "read",
): Promise<ResolvedHostedSeat | null> {
  const allowed = use === "command"
    ? (HOSTED_SEAT_COMMAND_TOOLS as readonly string[]).includes(binding.tool)
    : (HOSTED_SEAT_READ_TOOLS as readonly string[]).includes(binding.tool);
  if (!allowed || !seatTool(binding.tool)) return null;
  if (!await providerActive(binding)) { await auditAuthorizationDenial(tx,binding); return null; }
  const content = HOUSEHOLD_TOOL_REGISTRY.find(row => row.name === binding.tool);
  const databaseTool = content ? (use === "command" ? "note" : "members") : binding.tool;
  const [row] = await tx<{ identity: ResolvedHostedSeat | null }[]>`
    SELECT swarm.resolve_hosted_context(${binding.grantId}::uuid,${binding.handle},${databaseTool},${use}) AS identity
  `;
  const identity = row?.identity;
  if (identity?.provider_grant_id !== binding.providerGrantId) { await auditAuthorizationDenial(tx,binding); return null; }
  const utc = (value:string|null) => value === null ? null : new Date(value).toISOString();
  return { ...identity, created_at: utc(identity.created_at)!, last_business_at: utc(identity.last_business_at)!,
    idle_expires_at: utc(identity.idle_expires_at), absolute_expires_at: utc(identity.absolute_expires_at),
    closed_at: utc(identity.closed_at), database_now: utc(identity.database_now)! };
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

/** Content still requires its separate member and connection consent in the store. */
export async function revalidateHostedSeatContent(tx: Sql, capability: HostedSeatCapability): Promise<ResolvedHostedSeat | null> {
  const binding = bindings.get(capability);
  if (binding?.kind !== "hosted_seat") return null;
  const tool = HOUSEHOLD_TOOL_REGISTRY.find(row => row.name === binding.tool);
  return tool ? await resolveSeat(tx, binding, tool.effect === "read" ? "read" : "command") : null;
}

/** Household content tables are granted to swarm_command, so a read stays in
 * that transaction. The read resolver is executable by swarm_read only: take
 * that role for this call, then restore the command role before any store
 * statement. Writes keep the command resolver. */
export async function revalidateHouseholdSeat(
  tx: Sql,
  capability: HostedSeatCapability,
  restoreCommandRole: (tx: Sql) => Promise<void>,
): Promise<ResolvedHostedSeat | null> {
  const name = hostedCapabilityTool(capability);
  const reading = HOUSEHOLD_TOOL_REGISTRY.some((row) => row.name === name && row.effect === "read");
  if (!reading) return await revalidateHostedSeatContent(tx, capability);
  await tx`SELECT set_config('role', 'swarm_read', true)`;
  try {
    return await revalidateHostedSeatContent(tx, capability);
  } finally {
    await restoreCommandRole(tx);
  }
}

/** Resolve connection discovery without selecting a context or requiring a home. */
export async function revalidateHostedDiscovery(tx: Sql, capability: HostedGrantCapability): Promise<Record<string, unknown> | null> {
  const binding = bindings.get(capability);
  if (binding?.kind !== 'hosted_grant' || binding.tool !== 'whoami' || !await providerActive(binding)) return null;
  const [row] = await tx<{ data: Record<string, unknown> | null }[]>`SELECT swarm.resolve_hosted_discovery(${binding.grantId}::uuid,${binding.ownerUserId}::uuid) AS data`;
  if (row?.data?.provider_grant_id !== binding.providerGrantId) return null;
  const { provider_grant_id: _, ...data } = row.data;
  return data;
}
export function hostedContextFailure(seat: ResolvedHostedSeat | null): { status: number; body: Record<string, unknown> } | null {
  const error = seat === null ? 'identity_resume_unavailable' : seat.context_error;
  if (!error) return null;
  const can_start_new = seat !== null;
  return { status: 403, body: { error, message: hostedContextErrorMessage(error, can_start_new), can_start_new } };
}
/** Lock is held from resolution through business execution and renewal. */
export async function renewHostedContext(tx: Sql, seat: ResolvedHostedSeat): Promise<Record<string, unknown>> {
  const toMs = (v: string | null) => v === null ? null : Date.parse(v);
  const transition = decideHostedContextLifecycle({ ...seat, lifetime: seat.lifetime,
    created_at: Date.parse(seat.created_at), last_business_at: Date.parse(seat.last_business_at),
    idle_expires_at: toMs(seat.idle_expires_at), absolute_expires_at: toMs(seat.absolute_expires_at), closed_at: toMs(seat.closed_at) },
    { now: Date.parse(seat.database_now), authorized: true, use: 'business' });
  if (!transition.ok) throw new Error('hosted context activity lost its authorization');
  const [row] = await tx<{ state: Record<string, unknown> }[]>`SELECT swarm.record_hosted_context_activity(${seat.context_id}::uuid) AS state`;
  return row!.state;
}
/** Fixed metadata only; never record handles, tool arguments or content. */
export async function auditHostedContext(tx: Sql, seat: ResolvedHostedSeat, tool: string, outcome: string, reason: string | null, request: string | null = null): Promise<void> {
  await tx`SELECT swarm.audit_hosted_context(${seat.context_id}::uuid,${seat.grant_id}::uuid,${tool},${outcome},${reason},${request})`;
}

async function auditAuthorizationDenial(tx: Sql, binding: GrantBinding | SeatBinding): Promise<void> {
  await tx`SELECT swarm.audit_hosted_authorization_denial(${binding.grantId}::uuid,${binding.providerGrantId},${binding.tool})`;
}
