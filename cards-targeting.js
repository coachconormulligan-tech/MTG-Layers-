/* Target pickers without the HTML: which picker the site shows for a spell or ability, and which
   permanents it offers in it.

   No DOM. The renderers in ui-targeting.js build their <option> lists from getTargetCandidates, and
   tests/audit.js calls the same functions headlessly, so what the audit measures is what the site
   shows. The four picker kinds were written separately and differ in small ways (which timestamp
   rule applies, whether protection is checked, whether a current target stays valid, ...). Those
   differences are kept exactly as they were; each is marked below. */

/* What the timestamp panel needs to know about a source's targeting. finalState is the source's
   final state when it has one (real permanents and spells), undefined for ability pseudo-perms. */
function getEffectInfo(permId, finalState) {
  const effs = Battlefield.effects.filter(e => e.sourceId === permId);
  const perm = Battlefield.getPermById(permId);
  const textEff = effs.find(e => e.type === EFFECT_TYPE.TEXT_CHANGE);
  // A copy-source picker only where the source picks what it copies; "<target> becomes a copy
  // of this creature" (The Flood of Mars) takes an ordinary target instead.
  // A mass copy whose source is a linked card (Deceiver of Form) has the "Linked card" button.
  const copyEff = effs.find(e => e.type === EFFECT_TYPE.COPY && !(e.params && (e.params.copiesAbilitySource || e.params.copyFromLinkedCard)));
  // If this permanent has a text-change effect, the text-change modal handles
  // targeting for ALL targeted effects from the same source (via setTextChangeConfig
  // propagation). So suppress the generic target dropdown entirely for such sources.
  const hasTextChange = !!textEff;
  const isToken = perm ? perm.isToken : false;
  // Bestow cards: targeting is handled by the bestow modal (bestow button), not the target dropdown.
  const isBestowCard = perm ? !!perm.hasBestow : false;
  // Non-top mutate stack members: they are part of a single merged permanent.
  // Their effects don't get individual target selects — the top card manages targeting.
  const stack = perm ? Battlefield.getStack(perm.id) : null;
  const isNonTopMutate = stack && stack.length >= 2 && stack[0] !== permId;
  const suppressTargeted = isBestowCard || isNonTopMutate;
  const isManual = perm ? perm.isManualEffect : false;
  // Multi-target: find first effect with maxTargets > 1
  const multiTargetEff = effs.find(e => e.maxTargets > 1 && e.scope === 'targeted' && !e.selfTarget);
  // Multi-slot: count distinct _targetSlot values (each is an independently selectable target)
  const _slottedEffs = effs.filter(e => e.scope === 'targeted' && !e.selfTarget && e._targetSlot !== undefined);
  const targetSlotCount = _slottedEffs.length > 0
    ? Math.max(..._slottedEffs.map(e => e._targetSlot)) + 1
    : 0;
  // Per-mode targeting: true when multiple distinct modal modes each need a separate target.
  // This occurs on Entwined/multi-mode spells (e.g. Twisted Reflection with Entwine) where
  // two different modes each target a creature independently.
  const activeModalTargetedModes = [...new Set(
    effs
      .filter(e => e.scope === 'targeted' && !e.selfTarget && !e.disabled && e.modalModeIndex !== undefined)
      .map(e => e.modalModeIndex)
  )];
  const hasModalTargets = !hasTextChange && !suppressTargeted && activeModalTargetedModes.length > 1;
  const exchangeControlEff = effs.find(e => e.type === EFFECT_TYPE.CONTROL && e.params.exchangeControl);
  const hasExchangeControl = !!exchangeControlEff;
  // Equipment/Reconfigure/Fortify: use the final computed state when available so that abilities
  // gained or removed by continuous effects are reflected (e.g. Humility removing equip ability).
  let hasEquipSource;
  if (finalState !== undefined) {
    if (finalState.allAbilitiesRemoved) {
      hasEquipSource = false;
    } else {
      const fActivated = Battlefield.extractActivatedAbilities(finalState.abilities || []);
      hasEquipSource = !suppressTargeted && fActivated.some(a => a.isEquip || a.isFortify || a.isReconfigure);
    }
  } else {
    hasEquipSource = !suppressTargeted && effs.some(e => e.requiresCreatureTarget && !e._isEquipTargetEff && !e.disabled);
  }
  // Aura takes priority: if any effect has auraRestriction, suppress equip UI so the
  // standard target dropdown renders (renderTargetSelect already handles auraRestriction filtering).
  if (effs.some(e => e.auraRestriction)) hasEquipSource = false;
  return {
    hasTargeted: !hasTextChange && !hasExchangeControl && !suppressTargeted && !hasModalTargets && !hasEquipSource && targetSlotCount === 0 && effs.some(e => e.scope === 'targeted' && !e.selfTarget && !e._isCounterEffect && !e._autoTargetSource && !e.disabled && !e._isEquipTargetEff),
    hasEquipSource,
    hasCopy: !!copyEff,
    hasCopyToken: !!copyEff && isToken,    // token copy -> full editor modal
    hasCopyCard: !!copyEff && !isToken,     // non-token copy -> dropdown select
    hasText: hasTextChange,
    textChangeType: textEff?.params?.changeType || null,
    hasExchangeControl,
    exchangeControlMode: exchangeControlEff?.params?.exchangeMode || null,
    hasCDA: effs.some(e => (e.type === EFFECT_TYPE.CDA_PT && (e.params.userAdjustable || (!e.params.forEachDesc && !e.params.compute))) || (e.type === EFFECT_TYPE.MODIFY_PT && e.params.forEachDesc !== undefined && e.params.userAdjustable)),
    isManualEffect: isManual,
    maxTargets: multiTargetEff ? multiTargetEff.maxTargets : 1,
    hasModalTargets,
    activeModalTargetedModes,
    targetSlotCount,
  };
}

