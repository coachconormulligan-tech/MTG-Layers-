/* engine-deps.js — CR 613.8 dependency detection, loop resolution, scope checks. */

/* Module-private id→perm Map set by detectDependenciesGlobal for the duration of one
   dependency-detection pass. The N² loop below uses it via _findRealPerm to avoid
   doing N linear realPerms.find() scans per pair. Reset to null when the pass ends. */
let _realPermsByIdCache = null;
function _findRealPerm(realPerms, id) {
  if (_realPermsByIdCache) return _realPermsByIdCache.get(id);
  return realPerms.find(p => p.id === id);
}

/* [KEY: DEPENDENCY]
   CR 613.8  —  Global dependency detection and resolution.

   An effect A DEPENDS ON effect B if:
   (a) They apply in the same layer/sublayer, AND
   (b) Applying B would change whether A applies, what A applies to,
       or what A does to what it applies to  —  across ANY permanent, AND
   (c) Neither is a CDA, or both are CDAs.

   The engine evaluates GLOBALLY: it applies each chosen effect to
   ALL matching permanents, then re-detects dependencies with
   the updated global state.
*/

/* Does an effect apply to a specific permanent given its current state?
   `permId` is the permanent being tested (not necessarily the inspected one). */
function effectAppliesToPerm(effect, permState, permanent, permId, allStates, abilityGroupAffectedPerms) {
  // Zone-card / spell / permanent scope gate.
  // A zone card (exile / graveyard / command zone) is neither a permanent nor a stack
  // spell — it only receives effects flagged to reach cards outside the battlefield
  // (e.g. Mycosynth Lattice's colorless clause), never ordinary battlefield-targeted
  // effects like "All permanents are artifacts".
  if (permanent && permanent.isZoneCard) {
    if (!effect.appliesToNonBattlefieldZones) return false;
    if (effect.nonBattlefieldZones && !effect.nonBattlefieldZones.includes(permanent.zone)) return false;
  } else if (permanent && permanent.isSpell) {
    if (!effect.appliesToSpells) return false;
  } else if (effect.appliesToSpells && !effect.appliesToPermanents) {
    return false;
  }
  // Zone-card-only effects (e.g. Yixlid Jailer "Cards in graveyards lose all abilities")
  // must not reach battlefield permanents — only zone cards flagged appliesToNonBattlefieldZones.
  if (effect.zoneCardsOnly && permanent && !permanent.isZoneCard) return false;

  // Imprint preconditions: if the effect's value comes from an imprinted exile entry,
  // the effect is inactive (and shouldn't even appear in the inspector) when there's no
  // valid entry — no imprint, missing card data, or fails the requireCreature filter.
  // Covers Duplicant (fromImprintedCard*), Phyrexian Ingester (fromExiledCardPT).
  if (effect.params && typeof _getImprintedExileEntries === 'function' &&
      (effect.params.fromImprintedCardPT || effect.params.fromImprintedCardCreatureTypes || effect.params.fromExiledCardPT)) {
    const entries = _getImprintedExileEntries(effect.sourceId);
    const last = entries.length ? entries[entries.length - 1] : null;
    if (!last || !last.card) return false;
    if (effect.params.requireCreature) {
      const parsed = typeof parseTypeLine === 'function'
        ? parseTypeLine(last.card.type_line || '') : { types: [] };
      if (!parsed.types.includes('Creature')) return false;
    }
  }

  // "For each" boosts whose count is currently 0 (e.g. Strata Scythe with no matching lands):
  // hide the layer row entirely rather than showing an inert +0/+0 entry. Only suppress when
  // the count is genuinely 0 — non-numeric / null falls through to the normal flow.
  if (effect.type === EFFECT_TYPE.MODIFY_PT && effect.params && effect.params.forEachDesc !== undefined &&
      typeof _computeForEachCount === 'function' && allStates) {
    const val = _computeForEachCount(effect.params.forEachDesc, allStates, permState, effect);
    if (val === 0) return false;
  }

  // Equipment attachment tracker: parallel to the engine-apply logic — the tracker only
  // contributes a boost for runtime-gained equipment (no parsed MODIFY_PT from this source).
  // For statically-parsed equipment (Bonesplitter, Strata Scythe), the parsed effect handles
  // the boost; the tracker would just produce an inert layer row. Hide it.
  if (effect._isEquipTargetEff && typeof Battlefield !== 'undefined' && Battlefield.effects) {
    const hasParsedBoost = Battlefield.effects.some(e =>
      e.sourceId === effect.sourceId &&
      e.type === EFFECT_TYPE.MODIFY_PT &&
      !e._isEquipTargetEff);
    if (hasParsedBoost) return false;
  }

  // Compute who "you" is for this effect (the controller of the source permanent)
  const effectCtrl = getEffectControllerId(effect, allStates);
  // "Enchant player" effects scope to the chosen enchanted player rather than the source controller.
  // "[type] target player controls" effects scope to the chosen target player.
  const ctrlForFilter = (effect._enchantedPlayerScoped && effect._enchantedPlayerId)
    ? effect._enchantedPlayerId
    : (effect._targetPlayerScoped && effect._targetPlayerId)
    ? effect._targetPlayerId
    : effectCtrl;

  if (effect.scope === 'targeted') {
    // Self-targeted effects (CDA_PT, counters, Volrath) apply only to their own source
    if (effect.selfTarget) {
      // TEXT_CHANGE effects with source ability text: the effect follows the ability.
      // If a text exchange moved the source ability to another permanent, the effect
      // applies to whichever permanent currently has that ability in its text box.
      if (effect.type === EFFECT_TYPE.TEXT_CHANGE && effect._sourceAbilityText) {
        const hasAbility = permState.abilities.some(a =>
          a.toLowerCase().includes(effect._sourceAbilityText)
        );
        if (!hasAbility) return false;
        // volrath_text: "As long as the top card of your graveyard is a creature card…"
        // gates the ENTIRE effect. "Your" = controller of whichever permanent currently
        // holds the ability (permState.controller), NOT the original source's controller.
        // This matters after Exchange of Words moves the ability to a different card.
        if (effect.params.changeType === 'volrath_text') {
          const ctrlId = permState.controller || 'player_0';
          const gCard = (typeof Battlefield !== 'undefined' && Battlefield.getGraveyardTop)
            ? Battlefield.getGraveyardTop(ctrlId)
            : null;
          // "creature card" uses the COMPUTED zone state, so a card that's a creature only off
          // the battlefield (Grist, the Hunger Tide) counts. _isCreatureCardInZone short-circuits
          // on the printed type line and guards against re-entrant evaluation.
          if (!gCard || typeof _isCreatureCardInZone !== 'function' || !_isCreatureCardInZone(gCard, 'graveyard')) return false;
        }
        if (effect.asLongAsCondition) {
          if (!effect.asLongAsCondition(permState, allStates)) return false;
        }
        return true;
      }
      if (effect.sourceId !== permId) return false;
      // Check "as long as" condition even for self-targeted effects
      if (effect.asLongAsCondition) {
        if (!effect.asLongAsCondition(permState, allStates)) return false;
      }
      // Devotion condition (Theros Gods): only applies while devotion < threshold.
      // When devotion >= threshold the God IS a creature — effect doesn't apply at all.
      if (effect.params && effect.params.devotionCondition && allStates) {
        const sourceState = allStates.get(effect.sourceId);
        const sourceController = sourceState ? sourceState.controller : null;
        const dev = _computeDevotionCounts(allStates, sourceController);
        const { colors, threshold } = effect.params.devotionCondition;
        const total = colors.reduce((sum, c) => sum + (dev[c] || 0), 0);
        if (total >= threshold) return false;
      }
      return true;
    }

    // Exchange control effects apply to both exchange targets (not through normal targeting)
    if (effect.type === EFFECT_TYPE.CONTROL && effect.params.exchangeControl) {
      const { exchangeTargetA, exchangeTargetB } = effect.params;
      if (exchangeTargetA && exchangeTargetB) {
        return permId === exchangeTargetA || permId === exchangeTargetB;
      }
      return false;
    }

    // Exchange text effects apply to both exchange targets (not through normal targeting)
    if (effect.type === EFFECT_TYPE.TEXT_CHANGE && effect.params.changeType === 'exchange_text') {
      const { exchangeTargetA, exchangeTargetB, exchangeTargetId } = effect.params;
      if (exchangeTargetA && exchangeTargetB) {
        return permId === exchangeTargetA || permId === exchangeTargetB;
      }
      if (exchangeTargetId) {
        return permId === effect.sourceId || permId === exchangeTargetId;
      }
      return false;
    }

    // Targeted effects require an explicit targetId (or targetIds for multi-target) to apply
    // Multi-target: effect has targetIds array (e.g. "up to two target creatures get +1/+1")
    if (effect.targetIds && effect.targetIds.length > 0) {
      if (!effect.targetIds.includes(permId)) return false;
      // Fall through to check conditions below
    } else if (!effect.targetId) {
      return false;
    } else if (effect.targetId !== permId) {
      // TEXT_CHANGE: if the target and this perm are in the same mutate stack,
      // apply the text change to this perm too — the stack is one merged permanent
      // and the text change should affect all merged abilities (Bug 1 fix).
      if (effect.type === EFFECT_TYPE.TEXT_CHANGE &&
          typeof Battlefield !== 'undefined' && Battlefield.mutateStacks) {
        const sameStack = Battlefield.mutateStacks.some(stack =>
          stack.length >= 2 && stack.includes(effect.targetId) && stack.includes(permId));
        if (!sameStack) return false;
      } else {
        return false;
      }
    }

    // Snapshot gate for triggered/activated abilities: check whether the target matched
    // the ability's overall target restriction at the moment the ability fired (i.e. at the
    // end of Layer 4 before the ability's own effects applied). _abilityTargetRestriction is
    // the restriction from the ability's earliest targeted effect, stamped on ALL effects
    // in the group so this fires uniformly — even on REMOVE_ABILITIES which has no restriction
    // of its own. Two outcomes:
    //   • Snapshot says NOT qualified → return false (abilityGroupRejectedPerms then blocks
    //     all subsequent layers of this ability for this permanent — total block).
    //   • Snapshot says qualified → proceed; each effect applies per its own current-state
    //     rules (engine-apply guards handle SET_PT/ADD_TYPE on non-creatures, etc.).
    if (effect.isSpellEffect && effect._firedAtStates && effect._abilityTargetRestriction) {
      const snapState = effect._firedAtStates.get(permId);
      if (snapState && !effect._abilityTargetRestriction(snapState, allStates, ctrlForFilter)) {
        return false;
      }
    }

    // Equipment effects only apply to creatures, unless the source is also an Aura (Aura+Equipment
    // dual: the attachment may be valid as an Aura enchanting a non-creature).
    if (effect.requiresCreatureTarget && !permState.types.includes('Creature')) {
      const srcState = allStates.get(effect.sourceId);
      const srcSubs = srcState ? (srcState.subtypes || []) : [];
      const validAsAura = srcSubs.includes('Aura') && (!effect.auraRestriction || effect.auraRestriction(permState));
      if (!validAsAura) return false;
    }

    // CR 702.16 — Protection from X: target rejects effects from a matching source.
    // Skip self-target effects (source = target). Aura/equipment attachment counts
    // as "targeting" in this engine and is also blocked.
    if (!effect.selfTarget && effect.sourceId !== permId) {
      const sourceState = allStates.get(effect.sourceId);
      const sourcePerm = (typeof Battlefield !== 'undefined')
        ? Battlefield.getPermById(effect.sourceId) : null;
      // The "_nonTargetingSelection" flag (UI pronoun-to-target conversion) bypasses
      // protection ONLY for non-attachment effects. Auras/equipment attaching always count.
      const isAttachment = !!effect.auraRestriction || !!effect.requiresCreatureTarget;
      const isNonTargeting = sourcePerm && sourcePerm._nonTargetingSelection && !isAttachment;
      if (!isNonTargeting && _isProtectedFromSource(permState, sourceState, sourcePerm, permanent)) {
        return false;
      }
    }

    // "As long as" conditional effects: check runtime condition against target state
    // Must be checked BEFORE the early return so conditions are enforced
    // CR 613: If another part of the same ability already applied to this permanent
    // in an earlier layer, bypass the asLongAsCondition — all parts of a continuous
    // effect apply to the same set of permanents (e.g. Animate Artifact: Layer 4 adds
    // Creature type, Layer 7b should still set P/T even though target is now a creature).
    if (effect.asLongAsCondition) {
      const groupAlreadyAppliedTargeted = abilityGroupAffectedPerms && effect.abilityGroupId
        && abilityGroupAffectedPerms.has(effect.abilityGroupId)
        && abilityGroupAffectedPerms.get(effect.abilityGroupId).has(permId);
      if (!groupAlreadyAppliedTargeted) {
        if (!effect.asLongAsCondition(permState, allStates)) return false;
      }
    }

    return true;
  }

  if (effect.scope === 'global' && _effectiveSourceId(effect, allStates) === permId) {
    const selfAllowed = effect.affectsSelf !== undefined ? effect.affectsSelf : true;
    if (!selfAllowed) return false;
  }
  // Triggered/activated "each other [thing] you control" pseudo-perm effects carry the
  // original ability source id so it can be excluded even though the effect's sourceId is
  // the pseudo-perm (e.g. God-Eternal Rhonas doubling each OTHER creature's power).
  if (effect.scope === 'global' && effect._excludeSourceId && effect._excludeSourceId === permId) {
    return false;
  }

  // "target opponent": effect applies only to the chosen opponent's permanents.
  // If no opponent chosen yet, the effect applies to nobody.
  if (effect._targetsOpponentPlayer) {
    const chosenOpp = effect._targetOpponentPlayerId;
    if (!chosenOpp) return false;
    if (permState.controller !== chosenOpp) return false;
  }

  if (effect.appliesTo) {
    // CR 613: If another part of the same ability already applied to this permanent
    // in an earlier layer, bypass the appliesTo filter — all parts of a continuous
    // effect apply to the same set of permanents.
    const groupAlreadyApplied = abilityGroupAffectedPerms && effect.abilityGroupId
      && abilityGroupAffectedPerms.has(effect.abilityGroupId)
      && abilityGroupAffectedPerms.get(effect.abilityGroupId).has(permId);
    if (!groupAlreadyApplied) {
      // For spell effects, check the filter against the permanent's characteristics
      // as they existed at spell resolution time. Spells should not benefit from
      // type/subtype/color changes made by continuous effects with later timestamps.
      // Strategy: check against base (printed) state. If that matches, spell applies.
      // If only the accumulated state matches, verify an earlier-timestamped continuous
      // effect on THIS permanent caused the match; otherwise block.
      if (effect.isSpellEffect && permanent) {
        if (effect._firedAtStates) {
          // Triggered/activated ability: check appliesTo against the frozen board state
          // captured at the moment the ability fired. That snapshot is authoritative for
          // determining which permanents qualify — live state only governs what happens to
          // them after the target set is locked in.
          const snapState = effect._firedAtStates.get(permId);
          if (!snapState || !effect.appliesTo(snapState, allStates, ctrlForFilter)) return false;
        } else {
        const hasPrintedChangeling = (permanent.printedAbilities || []).some(a => /\bchangeling\b/i.test(a));
        const baseState = {
          ...permState,
          types: [...(permanent.printedTypes || permState.types)],
          subtypes: [...(permanent.printedSubtypes || permState.subtypes)],
          supertypes: [...(permanent.printedSupertypes || permState.supertypes)],
          colors: [...(permanent.printedColors || permState.colors)],
          isAllCreatureTypes: hasPrintedChangeling,
        };
        // Materialize creature types into baseState.subtypes for printed Changeling
        // so subtype filter checks (now subtypes-only) match correctly at spell resolution.
        if (hasPrintedChangeling && typeof TypeCatalog !== 'undefined' &&
            TypeCatalog.creatureTypes && TypeCatalog.creatureTypes.size > 0) {
          for (const ct of TypeCatalog.creatureTypes) {
            if (!baseState.subtypes.includes(ct)) baseState.subtypes.push(ct);
          }
        }
        const baseMatches = effect.appliesTo(baseState, allStates, ctrlForFilter);
        const currentMatches = effect.appliesTo(permState, allStates, ctrlForFilter);
        if (!baseMatches && !currentMatches) return false;
        if (!baseMatches && currentMatches) {
          // Only current state matches — some effect changed the permanent.
          // Allow only if an effect with an earlier timestamp that could change
          // types/subtypes/colors applies to this specific permanent.
          // Earlier spells count too (e.g. Artificial Evolution changing creature types).
          const spellTs = effect.timestamp;
          let hasEarlierRelevantEffect = false;
          if (typeof Battlefield !== 'undefined') {
            for (const e of Battlefield.effects) {
              if (e.disabled || e.timestamp >= spellTs) continue;
              // Skip the spell effect itself (don't self-validate)
              if (e.sourceId === effect.sourceId) continue;
              if (e.type !== EFFECT_TYPE.ADD_TYPE && e.type !== EFFECT_TYPE.SET_TYPE &&
                  e.type !== EFFECT_TYPE.ADD_COLOR && e.type !== EFFECT_TYPE.SET_COLOR &&
                  e.type !== EFFECT_TYPE.COPY && e.type !== EFFECT_TYPE.TEXT_CHANGE) continue;
              // Check if this effect targets our permanent
              if (e.scope === 'targeted') {
                if ((e.selfTarget && e.sourceId === permId) ||
                    e.targetId === permId ||
                    (e.targetIds && e.targetIds.includes(permId))) {
                  hasEarlierRelevantEffect = true; break;
                }
              } else {
                // Global effect — check if it would apply to this permanent's base state
                if (!e.appliesTo || e.appliesTo(baseState)) {
                  hasEarlierRelevantEffect = true; break;
                }
              }
            }
          }
          if (!hasEarlierRelevantEffect) return false;
        }
        }
      } else {
        if (!effect.appliesTo(permState, allStates, ctrlForFilter)) return false;
      }
    }
  }

  // "As long as" conditional effects for global effects
  if (effect.asLongAsCondition) {
    if (!effect.asLongAsCondition(permState, allStates)) return false;
  }

  // Spell effects (instants/sorceries) only affect permanents that existed before the
  // spell was cast — i.e., permanents with a strictly earlier timestamp.
  if (effect.isSpellEffect && permanent && permanent.timestamp >= effect.timestamp) {
    return false;
  }

  return true;
}

