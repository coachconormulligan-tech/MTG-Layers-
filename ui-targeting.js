/* Render a copy-target dropdown for non-token copy cards.
   Uses final evaluated states so cards that gain types through Layer 1+ are valid targets. */
function renderCopyTargetSelect(sourceId) {
  const effect = Battlefield.effects.find(e => e.sourceId === sourceId && e.type === EFFECT_TYPE.COPY);
  if (!effect) return '';
  const restriction = effect.params.restriction;
  const currentCopyName = effect.params.copySource ? effect.params.copySource.name : '';

  // Cards like Shifting Woodland copy "target permanent card in your graveyard" — the
  // copy target lives in a non-battlefield zone, so source candidates from there instead
  // of the battlefield permanents.
  if (effect.params.copyTargetZone) {
    const zoneCards = _gatherCopyZoneCards(effect, sourceId);
    // Re-select after a board restore (where _copyTargetZoneRef is not persisted) by
    // matching the stored copySource name.
    const currentVal = effect.params._copyTargetZoneRef
      || (currentCopyName ? (zoneCards.find(zc => zc.name === currentCopyName)?.value || '') : '');
    return `<select class="ts-target-select" onchange="setCopyTargetFromZone('${sourceId}', this.value)" onclick="event.stopPropagation()">
      <option value="">copy…</option>
      ${zoneCards.map(zc => `<option value="${escapeAttr(zc.value)}" ${zc.value === currentVal ? 'selected' : ''}>${escapeHtml(zc.name)}</option>`).join('')}
    </select>`;
  }

  // Mana value cap (e.g. Mockingbird: MV <= mana spent to cast)
  let spentToCast = null;
  if (effect.params.maxManaValue === 'spentToCast') {
    const srcPerm = Battlefield.getPermById(sourceId);
    if (srcPerm) spentToCast = getSpentToCast(srcPerm);
  }

  // Use final evaluated states for restriction checking
  const finalStates = Battlefield.getAllFinalStates();
  // For spells / triggered / activated abilities, prefer the snapshot captured at fire/cast time
  // so targets are evaluated by what they WERE, not what they are now.
  const srcPermForSnap = Battlefield.getPermById(sourceId);
  const snapStates = srcPermForSnap?._firedAtStates || srcPermForSnap?._firedAtSnapshot?.states || null;
  const lookupState = (id) => (snapStates && snapStates.has(id)) ? snapStates.get(id) : finalStates.get(id);
  // Only show top cards of mutate stacks (non-top cards are not valid copy targets)
  const targets = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === sourceId) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack[0] !== p.id) return false; // not top of stack
    return true;
  });

  // Find currently selected target by matching copySource name to a battlefield perm
  let currentTargetId = '';
  if (effect.params._copyTargetPermId) {
    currentTargetId = effect.params._copyTargetPermId;
  }

  return `<select class="ts-target-select" onchange="setCopyTargetFromBattlefield('${sourceId}', this.value)" onclick="event.stopPropagation()">
    <option value="">copy\u2026</option>
    ${targets.map(t => {
      const fs = lookupState(t.id);
      const tState = fs
        ? { types: fs.types || [], supertypes: fs.supertypes || [], subtypes: fs.subtypes || [], colors: fs.colors || [], isAllCreatureTypes: fs.isAllCreatureTypes, isToken: t.isToken, counters: fs.counters || {} }
        : { types: t.printedTypes || [], supertypes: t.printedSupertypes || [], subtypes: t.printedSubtypes || [], colors: t.printedColors || [], isAllCreatureTypes: false, isToken: t.isToken, counters: t.counters || {} };
      const mvValid = spentToCast === null || (t.manaValue || 0) <= spentToCast;
      // "Choose target creature you control. Each other creature … becomes a copy of that creature".
      const ctrlValid = !effect.params.sourceYouControl || !srcPermForSnap || (fs ? fs.controller : t.controller) === srcPermForSnap.controller;
      const valid = mvValid && ctrlValid && (!restriction || restriction(tState));
      const tCopyName = (fs ? fs.name : t.name) + (fs?.copySource ? ' (copy)' : '');
      return valid ? `<option value="${t.id}" ${t.id === currentTargetId ? 'selected' : ''}>${escapeHtml(tCopyName)}</option>` : '';
    }).join('')}
  </select>`;
}