/* Which target picker the timestamp panel shows for this source (the ternary in
   renderTimestampPanel). kind is 'slotted' (one picker per slot of a multi-sentence spell),
   'modal' (one per active targeted mode), 'multi' ("up to N target"), 'single', or 'none'.
   finalState is passed exactly as the panel passes it: the source's final state, or undefined
   for an ability pseudo-perm. A caller that already ran getEffectInfo can pass the result as
   `info` to avoid running it twice. */
function getTargetPickerKind(sourceId, finalState, info) {
  info = info || getEffectInfo(sourceId, finalState);
  const kind = info.targetSlotCount > 0 ? 'slotted'
    : info.hasModalTargets ? 'modal'
    : info.hasTargeted ? (info.maxTargets > 1 ? 'multi' : 'single')
    : 'none';
  return { kind, slots: info.targetSlotCount, modes: info.activeModalTargetedModes, maxTargets: info.maxTargets, info };
}

/* "Audit Bear A [Player 2]" - how a permanent is named in a picker. The modal-mode picker leaves
   the player off. */
/* What a target restriction is asked about a candidate. The pickers' own tState carries only
   types and colours; a restriction may also ask who controls the permanent ("you control",
   "an opponent controls"), or about its power, abilities, counters or traits ("with power 5 or
   greater", "with defender", "with a counter on it", "attacking"). */
function _restrictionState(tState, fs, t) {
  const src = fs || {};
  return {
    ...tState,
    controller: src.controller || t.controller || t.owner || 'player_0',
    power: src.power ?? t.printedPower ?? null,
    toughness: src.toughness ?? t.printedToughness ?? null,
    abilities: src.abilities || t.printedAbilities || [],
    counters: src.counters || t.counters || {},
    manaValue: src.manaValue ?? t.manaValue ?? 0,
    isToken: !!t.isToken,
    traits: tState.traits || src.traits || t.traits || [],
  };
}

/* Does the permanent have this keyword? A keyword is an ability line of its own or one entry
   of a keyword list ("Flying, shroud"), possibly with a duration or reminder text after it —
   not any ability whose text mentions the word ("{1}{U}{U}: This creature gains shroud until
   end of turn" on Armored Guardian does not give it shroud). */
