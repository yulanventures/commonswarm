import assert from "node:assert/strict";
import { test } from "node:test";

import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { errors } from "oidc-provider";
import instance from "oidc-provider/lib/helpers/weak_cache.js";

import { createMcpProvider, ISSUER, RESOURCE, TEST_ACCOUNT_ID } from "../src/provider.js";

const CLAUDE_CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";

// The seven-field public metadata shape reported in TASK-10; no algorithm hint.
function claudeMetadata() {
  return {
    client_id: CLAUDE_CLIENT_ID,
    client_name: "Claude",
    client_uri: "https://claude.ai",
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

test("Claude-shaped CIMD without algorithm metadata resolves and issues ES256 tokens", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...await exportJWK(privateKey), alg: "ES256", kid: "client-defaults-test", use: "sig" };
  let fetches = 0;
  const provider = await createMcpProvider({
    jwks: { keys: [jwk] },
    fetch: async (url) => {
      assert.equal(String(url), CLAUDE_CLIENT_ID);
      fetches += 1;
      return new Response(JSON.stringify(claudeMetadata()), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const client = await provider.Client.find(CLAUDE_CLIENT_ID);
  assert.equal(fetches, 1);
  assert.equal(client.clientIdMetadataDocument, true);
  assert.equal(client.tokenEndpointAuthMethod, "none");
  assert.equal(client.grantTypeAllowed("refresh_token"), true);

  const idToken = new provider.IdToken({ sub: TEST_ACCOUNT_ID }, { client });
  idToken.scope = "openid";
  const issuedIdToken = await idToken.issue({ use: "idtoken" });
  const verifiedIdToken = await jwtVerify(issuedIdToken, publicKey, {
    algorithms: ["ES256"], issuer: ISSUER, audience: CLAUDE_CLIENT_ID,
  });
  assert.equal(verifiedIdToken.protectedHeader.alg, "ES256");
  assert.equal(verifiedIdToken.payload.sub, TEST_ACCOUNT_ID);

  // Read the pinned provider's resource callback so this tests the production
  // signing settings rather than supplying a second copy of those settings.
  const resourceServer = await instance(provider).configuration.features.resourceIndicators
    .getResourceServerInfo(undefined, RESOURCE, client);
  const accessToken = new provider.AccessToken({
    client, resourceServer, accountId: TEST_ACCOUNT_ID, scope: "mcp", grantId: "test-grant",
  });
  const issuedAccessToken = await accessToken.save();
  const verifiedAccessToken = await jwtVerify(issuedAccessToken, publicKey, {
    algorithms: ["ES256"], issuer: ISSUER, audience: RESOURCE,
  });
  assert.equal(verifiedAccessToken.protectedHeader.alg, "ES256");
  assert.equal(verifiedAccessToken.payload.sub, TEST_ACCOUNT_ID);
  assert.equal(verifiedAccessToken.payload.grant_id, "test-grant");
});

test("DCR metadata validates with omitted algorithms and supported grant/response defaults", async () => {
  const provider = await createMcpProvider();
  await provider.Client.validate(claudeMetadata());

  const minimal = {
    client_id: "dcr-client",
    redirect_uris: claudeMetadata().redirect_uris,
  };
  await provider.Client.validate(minimal);
  const client = new provider.Client(minimal);
  assert.equal(client.responseTypeAllowed("code"), true);
  assert.equal(client.grantTypeAllowed("authorization_code"), true);
  assert.equal(client.idTokenSignedResponseAlg, "ES256");
  assert.equal(client.tokenEndpointAuthMethod, "none");
});

test("explicit unsupported ID-token algorithms remain invalid for CIMD and DCR metadata", async () => {
  for (const alg of ["RS256", "ES384", "none"]) {
    const metadata = { ...claudeMetadata(), id_token_signed_response_alg: alg };
    const provider = await createMcpProvider({
      fetch: async () => new Response(JSON.stringify(metadata), {
        headers: { "content-type": "application/json" },
      }),
    });
    const expected = {
      constructor: errors.InvalidClientMetadata,
      error: "invalid_client_metadata",
      error_description: "id_token_signed_response_alg must be 'ES256'",
    };
    await assert.rejects(provider.Client.find(CLAUDE_CLIENT_ID), expected);
    await assert.rejects(provider.Client.validate(metadata), expected);
  }
});
