/* ui-modal-equip.js — Equip / Reconfigure / Fortify modal, plus the imprint-target
   picker (sibling attach-to-source modal). Extracted from ui-modals.js. */

/* ---- Equip / Reconfigure / Fortify Modal ---- */

/* Button shown in the timestamp panel for printed Equipment / Reconfigure / Fortify cards.
   Replaces the old inline dropdown. Shows the current target name when attached. */
function renderEquipButton(permId) {
  const equipEff = Battlefield.effects.find(e => e.sourceId === permId && e.requiresCreatureTarget && !e._isEquipTargetEff && !e.disabled);
  const synthEff = Battlefield.effects.find(e => e.sourceId === permId && e._isEquipTargetEff);
  const currentTargetId = equipEff?.targetId || synthEff?.targetId || null;
  const sourcePerm = Battlefield.getPermById(permId);
  const isReconfigure = sourcePerm && (sourcePerm.oracleText || '').toLowerCase().includes('reconfigure');
  const isFortify = sourcePerm && (sourcePerm.oracleText || '').toLowerCase().includes('fortify');
  const label = isFortify ? 'Fortify' : isReconfigure ? 'Reconfigure' : 'Equip';
  const btnClass = isFortify ? 'fortify-btn' : isReconfigure ? 'reconfigure-btn' : 'equip-btn';
  const activeClass = currentTargetId ? ` ${btnClass}-active` : '';
  const targetPerm = currentTargetId ? Battlefield.getPermById(currentTargetId) : null;
  const targetLabel = targetPerm ? (targetPerm.label ? targetPerm.name + ' ' + targetPerm.label : targetPerm.name) : null;
  const titleText = targetLabel ? label + ': ' + targetLabel : 'Attach to a ' + (isFortify ? 'land' : 'creature');
  return `<button class="ts-action-btn configure ${btnClass}${activeClass}" onclick="event.stopPropagation(); openEquipModal('${escapeAttr(permId)}', null, null)" title="${escapeAttr(titleText)}">${escapeHtml(label)}</button>`
    + (currentTargetId ? `<button class="ts-action-btn remove-mutate-btn" onclick="event.stopPropagation(); clearEquipTarget('${escapeAttr(permId)}')" title="Unattach">✕</button>` : '');
}

/* ---- Imprint Modal ---- */
/* Imprint button shown on the timestamp panel for cards with the Imprint keyword.
   Adds cards to exile already tagged with exiledWithId = this permanent. */
function renderImprintButton(permId) {
  const perm = Battlefield.getPermById(permId);
  if (!perm) return '';
  const imprinted = (typeof _getImprintedExileEntries === 'function')
    ? _getImprintedExileEntries(permId)
    : Battlefield.exile.filter(e => e.exiledWithId === permId && !e.isFaceDown);
  const n = imprinted.length;
  let label, title;
  if (n === 0) { label = 'Imprint'; title = 'Imprint a card'; }
  else if (n === 1) { label = 'Imprint'; title = 'Imprinted: ' + (imprinted[0].card?.name || 'card'); }
  else { label = 'Imprint (' + n + ')'; title = imprinted.map(e => e.card?.name || 'card').join(', '); }
  const activeClass = n > 0 ? ' imprint-btn-active' : '';
  const removeBtn = n > 0
    ? `<button class="ts-action-btn remove-mutate-btn" onclick="event.stopPropagation(); clearImprintTargets('${escapeAttr(permId)}')" title="Remove imprinted card${n > 1 ? 's' : ''}">✕</button>`
    : '';
  return `<button class="ts-action-btn configure imprint-btn${activeClass}" onclick="event.stopPropagation(); openImprintModal('${escapeAttr(permId)}')" title="${escapeAttr(title)}">${escapeHtml(label)}</button>${removeBtn}`;
}

function clearImprintTargets(permId) {
  const imprinted = (typeof _getImprintedExileEntries === 'function')
    ? _getImprintedExileEntries(permId)
    : Battlefield.exile.filter(e => e.exiledWithId === permId);
  for (const entry of imprinted) Battlefield.removeFromExile(entry.id);
  Battlefield.evaluate();
  renderAll();
}

