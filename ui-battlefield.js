/* Global toggle: hide triggered/activated ability pseudo-permanents from the battlefield */
let _hideAbilityPseudoPerms = false;
function toggleHideAbilityPerms() {
  _hideAbilityPseudoPerms = !_hideAbilityPseudoPerms;
  // If the currently-inspected perm is now hidden, deselect it
  if (_hideAbilityPseudoPerms && Battlefield.inspectedId) {
    const p = Battlefield.permanents.find(x => x.id === Battlefield.inspectedId);
    if (p && (p.isTriggeredAbility || p.isActivatedAbility)) {
      Battlefield.inspectedId = null;
    }
  }
  renderAll();
}

/* [KEY: BATTLEFIELD-UI] */
function renderBattlefield() {
  const container = document.getElementById('battlefield');
  // Compute final states first so Layer 2 control-changing effects are reflected in the display
  const finalStates = Battlefield.getAllFinalStates();
  // Show permanents whose computed controller (post-layers) is the active player.
  // Fall back to p.owner (not p.controller) so a permanent with no active Layer 2
  // effects always appears on its owner's board.
  const perms = Battlefield.permanents.filter(p => {
    if (p.isEmblem) return false; // emblems live in command zone, not battlefield
    if (_hideAbilityPseudoPerms && (p.isTriggeredAbility || p.isActivatedAbility)) return false;
    const ctrl = finalStates.get(p.id)?.controller || p.owner || 'player_0';
    return ctrl === Battlefield.activePlayerId;
  });

  const hideBtn = document.getElementById('hide-abilities-btn');
  if (hideBtn) {
    hideBtn.textContent = _hideAbilityPseudoPerms ? 'Show abilities' : 'Hide abilities';
    hideBtn.classList.toggle('active', _hideAbilityPseudoPerms);
  }

  if (perms.length === 0) {
    container.innerHTML = `<div class="bf-empty">
      <div class="bf-empty-icon">+</div>
      <div>Search and add cards to begin inspection</div>
    </div>`;
    return;
  }

  // Pre-index effects by sourceId to avoid O(n×m) scans inside perm loops.
  const effectsBySourceId = new Map();
  const creatureTargetSourceIds = new Set();
  for (const e of Battlefield.effects) {
    if (!effectsBySourceId.has(e.sourceId)) effectsBySourceId.set(e.sourceId, []);
    effectsBySourceId.get(e.sourceId).push(e);
    if (e.requiresCreatureTarget) creatureTargetSourceIds.add(e.sourceId);
  }

  // Detect legend-rule-exempt permanent types from oracle text
  const legendExemptTypes = new Set();
  for (const [, st] of finalStates) {
    const txt = st.oracleText || '';
    const m = txt.match(/the\s+[\u201c"\'"]legend rule[\u201d"\'"]?\s+doesn'?t\s+apply\s+to\s+(.+)/i);
    if (m) {
      const raw = m[1].replace(/you control\.?/i, '').replace(/[.,;]+$/, '').trim().toLowerCase();
      const typeWords = { creatures: 'Creature', permanents: 'Permanent', artifacts: 'Artifact',
        enchantments: 'Enchantment', lands: 'Land', planeswalkers: 'Planeswalker',
        creature: 'Creature', permanent: 'Permanent', artifact: 'Artifact',
        enchantment: 'Enchantment', land: 'Land', planeswalker: 'Planeswalker' };
      for (const [word, type] of Object.entries(typeWords)) {
        if (raw.includes(word)) legendExemptTypes.add(type);
      }
      if (/\btokens?\b/i.test(raw)) legendExemptTypes.add('Token');
    }
  }

  const legendaryByName = new Map();
  for (const p of perms) {
    // Legend rule only checks final states, and a mutate stack counts as ONE card.
    // Only the top card of a mutate stack participates in the legend rule check.
    const myStack = Battlefield.getStack(p.id);
    if (myStack && myStack.length >= 2 && myStack[0] !== p.id) continue;
    const st = finalStates.get(p.id);
    if (!st) continue;
    if (st.supertypes && st.supertypes.includes('Legendary')) {
      const isExempt = (st.types && st.types.some(t => legendExemptTypes.has(t)))
        || legendExemptTypes.has('Permanent')
        || (legendExemptTypes.has('Token') && p.isToken);
      if (!isExempt) {
        const nm = st.name;
        if (!legendaryByName.has(nm)) legendaryByName.set(nm, []);
        legendaryByName.get(nm).push(p.id);
      }
    }
  }
  const legendViolationIds = new Set();
  for (const [, ids] of legendaryByName) {
    if (ids.length >= 2) ids.forEach(id => legendViolationIds.add(id));
  }

  const zeroToughnessIds = new Set();
  for (const p of perms) {
    const st = finalStates.get(p.id);
    if (!st) continue;
    if (st.types && st.types.includes('Creature') && st.toughness !== null && st.toughness !== undefined && st.toughness <= 0) {
      zeroToughnessIds.add(p.id);
    }
  }

  const noLoyaltyIds = new Set();
  for (const p of perms) {
    const st = finalStates.get(p.id);
    if (!st) continue;
    if (st.types && st.types.includes('Planeswalker')) {
      const loyaltyCount = (p.counters && p.counters['loyalty']) || 0;
      if (loyaltyCount <= 0) noLoyaltyIds.add(p.id);
    }
  }

  const sagaFinishedIds = new Set();
  for (const p of perms) {
    const st = finalStates.get(p.id);
    if (!st) continue;
    if (st.subtypes && st.subtypes.includes('Saga') && p._sagaMaxChapter) {
      const loreCount = (p.counters && p.counters['lore']) || 0;
      if (loreCount >= p._sagaMaxChapter) sagaFinishedIds.add(p.id);
    }
  }

  // CR 704.5p: If a creature is attached to an object or player, it becomes unattached.
  // Detect equipment that is currently a creature AND has a target assigned (is equipping).
  // Reconfigure cards are exempt because they lose creature type when equipping.
  // Also detect Auras that have become creatures while enchanting a permanent.
  const creatureAttachedIds = new Set();
  for (const p of perms) {
    const st = finalStates.get(p.id);
    if (!st) continue;
    if (!st.types || !st.types.includes('Creature')) continue;

    // Equipment/reconfigure that is now also a creature — CR 704.5p.
    // Match on Equipment subtype in the final state (covers animated equipment) OR
    // on requiresCreatureTarget (covers standard equip abilities).
    const stSubs = st.subtypes || [];
    const isEquipmentBySubtype = stSubs.includes('Equipment');
    const isEquipping = (isEquipmentBySubtype || creatureTargetSourceIds.has(p.id)) &&
      (effectsBySourceId.get(p.id) || []).some(e =>
        e.scope === 'targeted' && !e.selfTarget && e.targetId &&
        (e.requiresCreatureTarget || isEquipmentBySubtype));
    if (isEquipping) {
      creatureAttachedIds.add(p.id);
      Battlefield.effects.forEach(e => {
        if (e.sourceId === p.id && e.scope === 'targeted' && !e.selfTarget) e.targetId = null;
      });
      _showSBAToast(`"${p.name}" is a creature and was attached to another object. As a state-based action (rule 704.5p), it has become unattached and remains on the battlefield.`);
      if (!renderBattlefield._sbaRerender) {
        renderBattlefield._sbaRerender = true;
        setTimeout(() => { renderBattlefield._sbaRerender = false; Battlefield._invalidate(); renderAll(); }, 0);
      }
    }

    // Aura that has become a creature while enchanting a permanent
    if (!creatureAttachedIds.has(p.id) && stSubs.includes('Aura')) {
      const isEnchanting = (effectsBySourceId.get(p.id) || []).some(e =>
        e.scope === 'targeted' && !e.selfTarget && e.targetId);
      if (isEnchanting) {
        creatureAttachedIds.add(p.id);
        Battlefield.effects.forEach(e => {
          if (e.sourceId === p.id && e.scope === 'targeted' && !e.selfTarget) e.targetId = null;
        });
        _showSBAToast(`"${p.name}" is an Aura that became a creature while attached. As a state-based action, it has become unattached and remains on the battlefield.`);
        if (!renderBattlefield._sbaRerender) {
          renderBattlefield._sbaRerender = true;
          setTimeout(() => { renderBattlefield._sbaRerender = false; Battlefield._invalidate(); renderAll(); }, 0);
        }
      }
    }
  }

  // Aura enchant restriction no longer satisfied.
  // e.g., "Enchant creature" aura whose target lost the Creature type via another continuous effect.
  const illegalAuraAttachIds = new Set();
  for (const p of perms) {
    if (creatureAttachedIds.has(p.id) || illegalAuraAttachIds.has(p.id)) continue;
    const pFs = finalStates.get(p.id);
    if (!pFs || !(pFs.subtypes || []).includes('Aura')) continue;
    const auraEffWithRestriction = (effectsBySourceId.get(p.id) || []).find(e =>
      e.scope === 'targeted' && !e.selfTarget && e.targetId && e.auraRestriction);
    if (!auraEffWithRestriction) continue;
    const targetFs = finalStates.get(auraEffWithRestriction.targetId);
    if (!targetFs) continue;
    if (auraEffWithRestriction.auraRestriction(targetFs)) continue; // still legal
    // Attachment is now illegal — auto-unattach
    Battlefield.effects.forEach(e => {
      if (e.sourceId === p.id && e.scope === 'targeted' && !e.selfTarget) {
        e.targetId = null;
        if (Array.isArray(e.targetIds)) e.targetIds = [];
      }
    });
    if (Battlefield.bestowTargets instanceof Map && Battlefield.bestowTargets.has(p.id)) {
      Battlefield.bestowTargets.delete(p.id);
    }
    illegalAuraAttachIds.add(p.id);
    _showSBAToast(`"${p.name}"'s enchant restriction is no longer satisfied. As a state-based action, it has become unattached.`);
    if (!renderBattlefield._sbaRerender) {
      renderBattlefield._sbaRerender = true;
      setTimeout(() => { renderBattlefield._sbaRerender = false; Battlefield._invalidate(); renderAll(); }, 0);
    }
  }

  // CR 704.5q: Equipment attached to a permanent that is not a creature becomes unattached.
  // This creates a dependency: the effect that removed the Creature type from the target
  // influences whether the equipment effects apply (engine already enforces this via
  // requiresCreatureTarget check in effectAppliesToPerm; here we clear the targetId so
  // the equipment is also visually unattached and re-evaluation reflects the new state).
  const equipNonCreatureIds = new Set();
  for (const p of perms) {
    if (creatureAttachedIds.has(p.id) || illegalAuraAttachIds.has(p.id)) continue;
    const pFs = finalStates.get(p.id);
    if (!pFs) continue;
    const pSubs = pFs.subtypes || [];
    const isEquipment = pSubs.includes('Equipment') || creatureTargetSourceIds.has(p.id);
    if (!isEquipment) continue;
    const equipEff = (effectsBySourceId.get(p.id) || []).find(e =>
      e.scope === 'targeted' && !e.selfTarget && e.targetId && e.requiresCreatureTarget);
    if (!equipEff) continue;
    const targetFs = finalStates.get(equipEff.targetId);
    if (!targetFs) continue;
    if (targetFs.types && targetFs.types.includes('Creature')) continue;
    // Aura+Equipment dual: valid if it can still legally enchant the target as an aura
    if (pSubs.includes('Aura') && (!equipEff.auraRestriction || equipEff.auraRestriction(targetFs))) continue;
    const targetPerm = Battlefield.permanents.find(pp => pp.id === equipEff.targetId);
    const targetName = targetPerm ? targetPerm.name : 'a permanent';
    Battlefield.effects.forEach(e => {
      if (e.sourceId === p.id && e.scope === 'targeted' && !e.selfTarget) e.targetId = null;
    });
    equipNonCreatureIds.add(p.id);
    _showSBAToast(`"${p.name}" is attached to "${targetName}" which is not a creature. As a state-based action (CR 704.5q), the Equipment has become unattached.`);
    if (!renderBattlefield._sbaRerender) {
      renderBattlefield._sbaRerender = true;
      setTimeout(() => { renderBattlefield._sbaRerender = false; Battlefield._invalidate(); renderAll(); }, 0);
    }
  }

  // CR 704.5n — Aura/Equipment/Fortification illegally attached due to protection.
  // Scan attachers (auras, equipment, bestow) whose target now has protection from
  // the source. Clear their effect targetId(s) and any bestow target, then show toast.
  const protectionUnattachedIds = new Set();
  for (const p of perms) {
    const sFs = finalStates.get(p.id);
    if (!sFs) continue;
    const subs = sFs.subtypes || [];
    const isAura = subs.includes('Aura');
    const isEquipment = subs.includes('Equipment') || creatureTargetSourceIds.has(p.id);
    const isFort = subs.includes('Fortification');
    if (!isAura && !isEquipment && !isFort) continue;
    // Find bestow target or first targeted-effect target
    let attachTargetId = (typeof Battlefield.getBestowTarget === 'function')
      ? Battlefield.getBestowTarget(p.id) : null;
    if (!attachTargetId) {
      const eff = (effectsBySourceId.get(p.id) || []).find(e =>
        e.scope === 'targeted' && !e.selfTarget && e.targetId);
      if (eff) attachTargetId = eff.targetId;
    }
    if (!attachTargetId) continue;
    const tFs = finalStates.get(attachTargetId);
    if (!tFs) continue;
    // Aura/equipment attachment is a continuous game-object linkage (not a one-time
    // spell effect), so the timestamp-bypass for one-time effects doesn't apply here.
    // We still pass the target perm so the helper has it available.
    const targetPerm = Battlefield.permanents.find(pp => pp.id === attachTargetId);
    const protEntry = (typeof _isProtectedFromSource === 'function')
      ? _isProtectedFromSource(tFs, sFs, p, targetPerm) : null;
    if (!protEntry) continue;
    // Clear all targeted effect targets from this source
    Battlefield.effects.forEach(e => {
      if (e.sourceId === p.id && e.scope === 'targeted' && !e.selfTarget) {
        e.targetId = null;
        if (Array.isArray(e.targetIds)) e.targetIds = [];
      }
    });
    // Clear bestow target
    if (Battlefield.bestowTargets && Battlefield.bestowTargets[p.id]) {
      delete Battlefield.bestowTargets[p.id];
    }
    protectionUnattachedIds.add(p.id);
    const protLabel = (typeof _formatProtectionEntry === 'function')
      ? _formatProtectionEntry(protEntry) : `protection from ${protEntry.value || protEntry.kind}`;
    _showSBAToast(`"${p.name}" was illegally attached to a permanent with ${protLabel}. As a state-based action (CR 704.5n), it has become unattached.`);
    if (!renderBattlefield._sbaRerender) {
      renderBattlefield._sbaRerender = true;
      setTimeout(() => { renderBattlefield._sbaRerender = false; Battlefield._invalidate(); renderAll(); }, 0);
    }
  }

  // CR 704.5d/e: An Aura with no legal attachment goes to the graveyard.
  // Exclude auras already handled by illegalAuraAttachIds (targetId was just cleared —
  // they would falsely appear here too, but they'll be caught on the next render cycle).
  const unattachedAuraIds = new Set();
  for (const p of perms) {
    if (illegalAuraAttachIds.has(p.id) || creatureAttachedIds.has(p.id)) continue;
    const st = finalStates.get(p.id);
    if (!st) continue;
    const subs = st.subtypes || [];
    if (!subs.includes('Aura')) continue;
    const hasBestowTarget = typeof Battlefield.getBestowTarget === 'function' && Battlefield.getBestowTarget(p.id);
    const hasEffectTarget = (effectsBySourceId.get(p.id) || []).some(e =>
      e.scope === 'targeted' && !e.selfTarget && e.targetId);
    const hasEnchantPlayer = p._isEnchantPlayer && p._enchantedPlayerId;
    if (!hasBestowTarget && !hasEffectTarget && !hasEnchantPlayer) {
      unattachedAuraIds.add(p.id);
    }
  }

  const sbaIds = new Set([...legendViolationIds, ...zeroToughnessIds, ...noLoyaltyIds, ...sagaFinishedIds, ...creatureAttachedIds, ...protectionUnattachedIds, ...illegalAuraAttachIds, ...equipNonCreatureIds, ...unattachedAuraIds]);

  // Determine which perms are in mutate stacks
  const stackedIds = new Set();
  for (const stack of Battlefield.mutateStacks) {
    for (const id of stack) stackedIds.add(id);
  }

  // Build render order: groups (stacks) and standalone cards, maintaining timestamp order
  // For stacks, we render them as a group at the position of the earliest card in the stack.
  const permById = new Map(perms.map(p => [p.id, p]));
  const rendered = new Set();
  const renderItems = []; // each item: { type: 'stack'|'card', stack?, perm? }

  // Group Auras/Equipment/Bestow under their attached target so they visually sit behind the
  // target card in a fan. Attacher perms are removed from the main grid.
  const attachersByTarget = new Map();
  const attacherIds = new Set();
  for (const p of perms) {
    const fs = finalStates.get(p.id);
    const subs = fs ? (fs.subtypes || []) : (p.printedSubtypes || []);
    const isAura = subs.includes('Aura');
    const isEquipment = subs.includes('Equipment') || creatureTargetSourceIds.has(p.id);
    if (!isAura && !isEquipment) continue;
    // Bestow cards track their target separately; fall back to regular effect targetId
    let targetId = p.hasBestow ? (Battlefield.getBestowTarget(p.id) || null) : null;
    if (!targetId) {
      const eff = (effectsBySourceId.get(p.id) || []).find(e =>
        e.scope === 'targeted' && !e.selfTarget && e.targetId);
      targetId = eff ? eff.targetId : null;
    }
    if (!targetId) continue;
    if (!permById.has(targetId)) continue;
    if (targetId === p.id) continue;
    if (!attachersByTarget.has(targetId)) attachersByTarget.set(targetId, []);
    attachersByTarget.get(targetId).push(p);
    attacherIds.add(p.id);
  }
  for (const arr of attachersByTarget.values()) arr.sort((a, b) => b.timestamp - a.timestamp);

  // Ghost attachers: aura/equipment/bestow cards controlled by OTHER players that enchant/equip
  // a permanent on the active player's board. Shown faded as a visual reminder; clicking them
  // opens their Layer Inspector (they are still physically owned by another player).
  const ghostAttachersByTarget = new Map();
  for (const p of Battlefield.permanents) {
    if (p.isEmblem) continue;
    const ctrl = finalStates.get(p.id)?.controller || p.owner || 'player_0';
    if (ctrl === Battlefield.activePlayerId) continue;
    const fs = finalStates.get(p.id);
    const subs = fs ? (fs.subtypes || []) : (p.printedSubtypes || []);
    const isAura = subs.includes('Aura');
    const isEquipment = subs.includes('Equipment') || creatureTargetSourceIds.has(p.id);
    if (!isAura && !isEquipment) continue;
    let targetId = p.hasBestow ? (Battlefield.getBestowTarget(p.id) || null) : null;
    if (!targetId) {
      const eff = (effectsBySourceId.get(p.id) || []).find(e =>
        e.scope === 'targeted' && !e.selfTarget && e.targetId);
      targetId = eff ? eff.targetId : null;
    }
    if (!targetId) continue;
    if (!permById.has(targetId)) continue;
    if (targetId === p.id) continue;
    if (!ghostAttachersByTarget.has(targetId)) ghostAttachersByTarget.set(targetId, []);
    ghostAttachersByTarget.get(targetId).push(p);
  }
  for (const arr of ghostAttachersByTarget.values()) arr.sort((a, b) => b.timestamp - a.timestamp);

  // Sort perms by timestamp ascending: earlier cards on left, later on right
  const sortedPerms = [...perms].sort((a, b) => a.timestamp - b.timestamp);

  for (const p of sortedPerms) {
    if (rendered.has(p.id)) continue;
    if (attacherIds.has(p.id)) { rendered.add(p.id); continue; }
    const stack = Battlefield.getStack(p.id);
    const stackPerms = stack ? stack.map(id => permById.get(id)).filter(Boolean) : null;
    if (stackPerms && stackPerms.length >= 2) {
      // Only render the stack once (at the position of the first stack member we encounter)
      renderItems.push({ type: 'stack', stack, stackPerms });
      for (const sp of stackPerms) rendered.add(sp.id);
    } else {
      renderItems.push({ type: 'card', perm: p });
      rendered.add(p.id);
    }
  }

  function renderCardDiv(p) {
    const isSelected = p.id === Battlefield.inspectedId;
    const _cardFs = finalStates.get(p.id);
    const isCreature = _cardFs ? _cardFs.types.includes('Creature') : p.printedTypes.includes('Creature');
    const hasSBA = sbaIds.has(p.id);
    const sbaReasons = [];
    if (legendViolationIds.has(p.id)) sbaReasons.push('legend');
    if (zeroToughnessIds.has(p.id)) sbaReasons.push('toughness');
    if (noLoyaltyIds.has(p.id)) sbaReasons.push('loyalty');
    if (sagaFinishedIds.has(p.id)) sbaReasons.push('saga');
    if (creatureAttachedIds.has(p.id)) sbaReasons.push('creature-attached');
    if (unattachedAuraIds.has(p.id)) sbaReasons.push('aura-unattached');
    // Use final computed state for type line and P/T when available
    const _supertypes = _cardFs ? (_cardFs.supertypes || []) : p.printedSupertypes;
    const _types = _cardFs ? (_cardFs.types || []) : p.printedTypes;
    const _subtypes = _cardFs ? (_cardFs.subtypes || []) : p.printedSubtypes;
    const _power = _cardFs && _cardFs.power !== null && _cardFs.power !== undefined ? _cardFs.power : p.printedPower;
    const _toughness = _cardFs && _cardFs.toughness !== null && _cardFs.toughness !== undefined ? _cardFs.toughness : p.printedToughness;
    return `
    <div class="bf-card ${isSelected ? 'bf-card-selected' : ''} ${hasSBA ? 'bf-card-sba' : ''} ${(p.isManualEffect || p.isSpell) ? 'bf-card-spell' : ''} ${p.tapped ? 'bf-card-tapped' : ''} ${p.isSideways ? 'bf-card-sideways' : ''} ${p.isFaceDown ? 'bf-card-facedown' : ''}" data-id="${p.id}" data-sba="${sbaReasons.join(',')}" onclick="selectPermanent('${p.id}')"${(!p.isManualEffect && !p.isSpell) ? ` oncontextmenu="event.preventDefault(); event.stopPropagation(); openAnalyzeMenu(event, '${p.id}'); return false;"` : ''}>
      ${p.imageUri ? `<img src="${p.imageUri}" alt="${escapeAttr(p.name)}" class="bf-card-img">` : `<div class="bf-card-no-img"><span>${escapeHtml(p.name)}</span></div>`}
      ${p.label ? `<div class="bf-card-label" aria-hidden="true">${escapeHtml(p.label)}</div>` : ''}
      <div class="bf-card-overlay"></div>
      ${p._isEnchantPlayer && p._enchantedPlayerId ? `<div class="bf-card-spell-badge bf-card-enchant-player-badge">Enchanting: ${escapeHtml(Battlefield.getPlayerName(p._enchantedPlayerId))}</div>` : ''}
      <button class="bf-card-remove" onclick="event.stopPropagation(); removePermanent('${p.id}')" title="Remove"> \u2014 </button>
      ${!p.isManualEffect && !p.isSpell ? `<button class="bf-card-tap" onclick="event.stopPropagation(); toggleTapped('${p.id}')" title="${p.tapped ? 'Untap' : 'Tap'}">\u21BB</button>` : ''}
      ${p.isTransformable ? `<button class="bf-card-flip" onclick="event.stopPropagation(); flipCard('${p.id}')" title="Transform / Flip">\u21C4</button>` : ''}
      ${p.isChooseableFace ? `<button class="bf-card-flip" onclick="event.stopPropagation(); openDualOptionsPopup('${p.id}')" title="Choose half">\u21C4</button>` : ''}
      ${!p.isManualEffect && !p.isSpell && !p.isFaceDown ? `<button class="bf-card-facedown-btn" onclick="event.stopPropagation(); openFaceDownMenu(event, '${p.id}')" title="Turn face down">\u29C9</button>` : ''}
      ${p.isFaceDown ? `<button class="bf-card-facedown-btn bf-card-faceup-btn" onclick="event.stopPropagation(); turnFaceUp('${p.id}')" title="Turn face up">\u25CE</button>` : ''}
      ${isCreature && !p.isManualEffect && !p.isSpell ? `<button class="bf-card-attack-btn${(p.traits||[]).includes('Attacking') ? ' bf-card-attack-btn-active' : ''}" onclick="event.stopPropagation(); toggleAttacking('${p.id}')" title="${(p.traits||[]).includes('Attacking') ? 'Remove Attacking' : 'Mark as Attacking'}"><svg viewBox="0 0 24 24"><path style="fill:currentColor;stroke:none" d="M12 2 L16 18 L12 20 L8 18 Z"/><line x1="5" y1="18" x2="19" y2="18"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="10" y1="23" x2="14" y2="23"/></svg></button>` : ''}
      ${isCreature && !p.isManualEffect && !p.isSpell ? `<button class="bf-card-block-btn${(p.traits||[]).includes('Blocking') ? ' bf-card-block-btn-active' : ''}" onclick="event.stopPropagation(); toggleBlocking('${p.id}')" title="${(p.traits||[]).includes('Blocking') ? 'Remove Blocking' : 'Mark as Blocking'}"><svg viewBox="0 0 24 24"><path style="fill:currentColor;stroke:none" d="M4 4 H20 V14 L12 22 L4 14 Z"/></svg></button>` : ''}
      ${p.isRoom && p.roomFaces ? (() => {
        const unlockedCount = p.roomFaces.filter((_, i) => !p.roomLocked[i]).length;
        return `<button class="bf-room-btn bf-room-popup-btn" style="bottom:18px"
          onclick="event.stopPropagation(); openDualOptionsPopup('${p.id}')"
          title="Room options — ${unlockedCount}/${p.roomFaces.length} unlocked"
        >Rooms ${unlockedCount}/${p.roomFaces.length}</button>`;
      })() : ''}
      ${p.isToken ? '<div class="bf-card-token-badge">TOKEN</div>' : ''}
      ${_cardFs?.copySource ? '<div class="bf-card-copy-badge">COPY</div>' : ''}
      ${(p.isSpell || (p.isManualEffect && !p.isTriggeredAbility && !p.isActivatedAbility)) ? '<div class="bf-card-spell-badge">SPELL</div>' : ''}
      ${p.isTriggeredAbility ? '<div class="bf-card-spell-badge bf-card-trigger-badge">TRIGGER</div>' : ''}
      ${p._isCrewEffect ? '<div class="bf-card-spell-badge bf-card-crew-badge">CREWED</div>' : p._isSaddleEffect ? '<div class="bf-card-spell-badge bf-card-saddle-badge">SADDLED</div>' : p.isActivatedAbility ? '<div class="bf-card-spell-badge bf-card-activated-badge">ACTIVATED</div>' : ''}
      ${Battlefield.isCommander(p.id) ? '<div class="bf-card-commander-badge">CMDR</div>' : ''}
      ${p.classLevel ? `<div class="bf-card-class-badge">LVL ${p.classLevel}</div>` : ''}
      ${p.isFaceDown ? `<div class="bf-card-facedown-badge">${p.faceDownMode === 'cloak' ? 'CLOAK' : p.faceDownMode === 'manifest' ? 'MANIFEST' : 'MORPH'}</div>` : ''}
      ${hasSBA ? `<div class="bf-card-sba-badge" title="State-based action required">\u26a0</div>` : ''}
      ${renderBfCounterBadges(p)}
    </div>`;
  }

  function wrapWithAttachers(targetPerm, cardHtml) {
    const attachers = attachersByTarget.get(targetPerm.id) || [];
    const ghosts = ghostAttachersByTarget.get(targetPerm.id) || [];
    if (!attachers.length && !ghosts.length) return cardHtml;
    const total = attachers.length + ghosts.length;
    const fan = [
      ...attachers.map((ap, i) =>
        `<div class="bf-attached" style="--i:${i}; --n:${total};">${wrapWithAttachers(ap, renderCardDiv(ap))}</div>`),
      ...ghosts.map((ap, i) =>
        `<div class="bf-attached" style="--i:${attachers.length + i}; --n:${total};">${wrapWithAttachers(ap, renderGhostCardDiv(ap))}</div>`)
    ].join('');
    return `<div class="bf-attach-group"><div class="bf-attach-target">${cardHtml}</div><div class="bf-attached-fan">${fan}</div></div>`;
  }

  function renderGhostCardDiv(p) {
    const isSelected = p.id === Battlefield.inspectedId;
    const _cardFs = finalStates.get(p.id);
    const ctrl = _cardFs?.controller || p.owner || 'player_0';
    const ownerPlayer = Battlefield.getPlayer(ctrl);
    const ownerLabel = ownerPlayer ? ownerPlayer.name : ctrl;
    return `<div class="bf-card bf-card-ghost ${isSelected ? 'bf-card-selected' : ''}"
      data-id="${p.id}"
      title="Controlled by ${escapeAttr(ownerLabel)} — click to inspect"
      onclick="selectPermanent('${p.id}')">
      ${p.imageUri ? `<img src="${p.imageUri}" alt="${escapeAttr(p.name)}" class="bf-card-img">` : `<div class="bf-card-no-img"><span>${escapeHtml(p.name)}</span></div>`}
      <div class="bf-card-overlay"></div>
      <div class="bf-card-ghost-badge">${escapeHtml(ownerLabel)}</div>
      ${p.label ? `<div class="bf-card-label" aria-hidden="true">${escapeHtml(p.label)}</div>` : ''}
      ${renderBfCounterBadges(p)}
    </div>`;
  }

  container.innerHTML = renderItems.map(item => {
    if (item.type === 'card') {
      return wrapWithAttachers(item.perm, renderCardDiv(item.perm));
    } else {
      // Mutate stack: render as a grouped container with stacked cards (top first)
      const topPerm = item.stackPerms[0];
      const topFs = finalStates.get(topPerm ? topPerm.id : '');
      const mergedName = topFs ? topFs.name : (topPerm ? topPerm.name : '');
      const isAnySelected = item.stackPerms.some(sp => sp.id === Battlefield.inspectedId);
      let stackHtml = `<div class="bf-mutate-stack ${isAnySelected ? 'bf-mutate-stack-selected' : ''}">
        <div class="bf-mutate-stack-label">Mutate: ${escapeHtml(mergedName)}</div>
        <div class="bf-mutate-stack-cards">
          ${item.stackPerms.map((sp, idx) => {
            const isNonTop = idx !== 0;
            const stackLabel = idx === 0 ? '<div class="bf-mutate-pos-badge">TOP</div>'
              : (idx === item.stackPerms.length - 1 ? '<div class="bf-mutate-pos-badge bf-mutate-pos-bottom">BTM</div>' : '<div class="bf-mutate-pos-badge bf-mutate-pos-mid">MID</div>');
            // Non-top cards: add grayed class and block click
            let cardHtml = renderCardDiv(sp).replace('class="bf-card', `class="bf-card bf-card-in-stack${isNonTop ? ' bf-card-stack-non-top' : ''}`);
            if (isNonTop) {
              // Remove onclick from the top-level div for non-top cards
              cardHtml = cardHtml.replace(/onclick="selectPermanent\('[^']*'\)"/, 'onclick="event.stopPropagation()"');
            }
            return cardHtml + stackLabel;
          }).join('')}
        </div>
      </div>`;

      // Collect auras/equipment attached to any member of this stack, then fan them
      // behind the whole stack container (they are already excluded from the main grid).
      const stackAttachers = [];
      const stackGhosts = [];
      for (const sp of item.stackPerms) {
        stackAttachers.push(...(attachersByTarget.get(sp.id) || []));
        stackGhosts.push(...(ghostAttachersByTarget.get(sp.id) || []));
      }
      stackAttachers.sort((a, b) => b.timestamp - a.timestamp);
      stackGhosts.sort((a, b) => b.timestamp - a.timestamp);
      if (stackAttachers.length || stackGhosts.length) {
        const total = stackAttachers.length + stackGhosts.length;
        const fan = [
          ...stackAttachers.map((ap, i) =>
            `<div class="bf-attached" style="--i:${i}; --n:${total};">${wrapWithAttachers(ap, renderCardDiv(ap))}</div>`),
          ...stackGhosts.map((ap, i) =>
            `<div class="bf-attached" style="--i:${stackAttachers.length + i}; --n:${total};">${wrapWithAttachers(ap, renderGhostCardDiv(ap))}</div>`),
        ].join('');
        stackHtml = `<div class="bf-attach-group"><div class="bf-attach-target">${stackHtml}</div><div class="bf-attached-fan">${fan}</div></div>`;
      }

      return stackHtml;
    }
  }).join('');
}


function hasTargetedEffects(permId) {
  return Battlefield.effects.some(e => e.sourceId === permId && e.scope === 'targeted' && !e.selfTarget && !e._isCounterEffect);
}

// Basenames of the counter icon SVGs that live in SVGs/ (named + keyword counters).
// P/T counters are drawn inline by _ptTokenSvg so any value works; unknown types fall
// back to a text badge. Keep in sync with SVGs/_generate_icons.py.
const COUNTER_ICON_SET = new Set(["acorn","aegis","age","aim","arrow","arrowhead","awakening","bait","blaze","blessing","blight","blood","bloodline","bloodstain","book","bounty","brain","bribery","brick","burden","cage","carrion","cell","charge","coin","collection","component","contested","corpse","corruption","crank","credit","croak","crystal","cube","currency","death","deathtouch","decayed","defender","defense","delay","depletion","descent","despair","devotion","discovery","divinity","doom","double-strike","dream","duty","echo","egg","elixir","ember","energy","enlightened","eon","eruption","everything","exalted","experience","exposure","eyeball","eyestalk","fade","fate","feather","feeding","fellowship","fetch","filibuster","film","finality","fire","first-strike","flame","flash","flood","flying","foreshadow","fungus","fury","fuse","gem","ghostform","glyph","gold","growth","hack","harmony","haste","hatching","hatchling","healing","hexproof","hexproof-black","hexproof-blue","hexproof-green","hexproof-red","hexproof-white","hit","hone","hoofprint","hope","hour","hourglass","hunger","ice","immunity","impostor","incarnation","incubation","indestructible","infection","influence","ingenuity","intel","intervention","invitation","isolation","javelin","judgment","keyword","ki","kick","knickknack","knowledge","level","lifelink","loot","lore","loyalty","luck","lure","magnet","manabond","manifestation","mannequin","mask","matrix","memory","menace","midway","mine","mining","minus-0-1","minus-0-2","minus-1-0","minus-1-1","minus-1-2","minus-2-0","minus-2-1","minus-2-2","mire","music","muster","necrodermis","nest","net","night","oil","omen","ore","page","pain","palliation","paralyzation","pause","petal","petrification","phylactery","phyresis","pin","plague","plot","plus-0-1","plus-0-2","plus-1-0","plus-1-1","plus-1-2","plus-2-0","plus-2-1","plus-2-2","point","poison","polyp","possession","pressure","prey","pt-blank","pupa","quest","rad","rally","reach","rejection","reprieve","rev","revival","ribbon","ritual","rope","rust","scream","scroll","shadow","shell","shield","shred","silver","skull","sleep","sleight","slime","slumber","soot","soul","spark","spite","spooky","spore","stash","storage","story","strife","study","stun","supply","suspect","takeover","task","theft","ticket","tide","time","tower","training","training-swords","trample","trap","treasure","unity","unlock","valor","velocity","verse","vigilance","vitality","void","volatile","vortex","vow","voyage","wage","ward","winch","wind","wish","wreck"]);

// Bump when the SVGs/ icon set is regenerated, to bust the browser image cache
// (filenames stay the same, so the query string is what forces a reload).
const ICON_VER = 22;

// Build a P/T counter medallion inline so any +N/+M or -N/-M value renders, matching
// the SVGs/ minted-medallion style: PURE black & white only (no gray) — outer ring +
// denticle bead ring + inner ring + stacked numbers.
function _ptTokenSvg(sign, top, bot) {
  // Inverted to match the SVG icon set: dark disc background, white beaded frame + numbers.
  let beads = '';
  for (let i = 0; i < 40; i++) {
    const a = i * 360 / 40 * Math.PI / 180;
    const x = 50 + 41 * Math.cos(a), y = 50 + 41 * Math.sin(a);
    beads += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.15" fill="#fff"/>`;
  }
  return `<svg class="bf-counter-tok-img" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">`
    + `<circle cx="50" cy="50" r="50" fill="#17171c"/>`
    + `<circle cx="50" cy="50" r="47" fill="none" stroke="#fff" stroke-width="2.6"/>${beads}`
    + `<circle cx="50" cy="50" r="37" fill="none" stroke="#fff" stroke-width="1.4"/>`
    + `<text x="50" y="44" font-family="Georgia,serif" font-weight="700" font-size="24" text-anchor="middle" fill="#fff">${sign}${top}</text>`
    + `<line x1="33" y1="50" x2="67" y2="50" stroke="#fff" stroke-width="2.4"/>`
    + `<text x="50" y="77" font-family="Georgia,serif" font-weight="700" font-size="24" text-anchor="middle" fill="#fff">${sign}${bot}</text>`
    + `</svg>`;
}

