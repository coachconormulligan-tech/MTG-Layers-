/* --- Triggered / Activated Ability Handlers --- */

/* Fire a triggered ability: look up the ability from the final computed state,
   create a pseudo-permanent in the timeline, re-render. */
function fireTriggeredAbility(permId, abilityIdx) {
  const finalStates = Battlefield.getAllFinalStates();
  const fState = finalStates.get(permId);
  if (!fState) return;
  const triggers = Battlefield.extractTriggeredAbilities(fState.abilities || []);
  const t = triggers.find(tr => tr.index === abilityIdx);
  if (!t) return;
  // Check trigger limit
  if (t.triggerLimit !== null) {
    const count = Battlefield.getTriggerCount(permId, abilityIdx);
    if (count >= t.triggerLimit) return;
  }
  // Check "if [condition]," prefix — if the condition is evaluable and false, do nothing.
  const ifCondMatch = t.effectText.match(/^if\s+([^,]+),\s*/i);
  if (ifCondMatch) {
    const condResult = _evaluateTriggerCondition(ifCondMatch[1].trim(), fState);
    if (condResult === false) return;
  }
  const pseudo = Battlefield.addTriggeredAbility(permId, abilityIdx, t.effectText, t.fullText, finalStates);
  // Exchange of Words (text-swap) / Gilded Drake-style (control-swap) triggers:
  // parseCardEffects doesn't always emit these for the pronoun phrasings, so inject
  // them onto the pseudo-perm. Shared with board restore via Battlefield.
  if (pseudo) Battlefield.injectTriggeredExchange(pseudo, permId, t.effectText);
  // Princess Yue-style "dies → becomes a land named X" transform: deselect from all
  // targets, move timestamp to last, then rename (L3) / become a land (L4) / gain the
  // quoted ability (L6). No-op for any other trigger text.
  if (pseudo) Battlefield.injectTriggeredBecomesLand(pseudo, permId, t.effectText);
  Battlefield.evaluate();
  renderAll();
}

/* Fire an activated ability: look up the ability from the final computed state,
   create a pseudo-permanent in the timeline, re-render. */
