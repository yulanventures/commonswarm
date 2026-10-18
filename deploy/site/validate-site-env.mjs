#!/usr/bin/env node
// Public build inputs only. Never source a caller's shell or .env file.
import { readFileSync as read, writeFileSync as write, mkdirSync, copyFileSync, chmodSync, openSync, closeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const hash = data => createHash('sha256').update(data).digest('hex');
const fileHash = p => hash(read(p));
const check = (condition, label) => { if (!condition) throw Error(label); };
const image = 'node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c';
const keys = ['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY', 'PUBLIC_H0_LINK_JOIN'];
function config(value, h0) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'public JSON object required');
  check(Object.keys(value).every(k => keys.includes(k)), 'unknown public configuration key');
  check(h0 === '0' || h0 === '1', 'explicit H0=0 or 1 required');
  check(value.PUBLIC_H0_LINK_JOIN === undefined || value.PUBLIC_H0_LINK_JOIN === h0, 'H0 input conflict');
  check(value.PUBLIC_SUPABASE_URL === 'https://api.commonswarm.com', 'production API URL required');
  const key = value.PUBLIC_SUPABASE_ANON_KEY;
  check(typeof key === 'string' && /^[-\w]+\.[-\w]+\.[-\w]+$/.test(key), 'anon JWT required');
  check(JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'anon', 'anon role required; service_role role refused');
  return Object.fromEntries(keys.map(k => [k, k === keys[2] ? h0 : value[k]]));
}
// Builder emits plain ustar. Reject links, special files, traversal, duplicates,
// corrupt headers, nonzero trailing data and children of regular files before extraction.
function members(bytes) {
  check(bytes.length <= 536870912 && bytes.length % 512 === 0, 'tar size');
  const files = new Map(); let offset = 0;
  const text = b => b.toString('utf8').replace(/\0.*$/s, '');
  while (offset + 512 <= bytes.length) {
    const b = bytes.subarray(offset, offset + 512); offset += 512;
    if (b.every(x => x === 0)) { check(bytes.subarray(offset).every(x => x === 0), 'tar trailing bytes'); return files; }
    const oct = b => { const s = text(b).trim(); check(/^[0-7]+$/.test(s), 'tar numeric field'); return parseInt(s, 8); };
    check(text(b.subarray(257, 263)) === 'ustar', 'ustar required');
    check(oct(b.subarray(148, 156)) === b.reduce((n, x, i) => n + (i >= 148 && i < 156 ? 32 : x), 0), 'tar checksum');
    const raw = (text(b.subarray(345, 500)) ? text(b.subarray(345, 500)) + '/' : '') + text(b.subarray(0, 100));
    const name = raw === './' ? '.' : raw.replace(/^\.\//, '').replace(/\/$/, ''); const type = String.fromCharCode(b[156]);
    check(!raw.endsWith('/') || type === '5', 'regular tar member has trailing slash');
    check((type === '0' || type === '\0' || type === '5') && !text(b.subarray(157, 257)), 'tar links/special members refused');
    check(name === '.' || (/^[A-Za-z0-9_./@+-]+$/.test(name) && !name.startsWith('/') && name.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('.'))), 'unsafe tar member');
    check(!files.has(name), 'duplicate tar member');
    const size = oct(b.subarray(124, 136)); check(offset + size <= bytes.length && (type !== '5' || size === 0), 'truncated tar');
    files.set(name, type === '5' ? null : bytes.subarray(offset, offset + size)); offset += Math.ceil(size / 512) * 512;
  }
  throw Error('tar terminator missing');
}
function htmlHashes(dir, publicConfig) {
  const entries = members(read(join(dir, 'site.tar')));
  for (const name of entries.keys()) for (let p = name; p.includes('/');) { p = p.slice(0, p.lastIndexOf('/')); check(!entries.has(p) || entries.get(p) === null, 'tar file parent'); }
  const hashes = {};
  for (const name of ['index.html', 'app/index.html', 'start/index.html']) {
    const bytes = entries.get(name); check(bytes?.length, 'missing HTML'); const html = bytes.toString();
    for (const [meta, value] of [['url', publicConfig.PUBLIC_SUPABASE_URL], ['anon-key', publicConfig.PUBLIC_SUPABASE_ANON_KEY]]) {
      const matches = [...html.matchAll(new RegExp(`<meta\\s+name="commonswarm:${meta}"\\s+content="([^"]*)"`, 'g'))];
      check(matches.length === 1 && matches[0][1] === value, 'built public configuration mismatch');
    }
    if (name === 'app/index.html') {
      // Inspect emitted elements, excluding comments and raw script/style text.
      const markup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
      const controls = new Set();
      for (const tag of markup.matchAll(/<([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
        const attrs = new Map([...tag[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)].map(a => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '']));
        if (attrs.has('data-h0-link-join')) controls.add('data-h0-link-join');
        if (tag[1].toLowerCase() === 'button') controls.add(attrs.get('data-action'));
      }
      for (const control of ['data-h0-link-join', 'mint-join', 'revoke-join'])
        check(controls.has(control) === (publicConfig.PUBLIC_H0_LINK_JOIN === '1'), `built H0=${publicConfig.PUBLIC_H0_LINK_JOIN} controls mismatch: ${control}`);
    }
    hashes[name] = hash(bytes);
  }
  return hashes;
}
const sourceFile = (dir, path) => execFileSync('tar', ['-xOf', join(dir, 'source.tar'), path], { maxBuffer: 8 * 1024 * 1024 });
function provenance(dir, revision, pinnedImage) {
  check(/^[0-9a-f]{40}$/.test(revision) && pinnedImage === image, 'revision/image pin');
  const sourceFd = openSync(join(dir, 'source.tar'), 'r');
  try {
    // Git exits after the archive headers; a pipe can fail with EPIPE on larger archives.
    check(execFileSync('git', ['get-tar-commit-id'], { stdio: [sourceFd, 'pipe', 'pipe'], encoding: 'utf8' }).trim() === revision, 'source revision');
  } finally { closeSync(sourceFd); }
  const pub = JSON.parse(read(join(dir, 'public.json'))); config(pub, pub.PUBLIC_H0_LINK_JOIN);
  return { revision, image, source: fileHash(join(dir, 'source.tar')), config: fileHash(join(dir, 'public.json')), h0: pub.PUBLIC_H0_LINK_JOIN,
    lock: hash(sourceFile(dir, 'site/package-lock.json')), builder: hash(sourceFile(dir, 'deploy/site/build-artifact.sh')),
    validator: hash(sourceFile(dir, 'deploy/site/validate-site-env.mjs')), template: hash(sourceFile(dir, 'deploy/site/finalize-release.sh')),
    artifact: fileHash(join(dir, 'site.tar')), html: htmlHashes(dir, pub) };
}
try {
  const [mode, dir, arg, extra] = process.argv.slice(2);
  if (mode === 'config') write(extra, JSON.stringify(config(JSON.parse(read(dir)), arg), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  else if (mode === 'receipt') {
    const receipt = provenance(dir, arg, extra);
    check(fileHash(join(dir, 'finalize-release.sh')) === receipt.template, 'template provenance');
    write(join(dir, 'BUILD.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  } else if (mode === 'prepare') {
    check(/^[0-9a-f]{64}$/.test(arg) && fileHash(join(dir, 'BUILD.json')) === arg, 'reviewed BUILD hash mismatch');
    const receipt = JSON.parse(read(join(dir, 'BUILD.json')));
    check(fileHash(fileURLToPath(import.meta.url)) === receipt.validator, 'preparation validator provenance mismatch');
    check(JSON.stringify(receipt) === JSON.stringify(provenance(dir, receipt.revision, receipt.image)), 'build provenance mismatch');
    const template = read(join(dir, 'finalize-release.sh'), 'utf8'); check(hash(template) === receipt.template, 'template provenance mismatch');
    check(/^\/root\/cswarm-site-[A-Za-z0-9-]+$/.test(extra), 'reserve path');
    const release = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${receipt.revision.slice(0, 12)}-${randomBytes(8).toString('hex')}`;
    const values = { RESERVE: extra, RELEASE: release, BUILD_SHA: arg, ARTIFACT_SHA: receipt.artifact, ROOT_SHA: receipt.html['index.html'], APP_SHA: receipt.html['app/index.html'], REVISION: receipt.revision, H0: receipt.h0 };
    const script = template.replace(/@@([A-Z_]+)@@/g, (_, k) => { check(k in values, 'template placeholder'); return values[k]; });
    const packet = resolve(dir, 'packet'); mkdirSync(packet);
    for (const name of ['site.tar', 'BUILD.json']) copyFileSync(join(dir, name), join(packet, name));
    write(join(packet, 'SITE-DIRECT.sh'), script); write(join(packet, 'RESERVE'), extra + '\n');
    const names = ['site.tar', 'BUILD.json', 'SITE-DIRECT.sh', 'RESERVE'];
    write(join(packet, 'PACKET.sha256'), names.map(n => `${fileHash(join(packet, n))}  ${n}\n`).join(''));
    for (const name of [...names, 'PACKET.sha256']) chmodSync(join(packet, name), 0o444);
    console.log(`PASS packet=${packet} release=${release} PACKET.sha256=${fileHash(join(packet, 'PACKET.sha256'))}`);
  } else throw Error('Usage: config <public.json> <0|1> <output> | receipt <artifact-dir> <sha> <image> | prepare <artifact-dir> <reviewed-BUILD-sha256> <reserve>');
} catch (error) { console.error(`Refusing site artifact: ${error instanceof SyntaxError ? 'invalid public JSON/JWT' : error.message}`); process.exit(1); }
