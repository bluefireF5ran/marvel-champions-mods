# Spider-Punisher (`spider-punisher-tw`)

A fan-made hero pack by T-Wrecks (Hitch templates): Spider-Punisher / Peter Parker of Earth-71928, 15 hero cards around
his Web-Shooter rounds (Armor-Piercing, EMP, High Explosive, Incendiary), the Punisher No More obligation and a 4-card
nemesis set (Green Goblin, The Goblin's Ultimatum, Reorganized Crime x2, Revealed Identity). See `CREDITS.md` and
`PERMISSION.md`. Store shelf: Sinister Motives (`wave: cycle5`). Starter deck: Leadership, 42 cards.

**Draft** (the `DRAFT` file) until the game adds three engine features; the list is in `DRAFT` and at the top of
`abilities/index.ts`.

## How it was made

`mc-pack import-marvelcdb spider_punisher_tw --out packs/spider-punisher-tw --id spider-punisher-tw` from the curated
source (https://github.com/bluefireF5ran/mc-digital-custom-packs, commit `c131319`), then by hand: `abilities/index.ts`
(each ability commented with the base card it copies), the starter deck, the cover and `pack.json`'s store fields.

The starter deck swaps the list's Spider-Man (Peter Parker, 27049) for Spider-Man (Miles Morales, 13019): Peter Parker
is Spider-Punisher's own alter-ego, and a deck cannot include a unique card that matches its identity.
