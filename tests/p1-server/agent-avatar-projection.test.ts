/** CI-only. The real edge projection module, not a copied SQL projection. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('avatar core decisions persist through edge projection and reload with actor provenance', {timeout:120_000}, () => {
  const local = JSON.parse(execFileSync('supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));
  const target = new URL(local.DB_URL);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));
  const dir = mkdtempSync(join(tmpdir(),'avatar-projection-'));
  try {
    writeFileSync(join(dir,'db.env'),`AVATAR_TEST_DB_URL=${target.toString()}\n`,{mode:0o600});
    execFileSync('deno',['run','--config','supabase/functions/command/deno.json','--allow-net','--allow-env','--allow-read',
      `--env-file=${join(dir,'db.env')}`,'tests/support/agent-avatar-projection.mjs'], {stdio:['ignore','pipe','pipe']});
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