/* Is the source permanent of an effect still able to generate it?
   If the source lost abilities via rule 305.7 (land subtype replacement)
   or via a REMOVE_ABILITIES effect (e.g. Humility, Darksteel Mutation),
   effects generated by its oracle text cease to exist.
   Also checks allAbilitiesRemoved flag for Layer 6 ability removal.
   Targeted (aura) effects from OTHER sources are exempt — they come from
   the aura's rules text, not the enchanted creature's. */
function isSourceViable(effect, allStates) {
  if (!effect.sourceId || effect.sourceId === 'manual') return true;
  // Counters are external game objects, not rules text — they survive ability removal.
  if (effect._isCounterEffect) return true;
  const srcState = allStates.get(effect.sourceId);
  if (!srcState) return true; // source not tracked (manual pseudo-perm)
  if (srcState.abilitiesRemovedBy305_7) return false;
  // If source had all abilities removed, its rules-text effects are dead.
  // Exception: targeted effects that target the source itself (e.g. CDA on self)
  // still work because they define characteristics, not grant abilities externally.
  // Actually, CDAs and self-targeted effects are part of the creature's own rules text,
  // so they ARE affected. The exception is effects from OTHER sources (auras etc.)
  // which have a different sourceId — those won't be checked against this creature's state.
  if (srcState.allAbilitiesRemoved) return false;
  return true;
}

