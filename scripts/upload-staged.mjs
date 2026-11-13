#!/usr/bin/env node
/**
 * Uploads the packs the publish workflow's build job staged (scripts/stage-pack.mjs: published/<id>/) to R2 under
 * <id>/<version>/, and attaches each zip to a release of this repo (the store's zipFallback). Safe to re-run after a
 * failure part way:
 *
 *   - Published versions are immutable. Every staged pack is checked before anything is uploaded: a version whose
 *     zip is not in the bucket is uploaded; one whose zip is there with the same sha256 (a retry after the upload
 *     went through) is skipped; one whose zip differs fails the run ("bump the version").
 *   - The zip goes up last, with its sha256 as object metadata, so its presence marks the version complete and a
 *     retry can compare without downloading it (a zip uploaded without the metadata is downloaded and hashed).
 *   - The release is ensured, not created blindly: missing, it is created with the zip; present without the zip, the
 *     zip is attached; present with the zip, its digest (or size) must match.
 *
 * No staged pack (a run that only deleted entries) uploads nothing and succeeds, so the index update still runs.
 * Runs in the upload job, which holds the R2 secrets and runs no pack code: Node built-ins, the aws cli and gh only.
 *
 *   node scripts/upload-staged.mjs <published dir>
 *
 * Environment: ENDPOINT, BUCKET (R2), AWS_* credentials, GH_TOKEN and GITHUB_REPOSITORY (the release).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const IMMUTABLE = "public, max-age=31536000, immutable";

const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * The staged packs under `dir`: `[{ id, version, zipName, zipPath, zipSha, zipBytes, files }]`, where `files` is
 * `[{ path, key, contentType }]` in upload order, the zip last. A missing folder or one with no pack folders is none.
 */
export function readStaged(dir) {
  if (!fs.existsSync(dir)) return [];
  const packs = [];
  for (const id of fs.readdirSync(dir).sort()) {
    const at = path.join(dir, id);
    if (!fs.statSync(at).isDirectory()) continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(at, "pack.json"), "utf8"));
    if (manifest.id !== id) throw new Error(`${id}: its staged pack.json says ${manifest.id}`);
    const version = manifest.version;
    const zipName = `${id}-${version}.zip`;
    const zipPath = path.join(at, zipName);
    if (!fs.existsSync(zipPath)) throw new Error(`${id}: ${zipName} is not staged`);
    const prefix = `${id}/${version}/`;
    const files = [{ path: path.join(at, "pack.json"), key: `${prefix}pack.json`, contentType: "application/json" }];
    for (const [name, contentType] of [
      ["preview.json", "application/json"],
      ["thumb.webp", "image/webp"],
    ]) {
      const file = path.join(at, name);
      if (fs.existsSync(file)) files.push({ path: file, key: prefix + name, contentType });
    }
    const cards = path.join(at, "cards");
    if (fs.existsSync(cards)) {
      for (const lang of fs.readdirSync(cards).sort()) {
        const langDir = path.join(cards, lang);
        if (!fs.statSync(langDir).isDirectory()) continue;
        for (const name of fs.readdirSync(langDir).sort()) {
          if (!name.endsWith(".webp")) continue;
          const key = `${prefix}cards/${lang}/${name}`;
          files.push({ path: path.join(langDir, name), key, contentType: "image/webp" });
        }
      }
    }
    files.push({ path: zipPath, key: prefix + zipName, contentType: "application/zip" });
    const zipSha = sha256File(zipPath);
    packs.push({ id, version, zipName, zipPath, zipSha, zipBytes: fs.statSync(zipPath).size, files });
  }
  return packs;
}

/**
 * What to do with each staged pack. `store.zipSha256(key)` resolves the sha256 of the zip already in the bucket, or
 * null when there is none. Resolves `{ plan: [{ pack, action: "upload" | "skip" }], errors }`.
 */
export async function planUploads(packs, store) {
  const plan = [];
  const errors = [];
  for (const pack of packs) {
    const published = await store.zipSha256(`${pack.id}/${pack.version}/${pack.zipName}`);
    if (published == null) plan.push({ pack, action: "upload" });
    else if (published === pack.zipSha) plan.push({ pack, action: "skip" });
    else
      errors.push(
        `${pack.id} ${pack.version} is already published with a different zip (${published}, built ${pack.zipSha}): ` +
          "bump the pack's version",
      );
  }
  return { plan, errors };
}

/**
 * Makes sure release `<id>-v<version>` exists and carries the zip. `release.view(tag)` resolves `{ assets: [{ name,
 * size, digest }] }` or null when there is no such release. Resolves "created", "attached" or "present".
 */
