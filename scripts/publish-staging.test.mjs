// node --test "scripts/*.test.mjs" (the check workflow). The publish workflow's hand-off from the build job to the
// upload job: scripts/stage-pack.mjs stages what `mc-pack build --out` wrote, and scripts/update-index.mjs (as the
// workflow runs it) turns the staging folder and the live ids into index.json, including runs that stage no pack.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stagePack } from "./stage-pack.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const BASE = "https://packs.example.app";
const FALLBACK = "https://github.com/o/r/releases/download";
const root = mkdtempSync(join(tmpdir(), "publish-staging-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const fresh = (name) => {
  const dir = join(root, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const write = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

/** A work dir as scripts/build-entry.sh leaves it, with `out/` laid out as `mc-pack build --out` writes it. */
function builtWork(id, version, { preview = true, thumb = true } = {}) {
  const work = fresh(`work-${id}`);
  write(join(work, "entry.json"), JSON.stringify({ id, creator: "Neptune", tags: ["hero"] }));
  write(join(work, "zip.sha256"), `${"a".repeat(64)}\n`);
  const out = join(work, "out");
  const manifest = { id, version, kind: "hero", name: id, description: "A pack.", requires: { app: "0.40.0" } };
  write(join(out, "pack.json"), JSON.stringify(manifest));
  write(join(out, `${id}-${version}.zip`), "zip bytes");
  if (preview) write(join(out, "preview.json"), JSON.stringify({ schema: 1, packId: id, version }));
  if (thumb) write(join(out, "thumb.webp"), "thumb");
  // The build also writes the pack's data files and pictures; only the pictures are staged.
  write(join(out, "cards.json"), "[]");
  write(join(out, "cards", "en", "01a.webp"), "a");
  write(join(out, "cards", "en", "01b.webp"), "b");
  write(join(out, "cards", "es", "01a.webp"), "a-es");
  write(join(src(work), "thumb.webp"), "a source picture, not the build's thumbnail");
  return work;
}
const src = (work) => join(work, "src");

/** Runs scripts/update-index.mjs the way publish.yml does, and returns the index it prints. */
function runUpdateIndex(current, published, ids) {
  const idsFile = join(fresh("ids"), "ids.txt");
  writeFileSync(idsFile, ["# live ids", ...ids].join("\n") + "\n");
  let currentPath = "-";
  if (current) {
    currentPath = join(fresh("current"), "index.json");
    writeFileSync(currentPath, JSON.stringify(current));
  }
  const stdout = execFileSync(
    process.execPath,
    [join(scripts, "update-index.mjs"), currentPath, published, idsFile, BASE, FALLBACK],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(stdout);
}

describe("stagePack", () => {
  it("stages the build's zip, pack.json, preview.json, thumb.webp and card pictures", () => {
    const published = fresh("published");
    const target = stagePack(builtWork("fan-gwenpool", "1.0.0"), published);
    assert.deepEqual(readdirSync(target).sort(), [
      "cards",
      "entry.json",
      "fan-gwenpool-1.0.0.zip",
      "pack.json",
      "preview.json",
      "thumb.webp",
      "zip.sha256",
    ]);
    assert.deepEqual(readdirSync(join(target, "cards")).sort(), ["en", "es"]);
    assert.deepEqual(readdirSync(join(target, "cards", "en")).sort(), ["01a.webp", "01b.webp"]);
    // The build's thumbnail (the featured card), not a picture from the pack's source.
    assert.equal(readFileSync(join(target, "thumb.webp"), "utf8"), "thumb");
  });

  it("refuses to stage the same id twice", () => {
    const published = fresh("published");
    stagePack(builtWork("fan-gwenpool", "1.0.0"), published);
    assert.throws(() => stagePack(builtWork("fan-gwenpool", "1.0.0"), published), /staged twice/);
  });
});

describe("staging folder to index.json", () => {
  it("gives the published version its preview and the pack its thumbnail", () => {
    const published = fresh("published");
    stagePack(builtWork("fan-gwenpool", "1.0.0"), published);
    writeFileSync(join(published, "ids.txt"), "fan-gwenpool\n");
    const index = runUpdateIndex(undefined, published, ["fan-gwenpool"]);
    const [gwen] = index.packs;
    assert.equal(gwen.source, "registry");
    assert.equal(gwen.thumbnail, `${BASE}/fan-gwenpool/1.0.0/thumb.webp`);
    assert.equal(gwen.versions["1.0.0"].preview, `${BASE}/fan-gwenpool/1.0.0/preview.json`);
    assert.equal(gwen.versions["1.0.0"].zip, `${BASE}/fan-gwenpool/1.0.0/fan-gwenpool-1.0.0.zip`);
  });

  it("leaves preview and thumbnail out when the build wrote neither", () => {
    const published = fresh("published");
    stagePack(builtWork("fan-gwenpool", "1.0.0", { preview: false, thumb: false }), published);
    const [gwen] = runUpdateIndex(undefined, published, ["fan-gwenpool"]).packs;
    assert.equal(gwen.thumbnail, undefined);
    assert.equal(gwen.versions["1.0.0"].preview, undefined);
  });

  const current = {
    schema: 2,
    packs: [
      { id: "carnage-nep", name: "Carnage", versions: {}, withdrawn: false },
      { id: "fan-gwenpool", name: "Gwenpool", source: "registry", versions: {}, withdrawn: false },
      { id: "fan-yondu", name: "Yondu", source: "registry", versions: {}, withdrawn: false },
    ],
  };

  it("withdraws a deleted entry on a run that staged no pack (only ids.txt)", () => {
    const published = fresh("published");
    writeFileSync(join(published, "ids.txt"), "fan-yondu\n");
    const index = runUpdateIndex(current, published, ["fan-yondu"]);
    assert.deepEqual(
      index.packs.map((p) => p.id),
      ["carnage-nep", "fan-yondu"],
    );
  });

  it("withdraws the last registry entry, keeping the game repo's packs", () => {
    const published = fresh("published");
    const index = runUpdateIndex(current, published, []);
    assert.deepEqual(
      index.packs.map((p) => p.id),
      ["carnage-nep"],
    );
  });

  it("starts an index for an empty registry with no index.json yet", () => {
    const index = runUpdateIndex(undefined, join(root, "no-such-folder"), []);
    assert.equal(index.schema, 2);
    assert.deepEqual(index.packs, []);
  });

  it("fails the merge for an id the game repo publishes", () => {
    const published = fresh("published");
    stagePack(builtWork("carnage-nep", "2.0.0"), published);
    assert.throws(
      () => runUpdateIndex(current, published, ["carnage-nep"]),
      (error) => /another publisher/.test(String(error.stderr)),
    );
  });
});
