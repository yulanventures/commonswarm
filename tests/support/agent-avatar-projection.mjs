// Deno-only CI boundary; Node tests launch this with a protected local env file.
import assert from 'node:assert/strict';
import postgres from 'npm:postgres@3.4.9';
import { decideWorkspace, reduceWorkspace } from '../../supabase/functions/_shared/protocol.js';
import { loadAgentAvatarState, projectAgentAvatarEvent, projectAgentModelProvenance } from '../../supabase/functions/command/agent-avatars.ts';
const db = postgres(Deno.env.get('AVATAR_TEST_DB_URL'),{prepare:false,max:1});
const id = () => crypto.randomUUID();
const owner=id(),workspace=id(),principal=id(),job=id(),stream=id();
class RollbackProof extends Error {}
function check(value, label) { if (!value) throw new Error(label); }
try {
  try { await db.begin(async tx => {
    await tx`INSERT INTO auth.users(id,aud,role,email) VALUES(${owner}::uuid,'authenticated','authenticated',${`${owner}@example.test`})`;
    await tx`INSERT INTO swarm.users(user_id,display_name) VALUES(${owner}::uuid,'Synthetic owner')`;
    await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${workspace}::uuid,'Projection fixture',${owner}::uuid)`;
    await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${workspace}::uuid,${owner}::uuid,'owner')`;
    await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${stream}::uuid,${workspace}::uuid,'workspace')`;
    await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name) VALUES(${principal}::uuid,${workspace}::uuid,${owner}::uuid,'Synthetic agent')`;
    await tx`SET LOCAL ROLE swarm_command`;
    let state = { workspace:{workspace_id:workspace,name:'Projection fixture',created_by:owner,created_at:1,archived_at:null},
      members:{[owner]:{user_id:owner,role:'owner',invited_by:null,joined_at:1,revoked_at:null}},invitations:{},tokens:{},owners_count:1,
      principals:{[principal]:{principal_id:principal,owner_user_id:owner,name:'Synthetic agent',model:null,transport:'local',turn_only:false,created_at:1,revoked_at:null}},
      ...await loadAgentAvatarState(tx,workspace) };
    let seq=0;
    const apply = async (cmd, kind='human') => {
      const ctx={now:1000+seq,actor:{user:kind==='avatar_service'?null:owner,agent_principal:kind==='agent'?principal:null,run:null},
        credential_kind:kind,presenting_token_id:null,workspace_id:workspace,stream_id:stream,command_id:`projection-${seq}`,
        role:()=> 'owner',operatorAllowed:()=>false,identityVerified:()=>true,humanRights:()=>[],inviteeAlreadyMember:()=>false,
        landingAuthorityChangeResolved:()=>true,nextSeq:()=>++seq,nextEventId:id};
      const decision=decideWorkspace(state,cmd,ctx);check(decision.ok,'command accepted');
      for(const e of decision.events) {
        state=reduceWorkspace(state,e);
        // The real append-only history is written beside the real projection.
        await tx`INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,actor_user,actor_agent_principal,actor_run,occurred_at_server,payload)
          VALUES(${workspace}::uuid,${stream}::uuid,${e.seq},${e.event_id}::uuid,${e.command_id},${e.type},1,${e.actor_user}::uuid,
          ${e.actor_agent_principal}::uuid,NULL,${new Date(e.occurred_at_server)},${tx.json(e.payload)})`;
        if(e.type==='AgentModelDeclared') {
          await tx`UPDATE swarm.agent_principals SET model=${e.payload.model} WHERE principal_id=${principal}::uuid`;
          await projectAgentModelProvenance(tx,workspace,state.model_provenance[principal]);
        } else await projectAgentAvatarEvent(tx,workspace,e.payload);
      }
      const reloaded=await loadAgentAvatarState(tx,workspace);
      assert.deepEqual(reloaded.avatars,state.avatars??{},'avatar reload');
      assert.deepEqual(reloaded.avatar_jobs,state.avatar_jobs??{},'job reload');
      assert.deepEqual(reloaded.model_provenance,state.model_provenance??{},'provenance reload');
      state={...state,...reloaded};
    };
    await apply({kind:'declare_agent_model',model:'Agent model'},'agent');
    check(state.model_provenance[principal].model_set_by==='agent' && state.model_provenance[principal].set_by_user_id===null,'agent actor precedence');
    await apply({kind:'set_agent_model',principal_id:principal,model:'Agent model'});
    check(state.model_provenance[principal].model_set_by==='person','human provenance');
    await apply({kind:'begin_agent_avatar_upload',principal_id:principal,upload_id:job});
    check(state.avatar_jobs[job].declared_at===null,'begin is not runnable');
    await apply({kind:'set_agent_avatar',principal_id:principal,upload_id:job});
    check(state.avatars[principal].generation===1 && state.avatars[principal].person_locked,'declaration fence');
    const result={object_prefix:`${workspace}/${principal}/${'a'.repeat(64)}`,sha256:'a'.repeat(64),content_type:'image/webp',byte_size:1024,width:256,height:256};
    await apply({kind:'complete_agent_avatar_job',job_id:job,result},'avatar_service');
    check(state.avatars[principal].sha256==='a'.repeat(64) && state.avatar_jobs[job].state==='done','completion projection');
    const stale=id();await apply({kind:'begin_agent_avatar_upload',principal_id:principal,upload_id:stale});
    await apply({kind:'set_agent_avatar',principal_id:principal,upload_id:stale});
    await apply({kind:'clear_agent_avatar',principal_id:principal});
    await apply({kind:'complete_agent_avatar_job',job_id:stale,result},'avatar_service');
    check(state.avatar_jobs[stale].refusal_code==='stale' && state.avatars[principal].source===null,'refusal persisted beside clear');
    throw new RollbackProof();
  }); } catch(e) { if (!(e instanceof RollbackProof)) throw e; }
  const rows=await db`SELECT count(*)::integer AS n FROM swarm.workspaces WHERE workspace_id=${workspace}::uuid`;
  check(rows[0].n===0,'test transaction rolled back');
} finally { await db.end(); }
