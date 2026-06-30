/* ui-modal-text-change.js — Text-change cluster: standard text-change, swirl (color),
   exchange (deadpool / target swap), exchange-control, creature-type modal.
   Extracted from ui-modals.js. */

/* [KEY: MODAL-TEXT]  —  Text-change targeting/word-replacement modal (expanded) */
let _textModalSourceId = null;
let _textModalReplacements = [];
let _textModalSelectedWord = null;

function openTextChangeModal(permId) {
  _textModalSourceId = permId;
  const effect = Battlefield.effects.find(e => e.sourceId === permId && e.type === EFFECT_TYPE.TEXT_CHANGE);
  if (!effect) return;
  const changeType = effect.params.changeType || 'color_or_land';
  if (changeType === 'color_global') return openSwirlModal(permId, effect);
  if (changeType === 'exchange_text') return openExchangeModal(permId, effect);
  if (changeType === 'creature_type') return openCreatureTypeModal(permId, effect);
  openStandardTextModal(permId, effect);
}

/* --- Standard color/land text-change modal (Mind Bend etc.) --- */
function openStandardTextModal(permId, effect) {
  const changeType = effect.params.changeType || 'color_or_land';
  const currentTarget = effect.targetId || '';
  _textModalReplacements = [...(effect.params.replacements || [])];
  _textModalSelectedWord = null;

  const overlay = _createModalOverlay('text-modal-overlay', closeTextChangeModal);

  let otherPerms = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === permId) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack[0] !== p.id) return false; // non-top mutate members are not valid targets
    return true;
  });
  if (effect.params.targetRestriction) {
    const finalStates = Battlefield.getAllFinalStates();
    otherPerms = otherPerms.filter(p => {
      const fs = finalStates.get(p.id);
      const state = fs || createBaseState(p);
      return effect.params.targetRestriction(state);
    });
  }
  // Also apply aura restriction from "Enchant [type]" line
  const _auraR = effect.auraRestriction
    || Battlefield.effects.find(e => e.sourceId === permId && e.auraRestriction)?.auraRestriction
    || Battlefield.getPermById(permId)?._auraRestriction;
  if (_auraR) {
    otherPerms = otherPerms.filter(p => {
      const st = { types: p.printedTypes || [], supertypes: p.printedSupertypes || [], subtypes: p.printedSubtypes || [] };
      return _auraR(st);
    });
  }

  overlay.innerHTML = _modalShell({
    title: 'Configure Text Change',
    closeFn: 'closeTextChangeModal',
    body: `
      <div class="text-change-target">
        <div class="modal-section-title">Target Permanent</div>
        <select id="text-target-select" onchange="textChangeTargetSelected()">
          <option value="">\u2014 Select target \u2014</option>
          ${otherPerms.map(p =>
            `<option value="${p.id}" ${p.id === currentTarget ? 'selected' : ''}>${escapeHtml(permDisplayName(p))}</option>`
          ).join('')}
        </select>
      </div>
      <div id="text-oracle-container"></div>
      <div class="modal-section-title">Replacement</div>
      <div id="text-replacements-list"></div>
      <div id="text-add-section" style="margin-top:10px;">
        <div class="modal-section-title">Change Word</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <select id="text-from-select" onchange="updateToOptions()" style="flex:1;padding:5px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;"></select>
          <span style="color:var(--text-dim)">\u2192</span>
          <select id="text-to-select" style="flex:1;padding:5px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;"></select>
          <button class="btn btn-sm" onclick="addTextReplacement()">Set</button>
        </div>
        <div class="dim" style="font-size:11px;margin-top:4px;">Click a highlighted word to pre-select it.</div>
      </div>`,
    footer: `
      <button class="btn btn-sm" onclick="closeTextChangeModal()">Cancel</button>
      <button class="btn-accent" onclick="applyTextChange()">Apply</button>`,
  });

  document.body.appendChild(overlay);
  renderTextReplacements();
  updateTextAddSectionVisibility();
  if (currentTarget) textChangeTargetSelected();
}

/* --- Swirl the Mists modal: pick a color, applies to all permanents --- */
function openSwirlModal(permId, effect) {
  const currentColor = effect.params.chosenColor || '';
  const overlay = _createModalOverlay('text-modal-overlay', closeTextChangeModal);

  const colors = ['white', 'blue', 'black', 'red', 'green'];
  overlay.innerHTML = _modalShell({
    title: 'Swirl the Mists \u2014 Choose a Color',
    closeFn: 'closeTextChangeModal',
    body: `
      <div class="modal-section-title">All color words on all other permanents become this color:</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        ${colors.map(c => `
          <button class="btn ${c === currentColor ? 'btn-accent' : ''}" style="min-width:80px;text-transform:capitalize;"
                  onclick="applySwirlColor('${permId}', '${c}')">${c}</button>
        `).join('')}
      </div>
      ${currentColor ? `<div style="margin-top:12px;color:var(--green);">Currently: <strong>${currentColor}</strong></div>` : ''}`,
    footer: `<button class="btn btn-sm" onclick="closeTextChangeModal()">Close</button>`,
  });
  document.body.appendChild(overlay);
}

function applySwirlColor(permId, color) {
  Battlefield.setSwirlColor(permId, color);
  closeTextChangeModal();
  Battlefield.evaluate();
  renderAll();
}

