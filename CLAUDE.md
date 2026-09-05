# Layer Inspector — Codebase Guide

MTG continuous-effects evaluator (CR 613). Single-page app, no build step, no frameworks, no external libraries.

## UI Style Rules

**No emojis.** The user strongly dislikes emojis in the UI. Never add emoji characters (including Unicode symbols like ☀, ☠, ⚙️, or HTML entities like &#x1F441;) to button labels, headings, placeholders, or any user-facing text. Use plain words only.

**Capitalize the first letter of every sentence.** Any sentence presented to the user must always begin with a capital letter. This applies to all user-facing text — button labels, headings, placeholders, tooltips, log messages, dependency reasons, effect descriptions, and any engine- or parser-generated strings. When emitting text that starts a sentence, ensure the leading character is uppercase.

## File Overview

The codebase is split into many focused files so any given concern (Scryfall, Battlefield state, oracle parsing, a single layer, one render path, one modal cluster) can be loaded without wading through thousands of unrelated lines.

| File | Lines | Role |
|------|-------|------|
| `index.html` | 202 | Layout skeleton; loads scripts in dependency order |
| `data.js` | 349 | Constants, effect templates, type catalog |
| **engine — pure CR 613 evaluation** | | |
| `engine-state.js` | 75 | `createBaseState` (printed-characteristics → mutable state) |
| `engine-helpers.js` | 148 | Display names, snapshots, `_isAuraNotCreature`, `_getImprintedExileEntries`, `statesAreDifferent`, `additiveDeltaDiffers` (post-split slim helpers) |
| `engine-protection.js` | 223 | CR 702.16 protection parsing/matching (`_parseOneProtectionClause`, `_parseProtectionAbility`, `_getStateProtection`, `_protectionGrantTimestamp`, `_isProtectedFromSource`, `_formatProtectionEntry`) |
| `engine-compute.js` | 414 | `_computeForEachCount`, `_computeDevotionCounts` (Layer-7 dynamic compute) |
| `engine-bestow-mutate.js` | 222 | `_applyBestowLayer4`, `_applyMutateLayer1`, `_reParseAfterTextChange` (special-mechanic layer hooks) |
| `engine-apply.js` | 1,208 | `applyEffect` — the 21-case-per-EFFECT_TYPE switch + `BASIC_LAND_MANA` |
| `engine-deps.js` | 786 | `effectAppliesToPerm`, `isSourceViable`, `doesBInfluenceA_global`, `getDependencyReason`, `detectDependenciesGlobal`, `removeLoopDependencies` (CR 613.8) + `_findRealPerm` / `_realPermsByIdCache` hot-loop helper |
| `engine-layer.js` | 639 | `applyLayerGlobal`, `applyEffectGlobally`, `evaluatePermanent` |
| **cards — Scryfall, Battlefield, oracle parsing** | | |
| `cards-helpers.js` | 45 | `_parseWordNumber`, `_pinAbilityEffectsToSource`, `_permLabelString`, `getSpentToCast` |
| `cards-scryfall.js` | 60 | `searchScryfall`, `hasMoreScryfallResults`, `fetchCardByName`, `fetchTokenByName` |
| `cards-permanent.js` | 622 | `createPermanent`, `_resolveCardFace`, special card-type parsers (saga / class / leveler / spacecraft), oracle text preprocessing |
| `cards-text-utils.js` | 1,189 | `CARD_TYPE_WORDS` / `LAND_SUBTYPE_WORDS`, `normalizeTypeWord`, plurals, `filterReferencesPermanents`, `extractTargetInfo`, `buildAppliesToFromText` (+ inner), `parseBecomesType`, `buildAuraRestriction`, `_evaluateTriggerCondition` |
| `cards-parser.js` | 5,343 | `parseCardEffects` — the monolith oracle-text → effect-objects converter. Top-of-file shared helpers: `_isTriggeredSentence`, `stripDurationPrefix`, `SIMPLE_TRAIT_CONDITIONS` |
| `cards-parser-post.js` | 185 | `_parseGrantedGlobalAbilities`, `_parseSimpleKeywordList`, `_finalizeEffects` (post-processing extracted from cards-parser) |
| `cards-battlefield.js` | 2,254 | `Battlefield` singleton (incl. `getPermById` O(1) lookup map) |
| **ui — DOM rendering and event binding** | | |
| `ui-helpers.js` | 176 | `_createModalOverlay`, `_setupDrag`, `escapeHtml`, `escapeAttr`, `simplifyReason`, `_stripReminderText`, `showDepReasonPopup`, `_modalShell`, `_renderPermItem`, `_selectOneOf` |
| `ui-dom-builders.js` | 12 | `buildPlayerSelectOptions` (shared option-list builders) |
| `ui-core.js` | 493 | `DOMContentLoaded`, `renderAll`, player tabs, panel-resize init, search UI, add-card flow, split-face / dual-options modals |
| `ui-pages.js` | 305 | Utility-page routes (tutorial, about, contact) — hash-based router for the header icon-button pages |
| `ui-battlefield.js` | 693 | `renderBattlefield` (+ nested `renderCardDiv`, `wrapWithAttachers`, `renderGhostCardDiv`), per-permanent interactions (select/remove/tap/flip/face-down), `renderBfCounterBadges`, `_hideAbilityPseudoPerms` toggle |
| `ui-timestamp.js` | 171 | `renderTimestampPanel`, `initDragDrop` |
| `ui-zones.js` | 695 | Commander, Emblem, Graveyard, Exile zone panels |
| `ui-abilities.js` | 667 | `fireTriggeredAbility`, `fireActivatedAbility`, ability popup, modal-mode popup, color-choice popup, activate-options popup |
| `ui-targeting.js` | 540 | All target-picker dropdowns (single, multi, opponent, player, modal-mode) |
| `ui-effect-inputs.js` | 301 | `getEffectInfo`, X / CDA / chosen-card-name / chosen-creature-type / chosen-color input renderers |
| `ui-state-panels.js` | 203 | Counter panel + game-state panel + `COUNTER_PRESETS` + `_adjustGameStat` |
| `ui-inspector.js` | 630 | `renderInspector`, `renderLayerBody`, type-line popups, state block, `_orderShowAll` toggle |
| `ui-modals.js` | 11 | Stub. Modal implementations split into per-cluster files below. |
| `ui-modal-copy.js` | 290 | Copy modal (Clone-style copy-source picker + editable copy editor) |
| `ui-modal-text-change.js` | 878 | Text-change cluster: standard text / swirl (color) / exchange (deadpool / target swap) / exchange-control / creature-type modal |
| `ui-modal-mutate.js` | 158 | Mutate target selection modal (CR 702.140) |
| `ui-modal-bestow.js` | 103 | Bestow target selection modal (CR 702.102) |
| `ui-modal-equip.js` | 376 | Equip / Reconfigure / Fortify / Imprint modals (`renderEquipButton`, `clearEquipTarget`, `unattachEquipFromModal`, `openImprintModal`) |
| `ui-modal-snapshot.js` | 295 | Board snapshot popup ("camera" button on spells/abilities) |
| `styles.css` | 2,764 | All styles |

**Script load order** (in `index.html`): `data.js` → engine-* (state, helpers, protection, compute, bestow-mutate, apply, deps, layer) → cards-* → ui-* (helpers, dom-builders, then page/grid renderers, then modal cluster). Within each tier, order doesn't matter at runtime — all cross-file references happen inside event-time function calls, not at parse time.

---

## data.js

Constants only — no logic.

- `TypeCatalog` (line 14) — Scryfall type enums; async `init()` fetches from API with hardcoded fallback
- `LAYERS[]` — Layer metadata with CR references
- `EFFECT_TYPE` — String constants for effect types (`ADD_TYPE`, `SET_PT`, `TEXT_CHANGE`, etc.)
- `KNOWN_ABILITY_EFFECTS` — Map of normalized oracle text → effect template arrays. Primary lookup used by `parseCardEffects()` in `cards-parser.js`

---

## engine — pure evaluation logic

No DOM. No Scryfall calls. Receives state objects, returns computed state.

### engine-state.js
- `createBaseState(perm)` — Builds mutable state object from a permanent's printed characteristics

### engine-apply.js
- `applyEffect(state, effect, context)` — Applies one effect to one state. Big switch on `effect.type` with 21 cases (`ADD_TYPE`, `REMOVE_TYPE`, `SET_TYPE`, `ADD_ABILITY`, `REMOVE_ABILITIES`, `SET_PT`, `MODIFY_PT`, `ADD_COUNTERS`, `SET_COLOR`, `ADD_COLOR`, `COPY`, `TEXT_CHANGE`, `CDA_PT`, `KEYWORD_COUNTER`, `SWITCH_PT`, `SET_NAME`, `GAIN_ACTIVATED_FROM_OTHERS`, `GAIN_ACTIVATED_FROM_GRAVEYARDS`, `GAIN_ACTIVATED_FROM_EXILE`, `IMPRINT_PROTECTION_FROM_TYPES`, `CONTROL`). Handles CR 305.7 land mana ability side-effects.
- `BASIC_LAND_MANA` — Map `{ Plains: '{T}: Add {W}.', ... }` (referenced by both engine-apply and cards-permanent's `_addIntrinsicLandMana`)

### engine-deps.js
- `effectAppliesToPerm(effect, permState, permanent, permId, allStates, abilityGroupAffectedPerms)` — Tests whether an effect targets/applies to a given permanent
- `isSourceViable(effect, allStates)` — Whether the source permanent still exists and qualifies
- `doesBInfluenceA_global(A, B, allStates, realPerms)` — **CR 613.8 dependency detection.** Tests if applying B before A changes A's result. Has special-case logic for word-replacement effects (asymmetric), `ADD_ABILITY` / `REMOVE_ABILITIES` (same layer, no cross-dependency), and source-viability checks
- `getDependencyReason(A, B, allStates, realPerms)` — Re-runs the dependency checks to identify which condition fired, for display
- `detectDependenciesGlobal(effects, allStates, realPerms)` — Builds full dependency graph. Populates module-private `_realPermsByIdCache` Map for the duration of the pass.
- `removeLoopDependencies(deps)` — DFS cycle detection; emits named loop log entries
- `_findRealPerm(realPerms, id)` — Hot-loop helper that prefers the per-pass id→perm Map cache, falling back to `realPerms.find()`. Use this inside the O(N²) inner loop instead of `realPerms.find(p => p.id === id)`.

### engine-layer.js
- `applyLayerGlobal(effects, allStates, allPermanents, inspectedId, ...)` — **Main per-layer evaluator.** Applies dependency ordering, then applies effects in order
- `applyEffectGlobally(effect, allStates, realPerms, ...)` — Applies one effect to every matching permanent
- `evaluatePermanent(permanent, allPermanents, allEffects, inspectedId)` — **Primary export.** Runs all 7 layers, returns `{ base, layers, applicationLog }`

### engine-helpers.js (post-split slim helpers)
- `_effectiveSourceId`, `_effectDisplayName` — Display-name resolution accounting for text exchanges and labels
- `snapshotState`, `getEffectControllerId` — Deep clone, controller resolution
- `statesAreDifferent`, `additiveDeltaDiffers` — Comparators for dependency detection
- `_isAuraNotCreature(st)` — true if a state is currently "Aura subtype but not Creature type" (used in CR 704.5p / bestow dep reasoning)
- `_getImprintedExileEntries(sourceId)` — exile entries tagged `exiledWith === sourceId`, sorted by timestamp

### engine-protection.js (split from engine-helpers in 2026-05-27)
CR 702.16 "protection from X" parsing and matching.
- `_parseOneProtectionClause(clauseRaw)` — single "protection from …" clause → `{ kind, value, raw }`
- `_parseProtectionAbility(abilityLine)` — splits "protection from A and from B" → array of clauses
- `_getStateProtection(state)` — all protection entries currently on a state, cached on `state._protectionFrom`
- `_protectionGrantTimestamp(targetPerm, protEntry)` — when did the perm acquire this protection? Used for one-time-effect bypass
- `_isProtectedFromSource(targetState, sourceState, sourcePerm, targetPerm)` — main predicate
- `_formatProtectionEntry(p)` — display string

### engine-compute.js (split from engine-helpers in 2026-05-27)
Layer-7 dynamic compute helpers.
- `_computeForEachCount(forEachDesc, allStates, selfState, effect)` — auto-compute "for each X" counts (counters / subtypes / supertypes / exile / commander-casts / hand size / life / poison / experience / mana value, etc.)
- `_computeDevotionCounts(allStates, controller)` — Theros gods' devotion {W,U,B,R,G}

### engine-bestow-mutate.js (split from engine-helpers in 2026-05-27)
Special-mechanic layer hooks called from `engine-layer.js`.
- `_applyBestowLayer4(Battlefield, allStates, inspectedId, layerResult)` — CR 702.102 bestow Layer-4 hook (loses Creature type, gains Aura subtype, gains "Enchant creature")
- `_applyMutateLayer1(Battlefield, allStates, inspectedId, layerResult)` — CR 702.140 mutate Layer-1 hook (top card's name/types/P/T win; all abilities merge)
- `_reParseAfterTextChange(allStates, allPermanents, currentEffects)` — after Layer 3 oracle-text changes, re-parse Layer 4+ effects from the modified card

**Layers implemented:** 1 (copy/mutate), 2 (control), 3 (text), 4 (type + 305.7 mana recalc), 5 (color), 6 (abilities), 7a–7e (P/T: CDA, set, modify, counters, switch).

---

## cards — Scryfall, permanent factory, oracle parsing

### cards-battlefield.js — the `Battlefield` singleton

The central application state. Everything reads from and writes to this.

```
Battlefield.permanents[]         — all permanents on battlefield
Battlefield.effects[]            — all parsed effects (from all permanents)
Battlefield.nextTimestamp        — auto-incrementing, used for ordering
Battlefield.inspectedId          — which permanent is selected in inspector
Battlefield.explanationMode      — 'teaching' | 'rules'
Battlefield.gameState{}          — handSize, currentLife, isYourTurn, etc.
Battlefield.mutateStacks[]       — array of [id, id, ...] stacks
Battlefield.players[]            — player list (each with own gameState)
Battlefield.activePlayerId       — for player-tabs
Battlefield.getAllFinalStates()  — evaluates every permanent, returns Map<id, finalState>
```

**Key methods:** `addPermanent`, `removePermanent`, `setTarget`, `clear`, `updateLabels` (assigns A/B/C labels to same-named perms), `getStack` (mutate stack containing this id, or null), `evaluate`, `getAllFinalStates`, plus zone managers (graveyards, exile, command zone, emblems).

### cards-permanent.js — permanent factory

`createPermanent(card, timestamp, opts)` builds a permanent object:

```
{
  id, name, timestamp, imageUri,
  printedTypes[], printedSupertypes[], printedSubtypes[],
  printedPower, printedToughness,     // null if not creature
  printedAbilities[], printedColors[],
  oracleText,                         // self-references substituted
  counters{}, traits[],
  isToken, isManualEffect, isTransformable,
  isFaceDown, faceDownMode,           // 'morph'|'manifest'|'cloak'
  tapped, label,                      // label: null | 'A'|'B'|...
}
```

Also: `_resolveCardFace` (multi-face card layouts), `_cmcFromManaCost`, `parseTypeLine`, `_stripReminderText`, `extractAbilities`, special-mechanic parsers (`_parseSagaChapters`, `_parseClassLevels`, `_parseLevelerLevels`, `_parseSpacecraftStations`, `_extractOracleCounterTypes`), `_replaceProperNounSelfRef`, `_addIntrinsicLandMana`, `TRANSFORMABLE_LAYOUTS`, `CHOOSEABLE_FACE_LAYOUTS`.

### cards-text-utils.js — type/subtype data + filter parsing

- `CARD_TYPE_WORDS`, `LAND_SUBTYPE_WORDS` — type catalogs used to recognize words in oracle text
- `normalizeTypeWord(w)` — shared `CARD_TYPE_WORDS[w] || CARD_TYPE_WORDS[w.replace(/s$/, '')]` lookup (handles singular/plural in one call)
- Plurals: `IRREGULAR_PLURALS`, `singularizeCreatureType`, `pluralizeCreatureType`, `SINGULAR_TO_PLURAL`, `LAND_SINGULAR_TO_PLURAL`, etc.
- `filterReferencesPermanents(filterText)` — does this filter scope to a class of permanents?
- `extractTargetInfo` — pulls target counts and restrictions from a filter string
- `buildAppliesToFromText` + `_buildAppliesToFromTextInner` — turns filter text into `{ isSelf, isTargeted, fn }` (the big tokenizer)
- `parseBecomesType` — "becomes a [type]" text
- `buildAuraRestriction` — "Enchant [type]" → aura targeting restriction
- `_evaluateTriggerCondition` — runtime check for a trigger's "if [condition]"

### cards-parser.js — `parseCardEffects` (~5,343-line monolith)

Top-of-file shared helpers (used in many sections, defined once at module level):
- `TRIGGERED_SENTENCE_RE` / `_isTriggeredSentence(s)` — does this sentence start with When/Whenever/At?
- `DURATION_PREFIX_RE` / `stripDurationPrefix(s)` — strip leading "Until end of turn, " from a filter fragment
- `SIMPLE_TRAIT_CONDITIONS[]` — table-driven dispatch for "is legendary / is a creature / is monstrous / is saddled / is crewed" plus negations

Normalizes oracle text → checks `KNOWN_ABILITY_EFFECTS` first → falls back to ~14 internal sections of regex parsers covering:
- Condition parsing ("as long as", counter / game-state / life-total / devotion conditions)
- Modal spell preprocessing
- Copy effects (Layer 1)
- Supertype changes (Layer 4)
- Aura target restrictions
- Type changes (Layer 4) — `becomesType`, `addTypeRegex`, `setTypeRegex`
- Type removal
- P/T modification (Layer 7c) — `boostRegex`
- Color setting (Layer 5)
- P/T setting (Layer 7b)
- P/T switch (Layer 7e)
- Ability granting (Layer 6) — `haveAbilityRegex`, keyword lists, protection
- Ability removal
- Lose-all-abilities
- Enchantment transformations
- Control effects (Layer 2)
- Trait parsing (goaded, suspected)
- Modal effect sorting / numbering
- Exiled-with abilities (Mairsil etc.)

Post-processing helpers — `_parseGrantedGlobalAbilities`, `_parseSimpleKeywordList`, `_finalizeEffects` (propagate aura/equipment restrictions across targeted effects, stamp `ownerId`) — live in **`cards-parser-post.js`** (loaded immediately after).

### cards-scryfall.js — Scryfall API integration

`searchScryfall(query, opts)`, `hasMoreScryfallResults`, `fetchCardByName` plus pagination state (`_scryfallNextPage`, `_scryfallLastResults`).

### cards-helpers.js — small utilities

`_parseWordNumber` (English number words → integers), `_pinAbilityEffectsToSource` (re-anchor self-target effects), `_permLabelString` (Excel-style A/B/.../AA labels).

---

## ui — DOM rendering and event handling

All DOM. Calls into `Battlefield` and the engine. No game logic.

### ui-core.js — boot + master render + search + add card
- `DOMContentLoaded` handler (`bindSearchUI` → resize init → `renderAll`)
- `renderAll()` — calls all 10 sub-renderers in sequence
- Player tabs (`renderPlayerTabs`, `switchPlayer`, `addPlayerPrompt`, `removePlayer`)
- `initPanelResize` (left panel width), `initSectionResize` (timestamp section height)
- Search UI: `bindSearchUI`, `doSearch`, `renderSearchResults`
- Add card flow: `addCardToBattlefield`, `_doAddCardToBattlefield`, split-face modal, dual-options modal

### ui-battlefield.js — battlefield grid + per-permanent interactions
- `renderBattlefield()` — Renders card grid; computes `finalStates` via `Battlefield.getAllFinalStates()` for SBA checks and overlay display
  - Inner `renderCardDiv(p)` — Builds one card's HTML (uses `_cardFs` final state for type line / P/T)
  - Inner `wrapWithAttachers` — renders auras/equipment fanned behind their target
  - Inner `renderGhostCardDiv` — mutate stack ghost cards
- `selectPermanent`, `removePermanent`, `toggleTapped`, `toggleAttacking`, `toggleBlocking`, `flipCard`, face-down menu (`openFaceDownMenu`, `setFaceDown`, `turnFaceUp`)
- `renderBfCounterBadges`, `_showSBAToast`, `_hideAbilityPseudoPerms` toggle

### ui-timestamp.js — timestamp / drag-drop
- `renderTimestampPanel` — drag-reorderable effect/ability list
- `initDragDrop`

### ui-zones.js — Commander, Emblem, Graveyard, Exile panels
Each zone has its own render + open/close modal + add/remove handlers.

### ui-abilities.js — triggered/activated firing + popups
- `fireTriggeredAbility(id, abilityIdx)` — Creates a pseudo-permanent in the timeline from a triggered ability
- `fireActivatedAbility(id, abilityIdx)` — Same for activated abilities; handles cost/option choices
- `openColorChoicePopup`, `openActivateOptionsPopup`, `_chooseActivateOption`
- Ability popup (`openAbilityPopup`, etc.)
- Modal-mode popup (15 functions for picking modes on modal spells)

### ui-targeting.js — target picker dropdowns
Renderers for: copy target, single permanent target, opponent, player, enchanted player, multi-target, modal-mode targets.

### ui-effect-inputs.js — per-effect inputs
`getEffectInfo`, X-value input, CDA-value input, chosen-card-name autocomplete, chosen-creature-type autocomplete, chosen-land-type, chosen-color picker.

### ui-state-panels.js — counter + game-state panels
`renderCounterPanel`, `modifyCounter`, `addCounterFromUI`, `modifyClassLevel`, `toggleYourTurn`, `renderGameStatePanel`, `COUNTER_PRESETS`.

### ui-inspector.js — layer inspector
- `renderInspector` — the big right-panel layout
- `renderLayerBody` — per-layer table builder
- Text-replacement helpers (`_replaceThisCard`, `_replaceYouForPlayer`, `_replaceYouControl`)
- `_buildTypeLineHtml` + clickable type popups (`openAllCreatureTypesPopup`, `openAllTypesPopup`)
- `renderStateBlock` — state-based effect visualization
- `_orderShowAll` toggle

### ui-modals.js — split into per-cluster files (2026-05-27)
`ui-modals.js` is now an 11-line stub. The modal implementations live in:
- `ui-modal-copy.js` — Copy modal (Clone-style copy-source picker + editable copy editor)
- `ui-modal-text-change.js` — Text-change cluster: standard text modal, swirl (color), exchange (deadpool / target swap), exchange-control, creature-type modal
- `ui-modal-mutate.js` — Mutate modal (CR 702.140)
- `ui-modal-bestow.js` — Bestow modal (CR 702.102)
- `ui-modal-equip.js` — Equip / Reconfigure / Fortify + Imprint modals (`renderEquipButton`, `clearEquipTarget`, `unattachEquipFromModal`, `openImprintModal`)
- `ui-modal-snapshot.js` — Board snapshot popup ("camera" button on spells/abilities)

### ui-dom-builders.js — shared option-list builders
`buildPlayerSelectOptions(players, currentId)` — used by the player/opponent/enchanted-player dropdowns in `ui-targeting.js`.

### ui-helpers.js — shared utilities
`_createModalOverlay`, `_setupDrag`, `escapeHtml`, `escapeAttr`, `simplifyReason`, `_stripReminderText`, `showDepReasonPopup`.

---

## styles.css

No preprocessor. CSS custom properties defined at top.

**Color palette:**
```
--bg: #0f0f11          --surface: #1a1a20     --border: #2a2a35
--accent: #7c6df0      --accent2: #5b8af0
--gold: #d4a540        --green: #4caf80       --red: #e05555
--text-dim: (muted)    --mono: (monospace font)
```

**Key class prefixes:**
- `.bf-card*` — Battlefield card and its sub-elements (overlay, label, badges, buttons)
- `.insp-*` — Layer inspector panel
- `.ts-*` — Timestamp/ordering panel
- `.modal-*` — Modal overlays
- `.search-*` — Search bar and results

---

## Data Flow

```
User adds card
  ui-core.js → searchScryfall() [cards-scryfall.js] → Scryfall API
  ui-core.js → _doAddCardToBattlefield() → Battlefield.addPermanent() [cards-battlefield.js]
                                         → createPermanent() [cards-permanent.js]
                                         → parseCardEffects() [cards-parser.js] → Battlefield.effects[]

User inspects permanent
  ui-battlefield.js → Battlefield.getAllFinalStates() [cards-battlefield.js]
                    → evaluatePermanent() [engine-layer.js] for each permanent
                    → detectDependenciesGlobal [engine-deps.js]
                    → applyLayerGlobal → applicationLog
  ui-inspector.js renderInspector() → displays per-layer effect log with dependency reasons
```

---

## Cross-file globals

Classic (non-module) `<script>` tags share a "script lexical environment." Top-level `function`, `var`, `const`, and `let` declarations from any file are visible by bare name in any other file — but **only at runtime**, never at parse time. All cross-file references in this codebase happen inside event-time function calls (clicks, render calls), so script load order doesn't matter beyond keeping data.js first.

`Battlefield`, `EFFECT_TYPE`, `LAYERS`, `LAYER_MAP`, `KNOWN_ABILITY_EFFECTS`, `TypeCatalog`, `BASIC_LAND_MANA`, `CARD_TYPE_WORDS`, `LAND_SUBTYPE_WORDS`, `CHOOSEABLE_FACE_LAYOUTS`, `COUNTER_PRESETS`, plus all top-level functions, are accessible across files.

---

## Preview Server

- Serves from `/tmp/layers_static/` (NOT directly from the Dropbox folder)
- A PostToolUse hook auto-syncs Edit/Write changes to `/tmp/layers_static/`. Bash file creation does NOT auto-sync — `cp` manually if you wrote files via shell.
- If styles/JS aren't updating in browser: manually `cp` the file to `/tmp/layers_static/` and force-reload with a cache-busted stylesheet URL
