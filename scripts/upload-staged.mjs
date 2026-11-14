#!/usr/bin/env node
/**
 * Uploads the packs the publish workflow's build job staged (scripts/stage-pack.mjs: published/<id>/) to R2 under
 * <id>/<version>/, and attaches each zip to a release of this repo (the store's zipFallback). Safe to re-run after a
 * failure part way:
 *
 *   - Published versions are immutable. Every object of every staged pack (pack.json, preview.json, thumb.webp, the
 *     card pictures and the zip) is checked before anything is uploaded: a version whose objects are all there with
 *     the same sha256 (a retry after the upload went through) is skipped; one with any object there with other bytes
 *     fails the run ("bump the version"); otherwise the objects not there yet are uploaded.
 *   - Every object goes up with its sha256 as object metadata, so a retry compares without downloading it (an object
 *     uploaded without the metadata is downloaded and hashed). The zip goes up last, so its presence marks the
 *     version complete.
 *   - Every put is conditional (If-None-Match: *), so it never overwrites an object already there. The game repo's
 *     publisher writes the same bucket: if both publish a new <id>/<version> at once, both pass the check above and
 *     only one put of each object succeeds; the other gets a 412, hashes the object that won and goes on only when
 *     it is the same bytes. So a publisher whose files differ stops at the first one the other wrote, and the bucket
 *     never holds one publisher's zip with the other's pack.json, preview or pictures, nor a zip whose sha256
 *     index.json does not list. (A publisher that stops may leave objects the winner's pack does not have, such as a
 *     card picture only it staged; nothing the winner's pack.json or preview.json names is ever another's.)
 *   - The release is ensured, not created blindly: missing, it is created with the zip; present without the zip, the
 *     zip is attached; present with the zip, its sha256 must match: the asset's digest when GitHub reports one,
 *     otherwise the asset is downloaded and hashed (a same-size zip with other bytes is refused).
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
 * `[{ path, key, name, contentType, sha256 }]` in upload order, the zip last (`name` is the key under
 * `<id>/<version>/`). A missing folder or one with no pack folders is none.
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
    for (const file of files) {
      Object.assign(file, { name: file.key.slice(prefix.length), sha256: sha256File(file.path) });
    }
    const zipSha = files.at(-1).sha256;
    packs.push({ id, version, zipName, zipPath, zipSha, zipBytes: fs.statSync(zipPath).size, files });
  }
  return packs;
}

/** How a file is named in a message: "zip" for the zip, its key under `<id>/<version>/` otherwise. */
const fileLabel = (pack, file) => (file.path === pack.zipPath ? "zip" : file.name);

/**
 * What to do with each staged pack, from every one of its objects. `store.sha256(key)` resolves the sha256 of the
 * object already in the bucket, or null when there is none. Resolves `{ plan: [{ pack, action: "upload" | "skip",
 * files }], errors }`: `files` are the ones to upload (the zip last), the ones not in the bucket yet. A pack with any
 * object already there with other bytes is an error, and nothing of any pack should be uploaded then.
 */
export async function planUploads(packs, store) {
  const plan = [];
  const errors = [];
  for (const pack of packs) {
    const missing = [];
    const differ = [];
    for (const file of pack.files) {
      const published = await store.sha256(file.key);
      if (published == null) missing.push(file);
      else if (published !== file.sha256) differ.push({ file, published });
    }
    if (differ.length > 0) {
      const what = differ
        .map(({ file, published }) => `${fileLabel(pack, file)} (${published}, built ${file.sha256})`)
        .join(", ");
      errors.push(
        `${pack.id} ${pack.version} is already published with a different ${what}: bump the pack's version`,
      );
    } else if (missing.length === 0) plan.push({ pack, action: "skip", files: [] });
    else plan.push({ pack, action: "upload", files: missing });
  }
  return { plan, errors };
}