function _hasKeywordAbility(abilities, keyword) {
  const re = new RegExp('^' + keyword + '\\b(?!\\s*[:\u2014])', 'i');
  return abilities.some(a => {
    const line = String(a).trim();
    if (/[:"\u201c]/.test(line.replace(/\(.*$/, '')) || /^(?:when|whenever|at|as long as|if)\b/i.test(line)) return false;
    return line.replace(/\s*\(.*$/, '').split(/,\s*/).some(part => re.test(part.trim()));
  });
}

function _targetPickerName(t, fs, withPlayer) {
  let name = (fs?.copySource ? fs.name + ' (copy)' : t.name) + (t.label ? ' ' + t.label : '');
  if (withPlayer && Battlefield.players.length > 1 && t.owner) name += ` [${Battlefield.getPlayerName(t.controller || t.owner)}]`;
  return name;
}

/* The permanents a source's target picker offers, in the order the picker lists them.

   opts.kind is 'single' | 'multi' | 'slotted' | 'modal' (see getTargetPickerKind), with
     opts.slotIndex  for 'multi'   - which of the "up to N" pickers (0-based),
     opts.slot       for 'slotted' - which target slot,
     opts.modeIndex  for 'modal'   - which modal mode.
   Returns { blocked } when the picker is replaced by a message (CR 704.5p), otherwise
   { candidates: [{ id, perm, state, displayName }], currentTarget, currentTargets, isNonTargeting,
     isAttached }. displayName is not HTML-escaped. */
function getTargetCandidates(sourceId, opts) {
  opts = opts || {};
  switch (opts.kind || 'single') {
    case 'multi': return _multiTargetCandidates(sourceId, opts.slotIndex || 0);
    case 'slotted': return _slottedTargetCandidates(sourceId, opts.slot || 0);
    case 'modal': return _modalTargetCandidates(sourceId, opts.modeIndex);
    default: return _singleTargetCandidates(sourceId);
  }
}

/* The picker for one target: the only one that knows about opponent/you-control restrictions,
   Auras and Equipment, and "choose" selections that do not target. */
function _singleTargetCandidates(sourceId) {
  const sourcePerm = Battlefield.getPermById(sourceId);
  const current = Battlefield.effects.find(e => e.sourceId === sourceId && e.scope === 'targeted' && !e.selfTarget && !e._isCounterEffect && !e.disabled)
    || Battlefield.effects.find(e => e.sourceId === sourceId && e.scope === 'targeted' && !e.selfTarget && !e._isCounterEffect);
  const currentTarget = current?.targetId || '';
  // If ANY targeted effect from this source requires an opponent's permanent, apply that filter.
  // We scan all effects (not just `current`) because haste/untap effects parsed before the
  // CONTROL effect may be found first by the `current` finder, hiding the flag.
  const opponentControlRequired = Battlefield.effects.some(e =>
    e.sourceId === sourceId && e.scope === 'targeted' && !e.selfTarget && e.opponentControlRequired)
    || !!(sourcePerm?._opponentControlRequired);
  const youControlRequired = Battlefield.effects.some(e =>
    e.sourceId === sourceId && e.scope === 'targeted' && !e.selfTarget && e.youControlRequired)
    || !!(sourcePerm?._youControlRequired);
  const sourceCtrl = sourcePerm?.controller || sourcePerm?.owner || Battlefield.activePlayerId;
  // Exclude non-top mutate stack members — a stack is one target (only the top is selectable)
  const targets = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === sourceId) return false;
    // "another" restriction: exclude the ability's source permanent itself (e.g. Arahbo can't target itself)
    if (sourcePerm?._excludeAbilitySource && sourcePerm.abilitySourceId && p.id === sourcePerm.abilitySourceId) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack.length >= 2 && stack[0] !== p.id) return false;
    // Spell effects only affect permanents that existed before the spell (earlier timestamp),
    // but always include a permanent that is already the current target — targeting persists
    // even if the card is later moved to a timestamp after the spell.
    if (sourcePerm && (sourcePerm.isManualEffect || sourcePerm.isSpell) && p.timestamp >= sourcePerm.timestamp && p.id !== currentTarget) return false;
    // "target creature an opponent controls" — exclude permanents the source's controller controls
    if (opponentControlRequired && (p.controller || p.owner || 'player_0') === sourceCtrl) return false;
    // "enchant creature you control" — exclude permanents controlled by opponents
    if (youControlRequired && (p.controller || p.owner || 'player_0') !== sourceCtrl) return false;
    return true;
  });

  // Get aura restriction from the source's effects (parsed from "Enchant [type]")
  const auraRestriction = current?.auraRestriction
    || Battlefield.effects.find(e => e.sourceId === sourceId && e.auraRestriction)?.auraRestriction
    || Battlefield.getPermById(sourceId)?._auraRestriction;

  // Get spell target restriction (from "target creature" parsing)
  const spellRestriction = current?.targetRestriction
    || Battlefield.effects.find(e => e.sourceId === sourceId && e.targetRestriction && !e.disabled)?.targetRestriction
    || Battlefield.effects.find(e => e.sourceId === sourceId && e.targetRestriction)?.targetRestriction;

  // Check if this is an equipment source (requires creature target)
  const isEquipment = Battlefield.effects.some(e => e.sourceId === sourceId && e.requiresCreatureTarget);

  // Use final computed states for validation so copies/tokens show correctly
  const finalStates = Battlefield.getAllFinalStates();
  // For spells / triggered / activated abilities, prefer the snapshot captured at fire/cast time
  // so target restrictions are checked against what each candidate WAS, not what it is now.
  const snapStates = sourcePerm?._firedAtStates || sourcePerm?._firedAtSnapshot?.states || null;
  const lookupState = (id) => (snapStates && snapStates.has(id)) ? snapStates.get(id) : finalStates.get(id);

  // CR 704.5p: If this equipment is currently a creature, it can't equip
  // (unless it has reconfigure, which makes it lose creature type upon equipping).
  if (isEquipment) {
    const sourceFs = finalStates.get(sourceId);
    const sourceTypes = sourceFs ? (sourceFs.types || []) : (sourcePerm?.printedTypes || []);
    if (sourceTypes.includes('Creature')) {
      const sourceAbilities = sourceFs ? (sourceFs.abilities || []) : [];
      const hasReconfigure = sourceAbilities.some(a => /\breconfigure\b/i.test(a));
      if (!hasReconfigure) {
        return { blocked: 'This Equipment is currently a creature and cannot equip. (Rule 704.5p)' };
      }
    }
  }

  // Check if this is a non-targeting selection (from "it" pronoun conversion).
  // These abilities don't actually target, so they bypass shroud/hexproof.
  const isNonTargeting = sourcePerm && sourcePerm._nonTargetingSelection;

  // Check if this is a reconfigure card that currently has a target (is attached)
  const isReconfigure = isEquipment && sourcePerm && (sourcePerm.oracleText || '').toLowerCase().includes('reconfigure');
  const isAttached = isReconfigure && currentTarget;

  const candidates = [];
  for (const t of targets) {
    const fs = lookupState(t.id);
    const tState = fs
      ? { types: fs.types || [], supertypes: fs.supertypes || [], subtypes: fs.subtypes || [], colors: fs.colors || [], isAllCreatureTypes: fs.isAllCreatureTypes }
      : { types: t.printedTypes || [], supertypes: t.printedSupertypes || [], subtypes: t.printedSubtypes || [], colors: t.printedColors || [], isAllCreatureTypes: false };
    const validAura = !auraRestriction || auraRestriction(tState);
    const tCtrlForEquip = t.controller || t.owner || 'player_0';
    const validEquip = !isEquipment || (tState.types.includes('Creature') && tCtrlForEquip === sourceCtrl);
    const validSpell = !spellRestriction || spellRestriction(_restrictionState(tState, fs, t), snapStates || finalStates, sourceCtrl);
    // Shroud/hexproof prevent being targeted — but non-targeting selections bypass them
    const tAbilities = !isNonTargeting && fs ? (fs.abilities || []) : [];
    const hasShroud = _hasKeywordAbility(tAbilities, 'shroud');
    const tCtrl = t.controller || t.owner || 'player_0';
    const hasHexproof = tCtrl !== sourceCtrl && _hasKeywordAbility(tAbilities, 'hexproof');
    // CR 702.16 — protection: skip if target is protected from this source.
    // Auras/equipment ALWAYS check (attachment counts); other non-targeting selections bypass.
    const isAttachment = !!auraRestriction || isEquipment;
    const checkProtection = !isNonTargeting || isAttachment;
    const sourceFs = finalStates.get(sourceId);
    const isProtected = checkProtection && (typeof _isProtectedFromSource === 'function')
      ? !!_isProtectedFromSource(fs || tState, sourceFs, sourcePerm, t)
      : false;
    // Dual Aura+Equipment: accept if valid for either attachment type; otherwise AND both.
    const validAttach = (auraRestriction && isEquipment) ? (validAura || validEquip) : (validAura && validEquip);
    if (validAttach && validSpell && !hasShroud && !hasHexproof && !isProtected) {
      candidates.push({ id: t.id, perm: t, state: fs || tState, displayName: _targetPickerName(t, fs, true) });
    }
  }
  return { candidates, currentTarget, currentTargets: currentTarget ? [currentTarget] : [], isNonTargeting, isAttached };
}

