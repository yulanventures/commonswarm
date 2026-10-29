import assert from "node:assert/strict";
import test from "node:test";
import {
  H0_VERBS,
  h0AgentDocumentDescription,
} from "../../src/h0/verbs.js";
import {
  buildH0AgentDocument,
  handleH0Request,
  internalErrorResponse,
} from "../../supabase/functions/h0/core.js";

import {
  SIGNAL_RECIPIENT_KINDS,
  SIGNAL_RECIPIENT_MAX,
} from "../../supabase/functions/_shared/channels.js";
import {
  DELIVERY_ACK_OUTCOMES,
  DELIVERY_CLIENT_ERROR_CODES,
} from "../../supabase/functions/command/durable-delivery.js";
import { H0_SEAT_TOKEN_TTL_MS } from "../../src/protocol/index.js";

/* The enforcement's own constants — the same four index.ts passes. */
const WIRE = {
  recipientKinds: SIGNAL_RECIPIENT_KINDS,
  recipientMax: SIGNAL_RECIPIENT_MAX,
  ackOutcomes: DELIVERY_ACK_OUTCOMES,
  ackErrorCodes: DELIVERY_CLIENT_ERROR_CODES,
};

function agentDescription(): string {
  return h0AgentDocumentDescription(H0_SEAT_TOKEN_TTL_MS);
}

function agentDocument(): Record<string, unknown> {
  return buildH0AgentDocument(H0_VERBS, agentDescription(), WIRE);
}

test("agent document response never reflects a locator or credential value", async () => {
  const credential = "swm_join_AbCdEf0123456789_SECRET";
  const spellings = [
    credential,
    credential.toLowerCase(),
    credential.toUpperCase(),
    encodeURIComponent(credential),
  ];
  const bodies: string[] = [];

  for (const spelling of spellings) {
    const response = handleH0Request(
      new Request(`https://api.commonswarm.com/functions/v1/h0/agent-doc/${spelling}`),
      agentDocument(),
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    bodies.push(body);
    for (const forbidden of spellings) {
      assert.equal(body.includes(forbidden), false);
      /* HEADERS TOO. An arm noted this checked only the body, so a value echoed into a header
       * would have passed a test whose name says the response never reflects a locator. */
      for (const [, value] of response.headers) {
        assert.equal(value.includes(forbidden), false, `header reflects ${forbidden}`);
      }
    }
  }
  assert.equal(new Set(bodies).size, 1, "every locator names the same document");
});

test("every H0 response disables caching and indexing", () => {
  const requests = [
    new Request("https://api.commonswarm.com/functions/v1/h0/agent-doc/public-locator"),
    new Request("https://api.commonswarm.com/functions/v1/h0/agent-doc/public-locator", {
      method: "POST",
    }),
    new Request("https://api.commonswarm.com/functions/v1/h0/not-a-route"),
  ];

  for (const request of requests) {
    const response = handleH0Request(request, agentDocument());
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      response.headers.get("x-robots-tag"),
      "noindex, nofollow, noarchive",
    );
  }
});

test("error responses carry the no-store and robots headers too", () => {
  /* Test 3 only ever checked a 200. An arm noted the 500 path was never exercised. */
  const document = buildH0AgentDocument(H0_VERBS, agentDescription(), WIRE);
  const cases = [
    handleH0Request(new Request("https://api.commonswarm.com/h0/nope"), document),
    handleH0Request(
      new Request("https://api.commonswarm.com/h0/agent-doc/x", { method: "DELETE" }),
      document,
    ),
    internalErrorResponse(),
  ];
  for (const response of cases) {
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      response.headers.get("x-robots-tag"),
      "noindex, nofollow, noarchive",
    );
  }
});

/* ---------------------------------------------------------------------------------------------
 * Wire type extraction, by AST. Comments and formatting are inert.
 * ------------------------------------------------------------------------------------------- */

test("the OPTIONS preflight carries the no-store, robots and CORS headers", () => {
  /* An arm stripped these from OPTIONS only and every test stayed green. */
  const response = handleH0Request(
    new Request("https://api.commonswarm.com/h0/agent-doc/abc", { method: "OPTIONS" }),
    agentDocument(),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});
