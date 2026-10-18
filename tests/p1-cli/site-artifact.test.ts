import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, cp, chmod, symlink, readlink, readdir, rm, stat } from 'node:fs/promises';
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

// Default: synthetic semantic fixture for current tooling, never build evidence.
// An explicit real builder output keeps the actual-build integration lane available.
const suppliedArtifact = process.env.COMMONSWARM_SITE_TEST_ARTIFACT;
const lane = suppliedArtifact ? 'REAL builder artifact' : 'SYNTHETIC CI artifact';
const linuxProof = process.platform === 'linux' && process.getuid?.() === 0;
function tarMember(name: string, data = Buffer.alloc(0), type = '0', link = '') {
  const header = Buffer.alloc(512);
  const field = (value: string, offset: number, size: number) => header.write(value, offset, size, 'ascii');
  field(name, 0, 100); field('0000644\0', 100, 8); field('0000000\0', 108, 8); field('0000000\0', 116, 8);
  field(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); field('00000000000\0', 136, 12);
  header.fill(32, 148, 156); field(type, 156, 1); field(link, 157, 100); field('ustar\0', 257, 6); field('00', 263, 2);
  field(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const tarEnd = Buffer.alloc(1024);
let fixture: Promise<string> | undefined;
async function artifactDir() {
  if (suppliedArtifact) return suppliedArtifact;
  return fixture ??= (async () => {
    const dir = join(root, 'synthetic'); await mkdir(dir);
    const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    // Preserve Git's commit-id header, but deliberately use current working bytes:
    // this source archive proves fixture semantics, never a real committed build.
    const archive = (await exec('git', ['archive', '--format=tar', revision, 'package.json'], { cwd: repo, encoding: 'buffer' })).stdout;
    assert.equal(archive.subarray(156, 157).toString(), 'g');
    const paths = ['site/package-lock.json', 'deploy/site/build-artifact.sh', 'deploy/site/validate-site-env.mjs', 'deploy/site/finalize-release.sh'];
    const source = await Promise.all(paths.map(async path => tarMember(path, await readFile(join(repo, path)))));
    await writeFile(join(dir, 'source.tar'), Buffer.concat([archive.subarray(0, 1024), ...source, tarEnd]));
    await writeFile(join(dir, 'public.json'), JSON.stringify({ ...config, PUBLIC_H0_LINK_JOIN: '1' }));
    const meta = `<meta name="commonswarm:url" content="${config.PUBLIC_SUPABASE_URL}"><meta name="commonswarm:anon-key" content="${config.PUBLIC_SUPABASE_ANON_KEY}">`;
    const controls = '<section data-h0-link-join><button data-action="mint-join">Join</button><button data-action="revoke-join">Revoke</button></section>';
    await writeFile(join(dir, 'site.tar'), Buffer.concat([
      tarMember('index.html', Buffer.from(meta)), tarMember('app/index.html', Buffer.from(meta + controls)),
      tarMember('start/index.html', Buffer.from(meta)), tarMember('_astro/new.js', Buffer.from('fixture asset')), tarEnd,
    ]));
    await cp(join(repo, 'deploy/site/finalize-release.sh'), join(dir, 'finalize-release.sh'));
    const image = 'node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c';
    // The production receipt owner computes pins; the fixture never supplies them.
    await exec(process.execPath, [validator, 'receipt', dir, revision, image]);
    return dir;
  })();
}
async function prepare(name: string, mutate?: (dir: string) => Promise<void>) {
  const dir = join(root, name); await cp(await artifactDir(), dir, { recursive: true });
  await rm(join(dir, 'packet'), { recursive: true, force: true });
  for (const file of ['BUILD.json', 'site.tar']) await chmod(join(dir, file), 0o600);
  if (mutate) await mutate(dir);
  const pin = hash(await readFile(join(dir, 'BUILD.json')));
  await exec(process.execPath, [validator, 'prepare', dir, pin, `/root/cswarm-site-${name}`]);
  return join(dir, 'packet');
}

test(`${lane}: provenance and unsafe tar members are rejected before packet creation`, async () => {
  await prepare('provenance-control');
  for (const field of ['source', 'config', 'lock', 'builder', 'validator', 'template', 'image', 'revision', 'h0', 'artifact']) {
    await assert.rejects(prepare(`bad-${field}`, async dir => {
      const p = join(dir, 'BUILD.json'), value = JSON.parse(await readFile(p, 'utf8')); value[field] = 'bad'; await writeFile(p, JSON.stringify(value));
    }));
  }
  for (const kind of ['symlink', 'hardlink', 'traversal', 'corrupt', 'trailing-slash']) {
    await assert.rejects(prepare(`tar-${kind}`, async dir => {
      let bytes = Buffer.concat([tarMember(kind === 'traversal' ? '../escape' : kind === 'trailing-slash' ? 'file/' : 'file', Buffer.alloc(0), kind === 'symlink' ? '2' : kind === 'hardlink' ? '1' : '0', ['symlink', 'hardlink'].includes(kind) ? '/etc/passwd' : ''), tarEnd]);
      if (kind === 'corrupt') bytes[0] ^= 1;
      if (kind === 'trailing-slash') {
        bytes = Buffer.concat([tarMember('unexpected/'), await readFile(join(dir, 'site.tar'))]);
        const receiptPath = join(dir, 'BUILD.json'), receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
        receipt.artifact = hash(bytes); await writeFile(receiptPath, JSON.stringify(receipt));
      }
      await writeFile(join(dir, 'site.tar'), bytes);
    }), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, kind === 'trailing-slash' ? /regular tar member has trailing slash/ : kind === 'corrupt' ? /tar checksum/ : kind === 'traversal' ? /unsafe tar member/ : /tar links\/special members refused/); return true;
    });
  }
});

