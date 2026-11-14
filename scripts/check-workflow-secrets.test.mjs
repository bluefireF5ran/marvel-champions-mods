// node --test "scripts/*.test.mjs" (the script tests workflow). No job both runs pack code and holds a secret.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkPullRequestCode,
  checkWorkflow,
  checkWorkflows,
  splitJobs,
  splitSteps,
  triggers,
} from "./check-workflow-secrets.mjs";

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
    assert.deepEqual(byFile["script-tests.yml"].packCodeJobs, []);
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

describe("the check workflow runs only the base branch's scripts (review P1s)", () => {
  const text = readFileSync(path.join(workflows, "check.yml"), "utf8");
  const jobs = Object.fromEntries(splitJobs(text).map((job) => [job.name, job]));

  it("runs on pull_request_target only, so its YAML and scripts come from the base branch", () => {
    assert.deepEqual(triggers(text), { pullRequestTarget: true, pullRequest: false });
  });

  it("checks out only this workflow's own commit (github.sha), never the pull request's", () => {
    const checkouts = splitJobs(text).flatMap((job) =>
      splitSteps(job.body).steps.filter((step) => /uses: actions\/checkout@/.test(step.body)),
    );
    assert.ok(checkouts.length > 0);
    for (const step of checkouts) assert.match(step.body, /^\s*ref: \$\{\{ github\.sha \}\}\s*$/m);
  });

  // A pull request that changes scripts/fetch-release.sh or scripts/changed-entries.sh doesn't get them run: the gate
  // runs the base checkout's copies, the build runs the copies the gate handed on, and changed-entries.sh is not used.
  it("runs fetch-release.sh and the gate from the base checkout, and build-entry.sh from the gate's artifact", () => {
    assert.doesNotMatch(text, /changed-entries\.sh/);
    assert.match(jobs.gate.body, /node scripts\/pr-gate\.mjs/);
    assert.match(jobs.gate.body, /bash scripts\/fetch-release\.sh/);
    assert.match(jobs.gate.body, /cp -r scripts "\$RUNNER_TEMP\/trusted\/scripts"/);
    assert.doesNotMatch(jobs.check.body, /actions\/checkout@/);
    assert.match(jobs.check.body, /bash "\$trusted\/scripts\/build-entry\.sh"/);
    assert.match(jobs.check.body, /^\s+permissions: \{\}\s*$/m);
  });

  it("fails All checks unless the gate passed and every listed entry was checked", () => {
    const body = jobs["all-checks"].body;
    assert.match(body, /needs: \[gate, check\]/);
    assert.match(body, /if \[ "\$GATE" != "success" \]/);
    assert.match(body, /if \[ "\$CHECK" != "success" \]/);
  });
});

describe("pull request code and tokens", () => {
  const prWorkflow = (trigger, jobLines) => ["on:", `  ${trigger}:`, "jobs:", ...jobLines, ""].join("\n");

  // The review's first P1, as check.yml was: a `pull_request` job that ran the PR's fetch-release.sh with GH_TOKEN.
  it("refuses a pull_request step that runs the pull request's script with a token", () => {
    const text = prWorkflow("pull_request", [
      "  check:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      contents: read",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          persist-credentials: false",
      ...fetchStep,
      ...buildStep,
    ]);
    assert.deepEqual(checkWorkflow(text), [
      'check: step "Fetch releases" runs the pull request\'s scripts with a GitHub token',
    ]);
  });

  it("allows a pull_request job that runs the pull request's scripts with no token", () => {
    const text = prWorkflow("pull_request", [
      "  scripts:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          persist-credentials: false",
      '      - run: node --test "scripts/*.test.mjs"',
      "      - run: node scripts/check-workflow-secrets.mjs",
    ]);
    assert.deepEqual(checkWorkflow(text), []);
  });

  const targetJob = (name, { permissions = ["    permissions: {}"], steps }) => [
    `  ${name}:`,
    "    runs-on: ubuntu-latest",
    ...permissions,
    "    steps:",
    ...steps,
  ];

  it("refuses a pull_request_target checkout of the pull request's head or merge commit", () => {
    for (const ref of ["${{ github.event.pull_request.head.sha }}", "refs/pull/${{ github.event.number }}/merge"]) {
      const text = prWorkflow(
        "pull_request_target",
        targetJob("list", {
          permissions: ["    permissions:", "      contents: read"],
          steps: [
            "      - uses: actions/checkout@v4",
            "        with:",
            `          ref: ${ref}`,
            "          persist-credentials: false",
          ],
        }),
      );
      assert.deepEqual(checkPullRequestCode(text), [
        'list: step "uses: actions/checkout@v4" checks out the pull request\'s code in a pull_request_target workflow',
      ]);
    }
  });

  it("refuses gh pr checkout in a pull_request_target workflow", () => {
    const text = prWorkflow(
      "pull_request_target",
      targetJob("list", { steps: ["      - name: Get it", "        run: gh pr checkout 1"] }),
    );
    assert.deepEqual(checkPullRequestCode(text), [
      'list: step "Get it" fetches the pull request\'s code in a pull_request_target workflow',
    ]);
  });

  it("refuses pack code in a pull_request_target job with token permissions, or next to a cache", () => {
    const text = prWorkflow("pull_request_target", [
      ...targetJob("check", {
        permissions: ["    permissions:", "      contents: read"],
        steps: buildStep,
      }),
      ...targetJob("other", {
        steps: ["      - uses: actions/setup-node@v4", "        with:", "          cache: npm"],
      }),
    ]);
    assert.deepEqual(checkPullRequestCode(text), [
      "check: runs pack code in a pull_request_target workflow without permissions: {}",
      "other: uses a cache in a pull_request_target workflow that runs pack code",
    ]);
  });

  it("allows pack code in a pull_request_target job with permissions: {} and no checkout", () => {
    const text = prWorkflow("pull_request_target", targetJob("check", { steps: buildStep }));
    assert.deepEqual(checkWorkflow(text), []);
  });
});
