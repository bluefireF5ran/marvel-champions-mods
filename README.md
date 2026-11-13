# Mod store registry

This repo lists the community content packs approved for the mod store in the
[Marvel Champions digital game](https://github.com/quincarter/marvel-champions-digital-game). The game's **Extras ▸ Mod
Store** screen reads a catalog built from this repo, and only packs listed here appear in it.

This is a fan-made, non-commercial project. Marvel Champions, its card text, artwork and characters are the
intellectual property of Fantasy Flight Games and Marvel.

## How a pack gets into the store

**Submitting a pack: read [CONTRIBUTING.md](CONTRIBUTING.md).** Making one: the pack template's step-by-step guide,
[SUBMITTING.md](https://github.com/quincarter/marvel-champions-mod-template/blob/main/SUBMITTING.md). Reviewing one:
[REVIEWING.md](REVIEWING.md). AI assistants: [AGENTS.md](AGENTS.md).

In short:

1. **Make the pack** in your own repo, made from the
   [pack template](https://github.com/quincarter/marvel-champions-mod-template) ("Use this template"). Its CI
   validates the pack and plays headless smoke games with it; on a `v<version>` tag it attaches the pack's zip to a
   release.
2. **Record permission** in the pack's `pack.json`: the creator granted the store permission to distribute it, with
   the evidence. If you didn't make the pack, you need its creator's permission; a post or message where they grant
   it is enough. Packs without permission evidence are never approved.
3. **Open a pull request** here that adds `packs/<pack-id>.yaml`:

   ```yaml
   id: fan-example-hero # the pack's id from its pack.json
   repo: https://github.com/<you>/<pack-repo>
   tag: v1.0.0
   commit: <the full commit sha that tag points at>
   creator: <the pack's creator>
   permission:
     by: <who granted permission: the creator, or who granted it for them>
     evidence: <a link to where permission was given>
     date: YYYY-MM-DD
   tags: [hero]
   summary: One line for the store list. # optional; defaults to the first line of the pack's description
   ```

4. **CI checks it.** It builds the pack from `commit`, validates it with `mc-pack validate --publish` (which also
   requires `pack.json` to record the creator's grant), plays the smoke games, requires the release's zip to match
   its build byte for byte, and writes the pack's size, the engine features it uses and the oldest game version that
   can load it on the run's Summary page.
5. **Review.** The maintainer checks the permission evidence, reads the cards and plays the pack. Merging the pull
   request approves it, and the publish workflow uploads it to the store.

To **update** a pack, open a pull request that changes `tag` and `commit`. Published versions are immutable, and
older ones stay available, so games saved with them still load.

To **withdraw** a pack, open a pull request that deletes its file. Players who already installed it keep their copy,
but the store stops offering it.

**Not supported yet: packs that need other packs.** A pack whose `pack.json` lists other packs in `requires.packs`
(for example a campaign that uses another pack's scenario) can't be submitted yet: the registry's build has no way to
resolve another approved pack's content, so the check refuses such a pack before building it. Make the pack stand
alone for now, or ask in the custom content discussion.

## Packs kept in this repo (not available yet)

**Not usable yet.** A pack kept here builds with an SDK version pinned by this repo's root `package.json` and
`package-lock.json`, and those arrive once the pack SDK is published on npm. Until then the check refuses a `path`
entry with a message saying so; keep every pack in its own repo made from the template. The rest of this section
describes how they will work.

Some packs will be curated here rather than in a creator's own repo: community packs the maintainer brought in with
their authors' permission. Their source is a folder in this repo, `packs/<pack-id>/` (the same layout as the pack
template: `pack.json`, `cards/`, `abilities/index.ts`, `decks/`, the pictures, `CREDITS.md`, `PERMISSION.md`), and
their entry gives `path` instead of `repo`, `tag` and `commit`:

```yaml
id: carnage-nep
path: packs/carnage-nep
creator: Neptune
permission:
  by: Neptune
  evidence: <a link, or where the message is kept>
  date: 2026-11-05
tags: [hero]
```

They build with this repo's own SDK version (the root `package.json` and `package-lock.json`), so bumping the SDK
there rebuilds and re-checks every pack kept here. A change to a pack's folder is checked and, once merged,
published like any other entry: bump the pack's `version` in its `pack.json`, since published versions are
immutable. A folder with a `DRAFT` file in it is not built or published; leave its entry out until it is ready.

## What a pack can and can't do

Packs are data: card records, abilities written with the game's ability DSL, scenarios, decks and images. A pack
never ships code. A card that needs a rule the game's engine doesn't have yet can't be approved until a game release
adds it. Ask in the game's
[custom content discussion](https://github.com/quincarter/marvel-champions-digital-game/issues/488) first.

The full design is in
[docs/custom-content-packs.md](https://github.com/quincarter/marvel-champions-digital-game/blob/feature/custom-content-packs/docs/custom-content-packs.md)
§11 in the game's repo.

## Maintainer setup

- `check.yml` runs on every pull request. It rebuilds the pack from `commit` with no secrets (a submission's pack
  code runs in that job) and puts its summary on the run's page. A repo entry's tagged release must carry the zip
  `mc-pack build` wrote, byte for byte: a missing or different zip fails the check. The read-only GitHub token only
  reaches the step that downloads that zip, never the step that runs pack code. Its last job, **All checks**, is the
  one the branch ruleset requires.
- `publish.yml` runs on a merge to `main`. A job without secrets builds the changed packs. A second job, in the
  `store` environment, uploads each version to R2 under `<id>/<version>/` (the zip, `pack.json`, and the
  `preview.json`, `thumb.webp` and card pictures the store shows before an install), makes a release here as the
  fallback download, and regenerates `index.json`. Published versions are immutable: a version already in the bucket
  with a different zip fails the run, while one with the same zip is skipped, so a failed run can simply be re-run. A
  push that only deletes entries still updates `index.json`.
- A pack id is published either here or by the game repo's own publish, never both. Entries this repo publishes carry
  `source: "registry"` in `index.json`; an id already listed by the game repo is refused before anything is uploaded,
  and deleting a `packs/<id>.yaml` only withdraws this repo's own entries.
- Before the first publish, set these on this repo:
  - Actions secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`;
  - Actions variable `PACKS_BASE_URL`, for example `https://packs.<domain>`;
  - optionally, the variable `R2_BUCKET`, which defaults to `mc-packs`.

## Repository settings

Merging to `main` approves a pack and publishes it, so `main` takes changes only through a reviewed pull request.
These are repository settings, not files, and have to be set by the owner:

- **Branch ruleset on `main`** (Settings > Rules > Rulesets), active, with no bypass list:
  - require a pull request before merging, with review from Code Owners ([`.github/CODEOWNERS`](.github/CODEOWNERS))
    and stale approvals dismissed on a new push;
  - require the status check **All checks** (`check.yml`), with the branch up to date;
  - block force pushes and deletion.
- **`store` environment** (Settings > Environments), which holds the R2 secrets: deployment branches limited to
  `main`, so no other branch's workflow can reach them.
