// Consumer-side OAuth fixtures use the real tables/triggers. This is not an AS
// issuance test: edge tests separately prove missing/rolled-back ledger refusal.
import { adminTokenDigest, base64url } from '../../supabase/functions/_shared/admin-oauth-auth.ts';
import * as policy from '../../supabase/functions/_shared/protocol.js';
const encode = value => base64url(new TextEncoder().encode(JSON.stringify(value)));
export async function oauthFixture(db, grantId, signing, kid) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const jkt = base64url(await adminTokenDigest(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y })));
  const [account] = await db`SELECT projection, stream_id, seq FROM swarm.admin_accounts
    WHERE owner_user_id=(SELECT owner_user_id FROM swarm.admin_grants WHERE grant_id=${grantId}::uuid)`;
  const g = account.projection.grants[grantId], provider = `edge-family-${crypto.randomUUID()}`;
  await db.begin(async tx => {
    await tx`INSERT INTO commonswarm_oauth.admin_verified_clients(client_id,verification_version,application_type,registration_source,
      publisher_identity,publisher_contact,metadata_digest,redirect_uris,scope_ceiling,full_account_eligible,pkce_s256_tested,dpop_tested,redirect_tested,
      origin_control_verified,review_evidence_ref,reviewed_by,active)
      VALUES(${g.client_id},1,'web','static','Test publisher','contact@example.test',${'a'.repeat(64)},${['https://client.example/callback']},
        ${g.scope_names},true,true,true,true,true,'edge-test','edge-test',true) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event)
      VALUES(${g.owner_user_id}::uuid,${Number(account.seq)+1},${crypto.randomUUID()}::uuid,${`fixture-approve-${crypto.randomUUID()}`},
        ${tx.json({ type:'AdminClientApproved', owner_user_id:g.owner_user_id, actor_user:g.owner_user_id, actor_agent_principal:null,
          payload:{client_id:g.client_id,verification_version:1}, command_id:'fixture-approval' })})`;
    const [event] = await tx`SELECT event_id, command_id FROM swarm.admin_events WHERE owner_user_id=${g.owner_user_id}::uuid AND seq=${Number(account.seq)+1}`;
    // Invoker approval guard requires a matching immutable human event.
    await tx`SELECT set_config('role','swarm_command',true)`;
    await tx`INSERT INTO commonswarm_oauth.admin_client_owner_approvals(owner_user_id,client_id,verification_version,approved_at,approval_event_id,approval_command_id)
      VALUES(${g.owner_user_id}::uuid,${g.client_id},1,statement_timestamp(),${event.event_id}::uuid,${event.command_id}) ON CONFLICT DO NOTHING`;
    await tx`UPDATE swarm.admin_accounts SET seq=${Number(account.seq)+1} WHERE owner_user_id=${g.owner_user_id}::uuid`;
    await tx`SELECT set_config('role','commonswarm_oauth_runtime',true)`;
    await tx`INSERT INTO commonswarm_oauth.provider_grant_resources(provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,admin_grant_id)
      VALUES(${provider},${g.resource},'delegated_admin',${g.owner_user_id}::uuid,${g.client_id},${g.connection_id}::uuid,${g.grant_id}::uuid)`;
    await tx`INSERT INTO commonswarm_oauth.admin_grant_bindings(provider_grant_id,admin_grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,
      registry_version,capabilities,scope_names,availability_digest,manifest_digest,verification_version,jkt,consented_at,expires_at,refresh_deadline,state)
      VALUES(${provider},${g.grant_id}::uuid,${g.owner_user_id}::uuid,${g.admin_identity_id}::uuid,${g.connection_id}::uuid,${g.client_id},${g.resource},
        ${g.registry_version},${g.capability_names},${g.scope_names},${g.availability_digest},${g.manifest_digest},1,${jkt},${new Date(g.created_at)},
        ${new Date(g.expires_at)},${new Date(g.refresh_deadline)},'active')`;
  });
  // JWT integer issue time must not precede millisecond consent activation.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const now = Math.floor(Date.now()/1000);
  const claims = { iss:'https://mcp.commonswarm.com',aud:g.resource,sub:g.owner_user_id,grant_class:'delegated_admin',grant_id:provider,
    admin_grant_id:g.grant_id,admin_identity_id:g.admin_identity_id,connection_id:g.connection_id,client_id:g.client_id,scope:g.scope_names.join(' '),
    registry_version:g.registry_version,manifest_digest:g.manifest_digest,cnf:{jkt},jti:crypto.randomUUID(),iat:now,exp:now+300 };
  const sign = async (header, body, key) => {
    const bytes = `${encode(header)}.${encode(body)}`;
    return `${bytes}.${base64url(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(bytes))))}`;
  };
  const access = await sign({typ:'at+jwt',alg:'ES256',kid},claims,signing.privateKey);
  const record = async (access, claims, generation=0, rowScopes=g.scope_names, rollback=false) => {
    const marker = new Error('fixture_issuance_rollback');
    await db.begin(async tx => {
    const [head] = await tx`SELECT seq,stream_id FROM swarm.admin_accounts WHERE owner_user_id=${g.owner_user_id}::uuid FOR UPDATE`;
    const eventId=crypto.randomUUID(), audit=crypto.randomUUID();
    await tx`INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event)
      VALUES(${g.owner_user_id}::uuid,${Number(head.seq)+1},${eventId}::uuid,${`edge-fixture-${claims.jti}`},
        ${tx.json({type:generation===0?'AdminCredentialIssued':'AdminCredentialRotated',owner_user_id:g.owner_user_id,grant_id:g.grant_id,payload:{provider_grant_id:provider,generation,version:2}})})`;
    await tx`UPDATE swarm.admin_accounts SET seq=${Number(head.seq)+1} WHERE owner_user_id=${g.owner_user_id}::uuid`;
    await tx`SELECT set_config('role','commonswarm_oauth_runtime',true)`;
    await tx`UPDATE commonswarm_oauth.admin_grant_bindings SET generation=${generation}, initial_issued_at=coalesce(initial_issued_at,${new Date(claims.iat*1000)}) WHERE provider_grant_id=${provider}`;
    await tx`INSERT INTO commonswarm_oauth.admin_oauth_audit(audit_id,owner_user_id,admin_identity_id,admin_grant_id,connection_id,
      provider_grant_id,manifest_digest,event_kind,outcome,related_event_ids)
      VALUES(${audit}::uuid,${g.owner_user_id}::uuid,${g.admin_identity_id}::uuid,${g.grant_id}::uuid,${g.connection_id}::uuid,${provider},${g.manifest_digest},${generation===0?'issued':'rotated'},'committed',${[eventId]}::uuid[])`;
    await tx`INSERT INTO commonswarm_oauth.admin_access_issuances(access_jti,access_token_digest,provider_grant_id,admin_grant_id,generation,client_id,
      resource,jkt,manifest_digest,scope_names,issuer,kid,issued_at,expires_at,event_id,audit_id)
      VALUES(${claims.jti},${await adminTokenDigest(access)},${provider},${g.grant_id}::uuid,${generation},${g.client_id},${g.resource},${jkt},${g.manifest_digest},${rowScopes},
        ${claims.iss},${kid},${new Date(claims.iat*1000)},${new Date(claims.exp*1000)},${eventId}::uuid,${audit}::uuid)`;
      if (rollback) throw marker;
    }).catch(error=>{if(error!==marker)throw error;});
  };
  await record(access,claims);
  let nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.begin(async tx => {
    await tx`SELECT set_config('role','commonswarm_oauth_runtime',true)`;
    await tx`SELECT commonswarm_oauth.register_dpop_nonce(${await adminTokenDigest(nonce)},${jkt},'admin_resource')`;
  });
  let nonceAt=Date.now();
  const request = async (body, surface='admin_command', overrides={}, presented=access) => {
    if (Date.now()-nonceAt>45_000) {
      nonce=base64url(crypto.getRandomValues(new Uint8Array(32)));
      await db.begin(async tx=>{await tx`SELECT set_config('role','commonswarm_oauth_runtime',true)`;await tx`SELECT commonswarm_oauth.register_dpop_nonce(${await adminTokenDigest(nonce)},${jkt},'admin_resource')`;});
      nonceAt=Date.now();
    }
    return new Request(surface==='admin_command'?'http://127.0.0.1/functions/v1/command':'http://127.0.0.1/admin',{
    method:'POST',headers:{Authorization:`DPoP ${presented}`,DPoP:await sign({typ:'dpop+jwt',alg:'ES256',jwk},
      {htm:'POST',htu:surface==='admin_command'?'https://api.commonswarm.com/functions/v1/command':g.resource,
        iat:Math.floor(Date.now()/1000),jti:crypto.randomUUID(),ath:base64url(await adminTokenDigest(presented)),nonce,...overrides},keys.privateKey)},body:JSON.stringify(body)});
  };
  const admission=async () => {
    const {admitAdminRequest}=await import('../../supabase/functions/command/admin-admission.ts');
    return admitAdminRequest(await request({}),'admin_command');
  };
  const issue = async (generation, changes={}, rowScopes=g.scope_names, rollback=false) => {
    const next={...claims,jti:crypto.randomUUID(),...changes};
    const nextAccess=await sign({typ:'at+jwt',alg:'ES256',kid},next,signing.privateKey);
    await record(nextAccess,next,generation,rowScopes,rollback);
    return nextAccess;
  };
  return { access, claims, request, admission, g, provider, get nonce(){return nonce;}, sign, keys, jwk, issue };
}
