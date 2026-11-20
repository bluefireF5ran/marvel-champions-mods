# Sentinel (`sentinel-tw`)

A fan-made hero pack by T-Wrecks (Hitch templates; a sealed product): Sentinel, four double-sided Component upgrades
(Head, Arms, Torso, Legs: Intact / Destroyed), 15 more hero cards, the Prime Directive obligation and a 5-card nemesis
set (Mark VII-A, Rogue Asset, Disabled, Viral Assault, Hostile Override). His Reboot (26024) and Size Advantage (62034)
are alternate art for those official cards. See `CREDITS.md` and `PERMISSION.md`. Store shelf: Mutant Genesis
(`wave: cycle6`). Starter deck: Justice, 44 cards (40 plus the four Components).

**Draft** (the `DRAFT` file) until the game adds the engine features listed there and at the top of
`abilities/index.ts`.

**Components.** They ship in the hero set (the importer takes only hero cards of the identity's set), so they are deck
cards: the alter-ego's Setup takes them from the deck and the opening hand and puts them into play, as Valkyrie's Setup
takes Death-Glow. In paper they start in play and never sit in the deck.

## How it was made

`mc-pack import-marvelcdb sentinel_tw --out packs/sentinel-tw --id sentinel-tw` from the curated source
(https://github.com/bluefireF5ran/mc-digital-custom-packs, commit `c131319`). For the import only, Juston Seyfert's
"Action: Attach to a side scheme." was read as "Attach this card to a side scheme." (the importer takes "Attach to" as an
attach rule, which a support cannot have); his card keeps the printed text. Then by hand: `abilities/index.ts` (each
ability commented with the base card it copies), the starter deck, the alternate art, the cover and `pack.json`'s store
fields.
