import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { after, test } from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, cp, chmod, symlink, readlink, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { gzipSync } from 'node:zlib';
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
function tarMember(name: string, data: Buffer = Buffer.alloc(0), type = '0', link = '') {
  const header = Buffer.alloc(512);
  const field = (value: string, offset: number, size: number) => header.write(value, offset, size, 'ascii');
  field(name, 0, 100); field('0000644\0', 100, 8); field('0000000\0', 108, 8); field('0000000\0', 116, 8);
  field(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); field('00000000000\0', 136, 12);
  header.fill(32, 148, 156); field(type, 156, 1); field(link, 157, 100); field('ustar\0', 257, 6); field('00', 263, 2);
  field(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const tarEnd = Buffer.alloc(1024);
const sourcePaths = ['site/package-lock.json', 'app/package-lock.json', 'deploy/site/build-artifact.sh', 'deploy/site/validate-site-env.mjs', 'deploy/site/finalize-release.sh', 'deploy/site/refresh-site.py'];
const nextCsp = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://api.commonswarm.com wss://api.commonswarm.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
function syntheticNextHtml(overrides?: { url?: string; anonKey?: string; csp?: string | null; rawCspMeta?: string; cspAfterTitle?: boolean; extraHead?: string }) {
  const url = overrides?.url ?? config.PUBLIC_SUPABASE_URL;
  const anonKey = overrides?.anonKey ?? config.PUBLIC_SUPABASE_ANON_KEY;
  const cspMeta = overrides?.rawCspMeta !== undefined
    ? overrides.rawCspMeta
    : overrides?.csp === null
      ? ''
      : `<meta http-equiv="Content-Security-Policy" content="${overrides?.csp ?? nextCsp}" />`;
  const head = overrides?.cspAfterTitle
    ? `<meta charset="UTF-8" />\n    <title>CommonSwarm</title>\n    ${cspMeta}`
    : `<meta charset="UTF-8" />${cspMeta ? `\n    ${cspMeta}` : ''}\n    <title>CommonSwarm</title>`;
  return `<!doctype html>\n<html lang="en" class="dark">\n  <head>\n    ${head}\n    <meta name="commonswarm:url" content="${url}" />\n    <meta name="commonswarm:anon-key" content="${anonKey}" />${overrides?.extraHead ? `\n    ${overrides.extraHead}` : ''}\n    <script type="module" src="/next/assets/index-fixture.js"></script>\n    <link rel="stylesheet" href="/next/assets/index-fixture.css">\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n`;
}
function syntheticSite(options?: { includeNext?: boolean; nextHtml?: string; omitNextAsset?: boolean }) {
  const includeNext = options?.includeNext ?? false;
  const meta = `<meta name="commonswarm:url" content="${config.PUBLIC_SUPABASE_URL}"><meta name="commonswarm:anon-key" content="${config.PUBLIC_SUPABASE_ANON_KEY}">`;
  const controls = '<section data-h0-link-join><button data-action="mint-join">Join</button><button data-action="revoke-join">Revoke</button></section>';
  const parts = [
    tarMember('index.html', Buffer.from(meta)), tarMember('app/index.html', Buffer.from(meta + controls)),
    tarMember('start/index.html', Buffer.from(meta)), tarMember('_astro/new.js', Buffer.from('fixture asset')),
  ];
  if (includeNext) {
    parts.push(
      tarMember('next/index.html', Buffer.from(options?.nextHtml ?? syntheticNextHtml())),
      tarMember('next/assets/index-fixture.js', Buffer.from('console.log("next");')),
    );
    if (!options?.omitNextAsset) {
      parts.push(
        tarMember('next/assets/index-fixture.css', Buffer.from('@font-face{src:url(/next/fonts/inter-latin.woff2)}')),
        tarMember('next/fonts/inter-latin.woff2', Buffer.from('fixture-font')),
      );
    }
  }
  parts.push(tarEnd);
  return Buffer.concat(parts);
}
function cleanNextEnv(extra?: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.COMMONSWARM_INCLUDE_NEXT;
  return extra ? { ...env, ...extra } : env;
}
let fixture: Promise<string> | undefined;
let fixtureWithNext: Promise<string> | undefined;
async function buildSyntheticArtifact(dirName: string, includeNext: boolean) {
  const dir = join(root, dirName); await mkdir(dir);
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  // Preserve Git's commit-id header, but deliberately use current working bytes:
  // this source archive proves fixture semantics, never a real committed build.
  const archive = (await exec('git', ['archive', '--format=tar', revision, 'package.json'], { cwd: repo, encoding: 'buffer' })).stdout;
  assert.equal(archive.subarray(156, 157).toString(), 'g');
  const source = await Promise.all(sourcePaths.map(async path => tarMember(path, await readFile(join(repo, path)))));
  await writeFile(join(dir, 'source.tar'), Buffer.concat([archive.subarray(0, 1024), ...source, tarEnd]));
  await writeFile(join(dir, 'public.json'), JSON.stringify({ ...config, PUBLIC_H0_LINK_JOIN: '1' }));
  await writeFile(join(dir, 'site.tar'), syntheticSite({ includeNext }));
  await cp(join(repo, 'deploy/site/finalize-release.sh'), join(dir, 'finalize-release.sh'));
  const image = 'node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d';
  // The production receipt owner computes pins; the fixture never supplies them.
  await exec(process.execPath, [validator, 'receipt', dir, revision, image], {
    env: cleanNextEnv(includeNext ? { COMMONSWARM_INCLUDE_NEXT: '1' } : undefined),
  });
  return dir;
}
async function artifactDir() {
  if (suppliedArtifact) return suppliedArtifact;
  return fixture ??= buildSyntheticArtifact('synthetic', false);
}
async function artifactDirWithNext() {
  return fixtureWithNext ??= buildSyntheticArtifact('synthetic-next', true);
}
async function prepare(name: string, mutate?: (dir: string) => Promise<void>, sourceDir?: string) {
  const dir = join(root, name); await cp(sourceDir ?? await artifactDir(), dir, { recursive: true });
  await rm(join(dir, 'packet'), { recursive: true, force: true });
  for (const file of ['BUILD.json', 'site.tar']) await chmod(join(dir, file), 0o600);
  if (mutate) await mutate(dir);
  const pin = hash(await readFile(join(dir, 'BUILD.json')));
  await exec(process.execPath, [validator, 'prepare', dir, pin, `/root/cswarm-site-${name}`], { env: cleanNextEnv() });
  return join(dir, 'packet');
}

test(`${lane}: provenance and unsafe tar members are rejected before packet creation`, async () => {
  await prepare('provenance-control');
  for (const field of ['source', 'config', 'lock', 'appLock', 'builder', 'validator', 'template', 'refresh', 'image', 'revision', 'h0', 'next', 'nextAssets', 'artifact']) {
    await assert.rejects(prepare(`bad-${field}`, async dir => {
      const p = join(dir, 'BUILD.json'), value = JSON.parse(await readFile(p, 'utf8')); value[field] = 'bad'; await writeFile(p, JSON.stringify(value));
    }));
  }
  const withNext = await artifactDirWithNext();
  await prepare('provenance-next-control', undefined, withNext);
  for (const field of ['appLock', 'next', 'nextAssets']) {
    await assert.rejects(prepare(`bad-next-${field}`, async dir => {
      const p = join(dir, 'BUILD.json'), value = JSON.parse(await readFile(p, 'utf8')); value[field] = 'bad'; await writeFile(p, JSON.stringify(value));
    }, withNext));
  }
  await assert.rejects(prepare('bad-next-stripped', async dir => {
    const p = join(dir, 'BUILD.json'), value = JSON.parse(await readFile(p, 'utf8')); delete value.next; await writeFile(p, JSON.stringify(value));
  }, withNext));
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

test(`${lane}: /next preview defaults off with pre-PR receipt, rejects invalid values, and validates meta/CSP/origins/assets when opted in`, async () => {
  const base = await artifactDir();
  const baseReceiptBytes = await readFile(join(base, 'BUILD.json'), 'utf8');
  const baseReceipt = JSON.parse(baseReceiptBytes);
  const image = baseReceipt.image;
  const revision = baseReceipt.revision;

  // Verify default (unset) matches pre-PR receipt schema when built without COMMONSWARM_INCLUDE_NEXT=1.
  if (!suppliedArtifact) {
    assert.deepEqual(
      Object.keys(baseReceipt).sort(),
      ['artifact', 'builder', 'config', 'h0', 'html', 'image', 'lock', 'refresh', 'revision', 'source', 'template', 'validator'],
    );
    assert.equal(baseReceipt.next, undefined);
    assert.equal(baseReceipt.appLock, undefined);
    assert.equal(baseReceipt.nextAssets, undefined);
    assert.equal(baseReceipt.html['next/index.html'], undefined);
  }

  // Verify build-artifact.sh defaults unset -> 0 (not :-0, so empty string still fails closed before mkdir).
  const builderSource = await readFile(join(repo, 'deploy/site/build-artifact.sh'), 'utf8');
  assert.match(builderSource, /INCLUDE_NEXT=\$\{COMMONSWARM_INCLUDE_NEXT-0\}/);
  assert.match(builderSource, /\$INCLUDE_NEXT =~ \^\[01\]\$/);
  assert.ok(builderSource.indexOf('$INCLUDE_NEXT =~ ^[01]$') < builderSource.indexOf('mkdir "$OUT"'));

  // Explicit COMMONSWARM_INCLUDE_NEXT=0 produces a receipt byte-identical to unset.
  const zeroDir = join(root, 'next-check-explicit-zero');
  await cp(base, zeroDir, { recursive: true });
  await rm(join(zeroDir, 'BUILD.json'), { force: true });
  await rm(join(zeroDir, 'packet'), { recursive: true, force: true });
  await chmod(join(zeroDir, 'site.tar'), 0o600);
  await writeFile(join(zeroDir, 'site.tar'), syntheticSite({ includeNext: false }));
  await exec(process.execPath, [validator, 'receipt', zeroDir, revision, image], { env: cleanNextEnv({ COMMONSWARM_INCLUDE_NEXT: '0' }) });
  const zeroReceiptBytes = await readFile(join(zeroDir, 'BUILD.json'), 'utf8');
  const unsetDir = join(root, 'next-check-unset');
  await cp(zeroDir, unsetDir, { recursive: true });
  await rm(join(unsetDir, 'BUILD.json'), { force: true });
  await exec(process.execPath, [validator, 'receipt', unsetDir, revision, image], { env: cleanNextEnv() });
  const unsetReceiptBytes = await readFile(join(unsetDir, 'BUILD.json'), 'utf8');
  assert.equal(zeroReceiptBytes, unsetReceiptBytes);
  const offReceipt = JSON.parse(unsetReceiptBytes);
  assert.deepEqual(
    Object.keys(offReceipt).sort(),
    ['artifact', 'builder', 'config', 'h0', 'html', 'image', 'lock', 'refresh', 'revision', 'source', 'template', 'validator'],
  );
  assert.equal(offReceipt.html['next/index.html'], undefined);
  await exec(process.execPath, [validator, 'prepare', unsetDir, hash(unsetReceiptBytes), '/root/cswarm-site-next-unset'], { env: cleanNextEnv() });
  const renderedOff = await readFile(join(unsetDir, 'packet/SITE-DIRECT.sh'), 'utf8');
  assert.doesNotMatch(renderedOff, /@@/);
  assert.match(renderedOff, /if \[\[ '0' == 1 \]\]/);
  await exec('bash', ['-n', join(unsetDir, 'packet/SITE-DIRECT.sh')]);

  // Extract the exact PRODUCTION_CSP and preamble generated by app/index.html + app/vite.config.ts so any drift fails this test.
  const appIndexSource = await readFile(join(repo, 'app/index.html'), 'utf8');
  assert.ok(
    appIndexSource.startsWith('<!doctype html>\n<html lang="en" class="dark">\n  <head>\n    <meta charset="UTF-8" />\n'),
    'app/index.html must begin with the canonical doctype, html, head, and charset preamble',
  );
  const viteConfigSource = await readFile(join(repo, 'app/vite.config.ts'), 'utf8');
  const viteCspMatch = viteConfigSource.match(/const\s+PRODUCTION_CSP\s*=\s*\n?\s*"([^"]+)"/);
  assert.ok(viteCspMatch, 'app/vite.config.ts must declare PRODUCTION_CSP as a static string');
  const viteCsp = viteCspMatch[1]!;
  assert.match(viteCsp, /\bframe-src\s+'none'/);
  assert.match(viteConfigSource, /order:\s*'pre'/);
  assert.match(viteConfigSource, /const\s+charsetTag\s*=\s*\/\(<meta\\s\+charset=/);
  assert.match(viteConfigSource, /out\.replace\(\s*charsetTag,\s*`\$1\\n\s*<meta http-equiv="Content-Security-Policy" content="\$\{PRODUCTION_CSP\}" \/>`/);
  assert.equal(viteCsp, nextCsp, 'test fixture nextCsp must match app/vite.config.ts PRODUCTION_CSP');

  const receiptCases: Array<{ name: string; siteTar: Buffer; env?: Record<string, string>; expectError?: RegExp }> = [
    { name: 'default-rejects-stray-next', siteTar: syntheticSite({ includeNext: true }), expectError: /unexpected next\/ member/ },
    { name: 'zero-rejects-stray-next', siteTar: syntheticSite({ includeNext: true }), env: { COMMONSWARM_INCLUDE_NEXT: '0' }, expectError: /unexpected next\/ member/ },
    { name: 'invalid-empty', siteTar: syntheticSite({ includeNext: false }), env: { COMMONSWARM_INCLUDE_NEXT: '' }, expectError: /COMMONSWARM_INCLUDE_NEXT must be 0 or 1/ },
    { name: 'invalid-two', siteTar: syntheticSite({ includeNext: false }), env: { COMMONSWARM_INCLUDE_NEXT: '2' }, expectError: /COMMONSWARM_INCLUDE_NEXT must be 0 or 1/ },
    { name: 'invalid-true', siteTar: syntheticSite({ includeNext: false }), env: { COMMONSWARM_INCLUDE_NEXT: 'true' }, expectError: /COMMONSWARM_INCLUDE_NEXT must be 0 or 1/ },
    { name: 'invalid-space', siteTar: syntheticSite({ includeNext: false }), env: { COMMONSWARM_INCLUDE_NEXT: ' 1' }, expectError: /COMMONSWARM_INCLUDE_NEXT must be 0 or 1/ },
    { name: 'next-missing', siteTar: syntheticSite({ includeNext: false }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /missing next\/index\.html/ },
    { name: 'next-url-mismatch', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ url: 'https://other.invalid' }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /built public configuration mismatch|third-party origin/ },
    { name: 'next-key-mismatch', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ anonKey: token('anon') + 'x' }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /built public configuration mismatch/ },
    { name: 'next-service-role', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ anonKey: token('service_role') }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /service_role/ },
    { name: 'next-csp-missing', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: null }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /Content-Security-Policy meta must be the first element/ },
    { name: 'next-csp-not-first', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ cspAfterTitle: true }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /Content-Security-Policy meta must be the first element/ },
    { name: 'next-csp-duplicate-content-attr', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ rawCspMeta: `<meta http-equiv="Content-Security-Policy" content="default-src *" content="${viteCsp}" />` }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /<meta> contains duplicate attribute: content/ },
    { name: 'next-csp-duplicate-content-attr-case', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ rawCspMeta: `<meta http-equiv="Content-Security-Policy" Content="default-src *" content="${viteCsp}" />` }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /<meta> contains duplicate attribute: content/ },
    { name: 'next-csp-duplicate-http-equiv-attr', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ rawCspMeta: `<meta http-equiv="X-Other" http-equiv="Content-Security-Policy" content="${viteCsp}" />` }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /<meta> contains duplicate attribute: http-equiv/ },
    { name: 'next-csp-duplicate-http-equiv-reversed', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ rawCspMeta: `<meta http-equiv="Content-Security-Policy" http-equiv="X-Other" content="${viteCsp}" />` }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /<meta> contains duplicate attribute: http-equiv/ },
    { name: 'next-csp-nbsp-attr-separator', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ rawCspMeta: `<meta http-equiv="Content-Security-Policy" content="default-src *"\u00a0content="${viteCsp}" />` }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP directive default-src mismatch/ },
    { name: 'next-csp-non-ascii-nbsp', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: viteCsp.replace("script-src 'self'", "script-src\u00a0'self'") }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP contains non-ASCII or control character/ },
    { name: 'next-csp-non-ascii-em-space', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: viteCsp.replace("frame-src 'none'", "frame-src\u2003'none'") }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP contains non-ASCII or control character/ },
    { name: 'next-csp-control-char', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: viteCsp.replace("script-src 'self'", "script-src\t'self'") }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP contains non-ASCII or control character/ },
    { name: 'next-csp-missing-frame-src', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: viteCsp.replace("; frame-src 'none'", '') }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP missing required directive: frame-src/ },
    { name: 'next-csp-missing-object-src', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: viteCsp.replace("; object-src 'none'", '') }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP missing required directive: object-src/ },
    { name: 'next-csp-relaxed-script-src', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: viteCsp.replace("script-src 'self'", "script-src 'self' https://example.com") }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP directive script-src mismatch/ },
    { name: 'next-csp-relaxed-connect-wildcard', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: viteCsp.replace("connect-src 'self' https://api.commonswarm.com wss://api.commonswarm.com", 'connect-src *') }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP directive connect-src mismatch/ },
    { name: 'next-csp-relaxed-connect-wrong-origin', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: viteCsp.replace("https://api.commonswarm.com wss://api.commonswarm.com", 'https://evil.invalid wss://evil.invalid') }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP directive connect-src mismatch/ },
    { name: 'next-csp-relaxed-style-unsafe-inline', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: viteCsp.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'") }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /unsafe-inline/ },
    { name: 'next-csp-added-directive', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: `${viteCsp}; worker-src 'self'` }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP contains unexpected directive: worker-src/ },
    { name: 'next-csp-duplicate-relaxed-first', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: `script-src 'self' https://example.com; ${viteCsp}` }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP contains duplicate directive: script-src/ },
    { name: 'next-csp-duplicate-strict-first', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: `${viteCsp}; script-src 'self' https://example.com` }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP contains duplicate directive: script-src/ },
    { name: 'next-csp-duplicate-identical', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: `${viteCsp}; frame-src 'none'` }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /CSP contains duplicate directive: frame-src/ },
    { name: 'next-third-party-link', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ extraHead: '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /third-party origin/ },
    { name: 'next-protocol-relative', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ extraHead: '<script src="//cdn.example.invalid/a.js"></script>' }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /third-party origin/ },
    { name: 'next-missing-asset', siteTar: syntheticSite({ includeNext: true, omitNextAsset: true }), env: { COMMONSWARM_INCLUDE_NEXT: '1' }, expectError: /referenced asset missing from archive/ },
    { name: 'next-opt-in-valid', siteTar: syntheticSite({ includeNext: true, nextHtml: syntheticNextHtml({ csp: viteCsp }) }), env: { COMMONSWARM_INCLUDE_NEXT: '1' } },
  ];

  for (const row of receiptCases) {
    const dir = join(root, `next-check-${row.name}`);
    await cp(base, dir, { recursive: true });
    await rm(join(dir, 'BUILD.json'), { force: true });
    await rm(join(dir, 'packet'), { recursive: true, force: true });
    await chmod(join(dir, 'site.tar'), 0o600);
    await writeFile(join(dir, 'site.tar'), row.siteTar);
    const run = exec(process.execPath, [validator, 'receipt', dir, revision, image], { env: cleanNextEnv(row.env) });
    if (row.expectError) {
      await assert.rejects(run, (error: unknown) => {
        assert.match((error as { stderr: string }).stderr, row.expectError!);
        return true;
      });
    } else {
      await run;
      const receipt = JSON.parse(await readFile(join(dir, 'BUILD.json'), 'utf8'));
      assert.equal(receipt.next, '1');
      assert.equal(receipt.appLock, hash(await readFile(join(repo, 'app/package-lock.json'))));
      assert.ok(typeof receipt.html['next/index.html'] === 'string' && receipt.html['next/index.html'].length === 64);
      assert.ok(Array.isArray(receipt.nextAssets) && receipt.nextAssets.length > 0);
      await exec(process.execPath, [validator, 'prepare', dir, hash(await readFile(join(dir, 'BUILD.json'))), `/root/cswarm-site-${row.name}`], { env: cleanNextEnv() });
      const rendered = await readFile(join(dir, 'packet/SITE-DIRECT.sh'), 'utf8');
      assert.doesNotMatch(rendered, /@@/);
      assert.match(rendered, /if \[\[ '1' == 1 \]\]/);
      await exec('bash', ['-n', join(dir, 'packet/SITE-DIRECT.sh')]);
    }
  }
});

