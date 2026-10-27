// Shared by the server matrix and its final coverage gate. Run from the repo root.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkList, expand, parseList } from '../run-test-list.mjs';

const shardCount = 3;
function serverFiles() {
  const entries = parseList(readFileSync('tests/lists/test:p1-server.txt', 'utf8'));
  assert.deepEqual(checkList(entries), []);
  const files = expand(entries).sort();
  assert.ok(files.length >= shardCount, 'server manifest must fill every shard');
  const discovered = expand(['tests/p1-server/**/*.test.ts']).sort();
  assert.deepEqual(files, discovered, 'server manifest must cover every server test');
  return files;
}
function shardFiles(shard) {
  assert.ok(Number.isInteger(shard) && shard >= 1 && shard <= shardCount, 'invalid server shard');
  return serverFiles().filter((_, index) => index % shardCount === shard - 1);
}

// This amd64 manifest was measured for the existing version in
// deploy/edge-runtime/{README,VERIFICATION}.md. Do not resolve a mirror tag:
// both registries must serve these exact bytes, even when ECR is throttled.
function pinnedImages() {
  const edge = readFileSync('deploy/edge-runtime/compose.yaml', 'utf8').match(/^    image: (\S+)$/m)?.[1];
  assert.equal(edge, 'public.ecr.aws/supabase/edge-runtime:v1.73.13', 'review the CI digest when changing the edge version');
  const edgeDigest = 'sha256:e8ddc7b0f4888818159d4b665e922de667948e2864c895ed62acdfd29e7c6c80';
  const images = [{ image: edge, digest: edgeDigest }];
  return images.map(({ image, digest }) => {
    const repository = image.split('@')[0].replace(/:[^/:]+$/, '');
    assert.ok(repository.startsWith('public.ecr.aws/supabase/'));
    return { image, digest, primary: `${repository}@${digest}`, mirror: `${repository.replace('public.ecr.aws/', 'ghcr.io/')}@${digest}` };
  });
}
function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 180_000 });
}
function requireDocker(args) {
  const result = docker(args);
  assert.equal(result.status, 0, result.stderr || result.error?.message || `docker ${args[0]} failed`);
  return result.stdout;
}
function rateLimited(result) {
  const lines = (result.stderr ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return result.status !== 0 && !result.error && !result.signal && lines.length > 0 && lines.every(line =>
    /^(?:docker:\s*)?(?:Error response from daemon:\s*)?toomanyrequests:\s*(?:Data limit exceeded|Rate exceeded)$/i.test(line));
}
function inspect(image) {
  const result = docker(['image', 'inspect', image]);
  return result.status === 0 ? JSON.parse(result.stdout)[0] : undefined;
}
async function prepareImages(directory, cacheHit) {
  mkdirSync(directory, { recursive: true });
  const images = pinnedImages();
  const archive = join(directory, 'images.tar');
  const lockPath = join(directory, 'images.json');
  if (cacheHit === 'true') {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      assert.deepEqual(lock.images, images);
      assert.equal(docker(['load', '--input', archive]).status, 0);
      for (const { image } of images) {
        assert.match(lock.ids[image], /^sha256:[0-9a-f]{64}$/);
        assert.equal(inspect(image)?.Id, lock.ids[image], `cached image identity: ${image}`);
      }
      console.log('Restored and verified all pinned images');
      return;
    } catch {
      console.log('Warning: Cached images could not be verified; pulling the exact digests.');
    }
  }
  const ids = {};
  for (const spec of images) {
    let reference = spec.primary;
    let result;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      result = docker(['pull', reference]);
      if (result.status === 0 || !rateLimited(result)) break;
      if (attempt < 3) await new Promise(resolveWait => setTimeout(resolveWait, attempt * 1_000));
    }
    if (rateLimited(result)) {
      reference = spec.mirror;
      console.log(`ECR rate limited; trying the same digest at ${reference}`);
      result = docker(['pull', reference]);
    }
    assert.equal(result.status, 0, result.stderr || result.error?.message || 'pinned image pull failed');
    const pulled = inspect(reference);
    assert.ok(pulled?.RepoDigests?.includes(reference), `pulled image must carry the exact registry digest: ${reference}`);
    assert.match(pulled.Id, /^sha256:[0-9a-f]{64}$/);
    if (reference !== spec.image) requireDocker(['tag', reference, spec.image]);
    assert.equal(inspect(spec.image)?.Id, pulled.Id);
    ids[spec.image] = pulled.Id;
  }
  requireDocker(['save', '--output', archive, ...images.map(({ image }) => image)]);
  writeFileSync(lockPath, `${JSON.stringify({ images, ids }, null, 2)}\n`);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'list':
    console.log(shardFiles(Number(args[0])).join('\n'));
    break;
  case 'receipt': {
    const shard = Number(args[0]);
    const files = parseList(readFileSync(args[1], 'utf8'));
    assert.deepEqual(files, shardFiles(shard), 'executed list must match the shard');
    writeFileSync(args[2], `${JSON.stringify({ shard, files })}\n`);
    break;
  }
  case 'verify': {
    const receipts = readdirSync(args[0]).filter(name => /^server-shard-.*\.json$/.test(name));
    assert.equal(receipts.length, shardCount, 'all three shard receipts are required');
    const seen = new Set();
    const files = receipts.flatMap(name => {
      const receipt = JSON.parse(readFileSync(join(args[0], name), 'utf8'));
      assert.ok(!seen.has(receipt.shard), 'duplicate shard receipt');
      seen.add(receipt.shard);
      assert.deepEqual(receipt.files, shardFiles(receipt.shard), 'shard receipt coverage mismatch');
      return receipt.files;
    });
    assert.deepEqual(files.sort(), serverFiles(), 'server files must run exactly once');
    console.log(`Verified ${files.length} server files exactly once across ${shardCount} successful shards`);
    break;
  }
  case 'image-metadata':
    console.log(`key=${createHash('sha256').update(JSON.stringify(pinnedImages())).digest('hex')}`);
    break;
  case 'prepare-images':
    await prepareImages(args[0], args[1]);
    break;
  default:
    throw new Error('Expected list, receipt, verify, image-metadata, or prepare-images');
}