/* One of the "up to N target" pickers. A permanent already in this slot stays valid whatever its
   state now is; hexproof and shroud are checked, protection is not. */
function _multiTargetCandidates(sourceId, slotIndex) {
  const sourcePerm = Battlefield.getPermById(sourceId);
  const effs = Battlefield.effects.filter(e => e.sourceId === sourceId && e.scope === 'targeted' && !e.selfTarget);
  const currentTargetIds = effs[0]?.targetIds || [];
  const targets = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === sourceId) return false;
    if (sourcePerm?._excludeAbilitySource && sourcePerm.abilitySourceId && p.id === sourcePerm.abilitySourceId) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack.length >= 2 && stack[0] !== p.id) return false;
    // Spell effects only affect permanents that existed before the spell (earlier timestamp),
    // but always include permanents that are already current targets — targeting persists
    // even if the card is later moved to a timestamp after the spell.
    // (Not for a pick made from the board as it is now — _pickFromLiveBoard, below.)
    if (sourcePerm && sourcePerm.isManualEffect && !sourcePerm._pickFromLiveBoard && p.timestamp >= sourcePerm.timestamp && !currentTargetIds.includes(p.id)) return false;
    return true;
  });
  const spellRestriction = effs.find(e => e.targetRestriction)?.targetRestriction;

  const finalStates = Battlefield.getAllFinalStates();
  const snapStates = sourcePerm?._firedAtStates || sourcePerm?._firedAtSnapshot?.states || null;
  // "Whenever a creature attacks this turn, it gets …" (Song of Blood): the creatures attack
  // after the spell has resolved, so they are picked from those marked attacking now.
  const liveBoard = !!(sourcePerm && sourcePerm._pickFromLiveBoard);
  const lookupState = (id) => (!liveBoard && snapStates && snapStates.has(id)) ? snapStates.get(id) : finalStates.get(id);
  const isNonTargeting = sourcePerm && sourcePerm._nonTargetingSelection;
  const sourceCtrl = sourcePerm?.controller || sourcePerm?.owner || Battlefield.activePlayerId;

  const currentVal = currentTargetIds[slotIndex] || '';
  const candidates = [];
  for (const t of targets) {
    const fs = lookupState(t.id);
    const tState = fs
      ? { types: fs.types || [], supertypes: fs.supertypes || [], subtypes: fs.subtypes || [], colors: fs.colors || [], isAllCreatureTypes: fs.isAllCreatureTypes, ...(liveBoard ? { traits: fs.traits || t.traits || [] } : {}) }
      : { types: t.printedTypes || [], supertypes: t.printedSupertypes || [], subtypes: t.printedSubtypes || [], colors: t.printedColors || [], isAllCreatureTypes: false, ...(liveBoard ? { traits: t.traits || [] } : {}) };
    const valid = t.id === currentVal || !spellRestriction || spellRestriction(_restrictionState(tState, fs, t), snapStates || finalStates, sourceCtrl);
    const tAbilities = !isNonTargeting && fs ? (fs.abilities || []) : [];
    const hasShroud = _hasKeywordAbility(tAbilities, 'shroud');
    const tCtrl = t.controller || t.owner || 'player_0';
    const hasHexproof = tCtrl !== sourceCtrl && _hasKeywordAbility(tAbilities, 'hexproof');
    if (valid && !hasShroud && !hasHexproof) {
      candidates.push({ id: t.id, perm: t, state: fs || tState, displayName: _targetPickerName(t, fs, true) });
    }
  }
  return { candidates, currentTarget: currentVal, currentTargets: currentTargetIds.slice(), isNonTargeting, isAttached: false };
}

