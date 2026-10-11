/**
 * Pure command/reducer regressions: synthetic actors and commands produce events
 * and state. Person precedence, closed worker images and model no-ops must survive
 * hostile completion fields and an authorized change of submitting actor.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideWorkspace, reduceWorkspace, type WorkspaceState, type WorkspaceCommand,
  type DecideWorkspaceCtx, type AgentAvatarImage, type AgentAvatarEvent, StreamIntegrityError,
} from '../src/protocol/index.js';
const image: AgentAvatarImage = { sha256: 'a'.repeat(64), object_prefix: `w/p/${'a'.repeat(64)}`,
  content_type: 'image/webp', byte_size: 4096, width: 256, height: 256 };
function world() {
  let seq = 0;
  let state: WorkspaceState = { workspace: { workspace_id: 'w', name: 'W', created_by: 'owner', created_at: 1, archived_at: null },
    members: { owner: { user_id: 'owner', role: 'owner', invited_by: null, joined_at: 1, revoked_at: null },
      member: { user_id: 'member', role: 'member', invited_by: null, joined_at: 1, revoked_at: null } },
    invitations: {}, principals: { p: { principal_id: 'p', owner_user_id: 'owner', name: 'P', model: null,
      transport: 'local', turn_only: false, created_at: 1, revoked_at: null } }, tokens: {}, owners_count: 1 };
  function apply(command: WorkspaceCommand, kind: DecideWorkspaceCtx['credential_kind'] = 'human', user = 'owner', operator = false) {
    const service = kind === 'avatar_service';
    const ctx: DecideWorkspaceCtx = { now: 100 + seq, actor: { user: service ? null : user,
      agent_principal: kind === 'agent' ? 'p' : null, run: null }, credential_kind: kind, presenting_token_id: null,
      command_id: `c-${seq}`, workspace_id: 'w', stream_id: 's', operatorAllowed: () => operator,
      role: user => state.members[user]?.role ?? null, inviteeAlreadyMember: () => false, identityVerified: () => true,
      humanRights: () => [], landingAuthorityChangeResolved: () => true, nextSeq: () => ++seq, nextEventId: () => `e-${seq}` };
    const d = decideWorkspace(state, command, ctx);
    for (const e of d.events) state = reduceWorkspace(state, e);
    return d;
  }
  return { apply, state: () => state, mutate: (fn: (s: WorkspaceState) => void) => fn(state),
    upload: (id: string, agent = false) => apply({ kind: 'begin_agent_avatar_upload', upload_id: id,
      ...(agent ? {} : { principal_id: 'p' }) }, agent ? 'agent' : 'human'),
    declare: (id: string, agent = false) => apply(agent ? { kind: 'declare_agent_avatar', upload_id: id }
      : { kind: 'set_agent_avatar', principal_id: 'p', upload_id: id }, agent ? 'agent' : 'human'),
    complete: (id: string) => apply({ kind: 'complete_agent_avatar_job', job_id: id, result: image }, 'avatar_service'),
  };
}
function reason(d: ReturnType<ReturnType<typeof world>['apply']>) { assert.equal(d.ok, false); return !d.ok ? d.reason : null; }
function payload(d: ReturnType<ReturnType<typeof world>['apply']>) { assert.equal(d.ok, true); return d.events[0]!.payload as AgentAvatarEvent; }

test('human ownership and agent-only commands have positive controls; no self target or borrowed upload', () => {
  const w = world();
  assert.equal(reason(w.apply({kind:'begin_agent_avatar_upload',principal_id:'p',upload_id:'wrong'}, 'human', 'member')), 'principal_not_owned');
  assert.equal(reason(w.apply({kind:'declare_agent_avatar',upload_id:'x'})), 'credential_kind_forbidden');
  assert.equal(reason(w.apply({kind:'clear_own_agent_avatar'})), 'credential_kind_forbidden');
  assert.equal(reason(w.apply({kind:'set_agent_avatar',principal_id:'p',upload_id:'x'}, 'agent')), 'credential_kind_forbidden');
  assert.equal(reason(w.apply({kind:'begin_agent_avatar_upload',principal_id:'p',upload_id:'x'}, 'agent')), 'credential_kind_forbidden');
  assert.equal(w.upload('person').ok, true);
  assert.equal(w.upload('agent', true).ok, true);
  assert.equal(reason(w.declare('person', true)), 'avatar_upload_not_found');
  assert.equal(w.declare('agent', true).ok, true);
  assert.equal(w.complete('agent').ok, true);
  assert.equal(w.state().avatars?.p?.source, 'declared_by_agent');
  assert.equal(w.apply({kind:'clear_own_agent_avatar'}, 'agent').ok, true);
  assert.equal(w.state().avatars?.p?.source, null);
});

test('plain members manage their own principal and admins manage another owner', () => {
  const w = world(); w.mutate(s => { s.principals.p!.owner_user_id = 'member'; });
  assert.equal(w.apply({kind:'begin_agent_avatar_upload',principal_id:'p',upload_id:'own'}, 'human', 'member').ok,true);
  assert.equal(w.apply({kind:'set_agent_avatar',principal_id:'p',upload_id:'own'}, 'human', 'member').ok,true);
  const admin = world(); admin.mutate(s => { s.members.member!.role = 'admin'; });
  assert.equal(admin.apply({kind:'begin_agent_avatar_upload',principal_id:'p',upload_id:'admin'}, 'human', 'member').ok,true);
  assert.equal(admin.apply({kind:'set_agent_avatar',principal_id:'p',upload_id:'admin'}, 'human', 'member').ok,true);
});

test('person pending and locked choices win; person clear releases lock and fences old completion', () => {
  const w = world(); w.upload('a', true); w.declare('a', true);
  w.upload('person'); w.declare('person');
  assert.equal(payload(w.apply({kind:'clear_own_agent_avatar'}, 'agent')).code, 'precedence');
  assert.equal(payload(w.complete('a')).code, 'stale');
  assert.equal(w.state().avatar_jobs?.a?.state, 'refused');
  w.complete('person');
  assert.equal(w.state().avatars?.p?.person_locked, true);
  assert.equal(payload(w.upload('blocked', true)).code, 'precedence');
  assert.equal(w.apply({kind:'clear_agent_avatar',principal_id:'p'}).ok, true);
  assert.equal(w.state().avatars?.p?.person_locked, false);
  assert.equal(w.upload('fresh', true).ok, true);
  w.declare('fresh', true); w.complete('fresh');
  assert.equal(w.state().avatars?.p?.generation, 4);
  assert.equal(w.state().avatars?.p?.source, 'declared_by_agent');
});

test('generation fence handles out of order jobs and clear before completion without replacing current image', () => {
  const w = world(); w.upload('old', true); w.declare('old', true); w.upload('new', true); w.declare('new', true);
  w.complete('new'); const current = w.state().avatars?.p;
  assert.equal(payload(w.complete('old')).code, 'stale');
  assert.deepEqual(w.state().avatars?.p, current);
  w.upload('person'); w.declare('person'); w.apply({kind:'clear_agent_avatar',principal_id:'p'});
  assert.equal(payload(w.complete('person')).code, 'stale');
  assert.equal(w.state().avatars?.p?.source, null);
});

test('worker rechecks precedence, principal revocation, workspace closure, service capability and image contract', () => {
  const w = world(); w.upload('a', true); w.declare('a', true);
  assert.equal(reason(w.apply({kind:'complete_agent_avatar_job',job_id:'a',result:image})), 'credential_kind_forbidden');
  assert.equal(reason(w.apply({kind:'clear_agent_avatar',principal_id:'p'}, 'avatar_service')), 'credential_kind_forbidden');
  assert.equal(reason(w.apply({kind:'complete_agent_avatar_job',job_id:'a',result:{...image,object_prefix:'foreign'}}, 'avatar_service')), 'avatar_invalid');
  w.mutate(s => { s.avatars!.p!.person_locked = true; });
  assert.equal(payload(w.complete('a')).code, 'precedence');
  const revoked = world(); revoked.upload('a',true); revoked.declare('a',true); revoked.mutate(s => { s.principals.p!.revoked_at = 2; });
  assert.equal(payload(revoked.complete('a')).code, 'principal_gone');
  const closed = world(); closed.upload('a',true); closed.declare('a',true); closed.mutate(s => {s.workspace.archived_at = 2;});
  assert.equal(payload(closed.complete('a')).code, 'principal_gone');
});

test('completion rejects extra result fields without releasing a person lock', () => {
  const w = world(); w.upload('person'); w.declare('person');
  const pendingAvatar = structuredClone(w.state().avatars?.p);
  for (const extra of [{person_locked:false}, {unexpected:'extra'}]) {
    const refused = w.apply({kind:'complete_agent_avatar_job',job_id:'person',result:{...image,...extra}}, 'avatar_service');
    assert.equal(reason(refused), 'avatar_invalid');
    assert.deepEqual(w.state().avatars?.p, pendingAvatar);
    assert.equal(w.state().avatar_jobs?.person?.state, 'pending');
    assert.equal(payload(w.upload('blocked', true)).code, 'precedence');
  }
  // The same pending job accepts exactly the image contract and retains authority.
  assert.equal(w.complete('person').ok, true);
  assert.deepEqual(w.state().avatars?.p, {...pendingAvatar,...image,
    source:'uploaded_by_person',source_ref:null,set_by_user_id:'owner',set_by_principal_id:null,
    set_at:w.state().avatar_jobs?.person?.completed_at});
  assert.equal(w.state().avatars?.p?.person_locked, true);
  assert.equal(payload(w.upload('still-blocked', true)).code, 'precedence');
});

test('operator gate and normalized removal reason; audited removal unlocks and increments generation', () => {
  const w = world(); w.upload('a'); w.declare('a'); w.complete('a');
  assert.equal(reason(w.apply({kind:'remove_agent_avatar',principal_id:'p',reason:'report'})), 'operator_not_allowed');
  assert.equal(reason(w.apply({kind:'remove_agent_avatar',principal_id:'p',reason:'\u202e report'}, 'human', 'support', true)), 'avatar_invalid');
  assert.equal(reason(w.apply({kind:'remove_agent_avatar',principal_id:'p',reason:'x'.repeat(201)}, 'human', 'support', true)), 'avatar_invalid');
  const p = payload(w.apply({kind:'remove_agent_avatar',principal_id:'p',reason:'  report  '}, 'human', 'support', true));
  assert.equal(p.reason, 'report'); assert.equal(p.removed_by, 'support');
  assert.equal(w.state().avatars?.p?.generation, 2); assert.equal(w.state().avatars?.p?.person_locked, false);
});

test('provenance uses envelope principal before human owner, including model clears; avatars do not change it', () => {
  const w = world();
  w.apply({kind:'create_agent_principal',principal_id:'q',name:'Q',model:'  Model Q  '});
  assert.equal(w.state().principals.q?.model, 'Model Q'); assert.equal(w.state().model_provenance?.q?.model_set_by,'person');
  w.apply({kind:'declare_agent_model',model:' Model P '}, 'agent');
  assert.equal(w.state().model_provenance?.p?.model_set_by,'agent'); assert.equal(w.state().model_provenance?.p?.set_by_user_id,null);
  w.apply({kind:'set_agent_model',principal_id:'p',model:'Person Model P'});
  assert.equal(w.state().model_provenance?.p?.model_set_by,'person');
  w.apply({kind:'declare_agent_model',model:' '}, 'agent');
  assert.equal(w.state().principals.p?.model,null); assert.equal(w.state().model_provenance?.p?.model_set_by,'agent');
  const provenance = w.state().model_provenance; w.upload('a');w.declare('a');w.complete('a');w.apply({kind:'clear_agent_avatar',principal_id:'p'});
  assert.deepEqual(w.state().model_provenance,provenance);
});

test('unchanged normalized model commands append nothing and preserve provenance across actors', () => {
  const w = world();
  // A changed model supplies the positive control and initial agent provenance.
  assert.equal(w.apply({kind:'declare_agent_model',model:'Model P'}, 'agent').events.length, 1);
  const before = structuredClone(w.state());
  const human = w.apply({kind:'set_agent_model',principal_id:'p',model:'  Model P  '});
  assert.equal(human.ok, true); assert.deepEqual(human.events, []);
  assert.deepEqual(w.state(), before);
  // Likewise an agent cannot take attribution for a person's unchanged label.
  assert.equal(w.apply({kind:'set_agent_model',principal_id:'p',model:'Person P'}).events.length, 1);
  const personState = structuredClone(w.state());
  const agent = w.apply({kind:'declare_agent_model',model:'  Person P  '}, 'agent');
  assert.equal(agent.ok, true); assert.deepEqual(agent.events, []);
  assert.deepEqual(w.state(), personState);
});

test('reducer refuses malformed avatar generations instead of silently folding them', () => {
  const w = world(); const d = w.upload('a'); const e = d.events[0]!;
  assert.throws(() => reduceWorkspace(w.state(), {...e,type:'AgentAvatarSet',payload:{principal_id:'p'}}), StreamIntegrityError);
});
