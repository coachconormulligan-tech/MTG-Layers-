/* engine-bestow-mutate.js — special-mechanic layer hooks called from engine-layer.js.

   Public functions:
     _applyBestowLayer4(Battlefield, allStates, inspectedId, layerResult)
     _applyMutateLayer1(Battlefield, allStates, inspectedId, layerResult)
     _reParseAfterTextChange(allStates, allPermanents, currentEffects) → effects[]

   Extracted from engine-helpers.js. */

/* Helper: apply bestow at end of Layer 4 (CR 702.102).
   When a bestow creature has an active bestow target, it loses Creature type,
   loses creature subtypes, retains Enchantment, gains Aura subtype,
   and gains "Enchant creature" ability. */
function _applyBestowLayer4(Battlefield, allStates, inspectedId, layerResult) {
  if (typeof Battlefield === 'undefined' || !Battlefield.bestowTargets || !Battlefield.bestowTargets.size) return;
  for (const [bestowPermId, targetPermId] of Battlefield.bestowTargets) {
    const st = allStates.get(bestowPermId);
    if (!st) continue;
    const targetPerm = Battlefield.permanents && Battlefield.getPermById(targetPermId);
    if (!targetPerm) continue; // target gone — bestow reverts (skip)

    const beforeTypes = [...st.types];
    const beforeSubtypes = [...st.subtypes];
    const beforeAbilities = [...st.abilities];

    // Remove Creature type
    const creatureIdx = st.types.indexOf('Creature');
    if (creatureIdx >= 0) st.types.splice(creatureIdx, 1);

    // Ensure Enchantment type is present
    if (!st.types.includes('Enchantment')) st.types.push('Enchantment');

    // Remove creature subtypes (CR 702.102: loses all creature types)
    const creatureSubtypes = (typeof TypeCatalog !== 'undefined') ? TypeCatalog.creatureTypes : new Set();
    st.subtypes = st.subtypes.filter(s => !creatureSubtypes.has(s));

    // Add Aura subtype if not present
    if (!st.subtypes.includes('Aura')) st.subtypes.push('Aura');

    // Add "Enchant creature" ability if not present
    if (!st.abilities.some(a => /^enchant creature$/i.test(a))) {
      st.abilities.push('Enchant creature');
    }

    if (bestowPermId === inspectedId) {
      const targetName = targetPerm.name || targetPermId;
      const changes = [];
      if (JSON.stringify(beforeTypes) !== JSON.stringify(st.types)) {
        changes.push('Types: [' + beforeTypes.join(', ') + '] → [' + st.types.join(', ') + ']');
      }
      if (JSON.stringify(beforeSubtypes) !== JSON.stringify(st.subtypes)) {
        changes.push('Subtypes: [' + beforeSubtypes.join(', ') + '] → [' + st.subtypes.join(', ') + ']');
      }
      const addedAbs = st.abilities.filter(a => !beforeAbilities.includes(a));
      if (addedAbs.length) changes.push('Gained abilities: ' + addedAbs.join('; '));
      changes.push('P/T cleared (no longer a creature).');
      layerResult.applicationLog.push({
        source: 'Bestow (enchanting ' + targetName + ')',
        timestamp: Battlefield.getPermById(bestowPermId)?.timestamp || 0,
        reason: 'CR 702.102: While enchanting a creature via bestow, this card is an Aura enchantment, not a creature. It loses all creature subtypes and gains "Enchant creature".',
        changes,
      });
    }
  }
}


/* Helper: apply mutate stacks within Layer 1 (after COPY effects).
   CR 702.140: Top card's name/types/P/T are authoritative; ability pools merged.
   Called from both the "has effects" and "no effects" paths of Layer 1. */
function _applyMutateLayer1(Battlefield, allStates, inspectedId, layerResult) {
  if (typeof Battlefield === 'undefined' || !Battlefield.mutateStacks || !Battlefield.mutateStacks.length) return;
  for (const stack of Battlefield.mutateStacks) {
    if (stack.length < 2) continue;
    const topState = allStates.get(stack[0]);
    if (!topState) continue;

    const topName = topState.name;
    const topTypes = [...topState.types];
    const topSupertypes = [...topState.supertypes];
    const topSubtypes = [...topState.subtypes];
    const topPower = topState.power;
    const topToughness = topState.toughness;

    const mergedAbilities = [];
    const seen = new Set();
    for (const permId of stack) {
      const st = allStates.get(permId);
      if (!st) continue;
      for (const ab of st.abilities) {
        const abL = ab.toLowerCase().trimStart();
        const allowDup = /^(?:at|when|whenever)\b/.test(abL) ||
          /\bat the beginning\b|\bwhenever\b|\bwhen you do\b/i.test(abL) ||
          /^ward\b/i.test(ab);
        if (allowDup || !seen.has(ab)) { seen.add(ab); mergedAbilities.push(ab); }
      }
    }

    for (const permId of stack) {
      const st = allStates.get(permId);
      if (!st) continue;
      const beforeName = st.name;
      const beforeAbilities = [...st.abilities];
      st.name = topName;
      st.types = [...topTypes];
      st.supertypes = [...topSupertypes];
      st.subtypes = [...topSubtypes];
      st.power = topPower;
      st.toughness = topToughness;
      st.abilities = [...mergedAbilities];
      // Also sync oracleText to the merged abilities so Layer 3 text-change effects
      // that target any member of this stack operate on the full merged ability pool.
      st.oracleText = mergedAbilities.join('\n');

      if (permId === inspectedId) {
        const topPerm = Battlefield.getPermById(stack[0]);
        const stackNames = stack.map(id => {
          const p = Battlefield.getPermById(id);
          return p ? p.name : id;
        });
        const changes = [];
        if (beforeName !== st.name) changes.push('Name: "' + beforeName + '" → "' + st.name + '"');
        const addedAbs = mergedAbilities.filter(a => !beforeAbilities.includes(a));
        if (addedAbs.length) changes.push('Gained abilities from stack: ' + addedAbs.join('; '));
        layerResult.applicationLog.push({
          source: 'Mutate Stack (' + stackNames.join(' / ') + ')',
          timestamp: topPerm ? topPerm.timestamp : 0,
          reason: 'CR 702.140: Top card’s name/types/P/T are used; all abilities in the stack are merged. Stack order (top→bottom): ' + stackNames.join(', ') + '.',
          changes,
        });
      }
    }
  }
}