/* --- Exchange of Words / Deadpool modal --- */
function openExchangeModal(permId, effect) {
  const isDeadpool = effect.params.exchangeTargetId !== undefined && effect.params.exchangeTargetA === undefined;
  // Use final evaluated states so copies that become creatures are valid targets
  const finalStates = Battlefield.getAllFinalStates();
  const creatures = Battlefield.permanents.filter(p => {
    if (p.isManualEffect) return false;
    // Non-top mutate stack members are part of a merged permanent; only top is selectable
    const stack = Battlefield.getStack(p.id);
    if (stack && stack.length >= 2 && stack[0] !== p.id) return false;
    const fs = finalStates.get(p.id);
    return fs ? fs.types.includes('Creature') : p.printedTypes.includes('Creature');
  });

  const overlay = _createModalOverlay('text-modal-overlay', closeTextChangeModal);

  if (isDeadpool) {
    const targets = creatures.filter(p => p.id !== permId);
    overlay.innerHTML = _modalShell({
      title: 'Exchange Text Boxes',
      closeFn: 'closeTextChangeModal',
      body: `
        <div class="modal-section-title">Select target creature to exchange text with:</div>
        <div class="modal-perm-list">
          ${targets.map(p => `
            <div class="modal-perm-item" onclick="applyDeadpoolTarget('${permId}', '${p.id}')">
              ${p.imageUri ? `<img src="${p.imageUri}" alt="">` : ''}
              <div class="perm-info">
                <div class="perm-name">${escapeHtml(permDisplayName(p))}</div>
                <div class="perm-type">${escapeHtml([...p.printedTypes].join(' '))}</div>
              </div>
            </div>
          `).join('') || '<div class="dim" style="padding:8px">No other creatures</div>'}
        </div>`,
      footer: `<button class="btn btn-sm" onclick="closeTextChangeModal()">Cancel</button>`,
    });
  } else {
    const currentA = effect.params.exchangeTargetA || '';
    const currentB = effect.params.exchangeTargetB || '';
    overlay.innerHTML = _modalShell({
      title: 'Exchange of Words \u2014 Select Two Creatures',
      closeFn: 'closeTextChangeModal',
      body: `
        <div class="modal-section-title">Creature A</div>
        <select id="exchange-target-a" onchange="exchangeTargetChanged()" style="width:100%;padding:7px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;">
          <option value="">\u2014 Select \u2014</option>
          ${creatures.map(p => `<option value="${p.id}" ${p.id === currentA ? 'selected' : ''}>${escapeHtml(permDisplayName(p))}</option>`).join('')}
        </select>
        <div class="modal-section-title" style="margin-top:10px;">Creature B</div>
        <select id="exchange-target-b" onchange="exchangeTargetChanged()" style="width:100%;padding:7px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;">
          <option value="">\u2014 Select \u2014</option>
          ${creatures.map(p => `<option value="${p.id}" ${p.id === currentB ? 'selected' : ''}>${escapeHtml(permDisplayName(p))}</option>`).join('')}
        </select>
        <div id="exchange-warning" class="dim" style="margin-top:8px;color:var(--red);display:none;">Cannot exchange with itself.</div>`,
      footer: `
        <button class="btn btn-sm" onclick="closeTextChangeModal()">Cancel</button>
        <button class="btn-accent" id="exchange-apply-btn" onclick="applyExchangeTargets('${permId}')">Apply</button>`,
    });
  }
  document.body.appendChild(overlay);
}

function exchangeTargetChanged() {
  const a = document.getElementById('exchange-target-a')?.value;
  const b = document.getElementById('exchange-target-b')?.value;
  const warn = document.getElementById('exchange-warning');
  const btn = document.getElementById('exchange-apply-btn');
  if (a && b && a === b) {
    if (warn) warn.style.display = '';
    if (btn) btn.disabled = true;
  } else {
    if (warn) warn.style.display = 'none';
    if (btn) btn.disabled = false;
  }
}

function applyDeadpoolTarget(sourceId, targetId) {
  Battlefield.setDeadpoolTarget(sourceId, targetId);
  closeTextChangeModal();
  Battlefield.evaluate();
  renderAll();
}

function applyExchangeTargets(sourceId) {
  const a = document.getElementById('exchange-target-a')?.value;
  const b = document.getElementById('exchange-target-b')?.value;
  if (!a || !b || a === b) return;
  Battlefield.setExchangeTargets(sourceId, a, b);
  closeTextChangeModal();
  Battlefield.evaluate();
  renderAll();
}

/* ===== Exchange Control Modal ===== */

