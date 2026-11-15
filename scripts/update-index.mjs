// Updates the store's index.json (docs/custom-content-packs.md §11.5 in the game's repo) after a publish.
//
//   node scripts/update-index.mjs <current index.json or "-" for none> <published dir> <ids file> <base url> <fallback base> [<adopted ids file>]
//
// <published dir> holds one folder per pack published in this run (scripts/stage-pack.mjs): entry.json (the registry
// entry as JSON), pack.json (the built manifest), zip.sha256, the zip, and preview.json, thumb.webp and cards/ when the
// build wrote them. It may hold no pack folders at all: a run that only deleted entries still rewrites the index.
// <ids file> lists every pack id that still has a packs/<id>.yaml (lines starting with # are comments); a pack in the
// index whose file was deleted is dropped (withdrawn, §11.4). Older versions stay in the index so saves that used them
// still load. Prints the new index.json.
//
// The rules the game repo's scripts/lib/pack-index.mjs also follows (§11.5, "Two publishers, one index.json"):
//   - `latest` is the highest version by SemVer precedence, not the version this run published, and the pack's name,
//     summary, tags and thumbnail follow it;
//   - `withdrawn` is kept as it is: a publish never lists a withdrawn pack again (a pack the game repo withdrew stays
//     withdrawn). Here a pack is withdrawn by deleting its file, which drops it, and adding the file back lists it.
//   - one publisher per pack id (§11.4): an entry is this registry's when it carries `source: "registry"`. An entry
//     with `source: "game"`, or with no `source` (the game repo's publish writes none), belongs to the game repo, so
//     publishing that id here is refused (`ownershipProblems`, which the publish workflow also runs before it uploads
//     anything), and deleting a packs/<id>.yaml only ever drops a `source: "registry"` entry.
//   - the one exception is adoption: an entry with `adopt: game` (only a `path` entry, so only the maintainer's) takes
//     over an id the game repo published. Its entry becomes `source: "registry"` with every version the game repo
//     published kept as it is, so saves that used them still load. <adopted ids file> lists those ids (the same format
//     as <ids file>); an adopted version the game repo already published is not built into <published dir> again.
//
// The publish workflow runs this inside scripts/r2-conditional-update.mjs, which re-runs it on a fresh read when the
// game repo wrote index.json in between.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Compares two versions by SemVer 2.0.0 precedence (semver.org §11): negative when `a` is older. The same function
 * as the game repo's scripts/lib/pack-index.mjs: keep the two the same.
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const text = String(v).split("+")[0];
    const dash = text.indexOf("-");
    const core = dash < 0 ? text : text.slice(0, dash);
    const pre = dash < 0 ? [] : text.slice(dash + 1).split(".");
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length) - Math.sign(x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const d = compareIdentifiers(x.pre[i], y.pre[i]);
    if (d !== 0) return d;
  }
  return 0;
}

const NUMERIC = /^\d+$/;

/**
 * Why this registry may not publish `ids` into `current`: one line per id whose entry another publisher owns (the game
 * repo's entries have `source: "game"` or no `source`). Empty when every id is new or already this registry's.
 */
export function ownershipProblems(current, ids, adopted = new Set()) {
  const byId = new Map((current?.packs ?? []).map((pack) => [pack.id, pack]));
  const problems = [];
  for (const id of ids) {
    const pack = byId.get(id);
    if (!pack || pack.source === "registry") continue;
    // Adoption takes over the game repo's ids only, never another publisher's.
    if (adopted.has(id) && (pack.source === undefined || pack.source === "game")) continue;
    const owner = pack.source === undefined ? "no source, so the game repo's" : `source "${pack.source}"`;
    problems.push(
      `${id} is already in index.json from another publisher (${owner}): a pack id is published by one of the ` +
        "registry and the game repo only, so pick another id or move the pack's publishing over first",
    );
  }
  return problems;
}

/** One pre-release identifier against another; `undefined` (that list ran out first) sorts first. */
function compareIdentifiers(p, q) {
  if (p === q) return 0;
  if (p === undefined) return -1;
  if (q === undefined) return 1;
  const pn = NUMERIC.test(p);
  const qn = NUMERIC.test(q);
  if (pn && qn) {
    // Digit strings of any length: without leading zeros, the longer one is larger.
    const ps = p.replace(/^0+(?=\d)/, "");
    const qs = q.replace(/^0+(?=\d)/, "");
    if (ps.length !== qs.length) return ps.length < qs.length ? -1 : 1;
    return ps === qs ? 0 : ps < qs ? -1 : 1;
  }
  if (pn) return -1;
  if (qn) return 1;
  return p < q ? -1 : 1;
}

