# Mod store registry

This repo lists the community content packs approved for the mod store in the
[Marvel Champions digital game](https://github.com/quincarter/marvel-champions-digital-game). The game's **Extras ▸ Mod
Store** screen reads a catalog built from this repo, and only packs listed here appear in it.

This is a fan-made, non-commercial project. Marvel Champions, its card text, artwork and characters are the
intellectual property of Fantasy Flight Games and Marvel.

## How a pack gets into the store

1. **Make the pack.** Start from the
   [pack template](https://github.com/quincarter/marvel-champions-mod-template) ("Use this template"). Its CI
   validates the pack and plays headless smoke games with it. Tag a release (`v1.0.0`) once it passes.
2. **Get permission.** If you didn't make the pack yourself, you need its creator's permission for the store to
   distribute it. A post or message where they grant it is enough. Packs without permission are never approved.
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

4. **CI checks it.** It builds the pack from `commit`, validates it, plays the smoke games and comments the pack's
   size, the engine features it uses and the oldest game version that can load it.
5. **Review.** The maintainer reads the cards and plays the pack. Merging the pull request approves it, and the
   publish workflow uploads it to the store.

To **update** a pack, open a pull request that changes `tag` and `commit`. Older versions stay available, so games
saved with them still load.

To **withdraw** a pack, open a pull request that deletes its file. Players who already installed it keep their copy,
but the store stops offering it.

## Packs kept in this repo

Some packs are curated here rather than in a creator's own repo: community packs the maintainer brought in with
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

- `check.yml` runs on every submission pull request. It rebuilds the pack from `commit` with no secrets (a
  submission's pack code runs in that job) and puts its summary on the run's page.
- `publish.yml` runs on a merge to `main`. A job without secrets builds the changed packs. A second job, in the
  `store` environment, uploads them to R2, makes a release here as the fallback download, and regenerates
  `index.json`. Published versions are immutable: a version already in the bucket fails the run.
- Before the first publish, set these on this repo:
  - Actions secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`;
  - Actions variable `PACKS_BASE_URL`, for example `https://packs.<domain>`;
  - optionally, the variable `R2_BUCKET`, which defaults to `mc-packs`.