function openExchangeControlModal(permId) {
  const effect = Battlefield.effects.find(e =>
    e.sourceId === permId && e.type === EFFECT_TYPE.CONTROL && e.params.exchangeControl);
  if (!effect) return;

  const mode = effect.params.exchangeMode;
  const finalStates = Battlefield.getAllFinalStates();

  // Build candidate list: all non-manual permanents
  const candidates = Battlefield.permanents.filter(p => {
    if (p.isManualEffect) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack.length >= 2 && stack[0] !== p.id) return false;
    return true;
  });

  // Apply targeting restriction to get final state and filter
  const filterCandidate = (p) => {
    if (!effect.targetRestriction) return true;
    const fs = finalStates.get(p.id);
    const st = fs || {
      types: p.printedTypes || [], supertypes: p.printedSupertypes || [],
      subtypes: p.printedSubtypes || [], colors: p.printedColors || [],
      isAllCreatureTypes: false,
    };
    return effect.targetRestriction(st);
  };

  const overlay = _createModalOverlay('exchange-control-overlay', closeExchangeControlModal);
  const sourcePerm = Battlefield.getPermById(permId);
  const activePlayerId = sourcePerm?.controller || sourcePerm?.owner || Battlefield.activePlayerId;

  if (mode === 'self_and_target') {
    // Pattern A: source permanent is auto-selected as A, user picks B
    const selfId = effect.params.exchangeSelfId || permId;
    const selfPerm = Battlefield.getPermById(selfId);
    const targets = candidates.filter(p => {
      if (p.id === selfId) return false;
      if (!filterCandidate(p)) return false;
      if (effect.opponentControlRequired) {
        const ctrl = finalStates.get(p.id)?.controller || p.controller || p.owner;
        if (ctrl === activePlayerId) return false;
      }
      if (effect.neitherOwnNorControl) {
        const owner = p.owner || activePlayerId;
        if (owner === activePlayerId) return false;
      }
      return true;
    });
    const currentB = effect.params.exchangeTargetB || '';
    const optHtml = (p, selectedId) => {
      const fs = finalStates.get(p.id);
      const typeLine = fs ? [...(fs.supertypes||[]), ...(fs.types||[])].join(' ') : [...(p.printedSupertypes||[]), ...(p.printedTypes||[])].join(' ');
      const ctrl = fs?.controller || p.controller || p.owner;
      const playerTag = Battlefield.players.length > 1 && Battlefield.getPlayerName ? ` [${Battlefield.getPlayerName(ctrl)}]` : '';
      return `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(permDisplayName(p))} \u2014 ${escapeHtml(typeLine)}${playerTag}</option>`;
    };
    overlay.innerHTML = _modalShell({
      title: '\u21c4 Exchange Control',
      closeFn: 'closeExchangeControlModal',
      body: `
        <div class="modal-section-title">This permanent (fixed):</div>
        <div class="modal-perm-item" style="opacity:0.7;pointer-events:none;margin-bottom:10px;">
          ${selfPerm?.imageUri ? `<img src="${selfPerm.imageUri}" alt="">` : ''}
          <div class="perm-info">
            <div class="perm-name">${escapeHtml(selfPerm ? permDisplayName(selfPerm) : '?')}</div>
          </div>
        </div>
        <div class="modal-section-title">Exchange with:</div>
        <select id="exchctrl-target-b" style="width:100%;padding:7px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;">
          <option value="">\u2014 Select target \u2014</option>
          ${targets.map(p => optHtml(p, currentB)).join('') || '<option disabled>No valid targets</option>'}
        </select>`,
      footer: `
        <button class="btn btn-sm" onclick="closeExchangeControlModal()">Cancel</button>
        <button class="btn-accent" onclick="applyExchangeControlSelf('${permId}', '${selfId}')">Apply</button>`,
    });
  } else {
    const currentA = effect.params.exchangeTargetA || '';
    const currentB = effect.params.exchangeTargetB || '';
    const filtered = candidates.filter(p => filterCandidate(p));
    const optHtml = (p, selectedId) => {
      const fs = finalStates.get(p.id);
      const typeLine = fs ? [...(fs.supertypes||[]), ...(fs.types||[])].join(' ') : [...(p.printedSupertypes||[]), ...(p.printedTypes||[])].join(' ');
      const ctrl = fs?.controller || p.controller || p.owner;
      const playerTag = Battlefield.players.length > 1 && Battlefield.getPlayerName ? ` [${Battlefield.getPlayerName(ctrl)}]` : '';
      return `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(permDisplayName(p))} \u2014 ${escapeHtml(typeLine)}${playerTag}</option>`;
    };
    overlay.innerHTML = _modalShell({
      title: '\u21c4 Exchange Control',
      closeFn: 'closeExchangeControlModal',
      body: `
        ${effect.params.shareTypeRequired ? '<div class="dim" style="margin-bottom:8px;">Targets must share a card type.</div>' : ''}
        ${effect.params.differentPlayersRequired ? '<div class="dim" style="margin-bottom:8px;">Targets must be controlled by different players.</div>' : ''}
        <div class="modal-section-title">Permanent A</div>
        <select id="exchctrl-target-a" onchange="exchCtrlTargetChanged('${permId}')" style="width:100%;padding:7px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;">
          <option value="">\u2014 Select \u2014</option>
          ${filtered.map(p => optHtml(p, currentA)).join('')}
        </select>
        <div class="modal-section-title" style="margin-top:10px;">Permanent B</div>
        <select id="exchctrl-target-b" onchange="exchCtrlTargetChanged('${permId}')" style="width:100%;padding:7px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;">
          <option value="">\u2014 Select \u2014</option>
          ${filtered.map(p => optHtml(p, currentB)).join('')}
        </select>
        <div id="exchctrl-warning" class="dim" style="margin-top:8px;color:var(--red);display:none;"></div>`,
      footer: `
        <button class="btn btn-sm" onclick="closeExchangeControlModal()">Cancel</button>
        <button class="btn-accent" id="exchctrl-apply-btn" onclick="applyExchangeControlTwo('${permId}')">Apply</button>`,
    });
  }

  document.body.appendChild(overlay);
  // Re-filter B options if share-type is required and A is already selected
  if (mode === 'two_targets' && effect.params.exchangeTargetA) exchCtrlTargetChanged(permId);
}

function closeExchangeControlModal() {
  const el = document.getElementById('exchange-control-overlay');
  if (el) el.remove();
}

