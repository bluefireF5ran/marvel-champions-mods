// node --test "scripts/*.test.mjs" (the script tests workflow). The publish workflow's upload step: immutable versions,
// and re-running it after a failure part way, with the bucket and the releases faked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { awsStore, ensureRelease, ghRelease, publishStaged, readStaged } from "./upload-staged.mjs";

const root = mkdtempSync(join(tmpdir(), "upload-staged-"));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const write = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

let n = 0;
/** A staging folder (scripts/stage-pack.mjs) with one pack; `other` overrides the non-zip files' bytes. */
function staged(id = "fan-gwenpool", version = "1.0.0", zipBody = "zip bytes", other = {}) {
  const dir = join(root, `published-${n++}`);
  const at = join(dir, id);
  write(join(at, "pack.json"), other.manifest ?? JSON.stringify({ id, version }));
  write(join(at, "entry.json"), JSON.stringify({ id }));
  write(join(at, "zip.sha256"), sha(zipBody));
  write(join(at, `${id}-${version}.zip`), zipBody);
  write(join(at, "preview.json"), other.preview ?? "{}");
  write(join(at, "thumb.webp"), other.thumb ?? "thumb");
  write(join(at, "cards", "en", "01a.webp"), other.card ?? "a");
  writeFileSync(join(dir, "ids.txt"), `${id}\n`);
  return dir;
}

/**
 * An in-memory bucket whose every put honours If-None-Match like R2; `failOn(key)` makes the put of that key throw
 * once, like a dropped connection. Two stores over one `objects` map are two publishers writing the same bucket;
 * `beforePut` runs before each put (a hook to line two publishers up after both have planned).
 */
function fakeStore(objects = new Map(), { beforePut = async () => {} } = {}) {
  let failKey;
  const puts = [];
  return {
    objects,
    puts,
    failOn: (key) => (failKey = key),
    async sha256(key) {
      const object = objects.get(key);
      return object ? object.sha256 : null;
    },
    async put(file) {
      await beforePut();
      puts.push(file.key);
      if (file.key === failKey) {
        failKey = undefined;
        throw new Error(`upload of ${file.key} failed`);
      }
      if (objects.has(file.key)) return "exists";
      objects.set(file.key, { body: readFileSync(file.path), sha256: file.sha256 });
      return "written";
    },
  };
}

/** Resolves once `count` callers are waiting on it: both publishers have planned before either uploads. */
function barrier(count) {
  let waiting = 0;
  let release;
  const all = new Promise((resolve) => (release = resolve));
  return async () => {
    if (++waiting === count) release();
    await all;
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
    assert.equal(pack.files[2].sha256, sha("thumb"));
    assert.equal(pack.files[3].name, "cards/en/01a.webp");
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

  it("refuses a version whose zip never made it but whose other files are there with other bytes", async () => {
    // Another build's pack.json and thumbnail, left by a run that stopped before its zip.
    const store = fakeStore();
    const theirs = readStaged(staged("fan-gwenpool", "1.0.0", "zip", { thumb: "their thumb" }))[0];
    for (const file of theirs.files.filter((f) => f.name !== theirs.zipName)) await store.put(file);
    const before = store.objects.size;
    await assert.rejects(
      publishStaged(readStaged(staged("fan-gwenpool", "1.0.0", "zip", { thumb: "our thumb" })), {
        store,
        release: fakeReleases(),
      }),
      /already published with a different thumb\.webp/,
    );
    assert.equal(store.objects.size, before, "nothing was uploaded");
  });

  it("refuses a version whose zip matches but whose card picture differs", async () => {
    const store = fakeStore();
    await publishStaged(readStaged(staged("fan-gwenpool", "1.0.0", "zip", { card: "one" })), {
      store,
      release: fakeReleases(),
    });
    await assert.rejects(
      publishStaged(readStaged(staged("fan-gwenpool", "1.0.0", "zip", { card: "two" })), {
        store,
        release: fakeReleases(),
      }),
      /already published with a different cards\/en\/01a\.webp/,
    );
  });

  it("uploads only the files a stopped run left out, keeping the ones it wrote", async () => {
    const store = fakeStore();
    const packs = readStaged(staged());
    store.failOn("fan-gwenpool/1.0.0/thumb.webp");
    await assert.rejects(publishStaged(packs, { store, release: fakeReleases() }), /upload of .* failed/);
    store.puts.length = 0;
    await publishStaged(packs, { store, release: fakeReleases() });
    assert.deepEqual(store.puts, [
      "fan-gwenpool/1.0.0/thumb.webp",
      "fan-gwenpool/1.0.0/cards/en/01a.webp",
      "fan-gwenpool/1.0.0/fan-gwenpool-1.0.0.zip",
    ]);
  });
});