/* One target slot of a multi-sentence spell. Unlike the single picker it has no opponent/you-control
   rules and no non-targeting selections, but it does check protection. */
function _slottedTargetCandidates(sourceId, slot) {
  const sourcePerm = Battlefield.getPermById(sourceId);
  const slotEff = Battlefield.effects.find(e =>
    e.sourceId === sourceId && e.scope === 'targeted' && !e.selfTarget &&
    e._targetSlot === slot && !e.disabled
  );
  const currentTarget = slotEff?.targetId || '';
  const sourceCtrl = sourcePerm?.controller || sourcePerm?.owner || Battlefield.activePlayerId;

  const targets = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === sourceId) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack.length >= 2 && stack[0] !== p.id) return false;
    if (sourcePerm && (sourcePerm.isManualEffect || sourcePerm.isSpell) && p.timestamp >= sourcePerm.timestamp && p.id !== currentTarget) return false;
    return true;
  });

  const spellRestriction = slotEff?.targetRestriction || null;
  const finalStates = Battlefield.getAllFinalStates();
  const snapStates = sourcePerm?._firedAtStates || sourcePerm?._firedAtSnapshot?.states || null;
  const lookupState = (id) => (snapStates && snapStates.has(id)) ? snapStates.get(id) : finalStates.get(id);

  const candidates = [];
  for (const t of targets) {
    const fs = lookupState(t.id);
    const tState = fs
      ? { types: fs.types || [], supertypes: fs.supertypes || [], subtypes: fs.subtypes || [], colors: fs.colors || [], isAllCreatureTypes: fs.isAllCreatureTypes }
      : { types: t.printedTypes || [], supertypes: t.printedSupertypes || [], subtypes: t.printedSubtypes || [], colors: t.printedColors || [], isAllCreatureTypes: false };
    const validSpell = !spellRestriction || spellRestriction(_restrictionState(tState, fs, t), snapStates || finalStates, sourceCtrl);
    const tAbilities = fs ? (fs.abilities || []) : [];
    const hasShroud = _hasKeywordAbility(tAbilities, 'shroud');
    const tCtrl = t.controller || t.owner || 'player_0';
    const hasHexproof = tCtrl !== sourceCtrl && _hasKeywordAbility(tAbilities, 'hexproof');
    const sourceFs = finalStates.get(sourceId);
    const isProtected = (typeof _isProtectedFromSource === 'function')
      ? !!_isProtectedFromSource(fs || tState, sourceFs, sourcePerm, t)
      : false;
    if (validSpell && !hasShroud && !hasHexproof && !isProtected) {
      candidates.push({ id: t.id, perm: t, state: fs || tState, displayName: _targetPickerName(t, fs, true) });
    }
  }
  return { candidates, currentTarget, currentTargets: currentTarget ? [currentTarget] : [], isNonTargeting: false, isAttached: false };
}

