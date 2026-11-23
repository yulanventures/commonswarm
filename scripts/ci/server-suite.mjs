// Shared by the server matrix and its final coverage gate. Run from the repo root.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
function pinnedEdgeImage() {
  const edge = readFileSync('deploy/edge-runtime/compose.yaml', 'utf8').match(/^    image: (\S+)$/m)?.[1];
  assert.equal(edge, 'public.ecr.aws/supabase/edge-runtime:v1.73.13', 'review the CI digest when changing the edge version');
  const digest = 'sha256:e8ddc7b0f4888818159d4b665e922de667948e2864c895ed62acdfd29e7c6c80';
  const repository = edge.replace(/:[^/:]+$/, '');
  return { alias: 'edge-runtime-pinned', image: edge, digest, candidates: [`${repository}@${digest}`, `${repository.replace('public.ecr.aws/', 'ghcr.io/')}@${digest}`] };
}

// The local stack's images come from the installed Supabase CLI: its binary embeds the Dockerfile
// whose `FROM <image> AS <alias>` lines name every service image for that CLI version.
// Aliases `supabase start` does not run with supabase/config.toml: the pooler and storage image
// transformation are disabled there, and differ, migra and pgprove are one-shot job images.
// check-stack-images fails the job if the started stack uses or pulls any image outside the cache.
const notStarted = new Set(['imgproxy', 'supavisor', 'differ', 'migra', 'pgprove']);
const startedAliases = ['pg', 'kong', 'mailpit', 'postgrest', 'pgmeta', 'studio', 'edgeruntime', 'vector', 'gotrue', 'realtime', 'storage', 'logflare'];
function cliDockerfile(text) {
  const anchor = /^FROM supabase\/postgres:\S+ AS pg$/m.exec(text);
  if (!anchor) return undefined;
  const images = [];
  for (const line of text.slice(anchor.index).split('\n')) {
    const from = /^FROM (\S+) AS (\w+)$/.exec(line);
    if (from) images.push({ alias: from[2], image: from[1] });
    else if (!line.startsWith('#')) break;
  }
  return images;
}
function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}
function cliBinaries() {
  const directory = (process.env.PATH ?? '').split(':').find(entry => entry && isFile(join(entry, 'supabase')));
  assert.ok(directory, 'the Supabase CLI is not on PATH');
  const binary = realpathSync(join(directory, 'supabase'));
  // The npm package's launcher runs a platform binary from node_modules/@supabase/cli-*/bin.
  const packages = join(dirname(dirname(binary)), 'node_modules', '@supabase');
  const folders = [dirname(binary), ...(existsSync(packages)
    ? readdirSync(packages).filter(name => name.startsWith('cli-')).map(name => join(packages, name, 'bin')).filter(existsSync)
    : [])];
  const files = folders.flatMap(folder => readdirSync(folder).map(name => join(folder, name)))
    .filter(file => isFile(file) && statSync(file).size < 512 * 1024 * 1024);
  return { binary, files };
}
function stackImages() {
  assert.ok(!process.env.SUPABASE_INTERNAL_IMAGE_REGISTRY, 'the image cache follows the CLI default registry order; unset SUPABASE_INTERNAL_IMAGE_REGISTRY');
  const overrides = existsSync('supabase/.temp') ? readdirSync('supabase/.temp').filter(name => name.endsWith('-version')) : [];
  assert.deepEqual(overrides, [], 'supabase/.temp version files override CLI images; the image cache does not follow them');
  const version = spawnSync('supabase', ['--version'], { encoding: 'utf8', timeout: 60_000 }).stdout?.match(/^v?(\d+\.\d+\.\d+)\s*$/m)?.[1];
  assert.ok(version, 'could not read the Supabase CLI version');
  const { binary, files } = cliBinaries();
  const found = files.map(file => cliDockerfile(readFileSync(file, 'latin1'))).filter(Boolean);
  assert.ok(found.length > 0, `no embedded Dockerfile image list in the Supabase CLI ${version} at ${binary}`);
  for (const other of found) assert.deepEqual(other, found[0], 'the CLI binaries disagree on their image list');
  const aliases = found[0].map(({ alias }) => alias);
  for (const alias of startedAliases) assert.ok(aliases.includes(alias), `the CLI ${version} image list has no ${alias}; review startedAliases`);
  // The CLI looks for public.ecr.aws/supabase/<name>, then ghcr.io/supabase/<name>, then the
  // Docker Hub name, and starts whichever exists locally. The cache tags each image with the first.
  const images = found[0].filter(({ alias }) => !notStarted.has(alias)).map(({ alias, image }) => {
    const name = image.split('/').pop();
    return { alias, image: `public.ecr.aws/supabase/${name}`, candidates: [`public.ecr.aws/supabase/${name}`, `ghcr.io/supabase/${name}`, image] };
  });
  return { cli: version, binary, images: [pinnedEdgeImage(), ...images] };
}