function _reParseAfterTextChange(allStates, allPermanents, currentEffects) {
  const modifiedSources = new Set();
  for (const [id, state] of allStates) {
    if (state.oracleTextModified) modifiedSources.add(id);
  }
  if (modifiedSources.size === 0) return currentEffects;

  // Collect targetId from removed effects so re-parsed effects inherit the same target.
  // An Aura like Living Terrain has its targetId set by the UI when the user picks
  // the enchanted permanent.  Re-parsing produces fresh effects with no targetId,
  // which makes them silently stop applying.
  const removedTargetIds = new Map(); // sourceId → targetId
  for (const eff of currentEffects) {
    if (modifiedSources.has(eff.sourceId) && !['1', '2', '3'].includes(eff.layer) &&
        eff.scope === 'targeted' && eff.targetId && !eff.selfTarget) {
      removedTargetIds.set(eff.sourceId, eff.targetId);
    }
  }

  // When an exchange-text permanent is part of a mutate stack, other stack members contribute
  // abilities to the same "permanent" — their text box was also exchanged away. Remove their
  // Layer 4+ effects too (without re-parsing them with stale text).
  const stackSiblingRemoveSources = new Set();
  for (const id of modifiedSources) {
    const state = allStates.get(id);
    if (state && state.textExchangedTo != null &&
        typeof Battlefield !== 'undefined' && Battlefield.getStack) {
      const stack = Battlefield.getStack(id);
      if (stack) {
        for (const memberId of stack) {
          if (memberId !== id && !modifiedSources.has(memberId)) {
            stackSiblingRemoveSources.add(memberId);
          }
        }
      }
    }
  }

  const updated = [];
  for (const eff of currentEffects) {
    const inModified = modifiedSources.has(eff.sourceId);
    const inSibling = stackSiblingRemoveSources.has(eff.sourceId);
    if ((!inModified && !inSibling) || ['1', '2', '3'].includes(eff.layer)) {
      updated.push(eff);
    }
    // Preserve CDA_PT, SWITCH_PT, and counter effects  —  not text-dependent
    else if ((inModified || inSibling) &&
             (eff.type === EFFECT_TYPE.CDA_PT || eff.type === EFFECT_TYPE.SWITCH_PT || eff._isCounterEffect)) {
      updated.push(eff);
    }
  }

  for (const id of modifiedSources) {
    const state = allStates.get(id);
    const perm = allPermanents.find(p => p.id === id);
    if (!perm || !state) continue;

    const fakeCard = {
      name: state.name,
      oracle_text: state.oracleText,
      type_line: perm.scryfallData?.type_line || [...state.supertypes, ...state.types].join(' ') + (state.subtypes.length ? ' — ' + state.subtypes.join(' ') : ''),
      colors: state.colors,
      cmc: state.manaValue,
    };
    // Re-parse modified text. Known abilities are matched by ability text (not card name),
    // so they will correctly match abilities in the modified/copied oracle text.
    if (typeof parseCardEffects === 'function') {
      const savedTargetId = removedTargetIds.get(id);
      const newEffects = parseCardEffects(perm, fakeCard);
      for (const ne of newEffects) {
        if (!['1', '2', '3'].includes(ne.layer)) {
          // Carry over the targetId from the original effects so the re-parsed
          // effects continue to apply to the same permanent (e.g. enchanted land).
          if (savedTargetId && ne.scope === 'targeted' && !ne.selfTarget && !ne.targetId) {
            ne.targetId = savedTargetId;
          }
          // Mark as re-parsed so _effectiveSourceId doesn't remap via textExchangedTo —
          // re-parsed effects already have the correct sourceId for the current text carrier.
          ne._reparsedEffect = true;
          updated.push(ne);
        }
      }
    }
  }

  return updated;
}
