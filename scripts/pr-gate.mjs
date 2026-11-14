#!/usr/bin/env node
/**
 * The trusted gate of the Check submission workflow (check.yml, `pull_request_target`). It runs the base branch's copy
 * of this script, never the pull request's, and reads the pull request only as data through the GitHub API:
 *
 *   - lists the pull request's changed files (the API, not a diff computed by a script the pull request could change);
 *   - refuses a submission from someone who is not a maintainer (write, maintain or admin on this repo) that touches
 *     anything but `packs/<id>.yaml`, more than one pack (deletions and renames count: one withdrawal on its own is
 *     allowed, more than one, or one next to a new or changed entry, is not), or a `path:` entry (packs kept here
 *     are maintainer-only);
 *   - lists the entries to check: every added or changed `packs/<id>.yaml`, the entry of every `packs/<id>/` folder a
 *     maintainer changed, and every `path:` entry when the root package.json / package-lock.json changed;
 *   - fails closed: an entry file or pack folder that changed but whose entry can't be read at the pull request's head
 *     fails the gate, so a pack change can never pass with nothing checked.
 *
 * It writes each entry's YAML to <out>/entries/<id>.yaml, the ids to check to <out>/ids.json, and the ids of `path:`
 * entries to <out>/kept-ids.txt, and sets the `ids` step output. Deleted entries are not checked (a deletion
 * withdraws the pack).
 *
 *   node scripts/pr-gate.mjs <out dir>
 *
 * Environment: GH_TOKEN, REPO (owner/name), PR (number), HEAD_SHA, AUTHOR (the pull request's author), SENDER (who
 * triggered this run), CHANGED_FILES (the event's changed_files count).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENTRY_FILE = /^packs\/([^/]+)\.yaml$/;
const PACK_FOLDER = /^packs\/([^/]+)\/./;
const ROOT_MANIFEST = /^package(-lock)?\.json$/;
const KEPT_HERE = /^path:/m;
/** Repo permissions that make someone a maintainer. */
export const MAINTAINER_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * Decides what a pull request may change and which entries to check.
 *
 *   files: [{ filename, status, previous_filename? }] (the pull request's files, from the API)
 *   maintainer: whether the author and whoever triggered the run are maintainers
 *   readEntry(path): resolves an entry file's text at the pull request's head, or null when it is not there
 *   listEntries(): resolves every packs/<id>.yaml path at the pull request's head
 *
 * Resolves `{ entries: [{ id, file, text, kept }], errors }`.
 */
export async function gate({ files, maintainer, readEntry, listEntries }) {
  const errors = [];
  const paths = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];

  if (!maintainer) {
    for (const p of paths) {
      if (!ENTRY_FILE.test(p)) {
        errors.push(
          `${p}: a submission may only add, change or delete packs/<id>.yaml; everything else (scripts, workflows, ` +
            "pack folders kept here, the SDK version) is changed by the maintainer",
        );
      }
    }
  }

  // Entry files to check, each with why it is checked (an entry file changed, or a folder of a pack kept here).
  const candidates = new Map();
  for (const f of files) {
    if (f.status !== "removed" && ENTRY_FILE.test(f.filename)) candidates.set(f.filename, "changed");
  }
  for (const p of paths) {
    const folder = PACK_FOLDER.exec(p);
    if (folder && !candidates.has(`packs/${folder[1]}.yaml`)) candidates.set(`packs/${folder[1]}.yaml`, "folder");
  }
  if (paths.some((p) => ROOT_MANIFEST.test(p))) {
    for (const file of await listEntries()) {
      if (candidates.has(file)) continue;
      const text = await readEntry(file);
      if (text != null && KEPT_HERE.test(text)) candidates.set(file, "sdk");
    }
  }

  if (!maintainer) errors.push(...onePack(files, candidates));

  const entries = [];
  for (const [file, why] of candidates) {
    const id = ENTRY_FILE.exec(file)[1];
    if (!ID.test(id)) {
      errors.push(`${file}: the file name must be <id>.yaml, the id lowercase letters, digits and single dashes`);
      continue;
    }
    const text = await readEntry(file);
    if (text == null) {
      errors.push(
        why === "folder"
          ? `packs/${id}/ changed but ${file} is not in the pull request: a pack folder needs its entry to be checked`
          : `${file} changed but could not be read at the pull request's head: nothing would be checked`,
      );
      continue;
    }
    const kept = KEPT_HERE.test(text);
    if (kept && !maintainer) errors.push(`${file}: path entries (packs kept in this repo) are added by the maintainer`);
    entries.push({ id, file, text, kept });
  }

  // Fail closed: a pack change never passes with an empty check (every candidate above is an entry or an error, so
  // this is the last line of defence, not the usual way a gate fails).
  if (candidates.size > 0 && entries.length === 0 && errors.length === 0) {
    errors.push("pack files changed but no entry was found to check");
  }
  return { entries, errors };
}

/**
 * A submission's one-pack rule, counting every pack id it touches: entries added, changed, deleted (a deletion
 * withdraws the pack on merge) or renamed (which withdraws the old id and submits the new one), and the entries it
 * would check. One pack added or changed passes, and so does one withdrawal on its own; two packs, two withdrawals, or
 * a withdrawal next to a new or changed entry do not.
 */
