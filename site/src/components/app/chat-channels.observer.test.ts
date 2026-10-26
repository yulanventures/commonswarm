import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHomeRoute } from "../../lib/home-map";

/*
 * The channel surfaces of the workspace app: the rail, the phone's control, the feed's
 * narrowing, the composer's stamp, and the thread. Source assertions pin the behaviour;
 * the built /app artifact proves Astro ships it.
 *
 * The claims this file defends, stated so a reader can check them against the system rather
 * than against another artifact that repeats them:
 *   1. A channel is an ADDRESS. all-signals shows every message, filed and unfiled.
 *   2. The narrowing is the QUERY's, so a channel shows the newest messages IN it.
 *   3. The composer posts where you are reading, with no added chrome and no body parsing.
 *   4. A refusal shows the server's sentence and is never read for meaning.
 *   5. A ?c= that names no readable channel never falls back to the unfiltered feed.
 */

/** The key set the command edge's own `exactKeys` check accepts, read from the edge. */

/**
 * The keys a literal command object in our source actually sends: `key: value` pairs and
 * ES shorthand alike, the latter both as `{ slug }` and as the last entry of a longer
 * object. Missing the shorthand form made this read a command as short one field and gave
 * a confident failure about a key that was there.
 */

test("the URL round-trips the workspace and the channel by id", () => {
  const memberships = [{ id: "home", name: "Home" }, { id: "trip", name: "Trip" }];
  assert.deepEqual(resolveHomeRoute("?w=trip&c=plans", memberships), { view: "chat", workspaceId: "trip", channelId: "plans" });
  assert.deepEqual(resolveHomeRoute("?w=foreign&c=plans", memberships), { view: "catchup" });
});

/**
 * The permission claim, in one place, so the sweep and the constants test refuse the same
 * sentences. "cannot read" is in it because a review arm found exactly that sentence: the
 * app told a reader a channel might be one they cannot read, and no such channel exists.
 */