let _imprintModalPermId = null;
let _imprintScryfallResults = [];

function openImprintModal(permId) {
  _imprintModalPermId = permId;
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;
  const overlay = _createModalOverlay('imprint-modal-overlay', closeImprintModal);
  const permName = perm.label ? perm.name + ' ' + perm.label : perm.name;
  overlay.innerHTML = _modalShell({
    title: escapeHtml('Imprint — ' + permName),
    closeFn: 'closeImprintModal',
    body: `
      <div class="modal-section-title">Search for a card to imprint:</div>
      <div class="modal-search-bar">
        <input type="text" id="imprint-search-input" placeholder="Search for a card…" autocomplete="off">
      </div>
      <div class="modal-search-results" id="imprint-search-results"></div>
      <div class="graveyard-divider"></div>
      <div class="modal-section-title">Currently imprinted:</div>
      <div id="imprint-current-list">${_renderImprintCurrentList(permId)}</div>`,
    footer: `<button class="btn btn-sm" onclick="closeImprintModal()">Close</button>`,
  });
  document.body.appendChild(overlay);

  const input = document.getElementById('imprint-search-input');
  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { document.getElementById('imprint-search-results').innerHTML = ''; return; }
      document.getElementById('imprint-search-results').innerHTML = '<div class="search-loading">Searching…</div>';
      const cards = await searchScryfall(q);
      _imprintScryfallResults = cards || [];
      _renderImprintSearchResults(_imprintScryfallResults);
    }, 350);
  });
  input.focus();
}

