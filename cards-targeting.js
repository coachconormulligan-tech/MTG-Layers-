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
    // "For each time it has attacked this turn" (Moraug): a count typed on each creature.
    attackCountEffect: effs.find(e => e.type === EFFECT_TYPE.MODIFY_PT && /\bit has attacked this turn$/i.test((e.params && e.params.forEachDesc) || '')) || null,
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
  // (An effect pinned to the ability's own source is not the one the picker sets: "This creature
  // and another target creature each get +1/+0" — Deadly Dancer.)
  const current = Battlefield.effects.find(e => e.sourceId === sourceId && e.scope === 'targeted' && !e.selfTarget && !e._isCounterEffect && !e.disabled && !e._sourceHalf)
    || Battlefield.effects.find(e => e.sourceId === sourceId && e.scope === 'targeted' && !e.selfTarget && !e._isCounterEffect && !e.disabled)
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
  const firstRestriction = current?.targetRestriction
    || Battlefield.effects.find(e => e.sourceId === sourceId && e.targetRestriction && !e.disabled)?.targetRestriction
    || Battlefield.effects.find(e => e.sourceId === sourceId && e.targetRestriction)?.targetRestriction;
  // Every targeted effect of a one-target source is about that same target, so each one's
  // restriction applies. "Gain control of target creature with power 3 or less … It gains haste"
  // (Smelt-Ward Ignus): the haste effect, found first, only knows "creature".
  const sharedRestrictions = [...new Set(Battlefield.effects
    .filter(e => e.sourceId === sourceId && e.scope === 'targeted' && !e.selfTarget && !e._isCounterEffect &&
      !e.disabled && e.targetRestriction)
    .map(e => e.targetRestriction))];
  const spellRestriction = sharedRestrictions.length >= 2
    ? (st, states, ctrl) => sharedRestrictions.every(r => r(st, states, ctrl))
    : firstRestriction;

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
    const hasHexproof = tCtrl !== sourceCtrl && !!_hexproofFromSource(tAbilities, fs || tState, finalStates.get(sourceId), sourcePerm);
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
    const hasHexproof = tCtrl !== sourceCtrl && !!_hexproofFromSource(tAbilities, fs || tState, finalStates.get(sourceId), sourcePerm);
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
    const hasHexproof = tCtrl !== sourceCtrl && !!_hexproofFromSource(tAbilities, fs || tState, finalStates.get(sourceId), sourcePerm);
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
    const hasHexproof = tCtrl !== sourceCtrl && !!_hexproofFromSource(tAbilities, fs || tState, finalStates.get(sourceId), sourcePerm);
    if (valid && !hasShroud && !hasHexproof) {
      candidates.push({ id: t.id, perm: t, state: fs || tState, displayName: _targetPickerName(t, fs, false) });
    }
  }
  return { candidates, currentTarget, currentTargets: currentTarget ? [currentTarget] : [], isNonTargeting, isAttached: false };
}

/* ===== Exchange control of two targets =====
   "Exchange control of target creature you control and target creature with power less than or
   equal to that creature's power an opponent controls" (Spawnbroker). The exchange-control modal
   (ui-modal-text-change.js) lists from getExchangeControlCandidates and warns with
   exchangeControlPairProblem, and the engine (effectAppliesToPerm) refuses a pair the latter says
   no to, so a pair set some other way (a saved board, a recipe) exchanges nothing either
   (CR 701.12b). Every rule is read off the board as the spell was cast or the ability fired, the
   live board only where the source has no snapshot. */

function _exchangeControlEffect(sourceId) {
  return Battlefield.effects.find(e => e.sourceId === sourceId && e.type === EFFECT_TYPE.CONTROL && e.params && e.params.exchangeControl) || null;
}

/* The states of the board as the source was cast or fired (a Map by id), or null. */
function _exchangeControlSnapshot(sourceId) {
  const src = Battlefield.getPermById(sourceId);
  return (src && (src._firedAtStates || src._castStates || (src._firedAtSnapshot && src._firedAtSnapshot.states))) || null;
}

/* The player "you" means: the controller of the spell or ability. */
function _exchangeControlYou(sourceId) {
  const src = Battlefield.getPermById(sourceId);
  return (src && (src.controller || src.owner)) || Battlefield.activePlayerId;
}

