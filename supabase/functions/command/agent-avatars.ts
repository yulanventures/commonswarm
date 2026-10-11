/** Phase 2 command projection. Storage PUT/signing and worker transport are phase 3. */
import type postgres from 'npm:postgres@3.4.9';
import type { AgentAvatar, AgentAvatarJob, AgentAvatarEvent, AgentModelProvenance } from '../_shared/agent-avatars.d.ts';
type Sql = postgres.TransactionSql;
const at = (value: unknown): number | null => value instanceof Date ? value.getTime() : null;
export async function loadAgentAvatarState(tx: Sql, workspaceId: string) {
  const avatars: Record<string, AgentAvatar> = {};
  const avatar_jobs: Record<string, AgentAvatarJob> = {};
  const model_provenance: Record<string, AgentModelProvenance> = {};
  for (const row of await tx`SELECT * FROM swarm.agent_avatars WHERE workspace_id=${workspaceId}::uuid`) {
    const image = row.source === null ? {} : { object_prefix: String(row.object_prefix), content_type: 'image/webp' as const,
      byte_size: Number(row.byte_size), width: 256 as const, height: 256 as const, sha256: String(row.sha256) };
    avatars[row.principal_id] = { ...image, principal_id: row.principal_id, generation: Number(row.generation),
      person_locked: row.person_locked, source: row.source, source_ref: row.source_ref,
      set_by_user_id: row.set_by_user_id, set_by_principal_id: row.set_by_principal_id, set_at: at(row.set_at) };
  }
  for (const row of await tx`SELECT * FROM swarm.agent_avatar_jobs WHERE workspace_id=${workspaceId}::uuid`) {
    avatar_jobs[row.job_id] = { job_id: row.job_id, principal_id: row.principal_id, generation: Number(row.generation),
      quarantine_key: row.quarantine_key, source: row.source, requested_by_user_id: row.requested_by_user_id,
      requested_by_principal_id: row.requested_by_principal_id, state: row.state, refusal_code: row.refusal_code,
      created_at: at(row.created_at)!, declared_at: at(row.declared_at), completed_at: at(row.completed_at) };
  }
  for (const row of await tx`SELECT * FROM swarm.agent_model_provenance WHERE workspace_id=${workspaceId}::uuid`) {
    model_provenance[row.principal_id] = { principal_id: row.principal_id, model_set_by: row.model_set_by,
      set_by_user_id: row.set_by_user_id, set_at: at(row.set_at)! };
  }
  return { avatars, avatar_jobs, model_provenance };
}
export async function projectAgentAvatarEvent(tx: Sql, workspaceId: string, p: AgentAvatarEvent): Promise<void> {
  if (p.avatar) {
    const a = p.avatar;
    await tx`INSERT INTO swarm.agent_avatars(principal_id,workspace_id,object_prefix,content_type,byte_size,width,height,sha256,
      source,generation,person_locked,source_ref,set_by_user_id,set_by_principal_id,set_at)
      VALUES(${a.principal_id}::uuid,${workspaceId}::uuid,${a.object_prefix ?? null},${a.content_type ?? null},${a.byte_size ?? null},
      ${a.width ?? null},${a.height ?? null},${a.sha256 ?? null},${a.source},${a.generation},${a.person_locked},${a.source_ref},
      ${a.set_by_user_id}::uuid,${a.set_by_principal_id}::uuid,${a.set_at === null ? null : new Date(a.set_at)})
      ON CONFLICT(principal_id) DO UPDATE SET object_prefix=EXCLUDED.object_prefix,content_type=EXCLUDED.content_type,
      byte_size=EXCLUDED.byte_size,width=EXCLUDED.width,height=EXCLUDED.height,sha256=EXCLUDED.sha256,source=EXCLUDED.source,
      generation=EXCLUDED.generation,person_locked=EXCLUDED.person_locked,source_ref=EXCLUDED.source_ref,
      set_by_user_id=EXCLUDED.set_by_user_id,set_by_principal_id=EXCLUDED.set_by_principal_id,set_at=EXCLUDED.set_at`;
  }
  if (p.job) {
    const j = p.job;
    await tx`INSERT INTO swarm.agent_avatar_jobs(job_id,principal_id,workspace_id,generation,quarantine_key,source,
      requested_by_user_id,requested_by_principal_id,state,refusal_code,created_at,declared_at,completed_at)
      VALUES(${j.job_id}::uuid,${j.principal_id}::uuid,${workspaceId}::uuid,${j.generation},${j.quarantine_key},${j.source},
      ${j.requested_by_user_id}::uuid,${j.requested_by_principal_id}::uuid,${j.state},${j.refusal_code},${new Date(j.created_at)},
      ${j.declared_at === null ? null : new Date(j.declared_at)},${j.completed_at === null ? null : new Date(j.completed_at)})
      ON CONFLICT(job_id) DO UPDATE SET generation=EXCLUDED.generation,state=EXCLUDED.state,refusal_code=EXCLUDED.refusal_code,
      declared_at=EXCLUDED.declared_at,completed_at=EXCLUDED.completed_at`;
  }
}
export async function projectAgentModelProvenance(tx: Sql, workspaceId: string, p: AgentModelProvenance): Promise<void> {
  await tx`INSERT INTO swarm.agent_model_provenance(principal_id,workspace_id,model_set_by,set_by_user_id,set_at)
    VALUES(${p.principal_id}::uuid,${workspaceId}::uuid,${p.model_set_by},${p.set_by_user_id}::uuid,${new Date(p.set_at)})
    ON CONFLICT(principal_id) DO UPDATE SET model_set_by=EXCLUDED.model_set_by,set_by_user_id=EXCLUDED.set_by_user_id,set_at=EXCLUDED.set_at`;
}