// The images the C1 docker stdin check (server shard 1) and the p1-cli Docker tests run by tag (#487). Each is
// pulled only by its linux/amd64 manifest digest, read from the registry API, and tagged with the name its
// consumers use, so `docker run <tag>` finds it locally. Every registry listed serves the same digest.
// `users` must name the tag literally; the C1 check takes its tag from image-metadata (c1_psql_image).
function dockerHubLibrary(name, digest) {
  return [`${name}@${digest}`, `public.ecr.aws/docker/library/${name}@${digest}`, `mirror.gcr.io/library/${name}@${digest}`];
}
function supabaseRegistries(name, digest) {
  return [`public.ecr.aws/supabase/${name}@${digest}`, `ghcr.io/supabase/${name}@${digest}`, `supabase/${name}@${digest}`];
}
function supabaseEdgeRegistries(name, digest) {
  return [`public.ecr.aws/supabase/${name}@${digest}`, `ghcr.io/supabase/${name}@${digest}`];
}
const pinnedTestImages = [
  { alias: 'c1-psql', image: 'postgres:17.12', digest: 'sha256:6f7593c161689b6b02c78668b314af7da8811b592c5519108c57a49d0b6ad788', registries: dockerHubLibrary, users: [] },
  { alias: 'p1-cli-postgres', image: 'postgres:17.11', digest: 'sha256:996e9dc583ba9f0265a2c75547a9c95fb22c251e394749cab205a0a00e1856a1', registries: dockerHubLibrary,
    users: ['tests/p1-cli/n-db-target-marker.test.ts', 'tests/p1-cli/n-db-freeze-hosted-shape.test.ts', 'tests/p1-cli/supabase-stack.test.ts'] },
  { alias: 'p1-cli-box-postgres', image: 'public.ecr.aws/supabase/postgres:17.6.1.147', digest: 'sha256:0c0d3539aaf3c8c09a9a5b044ad3f709470e7241f3e4c69e1572bfac1b90a24b', registries: supabaseRegistries,
    users: ['tests/p1-cli/n-db-cron-jobs.test.ts', 'tests/p1-cli/edge-database-recovery.test.ts'] },
  { alias: 'p1-cli-edge-runtime', image: 'public.ecr.aws/supabase/edge-runtime:v1.73.13', digest: 'sha256:e8ddc7b0f4888818159d4b665e922de667948e2864c895ed62acdfd29e7c6c80', registries: supabaseEdgeRegistries,
    users: ['tests/p1-cli/edge-database-recovery.test.ts'] },
];
function testImages() {
  return pinnedTestImages.map(({ alias, image, digest, registries, users }) => {
    for (const file of users) {
      assert.ok(readFileSync(file, 'utf8').includes(`"${image}"`), `${file} no longer runs ${image}; review pinnedTestImages in scripts/ci/server-suite.mjs`);
    }
    const name = image.replace(/:[^/:]+$/, '').split('/').pop();
    return { alias, image, digest, candidates: registries(name, digest) };
  });
}
function imageSet(set = 'stack') {
  assert.ok(set === 'stack' || set === 'test', `unknown image set: ${set}`);
  return set === 'test' ? { label: 'pinned test images', images: testImages() } : { label: 'pinned images', images: stackImages().images };
}
function repositoryOf(reference) {
  return reference.split('@')[0].replace(/:[^/:]+$/, '').replace(/^library\//, '');
}

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 180_000 });
}
function requireDocker(args) {
  const result = docker(args);
  assert.equal(result.status, 0, result.stderr || result.error?.message || `docker ${args[0]} failed`);
  return result.stdout;
}
// Pulls, saves and loads move gigabytes: run them asynchronously with a 20-minute limit.
function longRun(command, args) {
  return new Promise(resolveRun => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_200_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolveRun({ status: null, stdout, stderr, error }));
    child.on('close', (status, signal) => resolveRun({ status, signal, stdout, stderr }));
  });
}
function inspect(image) {
  const result = docker(['image', 'inspect', image]);
  return result.status === 0 ? JSON.parse(result.stdout)[0] : undefined;
}
// Every warm verification of the old edge-runtime cache failed on comparing image IDs (#480), most
// likely because the runner's containerd image store gives a loaded image a different ID than the
// pulled one. Layer diff IDs are the same in either image store and across save and load.
function identity(image) {
  const info = inspect(image);
  assert.ok(info, `image is missing: ${image}`);
  assert.ok(Array.isArray(info.RootFS?.Layers) && info.RootFS.Layers.length > 0, `image has no layers: ${image}`);
  return createHash('sha256').update(JSON.stringify([info.Os, info.Architecture, info.RootFS.Layers])).digest('hex');
}
function localImages() {
  return requireDocker(['image', 'ls', '--no-trunc', '--format', '{{.ID}} {{.Repository}}:{{.Tag}}']).split('\n').filter(Boolean).sort();
}
// Any failed pull is retried, rate limit or not. Each round tries every registry the CLI would try;
// rounds are separated by 10, 30 and 90 seconds (tests pass zero waits).
const pullWaits = (process.env.PINNED_IMAGE_PULL_WAITS ?? '10000,30000,90000').split(',').map(Number);
async function pullImage({ alias, image, digest, candidates }) {
  const failures = [];
  for (let round = 1; round <= pullWaits.length + 1; round += 1) {
    for (const reference of candidates) {
      const result = await longRun('docker', ['pull', '--quiet', reference]);
      if (result.status === 0) {
        const pulled = inspect(reference);
        // Docker records a Docker Hub library image as kong@sha256:..., not library/kong@sha256:....
        const repository = reference.split('@')[0].replace(/:[^/:]+$/, '').replace(/^library\//, '');
        const repoDigest = digest ? `${repository}@${digest}` : pulled?.RepoDigests?.find(entry => entry.startsWith(`${repository}@`));
        assert.ok(repoDigest && pulled?.RepoDigests?.includes(repoDigest), `pulled image must carry its registry digest: ${reference}`);
        if (reference !== image) requireDocker(['tag', reference, image]);
        const id = identity(image);
        assert.equal(id, identity(reference), `tag must name the pulled image: ${image}`);
        console.log(`Pulled ${alias}: ${repoDigest} (round ${round})`);
        return { digest: repoDigest, identity: id };
      }
      const reason = (result.stderr || result.error?.message || `exit ${result.status ?? result.signal}`).trim().split('\n').pop();
      failures.push(`${reference} round ${round}: ${reason}`);
      console.log(`::warning title=Image pull retry::${reference} round ${round}: ${reason}`);
    }
    if (round <= pullWaits.length) await new Promise(resolveWait => setTimeout(resolveWait, pullWaits[round - 1]));
  }
  throw new Error(`could not pull ${alias} after ${pullWaits.length + 1} rounds:\n${failures.join('\n')}`);
}
async function pullAll(images) {
  const entries = {};
  const queue = [...images];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) entries[next.image] = await pullImage(next);
  }));
  return entries;
}
async function prepareImages(directory, cacheHit, set) {
  mkdirSync(directory, { recursive: true });
  const { label, images } = imageSet(set);
  const archive = join(directory, 'images.tar.zst');
  const lockPath = join(directory, 'images.json');
  const snapshot = `${directory}-before-start.json`;
  assert.equal(spawnSync('zstd', ['--version']).status, 0, 'zstd is required for the image cache');
  if (cacheHit === 'true') {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      assert.deepEqual(lock.images, images, 'the cached image list differs from the CLI');
      const loaded = await longRun('bash', ['-c', 'set -o pipefail; zstd -dc -- "$1" | docker load --quiet', 'load', archive]);
      assert.equal(loaded.status, 0, loaded.stderr || loaded.error?.message || 'docker load failed');
      for (const { image } of images) assert.equal(identity(image), lock.entries[image]?.identity, `cached image identity: ${image}`);
      rmSync(archive);
      writeFileSync(snapshot, `${JSON.stringify(localImages())}\n`);
      console.log(`Restored and verified ${images.length} ${label} from the cache; no registry pulls.`);
      return;
    } catch (error) {
      console.log(`::warning title=Image cache::Cached images could not be verified; pulling them. ${String(error.message).split('\n')[0]}`);
    }
  }
  const entries = await pullAll(images);
  const saved = await longRun('bash', ['-c', 'set -o pipefail; out="$1"; shift; docker save "$@" | zstd -q -T0 -3 --force -o "$out"', 'save', archive, ...images.map(({ image }) => image)]);
  assert.equal(saved.status, 0, saved.stderr || saved.error?.message || 'docker save failed');
  writeFileSync(lockPath, `${JSON.stringify({ images, entries }, null, 2)}\n`);
  writeFileSync(snapshot, `${JSON.stringify(localImages())}\n`);
  console.log(`Pulled ${images.length} ${label}; cache archive ${(statSync(archive).size / 1e9).toFixed(2)} GB`);
  // Only a complete pull gets here. A cache miss saves the archive once the stack check passes.
  if (cacheHit !== 'true' && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'save=true\n');
}
// Run after supabase start: every stack container uses a cached image, and nothing was pulled.
function checkStackImages(directory) {
  const { images } = JSON.parse(readFileSync(join(directory, 'images.json'), 'utf8'));
  const before = new Set(JSON.parse(readFileSync(`${directory}-before-start.json`, 'utf8')));
  const pulled = localImages().filter(entry => !before.has(entry));
  const containers = requireDocker(['ps', '--all', '--filter', 'label=com.supabase.cli.project', '--format', '{{.Names}} {{.Image}}'])
    .split('\n').filter(Boolean).map(line => line.split(' '));
  const cached = new Set(images.map(({ image }) => image));
  const outside = containers.filter(([, image]) => !cached.has(image));
  assert.ok(containers.length > 0, 'no local stack containers found');
  assert.deepEqual(pulled, [], `supabase start pulled images outside the cache; review startedAliases and notStarted in scripts/ci/server-suite.mjs:\n${pulled.join('\n')}`);
  assert.deepEqual(outside, [], `stack containers use images outside the cache:\n${outside.map(entry => entry.join(' ')).join('\n')}`);
  const used = new Set(containers.map(([, image]) => image));
  const unused = images.filter(({ alias, image }) => alias !== 'edge-runtime-pinned' && !used.has(image));
  if (unused.length) console.log(`::warning title=Image cache::Cached but not started: ${unused.map(({ alias }) => alias).join(', ')}`);
  console.log(`Local stack started ${containers.length} containers from cached images; supabase start pulled 0 images.`);
}
// Run after the C1 check and the p1-cli suite: each pinned test image still has its cached identity, and no
// image appeared in their repositories (a pull under another tag or digest). Other new images are listed.
function checkTestImages(directory) {
  const { images, entries } = JSON.parse(readFileSync(join(directory, 'images.json'), 'utf8'));
  const before = new Set(JSON.parse(readFileSync(`${directory}-before-start.json`, 'utf8')));
  const repositories = new Set(images.flatMap(({ image, candidates }) => [image, ...candidates].map(repositoryOf)));
  const added = localImages().filter(entry => !before.has(entry));
  const pulled = added.filter(entry => repositories.has(repositoryOf(entry.slice(entry.indexOf(' ') + 1))));
  const changed = images.filter(({ image }) => inspect(image) === undefined || identity(image) !== entries[image]?.identity).map(({ image }) => image);
  const other = added.filter(entry => !pulled.includes(entry));
  if (other.length) console.log(`::warning title=Image cache::New images outside the image caches since the pinned test images were loaded:%0A${other.join('%0A')}`);
  assert.deepEqual(changed, [], `pinned test images changed or went missing after they were loaded; something pulled them:\n${changed.join('\n')}`);
  assert.deepEqual(pulled, [], `images were pulled into the pinned test image repositories; point the caller at the pinned tag in scripts/ci/server-suite.mjs:\n${pulled.join('\n')}`);
  console.log(`Checked ${images.length} pinned test images: unchanged, none pulled from a registry.`);
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
  case 'image-metadata': {
    // stdout goes to GITHUB_OUTPUT; the list goes to the log.
    if (args[0] === 'test') {
      const images = testImages();
      console.error(`${images.length} pinned test images:`);
      for (const { alias, image, digest } of images) console.error(`  ${alias}: ${image} ${digest}`);
      console.log(`key=${createHash('sha256').update(JSON.stringify({ images })).digest('hex')}`);
      console.log(`c1_psql_image=${images.find(({ alias }) => alias === 'c1-psql').image}`);
      break;
    }
    assert.ok(args[0] === undefined || args[0] === 'stack', `unknown image set: ${args[0]}`);
    const { cli, binary, images } = stackImages();
    console.error(`Supabase CLI ${cli} (${binary}); ${images.length} pinned images:`);
    for (const { alias, image } of images) console.error(`  ${alias}: ${image}`);
    console.log(`key=${createHash('sha256').update(JSON.stringify({ cli, images })).digest('hex')}`);
    break;
  }
  case 'prepare-images':
    await prepareImages(args[0], args[1], args[2]);
    break;
  case 'check-stack-images':
    checkStackImages(args[0]);
    break;
  case 'check-test-images':
    checkTestImages(args[0]);
    break;
  default:
    throw new Error('Expected list, receipt, verify, image-metadata, prepare-images, check-stack-images, or check-test-images');
}
