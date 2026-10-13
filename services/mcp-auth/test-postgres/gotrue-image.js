import assert from 'node:assert/strict';

export const GOTRUE_IMAGE_TAG = 'public.ecr.aws/supabase/gotrue:v2.197.0';
// TASK-int-fix8's 2026-10-13 registry measurement supersedes tag resolution.
// FACTS-box-20261012 item 2 alone measured a local image ID, not a RepoDigest.
const expectedRegistryDigest = 'sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const pinnedImage = `${GOTRUE_IMAGE_TAG.split(':v')[0]}@${expectedRegistryDigest}`;

export function pullBoxMatchedGoTrue(docker, t) {
  docker(['pull', pinnedImage]);
  const repoDigests = JSON.parse(docker(['image', 'inspect', pinnedImage, '--format', '{{json .RepoDigests}}']));
  assert.ok(Array.isArray(repoDigests) && repoDigests.includes(pinnedImage),
    `GoTrue RepoDigests must contain the box-matched registry pin ${pinnedImage}`);
  const verifiedDigest = repoDigests.find(value => value === pinnedImage).split('@')[1];
  t.diagnostic(`GoTrue production=${GOTRUE_IMAGE_TAG}; box_expected_registry=${expectedRegistryDigest}; CI_verified_registry=${verifiedDigest}`);
  return pinnedImage;
}