const _EXCHANGE_CONTROLLER_WORDS = { you: 'one you control', opponent: 'one an opponent controls', notYou: "one you don't control", neither: 'one you neither own nor control' };

/* Whether slot 'a' or 'b' is a target of the spell or ability (params.exchangeTargeted, from
   _exchangeControlTargeted; an effect without it: both of two targets, B of "this … and target
   …"). Only a target is refused for shroud, hexproof or protection. */
function _exchangeControlSlotTargeted(effect, slot) {
  const t = effect.params.exchangeTargeted;
  if (t) return !!t[slot];
  return slot === 'b' || effect.params.exchangeMode === 'two_targets';
}

/* Who must control the permanent in slot 'a' or 'b': for two targets, the slot's own words
   (exchangeSlotRules); for "this creature and target creature an opponent controls" (Gilded
   Drake, Volatile Stormdrake) or "… target permanent you neither own nor control" (Conjured
   Currency), B's from the effect's flags. 'you' | 'opponent' | 'notYou' | 'neither' | null. */
function getExchangeControlSlotController(effect, slot) {
  const rules = effect.params.exchangeSlotRules;
  const rule = rules && (slot === 'a' ? rules.controllerA : rules.controllerB);
  if (rule) return rule;
  if (slot === 'b' && effect.params.exchangeMode === 'self_and_target') {
    if (effect.neitherOwnNorControl) return 'neither';
    if (effect.opponentControlRequired) return 'opponent';
  }
  return null;
}

/* What keeps the permanent in a targeted slot from being a target of the source, as a sentence,
   or null: shroud, hexproof when someone other than the source's controller controls it, or
   protection from the source (CR 702.18, 702.11, 702.16), as _singleTargetCandidates checks
   them; "hexproof from [quality]" only against a source of that quality (_hexproofFromSource).
   The source's state is read through stateOf as well, so the engine can ask during an
   evaluation (the snapshot) without evaluating the board again. */
function _exchangeControlTargetingProblem(effect, slot, st, you, perm, stateOf) {
  if (!st || !_exchangeControlSlotTargeted(effect, slot)) return null;
  const which = `Permanent ${slot.toUpperCase()}`;
  const abilities = st.abilities || [];
  if (_hasKeywordAbility(abilities, 'shroud')) return `${which} has shroud and cannot be targeted.`;
  const srcPerm = (typeof Battlefield !== 'undefined' && Battlefield.getPermById(effect.sourceId)) || null;
  // "Hexproof from activated and triggered abilities" (Volatile Stormdrake) stops Gilded Drake's
  // trigger but not Switcheroo.
  const hexproof = st.controller && st.controller !== you &&
    _hexproofFromSource(abilities, st, stateOf(effect.sourceId), srcPerm, { get: (id) => stateOf(id) });
  if (hexproof) return `${which} has ${hexproof.words} and cannot be targeted.`;
  if (typeof _isProtectedFromSource === 'function' && srcPerm) {
    // A copy: _getStateProtection keeps what it finds on the state it is given.
    const prot = srcPerm && _isProtectedFromSource({ ...st }, stateOf(effect.sourceId), srcPerm, perm || null, { get: (id) => stateOf(id) });
    if (prot) return `${which} has ${_formatProtectionEntry(prot)} and cannot be targeted.`;
  }
  return null;
}
const _EXCHANGE_STAT_WORDS = { power: 'power', toughness: 'toughness', manaValue: 'mana value' };

/* What a target in slot 'a' or 'b' must be, as a filter on a _restrictionState, and the words
   for it: the slot's own type text when the parser split "target X and target Y" (Oko, Thief of
   Crowns' B is "creature with power 3 or less", Shrewd Negotiation's B "artifact or creature"),
   otherwise the effect's one targetRestriction for both. { fn, words } or null. */