/**
 * Makes sure release `<id>-v<version>` exists and carries the zip. `release.view(tag)` resolves `{ assets: [{ name,
 * size, digest }] }` or null when there is no such release; `release.assetSha256(tag, name)` downloads an asset and
 * resolves its sha256, for an asset listed without a digest. Resolves "created", "attached" or "present".
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
  // Size alone proves nothing: without a digest, the asset's bytes are hashed.
  const published = asset.digest ?? `sha256:${await release.assetSha256(tag, pack.zipName)}`;
  if (published !== `sha256:${pack.zipSha}`) {
    throw new Error(
      `release ${tag} already carries a different ${pack.zipName} (${published}, built sha256:${pack.zipSha}): ` +
        "bump the pack's version",
    );
  }
  return "present";
}

/**
 * Checks every object of every pack, then uploads the new ones (each put conditional, the zip last) and ensures each
 * one's release. Throws before uploading anything when a pack is refused. Resolves `[{ id, version, action,
 * release }]`.
 */
export async function publishStaged(packs, { store, release, log = () => {} }) {
  const { plan, errors } = await planUploads(packs, store);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const done = [];
  for (const { pack, action, files } of plan) {
    if (action === "upload") {
      for (const file of files) {
        if ((await store.put(file)) === "written") continue;
        // Another publisher's object got there first (between the check above and now): keep going only if it is
        // the same bytes as ours, so this version's objects all come from one build.
        const published = await store.sha256(file.key);
        if (published !== file.sha256) {
          throw new Error(
            `${pack.id} ${pack.version} was published by someone else while this run uploaded it, with a different ` +
              `${fileLabel(pack, file)} (${published}, built ${file.sha256}): the bucket keeps theirs; ` +
              "bump the pack's version",
          );
        }
        const what = fileLabel(pack, file);
        log(`${pack.id} ${pack.version}: the same ${what} was uploaded by another publisher meanwhile.`);
      }
      log(`Uploaded ${pack.id} ${pack.version} (${files.length} of ${pack.files.length} files).`);
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
    /** The sha256 of the object at `key`: its metadata, or its bytes hashed when it has none; null when none. */
    async sha256(key) {
      const head = await aws(["s3api", "head-object", "--bucket", bucket, "--key", key]);
      if (head.code !== 0) {
        if (/\(404\)|Not Found|NoSuchKey/i.test(head.stderr)) return null;
        throw new Error(`aws s3api head-object ${key} failed: ${head.stderr.trim()}`);
      }
      const stored = JSON.parse(head.stdout).Metadata?.sha256;
      if (stored) return stored;
      const file = path.join(dir, "published-object");
      const get = await aws(["s3", "cp", "--only-show-errors", `s3://${bucket}/${key}`, file]);
      if (get.code !== 0) throw new Error(`aws s3 cp ${key} failed: ${get.stderr.trim()}`);
      const sha = sha256File(file);
      fs.rmSync(file, { force: true });
      return sha;
    },
    /**
     * Uploads one file `{ key, path, contentType, sha256 }`, with its sha256 as metadata, only if there is no object
     * at the key yet (If-None-Match: *; R2 evaluates it atomically; `s3api put-object --if-none-match` needs aws cli
     * 2.22+). Resolves "exists" on a 412 or a 409 (a put that raced ours), "written" otherwise.
     */
    async put(file) {
      const args = ["s3api", "put-object", "--bucket", bucket, "--key", file.key, "--body", file.path];
      args.push("--content-type", file.contentType, "--cache-control", IMMUTABLE, "--if-none-match", "*");
      args.push("--metadata", `sha256=${file.sha256}`);
      const { code, stderr } = await aws(args);
      if (code === 0) return "written";
      if (/PreconditionFailed|\(412\)|ConditionalRequestConflict|\(409\)/i.test(stderr)) return "exists";
      throw new Error(`aws s3api put-object ${file.key} failed: ${stderr.trim()}`);
    },
  };
}

/** This repo's releases over gh. `dir` is a scratch folder for an asset downloaded to be hashed. */
export function ghRelease({ repo, dir, exec = run }) {
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
    async assetSha256(tag, name) {
      const into = fs.mkdtempSync(path.join(dir, "asset-"));
      try {
        await gh(["release", "download", tag, "--pattern", name, "--dir", into]);
        return sha256File(path.join(into, name));
      } finally {
        fs.rmSync(into, { recursive: true, force: true });
      }
    },
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
      release: ghRelease({ repo: process.env.GITHUB_REPOSITORY, dir }),
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
