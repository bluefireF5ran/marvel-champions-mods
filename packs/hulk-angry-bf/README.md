# Don't Make Me Angry! (`hulk-angry-bf`)

An optional house rule for the official Hulk (10001a) by Abis Mal and Bluefire: one card, "Don't Make Me Angry!"
(Permanent. Setup.). A Hulk deck uses the rule by listing the card (`optionalForIdentity`): it starts in play, and the
official precons and every other Hulk deck stay legal without it. Starter deck: Hulk's Lab Partners - Protection (40
cards plus the house-rule card). See `CREDITS.md` and `PERMISSION.md`.

Needs the game at 0.51.0 or later (`requires.app`): a house-rule pack that adds a card.

The Response ("After an identity-specific card is discarded by an ability, tuck that card under here from your
discard pile") is a real Response for cards discarded from the deck (Abomination, Electro's "discard until") or from
play: the discard happens and the discarding ability sees it, then the card is tucked. A card discarded from the hand
(Enraged, Experimental Research) is tucked instead of being discarded, with its own twice-per-phase limit, because the
game announces a hand discard only before it happens (see `abilities/index.ts`).
