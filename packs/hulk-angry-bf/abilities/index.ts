/**
 * "Don't Make Me Angry!" (by Abis Mal & Bluefire, Hitch template): a house rule for the official Hulk (10001a), one
 * identity-specific card no deck must hold (`optionalForIdentity`; #890 item 13). "Permanent. Setup." is data: the game
 * sets it aside with the other Permanent cards and puts it into play at setup.
 *
 * The printed Response: "After an identity-specific card is discarded by an ability, tuck that card under here from
 * your discard pile. (Limit twice per phase.)"
 * - **From the deck or from play** it is a real Response, after the discard (PR #57 review): the card is discarded, the
 *   discarding ability sees it as discarded (Abomination 10026's "if a [physical] resource was discarded this way"),
 *   then it is tucked from the discard pile. The deck event (`cardDiscardedFromDeck`) is recorded by every path off the
 *   top of a player's deck, "discard until" (Electro 27159) included.
 * - **From the hand** the engine announces the discard only before it happens (`cardBeingDiscarded`, an interrupt
 *   event; there is no "after" event for a hand discard yet), so that part is an interrupt that tucks the card instead
 *   of discarding it: the card ends in the same place. It has its own limit of twice per phase until the engine has an
 *   after-hand-discard event and both halves can be one ability. Hulk's hand discards (Enraged, Experimental Research)
 *   count nothing "discarded this way".
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
  response,
  self,
  spendableFromTucked,
  tuckCards,
  you,
} from "@mc/mod-sdk";

/** One of your identity-specific cards (Hulk's, in a Hulk deck). */
const YOUR_IDENTITY_SPECIFIC = query([], { classification: "identitySpecific", controlledBy: you });
const TWICE_PER_PHASE = { count: 2, period: "phase" } as const;

export default definePackAbilities({
  // "Tucked cards here may be played and spent as if they were in your hand." Hawkeye's Quiver (`trors`) for the play,
  // Resource Reserve (`falcon` 53021) for the spending, here for every tucked card and you alone.
  "x.hulk-angry-bf.01.dont-make-me-angry-constant": constant(
    playableTucked(),
    spendableFromTucked({ cards: {}, by: you }),
  ),
  // The Response, for a card discarded from your deck or from play by a card's ability (see the header).
  "x.hulk-angry-bf.01.dont-make-me-angry-response": response(
    on.either(
      { on: "cardDiscardedFromDeck", playerIs: "controller", targetIs: YOUR_IDENTITY_SPECIFIC },
      on.playerCardDiscardedFromPlay({ who: YOUR_IDENTITY_SPECIFIC, by: "playerCard" }),
      on.playerCardDiscardedFromPlay({ who: YOUR_IDENTITY_SPECIFIC, by: "encounterCard" }),
    ),
    { limit: TWICE_PER_PHASE },
    tuckCards(cards(eventTarget), self),
  ),
  // The same Response for a card discarded from your hand by a card's ability: tucked instead (see the header).
  "x.hulk-angry-bf.01.dont-make-me-angry-hand": interrupt(
    { on: "cardBeingDiscarded", targetIs: YOUR_IDENTITY_SPECIFIC, eventIs: { from: "hand" } },
    { limit: TWICE_PER_PHASE },
    instead(tuckCards(cards(eventTarget), self)),
  ),
});
