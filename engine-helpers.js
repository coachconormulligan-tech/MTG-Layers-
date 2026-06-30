/* engine-helpers.js — small shared helpers across engine modules:
   display names, snapshots, source-type guards, state diff comparators.

   Larger subsystems live in sibling files:
     engine-protection.js     — CR 702.16 protection parsing/matching
     engine-compute.js        — _computeForEachCount, _computeDevotionCounts
     engine-bestow-mutate.js  — Layer-1 mutate, Layer-4 bestow, post-text-change re-parse
*/

/* True if `st` is currently in "Aura-but-not-Creature" form — i.e. an aura attached as an
   enchantment, not bestowed-as-creature or otherwise type-shifted. Used for SBA 704.5p
   dependency reasoning (aura unattaches when it becomes a creature). */
function _isAuraNotCreature(st) {
  return !!(st && (st.subtypes || []).includes('Aura') && !st.types.includes('Creature'));
}

/* Return all exile entries that were exiled "with" the given source permanent (Imprint, etc.),
   sorted ascending by timestamp — so .at(-1) gives the most recently imprinted card
   (Duplicant's "last creature card exiled with it"). Face-down entries are excluded. */
function _getImprintedExileEntries(sourceId) {
  if (typeof Battlefield === 'undefined' || !Battlefield.exile) return [];
  return Battlefield.exile
    .filter(e => e.exiledWithId === sourceId && !e.isFaceDown)
    .sort((a, b) => a.timestamp - b.timestamp);
}

/* Return the effective source ID for an effect, accounting for text exchanges.
   After Exchange of Words swaps permanent A and B's text boxes, effects originally from A
   now live on B — so their effective source ID is B's ID (and vice versa). */
function _effectiveSourceId(effect, allStates) {
  if (!allStates || !effect.sourceId) return effect.sourceId;
  // Re-parsed effects already carry the correct sourceId (the permanent that now has the text).
  // textExchangedTo remapping only applies to stale pre-exchange effects.
  if (effect._reparsedEffect) return effect.sourceId;
  const srcState = allStates.get(effect.sourceId);
  if (srcState && srcState.textExchangedTo != null) return srcState.textExchangedTo;
  return effect.sourceId;
}

/* Return the display name for an effect's source, appending the permanent's label if it
   has one (e.g. "Conversion A"). Uses the final computed name from allStates when available
   so that mutated permanents show the top card's name, and Exchange of Words shows the
   permanent that currently carries the ability. Used only in log strings — never in parsing. */
function _effectDisplayName(effect, allStates) {
  const effSourceId = _effectiveSourceId(effect, allStates);
  // Prefer the final computed name (e.g. after mutation or text exchange)
  const computedName = allStates && effSourceId
    ? (allStates.get(effSourceId)?.name || effect.sourceName)
    : effect.sourceName;
  if (typeof Battlefield !== 'undefined' && Battlefield.permanents) {
    const perm = Battlefield.getPermById(effSourceId);
    if (perm && perm.label) return `${computedName} ${perm.label}`;
  }
  return computedName;
}