function exchCtrlTargetChanged(permId) {
  const a = document.getElementById('exchctrl-target-a')?.value;
  const b = document.getElementById('exchctrl-target-b')?.value;
  const warn = document.getElementById('exchctrl-warning');
  const btn = document.getElementById('exchctrl-apply-btn');

  const effect = Battlefield.effects.find(e =>
    e.sourceId === permId && e.type === EFFECT_TYPE.CONTROL && e.params.exchangeControl);

  let warningText = '';
  if (a && b && a === b) {
    warningText = 'Cannot exchange with itself.';
  }

  // Share-type validation
  if (a && b && a !== b && effect?.params?.shareTypeRequired) {
    const finalStates = Battlefield.getAllFinalStates();
    const stA = finalStates.get(a);
    const stB = finalStates.get(b);
    if (stA && stB) {
      const typesA = new Set(stA.types || []);
      const shares = (stB.types || []).some(t => typesA.has(t));
      if (!shares) warningText = 'These permanents do not share a card type.';
    }
  }

  // Different-players validation
  if (a && b && a !== b && effect?.params?.differentPlayersRequired) {
    const finalStates = Battlefield.getAllFinalStates();
    const ctrlA = finalStates.get(a)?.controller;
    const ctrlB = finalStates.get(b)?.controller;
    if (ctrlA && ctrlB && ctrlA === ctrlB) warningText = 'These permanents must be controlled by different players.';
  }

  if (warningText) {
    if (warn) { warn.textContent = warningText; warn.style.display = ''; }
    if (btn) btn.disabled = true;
  } else {
    if (warn) warn.style.display = 'none';
    if (btn) btn.disabled = false;
  }

  // Dynamic B-dropdown filtering for share-type: re-filter options based on A's types
  if (effect?.params?.shareTypeRequired && a) {
    const finalStates = Battlefield.getAllFinalStates();
    const stA = finalStates.get(a);
    const typesA = new Set(stA?.types || []);
    const selB = document.getElementById('exchctrl-target-b');
    if (selB) {
      for (const opt of selB.options) {
        if (!opt.value) continue; // skip placeholder
        const stOpt = finalStates.get(opt.value);
        const shares = stOpt ? (stOpt.types || []).some(t => typesA.has(t)) : true;
        opt.style.display = (opt.value === a || !shares) ? 'none' : '';
      }
    }
  }
}

function applyExchangeControlSelf(sourceId, selfId) {
  const targetId = document.getElementById('exchctrl-target-b')?.value;
  if (!targetId) return;
  Battlefield.setExchangeControlTargets(sourceId, selfId, targetId);
  closeExchangeControlModal();
  Battlefield.evaluate();
  renderAll();
}

function applyExchangeControlTwo(sourceId) {
  const a = document.getElementById('exchctrl-target-a')?.value;
  const b = document.getElementById('exchctrl-target-b')?.value;
  if (!a || !b || a === b) return;
  Battlefield.setExchangeControlTargets(sourceId, a, b);
  closeExchangeControlModal();
  Battlefield.evaluate();
  renderAll();
}

/* --- Creature type text-change modal (Artificial Evolution, New Blood) --- */
function openCreatureTypeModal(permId, effect) {
  const currentTarget = effect.targetId || '';
  _textModalReplacements = [...(effect.params.replacements || [])];
  const toType = effect.params.toType || null;
  const excludeTypes = effect.params.excludeTypes || [];

  const overlay = _createModalOverlay('text-modal-overlay', closeTextChangeModal);
  overlay.dataset.excludeTypes = JSON.stringify(excludeTypes);

  let otherPerms = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === permId) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack[0] !== p.id) return false; // non-top mutate members are not valid targets
    return true;
  });
  // Apply target restriction from known ability params (e.g. New Blood: "target creature")
  if (effect.params.targetRestriction) {
    const finalStates = Battlefield.getAllFinalStates();
    otherPerms = otherPerms.filter(p => {
      const fs = finalStates.get(p.id);
      const state = fs || createBaseState(p);
      return effect.params.targetRestriction(state);
    });
  }
  // Apply aura restriction from "Enchant [type]" line
  const _auraR2 = effect.auraRestriction
    || Battlefield.effects.find(e => e.sourceId === permId && e.auraRestriction)?.auraRestriction
    || Battlefield.getPermById(permId)?._auraRestriction;
  if (_auraR2) {
    otherPerms = otherPerms.filter(p => {
      const st = { types: p.printedTypes || [], supertypes: p.printedSupertypes || [], subtypes: p.printedSubtypes || [] };
      return _auraR2(st);
    });
  }

  overlay.innerHTML = _modalShell({
    title: 'Creature Type Text Change',
    closeFn: 'closeTextChangeModal',
    body: `
      <div class="text-change-target">
        <div class="modal-section-title">Target Permanent</div>
        <select id="text-target-select" onchange="creatureTypeTargetSelected()">
          <option value="">\u2014 Select target \u2014</option>
          ${otherPerms.map(p =>
            `<option value="${p.id}" ${p.id === currentTarget ? 'selected' : ''}>${escapeHtml(permDisplayName(p))}</option>`
          ).join('')}
        </select>
      </div>
      <div id="text-oracle-container"></div>
      <div class="modal-section-title">Replacement</div>
      <div id="text-replacements-list"></div>
      <div id="text-add-section" style="margin-top:10px;">
        <div class="modal-section-title">Change Creature Type</div>
        <div style="display:flex;gap:6px;align-items:center;">
          <div style="flex:1;position:relative;">
            <input type="text" id="creature-type-from" placeholder="Type to search\u2026"
                   autocomplete="off" oninput="creatureTypeAutocomplete('creature-type-from', 'creature-type-from-dropdown')"
                   style="width:100%;padding:5px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;">
            <div id="creature-type-from-dropdown" class="creature-type-dropdown"></div>
          </div>
          <span style="color:var(--text-dim)">\u2192</span>
          <div style="flex:1;position:relative;">
            ${toType
              ? `<input type="text" id="creature-type-to" value="${toType}" readonly
                       style="width:100%;padding:5px;background:var(--surface2);color:var(--text-dim);border:1px solid var(--border);border-radius:4px;">`
              : `<input type="text" id="creature-type-to" placeholder="Type to search\u2026"
                       autocomplete="off" oninput="creatureTypeAutocomplete('creature-type-to', 'creature-type-to-dropdown')"
                       style="width:100%;padding:5px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;">
                 <div id="creature-type-to-dropdown" class="creature-type-dropdown"></div>`}
          </div>
          <button class="btn btn-sm" onclick="addCreatureTypeReplacement()">Set</button>
        </div>
      </div>`,
    footer: `
      <button class="btn btn-sm" onclick="closeTextChangeModal()">Cancel</button>
      <button class="btn-accent" onclick="applyTextChange()">Apply</button>`,
  });

  document.body.appendChild(overlay);
  renderTextReplacements();
  if (currentTarget) creatureTypeTargetSelected();
}

