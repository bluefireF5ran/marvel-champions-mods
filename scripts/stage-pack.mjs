#!/usr/bin/env node
/**
 * Stages one built pack for the publish workflow's upload job (scripts/build-entry.sh wrote <work dir>):
 *
 *   node scripts/stage-pack.mjs <work dir> <published dir>
 *
 * Copies into <published dir>/<id>/: entry.json and zip.sha256 (for scripts/update-index.mjs), and from `mc-pack
 * build --out`'s folder pack.json, <id>-<version>.zip, preview.json and thumb.webp (when the build wrote them; the
 * thumbnail is the build's, which follows the pack's featured card, not a picture in the source) and the card
 * pictures, cards/<lang>/*.webp. The store shows a pack's cards before it is installed by fetching
 * <base>cards/<lang>/<code>.webp one by one, so they are uploaded unpacked next to the zip, exactly as the game repo's
 * publish-packs workflow stages them (docs/custom-content-packs.md §11.5).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Stages `<work>` into `<publishedDir>/<id>/` and returns that folder. Throws when the id is already staged. */
export function stagePack(work, publishedDir) {
  const entry = JSON.parse(readFileSync(join(work, "entry.json"), "utf8"));
  const out = join(work, "out");
  const manifest = JSON.parse(readFileSync(join(out, "pack.json"), "utf8"));
  const id = entry.id;
  if (manifest.id !== id) throw new Error(`${id}: the built pack.json says ${manifest.id}`);
  const zip = `${id}-${manifest.version}.zip`;
  if (!existsSync(join(out, zip))) throw new Error(`${id}: the build wrote no ${zip}`);
  const target = join(publishedDir, id);
  if (existsSync(target)) throw new Error(`${id} is staged twice in one run`);
  mkdirSync(target, { recursive: true });
  copyFileSync(join(work, "entry.json"), join(target, "entry.json"));
  copyFileSync(join(work, "zip.sha256"), join(target, "zip.sha256"));
  for (const file of ["pack.json", zip, "preview.json", "thumb.webp"]) {
    if (existsSync(join(out, file))) copyFileSync(join(out, file), join(target, file));
  }
  const cards = join(out, "cards");
  if (existsSync(cards)) {
    for (const lang of readdirSync(cards).sort()) {
      const from = join(cards, lang);
      if (!statSync(from).isDirectory()) continue;
      const pictures = readdirSync(from).filter(
        (name) => name.endsWith(".webp") && statSync(join(from, name)).isFile(),
      );
      if (pictures.length === 0) continue;
      mkdirSync(join(target, "cards", lang), { recursive: true });
      for (const name of pictures) copyFileSync(join(from, name), join(target, "cards", lang, name));
    }
  }
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [work, publishedDir] = process.argv.slice(2);
  try {
    const target = stagePack(work, publishedDir);
    console.log(`Staged ${target}: ${readdirSync(target).join(" ")}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
