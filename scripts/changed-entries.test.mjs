// node --test "scripts/*.test.mjs" (the script tests). scripts/changed-entries.sh: which entries a push to main touches.
// Needs bash and git on the PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const script = path.join(import.meta.dirname, "changed-entries.sh");

describe("changed-entries.sh", () => {
  const temps = [];
  after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  /** A repo whose first commit has `before` and whose second has `after` (`{ path: text }`). */
  const repo = (before, afterFiles) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changed-entries-"));
    temps.push(dir);
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "test");
    const commit = (files) => {
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
      }
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "--allow-empty", "-m", "x");
    };
    commit({ "README.md": "x", ...before });
    commit(afterFiles);
    return dir;
  };
  const run = (dir) => spawnSync("bash", [script, "HEAD~1"], { cwd: dir, encoding: "utf8" });

  it("succeeds with nothing to list when the SDK pin changes and no pack is kept here", () => {
    const result = run(repo({}, { "package.json": "{}" }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  it("succeeds when the last change is a draft folder with no entry", () => {
    const result = run(repo({ "packs/fan-a.yaml": "id: fan-a\npath: packs/fan-a\n" }, { "packs/zz-draft/DRAFT": "" }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });

  it("lists a changed entry and a changed folder's entry", () => {
    const result = run(
      repo({ "packs/fan-a.yaml": "id: fan-a\npath: packs/fan-a\n" }, {
        "packs/fan-a/pack.json": "{}",
        "packs/fan-b.yaml": "id: fan-b\n",
      }),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "packs/fan-a.yaml\npacks/fan-b.yaml\n");
  });
});