function _renderImprintSearchResults(cards) {
  const container = document.getElementById('imprint-search-results');
  if (!container) return;
  if (!cards || !cards.length) { container.innerHTML = '<div class="search-empty">No results</div>'; return; }
  container.innerHTML = cards.slice(0, 20).map((card, i) => {
    const imgUrl = card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || '';
    return `<div class="modal-perm-item" onclick="imprintAddCard(${i})">
      ${imgUrl ? `<img src="${imgUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="perm-info">
        <div class="perm-name">${escapeHtml(card.name)}</div>
        <div class="perm-type">${escapeHtml(card.type_line || '')}</div>
      </div>
    </div>`;
  }).join('');
}

function _renderImprintCurrentList(permId) {
  const imprinted = (typeof _getImprintedExileEntries === 'function')
    ? _getImprintedExileEntries(permId)
    : Battlefield.exile.filter(e => e.exiledWithId === permId && !e.isFaceDown);
  if (!imprinted.length) return '<div class="exile-empty-msg">No cards currently imprinted.</div>';
  return imprinted.map(entry => {
    const card = entry.card;
    const imgUrl = card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || '';
    return `<div class="modal-perm-item">
      ${imgUrl ? `<img src="${imgUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="perm-info">
        <div class="perm-name">${escapeHtml(card.name || '')}</div>
        <div class="perm-type">${escapeHtml(card.type_line || '')}</div>
      </div>
      <button class="exile-remove-btn" onclick="imprintRemoveEntry('${escapeAttr(entry.id)}')" title="Remove">&times;</button>
    </div>`;
  }).join('');
}

function imprintAddCard(idx) {
  const card = _imprintScryfallResults[idx];
  if (!card || !_imprintModalPermId) return;
  const perm = Battlefield.getPermById(_imprintModalPermId);
  Battlefield.addToExile(card, {
    owner: perm?.controller || perm?.owner || Battlefield.activePlayerId,
    exiledWithId: _imprintModalPermId,
  });
  renderAll();
  const listEl = document.getElementById('imprint-current-list');
  if (listEl) listEl.innerHTML = _renderImprintCurrentList(_imprintModalPermId);
  const input = document.getElementById('imprint-search-input');
  if (input) input.value = '';
  const results = document.getElementById('imprint-search-results');
  if (results) results.innerHTML = '';
}

function imprintRemoveEntry(entryId) {
  Battlefield.removeFromExile(entryId);
  renderAll();
  if (_imprintModalPermId) {
    const listEl = document.getElementById('imprint-current-list');
    if (listEl) listEl.innerHTML = _renderImprintCurrentList(_imprintModalPermId);
  }
}

function closeImprintModal() {
  const overlay = document.getElementById('imprint-modal-overlay');
  if (overlay) overlay.remove();
  _imprintModalPermId = null;
  _imprintScryfallResults = [];
}

function clearEquipTarget(permId) {
  Battlefield.setTarget(permId, null);
  const synth = Battlefield.effects.find(e => e.sourceId === permId && e._isEquipTargetEff);
  if (synth) synth.targetId = null;
  const pseudo = Battlefield.permanents.find(p => p._isEquipEffect && p._equipSourceId === permId);
  if (pseudo) Battlefield.removePermanent(pseudo.id);
  Battlefield.evaluate();
  renderAll();
}

let _equipModalPermId = null;
let _equipModalAbilityIdx = null;
let _equipSelectedTargetId = null;

function openEquipModal(permId, abilityIdx, ability) {
  _equipModalPermId = permId;

  const perm = Battlefield.getPermById(permId);
  if (!perm) return;

  const finalStates = Battlefield.getAllFinalStates();
  const sourceCtrl = perm.controller || perm.owner || Battlefield.activePlayerId;
  const sourceFs = finalStates.get(permId);
  const sourceTypes = sourceFs ? (sourceFs.types || []) : (perm.printedTypes || []);
  const sourceAbilities = sourceFs ? (sourceFs.abilities || []) : [];

  // CR 704.5p: Equipment that is a creature cannot equip unless it has reconfigure
  const hasReconfigure = sourceAbilities.some(a => /\breconfigure\b/i.test(a));
  if (sourceTypes.includes('Creature') && !hasReconfigure) {
    if (typeof _showSBAToast === 'function') {
      _showSBAToast('This Equipment is currently a creature and cannot equip another creature. (Rule 704.5p)');
    }
    return;
  }

  // When called from the Equip/Reconfigure/Fortify button (abilityIdx is null), resolve
  // the actual ability index so this path behaves the same as clicking Activate in the popup.
  if (abilityIdx === null) {
    const activated = Battlefield.extractActivatedAbilities(sourceAbilities);
    const equipAbility = activated.find(a => a.isEquip || a.isFortify || a.isReconfigure);
    if (equipAbility) {
      abilityIdx = equipAbility.index;
      ability = equipAbility;
    }
  }
  _equipModalAbilityIdx = abilityIdx;

  // Detect fortify/reconfigure from the ability object or oracle text fallback.
  const oracleText = (perm.oracleText || '').toLowerCase();
  const isFortify = !!(ability && ability.isFortify) || oracleText.includes('fortify');
  const isReconfigure = !!(ability && ability.isReconfigure) || oracleText.includes('reconfigure');

  // Find current target from original effects or synthetic tracking effect.
  const existingDirectEff = Battlefield.effects.find(e => e.sourceId === permId && e.requiresCreatureTarget && !e._isEquipTargetEff && !e.disabled);
  const existingSynth = Battlefield.effects.find(e => e.sourceId === permId && e._isEquipTargetEff);
  const currentTargetId = (existingDirectEff?.targetId || existingSynth?.targetId) || '';
  _equipSelectedTargetId = currentTargetId || null;

  // For Aura-Equipment hybrids, equip target must also satisfy the Enchant restriction.
  const auraRestriction = Battlefield.effects.find(e => e.sourceId === permId && e.auraRestriction)?.auraRestriction
    || Battlefield.getPermById(permId)?._auraRestriction;

  // Valid targets: creatures (or lands for Fortify) the source's controller controls
  const validTargets = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === permId) return false;
    const fs = finalStates.get(p.id);
    const types = fs ? (fs.types || []) : (p.printedTypes || []);
    const tCtrl = p.controller || p.owner || 'player_0';
    if (isFortify ? !types.includes('Land') : !types.includes('Creature')) return false;
    if (tCtrl !== sourceCtrl) return false;
    if (auraRestriction) {
      const tState = {
        types: fs ? (fs.types || []) : (p.printedTypes || []),
        supertypes: fs ? (fs.supertypes || []) : (p.printedSupertypes || []),
        subtypes: fs ? (fs.subtypes || []) : (p.printedSubtypes || []),
        colors: fs ? (fs.colors || []) : (p.printedColors || []),
        isAllCreatureTypes: fs ? !!fs.isAllCreatureTypes : false,
      };
      if (!auraRestriction(tState)) return false;
    }
    const stack = Battlefield.getStack(p.id);
    if (stack && stack.length >= 2 && stack[0] !== p.id) return false;
    const tAbilities = fs ? (fs.abilities || []) : [];
    if (tAbilities.some(a => /\bshroud\b/i.test(a))) return false;
    if (typeof _isProtectedFromSource === 'function' && _isProtectedFromSource(fs, sourceFs, perm, p)) return false;
    return true;
  });

  const overlay = _createModalOverlay('equip-modal-overlay', closeEquipModal);

  const renderTarget = (t) => _renderPermItem(t, finalStates, {
    onClick: `selectEquipTarget('${escapeAttr(t.id)}', this)`,
    selectedId: currentTargetId,
    selectedClass: 'bestow-target-selected',
  });

  const targetsHtml = validTargets.length === 0
    ? '<div class="dim" style="padding:8px 0">No valid targets on the battlefield.</div>'
    : `<div class="modal-perm-list">${validTargets.map(renderTarget).join('')}</div>`;

  const actionLabel = isFortify ? 'Fortify' : isReconfigure ? 'Reconfigure' : 'Equip';
  const permDisplayName = perm.label ? perm.name + ' ' + perm.label : perm.name;
  const targetTypeLabel = isFortify ? 'Land' : 'Creature';

  const unattachBtn = currentTargetId
    ? '<button class="btn btn-sm" style="color:var(--red)" onclick="unattachEquipFromModal()">Unattach</button>'
    : '';

  overlay.innerHTML = _modalShell({
    title: escapeHtml(actionLabel + ' — ' + permDisplayName),
    closeFn: 'closeEquipModal',
    body: `
      <div class="modal-section-title">Select ${targetTypeLabel} to Attach To</div>
      ${targetsHtml}`,
    footer: `
      <button class="btn btn-sm" onclick="closeEquipModal()">Cancel</button>
      ${unattachBtn}
      <button class="btn-accent" onclick="applyEquipModal()">Apply ${escapeHtml(actionLabel)}</button>`,
  });

  document.body.appendChild(overlay);
}