test(`${lane}: preparation refuses a changed local validator`, async () => {
  const dir = join(root, 'validator-drift'); await cp(await artifactDir(), dir, { recursive: true });
  await rm(join(dir, 'packet'), { recursive: true, force: true });
  const changed = join(root, 'changed-validator.mjs'); await writeFile(changed, (await readFile(validator, 'utf8')) + '\n// local drift\n');
  await assert.rejects(exec(process.execPath, [changed, 'prepare', dir, hash(await readFile(join(dir, 'BUILD.json'))), '/root/cswarm-site-validator-drift']), (error: unknown) => {
    assert.match((error as { stderr: string }).stderr, /preparation validator provenance mismatch/); return true;
  });
});

test(`${lane}: H0=1 requires emitted controls; explicit H0=0 omits them`, async () => {
  const original = JSON.parse(await readFile(join(await artifactDir(), 'BUILD.json'), 'utf8'));
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
        assert.notEqual(html, before, `artifact must have the ${action} button to remove`);
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

test(`${lane}: rendered Linux release swaps bytes, retains reserves, and rolls back failures and drift`, { skip: !linuxProof }, async () => {
  const curl = (await exec('which', ['curl'])).stdout.trim();
  for (const variant of ['success', 'root-status', 'app-status', 'root-body', 'app-body', 'curl-failure', 'asset-drift', 'current-drift', 'artifact-pin', 'build-pin', 'closed-pipe', 'closed-pipe-failure', 'find-failure', 'flip-failure', 'missing-old', 'rollback-status', 'hup']) {
    const packet = await prepare(`run-${variant}`), site = join(root, `site-${variant}`), old = join(site, 'releases/old');
    await mkdir(join(old, 'app'), { recursive: true }); await writeFile(join(old, 'index.html'), 'old root'); await writeFile(join(old, 'app/index.html'), 'old app');
    await mkdir(join(old, '_astro'), { recursive: true }); await writeFile(join(old, '_astro/retained.js'), 'old asset');
    await symlink('releases/old', join(site, 'current')); await mkdir(join(site, 'releases/reserve'));
    const oldProbes = new Set<string>();
    let notifyHeld!: () => void, releaseHeld!: () => void;
    const probeHeld = new Promise<void>(r => { notifyHeld = r; });
    const probeReleased = new Promise<void>(r => { releaseHeld = r; });
    const server = createServer(async (req, res) => {
      if (variant === 'closed-pipe-failure' && (await readlink(join(site, 'current'))) !== 'releases/old') { res.writeHead(503); res.end(); return; }
      if (variant === 'rollback-status') { res.writeHead(503); res.end(); return; }
      const route = req.url === '/app' ? 'app/index.html' : 'index.html';
      const isNew = (await readlink(join(site, 'current'))) !== 'releases/old';
      if (isNew && variant === 'hup') { notifyHeld(); await probeReleased; }
      if (!isNew) oldProbes.add(req.url!);
      if (isNew && variant === `${req.url === '/app' ? 'app' : 'root'}-status`) { res.writeHead(503); res.end('unavailable'); return; }
      if (isNew && variant === `${req.url === '/app' ? 'app' : 'root'}-body`) { res.end('wrong HTML'); return; }
      try { res.end(await readFile(join(site, 'current', route))); } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address === 'object');
    const bin = join(root, `bin-${variant}`); await mkdir(bin);
    await writeFile(join(bin, 'hostname'), '#!/bin/sh\necho yulan-vps-1\n');
    await writeFile(join(bin, 'curl'), `#!/bin/bash\nargs=(); for a in "$@"; do case "$a" in https://commonswarm.com*) args+=("http://127.0.0.1:${address.port}\${a#https://commonswarm.com}");; *) args+=("$a");; esac; done\n${variant === 'curl-failure' ? `if [[ $(readlink '${site}/current') != releases/old ]]; then exit 7; fi\nexec ${curl} "\${args[@]}"` : `exec ${curl} "\${args[@]}"`}\n`);
    // Simulate a concurrent pointer edit during permissions normalization.
    await writeFile(join(bin, 'chmod'), `#!/bin/sh\n/bin/chmod "$@"\n${variant === 'current-drift' ? `ln -sfn releases/reserve '${site}/current'` : ':'}\n`);
    await writeFile(join(bin, 'find'), `#!/bin/sh\n${variant === 'find-failure' ? 'case "$*" in *"-type f -print0"*) exit 1;; esac\nexec /usr/bin/find "$@"' : 'exec /usr/bin/find "$@"'}\n`);
    await writeFile(join(bin, 'mv'), `#!/bin/sh\n${variant === 'flip-failure' ? 'exit 1' : 'exec /bin/mv "$@"'}\n`);
    for (const name of ['hostname', 'curl', 'chmod', 'find', 'mv']) await chmod(join(bin, name), 0o755);
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
      const run = () => exec('bash', variant.startsWith('closed-pipe') ? ['-c', 'exec 1>&- 2>&-; exec bash "$1" deploy', 'fixture', join(packet, 'run.sh')] : [join(packet, 'run.sh'), 'deploy'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, ...(variant === 'hup' ? { timeout: 30_000 } : {}) });
      if (['success', 'closed-pipe', 'missing-old'].includes(variant)) {
        const completed = await run();
        assert.equal(completed.stdout, ''); assert.equal(completed.stderr, '');
        assert.match(await readFile(join(packet, 'hostrun.log'), 'utf8'), /PASS deploy/);
        const current = await readlink(join(site, 'current')); assert.notEqual(current, 'releases/old');
        assert.equal(await readFile(join(site, 'current/_astro/retained.js'), 'utf8'), 'old asset');
        if (variant === 'missing-old') {
          await exec('mv', [old, old + '-moved']);
          await assert.rejects(exec('bash', [join(packet, 'run.sh'), 'rollback'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }));
          assert.equal(await readlink(join(site, 'current')), current);
          assert.match(await readFile(join(packet, 'hostrun.log'), 'utf8'), /assertion=old-directory/);
          await exec('mv', [old + '-moved', old]);
        }
        await exec('bash', [join(packet, 'run.sh'), 'rollback'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
        assert.equal(await readlink(join(site, 'current')), 'releases/old');
        await exec('bash', [join(packet, 'run.sh'), 'rollback'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      } else {
        if (variant === 'hup') {
          const running = run();
          // Attach the rejection assertion before sending HUP; Bash defers its
          // trap until the foreground probe returns, so never await exit first.
          const exited = assert.rejects(running, (error: unknown) => {
            assert.equal((error as { code: number }).code, 143); return true;
          });
          let timer: ReturnType<typeof setTimeout>;
          const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('new-release probe was not reached')), 10_000);
          });
          try {
            assert.equal(await Promise.race([probeHeld.then(() => true), exited.then(() => false), deadline]), true, 'child must reach the new-release probe');
            assert.notEqual(await readlink(join(site, 'current')), 'releases/old');
            assert.equal(running.child.kill('SIGHUP'), true, 'send HUP to the rendered Bash child');
          } finally { clearTimeout(timer!); releaseHeld(); await exited; }
        } else await assert.rejects(run());
        const output = await readFile(join(packet, 'hostrun.log'), 'utf8');
        if (['root-status', 'app-status'].includes(variant)) assert.match(output, /assertion=httpstatus/);
        if (['root-body', 'app-body'].includes(variant)) assert.match(output, /assertion=httphash/);
        if (['root-status', 'app-status', 'root-body', 'app-body', 'curl-failure', 'closed-pipe-failure', 'hup'].includes(variant)) assert.match(output, /PASS rollback/);
        if (variant === 'asset-drift') assert.match(output, /assertion=old-asset-identical/);
        if (variant === 'current-drift') assert.match(output, /assertion=exact-old-link/);
        if (variant === 'artifact-pin') assert.match(output, /assertion=artifactSHA/);
        if (variant === 'build-pin') assert.match(output, /assertion=buildSHA/);
        if (variant === 'flip-failure') assert.match(output, /PASS rollback unchanged/);
        if (variant === 'rollback-status') assert.match(output, /assertion=rollback-httpstatus/);
        if (variant === 'find-failure') assert.match(output, /FAIL step=old-assets/);
        assert.equal(await readlink(join(site, 'current')), variant === 'current-drift' ? 'releases/reserve' : 'releases/old');
      }
      if (['success', 'closed-pipe', 'closed-pipe-failure', 'missing-old', 'root-status', 'app-status', 'root-body', 'app-body', 'curl-failure', 'hup'].includes(variant)) assert.deepEqual([...oldProbes].sort(), ['/', '/app']);
      assert.equal((await stat(join(packet, 'hostrun.log'))).mode & 0o777, 0o600);
      assert.ok((await readdir(join(site, 'releases'))).includes('reserve'));
      assert.equal(await readFile(join(old, '_astro/retained.js'), 'utf8'), 'old asset');
    } finally { await new Promise<void>(r => server.close(() => r())); }
  }
});

test('production script requires only static file tools and never compiles or prunes', async () => {
  const source = await readFile(join(repo, 'deploy/site/finalize-release.sh'), 'utf8');
  assert.doesNotMatch(source, /\b(?:npm|node|docker|rsync|rm)\b/);
  assert.ok(source.trim().split('\n').length >= 24 && source.trim().split('\n').length <= 100);
});