test(`${lane}: real app build satisfies the canonical preamble pin and negative placement fixtures are refused`, async () => {
  const base = await artifactDir();
  const baseReceipt = JSON.parse(await readFile(join(base, 'BUILD.json'), 'utf8'));
  const image = baseReceipt.image;
  const revision = baseReceipt.revision;

  const viteConfigSource = await readFile(join(repo, 'app/vite.config.ts'), 'utf8');
  const viteCspMatch = viteConfigSource.match(/const\s+PRODUCTION_CSP\s*=\s*\n?\s*"([^"]+)"/);
  assert.ok(viteCspMatch, 'app/vite.config.ts must declare PRODUCTION_CSP');
  const viteCsp = viteCspMatch[1]!;
  const expectedPreamble =
    '<!doctype html>\n' +
    '<html lang="en" class="dark">\n' +
    '  <head>\n' +
    '    <meta charset="UTF-8" />\n' +
    `    <meta http-equiv="Content-Security-Policy" content="${viteCsp}" />\n`;

  async function collectDirMembers(dir: string, prefix: string): Promise<Buffer[]> {
    const parts: Buffer[] = [];
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        parts.push(...(await collectDirMembers(full, rel)));
      } else if (entry.isFile() && rel !== 'next/index.html') {
        parts.push(tarMember(rel, await readFile(full)));
      }
    }
    return parts;
  }

  function buildSiteTar(nextHtmlBytes: Buffer, nextAssetMembers: Buffer[]) {
    const meta = `<meta name="commonswarm:url" content="${config.PUBLIC_SUPABASE_URL}"><meta name="commonswarm:anon-key" content="${config.PUBLIC_SUPABASE_ANON_KEY}">`;
    const controls = '<section data-h0-link-join><button data-action="mint-join">Join</button><button data-action="revoke-join">Revoke</button></section>';
    return Buffer.concat([
      tarMember('index.html', Buffer.from(meta)),
      tarMember('app/index.html', Buffer.from(meta + controls)),
      tarMember('start/index.html', Buffer.from(meta)),
      tarMember('_astro/new.js', Buffer.from('fixture asset')),
      tarMember('next/index.html', nextHtmlBytes),
      ...nextAssetMembers,
      tarEnd,
    ]);
  }

  const viteBin = join(repo, 'app/node_modules/vite/bin/vite.js');
  let controlHtml: string;
  let nextAssetMembers: Buffer[];
  if (existsSync(viteBin)) {
    const buildEnvBase: NodeJS.ProcessEnv = { ...process.env };
    delete buildEnvBase.PUBLIC_SUPABASE_URL;
    delete buildEnvBase.PUBLIC_SUPABASE_ANON_KEY;

    const outNoConfig = join(root, 'app-dist-no-config');
    await exec(process.execPath, [viteBin, 'build', '--outDir', outNoConfig], {
      cwd: join(repo, 'app'),
      env: buildEnvBase,
    });
    const htmlNoConfig = await readFile(join(outNoConfig, 'index.html'), 'utf8');
    assert.ok(
      htmlNoConfig.startsWith(expectedPreamble),
      'real app build without public config must begin with the canonical preamble',
    );

    const outWithConfig = join(root, 'app-dist-with-config');
    await exec(process.execPath, [viteBin, 'build', '--outDir', outWithConfig], {
      cwd: join(repo, 'app'),
      env: {
        ...buildEnvBase,
        PUBLIC_SUPABASE_URL: config.PUBLIC_SUPABASE_URL,
        PUBLIC_SUPABASE_ANON_KEY: config.PUBLIC_SUPABASE_ANON_KEY,
      },
    });
    controlHtml = await readFile(join(outWithConfig, 'index.html'), 'utf8');
    assert.ok(
      controlHtml.startsWith(expectedPreamble),
      'real app build with public config must begin with the canonical preamble',
    );
    const cspEnd = expectedPreamble.length;
    for (const marker of [
      '<meta name="viewport"',
      '<meta name="color-scheme"',
      '<title>CommonSwarm</title>',
      '<meta name="commonswarm:url"',
      '<meta name="commonswarm:anon-key"',
      '<script type="module"',
      '<link rel="stylesheet"',
    ]) {
      const idx = controlHtml.indexOf(marker);
      assert.ok(idx >= cspEnd, `real app build must place ${marker} after the CSP meta`);
    }
    nextAssetMembers = await collectDirMembers(outWithConfig, 'next');
  } else {
    // Root-only CI jobs do not install app/node_modules; derive the control directly from app/index.html.
    const appIndexHtml = await readFile(join(repo, 'app/index.html'), 'utf8');
    controlHtml = appIndexHtml
      .replace(
        /(<meta\s+charset="[^"]*"\s*\/?>)/i,
        `$1\n    <meta http-equiv="Content-Security-Policy" content="${viteCsp}" />`,
      )
      .replace(
        '  </head>',
        `    <meta name="commonswarm:url" content="${config.PUBLIC_SUPABASE_URL}" />\n    <meta name="commonswarm:anon-key" content="${config.PUBLIC_SUPABASE_ANON_KEY}" />\n    <script type="module" crossorigin src="/next/assets/index-fixture.js"></script>\n    <link rel="stylesheet" crossorigin href="/next/assets/index-fixture.css">\n  </head>`,
      )
      .replace(/\s*<script type="module" src="\/src\/main\.tsx"><\/script>\n/, '\n');
    nextAssetMembers = [
      tarMember('next/assets/index-fixture.js', Buffer.from('console.log("next");')),
      tarMember('next/assets/index-fixture.css', Buffer.from('@font-face{src:url(/next/fonts/inter-latin.woff2)}')),
      tarMember('next/fonts/inter-latin.woff2', Buffer.from('fixture-font')),
    ];
  }

  const controlBytes = Buffer.from(controlHtml, 'utf8');
  const stylesheetMatch = controlHtml.match(/<link rel="stylesheet"[^>]*>/);
  assert.ok(stylesheetMatch, 'control HTML must contain a stylesheet link');
  const stylesheetTag = stylesheetMatch[0]!;
  const cspLine = `    <meta http-equiv="Content-Security-Policy" content="${viteCsp}" />\n`;
  assert.ok(controlHtml.includes(cspLine), 'control HTML must contain the canonical CSP line');

  async function runReceipt(name: string, nextHtmlBytes: Buffer) {
    const dir = join(root, `preamble-${name}`);
    await cp(base, dir, { recursive: true });
    await rm(join(dir, 'BUILD.json'), { force: true });
    await rm(join(dir, 'packet'), { recursive: true, force: true });
    await chmod(join(dir, 'site.tar'), 0o600);
    await writeFile(join(dir, 'site.tar'), buildSiteTar(nextHtmlBytes, nextAssetMembers));
    await exec(process.execPath, [validator, 'receipt', dir, revision, image], {
      env: cleanNextEnv({ COMMONSWARM_INCLUDE_NEXT: '1' }),
    });
    return dir;
  }

  // Control: the real build output must satisfy receipt + prepare cleanly.
  const controlDir = await runReceipt('control-real-build', controlBytes);
  await exec(
    process.execPath,
    [validator, 'prepare', controlDir, hash(await readFile(join(controlDir, 'BUILD.json'))), '/root/cswarm-site-preamble-control'],
    { env: cleanNextEnv() },
  );

  // Negative placement fixtures mutated directly from the control HTML.
  const negativeCases: Array<{ name: string; bytes: Buffer; expectError: RegExp }> = [
    {
      name: 'text-between-head-and-charset',
      bytes: Buffer.from(controlHtml.replace('  <head>\n    <meta charset="UTF-8" />', '  <head>\n    hello\n    <meta charset="UTF-8" />'), 'utf8'),
      expectError: /must begin with the canonical preamble/,
    },
    {
      name: 'text-between-charset-and-policy',
      bytes: Buffer.from(controlHtml.replace('    <meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy"', '    <meta charset="UTF-8" />\n    hello\n    <meta http-equiv="Content-Security-Policy"'), 'utf8'),
      expectError: /Content-Security-Policy meta must be the first element/,
    },
    {
      name: 'body-before-policy',
      bytes: Buffer.from(controlHtml.replace('    <meta http-equiv="Content-Security-Policy"', '    <body>\n    <meta http-equiv="Content-Security-Policy"'), 'utf8'),
      expectError: /Content-Security-Policy meta must be the first element/,
    },
    {
      name: 'script-before-policy',
      bytes: Buffer.from(controlHtml.replace('    <meta http-equiv="Content-Security-Policy"', '    <script></script>\n    <meta http-equiv="Content-Security-Policy"'), 'utf8'),
      expectError: /Content-Security-Policy meta must be the first element/,
    },
    {
      name: 'link-before-policy',
      bytes: Buffer.from(controlHtml.replace('    <meta http-equiv="Content-Security-Policy"', `    ${stylesheetTag}\n    <meta http-equiv="Content-Security-Policy"`), 'utf8'),
      expectError: /Content-Security-Policy meta must be the first element/,
    },
    {
      name: 'comment-arrow-game-before-policy',
      bytes: Buffer.from(controlHtml.replace('    <meta http-equiv="Content-Security-Policy"', '    <!-- --!>--><!-- -->\n    <meta http-equiv="Content-Security-Policy"'), 'utf8'),
      expectError: /Content-Security-Policy meta must be the first element/,
    },
    {
      name: 'comment-before-charset',
      bytes: Buffer.from(controlHtml.replace('  <head>\n    <meta charset="UTF-8" />', '  <head>\n    <!-- -->\n    <meta charset="UTF-8" />'), 'utf8'),
      expectError: /must begin with the canonical preamble/,
    },
    {
      name: 'unclosed-tag-swallowing-policy',
      bytes: Buffer.from(controlHtml.replace('    <meta http-equiv="Content-Security-Policy"', '    <div title="\n    <meta http-equiv="Content-Security-Policy"'), 'utf8'),
      expectError: /Content-Security-Policy meta must be the first element/,
    },
    {
      name: 'unclosed-charset-swallowing-policy',
      bytes: Buffer.from(controlHtml.replace('    <meta charset="UTF-8" />\n', '    <meta charset="UTF-8" data-x="\n'), 'utf8'),
      expectError: /must begin with the canonical preamble/,
    },
    {
      name: 'bom-at-start',
      bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), controlBytes]),
      expectError: /must begin with the canonical preamble/,
    },
    {
      name: 'non-ascii-nbsp-at-start',
      bytes: Buffer.from(`\u00a0${controlHtml}`, 'utf8'),
      expectError: /must begin with the canonical preamble/,
    },
    {
      name: 'non-ascii-em-space-at-start',
      bytes: Buffer.from(`\u2003${controlHtml}`, 'utf8'),
      expectError: /must begin with the canonical preamble/,
    },
    {
      name: 'policy-after-stylesheet-link',
      bytes: Buffer.from(
        controlHtml.replace(cspLine, '').replace(`${stylesheetTag}\n`, `${stylesheetTag}\n${cspLine}`),
        'utf8',
      ),
      expectError: /Content-Security-Policy meta must be the first element/,
    },
    {
      name: 'extra-attr-on-policy',
      bytes: Buffer.from(controlHtml.replace(`content="${viteCsp}" />`, `content="${viteCsp}" data-extra="1" />`), 'utf8'),
      expectError: /preamble must match the canonical emitted/,
    },
  ];

  for (const row of negativeCases) {
    assert.notDeepEqual(row.bytes, controlBytes, `${row.name} mutation must change control bytes`);
    await assert.rejects(runReceipt(row.name, row.bytes), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, row.expectError, row.name);
      return true;
    });
  }
});

