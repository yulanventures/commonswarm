/** CI-only PostgreSQL proofs. Uses real integrated DDL in a rollback transaction. */
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { catalog, dbAssert, fixture, issuance, openIssuanceForTest, refuses, repoSql, runSql } from '../support/admin-schema-db.js';

const version='20261003000005';
const page=(resource:string, before='NULL', workspace='NULL', limit=1)=>
  `swarm_read.admin_recovery_page('${resource}',${workspace},${limit},${before})`;
const claims=(owner:string)=>`SELECT set_config('request.jwt.claims','{"sub":"${owner}"}',true);`;
const action=(f:ReturnType<typeof fixture>,seq:number)=>`
INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event) VALUES('${f.owner}',${seq},'${randomUUID()}','read-proof-${seq}',
  jsonb_build_object('stream_kind','account','owner_user_id','${f.owner}','seq',${seq},'type','AdminActionRecorded',
    'grant_id','${f.grant}','admin_identity_id','${f.identity}','actor_user',NULL,'occurred_at_server',1780444800000,
    'payload',jsonb_build_object('action','admin_read_metadata','target_kind','admin_grant','target_id','${f.grant}',
      'workspace_id',NULL,'outcome','accepted','reason_code',NULL,'next_action','View access','recovery_kind','none',
      'related_event_ids',jsonb_build_array(),'private_payload','PRIVATE_RECOVERY_TEST_MARKER')));
`;

test('admin-recovery owner isolation, foreign refusal and secret-free approval/consent/family/history columns',()=>{
  const f=fixture(),foreign=fixture();
  runSql(`${catalog(version)}
${f.sql}${foreign.sql}
INSERT INTO commonswarm_oauth.admin_verified_clients SELECT (jsonb_populate_record(NULL::commonswarm_oauth.admin_verified_clients,to_jsonb(v)||jsonb_build_object(
  'client_id','https://unconnected.example/client','publisher_contact','PRIVATE_RECOVERY_TEST_MARKER','review_evidence_ref','PRIVATE_RECOVERY_TEST_MARKER'))).*
FROM commonswarm_oauth.admin_verified_clients v WHERE client_id='${f.client}';
${action(f,2)}${action(foreign,2)}
${claims(f.owner)} SET LOCAL ROLE swarm_read;
${dbAssert(`SELECT (${page('admin_grants')}->'grants'->0->>'owner_user_id')='${f.owner}'
  AND (${page('admin_grants')}->'grants'->0->'client'->'approval'->>'owner_user_id')='${f.owner}'
  AND (${page('admin_grants')}->'grants'->0->'family'->>'provider_grant_id')='${f.provider}'
  AND (${page('admin_grants')}->'grants'->0->>'issuance_status')='unknown'`, 'owner snapshot and uncertain issuance control')}
${dbAssert(`SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(${page('admin_clients','NULL','NULL',100)}->'clients') c
 WHERE c->>'client_id'='https://unconnected.example/client' AND c->'approval'='null'::jsonb AND (c->>'reapproval_required')::boolean)`, 'verified client with no grant is listed')}
${dbAssert(`SELECT (${page('admin_history')}->'actions'->0->>'owner_user_id')='${f.owner}'
  AND (${page('admin_history')}->'actions'->0->>'provider_grant_id')='${f.provider}'`, 'owner history provenance')}
${dbAssert(`SELECT NOT (${page('admin_grants')})::text LIKE '%${foreign.provider}%' AND NOT (${page('admin_history')})::text LIKE '%${foreign.grant}%'`, 'foreign families and grants excluded')}
${dbAssert(`SELECT ${page('admin_grants','NULL',`'${randomUUID()}'::uuid`)}='{"error":"forbidden"}'::jsonb`, 'foreign workspace refused')}
${dbAssert(`SELECT ${page('admin_clients','NULL',`'${randomUUID()}'::uuid`)}='{"error":"forbidden"}'::jsonb`, 'clients cannot select workspace owner scope')}
${['admin_grants','admin_history','admin_clients','admin_workers','admin_coverage'].map(resource=>dbAssert(`SELECT
  (${page(resource,'NULL','NULL',100)})::text !~ '"(access_hash|refresh_hash|access_jti|access_token_digest|jkt|session_binding|csrf_binding|pkce_challenge|publisher_contact|review_evidence_ref|private_payload|gate)"[[:space:]]*:'
  AND (${page(resource,'NULL','NULL',100)})::text NOT LIKE '%PRIVATE_RECOVERY_TEST_MARKER%'`, `no credential fields in ${resource}`)).join('\n')}
RESET ROLE; ${claims(f.foreign)} SET LOCAL ROLE swarm_read;
${dbAssert(`SELECT jsonb_array_length(${page('admin_grants')}->'grants')=0 AND jsonb_array_length(${page('admin_history')}->'actions')=0`, 'foreign account cannot read owner grant or history')}
${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${page('admin_clients','NULL','NULL',100)}->'clients') c WHERE c->'approval'<>'null'::jsonb)`, 'foreign approval provenance absent with globally verified clients control')}
RESET ROLE; SELECT set_config('request.jwt.claims','{}',true); SET LOCAL ROLE swarm_read;
${dbAssert(`SELECT ${page('admin_grants')}='{"error":"forbidden"}'::jsonb`, 'anonymous owner refused')}
${refuses(`SELECT * FROM commonswarm_oauth.admin_access_issuances`,'42501')}
RESET ROLE;
`);
});

test('admin-recovery paginates every collection with tied millisecond timestamps and stable UUID cursors',()=>{
  const tie=(f:ReturnType<typeof fixture>)=>f.sql.replace('review_evidence_ref,reviewed_by,active)', 'review_evidence_ref,reviewed_by,active,reviewed_at)')
    .replace("'schema-test',true);", "'schema-test',true,date_trunc('milliseconds',transaction_timestamp())+interval '0.0001 seconds');");
  const f=fixture(),other=fixture(),third=fixture(),workspace=randomUUID();
  runSql(`${tie(f)}${tie(other)}${tie(third)}
