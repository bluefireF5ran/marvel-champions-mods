/**
 * Sentinel (by T-Wrecks, Hitch templates; a sealed product): every ability of the pack, each modeled on the base-game
 * card named in its comment. The pack's own printed text and its two inserts (Destroy, Expose) are the authority
 * (docs/custom-content-packs.md section 6), then the RRG (v1.8) and FFG rulings for what the text does not override.
 *
 * Ability ids are `<card code>.<slug>`, as the importer wrote them. The four Components (02a-05a) are double-sided
 * Permanent upgrades, Intact (a) / Destroyed (b), with a printed dash cost: they enter play only from the alter-ego's
 * Setup.
 *
 * **Destroy** (insert): "When you are instructed to destroy a Component upgrade, take 2 unpreventable damage and flip that
 * Component from its Intact side to its Destroyed side. A Component that is already on its Destroyed side cannot be
 * destroyed." As an effect it is `destroy()` below. Rulings settled with the user (2026-11-19): an exhausted Intact
 * Component can still be destroyed; Exterminate may exhaust one Component and destroy the other; Ablative Protocol is a
 * destroy (his TTS wording "destroy a COMPONENT upgrade instead").
 *
 * **Expose** (insert): an Exposed status card on an enemy adds damage to one instance of damage it takes (a tough status
 * card blocks the whole boosted instance unless the attack has piercing). "Expose 2 enemies": 1 Exposed on each of up to
 * 2 enemies (T-Wrecks, 2026-11).
 *
 * Since SDK 0.51.0 (#890 items 10-12):
 * - **Exposed** is carried as `exposed` counters on enemies. The insert's rule ("When a character with one or more
 *   Exposed status cards is attacked, discard all Exposed status cards from that character. That attack deals 1
 *   additional damage for each Exposed status card discarded this way") lives on Sentinel's identity, both faces, so it
 *   holds while Sentinel is in play: `attacksDealAdditionalDamage(…, { perCounterOnTarget: "exposed" })` and a forced
 *   response that removes them after the attack.
 * - **Destroy as a cost**: "exhaust or destroy [Component]" is `eitherCost(exhaust, [flip, 2 unpreventable damage])`
 *   in `additionalCostToPlay`; Exterminate's two Components are four branches (each exhausted or destroyed).
 * - **Juston Seyfert** attaches to a side scheme and stays under your control; he comes back with
 *   `staysWhenHostLeaves: "defeated"`.
 * - 01a Ablative Protocol's cost is the destroy itself ("flip 1 Component … → take 2 unpreventable damage instead"):
 *   scripted as an interrupt that flips a Component and replaces the damage, which is the same result.
 */
import {
  allOf,
  setAside,
  action,
  addCounters,
  attachCard,
  attacksDealAdditionalDamage,
  countersOn,
  divide,
  eitherCost,
  eventTarget,
  flipCardsCost,
  forcedInterrupt,
  host,
  min,
  removeCountersFrom,
  removeThreat,
  setVar,
  sum,
  takeDamageCost,
  varOf,
  additionalCostToPlay,
  alterEgoAction,
  anAttackableEnemy,
  anyOf,
  attack,
  boost,
  cards,
  chooseCards,
  chooseOne,
  chooseTarget,
  chosen,
  confuse,
  constant,
  costModifier,
  countOf,
  dealDamage,
  definePackAbilities,
  discard,
  discardFromHandCost,
  discardThis,
  each,
  exhaust,
  exhaustCardsCost,
  exhaustThis,
  exists,
  findCard,
  flipCard,
  forcedAction,
  forcedResponse,
  forEachCard,
  FRIENDLY_CHARACTER,
  gainsTrait,
  gets,
  giveTough,
  heal,
  heroAction,
  heroInterrupt,
  ifThen,
  instead,
  moveCards,
  not,
  on,
  oncePerRound,
  option,
  placeThreat,
  putIntoPlay,
  query,
  ready,
  reduceNextCardCost,
  refCount,
  self,
  setup,
  shuffleDeck,
  statOf,
  stun,
  surge,
  theMainScheme,
  valueAtLeast,
  when,
  whenRevealed,
  you,
  YOUR_IDENTITY,
  yourIdentity,
  zone,
} from "@mc/mod-sdk";