/**
 * The new index: `current` (or `{ schema: 2, packs: [] }`) with `published` upserted. Each published pack is
 * `{ id, entry, manifest, sha, zipBytes, hasThumb, hasPreview }`. `liveIds` is the set of ids that still have a
 * packs/<id>.yaml, `adopted` the set of ids whose entry adopts the game repo's (`adopt: game`): a live adopted id's
 * entry becomes this registry's, its versions kept, whether or not this run built a new one. Throws when a published
 * id belongs to another publisher (`ownershipProblems`).
 */
export function updateIndex(current, { published, liveIds, adopted = new Set(), baseUrl, fallbackBase, today, now }) {
  const problems = ownershipProblems(
    current,
    published.map((pack) => pack.id),
    adopted,
  );
  if (problems.length > 0) throw new Error(problems.join("\n"));
  // The game repo publishes its own packs into the same index.json (its publish-packs workflow): only entries this
  // registry published (`source: "registry"`) are withdrawn when their packs/<id>.yaml is gone; the rest are kept.
  const byId = new Map(
    (current?.packs ?? [])
      .filter((pack) => pack.source !== "registry" || liveIds.has(pack.id))
      .map((pack) => [pack.id, pack]),
  );
  for (const id of adopted) {
    const pack = byId.get(id);
    if (pack && liveIds.has(id) && (pack.source === undefined || pack.source === "game")) {
      byId.set(id, { ...pack, source: "registry" });
    }
  }
  for (const { id, entry, manifest, sha, zipBytes, hasThumb, hasPreview } of published) {
    const version = manifest.version;
    const zipName = `${id}-${version}.zip`;
    const base = `${baseUrl}/${id}/${version}/`;
    const previous = byId.get(id);
    const versions = {
      [version]: {
        manifest: `${base}pack.json`,
        base,
        zip: `${base}${zipName}`,
        zipFallback: `${fallbackBase}/${id}-v${version}/${zipName}`,
        zipBytes,
        zipSha256: sha,
        requires: manifest.requires,
        // What the store shows before an install (mc-pack build's preview.json, §11.5), listed as the game repo's
        // scripts/lib/pack-index.mjs lists it.
        ...(hasPreview ? { preview: `${base}preview.json` } : {}),
      },
      // A version already listed is never replaced: published versions are immutable, and an adopted pack's versions
      // stay the game repo's (upload-staged.mjs refuses different bytes for this registry's own).
      ...previous?.versions,
    };
    const latest = Object.keys(versions).sort(compareVersions).at(-1);
    // The pack's own fields follow its newest version: publishing an older version leaves them alone.
    const head =
      !previous || latest === version
        ? {
            kind: manifest.kind,
            name: manifest.name,
            creator: entry.creator,
            summary: entry.summary ?? String(manifest.description ?? "").split("\n")[0],
            tags: entry.tags ?? [],
            ...(hasThumb ? { thumbnail: `${base}thumb.webp` } : {}),
          }
        : {
            kind: previous.kind,
            name: previous.name,
            creator: previous.creator,
            summary: previous.summary,
            tags: previous.tags,
            ...(previous.thumbnail ? { thumbnail: previous.thumbnail } : {}),
          };
    byId.set(id, {
      id,
      ...head,
      approved: previous?.approved ?? today,
      latest,
      versions,
      withdrawn: previous?.withdrawn ?? false,
      source: "registry",
    });
  }
  return {
    schema: 2,
    generated: now,
    packs: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The packs staged under `publishedDir`, as `updateIndex` takes them. No folder, or no pack folders, is no packs. */
export function readPublished(publishedDir) {
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  const published = [];
  for (const id of existsSync(publishedDir) ? readdirSync(publishedDir).sort() : []) {
    const dir = join(publishedDir, id);
    if (!statSync(dir).isDirectory()) continue;
    const manifest = read(join(dir, "pack.json"));
    published.push({
      id,
      entry: read(join(dir, "entry.json")),
      manifest,
      sha: readFileSync(join(dir, "zip.sha256"), "utf8").trim(),
      zipBytes: statSync(join(dir, `${id}-${manifest.version}.zip`)).size,
      hasThumb: existsSync(join(dir, "thumb.webp")),
      hasPreview: existsSync(join(dir, "preview.json")),
    });
  }
  return published;
}

/** The ids in an ids file: one per line, blank lines and `#` comments skipped. A missing file lists none. */
export function readIds(idsPath) {
  if (!existsSync(idsPath)) return new Set();
  return new Set(
    readFileSync(idsPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

function main() {
  const [currentPath, publishedDir, idsPath, baseUrl, fallbackBase, adoptedPath] = process.argv.slice(2);
  const current =
    currentPath !== "-" && existsSync(currentPath) ? JSON.parse(readFileSync(currentPath, "utf8")) : undefined;
  const now = new Date().toISOString();
  const index = updateIndex(current, {
    published: readPublished(publishedDir),
    liveIds: readIds(idsPath),
    adopted: adoptedPath ? readIds(adoptedPath) : new Set(),
    baseUrl,
    fallbackBase,
    today: now.slice(0, 10),
    now,
  });
  process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
    process.exit(1);
  }
}