/* When a non-token copy card selects a target from the battlefield dropdown,
   build the copySource from that permanent's scryfallData (Layer 1 copy uses the
   printed/base characteristics of the target, not the final evaluated state).
   If the target is the top of a mutate stack, the copy gets ALL abilities from
   all cards in the stack (CR 702.140). */
function setCopyTargetFromBattlefield(sourceId, targetPermId) {
  if (!targetPermId) {
    // Clear copy source
    const eff = Battlefield.effects.find(e => e.sourceId === sourceId && e.type === EFFECT_TYPE.COPY);
    if (eff) {
      eff.params.copySource = null;
      delete eff.params._copyTargetPermId;
      // Remove any injected known-card effects from a previous copy
      _removeInjectedCopyEffects(sourceId);
    }
    Battlefield.evaluate();
    renderAll();
    return;
  }
  const targetPerm = Battlefield.getPermById(targetPermId);
  if (!targetPerm) return;

  // Copies copy the target's copiable values: its Layer-1 state (the copy plus its "except"
  // changes) if the target is itself a copy, otherwise its printed card.
  let copyCard = Battlefield.copiableCardOf(targetPermId);

  if (!copyCard) return;

  // CR 702.140: If the target is the top of a mutate stack, the copy gets ALL
  // abilities from all cards in the stack merged together.
  const mutateStack = Battlefield.getStack(targetPermId);
  if (mutateStack && mutateStack[0] === targetPermId && mutateStack.length > 1) {
    // Gather abilities from all stack members (top card's oracle text first)
    const topOracle = (copyCard.oracle_text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const seenAb = new Set(topOracle);
    const allAbilities = [...topOracle];
    for (let i = 1; i < mutateStack.length; i++) {
      const stackPerm = Battlefield.getPermById(mutateStack[i]);
      if (!stackPerm || !stackPerm.scryfallData) continue;
      const stackOracle = (stackPerm.scryfallData.oracle_text || '').split('\n').map(l => l.trim()).filter(Boolean);
      for (const ab of stackOracle) {
        const abL = ab.toLowerCase().trimStart();
        const allowDup = /^(?:at|when|whenever)\b/.test(abL) ||
          /\bat the beginning\b|\bwhenever\b|\bwhen you do\b/i.test(abL) ||
          /^ward\b/i.test(ab);
        if (allowDup || !seenAb.has(ab)) {
          seenAb.add(ab);
          allAbilities.push(ab);
        }
      }
    }
    // Build a synthetic copyCard with merged oracle text
    copyCard = { ...copyCard, oracle_text: allAbilities.join('\n') };
  }

  // Store which perm we're copying for the dropdown selection state
  const eff = Battlefield.effects.find(e => e.sourceId === sourceId && e.type === EFFECT_TYPE.COPY);
  if (eff) eff.params._copyTargetPermId = targetPermId;

  Battlefield.setCopySource(sourceId, copyCard);

  // Check if the copy source matches a known card and inject those effects.
  // (Not for a mass copy: its row is a spell or fired ability, not one of the copies.)
  if (!(eff && eff.params.massCopy)) _injectKnownCardEffectsForCopy(sourceId, copyCard);

  Battlefield.evaluate();
  renderAll();
}

/* Gather the candidate copy-target cards for a COPY effect whose target lives in a
   non-battlefield zone (graveyard / exile). Returns [{ value, name, card }] filtered by
   the effect's restriction. "your graveyard" is scoped to the source's controller; "a/any
   graveyard" spans every player. Exile is a flat list of entries keyed by owner. */
function _gatherCopyZoneCards(effect, sourceId) {
  const zone = effect.params.copyTargetZone;
  if (!zone) return [];
  const restriction = effect.params.restriction;
  const srcPerm = Battlefield.getPermById(sourceId);
  const controllerId = srcPerm ? (srcPerm.controller || srcPerm.owner) : Battlefield.activePlayerId;
  const ownerScope = effect.params.copyTargetZoneOwner || 'any';
  const passes = (card) => {
    if (!restriction) return true;
    const tl = parseTypeLine(card.type_line || '');
    return restriction({ types: tl.types, supertypes: tl.supertypes, subtypes: tl.subtypes,
      colors: card.colors || [], isAllCreatureTypes: false, isToken: false });
  };
  const out = [];
  if (zone === 'graveyard') {
    for (const pl of Battlefield.players) {
      if (ownerScope === 'you' && pl.id !== controllerId) continue;
      (pl.graveyard || []).forEach((card, idx) => {
        if (passes(card)) out.push({ value: `gy:${pl.id}:${idx}`, name: card.name, card });
      });
    }
  } else if (zone === 'exile') {
    (Battlefield.exile || []).forEach((entry) => {
      if (ownerScope === 'you' && entry.owner !== controllerId) return;
      const card = entry.card;
      if (card && passes(card)) out.push({ value: `ex:${entry.id}`, name: card.name, card });
    });
  }
  return out;
}

/* When a copy card whose target lives in a graveyard/exile picks from the zone dropdown,
   build the copySource directly from the chosen card's data (zone cards are stored as raw
   Scryfall card objects, so no Layer-1 re-derivation is needed). */
function setCopyTargetFromZone(sourceId, value) {
  const eff = Battlefield.effects.find(e => e.sourceId === sourceId && e.type === EFFECT_TYPE.COPY);
  if (!eff) return;
  if (!value) {
    eff.params.copySource = null;
    delete eff.params._copyTargetZoneRef;
    _removeInjectedCopyEffects(sourceId);
    Battlefield.evaluate();
    renderAll();
    return;
  }
  const picked = _gatherCopyZoneCards(eff, sourceId).find(zc => zc.value === value);
  if (!picked) return;
  eff.params._copyTargetZoneRef = value;
  Battlefield.setCopySource(sourceId, picked.card);
  _injectKnownCardEffectsForCopy(sourceId, picked.card);
  Battlefield.evaluate();
  renderAll();
}

/* Remove any previously injected known-card effects from a copy */
function _removeInjectedCopyEffects(sourceId) {
  Battlefield.effects = Battlefield.effects.filter(e => !(e._injectedByCopy === sourceId));
}

/* If the copy source is a known card (e.g. Deadpool, Exchange of Words),
   inject that card's known effects so the copy behaves like the original */
function _injectKnownCardEffectsForCopy(sourceId, copyCard) {
  // Remove any previously injected effects
  _removeInjectedCopyEffects(sourceId);

  const perm = Battlefield.getPermById(sourceId);
  if (!perm) return;

  // Match by ability lines instead of card name — normalize the copy source's oracle text
  // and check each line against KNOWN_ABILITY_EFFECTS.
  const oracleText = copyCard.oracle_text || '';
  const stripped = _stripReminderText(oracleText);
  const normalized = _replaceProperNounSelfRef(copyCard.name || '', stripped, false);
  const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const lineKey = line.toLowerCase();
    if (!KNOWN_ABILITY_EFFECTS[lineKey]) continue;

    for (const template of KNOWN_ABILITY_EFFECTS[lineKey]) {
      // Skip COPY effects - we already have one
      if (template.type === EFFECT_TYPE.COPY) continue;
      const eff = {
        ...template,
        id: `${sourceId}_copyinj_${Battlefield.effects.length}`,
        sourceId: sourceId,
        sourceName: perm.name,
        timestamp: perm.timestamp,
        _injectedByCopy: sourceId, // marker for cleanup
      };
      // Deep-copy params to avoid sharing references
      if (template.params) eff.params = { ...template.params };
      if (template.appliesTo) eff.appliesTo = { ...template.appliesTo };
      Battlefield.effects.push(eff);
    }
  }

  // A copy of an Aura needs an attachment target. The engine re-parses the copied
  // oracle text inside the evaluation (Layer 3 -> _reParseAfterTextChange), so it
  // already computes the aura's effects — but those re-parsed effects live only
  // inside one evaluation pass and never reach Battlefield.effects, so no target
  // dropdown is rendered and the user can't pick what to enchant. Inject the copy
  // source's targeted aura effect(s) here so getEffectInfo() reports hasTargeted,
  // renderTargetSelect() shows the "Enchant ___" dropdown, and setTarget() can
  // stamp a targetId. On the next evaluate, _reParseAfterTextChange drops these
  // injected Layer 4+ effects and recreates them from the copied text, carrying
  // over the stamped targetId — so the effect applies exactly once.
  const isAuraCopy = /\bAura\b/.test(copyCard.type_line || '') || /\benchant\b/i.test(oracleText);
  if (isAuraCopy && typeof parseCardEffects === 'function') {
    const fakeCard = {
      name: copyCard.name || '',
      oracle_text: oracleText,
      type_line: copyCard.type_line || '',
      colors: copyCard.colors || [],
      cmc: copyCard.cmc || 0,
    };
    const parsed = parseCardEffects(perm, fakeCard) || [];
    for (const pe of parsed) {
      if (!pe.auraRestriction || pe.scope !== 'targeted' || pe.selfTarget) continue;
      pe.id = `${sourceId}_copyaura_${Battlefield.effects.length}`;
      pe.sourceId = sourceId;
      pe.sourceName = perm.name;
      pe.timestamp = perm.timestamp;
      pe._injectedByCopy = sourceId; // marker for cleanup
      Battlefield.effects.push(pe);
    }
  }
}

