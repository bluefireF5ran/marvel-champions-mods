// node --test "scripts/*.test.mjs" (the check workflow). The registry's upsert into the store's index.json.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareVersions, updateIndex } from "./update-index.mjs";

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
