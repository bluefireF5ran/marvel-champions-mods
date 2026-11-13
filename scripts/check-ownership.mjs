#!/usr/bin/env node
/**
 * Fails when the store's index.json already lists one of the given pack ids from the other publisher, the game repo
 * (an entry with `source: "game"`, or with no `source`): a pack id is published by one of the two only
 * (docs/custom-content-packs.md §11.4 in the game repo). The publish workflow runs it before anything is uploaded:
 * in the build job against the public index.json, and again in the upload job against the bucket's copy.
 * scripts/update-index.mjs refuses the same ids when it merges, as the last line of defence.
 *
 *   node scripts/check-ownership.mjs <index.json, or a path that does not exist for none> <pack id>...
 */
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ownershipProblems } from "./update-index.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [indexPath, ...ids] = process.argv.slice(2);
  if (!indexPath) {
    console.error("usage: node scripts/check-ownership.mjs <index.json> <pack id>...");
    process.exit(2);
  }
  const current = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : undefined;
  const problems = ownershipProblems(current, ids);
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(ids.length > 0 ? `This registry may publish ${ids.join(", ")}.` : "No packs to check.");
}
