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

/* View settings of the battlefield, kept per browser: whether cards show their
   live text, and how wide a card is drawn. Neither is part of a board. */
const LIVE_TEXT_KEY = 'layer-inspector-live-text';
const CARD_SIZE_KEY = 'layer-inspector-card-size';
const CARD_SIZE_DEFAULT = 130;
let _liveTextOn = true;
let _bfCardSize = CARD_SIZE_DEFAULT;
try {
  _liveTextOn = localStorage.getItem(LIVE_TEXT_KEY) !== 'off';
  _bfCardSize = Math.min(300, Math.max(100, parseInt(localStorage.getItem(CARD_SIZE_KEY)) || CARD_SIZE_DEFAULT));
} catch (e) { /* storage blocked: defaults */ }

/* The "Silver border" switch is a rule of the game being played, not a view setting:
   it is part of the board (Battlefield.silverBorder) and an undo step. */
function toggleSilverBorder() {
  Battlefield.setSilverBorder(!Battlefield.silverBorder);
  renderAll();
}

function toggleLiveText() {
  _liveTextOn = !_liveTextOn;
  try { localStorage.setItem(LIVE_TEXT_KEY, _liveTextOn ? 'on' : 'off'); } catch (e) { /* ignore */ }
  renderBattlefield();
}

// While the slider moves only the width changes; on release the cards are
// drawn again so a large card gets the sharper image.
function setBfCardSize(px, done) {
  _bfCardSize = Math.min(300, Math.max(100, parseInt(px) || CARD_SIZE_DEFAULT));
  document.documentElement.style.setProperty('--bf-card-w', _bfCardSize + 'px');
  if (!done) return;
  try { localStorage.setItem(CARD_SIZE_KEY, String(_bfCardSize)); } catch (e) { /* ignore */ }
  renderBattlefield();
}

// Scryfall's "small" image is 146px wide: a wider card takes the "normal" one.
function _bfCardImage(uri) {
  return (uri && _bfCardSize > 150) ? uri.replace('/small/', '/normal/') : uri;
}

/* [KEY: BATTLEFIELD-UI] */
/* Drag a card onto another to change the order they entered in: dropped on a card's
   left half it gets the timestamp just before that card, on its right half the one just
   after. The same reorder as dragging in the Timestamp Order list (reorderTimestamps),
   over every permanent on the board, so other players' cards keep their places. An Aura
   or Equipment stays drawn behind what it is attached to; only its timestamp moves.
   Listeners are bound once on the grid, which outlives every re-render. */
