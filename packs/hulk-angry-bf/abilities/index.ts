/**
 * "Don't Make Me Angry!" (by Abis Mal & Bluefire, Hitch template): a house rule for the official Hulk (10001a), one
 * identity-specific card no deck must hold (`optionalForIdentity`; #890 item 13). "Permanent. Setup." is data: the game
 * sets it aside with the other Permanent cards and puts it into play at setup.
 *
 * The printed Response reads "After an identity-specific card is discarded by an ability, tuck that card under here
 * from your discard pile." A card discarded from a hand or a deck by an ability is announced only as it is about to be
 * discarded (`cardBeingDiscarded`, an interrupt event; the engine has no "after" event for it), so the ability is an
 * interrupt that tucks the card here instead of discarding it: the card ends in the same place, and only a card
 * discarded by an ability is heard (a cost and the game's own discard down to hand size are not, as the designers meant).
 */
import {
  cards,
  constant,
  definePackAbilities,
  eventTarget,
  instead,
  interrupt,
  on,
  playableTucked,
  query,
  self,
  spendableFromTucked,
  tuckCards,
  you,
} from "@mc/mod-sdk";

/** One of your identity-specific cards (Hulk's, in a Hulk deck), wherever it is discarded from. */
const YOUR_IDENTITY_SPECIFIC = query([], { classification: "identitySpecific", controlledBy: you });

export default definePackAbilities({
  // "Tucked cards here may be played and spent as if they were in your hand." Hawkeye's Quiver (`trors`) for the play,
  // Resource Reserve (`falcon` 53021) for the spending, here for every tucked card and you alone.
  "x.hulk-angry-bf.01.dont-make-me-angry-constant": constant(
    playableTucked(),
    spendableFromTucked({ cards: {}, by: you }),
  ),
  // "Response: After an identity-specific card is discarded by an ability, tuck that card under here from your discard
  // pile. (Limit twice per phase.)" A card's ability on either side discards it (see the header).
  "x.hulk-angry-bf.01.dont-make-me-angry-response": interrupt(
    on.either(
      on.cardYouControlDiscarded({ who: YOUR_IDENTITY_SPECIFIC, by: "playerCard" }),
      on.cardYouControlDiscarded({ who: YOUR_IDENTITY_SPECIFIC, by: "encounterCard" }),
    ),
    { limit: { count: 2, period: "phase" } },
    instead(tuckCards(cards(eventTarget), self)),
  ),
});