INSERT INTO swarm.admin_grants SELECT (jsonb_populate_record(NULL::swarm.admin_grants,to_jsonb(g)||jsonb_build_object(
  'grant_id','${randomUUID()}','connection_id','${randomUUID()}','consent_receipt_id','${randomUUID()}'))).* FROM swarm.admin_grants g WHERE grant_id='${f.grant}';
INSERT INTO swarm.admin_grants SELECT (jsonb_populate_record(NULL::swarm.admin_grants,to_jsonb(g)||jsonb_build_object(
  'grant_id','${randomUUID()}','connection_id','${randomUUID()}','consent_receipt_id','${randomUUID()}'))).* FROM swarm.admin_grants g WHERE grant_id='${f.grant}';
${action(f,2)}${action(f,3)}${action(f,4)}
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${workspace}','Dependency projection','${f.owner}');
${[1,2,3].map(i=>`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,parent_admin_grant_id)
VALUES('${randomUUID()}','${workspace}','${f.owner}','Projection worker ${i}','${f.grant}');`).join('\n')}
${claims(f.owner)} SET LOCAL ROLE swarm_read;
DO $pagination$
DECLARE resource text; collection text; expected integer; result jsonb; cursor text; seen jsonb; total integer;
BEGIN
  FOR resource,collection,expected IN SELECT * FROM (VALUES
    ('admin_grants','grants',3),('admin_history','actions',3),('admin_clients','clients',3),('admin_workers','workers',3),('admin_coverage','coverage',0)) cases LOOP
    cursor:=NULL; seen:='[]'; total:=0;
    LOOP
      result:=swarm_read.admin_recovery_page(resource,NULL,1,cursor);
      IF result ? 'error' OR jsonb_array_length(result->collection)>1 THEN RAISE EXCEPTION 'invalid paginated projection'; END IF;
      IF jsonb_array_length(result->collection)=1 THEN
        IF seen @> (result->collection) THEN RAISE EXCEPTION 'duplicate page item'; END IF;
        seen:=seen||(result->collection);total:=total+1;
      END IF;
      cursor:=result->>'next_before';
      EXIT WHEN cursor IS NULL;
      IF total>expected THEN RAISE EXCEPTION 'cursor did not terminate'; END IF;
    END LOOP;
    IF total<>expected THEN RAISE EXCEPTION 'pagination lost rows'; END IF;
  END LOOP;
END $pagination$;
RESET ROLE;
`);
});

test('admin-recovery committed issuance coverage, dependencies and verification change require fresh owner approval',()=>{
  const f=fixture(),issued=issuance(f),workspace=randomUUID(),spaces=[workspace,randomUUID(),randomUUID()];
  runSql(`${openIssuanceForTest}${f.sql}${issued.sql}
SET LOCAL ROLE commonswarm_oauth_runtime;
-- Request kinds require the authenticated owner-definer helper: direct AS
-- INSERT is intentionally refused by the security-invoker audit trigger.
${dbAssert(`SELECT commonswarm_oauth.record_admin_request_audit('${issued.jti}',decode('${issued.tokenDigest}','hex'),
  'read','${randomUUID()}','committed',NULL,NULL,NULL,'{}'::uuid[]) IS NOT NULL`, 'authenticated read audit committed')}
