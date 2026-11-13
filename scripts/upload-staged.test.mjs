// node --test "scripts/*.test.mjs" (the check workflow). The publish workflow's upload step: immutable versions,
// and re-running it after a failure part way, with the bucket and the releases faked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { awsStore, ensureRelease, publishStaged, readStaged } from "./upload-staged.mjs";

const root = mkdtempSync(join(tmpdir(), "upload-staged-"));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

let n = 0;
/** A staging folder (scripts/stage-pack.mjs) with one pack. */
function staged(id = "fan-gwenpool", version = "1.0.0", zipBody = "zip bytes") {
  const dir = join(root, `published-${n++}`);
  const at = join(dir, id);
  write(join(at, "pack.json"), JSON.stringify({ id, version }));
  write(join(at, "entry.json"), JSON.stringify({ id }));
  write(join(at, "zip.sha256"), sha(zipBody));
  write(join(at, `${id}-${version}.zip`), zipBody);
  write(join(at, "preview.json"), "{}");
  write(join(at, "thumb.webp"), "thumb");
  write(join(at, "cards", "en", "01a.webp"), "a");
  writeFileSync(join(dir, "ids.txt"), `${id}\n`);
  return dir;
}

/** An in-memory bucket; `failOn(key)` makes the put of that key throw once, like a dropped connection. */
function fakeStore() {
  const objects = new Map();
  let failKey;
  return {
    objects,
    failOn: (key) => (failKey = key),
    async zipSha256(key) {
      const object = objects.get(key);
      return object ? object.sha256 : null;
    },
    async put(file, { sha256 } = {}) {
      if (file.key === failKey) {
        failKey = undefined;
        throw new Error(`upload of ${file.key} failed`);
      }
      objects.set(file.key, { body: readFileSync(file.path), sha256 });
    },
  };
}

/** In-memory releases; `failCreate()` makes the next create throw after the release exists without its asset. */
function fakeReleases() {
  const releases = new Map();
  let fail = false;
  return {
    releases,
    failCreate: () => (fail = true),
    async view(tag) {
      return releases.get(tag) ?? null;
    },
    async create(tag, pack) {
      releases.set(tag, { assets: [] });
      if (fail) {
        fail = false;
        throw new Error("the release was created, the asset upload failed");
      }
      releases.get(tag).assets.push({ name: pack.zipName, digest: `sha256:${pack.zipSha}` });
    },
    async upload(tag, pack) {
      releases.get(tag).assets.push({ name: pack.zipName, digest: `sha256:${pack.zipSha}` });
    },
  };
}

describe("readStaged", () => {
  it("lists every file to upload under <id>/<version>/, the zip last", () => {
    const [pack] = readStaged(staged());
    assert.deepEqual(
      pack.files.map((f) => f.key),
      [
        "fan-gwenpool/1.0.0/pack.json",
        "fan-gwenpool/1.0.0/preview.json",
        "fan-gwenpool/1.0.0/thumb.webp",
        "fan-gwenpool/1.0.0/cards/en/01a.webp",
        "fan-gwenpool/1.0.0/fan-gwenpool-1.0.0.zip",
      ],
    );
    assert.equal(pack.zipSha, sha("zip bytes"));
  });

  it("finds no packs in a staging folder holding only ids.txt, or no folder", () => {
    const dir = join(root, "deletion-only");
    write(join(dir, "ids.txt"), "");
    assert.deepEqual(readStaged(dir), []);
    assert.deepEqual(readStaged(join(root, "missing")), []);
  });
});