type Trait = NonNullable<Parameters<typeof gainsTrait>[0]>;
const trait = (name: string): Trait => name.toUpperCase() as Trait;
const COMPONENT = trait("Component");
const INTACT = trait("Intact");
const DESTROYED = trait("Destroyed");
const TECH = trait("Tech");
const HACKED = trait("Hacked");
const MUTANT = trait("Mutant");
const THWART = trait("Thwart");
const ATTACK = trait("Attack");

const YOUR_COMPONENTS = query("upgrade", { trait: COMPONENT, controller: "you" });
const YOUR_INTACT_COMPONENTS = query("upgrade", { trait: COMPONENT, controller: "you", anyTrait: [INTACT] });
const YOUR_DESTROYED_COMPONENTS = query("upgrade", { trait: COMPONENT, controller: "you", anyTrait: [DESTROYED] });
const yourIntact = (name: string) => query("upgrade", { name, controller: "you" });
const YOUR_HACKED_UPGRADES = query("upgrade", { trait: HACKED, controller: "you" });
const YOUR_READY_INTACT_COMPONENTS = query("upgrade", {
  trait: COMPONENT,
  controller: "you",
  anyTrait: [INTACT],
  exhausted: false,
});
const YOUR_READY_IDENTITY = query("identity", { controller: "you", exhausted: false });
const ROGUE_ASSET = query("sideScheme", { name: "Rogue Asset" });

const EXPOSED = "exposed";
const ENEMY = query("enemy");
const EXPOSED_ENEMY = query("enemy", { hasCounter: EXPOSED });
const ARMS_INTACT = yourIntact("Arms (Intact)");
const OTHER_INTACT_COMPONENT = query("upgrade", {
  trait: COMPONENT,
  controller: "you",
  anyTrait: [INTACT],
  not: { name: "Arms (Intact)" },
});
const armsPick = (slot: string) => ({ slot, query: ARMS_INTACT, min: 1, max: 1 });
const otherPick = (slot: string) => ({ slot, query: OTHER_INTACT_COMPONENT, min: 1, max: 1 });

/** "Expose N enemies": 1 Exposed status card (an `exposed` counter) on each of up to N different enemies. */
const expose = (n: number) => [
  chooseTarget("exposedEnemies", ENEMY, { count: n, upTo: true }),
  addCounters(EXPOSED, 1, chosen("exposedEnemies")),
];
/** "The number of Exposed status cards in play", into the var `exposedInPlay`. */
const countExposedInPlay = () => [
  setVar("exposedInPlay", 0),
  forEachCard(
    "exposedEnemy",
    each(EXPOSED_ENEMY),
    setVar("exposedInPlay", sum(varOf("exposedInPlay"), countersOn(chosen("exposedEnemy"), EXPOSED))),
  ),
];
/** "Exhaust [Component] or destroy it (see insert)": exhaust it, or flip it and take 2 unpreventable damage. */
const exhaustOrDestroy = (component: ReturnType<typeof query>) =>
  eitherCost(exhaustCardsCost(component), [flipCardsCost(component), takeDamageCost(2, { unpreventable: true })]);

/**
 * Destroy (insert): take 2 unpreventable damage and flip the Component to its Destroyed side. The flip goes first, so
 * an interrupt to that damage (Ablative Protocol again) sees the Component already destroyed and cannot loop on it.
 */
const destroy = (component: Parameters<typeof flipCard>[0]) => [
  flipCard(component),
  dealDamage(2, yourIdentity, { unpreventable: true }),
];