// Yixlid Jailer etc.: does B remove all abilities from cards in the given hidden zone
// ('graveyard' / 'exile')? Such an effect strips the abilities that a GAIN_ACTIVATED_FROM_*
// effect (Necrotic Ooze for graveyards, Mairsil / Agatha's Soul Cauldron for exile) would
// otherwise copy, so the gain depends on it (CR 613.8).
function _removesZoneCardAbilities(B, zone) {
  return B.type === EFFECT_TYPE.REMOVE_ABILITIES &&
    B.appliesToNonBattlefieldZones &&
    Array.isArray(B.nonBattlefieldZones) && B.nonBattlefieldZones.includes(zone);
}

// Maps a GAIN_ACTIVATED_FROM_* effect type to the hidden zone it reads, or null.
function _gainReadsZone(A) {
  if (A.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_GRAVEYARDS) return 'graveyard';
  if (A.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_EXILE) return 'exile';
  return null;
}

// GAIN_ACTIVATED_FROM_OTHERS (Marvin, Manascape Refractor) gathers abilities from OTHER
// permanents matching its filter. If B grants or removes an ability on one of those gathered
// permanents (e.g. Squirrel Nest granting the enchanted land "{T}: Create a Squirrel"),
// applying B first changes what A gains — so A depends on B. Returns the gathered permanent
// whose abilities B changes, or null. The general per-permanent loop tests B and A on the
// SAME permanent, so it never sees this cross-permanent read.
function _gatheredPermChangedByB(A, B, allStates, realPerms) {
  if (A.type !== EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS) return null;
  // B must be able to change a gathered permanent's abilities. Besides a direct grant/removal,
  // another ability-gathering effect qualifies: e.g. Sakashima the Impostor copies Marvin, so
  // both have "has all activated abilities of other creatures you control". Each one's gather
  // adds an ability (Llanowar Elves' "{T}: Add {G}") to the OTHER, changing what the other
  // copies from it — a mutual CR 613.8 dependency (a loop). The general per-permanent loop never
  // sees this because each gather is self-targeted to its own source.
  const _bChangesAbilities = B.type === EFFECT_TYPE.ADD_ABILITY ||
    B.type === EFFECT_TYPE.REMOVE_ABILITIES ||
    B.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS ||
    B.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_GRAVEYARDS ||
    B.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_EXILE;
  if (!_bChangesAbilities) return null;
  // GAIN_ACTIVATED_FROM_OTHERS reads other permanents' states from effect._allStates; supply it
  // so applying B below actually grants abilities (otherwise the apply no-ops). Harmless for the
  // other B types, which read the battlefield/zone directly.
  const simB = B.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS ? { ...B, _allStates: allStates } : B;
  const reqType = A.params.requireType || null;
  const sameController = !!A.params.sameController;
  const differentName = !!A.params.differentName;
  const srcState = A.sourceId ? allStates.get(A.sourceId) : null;
  const selfName = srcState ? srcState.name : null;
  const selfController = srcState ? srcState.controller : null;
  for (const perm of realPerms) {
    if (perm.id === A.sourceId) continue;
    const pState = allStates.get(perm.id);
    if (!pState) continue;
    if (reqType && !pState.types.includes(reqType)) continue;
    if (sameController && selfController != null && pState.controller !== selfController) continue;
    if (differentName && selfName != null && pState.name === selfName) continue;
    const withB = snapshotState(pState);
    if (!effectAppliesToPerm(B, withB, perm, perm.id, allStates)) continue;
    const beforeAbilities = JSON.stringify(withB.abilities);
    applyEffect(withB, simB);
    if (JSON.stringify(withB.abilities) !== beforeAbilities ||
        withB.allAbilitiesRemoved) {
      return perm;
    }
  }
  return null;
}

