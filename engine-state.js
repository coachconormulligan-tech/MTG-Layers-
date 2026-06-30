/* engine-state.js — base state factory for permanents. */

/* [KEY: STATE]  —  Construct mutable state; snapshot for deep clone */
function createBaseState(permanent) {
  const allPrinted = [...(permanent.printedAbilities || [])];
  // Filter out abilities from conditional lines (they're added by Layer 6/7 effects when conditions are met)
  const condIndices = permanent._conditionalAbilityIndices;
  // Filter out leveler bracket abilities — abilities in non-base brackets are conditional on level counters.
  // Also filter structural lines (LEVEL headers, P/T lines) since they're not real abilities.
  const levelerData = permanent._levelerData;
  // Filter out spacecraft bracket abilities — abilities gated by charge counter thresholds.
  const spacecraftData = permanent._spacecraftData;
  const abilities = allPrinted.filter((_, i) => {
    if (condIndices && condIndices.has(i)) return false;
    if (levelerData && levelerData.abilityIndexToBracket) {
      const bracketIdx = levelerData.abilityIndexToBracket.get(i);
      if (bracketIdx !== undefined && bracketIdx > 0) {
        // Non-base bracket: all lines excluded from base state (structural + ability lines)
        return false;
      }
    }
    return true;
  });
  const hasChangeling = abilities.some(a => /\bchangeling\b/i.test(a));
  return {
    name:       permanent.name,
    types:      [...permanent.printedTypes],
    supertypes: [...(permanent.printedSupertypes || [])],
    subtypes:   [...(permanent.printedSubtypes || [])],
    power:      permanent.printedPower,
    toughness:  permanent.printedToughness,
    abilities:  abilities,
    colors:     [...(permanent.printedColors || [])],
    manaValue:  permanent.manaValue || 0,
    manaCost:   permanent.manaCost || '',
    isCreature: permanent.printedTypes.includes('Creature'),
    isToken:    permanent.isToken || false,
    oracleText: permanent.oracleText || '',
    hasChangeling: hasChangeling,
    isAllCreatureTypes: false, // computed at Layer 4 based on whether changeling is present at that point
    isAllLandTypes: false,
    opponentsControlEffects: [], // track effects that say "your opponents control"
    abilitiesRemovedBy305_7: false,
    allAbilitiesRemoved: false, // set when REMOVE_ABILITIES strips all abilities from this permanent
    oracleTextModified: false,
    copySource: null,
    cdaUserValue: null,
    counters: { ...(permanent.counters || {}) },
    traits: [...(permanent.traits || [])], // special traits like "Has all card names"
    allPrintedAbilities: allPrinted, // full list including conditional for display
    conditionalAbilityIndices: condIndices || null,
    conditionalAbilityConditions: permanent._conditionalAbilityConditions || null,
    sagaChapterThresholds: permanent._sagaChapterThresholds || null,
    classLevelThresholds: permanent._classLevelThresholds || null,
    classLevel: permanent.classLevel || null,
    levelerData: permanent._levelerData || null,
    spacecraftData: permanent._spacecraftData || null,
    owner: permanent.owner || 'player_0',
    // Always start from owner, not from permanent.controller. The engine writes back the
    // computed controller to permanent.controller after Layer 2 (for UI use), so reading it
    // back here would make the base state already "post-control-effect", which means the
    // CONTROL effect would produce no delta and Layer 2 would show as unmodified.
    // Starting from owner is the correct base: Layer 2 effects then apply on top.
    controller: permanent.owner || 'player_0',
    tapped: permanent.tapped || false,
    isCommander: (() => {
      if (typeof Battlefield === 'undefined' || !Battlefield.isCommander) return false;
      if (Battlefield.isCommander(permanent.id)) return true;
      // If this permanent is in a mutate stack, check if any card in the stack is a commander
      const stack = Battlefield.getStack ? Battlefield.getStack(permanent.id) : null;
      if (stack) return stack.some(id => Battlefield.isCommander(id));
      return false;
    })(),
  };
}
