// node --test "scripts/*.test.mjs" (the check workflow). scripts/build-entry.sh refuses what the registry can't build
// yet before any pack code runs: `path` entries without the root SDK manifest, and packs that require other packs.
// Needs bash, jq and yq on the PATH (the workflow's runner has them).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "build-entry-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A copy of this repo's layout with one `path` entry, `packs/<id>.yaml` and `packs/<id>/pack.json`. */
function repoWith(id, { manifest = {}, rootManifest = true } = {}) {
  const repo = join(root, `repo-${n++}`);
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(join(scripts, "build-entry.sh"), join(repo, "scripts", "build-entry.sh"));
  mkdirSync(join(repo, "packs", id), { recursive: true });
  writeFileSync(
    join(repo, "packs", `${id}.yaml`),
    [
      `id: ${id}`,
      `path: packs/${id}`,
      "creator: Someone",
      "permission:",
      "  by: Someone",
      "  evidence: https://example.com/grant",
      "  date: 2026-11-01",
      "",
    ].join("\n"),
  );
  writeFileSync(join(repo, "packs", id, "pack.json"), JSON.stringify({ id, version: "1.0.0", ...manifest }));
  if (rootManifest) {
    writeFileSync(join(repo, "package.json"), "{}");
    writeFileSync(join(repo, "package-lock.json"), "{}");
  }
  return repo;
}

const build = (repo, id) =>
  spawnSync("bash", ["scripts/build-entry.sh", `packs/${id}.yaml`, join(repo, "work")], {
    cwd: repo,
    encoding: "utf8",
  });

const missingTool = ["bash", "jq", "yq"].find(
  (tool) => spawnSync(tool, ["--version"], { cwd: root }).status !== 0,
);

describe("build-entry.sh", { skip: missingTool && `${missingTool} is not on the PATH` }, () => {
  it("refuses a path entry while the repo has no root package.json / package-lock.json", () => {
    const result = build(repoWith("fan-a", { rootManifest: false }), "fan-a");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /path entries are not supported yet/);
  });

  it("refuses a pack that requires other packs, before installing anything", () => {
    const repo = repoWith("fan-b", { manifest: { requires: { app: "0.40.0", packs: ["fan-a"] } } });
    const result = build(repo, "fan-b");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /requires other packs \(fan-a\)/);
    assert.doesNotMatch(result.stdout + result.stderr, /npm/);
  });

  it("refuses a pack with a DRAFT file", () => {
    const repo = repoWith("fan-c");
    writeFileSync(join(repo, "packs", "fan-c", "DRAFT"), "");
    const result = build(repo, "fan-c");
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /DRAFT file/);
  });
});
