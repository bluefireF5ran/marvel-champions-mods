#!/usr/bin/env bash
# Lists the registry entries (packs/<id>.yaml) a change touches, one per line:
#
#   scripts/changed-entries.sh <base ref>
#
# An entry is touched when its .yaml is added or changed, when a file of a pack kept in this repo (packs/<id>/...)
# changes, or, for every pack kept here, when the repo's own SDK version (package.json, package-lock.json) changes.
# Deleted entries are not listed (a deletion withdraws the pack; the publish workflow handles that from the ids).
#
# Only publish.yml uses this, on a push to main (merged, reviewed code). The pull request check never runs it: a
# pull request could change it to list nothing, so check.yml lists a pull request's entries with scripts/pr-gate.mjs
# from the base branch, through the GitHub API.
set -euo pipefail
base="$1"
changed=$(git diff --name-only "$base" HEAD)
{
  echo "$changed" | grep -E '^packs/[^/]+\.yaml$' || true
  echo "$changed" | sed -nE 's#^packs/([^/]+)/.*#packs/\1.yaml#p'
  if echo "$changed" | grep -qE '^package(-lock)?\.json$'; then
    for file in packs/*.yaml; do
      if [[ -e "$file" ]] && grep -qE '^path:' "$file"; then echo "$file"; fi
    done
  fi
# `if`, not `&&`: a last test that fails (no entries at all, or a draft folder with no entry) must not end the script
# with status 1, which fails the publish under pipefail.
} | sort -u | while read -r file; do if [[ -f "$file" ]]; then echo "$file"; fi; done
