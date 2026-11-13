#!/usr/bin/env bash
# Lists the registry entries (packs/<id>.yaml) a change touches, one per line:
#
#   scripts/changed-entries.sh <base ref>
#
# An entry is touched when its .yaml is added or changed, when a file of a pack kept in this repo (packs/<id>/...)
# changes, or, for every pack kept here, when the repo's own SDK version (package.json, package-lock.json) changes.
# Deleted entries are not listed (a deletion withdraws the pack; the publish workflow handles that from the ids).
set -euo pipefail
base="$1"
changed=$(git diff --name-only "$base" HEAD)
{
  echo "$changed" | grep -E '^packs/[^/]+\.yaml$' || true
  echo "$changed" | sed -nE 's#^packs/([^/]+)/.*#packs/\1.yaml#p'
  if echo "$changed" | grep -qE '^package(-lock)?\.json$'; then
    for file in packs/*.yaml; do
      [[ -e "$file" ]] && grep -qE '^path:' "$file" && echo "$file"
    done
  fi
} | sort -u | while read -r file; do [[ -f "$file" ]] && echo "$file"; done
