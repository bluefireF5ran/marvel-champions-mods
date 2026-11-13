#!/usr/bin/env node
/**
 * Checks that no GitHub Actions job both runs pack code and holds a secret (docs/custom-content-packs.md §11.9).
 * `mc-pack validate`, `test` and `build` import a pack's abilities/index.ts, which runs whatever the pack's author
 * wrote, so a job that runs them must have no `secrets.` reference, no deployment `environment`, no write
 * permission and no persisted checkout token; and in a workflow that runs pack code, a job that does hold secrets
 * must not run pack code or install dependencies (an install could run a lifecycle script).
 *
 * The job's GitHub token is checked step by step: in a job that runs pack code, no step that runs pack code or installs
 * dependencies may have a token (`GH_TOKEN`, `GITHUB_TOKEN`, `github.token`) in its env, the job's own env may not
 * have one, and no step may use one after a step that ran pack code (that code could have left something behind on
 * the runner for the later step to run). A step that only fetches with the token goes first. And every checkout in a
 * workflow that runs pack code sets `persist-credentials: false`, since its later steps run scripts a pull request
 * can change.
 *
 * And whatever a workflow runs, the pull request's code never runs with a token:
 *
 *   - a `pull_request_target` workflow runs with the base repo's token, so none of its checkouts may take the pull
 *     request's head or merge commit (`ref:` naming `pull_request.head`, `head_ref`, `refs/pull/`, the merge sha), no
 *     step may `gh pr checkout` or fetch `refs/pull/`, a job in it that runs pack code must have `permissions: {}`, and
 *     no job in it may use a cache (pack code could poison the base branch's cache);
 *   - a `pull_request` workflow checks out the pull request's code, so no step there that holds a token may run one
 *     of the repo's scripts (`bash scripts/...`, `node scripts/...`, `./scripts/...`): a pull request can change them.
 *
 * The game repo (quincarter/marvel-champions-digital-game) has the original of this file, which its tests run; this
 * copy runs in the script tests workflow: keep the two the same.
 *
 * Usage: node scripts/check-workflow-secrets.mjs [workflows dir]   (exit 1 with the problems listed)
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** What marks a job as running pack code: the SDK's CLI, its tarball smoke test, the registry's build script. */
export const PACK_CODE = /\bmc-pack\b|\bsmoke:dist\b|\bbuild-entry\.sh\b/;
const INSTALL = /\b(pnpm|npm|yarn)\s+(install|ci|i)\b/;
/** A GitHub token handed to a step or job. */
const TOKEN = /\bGH_TOKEN\b|\bGITHUB_TOKEN\b|\bgithub\.token\b|\bsecrets\.GITHUB_TOKEN\b/;
/** A checkout `ref:` / `repository:` naming the pull request's code. */
const PR_CODE_REF = /\bpull_request\.head\b|\bhead_ref\b|refs\/pull\/|\bmerge_commit_sha\b|\bpull_request\.merge/;
/** A run step that fetches the pull request's code as a checkout. */
const PR_CODE_RUN = /\bgh\s+pr\s+checkout\b|refs\/pull\//;
/** A run step running one of the repo's own scripts. */
const REPO_SCRIPT = /(?:^|[\s;&|(])(?:(?:bash|sh|node|python3?)\s+(?:\.\/)?scripts\/|\.\/scripts\/)/m;
const CACHE = /uses:\s*actions\/cache(?:\/\w+)?@|^\s+cache:/m;
const CHECKOUT = /uses: actions\/checkout@/;

/** The workflow's triggers, from its top-level `on:` block (comments dropped). */
export function triggers(text) {
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
  const start = lines.findIndex((line) => /^["']?on["']?:/.test(line));
  if (start < 0) return { pullRequestTarget: false, pullRequest: false };
  const end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
  const on = lines
    .slice(start, end < 0 ? undefined : end)
    .join("\n")
    .replace(/^["']?on["']?:/, "");
  const has = (event) => new RegExp(`(?:^|[\\s,[])${event}(?=[\\s,\\]:]|$)`, "m").test(on);
  return { pullRequestTarget: has("pull_request_target"), pullRequest: has("pull_request") };
}

/** The problems with how a workflow treats the pull request's code, as `<job>: <problem>` lines. */
export function checkPullRequestCode(text, { packCode = PACK_CODE } = {}) {
  const { pullRequestTarget, pullRequest } = triggers(text);
  const jobs = splitJobs(text);
  const problems = [];
  if (pullRequestTarget) {
    const runsPackCode = jobs.some((job) => packCode.test(job.body));
    for (const job of jobs) {
      const { head, steps } = splitSteps(job.body);
      for (const step of steps) {
        const where = `${job.name}: step "${step.name}"`;
        if (CHECKOUT.test(step.body) && PR_CODE_REF.test(step.body)) {
          problems.push(`${where} checks out the pull request's code in a pull_request_target workflow`);
        } else if (PR_CODE_RUN.test(step.body)) {
          problems.push(`${where} fetches the pull request's code in a pull_request_target workflow`);
        }
      }
      if (packCode.test(job.body) && !/^\s+permissions:\s*\{\s*\}\s*$/m.test(head)) {
        problems.push(`${job.name}: runs pack code in a pull_request_target workflow without permissions: {}`);
      }
      if (runsPackCode && CACHE.test(job.body)) {
        problems.push(`${job.name}: uses a cache in a pull_request_target workflow that runs pack code`);
      }
    }
  }
  if (pullRequest) {
    for (const job of jobs) {
      if (!CHECKOUT.test(job.body)) continue;
      const { head, steps } = splitSteps(job.body);
      const jobToken = TOKEN.test(head);
      for (const step of steps) {
        if ((jobToken || TOKEN.test(step.body)) && REPO_SCRIPT.test(step.body)) {
          problems.push(`${job.name}: step "${step.name}" runs the pull request's scripts with a GitHub token`);
        }
      }
    }
  }
  return problems;
}

/**
 * Splits a workflow's `jobs:` block into jobs by indentation, which is all this check needs (no YAML parser: the
 * scripts run with Node built-ins only). Comment lines are dropped. Returns `[{ name, body }]`.
 */
export function splitJobs(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return [];
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (/^\s*#/.test(line)) continue;
    const head = /^ {2}([\w-]+):\s*$/.exec(line);
    if (head) jobs.push({ name: head[1], lines: [] });
    else if (jobs.length > 0) jobs.at(-1).lines.push(line);
  }
  return jobs.map(({ name, lines: body }) => ({ name, body: body.join("\n") }));
}

/**
 * Splits a job's body into the part before `steps:` (`head`) and its steps, by indentation. Each step is
 * `{ name, body }`, the name being its `name:` or, failing that, its first line.
 */
export function splitSteps(body) {
  const lines = body.split("\n");
  const at = lines.findIndex((line) => /^\s+steps:\s*$/.test(line));
  if (at < 0) return { head: body, steps: [] };
  const stepsIndent = /^(\s*)/.exec(lines[at])[1].length;
  const steps = [];
  let itemIndent;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = /^(\s*)/.exec(line)[1].length;
    if (indent <= stepsIndent && !/^\s*- /.test(line)) {
      end = i;
      break;
    }
    const item = /^(\s*)- (.*)$/.exec(line);
    if (item && (itemIndent === undefined || item[1].length === itemIndent)) {
      itemIndent = item[1].length;
      steps.push({ lines: [line.slice(itemIndent + 2)] });
    } else if (steps.length > 0) steps.at(-1).lines.push(line);
  }
  const head = [...lines.slice(0, at), ...lines.slice(end)].join("\n");
  return {
    head,
    steps: steps.map(({ lines: stepLines }) => {
      const text = stepLines.join("\n");
      const name = /^\s*name:\s*(.+)$/m.exec(text)?.[1] ?? stepLines[0].trim();
      return { name: name.trim(), body: text };
    }),
  };
}

/** The problems in one workflow's text, as `<job>: <problem>` lines. */
export function checkWorkflow(text, { packCode = PACK_CODE } = {}) {
  const jobs = splitJobs(text);
  const runsPackCode = (job) => packCode.test(job.body);
  const problems = checkPullRequestCode(text, { packCode });
  if (!jobs.some(runsPackCode)) return problems;
  for (const job of jobs) {
    if (runsPackCode(job)) {
      if (/\bsecrets\./.test(job.body)) problems.push(`${job.name}: runs pack code and references secrets`);
      if (/^\s+environment:/m.test(job.body)) problems.push(`${job.name}: runs pack code in a deployment environment`);
      if (/^\s+[\w-]+:\s*write\b/m.test(job.body)) problems.push(`${job.name}: runs pack code with a write permission`);
      if (!/^\s+permissions:/m.test(job.body)) problems.push(`${job.name}: runs pack code without its own permissions`);
      const { head, steps } = splitSteps(job.body);
      if (TOKEN.test(head)) problems.push(`${job.name}: runs pack code with a GitHub token in the job's env`);
      let ranPackCode = false;
      for (const step of steps) {
        const runsCode = packCode.test(step.body) || INSTALL.test(step.body);
        if (TOKEN.test(step.body)) {
          if (runsCode) problems.push(`${job.name}: step "${step.name}" runs pack code with a GitHub token`);
          else if (ranPackCode) problems.push(`${job.name}: step "${step.name}" uses a GitHub token after pack code ran`);
        }
        if (runsCode) ranPackCode = true;
      }
    } else if (/\bsecrets\./.test(job.body) && INSTALL.test(job.body)) {
      problems.push(`${job.name}: holds secrets and installs dependencies in a workflow that runs pack code`);
    }
    const checkouts = job.body.match(/uses: actions\/checkout@/g)?.length ?? 0;
    const unpersisted = job.body.match(/persist-credentials: false/g)?.length ?? 0;
    if (checkouts > unpersisted) {
      problems.push(
        runsPackCode(job)
          ? `${job.name}: runs pack code after a checkout that keeps its token`
          : `${job.name}: has a checkout that keeps its token in a workflow that runs pack code`,
      );
    }
  }
  return problems;
}

/** Every workflow under `dir`: `{ file, problems, packCodeJobs }`. */
export function checkWorkflows(dir, options) {
  return fs
    .readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const packCode = options?.packCode ?? PACK_CODE;
      return {
        file,
        problems: checkWorkflow(text, options),
        packCodeJobs: splitJobs(text)
          .filter((job) => packCode.test(job.body))
          .map((job) => job.name),
      };
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? path.join(".github", "workflows");
  const results = checkWorkflows(dir);
  const problems = results.flatMap(({ file, problems: list }) => list.map((p) => `${file}: ${p}`));
  for (const { file, packCodeJobs } of results) {
    if (packCodeJobs.length > 0) console.log(`${file}: pack code runs in ${packCodeJobs.join(", ")}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log("No job that runs pack code holds a secret, and no pull request code runs with a token.");
}
