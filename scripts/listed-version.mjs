#!/usr/bin/env node
/**
 * Exits 0 when the store's index.json already lists `<pack id>` at `<version>`, 1 when it doesn't (or there is no
 * index.json). The publish workflow uses it for an adopted pack (`adopt: game`): a version the game repo already
 * published stays as it published it, so it is built and checked here but not staged for upload again.
 *
 *   node scripts/listed-version.mjs <index.json, or a path that does not exist for none> <pack id> <version>
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Whether `index` lists pack `id` at `version`. */
export function isListed(index, id, version) {
  const pack = (index?.packs ?? []).find((one) => one.id === id);
  return Boolean(pack?.versions && Object.hasOwn(pack.versions, version));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [indexPath, id, version] = process.argv.slice(2);
  if (!indexPath || !id || !version) {
    console.error("usage: node scripts/listed-version.mjs <index.json> <pack id> <version>");
    process.exit(2);
  }
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : undefined;
  process.exit(isListed(index, id, version) ? 0 : 1);
}
