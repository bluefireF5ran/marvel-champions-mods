#!/usr/bin/env node
/**
 * Compares a rebuilt pack's zip with the zip on its creator's release (fetched by scripts/fetch-release.sh), for
 * scripts/build-entry.sh. A repo entry is only listed when the two are the same bytes, so what players get is what the
 * creator published: a missing release zip fails, as a different one does.
 *
 *   node scripts/compare-release-zip.mjs <built zip> <release zip>
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** `{ ok: true, sha }` when the release zip has the built zip's bytes, else `{ ok: false, error }`. */
export function compareReleaseZip(builtZip, releaseZip) {
  const built = sha256(builtZip);
  if (!existsSync(releaseZip)) {
    return {
      ok: false,
      error: `the release has no ${basename(releaseZip)}: attach the zip mc-pack build wrote to the tagged release`,
    };
  }
  const released = sha256(releaseZip);
  if (released !== built) {
    return { ok: false, error: `the release's zip (${released}) differs from the rebuilt one (${built})` };
  }
  return { ok: true, sha: built };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [builtZip, releaseZip] = process.argv.slice(2);
  const result = compareReleaseZip(builtZip, releaseZip);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(`The release's zip matches the rebuilt one (${result.sha}).`);
}