function creatureTypeAutocomplete(inputId, dropdownId) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  if (!input || !dropdown) return;
  const query = input.value.trim().toLowerCase();
  if (query.length < 1) { dropdown.style.display = 'none'; return; }

  const overlay = document.getElementById('text-modal-overlay');
  const excludeTypes = overlay?.dataset?.excludeTypes ? JSON.parse(overlay.dataset.excludeTypes) : [];
  const excludeSet = new Set(excludeTypes.map(t => t.toLowerCase()));

  let types = TypeCatalog.creatureTypes.size > 0 ? [...TypeCatalog.creatureTypes] :
    ['Human','Elf','Goblin','Merfolk','Zombie','Vampire','Angel','Dragon','Wizard','Warrior',
     'Soldier','Knight','Cleric','Rogue','Shaman','Beast','Elemental','Spirit','Demon','Bird',
     'Cat','Dog','Bear','Faerie','Giant','Dwarf','Treefolk','Saproling','Sliver','Insect',
     'Spider','Snake','Rat','Skeleton','Hydra','Sphinx','Phyrexian','Fungus','Horror','Wurm','Drake'];

  const filtered = types
    .filter(t => t.toLowerCase().startsWith(query) && !excludeSet.has(t.toLowerCase()))
    .slice(0, 10);

  if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
  dropdown.style.display = 'block';
  dropdown.innerHTML = filtered.map(t =>
    `<div class="creature-type-option" onclick="selectCreatureType('${inputId}', '${dropdownId}', '${t}')">${escapeHtml(t)}</div>`
  ).join('');
}

function selectCreatureType(inputId, dropdownId, type) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  if (input) input.value = type;
  if (dropdown) dropdown.style.display = 'none';
}

