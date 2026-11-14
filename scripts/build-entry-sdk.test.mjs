// MC_SDK_TARBALL=<path to the mod SDK's .tgz> node --test scripts/build-entry-sdk.test.mjs
//
// Runs scripts/build-entry.sh, unchanged, on a pack with the real mod SDK: the same npm ci, `mc-pack validate .
// --publish`, `mc-pack test .` and `mc-pack build` the check and publish workflows run on every entry. The script
// tests workflow's "Build entry with the SDK" job builds the tarball from the game repo at a pinned commit and runs
// this; without MC_SDK_TARBALL it is skipped.
//
// The pack is tests/fixtures/registry/packs/sample-hero/ (the pack template's sample pack, with a granted permission),
// built as a `path` entry: SOURCE_ROOT is a copy of tests/fixtures/registry/ given the root package.json and
// package-lock.json a `path` entry builds with, both pinning the tarball. That is the `path` entry's own code path,
// which a real entry takes too once this repo pins the SDK; nothing in build-entry.sh is relaxed for the test.
// Needs bash, git, jq, yq and npm on the PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repo, "tests", "fixtures", "registry");
const tarball = process.env.MC_SDK_TARBALL ? resolve(process.env.MC_SDK_TARBALL) : undefined;
const root = mkdtempSync(join(tmpdir(), "build-entry-sdk-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Forward slashes, so bash on Windows reads the paths as Linux would (sha256sum escapes a name with a backslash). */
const posix = (path) => path.replaceAll("\\", "/");

let n = 0;

/** A copy of the fixture with the SDK pinned in its root package.json / package-lock.json; `edit` changes pack.json. */
function sourceRoot(edit = (manifest) => manifest) {
  const dir = join(root, `source-${n++}`);
  cpSync(fixture, dir, { recursive: true });
  const manifestPath = join(dir, "packs", "sample-hero", "pack.json");
  writeFileSync(manifestPath, JSON.stringify(edit(JSON.parse(readFileSync(manifestPath, "utf8"))), null, 2));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "registry-fixture",
      private: true,
      type: "module",
      devDependencies: { "@champions-digital-game/mod-sdk": `file:${posix(tarball)}` },
    }),
  );
  const lock = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: dir,
    encoding: "utf8",
    shell: process.platform === "win32", // npm is npm.cmd there
  });
  assert.equal(lock.status, 0, lock.stdout + lock.stderr);
  return dir;
}

const build = (source) => {
  const work = posix(join(source, "work"));
  const entry = posix(join(source, "packs", "sample-hero.yaml"));
  const result = spawnSync("bash", ["scripts/build-entry.sh", entry, work], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, SOURCE_ROOT: posix(source) },
  });
  return { ...result, work, log: result.stdout + result.stderr };
};

describe("build-entry.sh with the mod SDK", { skip: !tarball && "MC_SDK_TARBALL is not set" }, () => {
  it("validates with --publish, tests and builds a granted pack", () => {
    const result = build(sourceRoot());
    assert.equal(result.status, 0, result.log);
    const version = readFileSync(join(result.work, "version"), "utf8").trim();
    assert.equal(version, "1.0.0");
    for (const file of ["pack.json", `sample-hero-${version}.zip`]) {
      assert.ok(existsSync(join(result.work, "out", file)), `out/${file} is missing`);
    }
    assert.match(readFileSync(join(result.work, "zip.sha256"), "utf8"), /^[0-9a-f]{64}\n$/);
    assert.match(readFileSync(join(result.work, "summary.md"), "utf8"), /`sample-hero` 1\.0\.0/);
  });

  it("fails the publish check when the pack's permission is pending", () => {
    const pending = (manifest) => ({
      ...manifest,
      permission: { status: "pending", by: manifest.permission.by, note: "waiting on the creator's reply" },
    });
    const result = build(sourceRoot(pending));
    assert.notEqual(result.status, 0);
    assert.match(result.log, /permission\.status.*not granted/);
    assert.match(result.log, /waiting on the creator's reply/);
  });

  it("fails the publish check when a shipped language has no permission", () => {
    const french = (manifest) => ({ ...manifest, languages: { base: "en", available: ["en", "fr"] } });
    const result = build(sourceRoot(french));
    assert.notEqual(result.status, 0);
    assert.match(result.log, /permission\.languages.*does not cover fr/);
  });
});
