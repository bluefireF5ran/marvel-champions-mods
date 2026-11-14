<!--
A pack submission, update or withdrawal. One pack per pull request, and change nothing but packs/<id>.yaml.
Guide: CONTRIBUTING.md. Making the pack: https://github.com/quincarter/marvel-champions-mod-template/blob/main/SUBMITTING.md
-->

## Pack

- This is: a new pack / an update / a withdrawal
- Pack id:
- Pack repo and tag:
- Kind and what it adds (for example: hero, Spider-Ham with a Justice precon):
- Languages it ships (`languages.available` in its `pack.json`):
- For an update: what changed since the last version:
- For a withdrawal: why:

## Permission

Packs without permission evidence are never approved.

- Who made the pack:
- Who granted permission for the Mod Store to distribute it:
- Where it was given (a link, or where the message is kept):
- Scope, and the languages it covers:

## Checklist

The registry's check repeats the first six; tick them once you have checked them yourself.

- [ ] The file is `packs/<id>.yaml`, and `id` is the `id` in the pack's `pack.json`.
- [ ] `commit` is the full 40-character sha the tag points at (`git rev-parse <tag>^{commit}`).
- [ ] The tag's GitHub release carries `<id>-<version>.zip`, attached by the template's CI (not uploaded by hand).
- [ ] The pack repo's CI (validate, typecheck, test) is green at that tag.
- [ ] `version` in `pack.json` has never been published before (an update bumps it).
- [ ] `pack.json`'s `permission` is `granted`, and its `languages` cover every language the pack ships
      (`npx mc-pack validate . --publish`, or the template's submit script, passes).
- [ ] `permission` in this file matches `pack.json`'s (`by`, `evidence`, `date`).
- [ ] `CREDITS.md` names the pack's creator, the card template and the art's sources, and any translators.
- [ ] Every ability is scripted from its card's text; no card needs an engine feature the game doesn't have yet.
- [ ] I have read the cards against their scripts and played at least one game with the pack.