function doesBInfluenceA_global(A, B, allStates, realPerms, appliedSourceIds) {
  // Special case: a GAIN_ACTIVATED_FROM_* effect reads the abilities of cards in a hidden zone
  // — Necrotic Ooze from graveyards, Mairsil / Agatha's Soul Cauldron from exile. If B removes
  // all abilities from cards in that zone (Yixlid Jailer), applying B first leaves nothing to
  // gain, so A depends on B. The grant operates on cards in a hidden zone (not battlefield
  // permanents), so the general per-permanent loop below never sees it — detect it explicitly.
  const _aGainZone = _gainReadsZone(A);
  if (_aGainZone && _removesZoneCardAbilities(B, _aGainZone) && isSourceViable(B, allStates)) {
    return true;
  }

  // Special case: Manascape Refractor / Marvin (GAIN_ACTIVATED_FROM_OTHERS) gather abilities
  // from other battlefield permanents matching their filter. If B grants/removes an ability on
  // one of those permanents (Squirrel Nest), applying B first changes what A gains, so A
  // depends on B. The general loop tests B and A on the same permanent and misses this.
  if (A.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS && isSourceViable(B, allStates) &&
      _gatheredPermChangedByB(A, B, allStates, realPerms)) {
    return true;
  }

  // Special case: "you control enchanted/equipped" CONTROL effects resolve their
  // newController dynamically from the source's current controller. If B is a CONTROL
  // effect that changes A's source's controller, then B influences A (the effective
  // "you" changes, changing who gains control of the enchanted permanent).
  if (A.type === EFFECT_TYPE.CONTROL && A.params.useSourceController &&
      A.sourceId && A.sourceId !== 'manual' &&
      B.type === EFFECT_TYPE.CONTROL && !B.params.exchangeControl) {
    const aSourceState = allStates.get(A.sourceId);
    if (aSourceState) {
      // Does B target A's source directly?
      const bTargetsASource = (B.scope === 'targeted' && !B.selfTarget &&
        (B.targetId === A.sourceId || (B.targetIds && B.targetIds.includes(A.sourceId))));
      // Does B's global appliesTo filter match A's source?
      const bGloballyAffectsASource = !bTargetsASource && B.appliesTo &&
        B.appliesTo(aSourceState, allStates, getEffectControllerId(B, allStates));
      if (bTargetsASource || bGloballyAffectsASource) {
        // B changes A's source's controller, which changes A's effective newController
        return true;
      }
    }
  }

  // For effects that operate on multiple permanents at once (exchange_text swaps
  // two text boxes, volrath_text reads from graveyard), we build a temporary
  // global state map so the simulation can actually apply B properly. This lets
  // the general loop detect dependencies without hardcoded special cases.
  const isGlobalB = B.type === EFFECT_TYPE.TEXT_CHANGE &&
    (B.params.changeType === 'exchange_text' || B.params.changeType === 'volrath_text');

  // Build "with B" global snapshot: snapshot all states, apply B globally to the copy
  let statesWithB = null;
  if (isGlobalB) {
    statesWithB = new Map();
    for (const p of realPerms) {
      const s = allStates.get(p.id);
      if (s) statesWithB.set(p.id, snapshotState(s));
    }
    // Apply B to all matching perms in the snapshot map (exchange needs both targets)
    const simB = { ...B, _allStates: statesWithB };
    const simContext = { exchangeApplied: new Set() };
    for (const p of realPerms) {
      const sB = statesWithB.get(p.id);
      if (sB && effectAppliesToPerm(simB, sB, p, p.id, statesWithB)) {
        applyEffect(sB, simB, simContext);
      }
    }
  }

  for (const perm of realPerms) {
    const baseState = allStates.get(perm.id);
    if (!baseState) continue;

    const stateWithoutB = snapshotState(baseState);
    // For global effects use the pre-computed "with B" state; otherwise apply per-perm
    let stateWithB;
    if (isGlobalB) {
      stateWithB = statesWithB.get(perm.id) || snapshotState(baseState);
    } else {
      stateWithB = snapshotState(baseState);
      if (effectAppliesToPerm(B, stateWithB, perm, perm.id, allStates)) {
        applyEffect(stateWithB, B);
      }
    }

    const aWithout = effectAppliesToPerm(A, stateWithoutB, perm, perm.id, allStates);
    const aWith    = effectAppliesToPerm(A, stateWithB, perm, perm.id, allStates);

    // Applicability changed on this permanent
    if (aWithout !== aWith) return true;

    // Result changed on this permanent
    if (aWithout && aWith) {
      // Purely additive/subtractive effects with static params (ADD_TYPE, ADD_COLOR,
      // ADD_ABILITY, REMOVE_ABILITIES) always attempt to add or remove the same
      // values regardless of existing state.  If the effect applies in both
      // scenarios the delta may differ (e.g. an addition is redundant in one case
      // but novel in the other, or a removal finds nothing to remove) yet the
      // effect's *behaviour* is identical — CR 613.8b only cares whether the
      // effect itself changes, not whether existing state absorbs it differently.
      // e.g. "loses flying" (REMOVE_ABILITIES) always attempts the same removal
      // regardless of whether another effect granted flying; "gains flying"
      // (ADD_ABILITY) always attempts the same addition regardless of whether
      // another effect removed flying.  Skip the delta check for these; only
      // applicability (condition a, checked above) matters.
      const STATIC_ADDITIVE = [EFFECT_TYPE.ADD_TYPE, EFFECT_TYPE.ADD_COLOR,
                                EFFECT_TYPE.ADD_ABILITY, EFFECT_TYPE.REMOVE_ABILITIES,
                                EFFECT_TYPE.KEYWORD_COUNTER];
      if (STATIC_ADDITIVE.includes(A.type)) continue;

      // SET_TYPE effects always output a fixed set of types/subtypes regardless
      // of the permanent's existing state:
      //   • replaceSubtypeCategory: replaces a fixed category with a fixed list.
      //   • Full SET_TYPE (explicit types, no keepTypes): overwrites all types and
      //     subtypes with fixed values (e.g. Darksteel Mutation → Artifact Creature
      //     Insect, Song of the Dryads → Land Forest).
      // In both cases the result is deterministic; B can only matter if it changes
      // whether A applies at all (tested above). The full-state comparison produces
      // false positives when B's side effects (e.g. CR 305.6 mana abilities added
      // by an ADD_TYPE subtype grant) linger in the snapshot — those are irrelevant
      // to whether A's own output changes. Only applicability changes matter.
      if (A.type === EFFECT_TYPE.SET_TYPE && A.params &&
          (A.params.replaceSubtypeCategory ||
           (A.params.types !== undefined && !A.params.keepTypes))) continue;

      // TEXT_CHANGE effects have specialized dependency rules:
      //
      // exchange_text and volrath_text read from fixed sources (frozen snapshots
      // or the top graveyard card), so B changing a target's live text cannot
      // affect what these effects write. Skip the result-changed check entirely
      // for them — only applicability changes (tested above) can create dependency.
      if (A.type === EFFECT_TYPE.TEXT_CHANGE &&
          (A.params.changeType === 'exchange_text' ||
           A.params.changeType === 'volrath_text')) continue;

      // Word-replacement TEXT_CHANGE effects (color, land type, creature type
      // substitutions): B *removing* a matchable word from A's target does NOT
      // create dependency — A still "applies" to its target, it simply finds
      // nothing to replace. Only if WITH B applied the target's text still
      // contains A's search word(s) can B affect what A does, and only then
      // should we continue to the result-changed check below.
      if (A.type === EFFECT_TYPE.TEXT_CHANGE) {
        const reps = A.params.replacements || [];
        const searchWords = reps.map(r => r.from).filter(Boolean);
        if (searchWords.length > 0) {
          const textWithB = stateWithB.oracleText || '';
          const anyMatchWithB = searchWords.some(w => {
            const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(esc, 'i').test(textWithB);
          });
          if (!anyMatchWithB) continue;
        }
      }

      const beforeWithout = snapshotState(stateWithoutB);
      const resultWithout = snapshotState(stateWithoutB);
      applyEffect(resultWithout, A);
      const beforeWith = snapshotState(stateWithB);
      const resultWith = snapshotState(stateWithB);
      applyEffect(resultWith, A);

      // For MODIFY_PT, partial SET_TYPE, and word-replacement TEXT_CHANGE,
      // compare what A actually CHANGED (delta) rather than the full resulting
      // state. This prevents false positives when B's changes persist in the
      // result even though A behaves identically (e.g. B changes "blue"→"green"
      // in an unrelated ability on the same permanent while A changes "red"→
      // "white" in a different ability — the delta for A's own replacement is
      // identical, even though the full state differs due to B's change).
      // exchange_text and volrath_text are excluded — they are handled by the
      // early-continue checks above and never reach this point.
      // ADD_COUNTERS now shares sublayer 7c with MODIFY_PT (CR 613.4c). Like a flat
      // boost, a counter applies a fixed P/T delta regardless of other 7c effects, so
      // compare its delta rather than the full state — otherwise a +1/+1 counter would
      // spuriously "depend on" an unrelated boost on the same permanent (both shift the
      // absolute P/T). A dynamic "for each" boost that counts counters still differs in
      // delta and is correctly detected as dependent.
      const DELTA_CHECK = [EFFECT_TYPE.MODIFY_PT, EFFECT_TYPE.TEXT_CHANGE, EFFECT_TYPE.ADD_COUNTERS];
      const isPartialSet = A.type === EFFECT_TYPE.SET_TYPE && A.params &&
                           (A.params.replaceSubtypeCategory || A.params.keepTypes);
      if (DELTA_CHECK.includes(A.type) || isPartialSet) {
        if (additiveDeltaDiffers(beforeWithout, resultWithout, beforeWith, resultWith)) return true;
      } else {
        if (statesAreDifferent(resultWithout, resultWith)) return true;
      }
    }
  }

  // Source-viability check: does applying B cause A's source to lose abilities?
  // e.g. Blood Moon (B) → Urborg becomes Mountain → Urborg's effect (A) dies.
  if (A.sourceId && A.sourceId !== 'manual') {
    const srcState = allStates.get(A.sourceId);
    if (srcState) {
      const srcWithout = snapshotState(srcState);
      // For global effects, use the pre-computed "with B" snapshot
      const srcWith = isGlobalB && statesWithB && statesWithB.has(A.sourceId)
        ? snapshotState(statesWithB.get(A.sourceId))
        : snapshotState(srcState);
      if (!isGlobalB && effectAppliesToPerm(B, srcWith, null, A.sourceId, allStates)) {
        applyEffect(srcWith, B);
      }
      // A "lose all abilities" B that strips A's source kills the ability that generates A,
      // so A depends on B (CR 613.8b — applying B changes whether A exists / applies). This is
      // true whether B is targeted (Frogify on one creature) or global (Humility on all
      // creatures): Humility removing Lord of Atlantis's ability means "Other Merfolk get
      // +1/+1 and islandwalk" applies to nothing once Humility goes first.
      //
      // EXCEPTION: if A's generating ability already started applying in an EARLIER layer
      // (Bello, Bard of the Brambles makes an artifact a creature in Layer 4 before granting
      // it abilities in Layer 6), the continuous effect is locked in (CR 613.7a) and persists
      // regardless of order — so applying B first cannot change A's outcome and there is no
      // dependency. `aLockedIn` mirrors the apply-time `appliedSourceIds` exemption in
      // applyEffectGlobally so detection and application agree. CDAs are never locked in (they
      // vanish with their defining ability), so a CDA whose source loses all abilities still
      // depends on B.
      const aLockedIn = appliedSourceIds && A.sourceId &&
                        appliedSourceIds.has(A.sourceId) && A.type !== EFFECT_TYPE.CDA_PT;
      if ((srcWith.abilitiesRemovedBy305_7 && !srcWithout.abilitiesRemovedBy305_7) ||
          (!aLockedIn && srcWith.allAbilitiesRemoved && !srcWithout.allAbilitiesRemoved)) {
        return true;
      }
    }
  }

  // Aura attachment restriction: if A is a targeted effect from an Aura (e.g. "Enchant creature"),
  // and B would change whether A's target still satisfies that restriction, then B influences A
  // (the attachment becomes illegal, causing A to stop applying via SBA).
  if (A.auraRestriction && A.scope === 'targeted' && !A.selfTarget && A.targetId) {
    const targetBase = allStates.get(A.targetId);
    if (targetBase) {
      const targetWithout = snapshotState(targetBase);
      let targetWith;
      if (isGlobalB && statesWithB) {
        targetWith = statesWithB.get(A.targetId) || snapshotState(targetBase);
      } else {
        targetWith = snapshotState(targetBase);
        const targetPerm = _findRealPerm(realPerms, A.targetId);
        if (effectAppliesToPerm(B, targetWith, targetPerm, A.targetId, allStates)) {
          applyEffect(targetWith, B);
        }
      }
      const validWithout = A.auraRestriction(targetWithout);
      const validWith = A.auraRestriction(targetWith);
      if (validWithout !== validWith) return true;
    }
  }

  // Aura-becomes-creature: if A is from an Aura source that does not yet have Creature type,
  // and B would grant that source the Creature type, the Aura will unattach via SBA 704.5p,
  // causing A's effects to stop applying entirely.
  if (A.scope === 'targeted' && !A.selfTarget && A.targetId && A.sourceId) {
    const srcState = allStates.get(A.sourceId);
    if (_isAuraNotCreature(srcState)) {
      let srcWith;
      if (isGlobalB && statesWithB) {
        srcWith = statesWithB.get(A.sourceId) || snapshotState(srcState);
      } else {
        srcWith = snapshotState(srcState);
        const srcPerm = _findRealPerm(realPerms, A.sourceId);
        if (effectAppliesToPerm(B, srcWith, srcPerm, A.sourceId, allStates)) {
          applyEffect(srcWith, B);
        }
      }
      if (srcWith.types.includes('Creature')) return true;
    }
  }

  return false;
}

