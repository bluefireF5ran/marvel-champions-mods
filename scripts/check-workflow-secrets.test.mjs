// node --test "scripts/*.test.mjs" (the check workflow). No job both runs pack code and holds a secret.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkWorkflow, checkWorkflows, splitSteps } from "./check-workflow-secrets.mjs";

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

/** A one-job workflow whose steps are `steps` (YAML lines, already indented under `steps:`). */
const workflow = (steps, { jobEnv = [] } = {}) =>
  [
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: read",
    ...jobEnv,
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          persist-credentials: false",
    ...steps,
    "",
  ].join("\n");

const token = "${{ github.token }}";
const fetchStep = [
  "      - name: Fetch releases",
  "        env:",
  `          GH_TOKEN: ${token}`,
  "        run: bash scripts/fetch-release.sh packs/x.yaml work",
];
const buildStep = ["      - name: Build", "        run: bash scripts/build-entry.sh packs/x.yaml work"];

describe("GitHub tokens in jobs that run pack code", () => {
  it("allows a token in a step that only fetches, before the build", () => {
    assert.deepEqual(checkWorkflow(workflow([...fetchStep, ...buildStep])), []);
  });

  it("refuses a token in the step that runs pack code", () => {
    const steps = [buildStep[0], "        env:", `          GH_TOKEN: ${token}`, buildStep[1]];
    assert.deepEqual(checkWorkflow(workflow(steps)), ['build: step "Build" runs pack code with a GitHub token']);
  });

  it("refuses a token in a step that installs dependencies", () => {
    const install = ["      - name: Install", "        env:", "          GITHUB_TOKEN: x", "        run: npm ci"];
    assert.deepEqual(checkWorkflow(workflow([...install, ...buildStep])), [
      'build: step "Install" runs pack code with a GitHub token',
    ]);
  });

  it("refuses a token in a step after pack code ran", () => {
    assert.deepEqual(checkWorkflow(workflow([...buildStep, ...fetchStep])), [
      'build: step "Fetch releases" uses a GitHub token after pack code ran',
    ]);
  });

  it("refuses a token in the job's env", () => {
    const jobEnv = ["    env:", `      GH_TOKEN: ${token}`];
    assert.deepEqual(checkWorkflow(workflow(buildStep, { jobEnv })), [
      "build: runs pack code with a GitHub token in the job's env",
    ]);
  });

  it("refuses a checkout that keeps its token in any job of a workflow that runs pack code", () => {
    const list = [
      "  list:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: bash scripts/changed-entries.sh main",
      "",
    ];
    assert.deepEqual(checkWorkflow(workflow(buildStep) + list.join("\n")), [
      "list: has a checkout that keeps its token in a workflow that runs pack code",
    ]);
  });

  it("splits steps by their item indentation, not by nested list items", () => {
    const { steps } = splitSteps(
      [
        "    runs-on: x",
        "    steps:",
        "      - uses: a",
        "        with:",
        "          list:",
        "            - nested",
        "      - name: Second",
        "        run: echo",
      ].join("\n"),
    );
    assert.deepEqual(
      steps.map((s) => s.name),
      ["uses: a", "Second"],
    );
  });
});