function fireActivatedAbility(permId, abilityIdx) {
  const finalStates = Battlefield.getAllFinalStates();
  const fState = finalStates.get(permId);
  if (!fState) return;
  const activated = Battlefield.extractActivatedAbilities(fState.abilities || []);
  const a = activated.find(ac => ac.index === abilityIdx);
  if (!a) return;
  // Check activation limit
  if (a.activateLimit !== null) {
    const count = Battlefield.getActivateCount(permId, abilityIdx);
    if (count >= a.activateLimit) return;
  }
  // "Activate only if you control N or more creatures with different powers" (Coven condition).
  // Check that the controller has at least N distinct power values among their creatures.
  const covenMatch = a.effectText.match(/activate\s+only\s+if\s+you\s+control\s+(\w+)\s+or\s+more\s+creatures\s+with\s+different\s+powers/i);
  if (covenMatch) {
    const threshold = _parseWordNumber(covenMatch[1]) || parseInt(covenMatch[1], 10) || 3;
    const srcPerm = Battlefield.getPermById(permId);
    const controller = srcPerm ? (srcPerm.controller || srcPerm.owner || Battlefield.activePlayerId) : Battlefield.activePlayerId;
    const distinctPowers = new Set();
    for (const [pid, st] of finalStates) {
      const pp = Battlefield.getPermById(pid);
      if (!pp || pp.isManualEffect) continue;
      if ((pp.controller || pp.owner || Battlefield.activePlayerId) !== controller) continue;
      if (!st.types || !st.types.includes('Creature')) continue;
      if (st.power !== null && st.power !== undefined) distinctPowers.add(Number(st.power));
    }
    if (distinctPowers.size < threshold) return;
  }
  // Monstrosity: if the creature isn't already monstrous, add the Monstrous
  // trait. The +1/+1 counters are left for the user to place manually so they
  // can manage counter state themselves. No pseudo-permanent is created.
  if (a.isMonstrosity) {
    const perm = Battlefield.getPermById(permId);
    if (!perm) return;
    if (!perm.traits) perm.traits = [];
    if (perm.traits.includes('Monstrous')) return;
    perm.traits.push('Monstrous');
    Battlefield.evaluate();
    renderAll();
    return;
  }
  // Crew: add Crewed trait + an artifact-creature ADD_TYPE pseudo-perm.
  if (a.isCrew) {
    Battlefield.applyCrew(permId, abilityIdx, a.fullText);
    Battlefield.evaluate();
    renderAll();
    return;
  }
  // Saddle: add Saddled trait + a tracking pseudo-perm.
  if (a.isSaddle) {
    Battlefield.applySaddle(permId, abilityIdx, a.fullText);
    Battlefield.evaluate();
    renderAll();
    return;
  }
  // Equip / Reconfigure / Fortify: open a target-selection popup.
  if (a.isEquip || a.isReconfigure || a.isFortify) {
    openEquipModal(permId, abilityIdx, a);
    return;
  }
  // If the ability has split "or" options, let the user choose which to apply.
  if (a.options && a.options.length >= 2) {
    openActivateOptionsPopup(permId, abilityIdx, a);
    return;
  }
  // CR 702.16 — "gains protection from the color of your choice": pop a color chooser
  // and substitute the chosen color into the effect text before firing.
  if (/gains?\s+protection\s+from\s+the\s+color\s+of\s+your\s+choice/i.test(a.effectText)) {
    openColorChoicePopup(a.fullText, (chosen) => {
      const colorName = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' }[chosen] || chosen.toLowerCase();
      const newText = a.effectText.replace(/the\s+color\s+of\s+your\s+choice/i, colorName);
      Battlefield.addActivatedAbility(permId, abilityIdx, newText, a.fullText);
      Battlefield.evaluate();
      renderAll();
    });
    return;
  }
  // "Choose a color. … gains/has [effect] from that color" — open a color picker and
  // substitute the chosen color into the effect text before creating the pseudo-perm.
  if (/^choose a color\./i.test(a.effectText)) {
    openColorChoicePopup(a.fullText, (chosen) => {
      const colorName = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' }[chosen] || chosen.toLowerCase();
      const newText = a.effectText.replace(/^choose a color\.\s*/i, '').replace(/\bthat color\b/gi, colorName);
      Battlefield.addActivatedAbility(permId, abilityIdx, newText, a.fullText, finalStates);
      Battlefield.evaluate();
      renderAll();
    });
    return;
  }
  Battlefield.addActivatedAbility(permId, abilityIdx, a.effectText, a.fullText, finalStates);
  Battlefield.evaluate();
  renderAll();
}

function openColorChoicePopup(promptText, onChoice) {
  let overlay = document.getElementById('color-choice-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'color-choice-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  const colors = [
    { code: 'W', label: 'White' },
    { code: 'U', label: 'Blue' },
    { code: 'B', label: 'Black' },
    { code: 'R', label: 'Red' },
    { code: 'G', label: 'Green' },
  ];
  window._colorChoiceCallback = onChoice;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = 'none'; };
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal ability-popup">
      <div class="modal-header">
        <h3>Choose a color</h3>
        <button class="modal-close" onclick="document.getElementById('color-choice-overlay').style.display='none'">&times;</button>
      </div>
      <div class="modal-body">
        <div style="color:var(--text-dim);margin-bottom:8px;font-size:13px;">${escapeHtml(promptText || '')}</div>
        ${colors.map(c => `<button class="ability-popup-fire-btn" style="display:block;width:100%;margin:6px 0;text-align:left;"
          onclick="(window._colorChoiceCallback &amp;&amp; window._colorChoiceCallback('${c.code}'));document.getElementById('color-choice-overlay').style.display='none';">${c.label}</button>`).join('')}
      </div>
    </div>`;
}

function openActivateOptionsPopup(permId, abilityIdx, a) {
  let overlay = document.getElementById('activate-options-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'activate-options-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  const optsHtml = a.options.map((opt, i) => `
    <button class="ability-popup-fire-btn ability-popup-activated-fire" style="display:block;width:100%;margin:6px 0;text-align:left;"
      onclick="_chooseActivateOption('${escapeAttr(permId)}', ${abilityIdx}, ${i})">${escapeHtml(_replaceYouControl(opt, permId))}</button>
  `).join('');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = 'none'; };
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal ability-popup">
      <div class="modal-header">
        <h3>Choose one</h3>
        <button class="modal-close" onclick="document.getElementById('activate-options-overlay').style.display='none'">&times;</button>
      </div>
      <div class="modal-body">
        <div style="color:var(--text-dim);margin-bottom:8px;font-size:13px;">${escapeHtml(_replaceYouControl(a.fullText, permId))}</div>
        ${optsHtml}
      </div>
    </div>`;
}

