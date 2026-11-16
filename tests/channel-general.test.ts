/** --channel general (Dogfood #4): unfiled messages as a selector for posting and reading, while the
 * name stays reserved for channel create and rename. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { channelSlugProblem, GENERAL_CHANNEL_SLUG, isGeneralChannel } from "../src/cloud/channels.js";
import { cloudTarget } from "../src/cloud/config.js";
import { readSignals } from "../src/cloud/signals.js";
import { GENERAL_CHANNEL_SLUG as EDGE_GENERAL, channelSlugProblem as edgeChannelSlugProblem } from "../supabase/functions/_shared/channels.js";

const WORKSPACE = "66666666-6666-4666-8666-666666666666";
const USER = "44444444-4444-4444-8444-444444444444";

test("general selects unfiled messages in any case, and stays reserved as a channel name", () => {
  assert.equal(GENERAL_CHANNEL_SLUG, EDGE_GENERAL);
  for (const value of ["general", "General", " GENERAL "]) assert.equal(isGeneralChannel(value), true, value);
  for (const value of ["generals", "ops", "all-signals"]) assert.equal(isGeneralChannel(value), false, value);
  assert.match(channelSlugProblem("general")!, /reserved/);
  assert.equal(channelSlugProblem("general"), edgeChannelSlugProblem("general"));
});

test("a person's --channel general read filters strictly to channel_id IS NULL", async () => {
  const urls: URL[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    urls.push(new URL(String(url)));
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await readSignals(cloudTarget("http://127.0.0.1:1", "anon"), { kind: "human", accessToken: "jwt", userId: USER },
    { workspaceId: WORKSPACE, inbox: false, unfiledOnly: true }, fetcher);
  assert.equal(urls[0]!.searchParams.get("channel_id"), "is.null");
  assert.match(urls[0]!.searchParams.get("select")!, /channel_id/);
  await readSignals(cloudTarget("http://127.0.0.1:1", "anon"), { kind: "human", accessToken: "jwt", userId: USER },
    { workspaceId: WORKSPACE, inbox: false }, fetcher);
  assert.equal(urls[1]!.searchParams.has("channel_id"), false, "no selector, no filter");
});