function renderBfCounterBadges(perm) {
  const entries = Object.entries(perm.counters || {}).filter(([,v]) => v > 0);
  if (!entries.length) return '';

  const PT_RE = /^([+-])(\d+)\/([+-])(\d+)$/;
  const isPT = (type) => PT_RE.test(type);

  const makeBadge = ([t, c]) => {
    const title = `${c}× ${t} counter${c !== 1 ? 's' : ''}`;
    const count = c > 1 ? `<span class="bf-counter-count">${c}</span>` : '';

    const m = t.match(PT_RE);
    if (m) {
      const sign = m[1] === '-' ? '−' : '+';
      const cls = m[1] === '-' ? 'is-minus' : 'is-plus';
      return `<span class="bf-counter-tok ${cls}" title="${escapeAttr(title)}">${_ptTokenSvg(sign, m[2], m[4])}${count}</span>`;
    }

    const norm = t.toLowerCase().trim().replace(/\s+/g, '-');
    if (COUNTER_ICON_SET.has(norm)) {
      return `<span class="bf-counter-tok" title="${escapeAttr(title)}"><img class="bf-counter-tok-img" src="SVGs/${norm}.svg?v=${ICON_VER}" alt="${escapeAttr(t)}">${count}</span>`;
    }

    const label = c > 1 ? `${c}× ${t}` : t;
    return `<span class="bf-counter-badge bf-counter-default" title="${escapeAttr(title)}">${escapeHtml(label)}</span>`;
  };

  const ptEntries = entries.filter(([t]) => isPT(t));
  const abilityEntries = entries.filter(([t]) => !isPT(t));

  const left = abilityEntries.length
    ? `<div class="bf-card-counters-left">${abilityEntries.map(makeBadge).join('')}</div>` : '';
  const right = ptEntries.length
    ? `<div class="bf-card-counters-right">${ptEntries.map(makeBadge).join('')}</div>` : '';

  return left + right;
}