function _chooseActivateOption(permId, abilityIdx, optionIdx) {
  const finalStates = Battlefield.getAllFinalStates();
  const fState = finalStates.get(permId);
  if (!fState) return;
  const activated = Battlefield.extractActivatedAbilities(fState.abilities || []);
  const a = activated.find(ac => ac.index === abilityIdx);
  if (!a || !a.options) return;
  const chosen = a.options[optionIdx];
  Battlefield.addActivatedAbility(permId, abilityIdx, chosen, a.fullText, finalStates);
  const _ovl = document.getElementById('activate-options-overlay');
  if (_ovl) _ovl.style.display = 'none';
  // Also refresh the parent ability popup if open.
  if (_abilityPopupPermId) _updateAbilityPopupContent();
  Battlefield.evaluate();
  renderAll();
}

/* Remove a triggered or activated ability pseudo-permanent from the timeline. */
function removeAbilityEffect(permId) {
  const p = Battlefield.permanents.find(pp => pp.id === permId);
  if (p && p._isEquipEffect && p._equipSourceId) {
    // When the equip pseudo-perm is dismissed, also un-assign the attachment target
    const synth = Battlefield.effects.find(e => e.sourceId === p._equipSourceId && e._isEquipTargetEff);
    if (synth) synth.targetId = null;
  }
  Battlefield.removePermanent(permId);
  Battlefield.evaluate();
  renderAll();
}

/* Reset trigger counts for a new turn. */
function resetTriggerCounts() {
  Battlefield.resetTriggerCounts();
  renderAll();
}

/* ---- Triggered / Activated Ability Popup ---- */
let _abilityPopupPermId = null;

