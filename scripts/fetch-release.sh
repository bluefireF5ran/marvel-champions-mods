#!/usr/bin/env bash
# Downloads the zips on a repo entry's own release, for scripts/build-entry.sh to compare with the rebuilt pack:
#
#   scripts/fetch-release.sh packs/<pack-id>.yaml <work dir>
#
# This is the only part of a build that uses a GitHub token (gh needs one, even for a public release). It runs in its
# own workflow step, which has GH_TOKEN and never installs or runs pack code; the step that runs build-entry.sh (npm
# ci, mc-pack) has no token. scripts/check-workflow-secrets.mjs fails if that changes.
#
# Writes <work dir>/release/<id>-*.zip. Fails when the release or a zip on it is missing: the store only lists a pack
# whose creator published the same bytes. A pack kept in this repo (`path:`) has no release, and nothing is fetched.
set -euo pipefail

entry_file="$1"
work="$2"

id=$(yq -r '.id // ""' "$entry_file")
[[ "$id" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "::error file=$entry_file::id must be lowercase letters, digits and single dashes"; exit 1; }
if [[ -n "$(yq -r '.path // ""' "$entry_file")" ]]; then
  echo "$id is kept in this repo: no release to fetch."
  exit 0
fi

repo=$(yq -r '.repo // ""' "$entry_file")
tag=$(yq -r '.tag // ""' "$entry_file")
[[ "$repo" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || { echo "::error file=$entry_file::repo must be a https://github.com/<owner>/<repo> address"; exit 1; }
[[ "$tag" =~ ^[A-Za-z0-9_.][A-Za-z0-9_./-]*$ ]] || { echo "::error file=$entry_file::tag is missing or not a plain tag name"; exit 1; }

rm -rf "$work/release"
mkdir -p "$work/release"
if ! gh release download "$tag" --repo "${repo#https://github.com/}" --pattern "$id-*.zip" --dir "$work/release"; then
  echo "::error file=$entry_file::could not download $id-<version>.zip from the $tag release of $repo: the release must carry the pack's zip"
  exit 1
fi
echo "Fetched from $repo $tag: $(ls "$work/release" | tr '\n' ' ')"