function onePack(files, candidates) {
  const withdrawn = new Set();
  const submitted = new Set();
  const idOf = (file) => ENTRY_FILE.exec(file)?.[1];
  for (const f of files) {
    const id = idOf(f.filename);
    if (id && f.status === "removed") withdrawn.add(id);
    else if (id) submitted.add(id);
    const previous = f.previous_filename && idOf(f.previous_filename);
    if (previous && previous !== id) withdrawn.add(previous);
  }
  for (const file of candidates.keys()) submitted.add(idOf(file));
  const list = (ids) => [...ids].sort().join(", ");
  if (withdrawn.size > 0 && submitted.size > 0) {
    return [
      `a submission adds, changes or withdraws one pack; this one withdraws ${list(withdrawn)} and adds or changes ` +
        `${list(submitted)}: open a pull request for each`,
    ];
  }
  if (withdrawn.size > 1) {
    return [`a submission withdraws one pack at a time; this one withdraws ${list(withdrawn)}`];
  }
  if (submitted.size > 1) return [`a submission adds or changes one pack; this one changes ${list(submitted)}`];
  return [];
}

const run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    );
  });

/** The pull request over the GitHub API (gh). `exec(file, args)` resolves `{ code, stdout, stderr }`. */
export function githubPullRequest({ repo, pr, headSha, exec = run }) {
  const api = async (args) => {
    const result = await exec("gh", ["api", ...args]);
    if (result.code !== 0) {
      throw Object.assign(new Error(`gh api ${args.at(-1)} failed: ${result.stderr.trim()}`), result);
    }
    return result.stdout;
  };
  const notFound = (error) => /HTTP 404|Not Found/i.test(String(error.stderr));
  return {
    async files() {
      const out = await api([
        "--paginate",
        "--jq",
        ".[] | {filename, status, previous_filename}",
        `repos/${repo}/pulls/${pr}/files?per_page=100`,
      ]);
      return out
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    },
    async permission(user) {
      try {
        return (await api(["--jq", ".permission", `repos/${repo}/collaborators/${user}/permission`])).trim();
      } catch (error) {
        if (notFound(error)) return "none";
        throw error;
      }
    },
    async readEntry(file) {
      try {
        const raw = "Accept: application/vnd.github.raw+json";
        return await api(["-H", raw, `repos/${repo}/contents/${file}?ref=${headSha}`]);
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async listEntries() {
      try {
        const out = await api([
          "--jq",
          '.[] | select(.type == "file") | .path',
          `repos/${repo}/contents/packs?ref=${headSha}`,
        ]);
        return out.split("\n").filter((p) => ENTRY_FILE.test(p));
      } catch (error) {
        if (notFound(error)) return [];
        throw error;
      }
    },
  };
}

async function main() {
  const [out] = process.argv.slice(2);
  if (!out) throw new Error("usage: node scripts/pr-gate.mjs <out dir>");
  for (const name of ["REPO", "PR", "HEAD_SHA", "AUTHOR", "SENDER", "CHANGED_FILES"]) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
  }
  const { REPO, PR, HEAD_SHA, AUTHOR, SENDER, CHANGED_FILES } = process.env;
  const pull = githubPullRequest({ repo: REPO, pr: PR, headSha: HEAD_SHA });

  const files = await pull.files();
  // The files API stops at 3000 files: a list shorter than the event's count would check only part of the change.
  if (files.length !== Number(CHANGED_FILES)) {
    throw new Error(`the API listed ${files.length} changed files, the pull request has ${CHANGED_FILES}`);
  }
  let maintainer = true;
  for (const user of new Set([AUTHOR, SENDER])) {
    const permission = await pull.permission(user);
    console.log(`${user}: ${permission} on ${REPO}`);
    if (!MAINTAINER_PERMISSIONS.has(permission)) maintainer = false;
  }
  console.log(maintainer ? "Maintainer pull request." : "Submission: only packs/<id>.yaml may change.");

  const { readEntry, listEntries } = pull;
  const { entries, errors } = await gate({ files, maintainer, readEntry, listEntries });
  if (errors.length > 0) throw new Error(errors.join("\n"));

  fs.mkdirSync(path.join(out, "entries"), { recursive: true });
  for (const entry of entries) fs.writeFileSync(path.join(out, "entries", `${entry.id}.yaml`), entry.text);
  const ids = JSON.stringify(entries.map((e) => e.id));
  fs.writeFileSync(path.join(out, "ids.json"), `${ids}\n`);
  const kept = entries.filter((e) => e.kept).map((e) => `${e.id}\n`);
  fs.writeFileSync(path.join(out, "kept-ids.txt"), kept.join(""));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ids=${ids}\n`);
  console.log(entries.length > 0 ? `Entries to check: ${entries.map((e) => e.file).join(", ")}` : "No entry to check.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    for (const line of error.message.split("\n")) console.error(`::error::${line}`);
    process.exit(1);
  });
}