RESET ROLE;
${spaces.map(w=>`INSERT INTO swarm.workspaces(workspace_id,name,created_by,created_at) VALUES('${w}','Selected coverage','${f.owner}',date_trunc('milliseconds',transaction_timestamp())+interval '0.0001 seconds');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${w}','${f.owner}','owner');`).join('\n')}
UPDATE swarm.admin_grants SET workspace_ids=ARRAY[${spaces.map(w=>`'${w}'`).join(',')}]::uuid[] WHERE grant_id='${f.grant}';
INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,parent_admin_grant_id)
VALUES('${randomUUID()}','${workspace}','${f.owner}','Live dependency','${f.grant}');
${claims(f.owner)} SET LOCAL ROLE swarm_read;
${dbAssert(`SELECT (${page('admin_grants')}->'grants'->0->>'issuance_status')='committed' AND (${page('admin_grants')}->'grants'->0->>'coverage_count')='3' AND (${page('admin_grants')}->'grants'->0->>'last_use_at') IS NOT NULL`, 'committed usable family positive')}
${dbAssert(`SELECT jsonb_array_length(${page('admin_coverage')}->'coverage')=1 AND (${page('admin_workers')}->'workers'->0->>'state')='active'`, 'effective coverage and worker dependency positive')}
DO $coverage_page$ DECLARE cursor text; result jsonb; seen uuid[]:='{}'; space uuid;
BEGIN
 LOOP
  result:=swarm_read.admin_recovery_page('admin_coverage',NULL,1,cursor);
  IF jsonb_array_length(result->'coverage')<>1 THEN RAISE EXCEPTION 'coverage page lost row'; END IF;
  space:=(result->'coverage'->0->>'workspace_id')::uuid;
  IF space=ANY(seen) THEN RAISE EXCEPTION 'coverage duplicate'; END IF;
  seen:=array_append(seen,space);cursor:=result->>'next_before';EXIT WHEN cursor IS NULL;
  IF cardinality(seen)>3 THEN RAISE EXCEPTION 'coverage cursor did not terminate'; END IF;
 END LOOP;
 IF cardinality(seen)<>3 THEN RAISE EXCEPTION 'coverage pagination lost row'; END IF;
END $coverage_page$;
RESET ROLE; SET LOCAL ROLE commonswarm_admin_release;
UPDATE commonswarm_oauth.admin_verified_clients SET active=false,withdrawn_at=statement_timestamp(),withdrawal_reason='verification_changed' WHERE client_id='${f.client}';
INSERT INTO commonswarm_oauth.admin_verified_clients SELECT (jsonb_populate_record(NULL::commonswarm_oauth.admin_verified_clients,to_jsonb(v)||jsonb_build_object(
  'verification_version',2,'active',true,'withdrawn_at',NULL,'withdrawal_reason',NULL,'metadata_digest',repeat('b',64)))).*
FROM commonswarm_oauth.admin_verified_clients v WHERE client_id='${f.client}' AND verification_version=1;
RESET ROLE; SET LOCAL ROLE swarm_read;
${dbAssert(`SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(${page('admin_clients','NULL','NULL',100)}->'clients') c WHERE c->>'verification_version'='2' AND (c->>'reapproval_required')::boolean AND c->'approval'='null'::jsonb)`, 'metadata change is not automatic approval')}
${dbAssert(`SELECT jsonb_array_length(${page('admin_coverage')}->'coverage')=0 AND (${page('admin_workers')}->'workers'->0->>'state')='stopped'`, 'withdrawn family loses effective coverage and dependencies')}
RESET ROLE;
`);
});

test('admin-recovery catalog rejects ACL drift and reserve retains all rows while restoring the previous contract',()=>{
  const f=fixture();
  runSql(`${catalog(version)}${f.sql}
SAVEPOINT intact_projection;
GRANT EXECUTE ON FUNCTION swarm_read.admin_recovery_page(text,uuid,integer,text) TO authenticated;
${catalog(version,false,false)}
ROLLBACK TO SAVEPOINT intact_projection;
${catalog(version)}
${repoSql(`supabase/admin-delegation-reserve/${version}-rollback.sql`)}
${catalog(version,true)}
${dbAssert(`SELECT count(*)=1 FROM swarm.admin_grants WHERE grant_id='${f.grant}'`, 'reserve retains historical grant')}
${repoSql('supabase/migrations/20261003000005_admin_recovery_projection.sql')}
${catalog(version)}
${claims(f.owner)} SET LOCAL ROLE swarm_read;
${dbAssert(`SELECT (${page('admin_grants')}->'grants'->0->>'grant_id')='${f.grant}'`, 'reapplied projection reads retained grant')}
RESET ROLE;
`);
});