function selectEquipTarget(targetId, el) {
  _equipSelectedTargetId = targetId;
  _selectOneOf('equip-modal-overlay', el, 'bestow-target-selected');
}

function closeEquipModal() {
  const overlay = document.getElementById('equip-modal-overlay');
  if (overlay) overlay.remove();
  _equipModalPermId = null;
  _equipModalAbilityIdx = null;
  _equipSelectedTargetId = null;
}

function applyEquipModal() {
  if (!_equipSelectedTargetId) {
    alert('Please select a target.');
    return;
  }
  const permId = _equipModalPermId;
  const abilityIdx = _equipModalAbilityIdx;
  const perm = Battlefield.getPermById(permId);
  if (!perm) { closeEquipModal(); return; }

  // Point the equipment's effects at the target, maintain the Equipped-trait tracker,
  // and build/update the equip pseudo-perm. Shared with board restore via Battlefield.
  Battlefield.applyEquipAttachment(permId, abilityIdx, _equipSelectedTargetId);

  closeEquipModal();
  Battlefield.evaluate();
  renderAll();
}

function unattachEquipFromModal() {
  const permId = _equipModalPermId;
  if (!permId) { closeEquipModal(); return; }
  // Clear targetId on original equipment effects and synthetic tracking effect.
  Battlefield.setTarget(permId, null);
  const synth = Battlefield.effects.find(e => e.sourceId === permId && e._isEquipTargetEff);
  if (synth) synth.targetId = null;
  // Remove pseudo-perm if it exists.
  const pseudo = Battlefield.permanents.find(p => p._isEquipEffect && p._equipSourceId === permId);
  if (pseudo) Battlefield.removePermanent(pseudo.id);
  closeEquipModal();
  Battlefield.evaluate();
  renderAll();
}
