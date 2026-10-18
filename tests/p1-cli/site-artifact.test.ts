import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, cp, chmod, symlink, readlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '../..');
const validator = join(repo, 'deploy/site/validate-site-env.mjs');
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const root = await mkdtemp(join(tmpdir(), 'cswarm-artifact-test-'));
after(() => rm(root, { recursive: true, force: true }));
const token = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.fixture`;
const config = { PUBLIC_SUPABASE_URL: 'https://api.commonswarm.com', PUBLIC_SUPABASE_ANON_KEY: token('anon') };

test('public config requires exact production URL, anon role and explicit H0 without shell evaluation', async () => {
  const input = join(root, 'public.json');
  const cases = [
    { value: config, h0: '0', valid: true }, { value: config, h0: '1', valid: true },
    { value: config, h0: '', valid: false },
    { value: { ...config, PUBLIC_H0_LINK_JOIN: '0' }, h0: '1', valid: false },
    { value: { ...config, PUBLIC_SUPABASE_URL: 'https://other.invalid' }, h0: '1', valid: false },
    { value: { ...config, PUBLIC_SUPABASE_ANON_KEY: token('service_role') }, h0: '1', valid: false },
    { value: { ...config, PUBLIC_SUPABASE_ANON_KEY: token('authenticated') }, h0: '1', valid: false },
    { value: { ...config, PRIVATE_KEY: '$(touch should-never-exist)' }, h0: '1', valid: false },
  ];
  for (const [i, row] of cases.entries()) {
    await writeFile(input, JSON.stringify(row.value));
    const result = exec(process.execPath, [validator, 'config', input, row.h0, join(root, `config-${i}.json`)]);
    if (row.valid) { await result; assert.equal(JSON.parse(await readFile(join(root, `config-${i}.json`), 'utf8')).PUBLIC_H0_LINK_JOIN, row.h0); }
    else await assert.rejects(result);
  }
});

// The lead supplies an actual build-artifact.sh output from the reviewed source.
// No synthetic receipt can stand in for that build, and the mini never compiles it.
const artifact = process.env.COMMONSWARM_SITE_TEST_ARTIFACT;
const linuxProof = process.platform === 'linux' && !!artifact && process.getuid?.() === 0;
async function prepare(name: string, mutate?: (dir: string) => Promise<void>) {
  const dir = join(root, name); await cp(artifact!, dir, { recursive: true });
  await rm(join(dir, 'packet'), { recursive: true, force: true });
  for (const file of ['BUILD.json', 'site.tar']) await chmod(join(dir, file), 0o600);
  if (mutate) await mutate(dir);
  const pin = hash(await readFile(join(dir, 'BUILD.json')));
  await exec(process.execPath, [validator, 'prepare', dir, pin, `/root/cswarm-site-${name}`]);
  return join(dir, 'packet');
}

test('real builder provenance and unsafe tar members are rejected before packet creation', { skip: !linuxProof }, async () => {
  await prepare('provenance-control');
  for (const field of ['source', 'config', 'lock', 'builder', 'validator', 'template', 'image', 'revision', 'h0', 'artifact']) {
    await assert.rejects(prepare(`bad-${field}`, async dir => {
      const p = join(dir, 'BUILD.json'), value = JSON.parse(await readFile(p, 'utf8')); value[field] = 'bad'; await writeFile(p, JSON.stringify(value));
    }));
  }
  for (const kind of ['symlink', 'hardlink', 'traversal', 'corrupt']) {
    await assert.rejects(prepare(`tar-${kind}`, async dir => {
      const tree = join(dir, 'malicious'); await mkdir(tree);
      if (kind === 'symlink') await symlink('/etc/passwd', join(tree, 'escape'));
      else { await writeFile(join(tree, 'file'), 'unsafe'); if (kind === 'hardlink') await exec('ln', [join(tree, 'file'), join(tree, 'linked')]); }
      const args = ['--format=ustar', '-cf', join(dir, 'site.tar'), '-C', tree];
      if (kind === 'traversal') args.push('--transform=s|file|../escape|', 'file'); else args.push('.');
      await exec('tar', args);
      if (kind === 'corrupt') { const bytes = await readFile(join(dir, 'site.tar')); bytes[0] ^= 1; await writeFile(join(dir, 'site.tar'), bytes); }
    }), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, kind === 'corrupt' ? /tar checksum/ : kind === 'traversal' ? /unsafe tar member/ : /tar links\/special members refused/); return true;
    });
  }
});

test('real H0=1 artifact must contain emitted join controls; explicit H0=0 must omit them', { skip: !linuxProof }, async () => {
  const original = JSON.parse(await readFile(join(artifact!, 'BUILD.json'), 'utf8'));
  assert.equal(original.h0, '1', 'supply the approved H0=1 real build for this regression');
  await prepare('h0-control');
  for (const variant of ['data-h0-link-join', 'mint-join', 'revoke-join', 'all', 'disabled-present', 'disabled-absent']) {
    const run = prepare(`h0-${variant}`, async dir => {
      const tree = join(dir, 'html'); await mkdir(tree);
      await exec('tar', ['-xf', join(dir, 'site.tar'), '-C', tree]);
      const app = join(tree, 'app/index.html'); let html = await readFile(app, 'utf8');
      if (['data-h0-link-join', 'all', 'disabled-absent'].includes(variant)) {
        const before = html; html = html.replace(/\sdata-h0-link-join(?:="[^"]*")?/g, ''); assert.notEqual(html, before);
      }
      for (const action of ['mint-join', 'revoke-join']) if ([action, 'all', 'disabled-absent'].includes(variant)) {
        const before = html;
        html = html.replace(new RegExp(`<button\\b[^>]*\\bdata-action="${action}"[^>]*>[\\s\\S]*?</button>`, 'g'), '');
        assert.notEqual(html, before, `real build must have the ${action} button to remove`);
      }
      await writeFile(app, html);
      await exec('tar', ['--format=ustar', '-cf', join(dir, 'site.tar'), '-C', tree, '.']);
      const receipt = JSON.parse(await readFile(join(dir, 'BUILD.json'), 'utf8'));
      if (variant.startsWith('disabled-')) {
        const pubPath = join(dir, 'public.json'), pub = JSON.parse(await readFile(pubPath, 'utf8'));
        pub.PUBLIC_H0_LINK_JOIN = '0'; await chmod(pubPath, 0o600); await writeFile(pubPath, JSON.stringify(pub));
        receipt.config = hash(await readFile(pubPath)); receipt.h0 = '0';
      }
      // Rebind only changed bytes: a generic hash mismatch must not mask the output guard.
      receipt.artifact = hash(await readFile(join(dir, 'site.tar'))); receipt.html['app/index.html'] = hash(html);
      await writeFile(join(dir, 'BUILD.json'), JSON.stringify(receipt));
    });
    if (variant === 'disabled-absent') await run;
    else await assert.rejects(run, (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /Refusing site artifact: built H0=[01] controls mismatch:/); return true;
    });
  }
});

test('rendered Linux release swaps real artifact bytes, retains reserves, and rolls back status/body failures and drift', { skip: !linuxProof }, async () => {
  const curl = (await exec('which', ['curl'])).stdout.trim();
  for (const variant of ['success', 'root-status', 'app-status', 'root-body', 'app-body', 'curl-failure', 'asset-drift', 'current-drift', 'artifact-pin', 'build-pin']) {
    const packet = await prepare(`run-${variant}`), site = join(root, `site-${variant}`), old = join(site, 'releases/old');
    await mkdir(join(old, '_astro'), { recursive: true }); await writeFile(join(old, '_astro/retained.js'), 'old asset');
    await symlink('releases/old', join(site, 'current')); await mkdir(join(site, 'releases/reserve'));
    const server = createServer(async (req, res) => {
      const route = req.url === '/app' ? 'app/index.html' : 'index.html';
      if (variant === `${req.url === '/app' ? 'app' : 'root'}-status`) { res.writeHead(503); res.end('unavailable'); return; }
      if (variant === `${req.url === '/app' ? 'app' : 'root'}-body`) { res.end('wrong HTML'); return; }
      try { res.end(await readFile(join(site, 'current', route))); } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address === 'object');
    const bin = join(root, `bin-${variant}`); await mkdir(bin);
    await writeFile(join(bin, 'hostname'), '#!/bin/sh\necho yulan-vps-1\n');
    await writeFile(join(bin, 'curl'), `#!/bin/bash\nargs=(); for a in "$@"; do case "$a" in https://commonswarm.com*) args+=("http://127.0.0.1:${address.port}\${a#https://commonswarm.com}");; *) args+=("$a");; esac; done\n${variant === 'curl-failure' ? 'exit 7' : `exec ${curl} "\${args[@]}"`}\n`);
    // Simulate a concurrent pointer edit during permissions normalization.
    await writeFile(join(bin, 'chmod'), `#!/bin/sh\n/bin/chmod "$@"\n${variant === 'current-drift' ? `ln -sfn releases/reserve '${site}/current'` : ':'}\n`);
    for (const name of ['hostname', 'curl', 'chmod']) await chmod(join(bin, name), 0o755);
    let script = await readFile(join(packet, 'SITE-DIRECT.sh'), 'utf8');
    script = script.replace(/B=\/root\/cswarm-site-[^;]+/, `B=${packet}`).replace('S=/srv/commonswarm/site', `S=${site}`);
    await writeFile(join(packet, 'run.sh'), script);
    if (variant === 'artifact-pin') await writeFile(join(packet, 'site.tar'), 'damaged');
    if (variant === 'build-pin') await writeFile(join(packet, 'BUILD.json'), '{}');
    if (variant === 'asset-drift') {
      const fresh = join(root, 'fresh-assets'); await mkdir(fresh); await exec('tar', ['-xf', join(packet, 'site.tar'), '-C', fresh]);
      const assets = await readdir(join(fresh, '_astro'), { recursive: true }); const asset = assets.find(n => /\.(?:js|css)$/.test(n)); assert.ok(asset);
      await mkdir(join(old, '_astro', asset, '..'), { recursive: true }); await writeFile(join(old, '_astro', asset), 'different bytes under same asset name');
    }
    try {
      const run = () => exec('bash', [join(packet, 'run.sh'), 'deploy'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      if (variant === 'success') {
        assert.match((await run()).stdout, /PASS deploy/);
        const current = await readlink(join(site, 'current')); assert.notEqual(current, 'releases/old');
        assert.equal(await readFile(join(site, 'current/_astro/retained.js'), 'utf8'), 'old asset');
        await exec('bash', [join(packet, 'run.sh'), 'rollback'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
        assert.equal(await readlink(join(site, 'current')), 'releases/old');
        await assert.rejects(exec('bash', [join(packet, 'run.sh'), 'rollback'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }));
      } else {
        await assert.rejects(run(), (error: unknown) => {
          const output = (error as { stdout: string }).stdout;
          if (['root-status', 'app-status'].includes(variant)) assert.match(output, /assertion=httpstatus/);
          if (['root-body', 'app-body'].includes(variant)) assert.match(output, /assertion=httphash/);
          if (['root-status', 'app-status', 'root-body', 'app-body', 'curl-failure'].includes(variant)) assert.match(output, /PASS rollback/);
          if (variant === 'asset-drift') assert.match(output, /assertion=old-asset-identical/);
          if (variant === 'current-drift') assert.match(output, /assertion=exact-old-link/);
          if (variant === 'artifact-pin') assert.match(output, /assertion=artifactSHA/);
          if (variant === 'build-pin') assert.match(output, /assertion=buildSHA/);
          return true;
        });
        assert.equal(await readlink(join(site, 'current')), variant === 'current-drift' ? 'releases/reserve' : 'releases/old');
      }
      assert.ok((await readdir(join(site, 'releases'))).includes('reserve'));
      assert.equal(await readFile(join(old, '_astro/retained.js'), 'utf8'), 'old asset');
    } finally { await new Promise<void>(r => server.close(() => r())); }
  }
});

test('production script requires only static file tools and never compiles or prunes', async () => {
  const source = await readFile(join(repo, 'deploy/site/finalize-release.sh'), 'utf8');
  assert.doesNotMatch(source, /\b(?:npm|node|docker|rsync|rm)\b/);
  assert.ok(source.trim().split('\n').length >= 24 && source.trim().split('\n').length <= 40);
});
