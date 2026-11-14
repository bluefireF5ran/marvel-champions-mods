#!/usr/bin/env bash
# Builds one registry entry's pack from source, the way the check and publish workflows both do.
#
#   scripts/build-entry.sh packs/<pack-id>.yaml <work dir>
#
# An entry names its source one of two ways:
#   - `repo`, `tag` and `commit`: the pack lives in its creator's own repo (made from the pack template);
#   - `path: packs/<pack-id>`: the pack's source is kept in this repo (packs curated here). It builds with this repo's
#     own SDK version (the root package.json and package-lock.json). Not usable yet: those files arrive once the SDK
#     is published on npm, and until then a `path` entry fails here with a message saying so.
#
# Not supported yet: a pack whose pack.json `requires.packs` names other packs. `mc-pack` has no way to resolve another
# approved pack's content in this build yet, so such a pack fails early, before any of its code runs.
#
# The validate step is `mc-pack validate --publish`, which also requires pack.json's permission to record the
# creator's grant; a pack with a DRAFT file is refused before that (--publish would skip the permission for it).
#
# SOURCE_ROOT, when set, is where a `path` entry's folder and the root package.json / package-lock.json are read from
# (the check workflow hands them over as data from the pull request); it defaults to this repo's checkout.
# scripts/build-entry-sdk.test.mjs uses it to run this script, unchanged, on a fixture pack with a real SDK tarball.
#
# Writes <work dir>/entry.json (the entry as JSON), <work dir>/src (the pack's source), <work dir>/out (what
# `mc-pack build --out` writes: pack.json, the zip, preview.json, thumb.webp, the data files and card pictures) and
# <work dir>/summary.md (what the check comments on the pull request). Fails if the entry is malformed, a repo entry's
# tag doesn't point at `commit`, the pack fails `mc-pack validate` or `mc-pack test`, or a repo entry's built zip is
# missing from, or differs from the zip on, the pack's own release.
#
# This script runs pack code (npm ci, mc-pack) and must run without a GitHub token: a repo entry's release zip is
# fetched beforehand, in its own step, by scripts/fetch-release.sh into <work dir>/release/.
set -euo pipefail

entry_file="$1"
work="$2"
root="$(cd "$(dirname "$0")/.." && pwd)"
source_root="${SOURCE_ROOT:-$root}"
mkdir -p "$work"
yq -o=json '.' "$entry_file" > "$work/entry.json"

field() { jq -er "$1" "$work/entry.json" || { echo "::error file=$entry_file::$1 is missing" >&2; exit 1; }; }
id=$(field '.id')
field '.creator' > /dev/null
field '.permission.by' > /dev/null
field '.permission.evidence' > /dev/null
field '.permission.date' > /dev/null

