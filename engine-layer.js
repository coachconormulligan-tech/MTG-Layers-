/* engine-layer.js — applyLayerGlobal, applyEffectGlobally, evaluatePermanent. */

// After Layer 4, re-stamp Equipped/Enchanted traits using computed subtypes.
// The pre-layer pass uses printedSubtypes; this catches runtime Aura↔Equipment gains.
function _reStampAttachmentTraits(workingEffects, allStates) {
  const seenPairs = new Set();
  for (const eff of workingEffects) {
    if (!eff.targetId || eff.selfTarget) continue;
    const key = `${eff.sourceId}:${eff.targetId}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const sourceState = allStates.get(eff.sourceId);
    const targetState = allStates.get(eff.targetId);
    if (!sourceState || !targetState) continue;
    const computedSubs = sourceState.subtypes || [];
    if (computedSubs.includes('Equipment') && !targetState.traits.includes('Equipped')) {
      targetState.traits.push('Equipped');
    }
    if (computedSubs.includes('Aura') && !targetState.traits.includes('Enchanted')) {
      targetState.traits.push('Enchanted');
    }
  }
}

function applyLayerGlobal(effects, allStates, allPermanents, inspectedId, appliedSourceIds, abilityGroupAffectedPerms, abilityGroupRejectedPerms) {
  const realPerms = allPermanents.filter(p => !p.isManualEffect);
  const log = [];
  const logReasons = {}; // maps log-entry text → human-readable reason string
  const applicationLog = [];
  let remaining = [...effects];
  let iteration = 0;
  const MAX_ITER = 50;

  while (remaining.length > 0 && iteration < MAX_ITER) {
    iteration++;

    // Step 1: detect dependencies using CURRENT global state. appliedSourceIds (sources that
    // already applied in an earlier layer) lets the source-viability check distinguish a grant
    // that is locked in (CR 613.7a, no dependency) from one that genuinely dies when its source
    // loses abilities (creates a dependency).
    const deps = detectDependenciesGlobal(remaining, allStates, realPerms, appliedSourceIds);

    // Step 2: remove loops
    const { cleaned, loopNodes } = removeLoopDependencies(deps);
    if (loopNodes.size > 0) {
      const loopNames = [...loopNodes].map(i => `"${remaining[i] ? _effectDisplayName(remaining[i], allStates) : '?'}"`).join(', ');

      // Build one interaction sentence per loop edge to explain why the loop exists
      const loopEdges = deps.filter(d => loopNodes.has(d.dependent) && loopNodes.has(d.dependsOn));
      const interactionParts = [];
      for (const edge of loopEdges) {
        const effA = remaining[edge.dependent]; // A depends on B
        const effB = remaining[edge.dependsOn]; // B influences A
        if (effA && effB) {
          const reason = getDependencyReason(effA, effB, allStates, realPerms);
          interactionParts.push(reason.split('\n\n')[0]);
        }
      }
      const interactionDesc = interactionParts.length > 0
        ? interactionParts.join(' ') + '\n\n'
        : '';

      const key = `Dependency loop: ${loopNames}: applied in timestamp order (CR 613.8).`;
      if (!log.includes(key)) {
        log.push(key);
        logReasons[key] =
          `A dependency loop (circular dependency) was detected among these effects: ${loopNames}.\n\n` +
          interactionDesc +
          `Each effect's outcome depends on the other(s), so the rules cannot establish a unique ordering.\n\n` +
          `CR 613.8 resolves this by applying all effects in the loop in timestamp order.`;
      }
    }

    if (cleaned.length > 0) {
      // Log dependencies discovered in this iteration (chains may span multiple iterations)
      for (const d of cleaned) {
        const depEff = remaining[d.dependent];
        const onEff  = remaining[d.dependsOn];
        const dd  = `"${depEff ? _effectDisplayName(depEff, allStates) : '?'}" depends on "${onEff ? _effectDisplayName(onEff, allStates) : '?'}"`;
        const key = `Dependency: ${dd}`;
        if (!log.includes(key)) {
          log.push(key);
          // Compute an explanation for the '?' popup in the layer inspector
          if (depEff && onEff) {
            logReasons[key] = getDependencyReason(depEff, onEff, allStates, realPerms);
          }
        }
      }
    }

    // Step 3: timestamp order
    const indexed = remaining.map((e, i) => ({ effect: e, idx: i }));
    indexed.sort((a, b) => a.effect.timestamp - b.effect.timestamp);

    // Step 4: first effect with no unresolved dependencies
    let chosen = null;
    let chosenIdx = -1;
    for (const { effect, idx } of indexed) {
      if (!cleaned.some(d => d.dependent === idx)) {
        chosen = effect;
        chosenIdx = remaining.indexOf(effect);
        break;
      }
    }

    if (!chosen) {
      // Fallback: all have deps  —  apply in timestamp order
      log.push('Fallback: remaining effects applied in timestamp order.');
      const sorted = [...remaining].sort((a, b) => a.timestamp - b.timestamp);
      for (const eff of sorted) {
        applyEffectGlobally(eff, allStates, realPerms, inspectedId, applicationLog, log, appliedSourceIds, abilityGroupAffectedPerms, abilityGroupRejectedPerms);
      }
      break;
    }

    // Step 5: remove chosen from remaining
    remaining.splice(chosenIdx, 1);

    // Step 6: apply chosen to ALL matching permanents
    applyEffectGlobally(chosen, allStates, realPerms, inspectedId, applicationLog, log, appliedSourceIds, abilityGroupAffectedPerms, abilityGroupRejectedPerms);

    // Step 7: loop  —  re-detect deps with fresh global state
  }

  if (remaining.length === 0 && log.length === 0) {
    log.push('No dependencies detected. Applied in timestamp order.');
  }

  return { log, logReasons, applicationLog };
}

