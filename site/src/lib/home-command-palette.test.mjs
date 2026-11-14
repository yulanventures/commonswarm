/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCommandPaletteItems } from "./home-command-palette.ts";

const input = { agents: [], members: [], channels: [], leadAgentPrincipalId: null, maySetLead: false };
const offersNewChannel = (extra) =>
  buildCommandPaletteItems({ ...input, ...extra }).some((item) => item.action.type === "new-channel");

test("the palette offers New channel unless the workspace keeps it from this person", () => {
  assert.equal(offersNewChannel({}), true);
  assert.equal(offersNewChannel({ mayCreateChannel: true }), true);
  assert.equal(offersNewChannel({ mayCreateChannel: false }), false);
});
