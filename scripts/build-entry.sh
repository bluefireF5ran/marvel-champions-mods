#!/usr/bin/env bash
# Builds one registry entry's pack from source, the way the check and publish workflows both do.
#
#   scripts/build-entry.sh packs/<pack-id>.yaml <work dir>
#
# An entry names its source one of two ways:
#   - `repo`, `tag` and `commit`: the pack lives in its creator's own repo (made from the pack template);
#   - `path: packs/<pack-id>`: the pack's source is kept in this repo (packs curated here). It builds with this repo's
#     own SDK version (the root package.json and package-lock.json).
#
# Writes <work dir>/entry.json (the entry as JSON), <work dir>/src (the pack's source), <work dir>/out (the built
# pack.json and zip) and <work dir>/summary.md (what the check comments on the pull request). Fails if the entry is
# malformed, a repo entry's tag doesn't point at `commit`, the pack fails `mc-pack validate` or `mc-pack test`, or a
# repo entry's built zip differs from the zip on the pack's own release.
set -euo pipefail

entry_file="$1"
work="$2"
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$work"
yq -o=json '.' "$entry_file" > "$work/entry.json"

field() { jq -er "$1" "$work/entry.json"; }
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
  [[ -f "$root/$path/pack.json" ]] || { echo "::error file=$entry_file::$path/pack.json is missing"; exit 1; }
  [[ ! -e "$root/$path/DRAFT" ]] || { echo "::error file=$entry_file::$path has a DRAFT file: it is not ready to publish"; exit 1; }
  rm -rf "$work/src"
  cp -r "$root/$path" "$work/src"
  cp "$root/package.json" "$root/package-lock.json" "$work/src/"
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

# The pack (or this repo, for packs kept here) pins its SDK version in its lockfile; install with scripts off so a
# pack can't run code here.
(cd "$work/src" && npm ci --ignore-scripts --no-audit --no-fund)
(cd "$work/src" && npx --no-install mc-pack validate .)
(cd "$work/src" && npx --no-install mc-pack test .)
(cd "$work/src" && npx --no-install mc-pack build . --out "$work/out")

version=$(jq -er '.version' "$work/out/pack.json")
zip="$work/out/$id-$version.zip"
sha=$(sha256sum "$zip" | awk '{print $1}')

if [[ -n "$path" ]]; then
  release_note="built here"
else
  # The creator's own release must carry the same bytes, so what players get is what the creator published.
  owner_repo="${repo#https://github.com/}"
  mkdir -p "$work/release"
  if gh release download "$tag" --repo "$owner_repo" --pattern "$id-$version.zip" --dir "$work/release" 2>/dev/null; then
    release_sha=$(sha256sum "$work/release/$id-$version.zip" | awk '{print $1}')
    [[ "$release_sha" == "$sha" ]] || { echo "::error file=$entry_file::the release's zip ($release_sha) differs from the rebuilt one ($sha)"; exit 1; }
    release_note="matches the release's zip"
  else
    release_note="no zip on the release to compare"
  fi
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