/* The target picker(s) the timestamp panel shows for a source, given getTargetPickerKind's answer. */
function renderTargetPickers(sourceId, picker) {
  if (picker.kind === 'slotted') return Array.from({length: picker.slots}, (_, i) => renderSlottedTargetSelect(sourceId, i)).join('');
  if (picker.kind === 'modal') return renderModalModeTargets(sourceId, picker.modes);
  if (picker.kind === 'multi') return renderMultiTargetSelect(sourceId, picker.maxTargets);
  if (picker.kind === 'single') return renderTargetSelect(sourceId);
  return '';
}

function renderTargetSelect(sourceId) {
  const r = getTargetCandidates(sourceId, { kind: 'single' });
  if (r.blocked) {
    return `<div class="ts-equip-blocked" style="color:#c44;font-size:0.85em;padding:2px 6px;">${r.blocked}</div>`;
  }
  return `<select class="ts-target-select" onchange="setEffectTarget('${sourceId}', this.value)" onclick="event.stopPropagation()">
    <option value="">${r.isAttached ? '\u2192 Unattach' : r.isNonTargeting ? '\u2192 choose\u2026' : '\u2192 target\u2026'}</option>
    ${r.candidates.map(c => `<option value="${c.id}" ${c.id === r.currentTarget ? 'selected' : ''}>${escapeHtml(c.displayName)}</option>`).join('')}
  </select>`;
}