/* One active targeted mode of a modal spell (Twisted Reflection with Entwine). No timestamp rule,
   no protection check, and the player's name is not added to the permanent's. A mode with no
   targeted effect has no picker: { noEffect: true }. */
function _modalTargetCandidates(sourceId, modeIdx) {
  const sourcePerm = Battlefield.getPermById(sourceId);
  const allEffs = Battlefield.effects.filter(e => e.sourceId === sourceId && e.scope === 'targeted' && !e.selfTarget);
  const finalStates = Battlefield.getAllFinalStates();
  const snapStates = sourcePerm?._firedAtStates || sourcePerm?._firedAtSnapshot?.states || null;
  const lookupState = (id) => (snapStates && snapStates.has(id)) ? snapStates.get(id) : finalStates.get(id);
  const isNonTargeting = sourcePerm && sourcePerm._nonTargetingSelection;
  const sourceCtrl = sourcePerm?.controller || sourcePerm?.owner || Battlefield.activePlayerId;
  const targets = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === sourceId) return false;
    if (sourcePerm?._excludeAbilitySource && sourcePerm.abilitySourceId && p.id === sourcePerm.abilitySourceId) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack.length >= 2 && stack[0] !== p.id) return false;
    return true;
  });

  const modeEff = allEffs.find(e => e.modalModeIndex === modeIdx);
  if (!modeEff) return { noEffect: true, candidates: [], currentTarget: '', currentTargets: [], isNonTargeting, isAttached: false };
  const currentTarget = modeEff.targetId || '';
  const spellRestriction = modeEff.targetRestriction || null;
  const candidates = [];
  for (const t of targets) {
    const fs = lookupState(t.id);
    const tState = fs
      ? { types: fs.types || [], supertypes: fs.supertypes || [], subtypes: fs.subtypes || [], colors: fs.colors || [], isAllCreatureTypes: fs.isAllCreatureTypes }
      : { types: t.printedTypes || [], supertypes: t.printedSupertypes || [], subtypes: t.printedSubtypes || [], colors: t.printedColors || [], isAllCreatureTypes: false };
    const valid = t.id === currentTarget || !spellRestriction || spellRestriction(_restrictionState(tState, fs, t), snapStates || finalStates, sourceCtrl);
    const tAbilities = !isNonTargeting && fs ? (fs.abilities || []) : [];
    const hasShroud = _hasKeywordAbility(tAbilities, 'shroud');
    const tCtrl = t.controller || t.owner || 'player_0';
    const hasHexproof = tCtrl !== sourceCtrl && _hasKeywordAbility(tAbilities, 'hexproof');
    if (valid && !hasShroud && !hasHexproof) {
      candidates.push({ id: t.id, perm: t, state: fs || tState, displayName: _targetPickerName(t, fs, false) });
    }
  }
  return { candidates, currentTarget, currentTargets: currentTarget ? [currentTarget] : [], isNonTargeting, isAttached: false };
}