function openAbilityPopup(permId) {
  _abilityPopupPermId = permId;
  let overlay = document.getElementById('ability-popup-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'ability-popup-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.onclick = (e) => { if (e.target === overlay) closeAbilityPopup(); };
  overlay.style.display = 'flex';
  _updateAbilityPopupContent();
}

function _updateAbilityPopupContent() {
  const permId = _abilityPopupPermId;
  if (!permId) return;
  const overlay = document.getElementById('ability-popup-overlay');
  if (!overlay) return;
  const perm = Battlefield.getPermById(permId);
  if (!perm) { closeAbilityPopup(); return; }

  const finalStates = Battlefield.getAllFinalStates();
  const fState = finalStates.get(permId);
  if (!fState) { closeAbilityPopup(); return; }

  const triggers = Battlefield.extractTriggeredAbilities(fState.abilities || []);
  const activated = Battlefield.extractActivatedAbilities(fState.abilities || []);

  let rowsHtml = '';

  if (triggers.length) {
    rowsHtml += '<div class="ability-popup-section-label">Triggered Abilities</div>';
    for (const t of triggers) {
      const count = Battlefield.getTriggerCount(permId, t.index);
      const atLimit = t.triggerLimit !== null && count >= t.triggerLimit;
      const limitBadge = t.triggerLimit !== null
        ? `<span class="ability-popup-limit${atLimit ? ' at-limit' : ''}">${count}/${t.triggerLimit}</span>`
        : '';
      rowsHtml += `<div class="ability-popup-row">
        <div class="ability-popup-text">
          <span class="ability-popup-type-badge ability-popup-trigger-badge">Triggered Ability</span>
          ${limitBadge}
          <span class="ability-popup-ability-text">${escapeHtml(_replaceYouControl(t.fullText, permId))}</span>
        </div>
        <button class="ability-popup-fire-btn ability-popup-trigger-fire${atLimit ? ' disabled' : ''}"
          onclick="_fireTriggeredFromPopup('${escapeAttr(permId)}', ${t.index})"
          ${atLimit ? 'disabled' : ''}>Trigger</button>
      </div>`;
    }
  }

  if (activated.length) {
    rowsHtml += '<div class="ability-popup-section-label">Activated Abilities</div>';
    for (const a of activated) {
      const count = Battlefield.getActivateCount(permId, a.index);
      const isMonstrous = !!(perm.traits && perm.traits.includes('Monstrous'));
      const atLimit = (a.activateLimit !== null && count >= a.activateLimit)
        || (a.isMonstrosity && isMonstrous);
      const limitBadge = a.activateLimit !== null
        ? `<span class="ability-popup-limit${atLimit ? ' at-limit' : ''}">${count}/${a.activateLimit}</span>`
        : '';
      rowsHtml += `<div class="ability-popup-row">
        <div class="ability-popup-text">
          <span class="ability-popup-type-badge ability-popup-activated-badge">Activated Ability</span>
          ${limitBadge}
          <span class="ability-popup-ability-text">${escapeHtml(_replaceYouControl(a.fullText, permId))}</span>
        </div>
        <button class="ability-popup-fire-btn ability-popup-activated-fire${atLimit ? ' disabled' : ''}"
          onclick="_fireActivatedFromPopup('${escapeAttr(permId)}', ${a.index})"
          ${atLimit ? 'disabled' : ''}>Activate</button>
      </div>`;
    }
  }

  overlay.innerHTML = `
    <div class="modal ability-popup">
      <div class="modal-header">
        <h3>${escapeHtml(perm.name)} — Abilities</h3>
        <button class="modal-close" onclick="closeAbilityPopup()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="ability-popup-rows">${rowsHtml}</div>
      </div>
      <div class="modal-footer">
        <button class="modal-popup-cancel-btn" onclick="closeAbilityPopup()">Close</button>
      </div>
    </div>`;
}

function _fireTriggeredFromPopup(permId, abilityIdx) {
  fireTriggeredAbility(permId, abilityIdx);
  closeAbilityPopup();
}

function _fireActivatedFromPopup(permId, abilityIdx) {
  fireActivatedAbility(permId, abilityIdx);
  closeAbilityPopup();
}

function closeAbilityPopup() {
  _abilityPopupPermId = null;
  const overlay = document.getElementById('ability-popup-overlay');
  if (overlay) overlay.style.display = 'none';
}

/* Render a summary line + button to open the modal mode selection popup.
   Shows active mode count and opens the full popup on click. */
function renderModalModeToggles(sourceId) {
  const perm = Battlefield.getPermById(sourceId);
  if (!perm) return '';
  const maxActive = perm.modalMaxActive ?? Infinity;
  const repeatable = !!perm.modalRepeatable;
  const effs = Battlefield.effects.filter(e => e.sourceId === sourceId && e.modalModeIndex !== undefined);
  // Count active modes (including unparseable selections)
  let activeCount = 0;
  if (repeatable && perm.modalModeCounts) {
    activeCount = Object.values(perm.modalModeCounts).reduce((s, v) => s + v, 0);
    if (perm._unparseableCounts) activeCount += Object.values(perm._unparseableCounts).reduce((s, v) => s + v, 0);
  } else {
    const activeIndices = new Set();
    for (const e of effs) { if (!e.disabled) activeIndices.add(e.modalModeIndex); }
    activeCount = activeIndices.size;
    if (perm._unparseableActive) activeCount += perm._unparseableActive.size;
  }
  const maxLabel = maxActive === Infinity ? '∞' : maxActive;
  const label = repeatable ? `Modes: ${activeCount}/${maxLabel}` : `Modes: ${activeCount}/${maxLabel}`;
  return `<div class="modal-mode-summary" onclick="event.stopPropagation()">
    <button class="ts-action-btn configure modal-mode-btn" onclick="event.stopPropagation(); openModalModePopup('${escapeAttr(sourceId)}')" title="Configure modes">${escapeHtml(label)}</button>
  </div>`;
}

/* ---- Modal Mode Selection Popup ---- */
let _modalModePopupPermId = null;
// For repeatable: temp counts during popup editing
let _modalModeTempCounts = {};
// For non-repeatable: temp active set during popup editing
let _modalModeTempActive = new Set();
// Track unparseable mode selections (count toward N but no game effect)
let _modalModeUnparseableActive = new Set();
// For repeatable unparseable
let _modalModeUnparseableCounts = {};
// Snapshot of initial state for change detection
let _modalModeInitialState = null;

function _snapshotModalState(repeatable) {
  if (repeatable) {
    return JSON.stringify({ c: _modalModeTempCounts, u: _modalModeUnparseableCounts });
  }
  return JSON.stringify({ a: [..._modalModeTempActive].sort(), u: [..._modalModeUnparseableActive].sort() });
}

function _modalStateChanged() {
  if (!_modalModePopupPermId || !_modalModeInitialState) return false;
  const perm = Battlefield.getPermById(_modalModePopupPermId);
  if (!perm) return false;
  return _snapshotModalState(!!perm.modalRepeatable) !== _modalModeInitialState;
}

function openModalModePopup(permId) {
  _modalModePopupPermId = permId;
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;
  const repeatable = !!perm.modalRepeatable;
  const effs = Battlefield.effects.filter(e => e.sourceId === permId && e.modalModeIndex !== undefined);

  // Initialize temp state from current state
  if (repeatable) {
    _modalModeTempCounts = {};
    _modalModeUnparseableCounts = {};
    if (perm.modalModeCounts) {
      for (const [k, v] of Object.entries(perm.modalModeCounts)) _modalModeTempCounts[parseInt(k)] = v;
    } else {
      for (const e of effs) {
        if (!e.disabled && _modalModeTempCounts[e.modalModeIndex] === undefined) {
          _modalModeTempCounts[e.modalModeIndex] = 1;
        }
      }
    }
    if (perm._unparseableCounts) {
      for (const [k, v] of Object.entries(perm._unparseableCounts)) _modalModeUnparseableCounts[parseInt(k)] = v;
    }
  } else {
    _modalModeTempActive = new Set();
    _modalModeUnparseableActive = new Set();
    for (const e of effs) {
      if (!e.disabled) _modalModeTempActive.add(e.modalModeIndex);
    }
    if (perm._unparseableActive) {
      for (const idx of perm._unparseableActive) _modalModeUnparseableActive.add(idx);
    }
  }

  // Snapshot initial state for change detection
  _modalModeInitialState = _snapshotModalState(repeatable);

  // Create overlay once, then populate inner content
  let overlay = document.getElementById('modal-mode-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-mode-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.onclick = (e) => { if (e.target === overlay) closeModalModePopup(); };
  overlay.style.display = 'flex';
  // Build the full shell once
  overlay.innerHTML = `
    <div class="modal modal-mode-popup">
      <div class="modal-header">
        <h3 id="modal-mode-title"></h3>
        <span class="modal-popup-count-badge" id="modal-mode-badge"></span>
        <button class="modal-close" onclick="closeModalModePopup()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-popup-modes" id="modal-mode-rows"></div>
      </div>
      <div class="modal-footer">
        <button class="modal-popup-apply-btn" id="modal-mode-apply-btn" onclick="applyModalModePopup()" disabled>Apply</button>
        <button class="modal-popup-cancel-btn" onclick="closeModalModePopup()">Cancel</button>
      </div>
    </div>`;
  _updateModalModeContent();
}

function _updateModalModeContent() {
  const permId = _modalModePopupPermId;
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;
  const maxActive = perm.modalMaxActive ?? Infinity;
  const minActive = perm.modalMinActive ?? 0;
  const repeatable = !!perm.modalRepeatable;
  const modeTexts = perm.modalModeTexts || [];
  const effs = Battlefield.effects.filter(e => e.sourceId === permId && e.modalModeIndex !== undefined);
  const parsedModeIndices = new Set();
  for (const e of effs) { if (e.modalModeIndex !== undefined) parsedModeIndices.add(e.modalModeIndex); }

  // Calculate total active count (parsed + unparseable)
  let totalActive = 0;
  if (repeatable) {
    for (const v of Object.values(_modalModeTempCounts)) totalActive += v;
    for (const v of Object.values(_modalModeUnparseableCounts)) totalActive += v;
  } else {
    totalActive = _modalModeTempActive.size + _modalModeUnparseableActive.size;
  }

  const maxLabel = maxActive === Infinity ? '∞' : maxActive;
  const constraintLabel = maxActive === 1 ? 'Choose one'
    : minActive === 1 && maxActive === 2 ? 'Choose one or both'
    : minActive === 1 ? 'Choose one or more'
    : `Choose ${maxLabel}`;
  const repeatLabel = repeatable ? ' (may repeat)' : '';

  // Build mode rows
  const rows = modeTexts.map((text, modeIdx) => {
    const isParsed = parsedModeIndices.has(modeIdx);

    if (repeatable) {
      const counts = isParsed ? _modalModeTempCounts : _modalModeUnparseableCounts;
      const count = counts[modeIdx] ?? 0;
      const canInc = maxActive === Infinity || totalActive < maxActive;
      const canDec = count > 0;
      return `<div class="modal-popup-mode ${!isParsed ? 'modal-popup-mode-unparsed' : ''}" title="${escapeAttr(text)}">
        <div class="modal-popup-mode-text">${escapeHtml(text)}${!isParsed ? ' <span class="modal-popup-unparsed-tag">(no game effect)</span>' : ''}</div>
        <div class="modal-popup-counter">
          <button class="modal-popup-counter-btn" ${!canDec ? 'disabled' : ''} onclick="event.stopPropagation(); _modalModeAdjust(${modeIdx}, -1, ${!isParsed})">−</button>
          <span class="modal-popup-counter-val">${count}</span>
          <button class="modal-popup-counter-btn" ${!canInc ? 'disabled' : ''} onclick="event.stopPropagation(); _modalModeAdjust(${modeIdx}, 1, ${!isParsed})">+</button>
        </div>
      </div>`;
    } else {
      // Checkbox/radio for non-repeatable
      const isActive = isParsed ? _modalModeTempActive.has(modeIdx) : _modalModeUnparseableActive.has(modeIdx);
      const isRadio = (maxActive === 1);
      const canActivate = isRadio || isActive || maxActive === Infinity || totalActive < maxActive;
      const inputType = isRadio ? 'radio' : 'checkbox';
      const radioName = isRadio ? `name="modal_popup_radio"` : '';
      return `<div class="modal-popup-mode ${!isParsed ? 'modal-popup-mode-unparsed' : ''} ${isActive ? 'modal-popup-mode-active' : ''}" title="${escapeAttr(text)}">
        <label class="modal-popup-mode-label">
          <input type="${inputType}" ${radioName} ${isActive ? 'checked' : ''} ${!canActivate && !isActive ? 'disabled' : ''}
            onchange="event.stopPropagation(); _modalModeToggle(${modeIdx}, this.checked, ${!isParsed}, ${isRadio})">
          <span class="modal-popup-mode-text">${escapeHtml(text)}${!isParsed ? ' <span class="modal-popup-unparsed-tag">(no game effect)</span>' : ''}</span>
        </label>
      </div>`;
    }
  }).join('');

  // Update only the inner content (no overlay recreation = no flicker)
  const titleEl = document.getElementById('modal-mode-title');
  const badgeEl = document.getElementById('modal-mode-badge');
  const rowsEl = document.getElementById('modal-mode-rows');
  const applyBtn = document.getElementById('modal-mode-apply-btn');
  if (titleEl) titleEl.textContent = `${perm.name} — ${constraintLabel}${repeatLabel}`;
  if (badgeEl) badgeEl.textContent = `${totalActive}/${maxLabel}`;
  if (rowsEl) rowsEl.innerHTML = rows;

  // Enable Apply whenever minimum mode requirement is met.
  // No "changed" guard — the user should always be able to confirm a valid selection.
  const meetsMin = minActive === 0 || totalActive >= minActive;
  if (applyBtn) applyBtn.disabled = !meetsMin;
}

function _modalModeAdjust(modeIdx, delta, isUnparseable) {
  const perm = Battlefield.getPermById(_modalModePopupPermId);
  if (!perm) return;
  const maxActive = perm.modalMaxActive ?? Infinity;
  const counts = isUnparseable ? _modalModeUnparseableCounts : _modalModeTempCounts;
  const cur = counts[modeIdx] ?? 0;
  const newVal = Math.max(0, cur + delta);
  // Check total doesn't exceed max
  if (delta > 0 && maxActive < Infinity) {
    let total = 0;
    for (const v of Object.values(_modalModeTempCounts)) total += v;
    for (const v of Object.values(_modalModeUnparseableCounts)) total += v;
    if (total >= maxActive) return;
  }
  counts[modeIdx] = newVal;
  _updateModalModeContent();
}

function _modalModeToggle(modeIdx, checked, isUnparseable, isRadio) {
  const perm = Battlefield.getPermById(_modalModePopupPermId);
  if (!perm) return;
  const maxActive = perm.modalMaxActive ?? Infinity;

  if (isRadio) {
    // Radio: clear all, select this one
    _modalModeTempActive.clear();
    _modalModeUnparseableActive.clear();
    if (isUnparseable) _modalModeUnparseableActive.add(modeIdx);
    else _modalModeTempActive.add(modeIdx);
  } else {
    const activeSet = isUnparseable ? _modalModeUnparseableActive : _modalModeTempActive;
    if (checked) {
      // Check capacity
      const total = _modalModeTempActive.size + _modalModeUnparseableActive.size;
      if (maxActive < Infinity && total >= maxActive) {
        // At max - remove oldest to make room
        if (_modalModeTempActive.size > 0) {
          const oldest = _modalModeTempActive.values().next().value;
          _modalModeTempActive.delete(oldest);
        } else if (_modalModeUnparseableActive.size > 0) {
          const oldest = _modalModeUnparseableActive.values().next().value;
          _modalModeUnparseableActive.delete(oldest);
        }
      }
      activeSet.add(modeIdx);
    } else {
      activeSet.delete(modeIdx);
    }
  }
  _updateModalModeContent();
}

function closeModalModePopup() {
  _modalModePopupPermId = null;
  _modalModeInitialState = null;
  const overlay = document.getElementById('modal-mode-overlay');
  if (overlay) overlay.style.display = 'none';
}

function applyModalModePopup() {
  const permId = _modalModePopupPermId;
  const perm = Battlefield.getPermById(permId);
  if (!perm) { closeModalModePopup(); return; }
  const repeatable = !!perm.modalRepeatable;

  if (repeatable) {
    Battlefield.setModalModeCounts(permId, { ..._modalModeTempCounts });
    perm._unparseableCounts = { ..._modalModeUnparseableCounts };
  } else {
    Battlefield.setModalModeSelections(permId, new Set(_modalModeTempActive));
    perm._unparseableActive = new Set(_modalModeUnparseableActive);
  }
  Battlefield.evaluate();
  closeModalModePopup();
  renderAll();
}
