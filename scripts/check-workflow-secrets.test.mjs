// node --test "scripts/*.test.mjs" (the check workflow). No job both runs pack code and holds a secret.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkWorkflows } from "./check-workflow-secrets.mjs";

const workflows = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

describe("this repo's workflows", () => {
  const results = checkWorkflows(workflows);
  const byFile = Object.fromEntries(results.map((r) => [r.file, r]));

  it("run pack code only in jobs without secrets, write permissions or a kept token", () => {
    assert.deepEqual(
      results.flatMap((r) => r.problems.map((p) => `${r.file}: ${p}`)),
      [],
    );
  });

  it("run pack code only in the submission check and the publish build", () => {
    assert.deepEqual(byFile["check.yml"].packCodeJobs, ["check"]);
    assert.deepEqual(byFile["publish.yml"].packCodeJobs, ["build"]);
  });
});