/**
 * "Search the encounter deck and discard pile for the Rogue Asset side scheme and put it into play." Mandatory: a Find
 * (`findCard`, Protect Humanity 59004's shape) takes it wherever it is and shuffles each deck it looked through (RRG 1.8
 * "Search", p. 39); with no Rogue Asset to find, nothing happens.
 */
const rogueAssetIntoPlay = () => [findCard(ROGUE_ASSET, "play")];

export default definePackAbilities({
  // =========================================================================
  // 01a Sentinel (hero) / 01b Sentinel (alter-ego)
  // =========================================================================

  // Ablative Protocol: "Interrupt: When you would take any amount of damage, flip 1 Component upgrade (Intact side) to
  // its Destroyed side → take 2 unpreventable damage instead." The destroy replaces the damage (see the header).
  "x.sentinel-tw.01a.ablative-protocol": heroInterrupt(
    when.damage(YOUR_IDENTITY),
    { while: exists(YOUR_INTACT_COMPONENTS) },
    chooseTarget("component", YOUR_INTACT_COMPONENTS),
    instead(...destroy(chosen("component"))),
  ),
  // Expose (insert), on both faces: "That attack deals 1 additional damage for each Exposed status card discarded this
  // way" (part of the one instance, T-Wrecks 2026-11-11), then "discard all Exposed status cards from that character".
  "x.sentinel-tw.01a.expose-constant": constant(
    attacksDealAdditionalDamage(1, { target: ENEMY, perCounterOnTarget: EXPOSED }),
  ),
  "x.sentinel-tw.01a.expose-forced-response": forcedResponse(
    { on: "characterAttacked", targetIs: EXPOSED_ENEMY },
    removeCountersFrom(eventTarget, EXPOSED, countersOn(eventTarget, EXPOSED)),
  ),
  "x.sentinel-tw.01b.expose-constant": constant(
    attacksDealAdditionalDamage(1, { target: ENEMY, perCounterOnTarget: EXPOSED }),
  ),
  "x.sentinel-tw.01b.expose-forced-response": forcedResponse(
    { on: "characterAttacked", targetIs: EXPOSED_ENEMY },
    removeCountersFrom(eventTarget, EXPOSED, countersOn(eventTarget, EXPOSED)),
  ),
  // "Setup: Put each Component upgrade (Intact side up) into play." The game sets each Permanent card aside before setup
  // (#890 item 16), so the Components are taken from there.
  "x.sentinel-tw.01b.setup": setup(
    chooseCards("components", setAside(you, query("upgrade", { trait: COMPONENT })), { min: 4, max: 4 }),
    forEachCard("component", chosen("components"), putIntoPlay(chosen("component"), you)),
  ),
  // "Action: Search your deck and discard pile for Juston Seyfert and add him to your hand. (Limit once per round.)"
  "x.sentinel-tw.01b.sentinel-action": alterEgoAction(
    { limit: oncePerRound },
    chooseCards("juston", zone(["deck", "discard"], you, { filter: query("support", { name: "Juston Seyfert" }) }), {
      min: 1,
      max: 1,
    }),
    moveCards(cards(chosen("juston")), "hand"),
    shuffleDeck(),
  ),
  // "Action: Discard 1 card from your hand → flip each Component (Destroyed side) upgrade to its Intact side."
  "x.sentinel-tw.01b.sentinel-action-2": alterEgoAction(
    { cost: discardFromHandCost(1) },
    forEachCard("component", each(YOUR_DESTROYED_COMPONENTS), flipCard(chosen("component"))),
  ),

  // =========================================================================
  // 02-05 Components (Permanent is data)
  // =========================================================================

  // Head (Intact): "Hero Action: Exhaust Head (Intact) → expose 2 enemies."
  "x.sentinel-tw.02a.head-intact-action": heroAction({ cost: exhaustThis, while: exists(ENEMY) }, ...expose(2)),
  // Head (Destroyed): "Your Thwart events cost 1 additional resource to play."
  "x.sentinel-tw.02b.head-destroyed-constant": constant(
    costModifier({ delta: 1, appliesTo: { controller: "you", categories: ["event"], trait: THWART } }),
  ),
  // Arms (Intact): "Hero Action (attack): Exhaust Arms (Intact) → deal 1 damage to an enemy."
  "x.sentinel-tw.03a.arms-intact-action": heroAction(
    { label: "attack", cost: exhaustThis },
    anAttackableEnemy("enemy"),
    attack(1, chosen("enemy")),
  ),
  // Arms (Destroyed): "Your Attack events cost 1 additional resource to play."
  "x.sentinel-tw.03b.arms-destroyed-constant": constant(
    costModifier({ delta: 1, appliesTo: { controller: "you", categories: ["event"], trait: ATTACK } }),
  ),
  // Torso (Intact): "Hero Action: Exhaust Torso (Intact) → heal 1 damage from Sentinel."
  "x.sentinel-tw.04a.torso-intact-action": heroAction({ cost: exhaustThis }, heal(1, yourIdentity)),
  // Torso (Destroyed): "Your upgrades cost 1 additional resource to play."
  "x.sentinel-tw.04b.torso-destroyed-constant": constant(
    costModifier({ delta: 1, appliesTo: { controller: "you", categories: ["upgrade"] } }),
  ),
  // Legs (Intact): "Hero Action: Exhaust Legs (Intact) → reduce the cost of the next card you play by 1."
  "x.sentinel-tw.05a.legs-intact-action": heroAction({ cost: exhaustThis }, reduceNextCardCost(you, 1, "phase")),
  // Legs (Destroyed): "You get -1 hand size."
  "x.sentinel-tw.05b.legs-destroyed-constant": constant(gets("handSize", -1, YOUR_IDENTITY)),

  // =========================================================================
  // 06-09 Events
  // =========================================================================

  // Exterminate: "[star] As an additional cost to play this event, exhaust or destroy Arms (Intact) and any one other
  // Component upgrade (Intact side up)." Each one is exhausted or destroyed on its own (ruling 2026-11-19): four
  // branches; destroying both is 4 unpreventable damage.
  "x.sentinel-tw.06.exterminate-constant": additionalCostToPlay(
    eitherCost(
      { exhaustCards: [armsPick("exhausted"), otherPick("exhaustedOther")] },
      [
        exhaustCardsCost(ARMS_INTACT, { slot: "exhausted" }),
        flipCardsCost(OTHER_INTACT_COMPONENT, { slot: "flippedOther" }),
        takeDamageCost(2, { unpreventable: true }),
      ],
      [
        flipCardsCost(ARMS_INTACT, { slot: "flipped" }),
        exhaustCardsCost(OTHER_INTACT_COMPONENT, { slot: "exhaustedOther" }),
        takeDamageCost(2, { unpreventable: true }),
      ],
      [{ flipCards: [armsPick("flipped"), otherPick("flippedOther")] }, takeDamageCost(4, { unpreventable: true })],
    ),
  ),
  // "Hero Action (attack): Deal 7 damage to an enemy. This attack gains ranged, piercing, and overkill. Expose 2
  // enemies."
  "x.sentinel-tw.06.exterminate-action": heroAction(
    { label: "attack" },
    anAttackableEnemy("enemy"),
    attack(7, chosen("enemy"), { keywords: ["ranged", "piercing", "overkill"] }),
    ...expose(2),
  ),
  // Hardwire Access: "[star] As an additional cost to play this event, exhaust Head (Intact) or destroy it."
  "x.sentinel-tw.07.hardwire-access-constant": additionalCostToPlay(exhaustOrDestroy(yourIntact("Head (Intact)"))),
  // "Hero Action (thwart): Remove 3 threat from among schemes in play, plus X, where X is the number of Exposed status
  // cards in play (to a maximum of 6 threat)." Inconspicuous's division (`divide`).
  "x.sentinel-tw.07.hardwire-access-action": heroAction(
    { label: "thwart" },
    ...countExposedInPlay(),
    divide("threat", min(sum(3, varOf("exposedInPlay")), 6), query("scheme")),
  ),
  // Rocket Punch: "[star] As an additional cost to play this event, exhaust Arms (Intact) or destroy it."
  "x.sentinel-tw.08.rocket-punch-constant": additionalCostToPlay(exhaustOrDestroy(ARMS_INTACT)),

  // Rocket Punch: "Hero Action (attack): Deal 5 damage to an enemy. This attack gains overkill."
  "x.sentinel-tw.08.rocket-punch-action": heroAction(
    { label: "attack" },
    anAttackableEnemy("enemy"),
    attack(5, chosen("enemy"), { keywords: ["overkill"] }),
  ),
  // Threat Suppression: "[star] As an additional cost to play this event, exhaust Legs (Intact) or destroy it."
  "x.sentinel-tw.09.threat-suppression-constant": additionalCostToPlay(exhaustOrDestroy(yourIntact("Legs (Intact)"))),
  // Threat Suppression: "Hero Action (attack): Deal 1 damage to up to 3 different enemies and stun up to 2 of those
  // enemies."
  "x.sentinel-tw.09.threat-suppression-action": heroAction(
    { label: "attack" },
    chooseTarget("hit", query("enemy"), { count: 3, upTo: true }),
    forEachCard("enemy", chosen("hit"), attack(1, chosen("enemy"))),
    chooseTarget("stunned", query("enemy", { inSlot: "hit" }), { count: 2, upTo: true }),
    stun(chosen("stunned")),
  ),

  // =========================================================================
  // 10 Juston Seyfert (support)
  // =========================================================================

  // "Action: Attach to a side scheme." He moves onto the scheme like an upgrade attached to a scheme (Overwatch 30019)
  // and stays a support under your control (ruling 2026-11-19). Once attached he stays there: the Action is for a
  // Juston in your play area.
  "x.sentinel-tw.10.juston-seyfert-action": action(
    { while: allOf(exists(query("sideScheme")), not(valueAtLeast(refCount(host), 1))) },
    chooseTarget("scheme", query("sideScheme")),
    attachCard(self, chosen("scheme")),
  ),
  // "Hero Action: Exhaust Juston Seyfert → remove 1 threat from attached side scheme."
  "x.sentinel-tw.10.juston-seyfert-hero-action": heroAction(
    { cost: exhaustThis, while: valueAtLeast(refCount(host), 1) },
    removeThreat(1, host),
  ),
  // "Forced Response: After attached side scheme is defeated, put Juston Seyfert in play under your control. Ready
  // Sentinel or up to 2 Component upgrades." Heard as the scheme is defeated, with him still attached (Wrist Navigator,
  // 27189a); `staysWhenHostLeaves: "defeated"` returns him to your play area instead of the discard pile.
  "x.sentinel-tw.10.juston-seyfert-forced-response": {
    ...forcedInterrupt(
      on.attachedCardDefeated(),
      chooseOne(
        option("Ready Sentinel", ready(yourIdentity)),
        option(
          "Ready up to 2 Component upgrades",
          chooseTarget("readied", YOUR_COMPONENTS, { count: 2, upTo: true }),
          ready(chosen("readied")),
        ),
      ),
    ),
    staysWhenHostLeaves: "defeated",
  },

  // =========================================================================
  // 11 Propulsion Array, 12 Reinforced Plating (upgrades)
  // =========================================================================

  // "[star] As an additional cost to play this upgrade, exhaust Legs (Intact)."
  "x.sentinel-tw.11.propulsion-array-constant": additionalCostToPlay(exhaustCardsCost(yourIntact("Legs (Intact)"))),
  // "Hero Action: Shuffle this card into your deck. Choose one: • Exhaust 1 Component (Intact side up) upgrade → ready
  // Sentinel. • Exhaust Sentinel → ready up to 2 Component (Intact side up) upgrades."
  // Each option's arrow cost is checked before anything resolves: the action is usable only while one of them can be
  // paid (a ready Intact Component, or a ready Sentinel), and an option is offered only while its own cost can be.
  "x.sentinel-tw.11.propulsion-array-action": heroAction(
    { while: anyOf(exists(YOUR_READY_INTACT_COMPONENTS), exists(YOUR_READY_IDENTITY)) },
    moveCards(cards(self), "deckShuffle"),
    chooseOne(
      option(
        "Exhaust 1 Intact Component to ready Sentinel",
        { when: exists(YOUR_READY_INTACT_COMPONENTS) },
        chooseTarget("component", YOUR_READY_INTACT_COMPONENTS),
        exhaust(chosen("component")),
        ready(yourIdentity),
      ),
      option(
        "Exhaust Sentinel to ready up to 2 Intact Components",
        { when: exists(YOUR_READY_IDENTITY) },
        exhaust(yourIdentity),
        chooseTarget("readied", YOUR_INTACT_COMPONENTS, { count: 2, upTo: true }),
        ready(chosen("readied")),
      ),
    ),
  ),
  // "[star] As an additional cost to play this upgrade, exhaust Torso (Intact)."
  "x.sentinel-tw.12.reinforced-plating-constant": additionalCostToPlay(exhaustCardsCost(yourIntact("Torso (Intact)"))),
  // "Hero Action: Discard Reinforced Plating → flip 1 Component (Destroyed side up) upgrade to its Intact side. Gain a
  // tough status card."
  "x.sentinel-tw.12.reinforced-plating-action": heroAction(
    { cost: discardThis, while: exists(YOUR_DESTROYED_COMPONENTS) },
    chooseTarget("component", YOUR_DESTROYED_COMPONENTS),
    flipCard(chosen("component")),
    giveTough(yourIdentity),
  ),

  // =========================================================================
  // 13 Targeting Protocol (upgrade)
  // =========================================================================

  // "Hero Action: Exhaust this card → expose 2 enemies or remove threat from a scheme equal to the number of exposed
  // status cards in play (to a maximum of 3)."
  "x.sentinel-tw.13.targeting-protocol-action": heroAction(
    { cost: exhaustThis },
    chooseOne(
      option("Expose 2 enemies", { when: exists(ENEMY) }, ...expose(2)),
      option(
        "Remove threat equal to the Exposed status cards in play",
        { when: exists(EXPOSED_ENEMY) },
        ...countExposedInPlay(),
        chooseTarget("scheme", query("scheme")),
        removeThreat(min(varOf("exposedInPlay"), 3), chosen("scheme")),
      ),
    ),
  ),

  // =========================================================================
  // 14 Prime Directive (obligation)
  // =========================================================================

  // "Give to the Sentinel player." The obligation stays in play until its Forced Action is resolved (Suggestion 61033's
  // shape).
  "x.sentinel-tw.14.prime-directive-constant": constant(),
  // "Forced Action: Choose one: • Deal 3 damage to another friendly character (Mutant if able) → discard this card. •
  // Place 3 threat on the main scheme → discard this card."
  "x.sentinel-tw.14.prime-directive-forced-action": forcedAction(
    chooseOne(
      option(
        "Deal 3 damage to another friendly character (Mutant if able)",
        // Offered only while there is another friendly character to take it (PR #46 review): with none, the 3 threat
        // is the only choice.
        { when: exists(query(["hero", "ally"], { excluding: yourIdentity })) },
        ifThen(
          exists(query(["hero", "ally"], { trait: MUTANT, excluding: yourIdentity })),
          chooseTarget("victim", query(["hero", "ally"], { trait: MUTANT, excluding: yourIdentity })),
          chooseTarget("victim", query(["hero", "ally"], { excluding: yourIdentity })),
        ),
        dealDamage(3, chosen("victim")),
        discard(self),
      ),
      option("Place 3 threat on the main scheme", placeThreat(3, theMainScheme), discard(self)),
    ),
  ),

  // =========================================================================
  // 15 Mark VII-A (minion, nemesis)
  // =========================================================================

  // "[star] Forced Response: After Mark VII-A makes an undefended attack against you, flip a Component upgrade (Intact
  // side up) to its Destroyed side. If you cannot, discard 1 upgrade you control." A flip, not a destroy (no damage).
  "x.sentinel-tw.15.mark-vii-a-forced-response": forcedResponse(
    on.enemyAttacks("self", { againstYou: true, undefended: true }),
    ifThen(
      exists(YOUR_INTACT_COMPONENTS),
      [chooseTarget("component", YOUR_INTACT_COMPONENTS), flipCard(chosen("component"))],
      [chooseTarget("upgrade", query("upgrade", { controller: "you" })), discard(chosen("upgrade"))],
    ),
  ),

  // =========================================================================
  // 16 Rogue Asset (side scheme, nemesis)
  // =========================================================================

  // "Component upgrades (Intact side up), and Tech upgrades gain the Hacked trait."
  "x.sentinel-tw.16.rogue-asset-constant": constant(
    gainsTrait(HACKED, query("upgrade", { anyOf: [query("upgrade", { trait: COMPONENT, anyTrait: [INTACT] }), query("upgrade", { trait: TECH })] })),
  ),

  // =========================================================================
  // 17 Disabled, 18 Viral Assault, 19 Hostile Override (treacheries, nemesis)
  // =========================================================================

  // "When Revealed: Exhaust each Hacked upgrade under your control. If you cannot, search the encounter deck and discard
  // pile for the Rogue Asset side scheme and put it into play. If Rogue Asset is already in play, stun your identity."
  "x.sentinel-tw.17.when-revealed": whenRevealed(
    ifThen(
      exists(query("upgrade", { trait: HACKED, controller: "you", exhausted: false })),
      forEachCard("upgrade", each(query("upgrade", { trait: HACKED, controller: "you", exhausted: false })), exhaust(chosen("upgrade"))),
      ifThen(exists(ROGUE_ASSET), stun(yourIdentity), rogueAssetIntoPlay()),
    ),
  ),
  // "[star] Boost: Stun your identity."
  "x.sentinel-tw.17.boost": boost(stun(yourIdentity)),
  // "When Revealed: You may discard 1 Hacked upgrade you control. If you do not, take 1 damage for each Hacked upgrade
  // you control. If you control no Hacked upgrades, search … for the Rogue Asset side scheme and put it into play. If
  // Rogue Asset is already in play, this card gains surge."
  "x.sentinel-tw.18.when-revealed": whenRevealed(
    ifThen(
      exists(YOUR_HACKED_UPGRADES),
      [
        chooseTarget("discarded", YOUR_HACKED_UPGRADES, { count: 1, upTo: true }),
        ifThen(
          valueAtLeast(refCount(chosen("discarded")), 1),
          discard(chosen("discarded")),
          dealDamage(countOf(YOUR_HACKED_UPGRADES), yourIdentity),
        ),
      ],
      ifThen(exists(ROGUE_ASSET), surge(), rogueAssetIntoPlay()),
    ),
  ),
  // "When Revealed: If you control at least one Hacked upgrade, deal damage to a friendly character equal to your ATK
  // value, or place threat on the main scheme equal to your THW value. If you control no Hacked upgrades, you are
  // confused."
  "x.sentinel-tw.19.when-revealed": whenRevealed(
    ifThen(
      exists(YOUR_HACKED_UPGRADES),
      chooseOne(
        option(
          "Deal damage equal to your ATK to a friendly character",
          chooseTarget("victim", FRIENDLY_CHARACTER),
          dealDamage(statOf(yourIdentity, "atk"), chosen("victim")),
        ),
        option("Place threat equal to your THW on the main scheme", placeThreat(statOf(yourIdentity, "thw"), theMainScheme)),
      ),
      confuse(yourIdentity),
    ),
  ),
  // "[star] Boost: You are confused."
  "x.sentinel-tw.19.boost": boost(confuse(yourIdentity)),
});