[[ "$(basename "$entry_file" .yaml)" == "$id" ]] || { echo "::error file=$entry_file::the file name must be <id>.yaml"; exit 1; }
[[ "$id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "::error file=$entry_file::id must be lowercase letters, digits and single dashes"; exit 1; }

path=$(jq -r '.path // empty' "$work/entry.json")
if [[ -n "$path" ]]; then
  # A pack kept in this repo.
  [[ "$path" == "packs/$id" ]] || { echo "::error file=$entry_file::path must be packs/$id"; exit 1; }
  [[ -z "$(jq -r '.repo // .tag // .commit // empty' "$work/entry.json")" ]] \
    || { echo "::error file=$entry_file::give either path or repo/tag/commit, not both"; exit 1; }
  [[ -f "$source_root/$path/pack.json" ]] || { echo "::error file=$entry_file::$path/pack.json is missing"; exit 1; }
  if [[ ! -f "$source_root/package.json" || ! -f "$source_root/package-lock.json" ]]; then
    echo "::error file=$entry_file::path entries are not supported yet: they build with this repo's root package.json" \
      "and package-lock.json pinning the pack SDK, which arrive once the SDK is published on npm. Until then, keep" \
      "the pack in its own repo made from the pack template and give repo, tag and commit instead."
    exit 1
  fi
  rm -rf "$work/src"
  cp -r "$source_root/$path" "$work/src"
  cp "$source_root/package.json" "$source_root/package-lock.json" "$work/src/"
  source_note="kept in this repo at \`$path\`"
else
  repo=$(field '.repo')
  tag=$(field '.tag')
  commit=$(field '.commit')
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "::error file=$entry_file::commit must be a full 40-character sha"; exit 1; }
  [[ "$repo" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "::error file=$entry_file::repo must be a https://github.com/<owner>/<repo> address"; exit 1; }

  # The tag must point at `commit` (an annotated tag's ^{} line wins).
  tag_sha=$(git ls-remote "$repo" "refs/tags/$tag" "refs/tags/$tag^{}" | awk '{print $1}' | tail -n 1)
  [[ "$tag_sha" == "$commit" ]] || { echo "::error file=$entry_file::tag $tag points at ${tag_sha:-nothing}, not $commit"; exit 1; }

  git init -q "$work/src"
  git -C "$work/src" fetch -q --depth 1 "$repo" "$commit"
  git -C "$work/src" checkout -q FETCH_HEAD
  source_note="$repo at \`$tag\`"
fi

pack_id=$(jq -er '.id' "$work/src/pack.json")
[[ "$pack_id" == "$id" ]] || { echo "::error file=$entry_file::pack.json's id is $pack_id, not $id"; exit 1; }
[[ ! -e "$work/src/DRAFT" ]] || { echo "::error file=$entry_file::the pack has a DRAFT file: it is not ready to publish"; exit 1; }
# Checked before any pack code runs (and again on the built pack.json below).
required=$(jq -r '(.requires.packs // []) | join(", ")' "$work/src/pack.json")
if [[ -n "$required" ]]; then
  echo "::error file=$entry_file::pack.json requires other packs ($required): packs that use another pack's content" \
    "can't be submitted to the registry yet (the build can't resolve another approved pack's content). Make the pack" \
    "stand alone, or ask in the custom content discussion."
  exit 1
fi

# The pack (or this repo, for packs kept here) pins its SDK version in its lockfile; install with scripts off so a
# pack can't run code here.
(cd "$work/src" && npm ci --ignore-scripts --no-audit --no-fund)
(cd "$work/src" && npx --no-install mc-pack validate . --publish)
(cd "$work/src" && npx --no-install mc-pack test .)
(cd "$work/src" && npx --no-install mc-pack build . --out "$work/out")

version=$(jq -er '.version' "$work/out/pack.json")
[[ "$(jq -r '(.requires.packs // []) | length' "$work/out/pack.json")" == "0" ]] \
  || { echo "::error file=$entry_file::the built pack.json requires other packs: not supported in the registry yet"; exit 1; }
zip="$work/out/$id-$version.zip"
sha=$(sha256sum "$zip" | awk '{print $1}')

if [[ -n "$path" ]]; then
  release_note="built here"
else
  # The creator's own release must carry the same bytes, so what players get is what the creator published
  # (scripts/fetch-release.sh downloaded it; a missing zip fails here too).
  if ! problem=$(node "$root/scripts/compare-release-zip.mjs" "$zip" "$work/release/$id-$version.zip" 2>&1); then
    echo "::error file=$entry_file::$problem"
    exit 1
  fi
  release_note="matches the release's zip"
fi

{
  echo "### \`$id\` $version"
  echo
  echo "- Source: $source_note"
  echo "- Size: $(stat -c %s "$zip") bytes (zip), sha256 \`$sha\` ($release_note)"
  echo "- Needs app: \`$(jq -r '.requires.app' "$work/out/pack.json")\`"
  echo "- Needs packs: $(jq -r '.requires.packs | if length == 0 then "none" else join(", ") end' "$work/out/pack.json")"
  echo "- Cards: $(jq -r '.files | map(select(.path | startswith("cards/"))) | length' "$work/out/pack.json") card images"
  echo "- Permission: $(jq -r '.permission.by + ", " + .permission.date + " (" + .permission.evidence + ")"' "$work/entry.json")"
  echo
  echo "<details><summary>Engine features used</summary>"
  echo
  jq -r '.requires.dslFeatures[] | "- `" + . + "`"' "$work/out/pack.json"
  echo
  echo "</details>"
} > "$work/summary.md"
echo "$sha" > "$work/zip.sha256"
echo "$version" > "$work/version"
