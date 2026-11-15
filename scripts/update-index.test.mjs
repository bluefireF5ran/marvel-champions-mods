// node --test "scripts/*.test.mjs" (the script tests workflow). The registry's upsert into the store's index.json.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isListed } from "./listed-version.mjs";
import { catalogTags, compareVersions, ownershipProblems, updateIndex } from "./update-index.mjs";

const BASE = "https://packs.example.app";
const pack = (id, version, extra = {}) => ({
  id,
  entry: { creator: "Neptune", tags: ["hero"], summary: extra.summary },
  manifest: { id, version, kind: "hero", name: extra.name ?? "Gwenpool", description: "A pack.", requires: {} },
  sha: extra.sha ?? "a".repeat(64),
  zipBytes: 100,
  hasThumb: true,
});
const opts = (published, live = ["fan-gwenpool"]) => ({
  published,
  liveIds: new Set(live),
  baseUrl: BASE,
  fallbackBase: "https://github.com/o/r/releases/download",
  today: "2026-11-13",
  now: "2026-11-13T00:00:00Z",
});

describe("compareVersions", () => {
  it("orders pre-releases by SemVer precedence", () => {
    const order = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-beta.11.1",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1-alpha",
      "1.10.0",
    ];
    assert.deepEqual([...order].reverse().sort(compareVersions), order);
    assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.10") < 0);
    assert.equal(compareVersions("1.0.0+a", "1.0.0+b"), 0);
  });
});

describe("updateIndex", () => {
  it("makes the highest version latest, not the one just published, and keeps its fields", () => {
    let index = updateIndex(undefined, opts([pack("fan-gwenpool", "1.0.0-beta.10", { name: "New" })]));
    index = updateIndex(index, opts([pack("fan-gwenpool", "1.0.0-beta.2", { name: "Old", sha: "b".repeat(64) })]));
    const gwen = index.packs[0];
    assert.equal(gwen.latest, "1.0.0-beta.10");
    assert.equal(gwen.name, "New");
    assert.equal(gwen.thumbnail, `${BASE}/fan-gwenpool/1.0.0-beta.10/thumb.webp`);
    assert.deepEqual(Object.keys(gwen.versions).sort(), ["1.0.0-beta.10", "1.0.0-beta.2"]);
    index = updateIndex(index, opts([pack("fan-gwenpool", "1.0.0", { sha: "c".repeat(64) })]));
    assert.equal(index.packs[0].latest, "1.0.0");
  });

  it("does not list a withdrawn pack again when it is published", () => {
    const current = updateIndex(undefined, opts([pack("fan-gwenpool", "1.0.0")]));
    current.packs[0].withdrawn = true;
    const next = updateIndex(current, opts([pack("fan-gwenpool", "1.1.0", { sha: "d".repeat(64) })]));
    assert.equal(next.packs[0].withdrawn, true);
  });

  it("keeps the game repo's packs, withdrawn or not, and drops its own deleted entries", () => {
    const current = {
      schema: 2,
      packs: [
        { id: "carnage-nep", name: "Carnage", withdrawn: true, versions: {} },
        { id: "old-pack", name: "Old", source: "registry", withdrawn: false, versions: {} },
      ],
    };
    const next = updateIndex(current, opts([pack("fan-gwenpool", "1.0.0")]));
    assert.deepEqual(
      next.packs.map((p) => [p.id, p.withdrawn]),
      [
        ["carnage-nep", true],
        ["fan-gwenpool", false],
      ],
    );
  });
});

describe("one publisher per pack id", () => {
  const gameEntry = (source) => ({
    id: "fan-gwenpool",
    name: "Gwenpool",
    withdrawn: false,
    versions: { "1.0.0": {} },
    ...(source ? { source } : {}),
  });

  it("refuses an id the game repo published first, with source game or no source", () => {
    for (const source of ["game", undefined]) {
      const current = { schema: 2, packs: [gameEntry(source)] };
      assert.equal(ownershipProblems(current, ["fan-gwenpool"]).length, 1);
      assert.throws(() => updateIndex(current, opts([pack("fan-gwenpool", "1.1.0")])), /another publisher/);
    }
  });

  it("lets the registry publish ids that are new or already its own", () => {
    assert.deepEqual(ownershipProblems(undefined, ["fan-gwenpool"]), []);
    const first = updateIndex(undefined, opts([pack("fan-gwenpool", "1.0.0")]));
    assert.equal(first.packs[0].source, "registry");
    assert.deepEqual(ownershipProblems(first, ["fan-gwenpool"]), []);
    const second = updateIndex(first, opts([pack("fan-gwenpool", "1.1.0", { sha: "e".repeat(64) })]));
    assert.equal(second.packs[0].latest, "1.1.0");
  });

  it("refuses the id once the game repo has written its own entry over the registry's", () => {
    const registry = updateIndex(undefined, opts([pack("fan-gwenpool", "1.0.0")]));
    // The game repo's upsert replaces the head fields with its own entry, which carries no source.
    const { source: _dropped, ...overwritten } = registry.packs[0];
    const current = { ...registry, packs: [overwritten] };
    assert.throws(() => updateIndex(current, opts([pack("fan-gwenpool", "1.1.0")])), /another publisher/);
    // And deleting the registry's file no longer drops it: it is the game repo's now.
    assert.deepEqual(
      updateIndex(current, opts([], [])).packs.map((p) => p.id),
      ["fan-gwenpool"],
    );
  });

  it("withdraws only the registry's entries when their files are deleted", () => {
    const current = {
      schema: 2,
      packs: [
        { ...gameEntry("game"), id: "game-pack", name: "Game" },
        { ...gameEntry(undefined), id: "legacy-pack", name: "Legacy" },
        { ...gameEntry("registry"), id: "registry-pack", name: "Registry" },
      ],
    };
    assert.deepEqual(
      updateIndex(current, opts([], [])).packs.map((p) => p.id),
      ["game-pack", "legacy-pack"],
    );
  });
});