/* Converts an effect display name like "Exchange of Words (trigger)" into a
   natural-language possessive phrase like "Exchange of Words' triggered ability". */
function _depAbilityPhrase(name) {
  let baseName = name;
  let abilityType = 'ability';
  const triggerMatch = name.match(/^(.*?)\s*\(trigger(?:ed)?\)\s*$/i);
  const activatedMatch = name.match(/^(.*?)\s*\(activated\)\s*$/i);
  if (triggerMatch) {
    baseName = triggerMatch[1].trim();
    abilityType = 'triggered ability';
  } else if (activatedMatch) {
    baseName = activatedMatch[1].trim();
    abilityType = 'activated ability';
  }
  const possessive = baseName.endsWith('s') ? `${baseName}'` : `${baseName}'s`;
  return `${possessive} ${abilityType}`;
}

/* Returns a human-readable string explaining WHY B is a dependency of A.
   Only called after doesBInfluenceA_global has already confirmed the dependency,
   so the same checks are re-run here purely to identify which condition fired. */
function getDependencyReason(A, B, allStates, realPerms) {
  const aName = _effectDisplayName(A, allStates);
  const bName = _effectDisplayName(B, allStates);
  const aPhrase = _depAbilityPhrase(aName);
  const bPhrase = _depAbilityPhrase(bName);

  // The gain copies nothing once the cards in its source zone lose their abilities (mirrors the
  // explicit dependency rule in doesBInfluenceA_global).
  const _reasonGainZone = _gainReadsZone(A);
  if (_reasonGainZone && _removesZoneCardAbilities(B, _reasonGainZone) && isSourceViable(B, allStates)) {
    return `${bPhrase} changes what ${aPhrase} affects or produces.\n\nSince ${bPhrase} changes what ${aPhrase} produces, ${aPhrase} is dependent on ${bPhrase} and needs to wait for ${bPhrase} to happen first.`;
  }

  // Manascape Refractor / Marvin gathers abilities from other permanents; B changes one of them.
  {
    const gathered = A.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS && isSourceViable(B, allStates)
      ? _gatheredPermChangedByB(A, B, allStates, realPerms) : null;
    if (gathered) {
      return `${bPhrase} changes what ${aPhrase} affects or produces.\n\nSince ${bPhrase} changes what ${aPhrase} produces, ${aPhrase} is dependent on ${bPhrase} and needs to wait for ${bPhrase} to happen first.`;
    }
  }

  const isGlobalB = B.type === EFFECT_TYPE.TEXT_CHANGE &&
    (B.params.changeType === 'exchange_text' || B.params.changeType === 'volrath_text');

  // Build "with B" snapshot for global effects (mirrors doesBInfluenceA_global)
  let statesWithB = null;
  if (isGlobalB) {
    statesWithB = new Map();
    for (const p of realPerms) {
      const s = allStates.get(p.id);
      if (s) statesWithB.set(p.id, snapshotState(s));
    }
    const simB = { ...B, _allStates: statesWithB };
    const simCtx = { exchangeApplied: new Set() };
    for (const p of realPerms) {
      const sB = statesWithB.get(p.id);
      if (sB && effectAppliesToPerm(simB, sB, p, p.id, statesWithB)) applyEffect(sB, simB, simCtx);
    }
  }

  // Check applicability change on any permanent
  for (const perm of realPerms) {
    const base = allStates.get(perm.id);
    if (!base) continue;
    const stWithout = snapshotState(base);
    let stWith;
    if (isGlobalB) {
      stWith = statesWithB.get(perm.id) || snapshotState(base);
    } else {
      stWith = snapshotState(base);
      if (effectAppliesToPerm(B, stWith, perm, perm.id, allStates)) applyEffect(stWith, B);
    }
    const appWithout = effectAppliesToPerm(A, stWithout, perm, perm.id, allStates);
    const appWith    = effectAppliesToPerm(A, stWith,    perm, perm.id, allStates);
    if (appWithout !== appWith) {
      const permLabel = perm.name || 'a permanent';
      return appWith
        ? `${bPhrase} causes ${aPhrase} to start applying to ${permLabel}.\n\nSince ${bPhrase} changes what ${aPhrase} applies to, ${aPhrase} is dependent on ${bPhrase} and needs to wait for ${bPhrase} to happen first.`
        : `${bPhrase} causes ${aPhrase} to stop applying to ${permLabel}.\n\nSince ${bPhrase} changes what ${aPhrase} applies to, ${aPhrase} is dependent on ${bPhrase} and needs to wait for ${bPhrase} to happen first.`;
    }
  }

  // Check source-viability
  if (A.sourceId && A.sourceId !== 'manual') {
    const srcState = allStates.get(A.sourceId);
    if (srcState) {
      const srcWithout = snapshotState(srcState);
      const srcWith    = isGlobalB && statesWithB && statesWithB.has(A.sourceId)
        ? snapshotState(statesWithB.get(A.sourceId))
        : snapshotState(srcState);
      if (!isGlobalB && effectAppliesToPerm(B, srcWith, null, A.sourceId, allStates)) {
        applyEffect(srcWith, B);
      }
      const srcName = A.sourceName || 'the source permanent';
      if (srcWith.abilitiesRemovedBy305_7 && !srcWithout.abilitiesRemovedBy305_7) {
        return `${bPhrase} makes ${srcName} a basic land type (CR 305.7), causing it to lose all non-basic abilities including the one that generates ${aPhrase}.\n\nSince ${bPhrase} changes what ${aPhrase} applies to, ${aPhrase} is dependent on ${bPhrase} and needs to wait for ${bPhrase} to happen first.`;
      }
      if (srcWith.allAbilitiesRemoved && !srcWithout.allAbilitiesRemoved) {
        return `${bPhrase} removes all abilities from ${srcName}, including the one that generates ${aPhrase}.\n\nSince ${bPhrase} changes what ${aPhrase} applies to, ${aPhrase} is dependent on ${bPhrase} and needs to wait for ${bPhrase} to happen first.`;
      }
    }
  }

  // Aura attachment restriction changed
  if (A.auraRestriction && A.scope === 'targeted' && !A.selfTarget && A.targetId) {
    const targetBase = allStates.get(A.targetId);
    if (targetBase) {
      const targetWithout = snapshotState(targetBase);
      const targetWith = snapshotState(targetBase);
      const targetPerm = _findRealPerm(realPerms, A.targetId);
      if (effectAppliesToPerm(B, targetWith, targetPerm, A.targetId, allStates)) applyEffect(targetWith, B);
      const validWithout = A.auraRestriction(targetWithout);
      const validWith = A.auraRestriction(targetWith);
      if (validWithout !== validWith) {
        const targetName = (targetPerm ? targetPerm.name : null) || 'its enchanted permanent';
        return validWith
          ? `${bPhrase} makes ${targetName} a legal target for the enchant restriction of ${aPhrase}.\n\nSince ${bPhrase} changes whether ${aPhrase} can remain legally attached, ${aPhrase} is dependent on ${bPhrase} and needs to wait for ${bPhrase} to happen first.`
          : `${bPhrase} causes ${targetName} to no longer satisfy the enchant restriction of ${aPhrase}, making the attachment illegal.\n\nSince ${bPhrase} changes whether ${aPhrase} can remain legally attached, ${aPhrase} is dependent on ${bPhrase} and needs to wait for ${bPhrase} to happen first.`;
      }
    }
  }

  // Aura-becomes-creature
  if (A.scope === 'targeted' && !A.selfTarget && A.targetId && A.sourceId) {
    const srcState = allStates.get(A.sourceId);
    if (_isAuraNotCreature(srcState)) {
      const srcWith = snapshotState(srcState);
      const srcPerm = _findRealPerm(realPerms, A.sourceId);
      if (effectAppliesToPerm(B, srcWith, srcPerm, A.sourceId, allStates)) applyEffect(srcWith, B);
      if (srcWith.types.includes('Creature')) {
        return `${bPhrase} causes the ${aName} Aura to become a creature, which will cause it to unattach as a state-based action.\n\nSince ${bPhrase} changes what ${aPhrase} applies to, ${aPhrase} is dependent on ${bPhrase} and needs to wait for ${bPhrase} to happen first.`;
      }
    }
  }

  // Result changed (fallback)
  return `${bPhrase} changes what ${aPhrase} affects or produces.\n\nSince ${bPhrase} changes what ${aPhrase} produces, ${aPhrase} is dependent on ${bPhrase} and needs to wait for ${bPhrase} to happen first.`;
}