test('probe-next-ingress.sh and finalize-release.sh share one exact effective CSP check matching Caddy', async () => {
  const probeScript = join(repo, 'deploy/site/probe-next-ingress.sh');
  const caddySource = await readFile(join(repo, 'deploy/site/commonswarm-site.caddy'), 'utf8');
  const refreshSource = await readFile(join(repo, 'deploy/site/refresh-site.py'), 'utf8');
  const probeSource = await readFile(probeScript, 'utf8');
  const finalizeSource = await readFile(join(repo, 'deploy/site/finalize-release.sh'), 'utf8');
  const caddyNextCsp = caddySource.match(/@next path \/next \/next\/\*\n\s*header @next \{\n\s*Content-Security-Policy "([^"]+)"/);
  assert.ok(caddyNextCsp, 'commonswarm-site.caddy @next block must declare Content-Security-Policy');
  const refreshNextCsp = refreshSource.match(/EXPECTED_NEXT_CSP\s*=\s*b"([^"]+)"/);
  assert.ok(refreshNextCsp, 'refresh-site.py must declare EXPECTED_NEXT_CSP');
  assert.equal(refreshNextCsp[1], caddyNextCsp[1], 'refresh-site.py EXPECTED_NEXT_CSP must match commonswarm-site.caddy');
  assert.match(probeSource, /refresh-site\.py" --check-next-csp/);
  assert.match(finalizeSource, /refresh-site\.py" --check-next-csp/);
  assert.match(probeSource, /refresh-site\.py" --check-next-html-headers/);
  assert.match(finalizeSource, /refresh-site\.py" --check-next-html-headers/);
  assert.doesNotMatch(probeSource, /has_header/);
  assert.doesNotMatch(finalizeSource, /has_header/);
  assert.doesNotMatch(probeSource, /grep .*frame-ancestors/);
  assert.doesNotMatch(finalizeSource, /grep .*frame-ancestors/);

  let statusMode: 200 | 404 | 302 | 503 = 404;
  let targetPath: string | null = null;
  let overrideCsp: string[] | null = null;
  const requested: string[] = [];
  const server = createServer((req, res) => {
    const urlPath = req.url ?? '/';
    requested.push(urlPath);
    const cspValues = targetPath === null || targetPath === urlPath
      ? (overrideCsp ?? ["frame-ancestors 'none'"])
      : ["frame-ancestors 'none'"];
    const headers: Record<string, string | string[]> = { 'content-type': 'text/html; charset=utf-8' };
    if (statusMode === 302) headers.location = '/next/';
    if (cspValues.length === 1) headers['content-security-policy'] = cspValues[0]!;
    else if (cspValues.length > 1) headers['content-security-policy'] = cspValues;
    res.writeHead(statusMode, headers);
    res.end(statusMode === 200 ? '<!doctype html><title>next</title>' : '<!doctype html><title>Page not found</title>');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    for (const [status, csp] of [
      [404, ["frame-ancestors 'none'"]],
      [200, ["frame-ancestors 'none'"]],
      [404, ["  frame-ancestors 'none' \t"]],
    ] as const) {
      statusMode = status;
      targetPath = null;
      overrideCsp = [...csp];
      requested.length = 0;
      const out = await exec('bash', [probeScript, baseUrl]);
      assert.match(out.stdout, /PASS probe-next-ingress/);
      assert.deepEqual(requested, ['/next', '/next/', '/next/index.html']);
    }
    const failingPolicies: Array<{ name: string; csp: string[]; reason: RegExp }> = [
      { name: 'missing', csp: [], reason: /reason=missing-csp/ },
      { name: 'duplicate-directive', csp: ["frame-ancestors https://example.com; frame-ancestors 'none'"], reason: /reason=csp-mismatch/ },
      { name: 'two-headers-conflicting', csp: ['frame-ancestors https://example.com', "frame-ancestors 'none'"], reason: /reason=multiple-csp/ },
      { name: 'two-headers-identical', csp: ["frame-ancestors 'none'", "frame-ancestors 'none'"], reason: /reason=multiple-csp/ },
      { name: 'longer-policy', csp: ["default-src 'self'; frame-ancestors 'none'"], reason: /reason=csp-mismatch/ },
      { name: 'wrong-csp', csp: ["default-src 'self'"], reason: /reason=csp-mismatch/ },
    ];
    statusMode = 404;
    for (const row of failingPolicies) {
      for (const path of ['/next', '/next/', '/next/index.html']) {
        targetPath = path;
        overrideCsp = row.csp;
        await assert.rejects(exec('bash', [probeScript, baseUrl]), (error: unknown) => {
          const stderr = (error as { stderr: string }).stderr;
          assert.match(stderr, new RegExp(`FAIL path=${path.replace(/\./g, '\\.')} status=404 `), `${row.name} on ${path}`);
          assert.match(stderr, row.reason, `${row.name} on ${path}`);
          return true;
        });
      }
    }
    for (const badStatus of [302, 503] as const) {
      statusMode = badStatus;
      targetPath = null;
      overrideCsp = ["frame-ancestors 'none'"];
      await assert.rejects(exec('bash', [probeScript, baseUrl]), (error: unknown) => {
        assert.match((error as { stderr: string }).stderr, /unexpected-status/);
        return true;
      });
    }
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('probe-next-ingress.sh --expect-sha verifies three paths, compressed and identity, browser UA, exact hash, and all required headers', async () => {
  const probeScript = join(repo, 'deploy/site/probe-next-ingress.sh');
  const htmlBody = Buffer.from(syntheticNextHtml(), 'utf8');
  const htmlSha = hash(htmlBody);
  const injectedBody = Buffer.from(syntheticNextHtml() + '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>', 'utf8');

  let statusMode = 200;
  let targetPath: string | null = null;
  let corruptEncoding: 'compressed' | 'identity' | null = null;
  let dropHeader: 'content-type' | 'csp' | 'nosniff' | 'referrer' | 'cache-control' | null = null;
  let overrideContentType: string | null = null;
  let overrideCacheControl: string | null = null;
  const seen: Array<{ path: string; ua: string; accept: string; ae: string }> = [];

  const server = createServer((req, res) => {
    const urlPath = req.url ?? '/';
    const ua = String(req.headers['user-agent'] ?? '');
    const accept = String(req.headers.accept ?? '');
    const ae = String(req.headers['accept-encoding'] ?? '');
    seen.push({ path: urlPath, ua, accept, ae });

    const isIdentity = ae.trim().toLowerCase() === 'identity';
    const isCompressed = !isIdentity && ae.toLowerCase().includes('gzip');
    const faultHere = targetPath === null || targetPath === urlPath;

    const headers: Record<string, string | string[]> = {};
    if (!(faultHere && dropHeader === 'content-type')) {
      headers['content-type'] = (faultHere && overrideContentType) ? overrideContentType : 'text/html; charset=utf-8';
    }
    if (!(faultHere && dropHeader === 'csp')) {
      headers['content-security-policy'] = "frame-ancestors 'none'";
    }
    if (!(faultHere && dropHeader === 'nosniff')) {
      headers['x-content-type-options'] = 'nosniff';
    }
    if (!(faultHere && dropHeader === 'referrer')) {
      headers['referrer-policy'] = 'no-referrer';
    }
    if (!(faultHere && dropHeader === 'cache-control')) {
      headers['cache-control'] = (faultHere && overrideCacheControl) ? overrideCacheControl : 'no-cache';
    }

    const body = faultHere && (
      (corruptEncoding === 'compressed' && isCompressed) ||
      (corruptEncoding === 'identity' && isIdentity)
    ) ? injectedBody : htmlBody;

    const payload = isCompressed ? gzipSync(body) : body;
    if (isCompressed) headers['content-encoding'] = 'gzip';
    res.writeHead(faultHere ? statusMode : 200, headers);
    res.end(payload);
  });

  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    // Reject invalid --expect-sha CLI values fail-closed (exit 2).
    for (const badArgs of [
      [baseUrl, '--expect-sha'],
      [baseUrl, '--expect-sha', ''],
      [baseUrl, '--expect-sha', 'not-a-sha'],
      [baseUrl, '--expect-sha', htmlSha.toUpperCase()],
      ['--expect-sha', htmlSha, '--expect-sha', htmlSha, baseUrl],
    ]) {
      await assert.rejects(exec('bash', [probeScript, ...badArgs]), (error: unknown) => {
        assert.equal((error as { code: number }).code, 2);
        return true;
      });
    }

    // Pass case: all three paths x both encodings with browser UA and Accept: text/html.
    seen.length = 0;
    const passed = await exec('bash', [probeScript, baseUrl, '--expect-sha', htmlSha]);
    assert.match(passed.stdout, /PASS probe-next-ingress/);
    assert.equal(seen.length, 6);
    for (const path of ['/next', '/next/', '/next/index.html']) {
      const forPath = seen.filter(r => r.path === path);
      assert.equal(forPath.length, 2, path);
      assert.ok(forPath.every(r => r.ua.startsWith('Mozilla/5.0 ') && r.accept.includes('text/html')), path);
      assert.ok(forPath.some(r => r.ae.toLowerCase().includes('gzip') && r.ae.trim().toLowerCase() !== 'identity'), `${path} compressed`);
      assert.ok(forPath.some(r => r.ae.trim().toLowerCase() === 'identity'), `${path} identity`);
    }

    // Flag-before-URL ordering also works.
    const passedAlt = await exec('bash', [probeScript, `--expect-sha=${htmlSha}`, baseUrl]);
    assert.match(passedAlt.stdout, /PASS probe-next-ingress/);

    // Body mismatch under compression only (identity clean) and under identity only (compression clean).
    for (const encoding of ['compressed', 'identity'] as const) {
      for (const path of ['/next', '/next/', '/next/index.html']) {
        targetPath = path;
        corruptEncoding = encoding;
        await assert.rejects(exec('bash', [probeScript, baseUrl, '--expect-sha', htmlSha]), (error: unknown) => {
          const stderr = (error as { stderr: string }).stderr;
          assert.match(stderr, new RegExp(`FAIL path=${path.replace(/\./g, '\\.')} encoding=${encoding} status=200 reason=body-sha-mismatch`), `${encoding} on ${path}`);
          return true;
        });
      }
    }
    corruptEncoding = null;

    // Non-200 (including 404, which preview-off accepts) fails under --expect-sha.
    for (const badStatus of [404, 302] as const) {
      statusMode = badStatus;
      targetPath = '/next/';
      await assert.rejects(exec('bash', [probeScript, baseUrl, '--expect-sha', htmlSha]), (error: unknown) => {
        assert.match((error as { stderr: string }).stderr, new RegExp(`FAIL path=/next/ encoding=compressed status=${badStatus} reason=unexpected-status`));
        return true;
      });
    }
    statusMode = 200;

    // Each missing or wrong required header fails with its specific reason.
    const headerCases: Array<{
      name: string;
      path: string;
      drop?: 'content-type' | 'csp' | 'nosniff' | 'referrer' | 'cache-control';
      ct?: string;
      cc?: string;
      reason: RegExp;
    }> = [
      { name: 'missing-content-type', path: '/next', drop: 'content-type', reason: /reason=content-type-mismatch/ },
      { name: 'wrong-content-type', path: '/next/', ct: 'text/plain; charset=utf-8', reason: /reason=content-type-mismatch/ },
      { name: 'missing-csp', path: '/next/index.html', drop: 'csp', reason: /reason=missing-csp/ },
      { name: 'missing-nosniff', path: '/next', drop: 'nosniff', reason: /reason=missing-nosniff/ },
      { name: 'missing-referrer', path: '/next/', drop: 'referrer', reason: /reason=missing-referrer-policy/ },
      { name: 'missing-cache-control', path: '/next/index.html', drop: 'cache-control', reason: /reason=cache-control-mismatch/ },
      { name: 'wrong-cache-control', path: '/next/', cc: 'public, max-age=0, must-revalidate', reason: /reason=cache-control-mismatch/ },
    ];
    for (const row of headerCases) {
      targetPath = row.path;
      dropHeader = row.drop ?? null;
      overrideContentType = row.ct ?? null;
      overrideCacheControl = row.cc ?? null;
      await assert.rejects(exec('bash', [probeScript, baseUrl, '--expect-sha', htmlSha]), (error: unknown) => {
        assert.match((error as { stderr: string }).stderr, row.reason, row.name);
        return true;
      });
    }
    dropHeader = null;
    overrideContentType = null;
    overrideCacheControl = null;
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('refresh-site.py --check-next-html-headers and probe-next-ingress.sh --expect-sha reject interim-only headers, duplicate final headers, and malformed lines', async () => {
  const refreshScript = join(repo, 'deploy/site/refresh-site.py');
  const probeScript = join(repo, 'deploy/site/probe-next-ingress.sh');
  const headerFile = join(root, 'check-headers.txt');

  const validFinalLines = [
    'Content-Type: text/html; charset=utf-8',
    "Content-Security-Policy: frame-ancestors 'none'",
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: no-referrer',
    'Cache-Control: no-cache',
  ];
  const valid103Block = [
    'HTTP/1.1 103 Early Hints',
    ...validFinalLines,
    '',
  ].join('\r\n');
  const makeDump = (statusLine: string, lines: string[], prefix = '') =>
    `${prefix}${statusLine}\r\n${lines.join('\r\n')}\r\n\r\n`;

  // Direct parser pass cases: HTTP/1.1, HTTP/2, OWS, case-insensitive non-CSP values, and 103 + valid 200.
  for (const [label, payload] of [
    ['http11-valid', makeDump('HTTP/1.1 200 OK', validFinalLines)],
    ['http2-valid', makeDump('HTTP/2 200 ', [
      'content-type:  TEXT/HTML ; charset=utf-8 \t',
      "content-security-policy: \tframe-ancestors 'none' ",
      'x-content-type-options:  NOSNIFF\t',
      'referrer-policy: No-Referrer ',
      'cache-control: NO-CACHE',
    ])],
    ['early-hints-plus-valid-200', makeDump('HTTP/1.1 200 OK', validFinalLines, `${valid103Block}\r\n`)],
  ] as const) {
    await writeFile(headerFile, payload, 'binary');
    await exec('python3', [refreshScript, '--check-next-html-headers', headerFile]);
    await exec('python3', [refreshScript, '--check-next-csp', headerFile]);
    assert.ok(label);
  }

  // Direct parser rejection cases: interim-only, duplicates, wrong values, obs-fold, control/non-ASCII, malformed lines.
  const directFailures: Array<{ name: string; bytes: Buffer; reason: RegExp }> = [
    { name: 'interim-103-only', bytes: Buffer.from(`${valid103Block}\r\n`, 'binary'), reason: /^invalid-http-headers$/m },
    { name: 'no-colon', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', [...validFinalLines, 'MalformedLine']), 'binary'), reason: /^invalid-http-headers$/m },
    { name: 'empty-name', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', [...validFinalLines, ': value']), 'binary'), reason: /^invalid-http-headers$/m },
    { name: 'space-in-name', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', [...validFinalLines, 'X-Bad Name: 1']), 'binary'), reason: /^invalid-http-headers$/m },
    { name: 'obs-fold-space', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', [...validFinalLines, ' continuation']), 'binary'), reason: /^invalid-http-headers$/m },
    { name: 'obs-fold-tab', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', [...validFinalLines, '\tcontinuation']), 'binary'), reason: /^invalid-http-headers$/m },
    { name: 'control-vtab', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', ['Content-Type: text/html\x0b; charset=utf-8', ...validFinalLines.slice(1)]), 'binary'), reason: /^invalid-http-headers$/m },
    { name: 'embedded-cr', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', ['Cache-Control: no-cache\r', ...validFinalLines.slice(0, 4)]), 'binary'), reason: /^invalid-http-headers$/m },
    { name: 'non-ascii-nbsp', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', ['Content-Type: text/html;\u00a0charset=utf-8', ...validFinalLines.slice(1)]), 'utf8'), reason: /^invalid-http-headers$/m },
    { name: 'wrong-nosniff', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', validFinalLines.map(l => l.startsWith('X-Content-Type-Options:') ? 'X-Content-Type-Options: sniff' : l)), 'binary'), reason: /^nosniff-mismatch$/m },
    { name: 'wrong-referrer', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', validFinalLines.map(l => l.startsWith('Referrer-Policy:') ? 'Referrer-Policy: origin' : l)), 'binary'), reason: /^referrer-policy-mismatch$/m },
    { name: 'dup-content-type', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', [...validFinalLines, 'Content-Type: text/plain']), 'binary'), reason: /^multiple-content-type$/m },
    { name: 'dup-csp', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', [...validFinalLines, 'Content-Security-Policy: frame-ancestors https://example.com']), 'binary'), reason: /^multiple-csp$/m },
    { name: 'dup-nosniff', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', [...validFinalLines, 'X-Content-Type-Options: nosniff']), 'binary'), reason: /^multiple-nosniff$/m },
    { name: 'dup-referrer', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', [...validFinalLines, 'Referrer-Policy: unsafe-url']), 'binary'), reason: /^multiple-referrer-policy$/m },
    { name: 'dup-cache-control', bytes: Buffer.from(makeDump('HTTP/1.1 200 OK', [...validFinalLines, 'Cache-Control: public, max-age=3600']), 'binary'), reason: /^multiple-cache-control$/m },
  ];
  for (const row of directFailures) {
    await writeFile(headerFile, row.bytes);
    await assert.rejects(exec('python3', [refreshScript, '--check-next-html-headers', headerFile]), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, row.reason, row.name);
      return true;
    });
  }

  // Raw TCP HTTP/1.1 fixture driving probe-next-ingress.sh --expect-sha with 103 Early Hints and duplicate final headers.
  const htmlBody = Buffer.from(syntheticNextHtml(), 'utf8');
  const htmlSha = hash(htmlBody);
  let send103 = false;
  let finalHeaderOverride: (urlPath: string) => string[] = () => [...validFinalLines];

  const tcpServer = createTcpServer((socket) => {
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1');
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const head = buffered.slice(0, headerEnd).split('\r\n');
      const reqLine = head[0] ?? 'GET / HTTP/1.1';
      const urlPath = reqLine.split(' ')[1] ?? '/';
      let ae = '';
      for (const line of head.slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0 && line.slice(0, idx).trim().toLowerCase() === 'accept-encoding') {
          ae = line.slice(idx + 1).trim();
        }
      }
      const isIdentity = ae.toLowerCase() === 'identity';
      const isCompressed = !isIdentity && ae.toLowerCase().includes('gzip');
      const payload = isCompressed ? gzipSync(htmlBody) : htmlBody;
      const finalHeaders = [
        ...finalHeaderOverride(urlPath),
        ...(isCompressed ? ['Content-Encoding: gzip'] : []),
        `Content-Length: ${payload.length}`,
        'Connection: close',
      ];
      const prefix = send103 ? `${valid103Block}\r\n` : '';
      const responseHead = `${prefix}HTTP/1.1 200 OK\r\n${finalHeaders.join('\r\n')}\r\n\r\n`;
      socket.end(Buffer.concat([Buffer.from(responseHead, 'latin1'), payload]));
    });
  });

  await new Promise<void>(r => tcpServer.listen(0, '127.0.0.1', r));
  const address = tcpServer.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    // 103 Early Hints followed by a valid final 200 OK must pass.
    send103 = true;
    finalHeaderOverride = () => [...validFinalLines];
    const okWith103 = await exec('bash', [probeScript, baseUrl, '--expect-sha', htmlSha]);
    assert.match(okWith103.stdout, /PASS probe-next-ingress/);

    // 103 Early Hints supplies all five valid headers, while final 200 OK serves exact body + valid CSP with bad final headers.
    const interimBypassCases: Array<{ name: string; lines: string[]; reason: RegExp }> = [
      {
        name: '103-bad-content-type',
        lines: validFinalLines.map(l => l.startsWith('Content-Type:') ? 'Content-Type: text/plain; charset=utf-8' : l),
        reason: /reason=content-type-mismatch/,
      },
      {
        name: '103-bad-cache-control',
        lines: validFinalLines.map(l => l.startsWith('Cache-Control:') ? 'Cache-Control: public, max-age=60' : l),
        reason: /reason=cache-control-mismatch/,
      },
      {
        name: '103-missing-referrer-policy',
        lines: validFinalLines.filter(l => !l.startsWith('Referrer-Policy:')),
        reason: /reason=missing-referrer-policy/,
      },
      {
        name: '103-missing-nosniff',
        lines: validFinalLines.filter(l => !l.startsWith('X-Content-Type-Options:')),
        reason: /reason=missing-nosniff/,
      },
      {
        name: '103-all-four-bad',
        lines: [
          'Content-Type: text/plain; charset=utf-8',
          "Content-Security-Policy: frame-ancestors 'none'",
          'Cache-Control: public, max-age=60',
        ],
        reason: /reason=content-type-mismatch/,
      },
    ];
    for (const row of interimBypassCases) {
      send103 = true;
      finalHeaderOverride = (urlPath) => urlPath === '/next/' ? row.lines : [...validFinalLines];
      await assert.rejects(exec('bash', [probeScript, baseUrl, '--expect-sha', htmlSha]), (error: unknown) => {
        const stderr = (error as { stderr: string }).stderr;
        assert.match(stderr, /FAIL path=\/next\/ /, row.name);
        assert.match(stderr, row.reason, row.name);
        return true;
      });
    }

    // Conflicting duplicate headers on the final 200 OK response must fail.
    send103 = false;
    const duplicateCases: Array<{ name: string; extra: string; reason: RegExp }> = [
      { name: 'dup-content-type', extra: 'Content-Type: text/plain; charset=utf-8', reason: /reason=multiple-content-type/ },
      { name: 'dup-csp', extra: 'Content-Security-Policy: frame-ancestors https://example.com', reason: /reason=multiple-csp/ },
      { name: 'dup-nosniff', extra: 'X-Content-Type-Options: nosniff', reason: /reason=multiple-nosniff/ },
      { name: 'dup-referrer', extra: 'Referrer-Policy: unsafe-url', reason: /reason=multiple-referrer-policy/ },
      { name: 'dup-cache-control', extra: 'Cache-Control: public, max-age=3600', reason: /reason=multiple-cache-control/ },
    ];
    for (const row of duplicateCases) {
      finalHeaderOverride = (urlPath) => urlPath === '/next/index.html' ? [...validFinalLines, row.extra] : [...validFinalLines];
      await assert.rejects(exec('bash', [probeScript, baseUrl, '--expect-sha', htmlSha]), (error: unknown) => {
        const stderr = (error as { stderr: string }).stderr;
        assert.match(stderr, /FAIL path=\/next\/index\.html /, row.name);
        assert.match(stderr, row.reason, row.name);
        return true;
      });
    }
  } finally {
    await new Promise<void>(r => tcpServer.close(() => r()));
  }
});

test(`${lane}: rendered Linux release swaps bytes, retains reserves, and rolls back failures and drift`, { skip: !linuxProof }, async () => {
  const curl = (await exec('which', ['curl'])).stdout.trim();
  const nextVariants = new Set([
    'next-success', 'next-status', 'next-slash-status', 'next-body', 'next-index-body',
    'next-browser-ua-inject', 'next-identity-inject', 'next-slash-cache', 'next-index-content-type',
    'next-header', 'next-header-duplicate-directive',
    'next-header-two-headers', 'next-header-longer-policy', 'next-asset-status',
    'next-preflip-missing-root', 'next-preflip-missing-slash', 'next-preflip-missing-index',
    'next-preflip-duplicate-directive', 'next-preflip-two-headers', 'next-preflip-longer-policy',
  ]);
  for (const variant of ['success', 'next-success', 'root-status', 'app-status', 'root-body', 'app-body', 'next-status', 'next-slash-status', 'next-body', 'next-index-body', 'next-browser-ua-inject', 'next-identity-inject', 'next-slash-cache', 'next-index-content-type', 'next-header', 'next-header-duplicate-directive', 'next-header-two-headers', 'next-header-longer-policy', 'next-asset-status', 'next-preflip-missing-root', 'next-preflip-missing-slash', 'next-preflip-missing-index', 'next-preflip-duplicate-directive', 'next-preflip-two-headers', 'next-preflip-longer-policy', 'curl-failure', 'asset-drift', 'current-drift', 'artifact-pin', 'build-pin', 'closed-pipe', 'closed-pipe-failure', 'find-failure', 'flip-failure', 'missing-old', 'rollback-status', 'hup', 'unchanged-unhealthy']) {
    const useNext = nextVariants.has(variant);
    const packet = await prepare(`run-${variant}`, undefined, useNext ? await artifactDirWithNext() : undefined);
    const site = join(root, `site-${variant}`), old = join(site, 'releases/old');
    await mkdir(join(old, 'app'), { recursive: true }); await writeFile(join(old, 'index.html'), 'old root'); await writeFile(join(old, 'app/index.html'), 'old app');
    await mkdir(join(old, '_astro'), { recursive: true }); await writeFile(join(old, '_astro/retained.js'), 'old asset');
    await symlink('releases/old', join(site, 'current')); await mkdir(join(site, 'releases/reserve'));
    const oldProbes = new Set<string>();
    const newProbes = new Set<string>();
    const newNextRequests: Array<{ path: string; ua: string; accept: string; ae: string }> = [];
    let unhealthyOldApp = false;
    let notifyHeld!: () => void, releaseHeld!: () => void;
    const probeHeld = new Promise<void>(r => { notifyHeld = r; });
    const probeReleased = new Promise<void>(r => { releaseHeld = r; });
    const server = createServer(async (req, res) => {
      if (variant === 'closed-pipe-failure' && (await readlink(join(site, 'current'))) !== 'releases/old') { res.writeHead(503); res.end(); return; }
      if (variant === 'rollback-status') { res.writeHead(503); res.end(); return; }
      const urlPath = req.url ?? '/';
      const ua = String(req.headers['user-agent'] ?? '');
      const accept = String(req.headers.accept ?? '');
      const ae = String(req.headers['accept-encoding'] ?? '');
      const isNew = (await readlink(join(site, 'current'))) !== 'releases/old';
      const isNextHtml = urlPath === '/next' || urlPath === '/next/' || urlPath === '/next/index.html';
      if (isNew && variant === 'hup') { notifyHeld(); await probeReleased; }
      if (isNew) {
        newProbes.add(urlPath);
        if (isNextHtml) newNextRequests.push({ path: urlPath, ua, accept, ae });
      }
      if (!isNew) oldProbes.add(urlPath);
      if (!isNew && unhealthyOldApp && urlPath === '/app') { res.writeHead(503); res.end(); return; }
      if (isNew && variant === 'root-status' && urlPath === '/') { res.writeHead(503); res.end('unavailable'); return; }
      if (isNew && variant === 'app-status' && urlPath === '/app') { res.writeHead(503); res.end('unavailable'); return; }
      if (isNew && variant === 'next-status' && urlPath === '/next') { res.writeHead(503); res.end('unavailable'); return; }
      if (isNew && variant === 'next-slash-status' && urlPath === '/next/') { res.writeHead(503); res.end('unavailable'); return; }
      if (isNew && variant === 'next-asset-status' && urlPath.startsWith('/next/') && !isNextHtml) { res.writeHead(404); res.end('missing'); return; }
      if (isNew && variant === 'root-body' && urlPath === '/') { res.end('wrong HTML'); return; }
      if (isNew && variant === 'app-body' && urlPath === '/app') { res.end('wrong HTML'); return; }
      if (isNew && variant === 'next-body' && urlPath === '/next') { res.end('wrong HTML'); return; }
      if (isNew && variant === 'next-index-body' && urlPath === '/next/index.html') { res.end('wrong HTML'); return; }
      const route = urlPath === '/app' ? 'app/index.html' : (urlPath === '/next' || urlPath === '/next/') ? 'next/index.html' : urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
      const nextCspOverride = (): string[] | undefined => {
        if (!isNew) {
          if (
            (variant === 'next-preflip-missing-root' && urlPath === '/next') ||
            (variant === 'next-preflip-missing-slash' && urlPath === '/next/') ||
            (variant === 'next-preflip-missing-index' && urlPath === '/next/index.html')
          ) return [];
          if (variant === 'next-preflip-duplicate-directive' && urlPath === '/next/') return ["frame-ancestors https://example.com; frame-ancestors 'none'"];
          if (variant === 'next-preflip-two-headers' && urlPath === '/next/index.html') return ['frame-ancestors https://example.com', "frame-ancestors 'none'"];
          if (variant === 'next-preflip-longer-policy' && urlPath === '/next') return ["default-src 'self'; frame-ancestors 'none'"];
        } else {
          if (variant === 'next-header') return [];
          if (variant === 'next-header-duplicate-directive') return ["frame-ancestors https://example.com; frame-ancestors 'none'"];
          if (variant === 'next-header-two-headers') return ['frame-ancestors https://example.com', "frame-ancestors 'none'"];
          if (variant === 'next-header-longer-policy') return ["default-src 'self'; frame-ancestors 'none'"];
        }
        return undefined;
      };
      const cspOverride = nextCspOverride();
      const cspHeader = cspOverride === undefined
        ? { 'content-security-policy': "frame-ancestors 'none'" }
        : cspOverride.length === 0
          ? {}
          : { 'content-security-policy': cspOverride.length === 1 ? cspOverride[0]! : cspOverride };
      const nextHeaders: Record<string, string | string[]> = useNext && (urlPath === '/next' || urlPath.startsWith('/next/'))
        ? {
            ...cspHeader,
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            ...(isNew && isNextHtml ? {
              'content-type': variant === 'next-index-content-type' && urlPath === '/next/index.html'
                ? 'text/plain; charset=utf-8'
                : 'text/html; charset=utf-8',
              'cache-control': variant === 'next-slash-cache' && urlPath === '/next/'
                ? 'public, max-age=0, must-revalidate'
                : 'no-cache',
            } : {}),
          }
        : {};
      try {
        let body = await readFile(join(site, 'current', route));
        const isIdentity = ae.trim().toLowerCase() === 'identity';
        const isCompressed = !isIdentity && ae.toLowerCase().includes('gzip');
        if (isNew && isNextHtml) {
          if (variant === 'next-browser-ua-inject' && ua.startsWith('Mozilla/')) {
            body = Buffer.concat([body, Buffer.from('<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>')]);
          }
          if (variant === 'next-identity-inject' && isIdentity) {
            body = Buffer.concat([body, Buffer.from('<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>')]);
          }
        }
        const payload = isNew && isNextHtml && isCompressed ? gzipSync(body) : body;
        if (isNew && isNextHtml && isCompressed) nextHeaders['content-encoding'] = 'gzip';
        res.writeHead(200, nextHeaders);
        res.end(payload);
      } catch { res.writeHead(404, nextHeaders); res.end(); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address === 'object');
    const bin = join(root, `bin-${variant}`); await mkdir(bin);
    await writeFile(join(bin, 'hostname'), '#!/bin/sh\necho yulan-vps-1\n');
    await writeFile(join(bin, 'curl'), `#!/bin/bash\nargs=(); for a in "$@"; do case "$a" in https://commonswarm.com*) args+=("http://127.0.0.1:${address.port}\${a#https://commonswarm.com}");; *) args+=("$a");; esac; done\n${variant === 'curl-failure' ? `if [[ $(readlink '${site}/current') != releases/old ]]; then exit 7; fi\nexec ${curl} "\${args[@]}"` : `exec ${curl} "\${args[@]}"`}\n`);
    // Simulate a concurrent pointer edit during permissions normalization.
    await writeFile(join(bin, 'chmod'), `#!/bin/sh\n/bin/chmod "$@"\n${variant === 'current-drift' ? `ln -sfn releases/reserve '${site}/current'` : ':'}\n`);
    await writeFile(join(bin, 'find'), `#!/bin/sh\n${variant === 'find-failure' ? 'case "$*" in *"-type d -exec"*) exit 1;; esac\nexec /usr/bin/find "$@"' : 'exec /usr/bin/find "$@"'}\n`);
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
      if (['success', 'next-success', 'closed-pipe', 'missing-old', 'unchanged-unhealthy'].includes(variant)) {
        const completed = await run();
        assert.equal(completed.stdout, ''); assert.equal(completed.stderr, '');
        const deployLog = await readFile(join(packet, 'hostrun.log'), 'utf8');
        assert.match(deployLog, useNext ? /PASS deploy .* NEXT=1/ : /PASS deploy .* NEXT=0/);
        if (useNext) {
          for (const p of ['/next', '/next/', '/next/index.html']) {
            assert.ok(newProbes.has(p), `preview-on release must probe ${p}`);
            const forPath = newNextRequests.filter(r => r.path === p);
            assert.ok(forPath.some(r => r.ua.startsWith('CommonSwarmReleaseCheck/')), `${p} release-check UA`);
            assert.ok(forPath.some(r => r.ua.startsWith('Mozilla/5.0 ') && r.accept.includes('text/html') && r.ae.toLowerCase().includes('gzip') && r.ae.trim().toLowerCase() !== 'identity'), `${p} browser compressed`);
            assert.ok(forPath.some(r => r.ua.startsWith('Mozilla/5.0 ') && r.accept.includes('text/html') && r.ae.trim().toLowerCase() === 'identity'), `${p} browser identity`);
          }
        } else assert.equal([...newProbes].some(p => p === '/next' || p.startsWith('/next/')), false, 'preview-off release must not probe /next');
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
        if (variant === 'unchanged-unhealthy') {
          // Root still returns 200: the already-old path must also probe /app.
          unhealthyOldApp = true;
          const offset = (await readFile(join(packet, 'hostrun.log'), 'utf8')).length;
          await assert.rejects(exec('bash', [join(packet, 'run.sh'), 'rollback'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }), (error: unknown) => {
            assert.equal((error as { code: number }).code, 1); return true;
          });
          const failure = (await readFile(join(packet, 'hostrun.log'), 'utf8')).slice(offset);
          assert.match(failure, /assertion=rollback-httpstatus/); assert.doesNotMatch(failure, /PASS rollback/);
          assert.equal(await readlink(join(site, 'current')), 'releases/old');
          unhealthyOldApp = false;
        }
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
        if (['root-status', 'app-status', 'next-status', 'next-slash-status', 'next-asset-status'].includes(variant)) assert.match(output, /assertion=httpstatus/);
        if (['root-body', 'app-body', 'next-body', 'next-index-body', 'next-browser-ua-inject', 'next-identity-inject'].includes(variant)) assert.match(output, /assertion=httphash/);
        if (variant === 'next-slash-cache') {
          assert.match(output, /assertion=next-html-headers/);
          assert.match(output, /cache-control-mismatch/);
        }
        if (variant === 'next-index-content-type') {
          assert.match(output, /assertion=next-html-headers/);
          assert.match(output, /content-type-mismatch/);
        }
        if (variant === 'next-header' || variant.startsWith('next-header-')) {
          assert.match(output, /assertion=next-html-headers/);
          assert.match(output, /(?:missing-csp|csp-mismatch|multiple-csp)/);
        }
        if (variant.startsWith('next-preflip-')) {
          assert.match(output, /assertion=preflip-next-csp/);
          assert.doesNotMatch(output, /PASS rollback/);
          assert.equal(newProbes.size, 0, 'pre-flip ingress failure must refuse before switching');
        }
        if (['root-status', 'app-status', 'next-status', 'next-slash-status', 'next-asset-status', 'root-body', 'app-body', 'next-body', 'next-index-body', 'next-browser-ua-inject', 'next-identity-inject', 'next-slash-cache', 'next-index-content-type', 'next-header', 'next-header-duplicate-directive', 'next-header-two-headers', 'next-header-longer-policy', 'curl-failure', 'closed-pipe-failure', 'hup'].includes(variant)) assert.match(output, /PASS rollback/);
        if (variant === 'asset-drift') assert.match(output, /Refusing site refresh: asset byte collision/);
        if (variant === 'current-drift') assert.match(output, /assertion=exact-old-link/);
        if (variant === 'artifact-pin') assert.match(output, /assertion=artifactSHA/);
        if (variant === 'build-pin') assert.match(output, /assertion=buildSHA/);
        if (variant === 'flip-failure') assert.match(output, /PASS rollback unchanged/);
        if (variant === 'rollback-status') assert.match(output, /assertion=rollback-httpstatus/);
        if (variant === 'find-failure') assert.match(output, /FAIL step=assets-and-freshness/);
        assert.equal(await readlink(join(site, 'current')), variant === 'current-drift' ? 'releases/reserve' : 'releases/old');
      }
      if (['success', 'closed-pipe', 'closed-pipe-failure', 'missing-old', 'root-status', 'app-status', 'root-body', 'app-body', 'curl-failure', 'hup', 'unchanged-unhealthy'].includes(variant)) assert.deepEqual([...oldProbes].sort(), ['/', '/app']);
      if (['next-success', 'next-status', 'next-slash-status', 'next-body', 'next-index-body', 'next-browser-ua-inject', 'next-identity-inject', 'next-slash-cache', 'next-index-content-type', 'next-header', 'next-header-duplicate-directive', 'next-header-two-headers', 'next-header-longer-policy', 'next-asset-status'].includes(variant)) assert.deepEqual([...oldProbes].sort(), ['/', '/app', '/next', '/next/', '/next/index.html']);
      assert.equal((await stat(join(packet, 'hostrun.log'))).mode & 0o777, 0o600);
      assert.ok((await readdir(join(site, 'releases'))).includes('reserve'));
      assert.equal(await readFile(join(old, '_astro/retained.js'), 'utf8'), 'old asset');
    } finally { await new Promise<void>(r => server.close(() => r())); }
  }
});

// The builder refuses anything but root on Linux, so these rows run in the root
// lane and skip elsewhere. The fixture repository commits the working-tree
// builder, because the builder only runs bytes equal to the revision it builds.
// Docker is the only stub; it records each removal and whether the workspace
// was still there, and can refuse to confirm that the container is gone.
test('builder removes its own container and then its own workspace, keeps the artifact and logs, and keeps the workspace when the container is not confirmed removed', { skip: !linuxProof }, async () => {
  const src = join(root, 'builder-repo'), state = join(root, 'builder-docker'), bin = join(state, 'bin');
  await mkdir(bin, { recursive: true });
  for (const path of sourcePaths) { await mkdir(join(src, path, '..'), { recursive: true }); await cp(join(repo, path), join(src, path)); }
  const git = (...args: string[]) => exec('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: src });
  await git('init', '-q'); await git('add', '-f', '.'); await git('commit', '-qm', 'fixture');
  const revision = (await git('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(join(state, 'site.tar'), syntheticSite());
  await writeFile(join(bin, 'docker'), `#!/bin/bash
state='${state}'; verb=$1; name=\${!#}; mode=$(cat "$state/mode")
workspace() { [[ -d /var/tmp/cswarm-site-build.\${1#cswarm-site-} ]] && echo present || echo gone; }
case "$verb" in
  pull) echo fixture pull;;
  run) while [[ $# -gt 1 && $1 != --name ]]; do shift; done; name=$2; cat >/dev/null
    case "$mode" in
      container|daemon|survivor) echo 'fixture container failure' >&2; exit 37;;
      term) : > "$state/held"; until [[ -e $state/release ]]; do sleep 0.1; done; workspace "$name" > "$state/run-end";;
      *) cat "$state/site.tar";;
    esac;;
  rm) echo "$name $(workspace "$name")" >> "$state/rm.log"; [[ $mode != daemon ]];;
  ps) [[ $mode != daemon ]] || exit 1; [[ $mode != survivor ]] || echo fixture-container;;
  *) exit 64;;
esac
`);
  await chmod(join(bin, 'docker'), 0o755);
  // A temp directory mounted noexec makes PATH skip the stub and reach any real docker.
  await writeFile(join(state, 'mode'), 'success');
  const probe = await exec(join(bin, 'docker'), ['pull']).then(done => done.stdout, (error: Error) => error.message);
  assert.equal(probe, 'fixture pull\n', 'the docker stub must be executable from the test temp directory (noexec mount?)');
  const partial =['build.log', 'public.json', 'site.tar', 'source.tar'];
  const expected = {
    success: { code: 0, kept: ['BUILD.json', 'build.log', 'finalize-release.sh', 'public.json', 'site.tar', 'source.tar'], retained: false },
    config: { code: 1, kept: ['source.tar'], retained: false },
    container: { code: 37, kept: partial, retained: false },
    term: { code: 143, kept: partial, retained: false },
    // Docker cannot confirm the container is gone: its daemon fails, or the container is still listed.
    daemon: { code: 37, kept: partial, retained: true },
    survivor: { code: 37, kept: partial, retained: true },
  };
  // Another build's workspace: cleanup must remove one exact directory, never the pattern.
  const sibling = await mkdtemp('/var/tmp/cswarm-site-build.');
  try {
    for (const row of ['success', 'config', 'container', 'term', 'daemon', 'survivor'] as const) {
      const out = join(root, `built-${row}`), input = join(state, `${row}.json`);
      await writeFile(input, JSON.stringify(row === 'config' ? { ...config, PUBLIC_SUPABASE_URL: 'https://other.invalid' } : config));
      await writeFile(join(state, 'mode'), row);
      for (const name of ['rm.log', 'held', 'release', 'run-end']) await rm(join(state, name), { force: true });
      const running = exec('bash', [join(src, 'deploy/site/build-artifact.sh'), revision, input, '1', out], { env: cleanNextEnv({ PATH: `${bin}:${process.env.PATH}` }) });
      const settled = running.then(done => ({ code: 0 as number | null, ...done }), (error: unknown) => error as { code: number | null; stdout: string; stderr: string });
      let job: string | undefined;
      try {
        if (row === 'term') {
          const held = async () => {
            for (let i = 0; i < 100; i++) { try { await stat(join(state, 'held')); return true; } catch { await new Promise(r => setTimeout(r, 100)); } }
            return false;
          };
          assert.equal(await Promise.race([held(), settled.then(() => false)]), true, 'builder must reach the container run');
          assert.equal(running.child.kill('SIGTERM'), true, 'send TERM to the builder');
          // Leave room for a premature cleanup before the held run is allowed to end.
          await new Promise(r => setTimeout(r, 500));
          await writeFile(join(state, 'release'), '');
        }
        const result = await settled;
        job = /\/var\/tmp\/cswarm-site-build\.\w{6}\b/.exec(result.stdout)?.[0];
        const log = await readFile(join(out, 'build.log'), 'utf8').catch(() => '(none)');
        const evidence = `${row}: exit ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}\nbuild.log: ${log}`;
        assert.ok(job, `builder must name its workspace. ${evidence}`);
        if (expected[row].retained) {
          assert.ok((await stat(job)).isDirectory(), `${row}: workspace must stay while its container is not confirmed removed`);
          assert.ok(result.stderr.includes('Build workspace retained') && result.stderr.includes(job), `${row}: retention must be reported with the path: ${result.stderr}`);
        } else await assert.rejects(stat(job), { code: 'ENOENT' }, `${row}: build workspace must be removed`);
        if (row === 'term') assert.equal((await readFile(join(state, 'run-end'), 'utf8')).trim(), 'present', 'workspace must outlive the container run');
        const removals = (await readFile(join(state, 'rm.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
        assert.ok(removals.every(line => line === `cswarm-site-${job!.slice(-6)} present`), `${row}: only its own container, before the workspace: ${removals}`);
        if (row !== 'success' && row !== 'config') assert.ok(removals.length > 0, `${row}: container removal must be attempted`);
        assert.equal(result.code, expected[row].code, evidence);
        assert.deepEqual((await readdir(out)).sort(), expected[row].kept);
        if (row === 'success') {
          assert.match(result.stdout, /^PASS artifact=/m);
          const builtReceipt = JSON.parse(await readFile(join(out, 'BUILD.json'), 'utf8'));
          assert.equal(builtReceipt.revision, revision);
          assert.equal(builtReceipt.next, undefined);
        }
        if (row === 'config') assert.match(result.stderr, /production API URL required/);
        if (row === 'container') assert.match(log, /fixture pull\n[\s\S]*fixture container failure/);
      } finally {
        await writeFile(join(state, 'release'), ''); await settled;
        if (job) await rm(job, { recursive: true, force: true });
      }
    }
    for (const badNext of ['', '2', 'true']) {
      const badOut = join(root, `built-bad-next-${badNext || 'empty'}`);
      const input = join(state, 'success.json');
      await assert.rejects(exec('bash', [join(src, 'deploy/site/build-artifact.sh'), revision, input, '1', badOut], {
        env: cleanNextEnv({ PATH: `${bin}:${process.env.PATH}`, COMMONSWARM_INCLUDE_NEXT: badNext }),
      }));
      await assert.rejects(stat(badOut), { code: 'ENOENT' }, 'invalid COMMONSWARM_INCLUDE_NEXT must fail before creating output dir');
    }
    assert.ok((await stat(sibling)).isDirectory(), "another build's workspace must survive");
  } finally { await rm(sibling, { recursive: true, force: true }); }
});

test('production script requires only static file tools and never compiles or prunes', async () => {
  const source = await readFile(join(repo, 'deploy/site/finalize-release.sh'), 'utf8');
  assert.doesNotMatch(source, /\b(?:npm|node|docker|rsync|rm)\b/);
  assert.ok(source.trim().split('\n').length >= 24 && source.trim().split('\n').length <= 100);
});

// Keep cache regressions in the canonical artifact owner: box-dry-run and p1-cli
// both execute this file. Python drives the real source tools over local HTTP.
test('release cache helper, full shell lifecycle, and producer provenance regressions', async () => {
  for (const name of ['test-cache-http.py', 'test-shell-http.py', 'test-prepare.py']) {
    const result = await exec('python3', ['-I', join(repo, 'tests/p1-cli/fixtures/site-release-cache', name)], { cwd: repo, timeout: 120_000 });
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.passed, true, name);
  }
});