describe("adopting the game repo's ids (adopt: game)", () => {
  const game = (source) => ({
    id: "fan-gwenpool",
    name: "Gwenpool",
    approved: "2026-11-01",
    latest: "1.0.0",
    withdrawn: false,
    versions: { "1.0.0": { zipSha256: "f".repeat(64) } },
    ...(source ? { source } : {}),
  });
  const adopting = (published, live = ["fan-gwenpool"]) => ({ ...opts(published, live), adopted: new Set(live) });

  it("lets an adopted id through, from the game repo only", () => {
    const adopted = new Set(["fan-gwenpool"]);
    for (const source of ["game", undefined]) {
      assert.deepEqual(ownershipProblems({ packs: [game(source)] }, ["fan-gwenpool"], adopted), []);
    }
    assert.equal(ownershipProblems({ packs: [game("elsewhere")] }, ["fan-gwenpool"], adopted).length, 1);
  });

  it("makes the entry the registry's with the game repo's versions as they were, with nothing built", () => {
    const gwen = updateIndex({ schema: 2, packs: [game("game")] }, adopting([])).packs[0];
    assert.equal(gwen.source, "registry");
    assert.equal(gwen.approved, "2026-11-01");
    assert.deepEqual(gwen.versions, { "1.0.0": { zipSha256: "f".repeat(64) } });
  });

  it("keeps an already listed version and adds a new one", () => {
    const gwen = updateIndex(
      { schema: 2, packs: [game(undefined)] },
      adopting([pack("fan-gwenpool", "1.0.0"), pack("fan-gwenpool", "1.1.0", { sha: "b".repeat(64) })]),
    ).packs[0];
    assert.equal(gwen.source, "registry");
    assert.equal(gwen.versions["1.0.0"].zipSha256, "f".repeat(64));
    assert.equal(gwen.versions["1.1.0"].zipSha256, "b".repeat(64));
    assert.equal(gwen.latest, "1.1.0");
  });

  it("leaves the entry the game repo's while the adopting file is not there", () => {
    const next = updateIndex({ schema: 2, packs: [game("game")] }, { ...opts([], []), adopted: new Set(["fan-gwenpool"]) });
    assert.equal(next.packs[0].source, "game");
  });
});

describe("listed-version", () => {
  it("says whether index.json lists a pack at a version", () => {
    const index = { packs: [{ id: "fan-gwenpool", versions: { "1.0.0": {} } }] };
    assert.equal(isListed(index, "fan-gwenpool", "1.0.0"), true);
    assert.equal(isListed(index, "fan-gwenpool", "1.0.1"), false);
    assert.equal(isListed(index, "other", "1.0.0"), false);
    assert.equal(isListed(undefined, "fan-gwenpool", "1.0.0"), false);
  });
});

describe("preview", () => {
  it("lists preview.json on the version when the build wrote one, and the thumbnail on the pack", () => {
    const withPreview = { ...pack("fan-gwenpool", "1.0.0"), hasPreview: true };
    const gwen = updateIndex(undefined, opts([withPreview])).packs[0];
    assert.equal(gwen.versions["1.0.0"].preview, `${BASE}/fan-gwenpool/1.0.0/preview.json`);
    assert.equal(gwen.thumbnail, `${BASE}/fan-gwenpool/1.0.0/thumb.webp`);
    const without = updateIndex(undefined, opts([{ ...pack("fan-gwenpool", "1.0.0"), hasThumb: false }])).packs[0];
    assert.equal(without.versions["1.0.0"].preview, undefined);
    assert.equal(without.thumbnail, undefined);
  });
});

describe("catalogTags", () => {
  it("lists the entry's tags, then the creator's from pack.json, once each ignoring case", () => {
    assert.deepEqual(catalogTags(["hero"], { tags: [" Symbiote ", "HERO", "symbiote", "Aggression"] }), [
      "hero",
      "Symbiote",
      "Aggression",
    ]);
  });

  it("skips bad creator tags and keeps at most eight", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    assert.deepEqual(catalogTags([], { tags: [1, "", "x".repeat(25), ...many] }), many.slice(0, 8));
    assert.deepEqual(catalogTags(undefined, {}), []);
  });

  it("is what a published entry carries", () => {
    const published = [pack("fan-gwenpool", "1.0.0")];
    published[0].manifest.tags = ["Spider-Verse"];
    const index = updateIndex(undefined, opts(published));
    assert.deepEqual(index.packs[0].tags, ["hero", "Spider-Verse"]);
  });
});