export async function ensureRelease(pack, release) {
  const tag = `${pack.id}-v${pack.version}`;
  const existing = await release.view(tag);
  if (!existing) {
    await release.create(tag, pack);
    return "created";
  }
  const asset = (existing.assets ?? []).find((one) => one.name === pack.zipName);
  if (!asset) {
    await release.upload(tag, pack);
    return "attached";
  }
  const same = asset.digest ? asset.digest === `sha256:${pack.zipSha}` : asset.size === pack.zipBytes;
  if (!same) {
    throw new Error(
      `release ${tag} already carries a different ${pack.zipName} (${asset.digest ?? `${asset.size} bytes`}, built ` +
        `sha256:${pack.zipSha}): bump the pack's version`,
    );
  }
  return "present";
}

/**
 * Checks every pack, then uploads the new ones (zip last) and ensures each one's release. Throws before uploading
 * anything when a pack is refused. Resolves `[{ id, version, action, release }]`.
 */
export async function publishStaged(packs, { store, release, log = () => {} }) {
  const { plan, errors } = await planUploads(packs, store);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const done = [];
  for (const { pack, action } of plan) {
    if (action === "upload") {
      for (const file of pack.files) {
        await store.put(file, file.path === pack.zipPath ? { sha256: pack.zipSha } : {});
      }
      log(`Uploaded ${pack.id} ${pack.version} (${pack.files.length} files).`);
    } else {
      log(`${pack.id} ${pack.version} is already in the bucket with the same zip; not uploaded again.`);
    }
    const state = await ensureRelease(pack, release);
    log(`Release ${pack.id}-v${pack.version}: ${state}.`);
    done.push({ id: pack.id, version: pack.version, action, release: state });
  }
  return done;
}

const run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    );
  });

/** The bucket over the aws cli. `exec(file, args)` resolves `{ code, stdout, stderr }`. */
export function awsStore({ endpoint, bucket, dir, exec = run }) {
  const aws = (args) => exec("aws", [...args, "--endpoint-url", endpoint]);
  return {
    async zipSha256(key) {
      const head = await aws(["s3api", "head-object", "--bucket", bucket, "--key", key]);
      if (head.code !== 0) {
        if (/\(404\)|Not Found|NoSuchKey/i.test(head.stderr)) return null;
        throw new Error(`aws s3api head-object ${key} failed: ${head.stderr.trim()}`);
      }
      const stored = JSON.parse(head.stdout).Metadata?.sha256;
      if (stored) return stored;
      const file = path.join(dir, "published.zip");
      const get = await aws(["s3", "cp", "--only-show-errors", `s3://${bucket}/${key}`, file]);
      if (get.code !== 0) throw new Error(`aws s3 cp ${key} failed: ${get.stderr.trim()}`);
      const sha = sha256File(file);
      fs.rmSync(file, { force: true });
      return sha;
    },
    async put(file, { sha256 } = {}) {
      const args = ["s3", "cp", "--only-show-errors", file.path, `s3://${bucket}/${file.key}`];
      args.push("--content-type", file.contentType, "--cache-control", IMMUTABLE);
      if (sha256) args.push("--metadata", `sha256=${sha256}`);
      const { code, stderr } = await aws(args);
      if (code !== 0) throw new Error(`aws s3 cp ${file.key} failed: ${stderr.trim()}`);
    },
  };
}

/** This repo's releases over gh. */
export function ghRelease({ repo, exec = run }) {
  const gh = async (args) => {
    const result = await exec("gh", [...args, "--repo", repo]);
    if (result.code !== 0) {
      const what = `gh ${args.slice(0, 2).join(" ")}`;
      throw Object.assign(new Error(`${what} failed: ${result.stderr.trim()}`), result);
    }
    return result;
  };
  return {
    async view(tag) {
      try {
        return JSON.parse((await gh(["release", "view", tag, "--json", "assets"])).stdout);
      } catch (error) {
        if (/release not found|HTTP 404/i.test(String(error.stderr))) return null;
        throw error;
      }
    },
    create: (tag, pack) => {
      const title = `${pack.id} ${pack.version}`;
      return gh(["release", "create", tag, pack.zipPath, "--title", title, "--notes", `Approved pack ${title}.`]);
    },
    upload: (tag, pack) => gh(["release", "upload", tag, pack.zipPath]),
  };
}

async function main() {
  const [publishedDir] = process.argv.slice(2);
  if (!publishedDir) throw new Error("usage: node scripts/upload-staged.mjs <published dir>");
  const packs = readStaged(publishedDir);
  if (packs.length === 0) {
    console.log("No packs staged (a run that only withdrew packs): nothing to upload.");
    return;
  }
  for (const name of ["ENDPOINT", "BUCKET", "GITHUB_REPOSITORY"]) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-staged-"));
  try {
    await publishStaged(packs, {
      store: awsStore({ endpoint: process.env.ENDPOINT, bucket: process.env.BUCKET, dir }),
      release: ghRelease({ repo: process.env.GITHUB_REPOSITORY }),
      log: (line) => console.log(line),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    for (const line of error.message.split("\n")) console.error(`::error::${line}`);
    process.exit(1);
  });
}
