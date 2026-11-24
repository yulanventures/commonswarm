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
const image = 'node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d';
const keys = ['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY', 'PUBLIC_H0_LINK_JOIN'];
function assertAnonJwt(key) {
  check(typeof key === 'string' && /^[-\w]+\.[-\w]+\.[-\w]+$/.test(key), 'anon JWT required');
  check(JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'anon', 'anon role required; service_role role refused');
}
function config(value, h0) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'public JSON object required');
  check(Object.keys(value).every(k => keys.includes(k)), 'unknown public configuration key');
  check(h0 === '0' || h0 === '1', 'explicit H0=0 or 1 required');
  check(value.PUBLIC_H0_LINK_JOIN === undefined || value.PUBLIC_H0_LINK_JOIN === h0, 'H0 input conflict');
  check(value.PUBLIC_SUPABASE_URL === 'https://api.commonswarm.com', 'production API URL required');
  assertAnonJwt(value.PUBLIC_SUPABASE_ANON_KEY);
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
function parseAttrs(raw, tag = '', rejectDuplicates = false) {
  const attrs = new Map();
  const pattern = rejectDuplicates
    ? /([^\t\n\f\r =/>]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'=<>`]+)))?/g
    : /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const a of raw.matchAll(pattern)) {
    const name = a[1].toLowerCase();
    if (rejectDuplicates) {
      check(!attrs.has(name), `next/index.html <${tag}> contains duplicate attribute: ${name}`);
    }
    attrs.set(name, a[2] ?? a[3] ?? a[4] ?? '');
  }
  return attrs;
}
function validateNextHtml(html, entries, publicConfig) {
  check(!html.includes('InNlcnZpY2Vfcm9sZSI') && !/"role"\s*:\s*"service_role"/.test(html), 'next/index.html contains service_role marker');
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const heads = [...noComments.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/gi)];
  check(heads.length === 1, 'next/index.html requires a single <head>');
  const headInner = heads[0][1].replace(/<(script|style|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, m => m.slice(0, m.indexOf('>') + 1));
  const headTags = [...headInner.matchAll(/<([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)].map(m => {
    const tag = m[1].toLowerCase();
    return { tag, attrs: parseAttrs(m[2], tag, true) };
  });
  check(headTags.length >= 2, 'next/index.html <head> missing charset or Content-Security-Policy');
  check(headTags[0].tag === 'meta' && headTags[0].attrs.has('charset') && headTags[0].attrs.get('charset').trim().length > 0,
    'next/index.html <head> must start with <meta charset>');
  check(headTags[1].tag === 'meta' && headTags[1].attrs.get('http-equiv')?.toLowerCase() === 'content-security-policy',
    'next/index.html Content-Security-Policy meta must be the first element in <head> after charset');
  const rawCsp = headTags[1].attrs.get('content') ?? '';
  check(rawCsp.length > 0, 'next/index.html CSP content must not be empty');
  check(!/[^\x20-\x7e]/.test(rawCsp), 'next/index.html CSP contains non-ASCII or control character');
  const apiOrigin = new URL(publicConfig.PUBLIC_SUPABASE_URL);
  // Keep in sync with PRODUCTION_CSP in app/vite.config.ts (enforced by tests/p1-cli/site-artifact.test.ts).
  const expectedCspDirectives = new Map([
    ['default-src', "'self'"],
    ['script-src', "'self'"],
    ['style-src', "'self'"],
    ['font-src', "'self'"],
    ['img-src', "'self' blob: data:"],
    ['connect-src', `'self' ${apiOrigin.origin} wss://${apiOrigin.host}`],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'none'"],
    ['frame-src', "'none'"],
  ]);
  check(!/unsafe-inline|unsafe-eval/i.test(rawCsp), 'next/index.html CSP must not allow unsafe-inline or unsafe-eval');
  // Parse per CSP3 "parse a serialized CSP" using ASCII whitespace only.
  const stripAsciiWs = s => s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  const directives = new Map();
  for (const rawDirective of rawCsp.split(';')) {
    const token = stripAsciiWs(rawDirective);
    if (!token) continue;
    const wsIndex = token.search(/[\t\n\f\r ]/);
    const rawName = wsIndex === -1 ? token : token.slice(0, wsIndex);
    const rawValue = wsIndex === -1 ? '' : stripAsciiWs(token.slice(wsIndex));
    const name = rawName.toLowerCase();
    check(!directives.has(name), `next/index.html CSP contains duplicate directive: ${name}`);
    check(expectedCspDirectives.has(name), `next/index.html CSP contains unexpected directive: ${name}`);
    const value = rawValue ? rawValue.split(/[\t\n\f\r ]+/).join(' ') : '';
    directives.set(name, value);
  }
  for (const [name, expected] of expectedCspDirectives) {
    check(directives.has(name), `next/index.html CSP missing required directive: ${name}`);
    const actual = directives.get(name);
    check(actual === expected, `next/index.html CSP directive ${name} mismatch: expected "${expected}", got "${actual}"`);
  }

  const docMarkup = noComments.replace(/<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (m, _t, body) => {
    check(body.trim() === '', 'next/index.html must not contain inline script or style');
    return m.slice(0, m.indexOf('>') + 1);
  });
  const urls = [];
  const anonKeys = [];
  let cspCount = 0;
  const assets = new Set();
  const externalScheme = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
  const checkAssetPath = (rawPath, basePath = '/next/index.html') => {
    const trimmed = rawPath.trim();
    check(trimmed.length > 0 && !externalScheme.test(trimmed), `next/index.html references third-party or non-relative origin: ${trimmed}`);
    const resolved = new URL(trimmed, `https://commonswarm.invalid${basePath}`);
    check(resolved.origin === 'https://commonswarm.invalid' && resolved.pathname.startsWith('/next/'),
      `next/index.html asset outside /next/: ${trimmed}`);
    check(/^\/next\/[A-Za-z0-9_./@-]+$/.test(resolved.pathname) && !resolved.pathname.split('/').includes('..'),
      `next/index.html unsafe asset path: ${resolved.pathname}`);
    const memberName = resolved.pathname.slice(1);
    check(entries.get(memberName)?.length > 0, `next/index.html referenced asset missing from archive: ${resolved.pathname}`);
    return resolved.pathname;
  };
  for (const m of docMarkup.matchAll(/<([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2], tag, true);
    if (tag === 'meta') {
      const httpEquiv = attrs.get('http-equiv')?.toLowerCase();
      if (httpEquiv === 'content-security-policy') cspCount += 1;
      const name = attrs.get('name');
      if (name === 'commonswarm:url') urls.push(attrs.get('content') ?? '');
      if (name === 'commonswarm:anon-key') anonKeys.push(attrs.get('content') ?? '');
    }
    for (const attr of ['src', 'href', 'action', 'poster', 'data']) {
      if (!attrs.has(attr)) continue;
      const value = attrs.get(attr).trim();
      if (tag === 'a' && value.startsWith('#')) continue;
      check(!externalScheme.test(value), `next/index.html references third-party origin in ${attr}: ${value}`);
      if (['script', 'link', 'img', 'source', 'audio', 'video'].includes(tag) && (attr === 'src' || attr === 'href')) {
        assets.add(checkAssetPath(value));
      }
    }
    if (attrs.has('srcset')) {
      for (const candidate of attrs.get('srcset').split(',')) {
        const ref = candidate.trim().split(/\s+/)[0] ?? '';
        if (ref) assets.add(checkAssetPath(ref));
      }
    }
  }
  check(cspCount === 1, 'next/index.html must contain exactly one Content-Security-Policy meta');
  check(urls.length === 1 && urls[0] === publicConfig.PUBLIC_SUPABASE_URL, 'next/index.html built public configuration mismatch');
  check(anonKeys.length === 1, 'next/index.html built public configuration mismatch');
  assertAnonJwt(anonKeys[0]);
  check(anonKeys[0] === publicConfig.PUBLIC_SUPABASE_ANON_KEY, 'next/index.html built public configuration mismatch');

  const allowedOrigins = new Set([apiOrigin.origin, `wss://${apiOrigin.host}`]);
  for (const originMatch of noComments.matchAll(/(?:https?|wss?):\/\/[^\s"'<>);,]+|(?:^|[\s"'=(])(\/\/[a-z0-9][^\s"'<>);,]*)/gi)) {
    const candidate = (originMatch[1] ?? originMatch[0]).trim();
    if (candidate.startsWith('//')) {
      throw Error(`next/index.html references third-party protocol-relative origin: ${candidate}`);
    }
    let parsed;
    try { parsed = new URL(candidate); } catch { throw Error(`next/index.html malformed origin reference: ${candidate}`); }
    check(allowedOrigins.has(`${parsed.protocol}//${parsed.host}`), `next/index.html references third-party origin: ${candidate}`);
  }

  // Walk CSS url(...) and Vite JS relative imports so finalize-release.sh verifies the full served /next asset graph.
  const queue = [...assets];
  while (queue.length > 0) {
    const assetPath = queue.shift();
    const bytes = entries.get(assetPath.slice(1));
    if (!bytes) continue;
    if (assetPath.endsWith('.css')) {
      const css = bytes.toString('utf8');
      for (const u of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) {
        const ref = u[1].trim();
        if (/^(?:data:|blob:|#)/i.test(ref)) continue;
        const resolved = checkAssetPath(ref, assetPath);
        if (!assets.has(resolved)) { assets.add(resolved); queue.push(resolved); }
      }
    } else if (assetPath.endsWith('.js')) {
      const js = bytes.toString('utf8');
      for (const imp of js.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+\.(?:js|css|woff2))["']/g)) {
        const resolved = checkAssetPath(imp[1], assetPath);
        if (!assets.has(resolved)) { assets.add(resolved); queue.push(resolved); }
      }
    }
  }
  return [...assets].sort();
}
function inspectSite(dir, publicConfig, includeNext) {
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
        const attrs = parseAttrs(tag[2]);
        if (attrs.has('data-h0-link-join')) controls.add('data-h0-link-join');
        if (tag[1].toLowerCase() === 'button') controls.add(attrs.get('data-action'));
      }
      for (const control of ['data-h0-link-join', 'mint-join', 'revoke-join'])
        check(controls.has(control) === (publicConfig.PUBLIC_H0_LINK_JOIN === '1'), `built H0=${publicConfig.PUBLIC_H0_LINK_JOIN} controls mismatch: ${control}`);
    }
    hashes[name] = hash(bytes);
  }
  let nextAssets = [];
  if (includeNext === '1') {
    const bytes = entries.get('next/index.html'); check(bytes?.length, 'missing next/index.html');
    nextAssets = validateNextHtml(bytes.toString('utf8'), entries, publicConfig);
    hashes['next/index.html'] = hash(bytes);
  } else {
    for (const name of entries.keys()) {
      check(name !== 'next' && !name.startsWith('next/'), 'unexpected next/ member when COMMONSWARM_INCLUDE_NEXT=0');
    }
  }
  return { hashes, nextAssets };
}
const sourceFile = (dir, path) => execFileSync('tar', ['-xOf', join(dir, 'source.tar'), path], { maxBuffer: 8 * 1024 * 1024 });
function provenance(dir, revision, pinnedImage, includeNext = '0') {
  check(/^[0-9a-f]{40}$/.test(revision) && pinnedImage === image, 'revision/image pin');
  check(includeNext === '0' || includeNext === '1', 'COMMONSWARM_INCLUDE_NEXT must be 0 or 1');
  const sourceFd = openSync(join(dir, 'source.tar'), 'r');
  try {
    // Git exits after the archive headers; a pipe can fail with EPIPE on larger archives.
    check(execFileSync('git', ['get-tar-commit-id'], { stdio: [sourceFd, 'pipe', 'pipe'], encoding: 'utf8' }).trim() === revision, 'source revision');
  } finally { closeSync(sourceFd); }
  const pub = JSON.parse(read(join(dir, 'public.json'))); config(pub, pub.PUBLIC_H0_LINK_JOIN);
  const site = inspectSite(dir, pub, includeNext);
  const receipt = {
    revision, image, source: fileHash(join(dir, 'source.tar')), config: fileHash(join(dir, 'public.json')), h0: pub.PUBLIC_H0_LINK_JOIN,
    lock: hash(sourceFile(dir, 'site/package-lock.json')), builder: hash(sourceFile(dir, 'deploy/site/build-artifact.sh')),
    validator: hash(sourceFile(dir, 'deploy/site/validate-site-env.mjs')), refresh: hash(sourceFile(dir, 'deploy/site/refresh-site.py')), template: hash(sourceFile(dir, 'deploy/site/finalize-release.sh')),
    artifact: fileHash(join(dir, 'site.tar')), html: site.hashes,
  };
  if (includeNext === '1') {
    receipt.next = '1';
    receipt.appLock = hash(sourceFile(dir, 'app/package-lock.json'));
    receipt.nextAssets = site.nextAssets;
  }
  return receipt;
}
try {
  const [mode, dir, arg, extra] = process.argv.slice(2);
  if (mode === 'config') write(extra, JSON.stringify(config(JSON.parse(read(dir)), arg), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  else if (mode === 'receipt') {
    const includeNext = process.env.COMMONSWARM_INCLUDE_NEXT ?? '0';
    const receipt = provenance(dir, arg, extra, includeNext);
    check(fileHash(join(dir, 'finalize-release.sh')) === receipt.template, 'template provenance');
    write(join(dir, 'BUILD.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  } else if (mode === 'prepare') {
    check(/^[0-9a-f]{64}$/.test(arg) && fileHash(join(dir, 'BUILD.json')) === arg, 'reviewed BUILD hash mismatch');
    const receipt = JSON.parse(read(join(dir, 'BUILD.json')));
    check(fileHash(fileURLToPath(import.meta.url)) === receipt.validator, 'preparation validator provenance mismatch');
    const includeNext = receipt.next === undefined ? '0' : receipt.next;
    check(JSON.stringify(receipt) === JSON.stringify(provenance(dir, receipt.revision, receipt.image, includeNext)), 'build provenance mismatch');
    const template = read(join(dir, 'finalize-release.sh'), 'utf8'); check(hash(template) === receipt.template, 'template provenance mismatch');
    check(/^\/root\/cswarm-site-[A-Za-z0-9-]+$/.test(extra), 'reserve path');
    const release = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${receipt.revision.slice(0, 12)}-${randomBytes(8).toString('hex')}`;
    const values = { RESERVE: extra, RELEASE: release, BUILD_SHA: arg, ARTIFACT_SHA: receipt.artifact, ROOT_SHA: receipt.html['index.html'], APP_SHA: receipt.html['app/index.html'], INCLUDE_NEXT: includeNext, NEXT_SHA: includeNext === '1' ? receipt.html['next/index.html'] : '', NEXT_ASSETS: includeNext === '1' ? receipt.nextAssets.join(' ') : '', REVISION: receipt.revision, H0: receipt.h0, REFRESH_SHA: receipt.refresh };
    const script = template.replace(/@@([A-Z_0-9]+)@@/g, (_, k) => { check(k in values, 'template placeholder'); return values[k]; });
    const packet = resolve(dir, 'packet'); mkdirSync(packet);
    for (const name of ['site.tar', 'BUILD.json']) copyFileSync(join(dir, name), join(packet, name));
    write(join(packet, 'refresh-site.py'), sourceFile(dir, 'deploy/site/refresh-site.py'));
    write(join(packet, 'SITE-DIRECT.sh'), script); write(join(packet, 'RESERVE'), extra + '\n');
    const names = ['site.tar', 'BUILD.json', 'SITE-DIRECT.sh', 'refresh-site.py', 'RESERVE'];
    write(join(packet, 'PACKET.sha256'), names.map(n => `${fileHash(join(packet, n))}  ${n}\n`).join(''));
    for (const name of [...names, 'PACKET.sha256']) chmodSync(join(packet, name), 0o444);
    console.log(`PASS packet=${packet} release=${release} PACKET.sha256=${fileHash(join(packet, 'PACKET.sha256'))}`);
  } else throw Error('Usage: config <public.json> <0|1> <output> | receipt <artifact-dir> <sha> <image> | prepare <artifact-dir> <reviewed-BUILD-sha256> <reserve>');
} catch (error) { console.error(`Refusing site artifact: ${error instanceof SyntaxError ? 'invalid public JSON/JWT' : error.message}`); process.exit(1); }