/* Apply one effect to every matching permanent. Log changes for inspected. */
function applyEffectGlobally(effect, allStates, realPerms, inspectedId, applicationLog, log, appliedSourceIds, abilityGroupAffectedPerms, abilityGroupRejectedPerms) {
  // Source-viability: if source lost abilities (305.7 or REMOVE_ABILITIES), effect is dead
  // EXCEPTION: If this source already applied effects in an earlier layer, the entire ability
  // continues to apply even if the source lost its ability in a later layer (CR 613.7a).
  // This covers cases like Bello making an artifact into a creature (layer 4), then Bello
  // losing abilities (layer 6) — the artifact still gets the abilities and P/T from Bello.
  if (!isSourceViable(effect, allStates)) {
    const alreadyAppliedEarlier = appliedSourceIds && appliedSourceIds.has(effect.sourceId);
    // CDA_PT is an intrinsic ability: if the source lost ALL its abilities (via 305.7
    // OR a REMOVE_ABILITIES effect like Humility/Darksteel Mutation), the CDA no longer
    // exists and cannot define P/T — regardless of whether the source applied effects in
    // earlier layers. CR 613.7a's "already applied" exemption does not rescue a CDA whose
    // defining ability has been erased; there is simply nothing left to set P/T.
    const srcState = allStates.get(effect.sourceId);
    const is305_7 = srcState && srcState.abilitiesRemovedBy305_7;
    const abilitiesGone = is305_7 || !!(srcState && srcState.allAbilitiesRemoved);
    const cdaBlocked = effect.type === EFFECT_TYPE.CDA_PT && abilitiesGone;
    if (!alreadyAppliedEarlier || cdaBlocked) {
      const displayName = _effectDisplayName(effect, allStates);
      const reasonText = is305_7
        ? `Rule 305.7: "${displayName}" lost its abilities`
        : `"${displayName}" lost all abilities`;
      const effSrcIdSkip = _effectiveSourceId(effect, allStates);
      applicationLog.push({
        source: allStates.get(effSrcIdSkip)?.name || effect.sourceName,
        sourceId: effSrcIdSkip, timestamp: effect.timestamp,
        reason: `${reasonText} \u2014 effect no longer exists.`,
        changes: [],
      });
      log.push(`Skipped "${displayName}" \u2014 source lost abilities.`);
      return;
    }
  }

  let appliedAnywhere = false;
  let appliedToInspected = false;
  let inspectedChanges = [];

  // Context for exchange_text guard: tracks which exchange effects have already swapped
  const applyContext = { exchangeApplied: new Set() };

  for (const perm of realPerms) {
    const state = allStates.get(perm.id);
    if (!state) continue;

    // CR 613: If an earlier layer of this ability already rejected this permanent,
    // the rest of the ability does not apply to it either.
    if (abilityGroupRejectedPerms && effect.abilityGroupId &&
        abilityGroupRejectedPerms.get(effect.abilityGroupId)?.has(perm.id)) continue;

    if (!effectAppliesToPerm(effect, state, perm, perm.id, allStates, abilityGroupAffectedPerms)) {
      // Record the rejection so subsequent layers of this ability also skip this permanent.
      if (abilityGroupRejectedPerms && effect.abilityGroupId) {
        const alreadyAffected = abilityGroupAffectedPerms?.get(effect.abilityGroupId)?.has(perm.id);
        if (!alreadyAffected) {
          if (!abilityGroupRejectedPerms.has(effect.abilityGroupId)) {
            abilityGroupRejectedPerms.set(effect.abilityGroupId, new Set());
          }
          abilityGroupRejectedPerms.get(effect.abilityGroupId).add(perm.id);
        }
      }
      continue;
    }

    // For exchange text effects, attach allStates so the handler can swap between permanents
    if (effect.type === EFFECT_TYPE.TEXT_CHANGE &&
        (effect.params.changeType === 'exchange_text' || effect.params.changeType === 'volrath_text')) {
      effect._allStates = allStates;
    }

    // For exchange control effects, attach allStates so the handler can swap both permanents
    if (effect.type === EFFECT_TYPE.CONTROL && effect.params.exchangeControl) {
      effect._allStates = allStates;
    }

    // For "you control enchanted/equipped" aura effects, attach allStates so the handler
    // can resolve the current controller of the source dynamically (CR: "you" = current controller).
    if (effect.type === EFFECT_TYPE.CONTROL && effect.params.useSourceController) {
      effect._allStates = allStates;
    }

    // For GAIN_ACTIVATED_FROM_OTHERS, attach allStates so it can scan other permanents
    if (effect.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS) {
      effect._allStates = allStates;
    }

    // For CDA_PT, attach allStates and cdaUserValue so the handler can compute
    if (effect.type === EFFECT_TYPE.CDA_PT) {
      effect._allStates = allStates;
      // Read user-supplied CDA value from the permanent's stored data
      const permObj = realPerms.find(p => p.id === perm.id);
      if (permObj && permObj.cdaUserValue !== undefined) {
        state.cdaUserValue = permObj.cdaUserValue;
      }
    }

    // For REMOVE_TYPE with devotion condition, attach allStates
    if (effect.type === EFFECT_TYPE.REMOVE_TYPE && effect.params.devotionCondition) {
      effect._allStates = allStates;
    }

    // For SET_PT with dynamic count, attach allStates
    if (effect.type === EFFECT_TYPE.SET_PT && effect.params.useCountOf !== undefined) {
      effect._allStates = allStates;
    }

    // For COPY of a permanent that is itself a copy, attach allStates so the COPY case can
    // re-derive copiable values from the source's live Layer-1 state (CR 707.2 copy-of-copy).
    if (effect.type === EFFECT_TYPE.COPY && effect.params._copyTargetPermId) {
      effect._allStates = allStates;
    }

    // For MODIFY_PT with "for each" variable boost, attach allStates
    if (effect.type === EFFECT_TYPE.MODIFY_PT && effect.params.forEachDesc !== undefined) {
      effect._allStates = allStates;
      const permObj = realPerms.find(p => p.id === perm.id);
      if (permObj && permObj.cdaUserValue !== undefined) {
        state.cdaUserValue = permObj.cdaUserValue;
      }
    }

    // For ADD_ABILITY with xSource (e.g. Bludgeon Brawl), attach allStates so the handler
    // can resolve source-based dynamic values like source_power.
    if (effect.type === EFFECT_TYPE.ADD_ABILITY && effect.params.xSource) {
      effect._allStates = allStates;
    }

    // For runtime-gained Equipment tracking effects, attach allStates so the engine can read
    // the source equipment's computed abilities (e.g. "Equipped creature gets +2/+0" granted
    // by Armed with Proof) rather than the fixed +0/+0 placeholder in the effect's params.
    if (effect._isEquipTargetEff) {
      effect._allStates = allStates;
    }

    const changes = applyEffect(state, effect, applyContext);
    appliedAnywhere = true;

    // If a non-exchange CONTROL effect changed this permanent's controller, propagate
    // the new controller to all other cards in its mutate stack — the whole stack
    // represents one permanent and must be controlled by the same player.
    if (effect.type === EFFECT_TYPE.CONTROL && !effect.params.exchangeControl &&
        typeof Battlefield !== 'undefined' && Battlefield.getStack) {
      const permStack = Battlefield.getStack(perm.id);
      if (permStack && permStack.length > 1) {
        const newController = state.controller;
        for (const stackMemberId of permStack) {
          if (stackMemberId === perm.id) continue;
          const memberState = allStates.get(stackMemberId);
          if (memberState && memberState.controller !== newController) {
            memberState.controller = newController;
          }
        }
      }
    }

    // Track that this source has successfully applied effects (for cross-layer ability persistence).
    // A COPY effect (Layer 1) is excluded: it establishes the permanent's copiable values, it is
    // NOT a granted continuous effect that "locks in" under CR 613.7a. Counting it would wrongly
    // exempt the copy's OTHER abilities from source-viability — e.g. a Clone copying Lord of
    // Atlantis then Frogified would keep granting "+1/+1 and islandwalk" to other Merfolk even
    // after Frogify removes the copy's abilities. A copy of a genuinely multi-layer ability still
    // gets the exemption via that ability's own earlier-layer (non-COPY) effects.
    if (appliedSourceIds && effect.sourceId && effect.type !== EFFECT_TYPE.COPY) {
      appliedSourceIds.add(effect.sourceId);
    }

    // CR 613: Track which permanents this ability group has affected.
    // Later effects in the same group will bypass the appliesTo filter for these permanents.
    if (abilityGroupAffectedPerms && effect.abilityGroupId) {
      if (!abilityGroupAffectedPerms.has(effect.abilityGroupId)) {
        abilityGroupAffectedPerms.set(effect.abilityGroupId, new Set());
      }
      abilityGroupAffectedPerms.get(effect.abilityGroupId).add(perm.id);
    }

    if (perm.id === inspectedId) {
      appliedToInspected = true;
      inspectedChanges = changes;
    }
  }

  // Resolve the effective source: accounts for text exchange (Exchange of Words) and
  // mutation (top card's name). After an exchange, the ability now lives on the other permanent.
  const effSrcId = _effectiveSourceId(effect, allStates);
  const computedSourceName = allStates.get(effSrcId)?.name || effect.sourceName;

  if (inspectedChanges.length > 0) {
    const displayName = _effectDisplayName(effect, allStates);
    applicationLog.push({
      source: computedSourceName, sourceId: effSrcId, timestamp: effect.timestamp,
      reason: effect.desc || `Effect from "${displayName}"`,
      changes: inspectedChanges,
    });
    log.push(`Applied "${displayName}" (ts:${effect.timestamp})`);
  } else if (appliedToInspected) {
    // Effect targets this permanent but produces no state change (e.g. CONTROL effect where
    // the permanent is already controlled by the correct player). Still show it in the inspector
    // so the user can see the Layer 2 effect is present even when it has no visible delta.
    const displayName = _effectDisplayName(effect, allStates);
    applicationLog.push({
      source: computedSourceName, sourceId: effSrcId, timestamp: effect.timestamp,
      reason: effect.desc || `Effect from "${displayName}"`,
      changes: [],
      appliedToInspected: true,
    });
    log.push(`Applied "${displayName}" (ts:${effect.timestamp})`);
  } else if (appliedAnywhere) {
    const displayName = _effectDisplayName(effect, allStates);
    applicationLog.push({
      source: computedSourceName, sourceId: effSrcId, timestamp: effect.timestamp,
      reason: `${effect.desc || displayName} (affected other permanents, not inspected)`,
      changes: [],
    });
    log.push(`Applied "${displayName}" (ts:${effect.timestamp}) — affected other permanents.`);
  } else {
    // Effect is in this layer but matched no permanents currently on the battlefield.
    // Still record it so "show all" mode can display it.
    const displayName = _effectDisplayName(effect, allStates);
    applicationLog.push({
      source: computedSourceName, sourceId: effSrcId, timestamp: effect.timestamp,
      reason: `${effect.desc || displayName} (no matching permanents)`,
      changes: [],
    });
    log.push(`Applied "${displayName}" (ts:${effect.timestamp}) — no matching permanents.`);
  }
}
/* [END: DEPENDENCY] */