const _exchangeSlotRestrictionCache = new Map();
function _exchangeControlSlotRestriction(effect, slot) {
  // "Exchange control of this artifact and target creature": A is the source, not a target.
  if (slot === 'a' && effect.params.exchangeMode !== 'two_targets') return null;
  const rules = effect.params.exchangeSlotRules;
  const text = rules && (slot === 'a' ? rules.typeA : rules.typeB);
  if (!text) return effect.targetRestriction ? { fn: effect.targetRestriction, words: null } : null;
  if (!_exchangeSlotRestrictionCache.has(text)) {
    const built = buildAppliesToFromText(text);
    _exchangeSlotRestrictionCache.set(text, built && built.fn && !built.isSelf
      ? { fn: (st) => built.fn(st), words: text } : null);
  }
  return _exchangeSlotRestrictionCache.get(text);
}

/* What is wrong with a target in slot 'a' or 'b' on its own (what it is, who controls it), or
   null. perm, when given, fills in what a state lacks (token, printed P/T). */
function _exchangeControlSlotProblem(effect, slot, st, you, perm) {
  if (!st) return null;
  const restriction = _exchangeControlSlotRestriction(effect, slot);
  if (restriction && !restriction.fn(_restrictionState(st, st, perm || {}))) {
    const w = restriction.words;
    return w ? `Permanent ${slot.toUpperCase()} must be ${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}.`
      : `Permanent ${slot.toUpperCase()} is not a legal target.`;
  }
  const rules = effect.params.exchangeSlotRules;
  // Gauntlets of Chaos: B can share one of the named types with some A only if it has one.
  const among = slot === 'b' && rules && rules.shareTypesWithA;
  if (among && !(st.types || []).some(t => among.includes(t))) {
    return `Permanent B must be ${among.map(t => t.toLowerCase()).join(', ').replace(/, ([^,]+)$/, ', or $1')}.`;
  }
  const rule = getExchangeControlSlotController(effect, slot);
  if (!rule || !st.controller) return null;
  const owner = st.owner || (perm && perm.owner) || null;
  const ok = rule === 'you' ? st.controller === you
    : rule === 'neither' ? st.controller !== you && owner !== you
    : st.controller !== you;
  return ok ? null : `Permanent ${slot.toUpperCase()} must be ${_EXCHANGE_CONTROLLER_WORDS[rule]}.`;
}

/* What is wrong with exchanging aId and bId, as a sentence, or null. stateOf(id) gives a
   permanent's state, or null when it is not known (a rule needing it is then not checked); you
   is the source's controller. */
function exchangeControlPairProblem(effect, aId, bId, stateOf, you) {
  if (!effect || !aId || !bId) return null;
  if (aId === bId) return 'Cannot exchange with itself.';
  const p = effect.params;
  const stA = stateOf(aId), stB = stateOf(bId);
  if (p.shareTypeRequired && stA && stB) {
    const typesA = new Set(stA.types || []);
    if (!(stB.types || []).some(t => typesA.has(t))) return 'These permanents do not share a card type.';
  }
  // "… that shares one of those types with it" (Gauntlets of Chaos): one of the types named
  // for A that A has.
  const among = p.exchangeSlotRules && p.exchangeSlotRules.shareTypesWithA;
  if (among && stA && stB) {
    const typesA = new Set((stA.types || []).filter(t => among.includes(t)));
    if (!(stB.types || []).some(t => typesA.has(t))) {
      return `Permanent B must share one of these types with permanent A: ${among.map(t => t.toLowerCase()).join(', ')}.`;
    }
  }
  if (p.differentPlayersRequired && stA && stB && stA.controller && stA.controller === stB.controller) {
    return 'These permanents must be controlled by different players.';
  }
  const permOf = (id) => (typeof Battlefield !== 'undefined' && Battlefield.getPermById(id)) || null;
  const slotProblem = _exchangeControlSlotProblem(effect, 'a', stA, you, permOf(aId)) ||
    _exchangeControlSlotProblem(effect, 'b', stB, you, permOf(bId)) ||
    _exchangeControlTargetingProblem(effect, 'a', stA, you, permOf(aId), stateOf) ||
    _exchangeControlTargetingProblem(effect, 'b', stB, you, permOf(bId), stateOf);
  if (slotProblem) return slotProblem;
  const bound = p.exchangeSlotRules && p.exchangeSlotRules.boundByA;
  if (bound && stA && stB) {
    const v = stA[bound.refStat], x = stB[bound.stat];
    const ok = v !== null && v !== undefined && x !== null && x !== undefined &&
      (bound.less ? (bound.orEqual ? x <= v : x < v) : (bound.orEqual ? x >= v : x > v));
    if (!ok) {
      const num = (n) => (n !== null && n !== undefined ? ` (${n})` : '');
      return `Permanent B's ${_EXCHANGE_STAT_WORDS[bound.stat]}${num(x)} must be ${bound.less ? 'less' : 'greater'} than ` +
        `${bound.orEqual ? 'or equal to ' : ''}permanent A's ${_EXCHANGE_STAT_WORDS[bound.refStat]}${num(v)}.`;
    }
  }
  return null;
}