function selectPermanent(id) {
  selectInspected(id);

  // Show SBA warnings after render
  const card = document.querySelector(`.bf-card[data-id="${id}"]`);
  if (card && card.dataset.sba) {
    const reasons = card.dataset.sba.split(',').filter(Boolean);
    if (reasons.length) {
      const perm = Battlefield.getPermById(id);
      const msgs = [];
      if (reasons.includes('legend')) {
        msgs.push(`There are two or more legendary permanents named "${perm ? perm.name : '?'}" on the battlefield. As a state-based action, you must put all but one into the graveyard. Note: this does NOT count as sacrificing.`);
      }
      if (reasons.includes('toughness')) {
        msgs.push('This creature has 0 or less toughness. As a state-based action, it must be put into the graveyard.');
      }
      if (reasons.includes('loyalty')) {
        msgs.push('This planeswalker has no loyalty counters on it. As a state-based action, it must be put into the graveyard.');
      }
      if (reasons.includes('saga')) {
        msgs.push('This Saga has lore counters equal to or greater than its final chapter number. As a state-based action (rule 714.4), it must be sacrificed.');
      }
      if (reasons.includes('creature-attached')) {
        msgs.push('This permanent is a creature and was attached to another object. As a state-based action (rule 704.5p), it has become unattached and remains on the battlefield.');
      }
      if (reasons.includes('aura-unattached')) {
        msgs.push('This Aura is not attached to a legal permanent or player. As a state-based action (CR 704.5d/e), it must be put into its owner\'s graveyard.');
      }
      // Use a non-blocking notification (small toast at top of battlefield)
      _showSBAToast(msgs.join('\n\n'));
    }
  }
}

