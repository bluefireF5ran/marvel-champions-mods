// node --test "scripts/*.test.mjs" (the script tests). The check workflow's trusted gate: what a pull request may change
// and which entries it checks, with the pull request's files and head faked.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gate, githubPullRequest } from "./pr-gate.mjs";

const repoEntry = (id) => `id: ${id}\nrepo: https://github.com/someone/${id}\ntag: v1.0.0\n`;
const keptEntry = (id) => `id: ${id}\npath: packs/${id}\n`;

/** The pull request's head: `{ path: text }`. */
const head = (tree) => ({
  readEntry: async (file) => tree[file] ?? null,
  listEntries: async () => Object.keys(tree).filter((p) => /^packs\/[^/]+\.yaml$/.test(p)),
});
const changed = (...names) => names.map((filename) => ({ filename, status: "modified" }));

describe("gate: a submission (not a maintainer)", () => {
  it("checks the one entry it adds", async () => {
    const { entries, errors } = await gate({
      files: [{ filename: "packs/fan-a.yaml", status: "added" }],
      maintainer: false,
      ...head({ "packs/fan-a.yaml": repoEntry("fan-a") }),
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(
      entries.map((e) => e.id),
      ["fan-a"],
    );
  });

  // The review's P1s: a submission that also changes the scripts the check would run is refused, whatever they say.
  for (const script of ["scripts/fetch-release.sh", "scripts/changed-entries.sh", ".github/workflows/check.yml"]) {
    it(`refuses a change to ${script} next to its entry`, async () => {
      const { errors } = await gate({
        files: changed("packs/fan-a.yaml", script),
        maintainer: false,
        ...head({ "packs/fan-a.yaml": repoEntry("fan-a") }),
      });
      assert.equal(errors.length, 1);
      assert.match(errors[0], new RegExp(`^${script.replaceAll(".", "\\.")}: a submission may only`));
    });
  }

  it("refuses a change under a pack folder, a path entry and the SDK version", async () => {
    const { errors } = await gate({
      files: changed("packs/fan-a/abilities/index.ts", "package-lock.json"),
      maintainer: false,
      ...head({ "packs/fan-a.yaml": keptEntry("fan-a") }),
    });
    assert.deepEqual(errors.length, 3);
    assert.match(errors[0], /^packs\/fan-a\/abilities\/index\.ts: a submission may only/);
    assert.match(errors[1], /^package-lock\.json: a submission may only/);
    assert.match(errors[2], /path entries .* are added by the maintainer/);
  });

  it("refuses two entries in one pull request", async () => {
    const { errors } = await gate({
      files: changed("packs/fan-a.yaml", "packs/fan-b.yaml"),
      maintainer: false,
      ...head({ "packs/fan-a.yaml": repoEntry("fan-a"), "packs/fan-b.yaml": repoEntry("fan-b") }),
    });
    assert.match(errors.join("\n"), /one pack/);
  });

  it("refuses a file name that is not a well-formed id", async () => {
    const { errors } = await gate({
      files: changed("packs/Fan_A.yaml"),
      maintainer: false,
      ...head({ "packs/Fan_A.yaml": repoEntry("Fan_A") }),
    });
    assert.match(errors.join("\n"), /lowercase letters, digits and single dashes/);
  });

  it("checks nothing, and passes, for a withdrawal (a deleted entry)", async () => {
    const { entries, errors } = await gate({
      files: [{ filename: "packs/fan-a.yaml", status: "removed" }],
      maintainer: false,
      ...head({}),
    });
    assert.deepEqual([entries, errors], [[], []]);
  });

  // The one-pack rule counts withdrawals too (deleting an entry withdraws the pack on merge).
  it("refuses two withdrawals in one pull request", async () => {
    const { errors } = await gate({
      files: [
        { filename: "packs/fan-a.yaml", status: "removed" },
        { filename: "packs/fan-b.yaml", status: "removed" },
      ],
      maintainer: false,
      ...head({}),
    });
    assert.deepEqual(errors, ["a submission withdraws one pack at a time; this one withdraws fan-a, fan-b"]);
  });

  it("refuses a withdrawal next to a new entry", async () => {
    const { errors } = await gate({
      files: [
        { filename: "packs/fan-a.yaml", status: "removed" },
        { filename: "packs/fan-b.yaml", status: "added" },
      ],
      maintainer: false,
      ...head({ "packs/fan-b.yaml": repoEntry("fan-b") }),
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /one pack; this one withdraws fan-a and adds or changes fan-b/);
  });

  it("refuses a withdrawal next to a changed entry", async () => {
    const { errors } = await gate({
      files: [{ filename: "packs/fan-a.yaml", status: "removed" }, ...changed("packs/fan-b.yaml")],
      maintainer: false,
      ...head({ "packs/fan-b.yaml": repoEntry("fan-b") }),
    });
    assert.match(errors.join("\n"), /withdraws fan-a and adds or changes fan-b/);
  });

  it("refuses a rename, which withdraws the old id and submits the new one", async () => {
    const { errors } = await gate({
      files: [{ filename: "packs/fan-b.yaml", previous_filename: "packs/fan-a.yaml", status: "renamed" }],
      maintainer: false,
      ...head({ "packs/fan-b.yaml": repoEntry("fan-b") }),
    });
    assert.match(errors.join("\n"), /withdraws fan-a and adds or changes fan-b/);
  });

  it("refuses two withdrawals hidden in renames and deletions", async () => {
    const { errors } = await gate({
      files: [
        { filename: "packs/fan-c.yaml", previous_filename: "packs/fan-a.yaml", status: "renamed" },
        { filename: "packs/fan-b.yaml", status: "removed" },
      ],
      maintainer: false,
      ...head({ "packs/fan-c.yaml": repoEntry("fan-c") }),
    });
    assert.match(errors.join("\n"), /withdraws fan-a, fan-b and adds or changes fan-c/);
  });
});

describe("gate: fails closed", () => {
  // The review's second P1: packs/foo.yaml changed and nothing to check must fail, never pass as "no entry".
  it("fails when packs/foo.yaml changed but no entry is found at the head", async () => {
    const { entries, errors } = await gate({ files: changed("packs/foo.yaml"), maintainer: true, ...head({}) });
    assert.deepEqual(entries, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /packs\/foo\.yaml changed but could not be read/);
  });

  it("fails when a pack folder changed without its entry", async () => {
    const { errors } = await gate({ files: changed("packs/foo/pack.json"), maintainer: true, ...head({}) });
    assert.match(errors.join("\n"), /packs\/foo\/ changed but packs\/foo\.yaml is not in the pull request/);
  });

  it("lets a maintainer keep a draft pack folder with no entry, and checks nothing for it", async () => {
    const draft = { "packs/foo/DRAFT": "waiting on a co-author" };
    const { entries, errors } = await gate({ files: changed("packs/foo/pack.json"), maintainer: true, ...head(draft) });
    assert.deepEqual(errors, []);
    assert.deepEqual(entries, []);
  });

  it("still refuses a draft folder from a submission", async () => {
    const draft = { "packs/foo/DRAFT": "" };
    const { errors } = await gate({ files: changed("packs/foo/pack.json"), maintainer: false, ...head(draft) });
    assert.ok(errors.length > 0);
  });
});

describe("gate: a maintainer", () => {
  it("may change scripts and workflows; with no pack touched, nothing is checked", async () => {
    const { entries, errors } = await gate({
      files: changed("scripts/fetch-release.sh", ".github/workflows/check.yml"),
      maintainer: true,
      ...head({ "packs/fan-a.yaml": repoEntry("fan-a") }),
    });
    assert.deepEqual([entries, errors], [[], []]);
  });

  it("may rename an entry and withdraw others in one pull request; the new name is checked", async () => {
    const { entries, errors } = await gate({
      files: [
        { filename: "packs/fan-b.yaml", previous_filename: "packs/fan-a.yaml", status: "renamed" },
        { filename: "packs/fan-c.yaml", status: "removed" },
        { filename: "packs/fan-d.yaml", status: "removed" },
      ],
      maintainer: true,
      ...head({ "packs/fan-b.yaml": repoEntry("fan-b") }),
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(
      entries.map((e) => e.id),
      ["fan-b"],
    );
  });

  it("checks the entry of a pack folder they changed", async () => {
    const { entries, errors } = await gate({
      files: changed("packs/fan-a/cards/en/01a.webp"),
      maintainer: true,
      ...head({ "packs/fan-a.yaml": keptEntry("fan-a") }),
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(
      entries.map((e) => [e.id, e.kept]),
      [["fan-a", true]],
    );
  });

  it("checks every path entry when the SDK version changes", async () => {
    const { entries, errors } = await gate({
      files: changed("package-lock.json"),
      maintainer: true,
      ...head({
        "packs/fan-a.yaml": keptEntry("fan-a"),
        "packs/fan-b.yaml": repoEntry("fan-b"),
        "packs/fan-c.yaml": keptEntry("fan-c"),
      }),
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(
      entries.map((e) => e.id),
      ["fan-a", "fan-c"],
    );
  });
});

describe("githubPullRequest", () => {
  const pull = (respond) =>
    githubPullRequest({
      repo: "o/r",
      pr: "7",
      headSha: "h".repeat(40),
      exec: async (_file, args) => respond(args),
    });

  it("lists the files from the API, and reads entries at the head sha", async () => {
    const seen = [];
    const api = pull((args) => {
      seen.push(args.at(-1));
      if (args.at(-1).includes("/files")) {
        return {
          code: 0,
          stdout: '{"filename":"packs/a.yaml","status":"added","previous_filename":null}\n',
          stderr: "",
        };
      }
      return { code: 0, stdout: "id: a\n", stderr: "" };
    });
    assert.deepEqual(await api.files(), [{ filename: "packs/a.yaml", status: "added", previous_filename: null }]);
    assert.equal(await api.readEntry("packs/a.yaml"), "id: a\n");
    assert.deepEqual(seen, [
      "repos/o/r/pulls/7/files?per_page=100",
      `repos/o/r/contents/packs/a.yaml?ref=${"h".repeat(40)}`,
    ]);
  });

  it("reads a missing entry as null and a non-collaborator as no permission", async () => {
    const api = pull(() => ({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }));
    assert.equal(await api.readEntry("packs/a.yaml"), null);
    assert.equal(await api.permission("someone"), "none");
  });

  it("fails on any other API error", async () => {
    const api = pull(() => ({ code: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)" }));
    await assert.rejects(api.readEntry("packs/a.yaml"), /HTTP 502/);
    await assert.rejects(api.files(), /HTTP 502/);
  });
});
