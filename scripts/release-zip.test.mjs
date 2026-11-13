// node --test "scripts/*.test.mjs" (the check workflow). A repo entry's rebuilt zip must match the zip on the
// creator's release: scripts/fetch-release.sh (gh stubbed on PATH) and scripts/compare-release-zip.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compareReleaseZip } from "./compare-release-zip.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "release-zip-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = (name) => {
  const dir = join(root, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("compareReleaseZip", () => {
  const dir = fresh("zips");
  const built = join(dir, "built.zip");
  writeFileSync(built, "the rebuilt bytes");

  it("passes when the release carries the same bytes", () => {
    const same = join(dir, "same.zip");
    writeFileSync(same, "the rebuilt bytes");
    assert.equal(compareReleaseZip(built, same).ok, true);
  });

  it("fails when the release has no zip", () => {
    const result = compareReleaseZip(built, join(dir, "fan-gwenpool-1.0.0.zip"));
    assert.equal(result.ok, false);
    assert.match(result.error, /the release has no fan-gwenpool-1\.0\.0\.zip/);
  });

  it("fails when the release's zip differs", () => {
    const other = join(dir, "other.zip");
    writeFileSync(other, "different bytes");
    const result = compareReleaseZip(built, other);
    assert.equal(result.ok, false);
    assert.match(result.error, /differs from the rebuilt one/);
  });
});

// fetch-release.sh needs bash and yq (both on GitHub's ubuntu runners); gh is a stub on PATH.
const bash = spawnSync("bash", ["-c", "yq --version"], { encoding: "utf8" });
const canRun = bash.status === 0;

describe("fetch-release.sh", { skip: canRun ? false : "needs bash and yq" }, () => {
  const stubs = fresh("bin");
  // The stub stands in for `gh release download <tag> --repo <r> --pattern <p> --dir <d>`: GH_STUB=missing answers
  // as gh does when no asset matches; otherwise it writes the zip named in GH_STUB_ZIP into --dir.
  writeFileSync(
    join(stubs, "gh"),
    [
      "#!/usr/bin/env bash",
      'echo "$@" >> "$GH_STUB_LOG"',
      'if [ "$GH_STUB" = missing ]; then echo "no assets match the file pattern" >&2; exit 1; fi',
      'while [ $# -gt 0 ]; do if [ "$1" = --dir ]; then dir=$2; fi; shift; done',
      'mkdir -p "$dir" && printf zip > "$dir/$GH_STUB_ZIP"',
      "",
    ].join("\n"),
  );
  chmodSync(join(stubs, "gh"), 0o755);

  const entry = (body) => {
    const file = join(fresh("packs"), "fan-gwenpool.yaml");
    writeFileSync(file, body);
    return file;
  };
  const repoEntry = entry(
    [
      "id: fan-gwenpool",
      "repo: https://github.com/someone/gwenpool",
      "tag: v1.0.0",
      `commit: ${"a".repeat(40)}`,
      "",
    ].join("\n"),
  );
  const fetch = (file, env) => {
    const work = fresh("work");
    const log = join(work, "gh.log");
    const result = spawnSync("bash", [join(scripts, "fetch-release.sh"), file, work], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubs}${delimiter}${process.env.PATH}`, GH_STUB_LOG: log, ...env },
    });
    return { ...result, work, log };
  };

  it("downloads the release's zips into <work>/release", () => {
    const result = fetch(repoEntry, { GH_STUB: "ok", GH_STUB_ZIP: "fan-gwenpool-1.0.0.zip" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(join(result.work, "release")), ["fan-gwenpool-1.0.0.zip"]);
  });

  it("fails when the release carries no zip for the pack", () => {
    const result = fetch(repoEntry, { GH_STUB: "missing" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /the release must carry the pack's zip/);
  });

  it("fetches nothing for a pack kept in this repo", () => {
    const kept = entry("id: fan-gwenpool\npath: packs/fan-gwenpool\n");
    const result = fetch(kept, { GH_STUB: "ok", GH_STUB_ZIP: "x.zip" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(result.log), false, "gh was not called");
  });

  it("refuses a repo that is not a GitHub address before calling gh", () => {
    const bad = entry("id: fan-gwenpool\nrepo: https://example.com/x/y\ntag: v1.0.0\n");
    const result = fetch(bad, { GH_STUB: "ok", GH_STUB_ZIP: "x.zip" });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(result.log), false);
  });
});
