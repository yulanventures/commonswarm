import assert from "node:assert/strict";
import { test } from "node:test";
import { agentLabel, firstNames, initials, agentTint, ordinal, formatWhen, greeting } from "./home-names.ts";

test("the naming table preserves ownership, historical identity and duplicate suffixes", () => {
  const people = [{ id: "t", name: "Tom Langridge" }, { id: "n", name: "Nikki Cooper" }, { id: "n2", name: "Nikki Singh" }];
  assert.deepEqual([...firstNames(people)], [["t", "Tom"], ["n", "Nikki Cooper"], ["n2", "Nikki Singh"]]);
  const cases = [
    [{ name: "Claude", yours: true, ownerName: "Tom Langridge" }, {}, "Your Claude"],
    [{ name: "Claude", yours: true, ownerName: "Tom Langridge" }, { nested: true }, "Claude"],
    [{ name: "Muse", ownerName: "Nikki Cooper" }, {}, "Nikki’s Muse"],
    [{ name: "Muse", ownerName: "Nikki Cooper" }, { nested: true }, "Muse"],
    [{ name: "Grok bot", ownerName: "Marcus Lee" }, {}, "Marcus’s Grok bot"],
    [{ name: "Nikki’s Muse", ownerName: "Nikki Cooper" }, {}, "Nikki’s Muse"],
    [{ name: "Nikki's Muse", ownerName: "Nikki Cooper" }, {}, "Nikki’s Muse"],
    [{ name: "Tom’s Claude", ownerName: "Tom Langridge", yours: true }, {}, "Tom’s Claude"],
    [{ name: "Your Claude", ownerName: "Tom Langridge", yours: true }, {}, "Your Claude"],
    [{ name: "Muse", ownerName: "Nikki Cooper", ownerId: "n" }, { people }, "Nikki Cooper’s Muse"],
    [{ name: "Nikki’s Muse", ownerName: "Nikki Cooper", ownerId: "n" }, { people }, "Nikki Cooper’s Muse"],
    [{ name: "Muse", ownerId: "n" }, { people }, "Nikki Cooper’s Muse"],
    [{ name: "Claude" }, {}, "Claude"],
    [{ name: "Claude · a12b34cd", ownerName: "Tom Langridge", yours: true }, {}, "Your Claude · a12b34cd"],
    [{ name: "Muse · 12345678", ownerName: "Nikki Cooper" }, {}, "Nikki’s Muse · 12345678"],
    [{ name: "Claude", ownerId: null, ownerName: "Tom" }, {}, "Claude (owner left)"],
    [{ name: "Claude", ownerName: "Tom", removed: true }, {}, "Claude (removed)"],
    [{ name: "Claude (removed)", ownerName: "Tom", removed: true }, {}, "Claude (removed)"],
    [{ name: "Claude (removed) · a12b34cd", ownerName: "Tom", removed: true }, {}, "Claude (removed) · a12b34cd"],
    [{ name: "Claude (owner left)", ownerId: null }, {}, "Claude (owner left)"],
  ];
  for (const [agent, opts, expected] of cases) assert.equal(agentLabel(agent, opts), expected);
});

test("initials and tint are stable across order and use Unicode characters", () => {
  for (const [name, expected] of [[" Tom Langridge ", "TL"], ["Nikki", "N"], ["Élodie 李", "É李"], ["", ""], ["𐐀 First", "𐐀F"]]) assert.equal(initials(name), expected);
  // Independent FNV-1a vectors for empty string, a, b and c, folded to four hues.
  for (const [id, expected] of [["", 1], ["a", 0], ["b", 1], ["c", 2]]) assert.equal(agentTint(id), expected);
  assert.deepEqual(["c", "a", "b"].map(agentTint), [2, 0, 1]);
});

test("ordinals include the teen exceptions and larger positions", () => {
  for (const [n, expected] of [[1,"1st"],[2,"2nd"],[3,"3rd"],[4,"4th"],[11,"11th"],[12,"12th"],[13,"13th"],[21,"21st"],[22,"22nd"],[23,"23rd"],[111,"111th"],[112,"112th"],[113,"113th"]]) assert.equal(ordinal(n), expected);
});

test("timestamps use the viewer's local day and locale; bad timestamps stay unknown", () => {
  const now = new Date(2026, 9, 5, 12, 0);
  assert.equal(formatWhen(new Date(2026, 9, 5, 9, 5).toISOString(), now, "en-US"), "9:05 am");
  assert.equal(formatWhen(new Date(2026, 9, 4, 23, 5).toISOString(), now, "en-US"), "Yesterday, 11:05 pm");
  assert.equal(formatWhen(new Date(2026, 9, 3, 9, 5).toISOString(), now, "en-US"), "Oct 3, 9:05 am");
  assert.equal(formatWhen(new Date(2025, 9, 3, 9, 5).toISOString(), now, "en-US"), "Oct 3, 2025, 9:05 am");
  assert.equal(formatWhen(new Date(2026, 9, 5, 9, 5).toISOString(), now, "en-GB"), "9:05");
  assert.equal(formatWhen("invalid", now), "Time unavailable");
  for (const [hour, expected] of [[0,"Good morning"],[11,"Good morning"],[12,"Good afternoon"],[17,"Good afternoon"],[18,"Good evening"],[23,"Good evening"]]) assert.equal(greeting(new Date(2026, 9, 5, hour)), expected);
});

import { agentLabelInSentence } from "./home-names.ts";
test("mid-sentence possessives lower your without changing an agent name", () => {
  assert.equal(agentLabelInSentence("Your Orbit"), "your Orbit");
  assert.equal(agentLabelInSentence("Nikki’s Muse"), "Nikki’s Muse");
  assert.equal(agentLabelInSentence("Yourself"), "Yourself");
  assert.equal(agentLabel({name:"Orbit", yours:true}), "Your Orbit");
});