/* The object a fired ability takes its numbers or abilities from ("…base power becomes equal
   to that creature's power" — Belligerent Yearling; "… target creature's power" — Riptide
   Mangler; "gains all activated abilities of target creature" — Quicksilver Elemental).
   The effect stays on its own subject; this only picks where the values come from. */
function renderRefPermSelect(sourceId) {
  const sourcePerm = Battlefield.getPermById(sourceId);
  const pick = sourcePerm && sourcePerm._refPick;
  const eff = Battlefield.effects.find(e => e.sourceId === sourceId && _takesFromRef(e));
  if (!pick || !eff) return '';
  const current = eff.params.refPermId || '';
  const sourceCtrl = sourcePerm.controller || sourcePerm.owner || Battlefield.activePlayerId;
  const applies = buildAppliesToFromText(pick.filter);
  const finalStates = Battlefield.getAllFinalStates();
  const snapStates = sourcePerm._firedAtStates || null;
  const options = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.isSpell) return false;
    if (pick.excludeSource && p.id === (sourcePerm.abilitySourceId || sourcePerm.id)) return false;
    if (p.timestamp >= sourcePerm.timestamp && p.id !== current) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack.length >= 2 && stack[0] !== p.id) return false;
    const fs = (snapStates && snapStates.get(p.id)) || finalStates.get(p.id);
    if (!fs) return false;
    if (pick.youControl && (fs.controller || p.controller || p.owner || 'player_0') !== sourceCtrl) return false;
    if (pick.opponentControls && (fs.controller || p.controller || p.owner || 'player_0') === sourceCtrl) return false;
    if (applies.fn && !applies.isSelf && !applies.fn(fs, finalStates, sourceCtrl)) return false;
    if (pick.isTarget) {
      const abilities = fs.abilities || [];
      if (abilities.some(a => /\bshroud\b/i.test(a))) return false;
      if ((p.controller || p.owner || 'player_0') !== sourceCtrl && abilities.some(a => /\bhexproof\b/i.test(a))) return false;
    }
    return true;
  });
  return `<select class="ts-target-select" onchange="setRefPerm('${sourceId}', this.value)" onclick="event.stopPropagation()">
    <option value="">${pick.isTarget ? '\u2192 target\u2026' : '\u2192 choose\u2026'}</option>
    ${options.map(t => `<option value="${t.id}" ${t.id === current ? 'selected' : ''}>${escapeHtml(_refPermDisplayName(t, finalStates))}</option>`).join('')}
  </select>`;
}
/* The card "last chosen" among those exiled with a permanent (Koh, the Face Stealer). */
function renderChosenExileSelect(permId) {
  const perm = Battlefield.getPermById(permId);
  const need = perm && perm._needsChosenExileCard;
  if (!need) return '';
  const current = perm._chosenExileId || '';
  const options = Battlefield.exile.filter(e => {
    if (e.exiledWithId !== permId || e.isFaceDown || !e.card) return false;
    if (!need.requireCreature) return true;
    return typeof _isCreatureCardInZone === 'function' ? _isCreatureCardInZone(e.card, 'exile')
      : /creature/i.test(e.card.type_line || '');
  });
  return `<select class="ts-target-select" onchange="setChosenExileCard('${permId}', this.value)" onclick="event.stopPropagation()">
    <option value="">\u2192 choose card\u2026</option>
    ${options.map(e => `<option value="${e.id}" ${e.id === current ? 'selected' : ''}>${escapeHtml(e.card.name)}</option>`).join('')}
  </select>`;
}
function setChosenExileCard(permId, entryId) {
  Battlefield.setChosenExileCard(permId, entryId || null);
  renderAll();
}
function _refPermDisplayName(t, finalStates) {
  const fs = finalStates.get(t.id);
  let name = (fs && fs.copySource ? fs.name + ' (copy)' : t.name) + (t.label ? ' ' + t.label : '');
  if (Battlefield.players.length > 1 && t.owner) name += ` [${Battlefield.getPlayerName(t.controller || t.owner)}]`;
  return name;
}
function setRefPerm(sourceId, permId) {
  Battlefield.setRefPerm(sourceId, permId || null);
  Battlefield.evaluate();
  renderAll();
}