describe("publishStaged", () => {
  it("uploads a new version and creates its release", async () => {
    const store = fakeStore();
    const release = fakeReleases();
    const done = await publishStaged(readStaged(staged()), { store, release });
    assert.deepEqual(done, [{ id: "fan-gwenpool", version: "1.0.0", action: "upload", release: "created" }]);
    assert.equal(store.objects.size, 5);
    assert.equal(store.objects.get("fan-gwenpool/1.0.0/fan-gwenpool-1.0.0.zip").sha256, sha("zip bytes"));
  });

  it("does nothing and succeeds when nothing is staged", async () => {
    assert.deepEqual(await publishStaged([], { store: fakeStore(), release: fakeReleases() }), []);
  });

  it("re-runs after a failure following the upload: skips the bucket, finishes the release", async () => {
    const store = fakeStore();
    const release = fakeReleases();
    const packs = readStaged(staged());
    release.failCreate();
    await assert.rejects(publishStaged(packs, { store, release }), /asset upload failed/);
    const done = await publishStaged(packs, { store, release });
    assert.deepEqual(done, [{ id: "fan-gwenpool", version: "1.0.0", action: "skip", release: "attached" }]);
    assert.deepEqual(release.releases.get("fan-gwenpool-v1.0.0").assets.map((a) => a.name), [
      "fan-gwenpool-1.0.0.zip",
    ]);
    // A third run finds everything in place.
    assert.deepEqual(await publishStaged(packs, { store, release }), [
      { id: "fan-gwenpool", version: "1.0.0", action: "skip", release: "present" },
    ]);
  });

  it("re-uploads a version whose zip never made it (a failure part way through the files)", async () => {
    const store = fakeStore();
    const release = fakeReleases();
    const packs = readStaged(staged());
    store.failOn("fan-gwenpool/1.0.0/fan-gwenpool-1.0.0.zip");
    await assert.rejects(publishStaged(packs, { store, release }), /upload of .* failed/);
    assert.equal(release.releases.size, 0);
    const done = await publishStaged(packs, { store, release });
    assert.equal(done[0].action, "upload");
    assert.equal(done[0].release, "created");
  });

  it("refuses a version already published with a different zip, before uploading anything", async () => {
    const store = fakeStore();
    const release = fakeReleases();
    await publishStaged(readStaged(staged("fan-gwenpool", "1.0.0", "first")), { store, release });
    const before = store.objects.size;
    const changed = [...readStaged(staged("fan-a", "1.0.0")), ...readStaged(staged("fan-gwenpool", "1.0.0", "second"))];
    await assert.rejects(publishStaged(changed, { store, release }), /already published with a different zip/);
    assert.equal(store.objects.size, before, "fan-a was not uploaded either");
  });
});

describe("ensureRelease", () => {
  const pack = { id: "p", version: "1.0.0", zipName: "p-1.0.0.zip", zipSha: "a".repeat(64), zipBytes: 10 };
  const releaseWith = (asset) => ({
    view: async () => ({ assets: [asset] }),
    create: async () => assert.fail("no create"),
    upload: async () => assert.fail("no upload"),
  });

  it("accepts the same asset by digest, or by size when the release has no digest", async () => {
    const digest = `sha256:${pack.zipSha}`;
    assert.equal(await ensureRelease(pack, releaseWith({ name: pack.zipName, digest })), "present");
    assert.equal(await ensureRelease(pack, releaseWith({ name: pack.zipName, size: 10 })), "present");
  });

  it("refuses a release carrying a different zip", async () => {
    await assert.rejects(
      ensureRelease(pack, releaseWith({ name: pack.zipName, digest: `sha256:${"b".repeat(64)}` })),
      /different/,
    );
  });
});

describe("awsStore", () => {
  const exec = (responses) => async (_file, args) => responses[args[1]](args);

  it("reads the stored sha256 metadata, and treats a 404 as no object", async () => {
    const store = awsStore({
      endpoint: "e",
      bucket: "b",
      dir: root,
      exec: exec({
        "head-object": (args) =>
          args.includes("missing")
            ? { code: 254, stdout: "", stderr: "An error occurred (404) when calling the HeadObject operation" }
            : { code: 0, stdout: JSON.stringify({ Metadata: { sha256: "c".repeat(64) } }), stderr: "" },
      }),
    });
    assert.equal(await store.zipSha256("missing"), null);
    assert.equal(await store.zipSha256("there"), "c".repeat(64));
  });

  it("downloads and hashes a zip uploaded without the metadata", async () => {
    const store = awsStore({
      endpoint: "e",
      bucket: "b",
      dir: root,
      exec: exec({
        "head-object": () => ({ code: 0, stdout: JSON.stringify({ Metadata: {} }), stderr: "" }),
        cp: (args) => {
          writeFileSync(args[4], "old zip");
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    });
    assert.equal(await store.zipSha256("k"), sha("old zip"));
  });

  it("fails on any other head-object error", async () => {
    const store = awsStore({
      endpoint: "e",
      bucket: "b",
      dir: root,
      exec: exec({ "head-object": () => ({ code: 255, stdout: "", stderr: "An error occurred (403): Forbidden" }) }),
    });
    await assert.rejects(store.zipSha256("k"), /Forbidden/);
  });
});