function snapshotState(state) {
  return {
    name:       state.name,
    types:      [...state.types],
    supertypes: [...state.supertypes],
    subtypes:   [...state.subtypes],
    power:      state.power,
    toughness:  state.toughness,
    abilities:  [...state.abilities],
    colors:     [...state.colors],
    manaValue:  state.manaValue,
    manaCost:   state.manaCost || '',
    isCreature: state.types.includes('Creature'),
    isToken:    state.isToken || false,
    oracleText: state.oracleText || '',
    hasChangeling: state.hasChangeling || state.abilities.some(a => /\bchangeling\b/i.test(a)),
    // isAllCreatureTypes: set once at Layer 4 based on whether changeling exists at that point
    // After Layer 4, it persists even if changeling is later removed in Layer 6
    isAllCreatureTypes: state.isAllCreatureTypes || false,
    isAllLandTypes: state.isAllLandTypes || false,
    opponentsControlEffects: [...(state.opponentsControlEffects || [])],
    abilitiesRemovedBy305_7: state.abilitiesRemovedBy305_7 || false,
    allAbilitiesRemoved: state.allAbilitiesRemoved || false,
    oracleTextModified: state.oracleTextModified || false,
    copySource: state.copySource || null,
    cdaUserValue: state.cdaUserValue ?? null,
    counters: { ...(state.counters || {}) },
    traits: [...(state.traits || [])],
    allPrintedAbilities: state.allPrintedAbilities ? [...state.allPrintedAbilities] : null,
    conditionalAbilityIndices: state.conditionalAbilityIndices || null,
    conditionalAbilityConditions: state.conditionalAbilityConditions || null,
    sagaChapterThresholds: state.sagaChapterThresholds || null,
    classLevelThresholds: state.classLevelThresholds || null,
    classLevel: state.classLevel || null,
    levelerData: state.levelerData || null,
    spacecraftData: state.spacecraftData || null,
    owner: state.owner || 'player_0',
    controller: state.controller || state.owner || 'player_0',
    tapped: state.tapped || false,
    isCommander: state.isCommander || false,
  };
}

/* Returns the controller of the effect's source permanent (for "you control" resolution).
   Looks up the source in allStates first (which reflects Layer 2 control changes),
   falls back to ownerId (the original owner of the effect's source). */
function getEffectControllerId(effect, allStates) {
  if (allStates && effect.sourceId) {
    const srcState = allStates.get(effect.sourceId);
    if (srcState) return srcState.controller;
  }
  return effect.ownerId || 'player_0';
}
/* [END: STATE] */

/* Compare two states for meaningful differences. */
function statesAreDifferent(a, b) {
  if ([...a.types].sort().join() !== [...b.types].sort().join()) return true;
  if ([...a.subtypes].sort().join() !== [...b.subtypes].sort().join()) return true;
  if ([...a.supertypes].sort().join() !== [...b.supertypes].sort().join()) return true;
  if ([...a.abilities].sort().join() !== [...b.abilities].sort().join()) return true;
  if ([...a.colors].sort().join() !== [...b.colors].sort().join()) return true;
  if (a.power !== b.power || a.toughness !== b.toughness) return true;
  return false;
}

/* CR 613.8 dependency: compare what an additive effect (ADD_TYPE, ADD_COLOR,
   ADD_ABILITY, MODIFY_PT) actually DOES (its delta) rather than the full resulting
   state.  Full-state comparison produces false positives when B's changes persist
   in the result even though A's behaviour is identical.
   Example: Life-and-Limb (ADD_TYPE) + Conversion — Conversion changes Mountain→Plains
   on Taiga, but Life-and-Limb still adds exactly Creature + Saproling either way. */
function additiveDeltaDiffers(before1, after1, before2, after2) {
  const diff = (arrA, arrB) => arrA.filter(x => !arrB.includes(x)).sort().join();
  // Types
  if (diff(after1.types, before1.types) !== diff(after2.types, before2.types)) return true;
  // Subtypes
  if (diff(after1.subtypes, before1.subtypes) !== diff(after2.subtypes, before2.subtypes)) return true;
  // Supertypes
  if (diff(after1.supertypes, before1.supertypes) !== diff(after2.supertypes, before2.supertypes)) return true;
  // Colors
  if (diff(after1.colors, before1.colors) !== diff(after2.colors, before2.colors)) return true;
  // Abilities
  if (diff(after1.abilities, before1.abilities) !== diff(after2.abilities, before2.abilities)) return true;
  // P/T delta (for MODIFY_PT)
  const pDelta1 = (after1.power ?? 0) - (before1.power ?? 0);
  const pDelta2 = (after2.power ?? 0) - (before2.power ?? 0);
  const tDelta1 = (after1.toughness ?? 0) - (before1.toughness ?? 0);
  const tDelta2 = (after2.toughness ?? 0) - (before2.toughness ?? 0);
  if (pDelta1 !== pDelta2 || tDelta1 !== tDelta2) return true;
  return false;
}