/* Detect all pairwise dependencies among effects using current global state.
   Spell effects (isSpellEffect) are excluded — they always resolve in strict
   timestamp order with no dependency reordering (CR: spells resolve on the stack). */
function detectDependenciesGlobal(effects, allStates, realPerms, appliedSourceIds) {
  // Build an id→perm Map once so the O(N²) pair loop below does O(1) perm lookups
  // instead of O(N) realPerms.find() per call. Stashed on doesBInfluenceA_global as a
  // module-private hint that downstream lookups consult when present.
  const realPermsById = new Map();
  for (const p of realPerms) realPermsById.set(p.id, p);
  _realPermsByIdCache = realPermsById;
  const deps = [];
  for (let i = 0; i < effects.length; i++) {
    if (effects[i].isSpellEffect) continue;
    for (let j = 0; j < effects.length; j++) {
      if (i === j) continue;
      if (effects[j].isSpellEffect) continue;
      if (doesBInfluenceA_global(effects[i], effects[j], allStates, realPerms, appliedSourceIds)) {
        deps.push({ dependent: i, dependsOn: j });
      }
    }
  }
  _realPermsByIdCache = null;
  return deps;
}

/* CR 613.8 loop detection: find cycles and remove ALL dependencies involving cycle nodes */
function removeLoopDependencies(deps) {
  const adj = {};
  for (const d of deps) {
    if (!adj[d.dependent]) adj[d.dependent] = new Set();
    adj[d.dependent].add(d.dependsOn);
  }
  const inLoop = new Set();
  const visited = new Set();
  const stack = new Set();

  function dfs(node, path) {
    if (stack.has(node)) {
      let inCycle = false;
      for (const p of path) {
        if (p === node) inCycle = true;
        if (inCycle) inLoop.add(p);
      }
      inLoop.add(node);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    path.push(node);
    for (const next of (adj[node] || [])) {
      dfs(next, [...path]);
    }
    stack.delete(node);
  }

  const allNodes = new Set(deps.flatMap(d => [d.dependent, d.dependsOn]));
  for (const node of allNodes) {
    if (!visited.has(node)) dfs(node, []);
  }

  return {
    cleaned: deps.filter(d => !(inLoop.has(d.dependent) && inLoop.has(d.dependsOn))),
    loopNodes: inLoop,
  };
}