/* [KEY: EVALUATE]  —  Full GLOBAL evaluation pipeline.
   Builds states for ALL permanents, then applies effects layer-by-layer
   across the entire battlefield. Returns result for the inspected permanent. */
function evaluatePermanent(permanent, allPermanents, allEffects, inspectedId) {
  // Build mutable states for ALL real permanents
  const allStates = new Map();
  for (const p of allPermanents) {
    if (p.isManualEffect) continue;
    const st = createBaseState(p);
    if (p.isSpell) st.isSpell = true;
    allStates.set(p.id, st);
  }

  // Mutate is applied at the end of Layer 1, after COPY effects.
  // See _applyMutateInLayer1 below.

  const result = {
    base: allStates.has(inspectedId) ? snapshotState(allStates.get(inspectedId)) : createBaseState(permanent),
    layers: [],
  };

  // Working copy of effects  —  may be mutated after Layer 3 text changes
  // Shallow-copy each effect object so mutations (bestow redirect, text-change) don't affect originals
  // Filter out disabled modal effects (user toggled off), then shallow-copy
  // For repeatable modal modes, duplicate effects per their mode count
  let workingEffects = [];
  for (const e of allEffects) {
    if (e.disabled) continue;
    if (e.modalModeIndex !== undefined) {
      const srcPerm = allPermanents.find(p => p.id === e.sourceId);
      if (srcPerm && srcPerm.modalRepeatable && srcPerm.modalModeCounts) {
        const count = srcPerm.modalModeCounts[e.modalModeIndex] ?? 0;
        for (let i = 0; i < count; i++) workingEffects.push({ ...e });
        continue;
      }
    }
    workingEffects.push({ ...e });
  }

  // Set "Equipped" / "Enchanted" traits on targeted permanents based on source type
  const permById = new Map();
  for (const p of allPermanents) { if (!p.isManualEffect) permById.set(p.id, p); }

  // BESTOW (CR 702.102): Redirect bestow card's self-targeting effects to the enchanted creature.
  // The bestow card's effects were parsed as creature effects (selfTarget: true, no targetId).
  // When bestowed, they should apply to the enchanted creature, like an Aura's effects.
  if (typeof Battlefield !== 'undefined' && Battlefield.bestowTargets && Battlefield.bestowTargets.size) {
    for (const [bestowPermId, targetPermId] of Battlefield.bestowTargets) {
      if (!permById.get(targetPermId)) continue;
      const targetState = allStates.get(targetPermId);
      if (!targetState) continue;
      // Add "Enchanted" trait to the bestow target
      if (!targetState.traits.includes('Enchanted')) targetState.traits.push('Enchanted');
      // Redirect this bestow perm's self-targeting effects to the enchanted creature.
      // Counter effects (_isCounterEffect) are NOT redirected: counters stay on the card
      // they're placed on, so a bestowed card's +1/+1 counters apply only to itself
      // (which has no P/T as an Aura), not to the enchanted creature.
      for (const eff of workingEffects) {
        if (eff.sourceId !== bestowPermId) continue;
        if (eff._isCounterEffect) continue; // counters stay on the bestow card
        if (eff.selfTarget || (!eff.targetId && eff.scope === 'targeted')) {
          eff.selfTarget = false;
          eff.targetId = targetPermId;
        }
      }
    }
  }

  // MUTATE (CR 702.140): In a mutate stack, all cards are treated as one permanent.
  // (a) Counters on any non-top card redirect to the top card.
  // (b) External effects (equipment/aura/other) targeting a non-top card redirect to the top card.
  if (typeof Battlefield !== 'undefined' && Battlefield.mutateStacks && Battlefield.mutateStacks.length) {
    for (const stack of Battlefield.mutateStacks) {
      if (stack.length < 2) continue;
      const topId = stack[0];
      for (let i = 1; i < stack.length; i++) {
        const nonTopId = stack[i];
        for (const eff of workingEffects) {
          if (eff.sourceId === nonTopId) {
            // Effect originates FROM a non-top card
            if (!eff._isCounterEffect) continue;
            // Redirect own counter effects to the top card
            eff.selfTarget = false;
            eff.targetId = topId;
          } else if (eff.targetId === nonTopId) {
            // External effect targeting a non-top card — redirect to top (CR 702.140).
            // Exception: TEXT_CHANGE effects remain targeting their original permanent;
            // effectAppliesToPerm applies them to all stack members (Bug 1 fix).
            if (eff.type !== EFFECT_TYPE.TEXT_CHANGE) {
              eff.targetId = topId;
            }
          }
        }
      }
    }
  }


  // RECONFIGURE (CR 702.151): When a permanent with reconfigure is attached to a creature
  // (has a targeted effect with a targetId set), it stops being a creature.
  // Inject a self-targeting REMOVE_TYPE effect to remove the Creature type.
  const reconfigureSourceIds = new Set();
  for (const eff of workingEffects) {
    if (!eff.targetId || eff.selfTarget) continue;
    if (reconfigureSourceIds.has(eff.sourceId)) continue;
    const sourcePerm = permById.get(eff.sourceId);
    if (!sourcePerm) continue;
    if (!(sourcePerm.printedSubtypes || []).includes('Equipment')) continue;
    // Check if this source has reconfigure in its abilities
    const hasReconfigure = (sourcePerm.oracleText || '').toLowerCase().includes('reconfigure');
    if (!hasReconfigure) continue;
    reconfigureSourceIds.add(eff.sourceId);
    // Inject a REMOVE_TYPE effect for Creature on the reconfigure source itself
    workingEffects.push({
      id: `${eff.sourceId}_reconfigure_remove_creature`,
      sourceId: eff.sourceId,
      sourceName: sourcePerm.name,
      type: EFFECT_TYPE.REMOVE_TYPE,
      layer: '4',
      params: { types: ['Creature'] },
      scope: 'targeted',
      selfTarget: true,
      timestamp: sourcePerm.timestamp,
      _isReconfigureEffect: true,
    });
  }


  for (const eff of workingEffects) {
    if (!eff.targetId || eff.selfTarget) continue;
    const sourcePerm = permById.get(eff.sourceId);
    if (!sourcePerm) continue;
    const targetState = allStates.get(eff.targetId);
    if (!targetState) continue;
    const srcSubs = sourcePerm.printedSubtypes || [];
    if (srcSubs.includes('Equipment') && !targetState.traits.includes('Equipped')) {
      targetState.traits.push('Equipped');
    }
    if (srcSubs.includes('Aura') && !targetState.traits.includes('Enchanted')) {
      targetState.traits.push('Enchanted');
    }
    // Synthetic equip-tracking effects (_isEquipTargetEff) are created when the user activates
    // an equip/reconfigure/fortify ability. The source may have gained Equipment subtype via a
    // Layer 4 effect (e.g. Armed with Proof making Clues Equipment), so printedSubtypes alone
    // is not sufficient. Mark the target Equipped whenever an explicit equip activation is present.
    if (eff._isEquipTargetEff && !targetState.traits.includes('Equipped')) {
      targetState.traits.push('Equipped');
    }
  }
  // Also update result.base if the inspected perm is targeted
  const inspectedBase = allStates.get(inspectedId);
  if (inspectedBase) {
    result.base.traits = [...inspectedBase.traits];
  }

  // (Exchange guard is now handled via context in applyEffectGlobally, not effect mutation)

  // Track which source IDs have successfully applied effects in earlier layers.
  // If an ability caused an earlier-layer change, all effects from that ability
  // continue to apply even if the source loses its abilities in a later layer.
  const appliedSourceIds = new Set();

  // CR 613: Track which permanents each ability group has affected or rejected.
  // Once any part of a continuous effect applies to a permanent, all other parts also apply.
  // Once any part fails to apply to a permanent, later parts also do not apply.
  const abilityGroupAffectedPerms = new Map(); // abilityGroupId → Set<permId>
  const abilityGroupRejectedPerms = new Map(); // abilityGroupId → Set<permId> rejected in earlier layers

  for (const layerDef of LAYERS) {
    const layerResult = {
      id: layerDef.id,
      name: layerDef.name,
      cr: layerDef.cr,
      active: layerDef.active,
      effects: [],
      orderLog: [],
      orderLogReasons: {},
      applicationLog: [],
      stateBefore: snapshotState(allStates.get(inspectedId)),
      stateAfter: null,
    };

    if (!layerDef.active) {
      layerResult.stateAfter = snapshotState(allStates.get(inspectedId));
      layerResult.orderLog.push('(Layer not yet active in MVP)');
      result.layers.push(layerResult);
      continue;
    }

    // ALL effects in this layer  —  do NOT pre-filter by applicability.
    const layerEffects = workingEffects.filter(e => e.layer === layerDef.id);

    // At the start of Layer 4, sync hasChangeling from current ability state.
    // isAllCreatureTypes is now set by the Changeling ADD_TYPE effect generated
    // in parseCardEffects(), so we don't initialize it here.
    if (layerDef.id === '4') {
      for (const [pid, st] of allStates) {
        st.hasChangeling = st.abilities.some(a => /\bchangeling\b/i.test(a));
      }
    }

    if (layerEffects.length === 0) {
      // For Layer 1, still apply mutate even if no COPY effects exist
      if (layerDef.id === '1') {
        _applyMutateLayer1(Battlefield, allStates, inspectedId, layerResult);
      }
      // For Layer 4, apply bestow even if no other type effects exist
      if (layerDef.id === '4') {
        _applyBestowLayer4(Battlefield, allStates, inspectedId, layerResult);
        _reStampAttachmentTraits(workingEffects, allStates);
      }
      layerResult.stateAfter = snapshotState(allStates.get(inspectedId));
      if (!layerResult.applicationLog.length) {
        layerResult.orderLog.push('No effects exist in this layer.');
      }
      result.layers.push(layerResult);
      // Post-Layer-3 re-parse
      if (layerDef.id === '3') {
        workingEffects = _reParseAfterTextChange(allStates, allPermanents, workingEffects);
      }
      continue;
    }

    // Apply with full CR 613.8 global dependency resolution
    const { log, logReasons, applicationLog } = applyLayerGlobal(
      layerEffects, allStates, allPermanents, inspectedId, appliedSourceIds, abilityGroupAffectedPerms, abilityGroupRejectedPerms
    );
    layerResult.orderLog = log;
    layerResult.orderLogReasons = logReasons;
    layerResult.applicationLog = applicationLog;

    // MUTATE (CR 702.140): Applied at end of Layer 1, after COPY effects.
    if (layerDef.id === '1') {
      _applyMutateLayer1(Battlefield, allStates, inspectedId, layerResult);
    }

    // BESTOW (CR 702.102): Applied at end of Layer 4, after other type effects.
    // Crew type gain is now handled via injected ADD_TYPE effects above.
    if (layerDef.id === '4') {
      _applyBestowLayer4(Battlefield, allStates, inspectedId, layerResult);
      _reStampAttachmentTraits(workingEffects, allStates);
    }

    // After Layer 2 (Control), write computed controller back to permanent objects
    // so subsequent getAllFinalStates calls and UI rendering see the updated controller.
    if (layerDef.id === '2' && typeof Battlefield !== 'undefined') {
      for (const [pid, st] of allStates) {
        const perm = Battlefield.getPermById(pid);
        if (perm && perm.controller !== st.controller) {
          perm.controller = st.controller;
        }
      }
    }

    layerResult.stateAfter = snapshotState(allStates.get(inspectedId));
    result.layers.push(layerResult);

    // After Layer 3 (Text), re-parse effects from permanents whose text was modified.
    // This implements the "refactoring" behavior: changed text → changed effects.
    if (layerDef.id === '3') {
      workingEffects = _reParseAfterTextChange(allStates, allPermanents, workingEffects);
    }
  }

  result.final = snapshotState(allStates.get(inspectedId));

  // Evaluate which conditional abilities have their conditions met
  // so the UI can show them as active/inactive
  const finalState = result.final;
  if (finalState.conditionalAbilityConditions && finalState.conditionalAbilityConditions.size > 0) {
    const metSet = new Set();
    const inspState = allStates.get(inspectedId);
    for (const [idx, condFn] of finalState.conditionalAbilityConditions) {
      try {
        if (condFn(inspState, allStates)) metSet.add(idx);
      } catch(e) { /* condition eval failed, leave as unmet */ }
    }
    result.final.conditionalAbilitiesMet = metSet;
    result.base.conditionalAbilitiesMet = metSet;
    // Propagate to layer stateAfter snapshots
    for (const layer of result.layers) {
      if (layer.stateAfter) layer.stateAfter.conditionalAbilitiesMet = metSet;
    }
  }

  // Snapshot every permanent's final state so callers can avoid re-running the pipeline.
  result.finalStates = new Map();
  for (const [pid, st] of allStates) {
    result.finalStates.set(pid, snapshotState(st));
  }

  return result;
}