let _bfDragId = null;
function _initBattlefieldDrag(container) {
  if (container._bfDragBound) return;
  container._bfDragBound = true;
  const clearMarks = () => container.querySelectorAll('.bf-drop-before, .bf-drop-after')
    .forEach(el => el.classList.remove('bf-drop-before', 'bf-drop-after'));
  const targetOf = (e) => {
    const card = e.target.closest ? e.target.closest('.bf-card[data-id]') : null;
    if (!card || !_bfDragId || card.dataset.id === _bfDragId) return null;
    const r = card.getBoundingClientRect();
    return { card, after: e.clientX > r.left + r.width / 2 };
  };

  container.addEventListener('dragstart', (e) => {
    const card = e.target.closest ? e.target.closest('.bf-card[data-id]') : null;
    if (!card) return;
    _bfDragId = card.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', _bfDragId);
    const r = card.getBoundingClientRect();
    try { e.dataTransfer.setDragImage(card, e.clientX - r.left, e.clientY - r.top); } catch (err) { /* keep the default image */ }
    setTimeout(() => card.classList.add('bf-card-dragging'), 0);
  });

  container.addEventListener('dragover', (e) => {
    if (!_bfDragId) return;
    const t = targetOf(e);
    clearMarks();
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    t.card.classList.add(t.after ? 'bf-drop-after' : 'bf-drop-before');
  });

  container.addEventListener('drop', (e) => {
    const t = targetOf(e);
    if (!t) return;
    e.preventDefault();
    const dragId = _bfDragId, targetId = t.card.dataset.id;
    const order = Battlefield.permanents.slice().sort((a, b) => a.timestamp - b.timestamp).map(p => p.id);
    const from = order.indexOf(dragId);
    if (from < 0 || !order.includes(targetId)) return;
    order.splice(from, 1);
    order.splice(order.indexOf(targetId) + (t.after ? 1 : 0), 0, dragId);
    Battlefield.reorderTimestamps(order);
    Battlefield.evaluate();
    renderAll();
  });

  container.addEventListener('dragend', () => {
    _bfDragId = null;
    clearMarks();
    container.querySelectorAll('.bf-card-dragging').forEach(el => el.classList.remove('bf-card-dragging'));
  });
}

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

  document.documentElement.style.setProperty('--bf-card-w', _bfCardSize + 'px');
  const liveBtn = document.getElementById('live-text-btn');
  if (liveBtn) liveBtn.classList.toggle('active', _liveTextOn);
  const silverBtn = document.getElementById('silver-border-btn');
  if (silverBtn) silverBtn.classList.toggle('active', !!Battlefield.silverBorder);
  const sizeInput = document.getElementById('bf-card-size');
  if (sizeInput && document.activeElement !== sizeInput) sizeInput.value = _bfCardSize;
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
    // (On a card in a graveyard: Animate Dead before its trigger is fired.)
    const onGraveyardCard = !!Battlefield.getGraveyardEnchant(p.id);
    if (!hasBestowTarget && !hasEffectTarget && !hasEnchantPlayer && !onGraveyardCard) {
      unattachedAuraIds.add(p.id);
    }
  }

  // A phased-out permanent is treated as though it doesn't exist (CR 702.26b): no state-based
  // action looks at it, and a legend phased out does not count against one on the battlefield.
  {
    const phased = new Set(perms.filter(p => p.phasedOut).map(p => p.id));
    if (phased.size) {
      for (const ids of legendaryByName.values()) {
        const here = ids.filter(id => !phased.has(id));
        if (here.length < 2) ids.forEach(id => legendViolationIds.delete(id));
      }
      for (const set of [legendViolationIds, zeroToughnessIds, noLoyaltyIds, sagaFinishedIds, creatureAttachedIds, protectionUnattachedIds, illegalAuraAttachIds, equipNonCreatureIds, unattachedAuraIds]) {
        for (const id of phased) set.delete(id);
      }
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
    // Live text is cut from Scryfall's "normal" image, so a card that has any is
    // drawn with that same image: the patch and the card are then the same pixels.
    const _live = renderLivePatches(p, _cardFs);
    const _imgSrc = (p.imageUri && _live.includes('data-src=')) ? p.imageUri.replace('/small/', '/normal/') : _bfCardImage(p.imageUri);
    return `
    <div class="bf-card ${isSelected ? 'bf-card-selected' : ''} ${hasSBA ? 'bf-card-sba' : ''} ${(p.isManualEffect || p.isSpell) ? 'bf-card-spell' : ''} ${p.tapped ? 'bf-card-tapped' : ''} ${_cardIsSideways(p) ? 'bf-card-sideways' : ''} ${p.isFaceDown ? 'bf-card-facedown' : ''} ${p.phasedOut ? 'bf-card-phased' : ''}" data-id="${p.id}" data-sba="${sbaReasons.join(',')}" draggable="true" onclick="selectPermanent('${p.id}')" oncontextmenu="event.preventDefault(); event.stopPropagation(); openCardMenu(event, '${p.id}');">
      ${p.imageUri ? `<img src="${_imgSrc}" alt="${escapeAttr(p.name)}" class="bf-card-img${_liveFlipped(p) ? ' bf-card-img-turned' : ''}">` : `<div class="bf-card-no-img"><span>${escapeHtml(p.name)}</span></div>`}
      ${p.label ? `<div class="bf-card-label" aria-hidden="true">${escapeHtml(p.label)}</div>` : ''}
      <div class="bf-card-overlay">${_live}</div>
      ${p._isEnchantPlayer && p._enchantedPlayerId ? `<div class="bf-card-spell-badge bf-card-enchant-player-badge">Enchanting: ${escapeHtml(Battlefield.getPlayerName(p._enchantedPlayerId))}</div>` : ''}
      <button class="bf-card-remove" onclick="event.stopPropagation(); removePermanent('${p.id}')" title="Remove"> \u2014 </button>
      ${!p.isManualEffect && !p.isSpell ? `<button class="bf-card-tap" onclick="event.stopPropagation(); toggleTapped('${p.id}')" title="${p.tapped ? 'Untap' : 'Tap'}">\u21BB</button>` : ''}
      <button class="bf-card-more" onclick="event.stopPropagation(); openCardMenu(event, '${p.id}')" title="More actions (or right-click the card)">More</button>
      ${p.isRoom && p.roomFaces ? (() => {
        const unlockedCount = p.roomFaces.filter((_, i) => !p.roomLocked[i]).length;
        return `<button class="bf-room-btn bf-room-popup-btn"
          onclick="event.stopPropagation(); openDualOptionsPopup('${p.id}')"
          title="Room options — ${unlockedCount}/${p.roomFaces.length} unlocked"
        >Rooms ${unlockedCount}/${p.roomFaces.length}</button>`;
      })() : ''}
      ${isCreature && !p.isManualEffect && !p.isSpell && (p.traits || []).includes('Attacking') ? renderAttackedPlayerSelect(p) : ''}
      ${p.isToken ? '<div class="bf-card-token-badge">TOKEN</div>' : ''}
      ${_cardFs?.copySource ? '<div class="bf-card-copy-badge">COPY</div>' : ''}
      ${(p.isSpell || (p.isManualEffect && !p.isTriggeredAbility && !p.isActivatedAbility)) ? '<div class="bf-card-spell-badge">SPELL</div>' : ''}
      ${p.isTriggeredAbility ? '<div class="bf-card-spell-badge bf-card-trigger-badge">TRIGGER</div>' : ''}
      ${p._isCrewEffect ? '<div class="bf-card-spell-badge bf-card-crew-badge">CREWED</div>' : p._isSaddleEffect ? '<div class="bf-card-spell-badge bf-card-saddle-badge">SADDLED</div>' : p.isActivatedAbility ? '<div class="bf-card-spell-badge bf-card-activated-badge">ACTIVATED</div>' : ''}
      ${Battlefield.isCommander(p.id) ? '<div class="bf-card-commander-badge">CMDR</div>' : ''}
      ${p.classLevel ? `<div class="bf-card-class-badge">LVL ${p.classLevel}</div>` : ''}
      ${p.isFaceDown ? `<div class="bf-card-facedown-badge">${p.faceDownMode === 'cloak' ? 'CLOAK' : p.faceDownMode === 'manifest' ? 'MANIFEST' : p.faceDownMode === 'plain' ? 'FACE DOWN' : 'MORPH'}</div>` : ''}
      ${(p.stickers && p.stickers.length) ? `<div class="bf-card-sticker-badge" title="Stickers on this card" onclick="event.stopPropagation();openStickerModal('${p.id}')">STICKERS ${p.stickers.length}</div>` : ''}
      ${p.phasedOut ? `<div class="bf-card-phased-badge" title="Treated as though it doesn't exist (rule 702.26)${p.phasedOutWith ? '. Phased out with what it is attached to' : ''}">PHASED OUT</div>` : ''}
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

  _initBattlefieldDrag(container);
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
  // Live-text patches get the card's own background (ui-live-bg.js)
  applyLiveBackgrounds();
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

// A card printed on its side lies on its side: a split card or Room, a plane,
// and a battle while its battle face is up (Scryfall files battles as
// "transform", so the layout does not say).
function _cardIsSideways(p) {
  return !!p.isSideways || (!p.isFaceDown && (p.printedTypes || []).includes('Battle'));
}

/* [KEY: LIVE-PATCHES]
   "Live text" on a battlefield card: where the final state differs from what
   the image prints, a patch is drawn over that part of the image (type line,
   power/toughness). A card nothing has changed keeps its image untouched.
   Display only: the values come from the final state. */

// Where the type line is printed. 'line' is the usual place (every normal
// frame, old and new); anything else gets a bar near the foot of the card.
let _liveForce = null;      // { p, kind, spot }: one card built as another kind (see renderLivePatches)
function _liveTypeSpot(p) {
  if (_liveForce && _liveForce.p === p) return _liveForce.spot;
  const c = p.scryfallData || {};
  if (p.isFaceDown || p.isToken || c.full_art || c.textless || c.border_color === 'borderless') return 'foot';
  if ((c.frame_effects || []).includes('showcase')) return 'foot';
  if (!['normal', 'transform', 'modal_dfc', 'meld', 'adventure', 'prepare', 'mutate', 'prototype', 'leveler'].includes(c.layout || 'normal')) return 'foot';
  if ((p.printedSubtypes || []).some(t => t === 'Saga' || t === 'Class' || t === 'Case' || t === 'Room')) return 'foot';
  if ((p.printedTypes || []).includes('Battle')) return 'foot';
  return 'line';
}

// Which frame the card's image has, for the live patches: 'line' (the usual
// one), or a frame whose type bar ui-live-bg.js finds in the image ('pw': a
// planeswalker on the 2015 or the 2003 frame,
// 'token', 'token03' (the token frame of 2004 to 2014), 'saga', 'class'), a frame read from measured places ('room' and
// 'battle', printed on their side, and 'token97', the promo tokens of 2001 to 2003),
// or 'foot' (anything else: drawn boxes only).
function _liveKind(p) {
  if (_liveForce && _liveForce.p === p) return _liveForce.kind;
  const c = p.scryfallData || {};
  if (p.isFaceDown) return 'foot';
  const plain = !c.full_art && !c.textless && c.border_color !== 'borderless' && !(c.frame_effects || []).includes('showcase');
  if (_liveTypeSpot(p) === 'line') return (p.printedTypes || []).includes('Planeswalker') ? ((c.frame === '2015' || c.frame === '2003') ? 'pw' : 'foot') : 'line';
  // The token frame of 2004 to 2014 (Scryfall calls some of them full-art)
  if (p.isToken && c.frame === '2003' && c.layout === 'token' && !c.textless && c.border_color !== 'borderless') return 'token03';
  // The promo tokens of 2001 to 2003: the lower part of the 1997 card frame
  if (p.isToken && c.frame === '1997' && c.layout === 'token' && ['mpr', 'pr2', 'p03'].includes(c.set)) return 'token97';
  // A showcase, borderless or full-art printing that may still have its boxes
  // in the usual places: tried as the usual frame once its image is read
  // ('show'), with the drawn boxes kept for when it has not. (An Adventure,
  // Omen or prepare card is tried with only its own page of the book: the
  // showcase frames of eld, woe, tdm and hob keep the book in the usual place.)
  if (!plain && c.frame === '2015' && !c.textless && !p.isToken
      && ['normal', 'transform', 'modal_dfc', 'meld', 'mutate', 'prototype', 'leveler', 'adventure', 'prepare'].includes(c.layout || 'normal')
      && !(p.printedSubtypes || []).some(t => t === 'Saga' || t === 'Class' || t === 'Case' || t === 'Room')
      && !(p.printedTypes || []).some(t => t === 'Battle' || t === 'Planeswalker')) return 'show';
  // (The same for a Saga: tried as the Saga frame.)
  if (!plain && c.frame === '2015' && !c.textless && !p.isToken && !p.isFaceDown && c.layout === 'saga') return 'showsaga';
  // (And for a token: Scryfall calls most vanilla tokens of 2019 to 2021
  // full-art, and a few textless, though they have the usual token frame.)
  if (!plain && c.frame === '2015' && p.isToken && (c.layout === 'token' || !c.layout)) return 'showtoken';
  // (A double-faced token's side is a token frame too, or the dark back of a card that transforms.)
  if (c.frame === '2015' && p.isToken && c.layout === 'double_faced_token') return 'showtoken';
  // A textless printing has no text box, but most creatures print their power
  // and toughness on the usual plate, and some printings a type line on a dark
  // bar near the foot: tried with those rewritten in place ('showbare'). (A
  // basic land's bar holds its name between a mana symbol and the stamp.)
  if (c.textless && c.frame === '2015' && !p.isToken && !(p.printedSupertypes || []).includes('Basic')
      && ['normal', 'transform', 'modal_dfc', 'meld'].includes(c.layout || 'normal')
      && !(p.printedTypes || []).some(t => t === 'Battle' || t === 'Planeswalker')) return 'showbare';
  // A flip card (Kamigawa): each half has its own small text box, type bar and
  // power/toughness; a flipped one is shown turned around ('...b').
  // (Two were reprinted on the 2015 frame, with the same halves in other places.)
  if (c.layout === 'flip' && plain && !p.isToken && p.isTransformable && (c.frame === '2003' || c.frame === '2015')) return (c.frame === '2003' ? 'flip03' : 'flip15') + (_liveFlipped(p) ? 'b' : '');
  if (!plain || c.frame !== '2015') return 'foot';
  if (p.isRoom && p.roomFaces && c.layout === 'split') return 'room';
  if ((p.printedTypes || []).includes('Battle')) return 'battle';
  if (p.isToken && (c.layout === 'token' || !c.layout)) return 'token';
  // (A Saga that transforms is filed as "transform": its front has the Saga frame.)
  if (c.layout === 'saga' || (c.layout === 'transform' && (p.printedSubtypes || []).includes('Saga'))) return 'saga';
  if (c.layout === 'class' || c.layout === 'case') return 'class';     // a Case has the Class frame: art left, text right
  return 'foot';
}

// A flip card that has been flipped: it is shown turned around, so the half
// it now is reads upright.
function _liveFlipped(p) {
  return (p.scryfallData || {}).layout === 'flip' && !!p.isTransformable && (p.activeFaceIndex || 0) === 1 && !p.isFaceDown;
}

// A card whose text box is an open book: its own rules are on one page, the
// spell it carries on the other. 'r': an Adventure or Omen (own rules on the
// right page); 'l': a prepare card (on the left); '' for any other card.
function _livePage(p) {
  const lay = (p.scryfallData || {}).layout;
  return lay === 'adventure' ? 'r' : lay === 'prepare' ? 'l' : '';
}

// The 1993 and 1997 frames print the type line and the power/toughness in
// white straight on the frame, and their text box is narrower.
function _liveOldFrame(p) {
  const f = (p.scryfallData || {}).frame;
  return f === '1993' || f === '1997';
}

function _liveTypeLineHtml(p, fs) {
  const same = (a, b) => a.length === b.length && a.every(t => b.includes(t));
  const sup = fs.supertypes || [], typ = fs.types || [], sub = fs.subtypes || [];
  const pSup = p.printedSupertypes || [], pTyp = p.printedTypes || [], pSub = p.printedSubtypes || [];
  if (same(sup, pSup) && same(typ, pTyp) && same(sub, pSub)) return '';
  const tok = (t, printed) => printed.includes(t) ? escapeHtml(t) : `<span class="bf-live-new">${escapeHtml(t)}</span>`;
  const left = [...sup.map(t => tok(t, pSup)), ...typ.map(t => tok(t, pTyp))];
  if (_liveKind(p) === 'token') left.unshift('Token');          // as the token's own type line prints it
  // "Every creature type" / "every land type" as one phrase, like the inspector's chip
  let subs = sub, all = [];
  const cat = typeof TypeCatalog !== 'undefined' ? TypeCatalog : null;
  if (fs.isAllCreatureTypes && cat) {
    const every = cat.everyCreatureType();
    subs = subs.filter(t => !every.has(t));
    all.push('<span class="bf-live-new">All creature types</span>');
  }
  if (fs.isAllLandTypes && cat && cat.landTypes && cat.landTypes.size) {
    subs = subs.filter(t => !cat.officialSubtypes.land.has(t));
    all.push('<span class="bf-live-new">All land types</span>');
  }
  const right = [...all, ...subs.map(t => tok(t, pSub))];
  const text = left.join(' ') + (right.length ? ' — ' + right.join(' ') : '');
  const spot = _liveTypeSpot(p);
  // A Room's type bar is dark with white words, across both doors
  if (_liveKind(p) === 'room') return `<div class="bf-live-type bf-live-type-room bf-live-light bf-live-wait">${text || 'No types'}</div>`;
  if (_liveKind(p) === 'battle') return `<div class="bf-live-type bf-live-type-battle bf-live-wait">${text || 'No types'}</div>`;
  // A promo token of 2001 to 2003 prints it in white on its coloured panel
  if (_liveKind(p) === 'token97') return `<div class="bf-live-type bf-live-type-t97 bf-live-light bf-live-wait">${text || 'No types'}</div>`;
  if (_liveKind(p).startsWith('flip')) return `<div class="bf-live-type bf-live-type-flip bf-live-type-${_liveKind(p)} bf-live-wait">${text || 'No types'}</div>`;
  const look = spot === 'foot' ? ' bf-live-drawn' : _liveOldFrame(p) ? ' bf-live-light' : '';
  return `<div class="bf-live-type bf-live-type-${spot}${look}">${text || 'No types'}</div>`;
}

// The name, when it is not the printed one (a copy, "becomes a copy … except
// its name is …", a name set by an effect): over the title bar on the usual
// frame, where ui-live-bg.js reads it, else on a drawn bar at the top.
function _liveNameChanged(p, fs) {
  return !p.isFaceDown && !!fs.name && fs.name !== p.name;
}
function _liveNameHtml(p, fs) {
  if (!_liveNameChanged(p, fs)) return '';
  const read = _liveKind(p) === 'line' && _liveTypeSpot(p) === 'line';
  const look = read ? (_liveOldFrame(p) ? ' bf-live-light' : '') : ' bf-live-drawn';
  return `<div class="bf-live-name${look}"><span class="bf-live-new">${escapeHtml(fs.name)}</span></div>`;
}
// How many mana symbols the title bar prints (where the name ends)
function _liveCostSymbols(p) {
  const sc = p.scryfallData || {};
  const face = (sc.card_faces || [])[p.activeFaceIndex || 0] || sc;
  return ((face.mana_cost != null ? face.mana_cost : sc.mana_cost) || '').match(/\{[^}]+\}/g)?.length || 0;
}

// The colour of a card's power/toughness box, from the colours of its frame
function _livePlateColor(p) {
  const tone = { W: '#f3efe2', U: '#bcd3e6', B: '#b4aca6', R: '#e6b092', G: '#bfd3b6', White: '#f3efe2', Blue: '#bcd3e6', Black: '#b4aca6', Red: '#e6b092', Green: '#bfd3b6' };
  const cols = (p.printedColors || []).filter(c => tone[c]);
  if (cols.length > 1) return '#e0cd8c';                                   // gold
  if (cols.length === 1) return tone[cols[0]];
  if ((p.printedTypes || []).includes('Land')) return '#d2c8b6';
  return '#ccd4d9';                                                        // artifact and colourless
}

function _livePtHtml(p, fs) {
  if (!(fs.types || []).includes('Creature')) return '';
  const pw = fs.power, tg = fs.toughness;
  if (pw === null || pw === undefined || tg === null || tg === undefined) return '';
  // A printed "*" is kept as 0, so a characteristic-defining value always shows.
  if (!p.isFaceDown && pw === p.printedPower && tg === p.printedToughness) return '';
  // Over a printed box the patch blends into it; where the image prints none
  // (a noncreature card, a face-down card, an unusual frame) a box is drawn.
  const kind = _liveKind(p);
  // (bare: a textless printing tried with its printed plate, see renderLivePatches)
  const bare = !!(_liveForce && _liveForce.p === p && _liveForce.bare);
  const drawn = p.isFaceDown || p.printedPower === null || p.printedPower === undefined || (_liveTypeSpot(p) === 'foot' && !bare && kind !== 'token' && kind !== 'token03' && kind !== 'token97' && !kind.startsWith('flip'));
  // A planeswalker's loyalty is where a P/T box would be: the box goes beside it
  const look = drawn ? ' bf-live-drawn' + (kind === 'pw' ? ' bf-live-pt-pw' + ((p.scryfallData || {}).frame === '2003' ? ' bf-live-pt-pw03' : '') : kind === 'battle' ? ' bf-live-pt-battle' : kind.startsWith('flip') ? ' bf-live-pt-' + kind : '') : _liveOldFrame(p) ? ' bf-live-light' : '';
  // A drawn box is made to look like a printed one, in the frame's own colour
  const plate = (drawn || bare) ? ` style="--plate:${_livePlateColor(p)}"` : '';
  return `<div class="bf-live-pt${look}"${plate}>${escapeHtml(String(pw))}/${escapeHtml(String(tg))}</div>`;
}

// What one door of a Room prints, read as the card's own abilities are
function _roomHalfAbilities(p, i) {
  const f = (p.roomFaces || [])[i];
  if (!f) return [];
  const cardName = (p.scryfallData && p.scryfallData.name) || p.name;
  let t = _replaceProperNounSelfRef(p.name, _stripReminderText(f.oracle_text || ''), p.isToken);
  if (cardName !== p.name) t = _replaceProperNounSelfRef(cardName, t, p.isToken);
  return extractAbilities(t);
}

// The rules text box, when the abilities are not the printed ones: rewritten
// on a frame whose text box is in the usual place (an ability the print lacks
// in red), else a strip of the gained abilities at the foot of the art.
function _liveTextBoxHtml(p, fs) {
  // The usual frame, a token that prints a text box, a Saga or a Class. (A
  // planeswalker keeps its print: its loyalty costs are part of the frame.)
  const kind = _liveKind(p);
  const token = kind === 'token' || kind === 'token03';
  // (A promo token of 2001 to 2003 always prints a text box: flavor text when it has no rules.)
  // (A textless token prints no text box, whatever its abilities.)
  const column = kind === 'saga' || kind === 'class' || kind === 'token97' || kind.startsWith('flip') || (token && (p.printedAbilities || []).length > 0 && !(p.scryfallData || {}).textless);
  // An ability it has twice is written once, as a card would print it
  // ("Flying" from the print and again from Levitation).
  // A keyword line of the print ("Defender, flying") counts word by word.
  // (A face-down card shows none of its print: all it has is gained.)
  const printed = p.isFaceDown ? [] : (p.printedAbilities || []);
  const had = new Set();
  for (const a of printed) {
    if (a.length <= 40 && !/[.:"—]/.test(a)) a.split(/\s*,\s*/).forEach(w => had.add(w.toLowerCase()));
  }
  const abilities = (fs.abilities || []).filter(a => {
    if (printed.includes(a)) return true;
    const k = String(a).toLowerCase();
    if (had.has(k)) return false;
    had.add(k);
    return true;
  });
  // (Its own name in its rules text is the name it has now: a printed line that
  // names the card is rewritten when the name changes.)
  const name = fs.name || p.name;
  const namesItself = _liveNameChanged(p, fs) && printed.some(a => _replaceThisCard(a, name) !== a);
  if (kind !== 'room' && !namesItself && abilities.length === printed.length && abilities.every(a => printed.includes(a))) return '';
  // Paragraphs as a card prints them: keywords share one, comma-separated.
  // Equip and Reconfigure last, as in the inspector.
  const isKeyword = (a) => a.length <= 40 && !/[.:"—]/.test(a);
  const last = (a) => /^(?:equip|reconfigure)\b/i.test(a) ? 1 : 0;
  const parasOf = (list) => {
    const paras = [];
    for (const a of _groupAbilityLines([...list].sort((x, y) => last(x) - last(y)))) {
      const part = { text: _replaceThisCard(a, name).replace(/\s+([.,;])/g, '$1'), isNew: !printed.includes(a) };
      const prev = paras[paras.length - 1];
      if (isKeyword(a) && prev && prev.keywords) {
        part.text = part.text.charAt(0).toLowerCase() + part.text.slice(1);
        prev.parts.push(part);
      } else {
        paras.push({ keywords: isKeyword(a), parts: [part] });
      }
    }
    return paras;
  };
  const bodyOf = (paras, mark) => paras.map(pa => '<p>' + pa.parts.map(x => (mark && x.isNew)
    ? `<span class="bf-live-new">${symbolsHtml(escapeHtml(x.text))}</span>` : symbolsHtml(escapeHtml(x.text))).join(', ') + '</p>').join('');
  // A Room has a text box for each door. A locked door has no abilities: its
  // box says so, with what it prints in pale ink under it. What the card has
  // gained is written on its first unlocked door.
  if (kind === 'room') {
    const gained = abilities.filter(a => !printed.includes(a));
    const carrier = Math.max(0, p.roomLocked.findIndex(l => !l));
    return p.roomFaces.map((f, i) => {
      const own = _roomHalfAbilities(p, i), locked = !!p.roomLocked[i];
      const kept = locked ? [] : own.filter(a => abilities.includes(a));
      const extra = i === carrier ? gained : [];
      if (!locked && kept.length === own.length && !extra.length) return '';
      let body = locked
        ? '<p class="bf-live-none">Locked</p>' + (own.length ? `<div class="bf-live-locked">${bodyOf(parasOf(own), false)}</div>` : '')
        : bodyOf(parasOf(kept), false);
      body += bodyOf(parasOf(extra), true);
      if (!body) body = '<p class="bf-live-none">No abilities</p>';
      return `<div class="bf-live-text bf-live-text-room bf-live-wait" data-half="${i}" data-max="3" data-min="1.6" style="font-size:3cqw">${body}</div>`;
    }).join('');
  }
  // A planeswalker's loyalty costs, a Saga's chapters and a Class's levels are
  // laid out by the frame, and a token without text prints no box: the print
  // stays, and what the card has gained is written on a strip at the foot of
  // the art. (A Saga or Class that has lost a printed ability is rewritten.)
  const framed = (kind === 'saga' || kind === 'class') && printed.every(a => abilities.includes(a));
  // A frame whose boxes are not read from the image (full-art, borderless,
  // showcase, a face-down card) keeps its print too and gets the same strip,
  // on the art: beside it on a Saga, Class or Case, else across it.
  if (kind === 'pw' || kind === 'foot' || framed || (token && !column)) {
    const gained = abilities.filter(a => !printed.includes(a));
    if (!gained.length) return '';
    const paras = parasOf(gained);
    const chars = paras.reduce((n, pa) => n + pa.parts.reduce((m, x) => m + x.text.length + 2, 0), 0);
    const lay = (p.scryfallData || {}).layout;
    // (A Class with drawn boxes is a borderless one with a layout of its own:
    // its text is not in the right half, so the strip goes across the art.)
    const place = kind !== 'foot' ? kind : p.isFaceDown ? 'foot' : lay === 'saga' ? 'saga' : 'foot';
    const narrow = place === 'saga' || place === 'class';
    const fsize = Math.max(narrow ? 2.6 : 3, Math.min(4.2, (narrow ? 15 : 22) / Math.sqrt(chars)));
    // (Its place is only known once the image is read, where the image is read.)
    return `<div class="bf-live-gain bf-live-gain-${place}${kind === 'foot' ? '' : ' bf-live-wait'}" style="font-size:${fsize.toFixed(1)}cqw;--plate:${_livePlateColor(p)}">${bodyOf(paras, false)}</div>`;
  }
  const paras = parasOf(abilities);
  // A battle's box is fitted once its image is read; the corner that holds the
  // back face's power/toughness and the defense shield is left clear.
  if (kind === 'battle') {
    const inner = paras.length ? bodyOf(paras, true) : '<p class="bf-live-none">No abilities</p>';
    return `<div class="bf-live-text bf-live-text-battle bf-live-wait" data-max="3" data-min="1.6" style="font-size:3cqw"><i class="bf-live-notch-a"></i><i class="bf-live-notch-b"></i>${inner}</div>`;
  }
  if (kind === 'token97') {
    const inner = paras.length ? bodyOf(paras, true) : '<p class="bf-live-none">No abilities</p>';
    return `<div class="bf-live-text bf-live-text-t97 bf-live-wait" data-max="4.4" data-min="1.8" style="font-size:3.4cqw">${inner}</div>`;
  }
  // (A flip card's half has a low, wide box above its type bar.)
  if (kind.startsWith('flip')) {
    const inner = paras.length ? bodyOf(paras, true) : '<p class="bf-live-none">No abilities</p>';
    return `<div class="bf-live-text bf-live-text-flip bf-live-text-${kind} bf-live-wait" data-max="4.2" data-min="1.6" style="font-size:3.4cqw">${inner}</div>`;
  }
  // The largest font at which the paragraphs fit: the box is about 81cqw by
  // 33cqw inside (75cqw on an old frame), a character about half its font size wide.
  // (One page of an Adventure's or a prepare card's book is about 36cqw wide.)
  const old = _liveOldFrame(p), page = kind === 'line' ? _livePage(p) : '';
  const lens = paras.map(pa => pa.parts.reduce((n, x) => n + x.text.length + 2, -2));
  let size = 4.8;
  for (; size > 2.6; size -= 0.2) {
    const perLine = (page ? 36 : old ? 75 : 81) / (0.5 * size);
    const rows = lens.reduce((n, len) => n + Math.ceil(len / perLine), 0);
    if (rows * 1.15 * size + (paras.length - 1) * 0.45 * size <= 33) break;
  }
  const body = paras.length ? bodyOf(paras, true) : '<p class="bf-live-none">No abilities</p>';
  // The printed power/toughness box sits in the text box's corner: leave it clear
  // (A prepare card's box is in the spell's page, not in its own.)
  const tall = (p.printedPower === null || p.printedPower === undefined || page === 'l') ? '' : ' bf-live-haspt';
  // Off the usual frame the box is only known once the image has been read
  return `<div class="bf-live-text${old ? ' bf-live-old' : ''}${tall}${(column || page) ? ' bf-live-wait' : ''}${page ? ' bf-live-page-' + page : ''}${kind === 'token03' ? ' bf-live-text-center' : ''}"${page ? ' data-min="1.8"' : ''} style="font-size:${size.toFixed(1)}cqw">${body}</div>`;
}

function renderLivePatches(p, fs) {
  if (!_liveTextOn || !fs || p.isManualEffect || p.isSpell || p.isEmblem) return '';
  // (A colour indicator, the dot that starts the type line of a back face or
  // of a card with no mana cost: the line starts after it.)
  const sc = p.scryfallData || {};
  const face = (sc.card_faces || [])[p.activeFaceIndex || 0] || sc;
  const ind = (face.color_indicator || sc.color_indicator || []).length ? 1 : 0;
  const build = () => _liveNameHtml(p, fs) + _liveTypeLineHtml(p, fs) + _liveTextBoxHtml(p, fs) + _livePtHtml(p, fs);
  // A showcase or borderless printing is built twice: as the usual frame,
  // shown if ui-live-bg.js finds its boxes in the usual places, and with
  // drawn boxes, shown if it does not.
  const tried = _liveKind(p);
  if (tried === 'show' || tried === 'showsaga' || tried === 'showtoken' || tried === 'showbare') {
    let asLine = '', asFoot = '';
    try {
      _liveForce = tried === 'show' ? { p, kind: 'line', spot: 'line' } : tried === 'showbare' ? { p, kind: 'foot', spot: 'foot', bare: true }
        : { p, kind: tried === 'showtoken' ? 'token' : 'saga', spot: 'foot' };
      asLine = build();
      _liveForce = { p, kind: 'foot', spot: 'foot' }; asFoot = build();
    } finally { _liveForce = null; }
    if (!asLine && !asFoot) return '';
    if (!p.imageUri) return asFoot ? `<div class="bf-live">${asFoot}</div>` : '';
    const pt = p.printedPower !== null && p.printedPower !== undefined;
    return `<div class="bf-live bf-live-try" data-src="${escapeAttr(p.imageUri.replace('/small/', '/normal/'))}" data-frame="${tried}" data-ind="${tried === 'showbare' ? ((p.printedTypes || []).includes('Land') ? 1 : 0) : ind}" data-pt="${pt ? 1 : 0}" data-text="${(p.printedAbilities || []).length && !sc.textless ? 1 : 0}" data-page="${tried === 'show' ? _livePage(p) : ''}">${asLine}</div>`
      + `<div class="bf-live bf-live-fallback">${asFoot}</div>`;
  }
  const html = build();
  if (!html) return '';
  // What ui-live-bg.js needs to read the card's own image: only for a frame
  // whose boxes are in the usual places.
  const kind = _liveKind(p);
  const usual = kind !== 'foot' && p.imageUri;
  const hasPt = p.printedPower !== null && p.printedPower !== undefined;
  const frame = (kind === 'pw' && sc.frame === '2003') ? 'pw03' : kind !== 'line' ? kind : _liveOldFrame(p) ? 'old' : ((p.scryfallData || {}).frame || '2015');
  const attrs = usual
    ? ` data-src="${escapeAttr(p.imageUri.replace('/small/', '/normal/'))}" data-frame="${escapeAttr(frame)}" data-ind="${ind}" data-pt="${hasPt ? 1 : 0}" data-text="${(p.printedAbilities || []).length ? 1 : 0}" data-page="${kind === 'line' ? _livePage(p) : ''}"${kind === 'line' && _liveNameChanged(p, fs) ? ` data-cost="${_liveCostSymbols(p)}"` : ''}`
    : '';
  return `<div class="bf-live"${attrs}>${html}</div>`;
}
/* [END: LIVE-PATCHES] */

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

// Which player an attacking creature is attacking: every player but its controller.
function renderAttackedPlayerSelect(p) {
  const ctrl = p.controller || p.owner || 'player_0';
  const others = Battlefield.players.filter(pl => pl.id !== ctrl);
  if (!others.length) return '';
  const attacked = _attackedPlayerId(p);
  return `<select class="bf-card-attack-select" title="Which player this creature is attacking" onclick="event.stopPropagation()" onchange="setAttackingPlayer('${p.id}', this.value)">${
    others.map(pl => `<option value="${escapeAttr(pl.id)}"${pl.id === attacked ? ' selected' : ''}>Attacking ${escapeHtml(pl.name)}</option>`).join('')}</select>`;
}

function setAttackingPlayer(id, playerId) {
  Battlefield.setAttackingPlayer(id, playerId);
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

function setFaceDown(permId, mode) {
  Battlefield.setFaceDown(permId, mode);
  renderAll();
}

/* Phasing (CR 702.26): a phased-out permanent is treated as though it doesn't exist; what is
   attached to it phases out and in with it (Battlefield.setPhasedOut). */
function togglePhased(permId) {
  const p = Battlefield.getPermById(permId);
  if (!p) return;
  Battlefield.setPhasedOut(permId, !p.phasedOut);
  renderAll();
}

function turnFaceUp(permId) {
  Battlefield.setFaceDown(permId); // toggles back to face up
  renderAll();
}
/* [END: BATTLEFIELD-UI] */
