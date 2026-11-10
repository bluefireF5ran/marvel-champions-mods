// Updates the store's index.json (docs/custom-content-packs.md §11.5 in the game's repo) after a publish.
//
//   node scripts/update-index.mjs <current index.json or "-" for none> <published dir> <ids file> <base url> <fallback base>
//
// <published dir> holds one folder per pack published in this run: entry.json (the registry entry as JSON),
// pack.json (the built manifest), zip.sha256, and the zip. <ids file> lists every pack id that still has a
// packs/<id>.yaml; a pack in the index whose file was deleted is dropped (withdrawn, §11.4). Older versions stay in
// the index so saves that used them still load. Prints the new index.json.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [currentPath, publishedDir, idsPath, baseUrl, fallbackBase] = process.argv.slice(2);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const current = currentPath !== "-" && existsSync(currentPath) ? read(currentPath) : { schema: 2, packs: [] };
const liveIds = new Set(readFileSync(idsPath, "utf8").split("\n").filter(Boolean));
const today = new Date().toISOString().slice(0, 10);

const byId = new Map(current.packs.filter((pack) => liveIds.has(pack.id)).map((pack) => [pack.id, pack]));

for (const id of existsSync(publishedDir) ? readdirSync(publishedDir) : []) {
  const dir = join(publishedDir, id);
  const entry = read(join(dir, "entry.json"));
  const manifest = read(join(dir, "pack.json"));
  const sha = readFileSync(join(dir, "zip.sha256"), "utf8").trim();
  const version = manifest.version;
  const zipName = `${id}-${version}.zip`;
  const base = `${baseUrl}/${id}/${version}/`;
  const previous = byId.get(id);
  byId.set(id, {
    id,
    kind: manifest.kind,
    name: manifest.name,
    creator: entry.creator,
    summary: entry.summary ?? manifest.description.split("\n")[0],
    tags: entry.tags ?? [],
    ...(existsSync(join(dir, "thumb.webp")) ? { thumbnail: `${base}thumb.webp` } : {}),
    approved: previous?.approved ?? today,
    latest: version,
    versions: {
      ...previous?.versions,
      [version]: {
        manifest: `${base}pack.json`,
        base,
        zip: `${base}${zipName}`,
        zipFallback: `${fallbackBase}/${id}-v${version}/${zipName}`,
        zipBytes: statSync(join(dir, zipName)).size,
        zipSha256: sha,
        requires: manifest.requires,
      },
    },
    withdrawn: false,
  });
}

const index = {
  schema: 2,
  generated: new Date().toISOString(),
  packs: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)),
};
process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