/* "Target opponent" dropdown — pick a single opponent (any player who is NOT the
   controller of this source's spell/ability). Used by cards like Curious Colossus
   whose effect reads "each creature target opponent controls...". */
function renderTargetOpponentSelect(sourceId) {
  const sourcePerm = Battlefield.getPermById(sourceId);
  if (!sourcePerm) return '';
  const sourceCtrl = sourcePerm.controller || sourcePerm.owner || Battlefield.activePlayerId;
  const current = sourcePerm._targetOpponentPlayerId || '';
  const opponents = (Battlefield.players || []).filter(pl => pl.id !== sourceCtrl);
  if (opponents.length === 0) return '';
  return `<select class="ts-target-select ts-target-opponent" onchange="setTargetOpponent('${sourceId}', this.value)" onclick="event.stopPropagation()">
    <option value="">\u2192 target opponent\u2026</option>
    ${buildPlayerSelectOptions(opponents, current)}
  </select>`;
}

function setTargetOpponent(sourceId, playerId) {
  Battlefield.setTargetOpponent(sourceId, playerId || null);
  Battlefield.evaluate();
  renderAll();
}

/* "Target player" dropdown — pick any player (including self). Used by cards like
   Bazaar Trader whose effect reads "target player gains control of target ... you control." */
function renderTargetPlayerSelect(sourceId) {
  const sourcePerm = Battlefield.getPermById(sourceId);
  if (!sourcePerm) return '';
  const current = sourcePerm._targetPlayerId || '';
  const players = Battlefield.players || [];
  if (players.length === 0) return '';
  return `<select class="ts-target-select ts-target-player" onchange="setTargetPlayer('${sourceId}', this.value)" onclick="event.stopPropagation()">
    <option value="">\u2192 target player\u2026</option>
    ${buildPlayerSelectOptions(players, current)}
  </select>`;
}

function setTargetPlayer(sourceId, playerId) {
  Battlefield.setTargetPlayer(sourceId, playerId || null);
  Battlefield.evaluate();
  renderAll();
}

/* "Enchant player" dropdown — pick which player this curse/aura enchants.
   Used by cards like Curse of Conformity whose static effects apply to the
   chosen player's permanents. */
function renderEnchantedPlayerSelect(sourceId) {
  const sourcePerm = Battlefield.getPermById(sourceId);
  if (!sourcePerm) return '';
  const current = sourcePerm._enchantedPlayerId || '';
  const players = Battlefield.players || [];
  if (players.length === 0) return '';
  return `<select class="ts-target-select ts-target-player" onchange="setEnchantedPlayer('${sourceId}', this.value)" onclick="event.stopPropagation()">
    <option value="">→ enchanted player…</option>
    ${buildPlayerSelectOptions(players, current)}
  </select>`;
}