function _showSBAToast(msg, variant) {
  let toast = document.getElementById('sba-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'sba-toast';
    toast.className = 'sba-toast';
    document.getElementById('battlefield').parentElement.prepend(toast);
  }
  toast.textContent = msg;
  toast.classList.toggle('sba-toast-success', variant === 'success');
  toast.classList.add('sba-toast-visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('sba-toast-visible'), 8000);
}

function removePermanent(id) {
  Battlefield.removePermanent(id);
  Battlefield.evaluate();
  renderAll();
}

function toggleTapped(id) {
  Battlefield.toggleTapped(id);
  Battlefield.evaluate();
  renderAll();
}

function toggleAttacking(id) {
  Battlefield.toggleAttacking(id);
  Battlefield.evaluate();
  renderAll();
}

function toggleBlocking(id) {
  Battlefield.toggleBlocking(id);
  Battlefield.evaluate();
  renderAll();
}

function flipCard(id) {
  Battlefield.flipCard(id);
  Battlefield.evaluate();
  renderAll();
}

/* Face-down menu for Morph/Cloak/Manifest */
function openFaceDownMenu(event, permId) {
  // Remove existing menu
  const existing = document.getElementById('facedown-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.id = 'facedown-menu';
  menu.className = 'facedown-popup-menu';
  menu.innerHTML = `
    <div class="facedown-menu-title">Turn Face Down</div>
    <button class="facedown-menu-btn" onclick="setFaceDown('${permId}', 'morph')">
      <strong>Morph</strong><br><span class="facedown-menu-desc">2/2 creature, no abilities</span>
    </button>
    <button class="facedown-menu-btn" onclick="setFaceDown('${permId}', 'cloak')">
      <strong>Cloak</strong><br><span class="facedown-menu-desc">2/2 creature, Ward 2</span>
    </button>
    <button class="facedown-menu-btn" onclick="setFaceDown('${permId}', 'manifest')">
      <strong>Manifest</strong><br><span class="facedown-menu-desc">2/2 creature, no abilities</span>
    </button>
  `;
  document.body.appendChild(menu);
  // Position near the button
  const rect = event.target.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';
  // Close on outside click
  const close = (e) => {
    if (!menu.contains(e.target) && e.target !== event.target) {
      menu.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

function setFaceDown(permId, mode) {
  const menu = document.getElementById('facedown-menu');
  if (menu) menu.remove();
  Battlefield.setFaceDown(permId, mode);
  renderAll();
}

function turnFaceUp(permId) {
  Battlefield.setFaceDown(permId); // toggles back to face up
  renderAll();
}
/* [END: BATTLEFIELD-UI] */