function creatureTypeTargetSelected() {
  const targetId = document.getElementById('text-target-select').value;
  const container = document.getElementById('text-oracle-container');
  if (!targetId) { container.innerHTML = ''; return; }
  const perm = Battlefield.getPermById(targetId);
  if (!perm) { container.innerHTML = ''; return; }

  const creatureTypes = TypeCatalog.creatureTypes.size > 0 ? [...TypeCatalog.creatureTypes] : [];
  // Show text as it appears after earlier Layer 3 effects
  const layer3Text = Battlefield.getLayer3Text(targetId, _textModalSourceId);
  const layer3Subtypes = Battlefield.getLayer3Subtypes(targetId, _textModalSourceId);

  // If target is top of a mutate stack, merge abilities from all cards in the stack
  const mutateStack = Battlefield.getStack(targetId);
  let displayOracleText = layer3Text;
  if (mutateStack && mutateStack[0] === targetId && mutateStack.length > 1) {
    const topLines = layer3Text.split('\n').map(l => l.trim()).filter(Boolean);
    const seenAb = new Set(topLines.map(l => l.toLowerCase()));
    const allLines = [...topLines];
    for (let i = 1; i < mutateStack.length; i++) {
      const stackText = Battlefield.getLayer3Text(mutateStack[i], _textModalSourceId);
      for (const line of stackText.split('\n').map(l => l.trim()).filter(Boolean)) {
        const lw = line.toLowerCase();
        const allowDup = /^(?:at|when|whenever)\b/.test(lw) || /\bat the beginning\b|\bwhenever\b/i.test(lw) || /^ward\b/i.test(lw);
        if (allowDup || !seenAb.has(lw)) { seenAb.add(lw); allLines.push(line); }
      }
    }
    displayOracleText = allLines.join('\n');
  }
  let html = escapeHtml(displayOracleText);
  // Build a combined set of words to highlight: each creature type + its plural form
  // When clicking a plural, we auto-fill the singular form (since replacements work on singular)
  const highlightWords = []; // { word, singularForm }
  const alreadyHighlighted = new Set();
  for (const ct of creatureTypes) {
    if (!alreadyHighlighted.has(ct.toLowerCase())) {
      highlightWords.push({ word: ct, singularForm: ct });
      alreadyHighlighted.add(ct.toLowerCase());
    }
    // Also highlight the plural form if present in text
    if (typeof pluralizeCreatureType === 'function') {
      const plural = pluralizeCreatureType(ct);
      if (plural.toLowerCase() !== ct.toLowerCase() && !alreadyHighlighted.has(plural.toLowerCase())) {
        highlightWords.push({ word: plural, singularForm: ct });
        alreadyHighlighted.add(plural.toLowerCase());
      }
    }
  }
  for (const st of layer3Subtypes) {
    if (!alreadyHighlighted.has(st.toLowerCase())) {
      highlightWords.push({ word: st, singularForm: st });
      alreadyHighlighted.add(st.toLowerCase());
    }
    if (typeof pluralizeCreatureType === 'function') {
      const plural = pluralizeCreatureType(st);
      if (plural.toLowerCase() !== st.toLowerCase() && !alreadyHighlighted.has(plural.toLowerCase())) {
        highlightWords.push({ word: plural, singularForm: st });
        alreadyHighlighted.add(plural.toLowerCase());
      }
    }
  }
  // Sort longest-first to avoid partial matches
  highlightWords.sort((a, b) => b.word.length - a.word.length);
  if (highlightWords.length > 0) {
    // Single-pass replacement: running multiple sequential regexes would corrupt span
    // attributes inserted by earlier passes (e.g. "Goblin" matches inside onclick="...Goblin...")
    const wordMap = new Map(highlightWords.map(({ word, singularForm }) => [word.toLowerCase(), singularForm]));
    const combinedPattern = highlightWords
      .map(({ word }) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const combinedRegex = new RegExp('\\b(' + combinedPattern + ')\\b', 'gi');
    html = html.replace(combinedRegex, (match) => {
      const singularForm = wordMap.get(match.toLowerCase()) || match;
      const safeSingular = singularForm.replace(/'/g, "\\'");
      return `<span class="text-editable-word creature-type-word" title="Click to select: ${singularForm}" onclick="selectCreatureTypeWord('${safeSingular}')">${match}</span>`;
    });
  }
  // Build type line using computed state (post Layer 1 + Layer 4) so copies and type-changes are reflected
  const finalStates = Battlefield.getAllFinalStates();
  const fs = finalStates.get(targetId);
  const fullTypes = fs ? (fs.types || []) : (perm.printedTypes || []);
  const fullSupertypes = fs ? (fs.supertypes || []) : (perm.printedSupertypes || []);
  const typeLineParts = escapeHtml([...fullSupertypes, ...fullTypes].join(' '));
  const clickableSubtypes = layer3Subtypes
    .map(st => `<span class="text-editable-word creature-type-word" title="Click to select" onclick="selectCreatureTypeWord('${escapeAttr(st)}')">${escapeHtml(st)}</span>`)
    .join(' ');
  const typeLineDisplay = typeLineParts + (layer3Subtypes.length ? '  —  ' + clickableSubtypes : '');
  container.innerHTML = `
    ${perm.imageUri || perm.name ? `<div class="copy-editor-banner" style="margin-bottom:8px;">
      ${perm.imageUri ? `<img src="${perm.imageUri}" alt="" class="copy-editor-thumb">` : ''}
      <div>
        <div style="font-weight:600;font-size:13px;">${escapeHtml(perm.name)}</div>
        <div class="dim" style="font-size:11px;">${escapeHtml([...fullSupertypes, ...fullTypes].join(' ') + (layer3Subtypes.length ? ' — ' + layer3Subtypes.join(' ') : ''))}</div>
      </div>
    </div>` : ''}
    ${typeLineDisplay ? `<div class="modal-section-title">Type Line (click a subtype to select it)</div><div class="text-oracle-display" style="margin-bottom:8px;">${typeLineDisplay}</div>` : ''}
    <div class="modal-section-title">Current text (click a creature type to select it)</div>
    <div class="text-oracle-display">${html}</div>`;
}

/* Auto-fill the "from" field when clicking a creature type word */
function selectCreatureTypeWord(word) {
  const fromInput = document.getElementById('creature-type-from');
  if (fromInput) {
    fromInput.value = word;
    // Highlight the clicked word AND its plural/singular forms
    const wordLow = word.toLowerCase();
    const plural = typeof pluralizeCreatureType === 'function' ? pluralizeCreatureType(word).toLowerCase() : '';
    const singular = typeof singularizeCreatureType === 'function' ? singularizeCreatureType(word).toLowerCase() : '';
    const matchSet = new Set([wordLow, plural, singular].filter(Boolean));
    document.querySelectorAll('.creature-type-word').forEach(el => {
      el.classList.toggle('selected', matchSet.has(el.textContent.toLowerCase()));
    });
  }
}

function addCreatureTypeReplacement() {
  const from = document.getElementById('creature-type-from')?.value?.trim();
  const to = document.getElementById('creature-type-to')?.value?.trim();
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return;
  // Validate that "to" type is not Wall for Artificial Evolution
  const overlay = document.getElementById('text-modal-overlay');
  const excludeTypes = overlay?.dataset?.excludeTypes ? JSON.parse(overlay.dataset.excludeTypes) : [];
  if (excludeTypes.map(t => t.toLowerCase()).includes(to.toLowerCase())) {
    alert(`Cannot choose "${to}"  —  pick a non-${to} creature type.`);
    return;
  }
  _textModalReplacements = _textModalReplacements.filter(r => r.from.toLowerCase() !== from.toLowerCase());
  _textModalReplacements.push({ from, to });
  renderTextReplacements();
}

/* --- Common helpers --- */
function getTextChangeMaxReps() {
  if (!_textModalSourceId) return 1;
  const effect = Battlefield.effects.find(e => e.sourceId === _textModalSourceId && e.type === EFFECT_TYPE.TEXT_CHANGE);
  return effect?.params?.maxReplacements || 1;
}

function updateTextAddSectionVisibility() {
  const addSection = document.getElementById('text-add-section');
  if (!addSection) return;
  addSection.style.display = _textModalReplacements.length >= getTextChangeMaxReps() ? 'none' : '';
}

function getReplacementOptionsForWord(word, changeType) {
  const w = word.toLowerCase();
  const colors = ['white', 'blue', 'black', 'red', 'green'];
  const lands = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  const isColor = colors.includes(w);
  const isLand = lands.map(l => l.toLowerCase()).includes(w);
  if (isColor && changeType !== 'land_only') return colors.filter(c => c !== w);
  if (isLand && changeType !== 'color_only') return lands.filter(l => l.toLowerCase() !== w);
  let all = [];
  if (changeType !== 'land_only') all.push(...colors);
  if (changeType !== 'color_only') all.push(...lands);
  return all.filter(x => x.toLowerCase() !== w);
}

function populateTextDropdowns(changeType, preselectedFrom) {
  const fromSelect = document.getElementById('text-from-select');
  const toSelect = document.getElementById('text-to-select');
  if (!fromSelect || !toSelect) return;
  const colors = ['white', 'blue', 'black', 'red', 'green'];
  const lands = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  let words = [];
  if (changeType === 'color_or_land') words = [...colors, ...lands];
  else if (changeType === 'land_only') words = [...lands];
  else if (changeType === 'color_only') words = [...colors];
  fromSelect.innerHTML = words.map(w =>
    `<option value="${w}" ${preselectedFrom && w.toLowerCase() === preselectedFrom.toLowerCase() ? 'selected' : ''}>${w}</option>`
  ).join('');
  updateToOptions();
}

function updateToOptions() {
  const fromSelect = document.getElementById('text-from-select');
  const toSelect = document.getElementById('text-to-select');
  if (!fromSelect || !toSelect) return;
  const effect = Battlefield.effects.find(e => e.sourceId === _textModalSourceId && e.type === EFFECT_TYPE.TEXT_CHANGE);
  const changeType = effect?.params.changeType || 'color_or_land';
  const options = getReplacementOptionsForWord(fromSelect.value, changeType);
  toSelect.innerHTML = options.map(w => `<option value="${w}">${w}</option>`).join('');
}

function textChangeTargetSelected() {
  const targetId = document.getElementById('text-target-select').value;
  const container = document.getElementById('text-oracle-container');
  if (!targetId) { container.innerHTML = ''; return; }
  const perm = Battlefield.getPermById(targetId);
  if (!perm) { container.innerHTML = ''; return; }

  const effect = Battlefield.effects.find(e => e.sourceId === _textModalSourceId && e.type === EFFECT_TYPE.TEXT_CHANGE);
  const changeType = effect?.params.changeType || 'color_or_land';
  const colors = ['white', 'blue', 'black', 'red', 'green'];
  const lands = ['plains', 'island', 'swamp', 'mountain', 'forest'];
  const landPlurals = ['plains', 'islands', 'swamps', 'mountains', 'forests'];
  let editableWords = [];
  if (changeType !== 'land_only') editableWords.push(...colors);
  if (changeType !== 'color_only') {
    editableWords.push(...lands);
    // Also highlight plural forms so "Mountains" etc. are fully highlighted
    for (const pl of landPlurals) {
      if (!editableWords.includes(pl)) editableWords.push(pl);
    }
  }

  // Show text as it appears after earlier Layer 3 effects (Fix 6)
  const layer3Text = Battlefield.getLayer3Text(targetId, _textModalSourceId);
  // If target is top of a mutate stack, merge abilities from all cards in the stack
  const mutateStackTC = Battlefield.getStack(targetId);
  let displayText = layer3Text;
  if (mutateStackTC && mutateStackTC[0] === targetId && mutateStackTC.length > 1) {
    const topLines = layer3Text.split('\n').map(l => l.trim()).filter(Boolean);
    const seenAb = new Set(topLines.map(l => l.toLowerCase()));
    const allLines = [...topLines];
    for (let i = 1; i < mutateStackTC.length; i++) {
      const stackText = Battlefield.getLayer3Text(mutateStackTC[i], _textModalSourceId);
      for (const line of stackText.split('\n').map(l => l.trim()).filter(Boolean)) {
        const lw = line.toLowerCase();
        const allowDup = /^(?:at|when|whenever)\b/.test(lw) || /\bat the beginning\b|\bwhenever\b/i.test(lw) || /^ward\b/i.test(lw);
        if (allowDup || !seenAb.has(lw)) { seenAb.add(lw); allLines.push(line); }
      }
    }
    displayText = allLines.join('\n');
  }
  let html = escapeHtml(displayText);
  // Sort longest-first so "mountains" highlights before "mountain" could partially match
  const sortedWords = [...editableWords].sort((a, b) => b.length - a.length);
  for (const word of sortedWords) {
    const regex = new RegExp('(' + word + ')(?![a-z])', 'gi');
    html = html.replace(regex, `<span class="text-editable-word" onclick="selectEditableWord('$1')" title="Click to change">$1</span>`);
  }
  // Show the card as it appears at the END of Layer 3 (after copy + text changes but
  // BEFORE Layer 4 type changes), matching the layer this modal edits. Using the final
  // (all-layers) state would wrongly show e.g. a land's Layer-4-granted types here.
  const l3State = Battlefield.getLayer3State(targetId, _textModalSourceId);
  const displayName = l3State ? l3State.name : perm.name;
  // Build the type line. Basic land subtypes (Plains/Island/Swamp/Mountain/Forest) live in
  // the type line, not the oracle text, so for land-capable changes (Mind Bend etc.) make
  // them clickable too — otherwise a bare basic land has no clickable word at all.
  const leftTypes = l3State ? [...(l3State.supertypes || []), ...(l3State.types || [])]
    : [...(perm.printedSupertypes || []), ...(perm.printedTypes || [])];
  const subtypesArr = l3State ? (l3State.subtypes || []) : (perm.printedSubtypes || []);
  // Dim (non-clickable) type line for the banner header.
  const plainTypeLine = escapeHtml(leftTypes.join(' '))
    + (subtypesArr.length ? ' — ' + escapeHtml(subtypesArr.join(' ')) : '');
  // Dedicated "Type Line" section (mirrors the New Blood / Artificial Evolution layout):
  // basic land subtypes (Plains/Island/Swamp/Mountain/Forest) live in the type line, not the
  // oracle text, so for land-capable changes (Mind Bend etc.) they get their own clickable spot.
  const basicLandSet = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);
  const allowLand = changeType !== 'color_only';
  const hasClickableLand = allowLand && subtypesArr.some(st => basicLandSet.has(st));
  const subHtml = subtypesArr.map(st => (allowLand && basicLandSet.has(st))
    ? `<span class="text-editable-word" onclick="selectEditableWord('${st}')" title="Click to change">${escapeHtml(st)}</span>`
    : escapeHtml(st)).join(' ');
  const typeLineDisplay = escapeHtml(leftTypes.join(' '))
    + (subtypesArr.length ? '  —  ' + subHtml : '');
  container.innerHTML = `
    <div class="copy-editor-banner" style="margin-bottom:8px;">
      ${perm.imageUri ? `<img src="${perm.imageUri}" alt="" class="copy-editor-thumb">` : ''}
      <div>
        <div style="font-weight:600;font-size:13px;">${escapeHtml(displayName)}</div>
        <div class="dim" style="font-size:11px;">${plainTypeLine}</div>
      </div>
    </div>
    ${hasClickableLand ? `<div class="modal-section-title">Type Line (click a basic land type to select it)</div>
    <div class="text-oracle-display" style="margin-bottom:8px;">${typeLineDisplay}</div>` : ''}
    <div class="modal-section-title">Current text (click a highlighted word)</div>
    <div class="text-oracle-display">${html}</div>`;
  populateTextDropdowns(changeType, null);
}

function selectEditableWord(word) {
  // Map plural land forms to singular for the "from" dropdown
  const PLURAL_TO_SINGULAR_LAND = {
    'islands': 'Island', 'swamps': 'Swamp', 'mountains': 'Mountain', 'forests': 'Forest'
    // Plains is the same singular/plural — no mapping needed
  };
  const singularWord = PLURAL_TO_SINGULAR_LAND[word.toLowerCase()] || word;
  _textModalSelectedWord = singularWord;
  const effect = Battlefield.effects.find(e => e.sourceId === _textModalSourceId && e.type === EFFECT_TYPE.TEXT_CHANGE);
  const changeType = effect?.params.changeType || 'color_or_land';
  populateTextDropdowns(changeType, singularWord);
  // Highlight both singular and plural forms of the word
  const wordLow = word.toLowerCase();
  const singLow = singularWord.toLowerCase();
  document.querySelectorAll('.text-editable-word').forEach(el => {
    const elLow = el.textContent.toLowerCase();
    el.classList.toggle('selected', elLow === wordLow || elLow === singLow);
  });
}

function renderTextReplacements() {
  const container = document.getElementById('text-replacements-list');
  if (!container) return;
  if (!_textModalReplacements.length) {
    container.innerHTML = '<div class="dim" style="padding:4px 0">No replacements yet</div>';
    return;
  }
  // Check if this is a creature_type or land change to show plural info
  const effect = Battlefield.effects.find(e => e.sourceId === _textModalSourceId && e.type === EFFECT_TYPE.TEXT_CHANGE);
  const isCreatureType = effect?.params?.changeType === 'creature_type';
  const isLandType = effect?.params?.changeType === 'color_or_land' || effect?.params?.changeType === 'land_only';
  container.innerHTML = _textModalReplacements.map((r, i) => {
    let pluralInfo = '';
    if (isCreatureType && typeof pluralizeCreatureType === 'function') {
      const fromPlural = pluralizeCreatureType(r.from);
      const toPlural = pluralizeCreatureType(r.to);
      if (fromPlural.toLowerCase() !== r.from.toLowerCase() ||
          toPlural.toLowerCase() !== r.to.toLowerCase()) {
        pluralInfo = `<div class="dim" style="font-size:0.85em;margin-left:4px;">(also: ${escapeHtml(fromPlural)} \u2192 ${escapeHtml(toPlural)})</div>`;
      }
    }
    if (isLandType && typeof buildLandTypeReplacementPairs === 'function') {
      const pairs = buildLandTypeReplacementPairs(r.from, r.to);
      const extra = pairs.filter(p => p.from.toLowerCase() !== r.from.toLowerCase());
      if (extra.length) {
        pluralInfo = `<div class="dim" style="font-size:0.85em;margin-left:4px;">(also: ${extra.map(p => escapeHtml(p.from) + ' \u2192 ' + escapeHtml(p.to)).join(', ')})</div>`;
      }
    }
    return `
    <div class="text-replacement-row">
      <span class="from">${escapeHtml(r.from)}</span>
      <span class="arrow">\u2192</span>
      <span class="to">${escapeHtml(r.to)}</span>
      <button onclick="removeTextReplacement(${i})" title="Remove">\u00d7</button>
    </div>${pluralInfo}`;
  }).join('');
}

function addTextReplacement() {
  const from = document.getElementById('text-from-select').value;
  const to = document.getElementById('text-to-select').value;
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return;
  _textModalReplacements = _textModalReplacements.filter(r => r.from.toLowerCase() !== from.toLowerCase());
  _textModalReplacements.push({ from, to });
  renderTextReplacements();
  updateTextAddSectionVisibility();
}

function removeTextReplacement(index) {
  _textModalReplacements.splice(index, 1);
  renderTextReplacements();
  updateTextAddSectionVisibility();
}

function applyTextChange() {
  const targetSelect = document.getElementById('text-target-select');
  const targetId = targetSelect ? targetSelect.value : null;
  if (targetSelect && !targetId) { alert('Please select a target permanent.'); return; }
  Battlefield.setTextChangeConfig(_textModalSourceId, targetId, _textModalReplacements);
  closeTextChangeModal();
  Battlefield.evaluate();
  renderAll();
}

function closeTextChangeModal() {
  const overlay = document.getElementById('text-modal-overlay');
  if (overlay) overlay.remove();
  _textModalSourceId = null;
  _textModalReplacements = [];
  _textModalSelectedWord = null;
}