/* Run the layer engine on a single card sitting in a non-battlefield zone (graveyard / exile /
   command zone). The throwaway permanent is flagged isZoneCard so effectAppliesToPerm only feeds
   it effects that function outside the battlefield, and its OWN appliesToNonBattlefieldZones
   statics (e.g. Grist, the Hunger Tide's "1/1 Insect creature while not on the battlefield") are
   parsed and injected — they aren't in Battlefield.effects because the card isn't on the board.
   This is the single source of truth shared by ui-zones' Details popup and by other-card checks
   that must read a zone card's COMPUTED characteristics (Volrath's Shapeshifter). */
let _zoneEvalDepth = 0;          // re-entrancy guard (see _isCreatureCardInZone)
const _zoneStateMemo = new Map(); // keyed by cacheVersion|name|zone within a single eval pass
function computeZoneCardState(card, zone) {
  const z = zone || 'graveyard';
  const cv = (typeof Battlefield !== 'undefined' && Battlefield._cacheVersion) || 0;
  const key = cv + '|' + (card && card.name) + '|' + z;
  if (_zoneStateMemo.has(key)) return _zoneStateMemo.get(key);
  _zoneEvalDepth++;
  let result = null;
  try {
    const perm = createPermanent(card, 0);
    perm.isZoneCard = true;
    perm.zone = z;
    perm.isManualEffect = false;
    let selfEffects = [];
    try {
      selfEffects = (parseCardEffects(perm, card) || []).filter(e => e.appliesToNonBattlefieldZones);
    } catch (e) { selfEffects = []; }
    const realPerms = (typeof Battlefield !== 'undefined' && Battlefield.permanents)
      ? Battlefield.permanents.filter(p => !p.isManualEffect) : [];
    const allEffects = (typeof Battlefield !== 'undefined' && Battlefield.effects) ? Battlefield.effects : [];
    result = evaluatePermanent(perm, [...realPerms, perm], [...allEffects, ...selfEffects], perm.id);
  } finally {
    _zoneEvalDepth--;
  }
  if (_zoneStateMemo.size > 200) _zoneStateMemo.clear();
  _zoneStateMemo.set(key, result);
  return result;
}

/* Does a card count as a creature card while in the given zone? Uses its computed zone state so
   cards that become creatures only outside the battlefield (Grist) are recognized. Short-circuits
   on the printed type line for the overwhelmingly common case, and bails to the printed answer
   when already inside a zone evaluation (prevents infinite recursion via Volrath's graveyard
   lookup re-evaluating the same graveyard card). */
function _isCreatureCardInZone(card, zone) {
  const printed = (typeof parseTypeLine === 'function') ? parseTypeLine((card && card.type_line) || '') : { types: [] };
  if (printed.types.includes('Creature')) return true;
  if (_zoneEvalDepth > 0) return false;
  const zr = computeZoneCardState(card, zone || 'graveyard');
  return !!(zr && zr.final && zr.final.types.includes('Creature'));
}

