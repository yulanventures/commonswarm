import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  decodeInviteLink,
  encodeInviteLink,
  type InviteLinkPayload,
} from "../../src/cloud/invite-link.js";

function payload(): InviteLinkPayload {
  return {
    v: 1,
    url: "http://127.0.0.1:54321",
    anon_key: "local-anon-key",
    workspace_id: randomUUID(),
    invitation_token: `swm_inv_${randomBytes(32).toString("base64url")}`,
    workspace_name: "Design swarm",
    inviter_display_name: "Taylor",
    inviter_user_id: randomUUID(),
  };
}

function forms(value: InviteLinkPayload): {
  cli: string;
  web: string;
  encoded: string;
} {
  const cli = encodeInviteLink(value);
  const encoded = cli.slice("cswarm://accept/".length);
  return {
    cli,
    web: `https://commonswarm.com/invite#invite=${encoded}`,
    encoded,
  };
}

test("D-038: 5 malformed payload in a web wrapper keeps strict base64url validation", () => {
  const original = payload();
  const { web, encoded } = forms(original);
  assert.deepEqual(decodeInviteLink(web), original);
  assert.throws(
    () => decodeInviteLink("https://commonswarm.com/invite#invite=abc="),
    /invite link payload must be strict unpadded base64url/,
  );
  const escapedFirstCharacter = `%${encoded[0]!.charCodeAt(0).toString(16)}`;
  assert.throws(
    () => decodeInviteLink(
      `https://commonswarm.com/invite#invite=${escapedFirstCharacter}${encoded.slice(1)}`,
    ),
    /invite link payload must be strict unpadded base64url/,
  );
});
