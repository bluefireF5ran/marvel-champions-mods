// Updates the store's index.json (docs/custom-content-packs.md §11.5 in the game's repo) after a publish.
//
//   node scripts/update-index.mjs <current index.json or "-" for none> <published dir> <ids file> <base url> <fallback base>
//
// <published dir> holds one folder per pack published in this run: entry.json (the registry entry as JSON),
// pack.json (the built manifest), zip.sha256, and the zip. <ids file> lists every pack id that still has a
// packs/<id>.yaml; a pack in the index whose file was deleted is dropped (withdrawn, §11.4). Older versions stay in
// the index so saves that used them still load. Prints the new index.json.
//
// The rules the game repo's scripts/lib/pack-index.mjs also follows (§11.5, "Two publishers, one index.json"):
//   - `latest` is the highest version by SemVer precedence, not the version this run published, and the pack's name,
//     summary, tags and thumbnail follow it;
//   - `withdrawn` is kept as it is: a publish never lists a withdrawn pack again (a pack the game repo withdrew stays
//     withdrawn). Here a pack is withdrawn by deleting its file, which drops it, and adding the file back lists it.
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
 * `{ id, entry, manifest, sha, zipBytes, hasThumb }`. `liveIds` is the set of ids that still have a packs/<id>.yaml.
 */
export function updateIndex(current, { published, liveIds, baseUrl, fallbackBase, today, now }) {
  // The game repo publishes its own packs into the same index.json (its publish-packs workflow): only entries this
  // registry published (`source: "registry"`) are withdrawn when their packs/<id>.yaml is gone; the rest are kept.
  const byId = new Map(
    (current?.packs ?? [])
      .filter((pack) => pack.source !== "registry" || liveIds.has(pack.id))
      .map((pack) => [pack.id, pack]),
  );
  for (const { id, entry, manifest, sha, zipBytes, hasThumb } of published) {
    const version = manifest.version;
    const zipName = `${id}-${version}.zip`;
    const base = `${baseUrl}/${id}/${version}/`;
    const previous = byId.get(id);
    const versions = {
      ...previous?.versions,
      [version]: {
        manifest: `${base}pack.json`,
        base,
        zip: `${base}${zipName}`,
        zipFallback: `${fallbackBase}/${id}-v${version}/${zipName}`,
        zipBytes,
        zipSha256: sha,
        requires: manifest.requires,
      },
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

function main() {
  const [currentPath, publishedDir, idsPath, baseUrl, fallbackBase] = process.argv.slice(2);
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  const current = currentPath !== "-" && existsSync(currentPath) ? read(currentPath) : undefined;
  const liveIds = new Set(readFileSync(idsPath, "utf8").split("\n").filter(Boolean));
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
    });
  }
  const now = new Date().toISOString();
  const index = updateIndex(current, {
    published,
    liveIds,
    baseUrl,
    fallbackBase,
    today: now.slice(0, 10),
    now,
  });
  process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