/* The same check as the modal makes it: the source's snapshot where it holds the permanent,
   otherwise the live board (finalStates). */
function exchangeControlPairProblemFor(sourceId, aId, bId, finalStates) {
  const effect = _exchangeControlEffect(sourceId);
  if (!effect) return null;
  const snap = _exchangeControlSnapshot(sourceId);
  const live = finalStates || Battlefield.getAllFinalStates();
  return exchangeControlPairProblem(effect, aId, bId,
    (id) => (snap && snap.has(id)) ? snap.get(id) : (live.get(id) || null), _exchangeControlYou(sourceId));
}

/* The permanents the exchange-control modal offers for Permanent A (slot 'a') or Permanent B
   (slot 'b'; with aId, only those that make a legal pair with it). Each is
   { id, perm, state, displayName }. Only permanents on the board as the spell was cast or the
   ability fired are offered (a current pick stays), judged by their state then; a target with
   shroud, hexproof or protection from the source is not. "Exchange control of this creature and
   target creature …" (Gilded Drake) has only B, its A being the source. */
function getExchangeControlCandidates(sourceId, slot, aId) {
  const effect = _exchangeControlEffect(sourceId);
  if (!effect) return [];
  const selfMode = effect.params.exchangeMode === 'self_and_target';
  if (selfMode && slot === 'b' && !aId) aId = effect.params.exchangeSelfId || null;
  // "This creature and that spell" (Perplexing Chimera): the spell becomes a permanent after
  // the trigger, so B is not limited to the board it fired on.
  const laterOk = selfMode && slot === 'b' && !_exchangeControlSlotTargeted(effect, 'b');
  const finalStates = Battlefield.getAllFinalStates();
  const snap = _exchangeControlSnapshot(sourceId);
  const stateOf = (id) => (snap && snap.has(id)) ? snap.get(id) : (finalStates.get(id) || null);
  const you = _exchangeControlYou(sourceId);
  const current = slot === 'a' ? effect.params.exchangeTargetA : effect.params.exchangeTargetB;
  const out = [];
  for (const t of Battlefield.permanents) {
    if (t.isManualEffect || t.isSpell) continue;
    const stack = Battlefield.getStack(t.id);
    if (stack && stack.length >= 2 && stack[0] !== t.id) continue;
    if (snap && !snap.has(t.id) && t.id !== current && !laterOk) continue;
    const fs = stateOf(t.id);
    const tState = fs
      ? { types: fs.types || [], supertypes: fs.supertypes || [], subtypes: fs.subtypes || [], colors: fs.colors || [], isAllCreatureTypes: fs.isAllCreatureTypes }
      : { types: t.printedTypes || [], supertypes: t.printedSupertypes || [], subtypes: t.printedSubtypes || [], colors: t.printedColors || [], isAllCreatureTypes: false };
    const rState = _restrictionState(tState, fs, t);
    const restriction = _exchangeControlSlotRestriction(effect, slot);
    if (restriction && !restriction.fn(rState, snap || finalStates, you)) continue;
    if (_exchangeControlSlotProblem(effect, slot, rState, you, t)) continue;
    if (_exchangeControlTargetingProblem(effect, slot, rState, you, t, stateOf)) continue;
    if (slot === 'b' && aId && exchangeControlPairProblem(effect, aId, t.id, stateOf, you)) continue;
    out.push({ id: t.id, perm: t, state: fs || tState, displayName: _targetPickerName(t, finalStates.get(t.id), true) });
  }
  return out;
}