describe("two publishers of one new version at once (this registry and the game repo)", () => {
  const zipKey = "fan-gwenpool/1.0.0/fan-gwenpool-1.0.0.zip";

  /** Both publishers plan against an empty bucket, then upload side by side. */
  const race = (...stagingDirs) => {
    const objects = new Map();
    const beforePut = barrier(stagingDirs.length);
    return Promise.allSettled(
      stagingDirs.map((dir) =>
        publishStaged(readStaged(dir), { store: fakeStore(objects, { beforePut }), release: fakeReleases() }),
      ),
    ).then((results) => ({ objects, results }));
  };

  it("keeps the first zip and fails the other publisher when the zips differ", async () => {
    const { objects, results } = await race(
      staged("fan-gwenpool", "1.0.0", "registry zip"),
      staged("fan-gwenpool", "1.0.0", "game repo zip"),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "rejected"],
    );
    assert.match(results[1].reason.message, /published by someone else .* with a different zip/);
    const zip = objects.get(zipKey);
    assert.equal(zip.sha256, sha("registry zip"));
    assert.equal(sha(zip.body), zip.sha256, "the bucket's zip is the bytes its sha256 names");
  });

  it("lets both finish when they upload the same files", async () => {
    const { objects, results } = await race(
      staged("fan-gwenpool", "1.0.0", "same zip"),
      staged("fan-gwenpool", "1.0.0", "same zip"),
    );
    assert.deepEqual(
      results.map((r) => r.status === "fulfilled" && r.value[0].action),
      ["upload", "upload"],
    );
    assert.equal(objects.get(zipKey).sha256, sha("same zip"));
  });

  it("never mixes their files when the same zip comes with different pictures and preview", async () => {
    const ours = { preview: '{"cards":1}', thumb: "registry thumb", card: "registry card" };
    const theirs = { preview: '{"cards":2}', thumb: "game repo thumb", card: "game repo card" };
    const { objects, results } = await race(
      staged("fan-gwenpool", "1.0.0", "same zip", ours),
      staged("fan-gwenpool", "1.0.0", "same zip", theirs),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "rejected"],
    );
    assert.match(results[1].reason.message, /published by someone else .* with a different preview\.json/);
    const body = (name) => String(objects.get(`fan-gwenpool/1.0.0/${name}`).body);
    assert.equal(body("preview.json"), ours.preview);
    assert.equal(body("thumb.webp"), ours.thumb);
    assert.equal(body("cards/en/01a.webp"), ours.card);
    for (const [key, object] of objects) assert.equal(sha(object.body), object.sha256, `${key} matches its sha256`);
  });

  it("never mixes their files when only a card picture differs, and only one finishes", async () => {
    const { objects, results } = await race(
      staged("fan-gwenpool", "1.0.0", "same zip", { card: "registry card" }),
      staged("fan-gwenpool", "1.0.0", "same zip", { card: "game repo card" }),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "rejected"],
    );
    assert.match(results[1].reason.message, /with a different cards\/en\/01a\.webp/);
    assert.equal(String(objects.get("fan-gwenpool/1.0.0/cards/en/01a.webp").body), "registry card");
    assert.equal(objects.get(zipKey).sha256, sha("same zip"));
  });
});

