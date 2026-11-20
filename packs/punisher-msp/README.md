# The Punisher (`punisher-msp`)

A fan-made hero pack by MissSugarPink (Hitch templates): The Punisher / Frank Castle, 15 hero cards (weapons fed by
all-purpose counters, Stash House, Microchip), five Permanent **Loadouts** (Warzone, High Slayer, Angel of Vengeance,
War Machine Armor, Avengers' Cache), the Haunting Memories obligation and a 5-card nemesis set (Captured, Jigsaw, Too
Ugly to Die, Jigsaw Goon x2). Not PermaKarma's Punisher scenario (`punisher-pk`). See `CREDITS.md` and `PERMISSION.md`.
Store shelf: Fear No Evil (`wave: cycle11`). Starter deck: Aggression, 45 cards (40 plus the five Loadouts).

**Draft** (the `DRAFT` file) until the game adds four engine features; the list is in `DRAFT` and at the top of
`abilities/index.ts`.

**Loadouts.** They ship in the hero set (the importer takes only hero cards of the identity's set), so they are deck
cards: Frank Castle's Setup takes them from the deck and the opening hand, as Valkyrie's Setup takes Death-Glow, puts
the chosen one into play and removes the rest from the game. In paper they are set aside before shuffling.

## How it was made

`mc-pack import-marvelcdb punisher_msp --out packs/punisher-msp --id punisher-msp` from the curated source
(https://github.com/bluefireF5ran/mc-digital-custom-packs, commit `c131319`), with the Loadouts' set code changed to the
hero set for the import, then by hand: `abilities/index.ts` (each ability commented with the base card it copies), the
starter deck, the cover and `pack.json`'s store fields.