function setEnchantedPlayer(sourceId, playerId) {
  Battlefield.setEnchantedPlayer(sourceId, playerId || null);
  Battlefield.evaluate();
  renderAll();
}

/* Render multiple target dropdowns for "up to N target" effects */
function renderMultiTargetSelect(sourceId, maxTargets) {
  let html = '<div class="multi-target-group" onclick="event.stopPropagation()">';
  for (let i = 0; i < maxTargets; i++) {
    const r = getTargetCandidates(sourceId, { kind: 'multi', slotIndex: i });
    html += `<select class="ts-target-select ts-target-multi" onchange="setMultiTarget('${sourceId}', ${i}, this.value)">
      <option value="">${r.isNonTargeting ? '\u2192 choose' : '\u2192 target'} ${i + 1}\u2026</option>
      ${r.candidates.map(c => `<option value="${c.id}" ${c.id === r.currentTarget ? 'selected' : ''}>${escapeHtml(c.displayName)}</option>`).join('')}
    </select>`;
  }
  html += '</div>';
  return html;
}

function setEffectTarget(sourceId, targetId) {
  Battlefield.setTarget(sourceId, targetId || null);
  Battlefield.evaluate();
  renderAll();
}

/* Set a specific target slot for multi-target effects */
function setMultiTarget(sourceId, slotIndex, targetId) {
  Battlefield.setMultiTarget(sourceId, slotIndex, targetId || null);
  Battlefield.evaluate();
  renderAll();
}

/* Set one independently-addressed target slot for multi-sentence spells (e.g. Seeds of Strength) */
function setSlottedTarget(sourceId, slot, targetId) {
  Battlefield.setSlottedTarget(sourceId, parseInt(slot), targetId || null);
  Battlefield.evaluate();
  renderAll();
}

/* Render a target dropdown for one slot of a multi-sentence spell. Each slot tracks its own
   targetId and restriction independently. */
function renderSlottedTargetSelect(sourceId, slot) {
  const r = getTargetCandidates(sourceId, { kind: 'slotted', slot });
  return `<select class="ts-target-select" onchange="setSlottedTarget('${sourceId}', ${slot}, this.value)" onclick="event.stopPropagation()">
    <option value="">→ target ${slot + 1}…</option>
    ${r.candidates.map(c => `<option value="${c.id}" ${c.id === r.currentTarget ? 'selected' : ''}>${escapeHtml(c.displayName)}</option>`).join('')}
  </select>`;
}

/* Render per-mode target dropdowns for modal spells whose active modes each need a
   separate target (e.g. Twisted Reflection with Entwine: mode 0 targets one creature,
   mode 1 targets another). One labeled dropdown per active targeted modal mode. */
function renderModalModeTargets(sourceId, activeModeIndices) {
  const sourcePerm = Battlefield.getPermById(sourceId);
  const modeTexts = sourcePerm && sourcePerm.modalModeTexts ? sourcePerm.modalModeTexts : [];
  let html = '<div class="multi-target-group" onclick="event.stopPropagation()">';
  for (const modeIdx of activeModeIndices) {
    const r = getTargetCandidates(sourceId, { kind: 'modal', modeIndex: modeIdx });
    if (r.noEffect) continue;
    const modeLabel = modeTexts[modeIdx]
      ? (modeTexts[modeIdx].length > 40 ? modeTexts[modeIdx].substring(0, 37) + '...' : modeTexts[modeIdx])
      : `Mode ${modeIdx + 1}`;
    html += `<select class="ts-target-select ts-target-multi" title="${escapeAttr(modeTexts[modeIdx] || '')}"
        onchange="setModalModeTarget('${escapeAttr(sourceId)}', ${modeIdx}, this.value)">
      <option value="">${r.isNonTargeting ? '\u2192 choose' : '\u2192 target'} (${escapeHtml(modeLabel)})\u2026</option>
      ${r.candidates.map(c => `<option value="${c.id}" ${c.id === r.currentTarget ? 'selected' : ''}>${escapeHtml(c.displayName)}</option>`).join('')}
    </select>`;
  }
  html += '</div>';
  return html;
}

function setModalModeTarget(sourceId, modeIndex, targetId) {
  Battlefield.setModalModeTarget(sourceId, modeIndex, targetId || null);
  Battlefield.evaluate();
  renderAll();
}
/* [END: TIMESTAMP-UI] */