describe("ensureRelease", () => {
  const pack = { id: "p", version: "1.0.0", zipName: "p-1.0.0.zip", zipSha: sha("built zip"), zipBytes: 9 };
  const releaseWith = (asset, bytes) => ({
    view: async () => ({ assets: [asset] }),
    create: async () => assert.fail("no create"),
    upload: async () => assert.fail("no upload"),
    assetSha256: async () => (bytes === undefined ? assert.fail("no download") : sha(bytes)),
  });

  it("accepts the same asset by digest, without downloading it", async () => {
    const digest = `sha256:${pack.zipSha}`;
    assert.equal(await ensureRelease(pack, releaseWith({ name: pack.zipName, digest })), "present");
  });

  it("downloads and hashes an asset listed without a digest, and accepts the same bytes", async () => {
    assert.equal(await ensureRelease(pack, releaseWith({ name: pack.zipName, size: 9 }, "built zip")), "present");
  });

  it("refuses a digest-less asset of the same size but other bytes", async () => {
    await assert.rejects(
      ensureRelease(pack, releaseWith({ name: pack.zipName, size: 9 }, "other zip")),
      /already carries a different p-1\.0\.0\.zip/,
    );
  });

  it("refuses a release carrying a different zip", async () => {
    await assert.rejects(
      ensureRelease(pack, releaseWith({ name: pack.zipName, digest: `sha256:${"b".repeat(64)}` })),
      /different/,
    );
  });
});

describe("ghRelease", () => {
  it("hashes a downloaded asset", async () => {
    const release = ghRelease({
      repo: "o/r",
      dir: root,
      exec: async (_file, args) => {
        assert.deepEqual(args.slice(0, 5), ["release", "download", "p-v1.0.0", "--pattern", "p-1.0.0.zip"]);
        writeFileSync(join(args[6], "p-1.0.0.zip"), "release bytes");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(await release.assetSha256("p-v1.0.0", "p-1.0.0.zip"), sha("release bytes"));
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
    assert.equal(await store.sha256("missing"), null);
    assert.equal(await store.sha256("there"), "c".repeat(64));
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
    assert.equal(await store.sha256("k"), sha("old zip"));
  });

  it("puts every file with If-None-Match: * and its sha256; a 412 or 409 is an object already there", async () => {
    const calls = [];
    const failed = (code) => ({ code: 254, stdout: "", stderr: `An error occurred (${code}) when calling PutObject` });
    const replies = [
      { code: 0, stdout: "{}", stderr: "" },
      failed("PreconditionFailed"),
      failed("ConditionalRequestConflict"),
      { code: 255, stdout: "", stderr: "An error occurred (AccessDenied)" },
    ];
    const store = awsStore({
      endpoint: "e",
      bucket: "b",
      dir: root,
      exec: async (_file, args) => {
        calls.push(args);
        return replies[calls.length - 1];
      },
    });
    const thumb = { path: "t.webp", key: "p/1.0.0/thumb.webp", contentType: "image/webp", sha256: "d".repeat(64) };
    assert.equal(await store.put(thumb), "written");
    assert.equal(await store.put(thumb), "exists");
    assert.equal(await store.put(thumb), "exists");
    await assert.rejects(store.put(thumb), /AccessDenied/);
    assert.deepEqual(calls[0].slice(0, 2), ["s3api", "put-object"]);
    assert.ok(calls[0].join(" ").includes("--if-none-match *"));
    assert.ok(calls[0].join(" ").includes(`--metadata sha256=${"d".repeat(64)}`));
    assert.ok(calls[0].join(" ").includes("--content-type image/webp"));
  });

  it("fails on any other head-object error", async () => {
    const store = awsStore({
      endpoint: "e",
      bucket: "b",
      dir: root,
      exec: exec({ "head-object": () => ({ code: 255, stdout: "", stderr: "An error occurred (403): Forbidden" }) }),
    });
    await assert.rejects(store.sha256("k"), /Forbidden/);
  });
});
