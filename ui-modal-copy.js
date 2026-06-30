/* ui-modal-copy.js — Copy modal (Clone-style copy-source picker + editable copy editor).
   Extracted from ui-modals.js. */

let _copyModalSourceId = null;
let _copyModalSelectedCard = null;
let _copyModalSelectedPermId = null; // battlefield perm chosen as the copy source (for live copy-of-copy re-derivation)

function openCopyModal(permId) {
  _copyModalSourceId = permId;
  _copyModalSelectedCard = null;
  _copyModalSelectedPermId = null;
  const effect = Battlefield.effects.find(e => e.sourceId === permId && e.type === EFFECT_TYPE.COPY);
  if (!effect) return;

  const restriction = effect.params.restriction;
  const sourcePerm = Battlefield.getPermById(permId);
  const spentToCast = (effect.params.maxManaValue === 'spentToCast' && sourcePerm)
    ? getSpentToCast(sourcePerm) : null;
  const overlay = _createModalOverlay('copy-modal-overlay', closeCopyModal);

  overlay.innerHTML = _modalShell({
    title: 'Select Copy Source',
    closeFn: 'closeCopyModal',
    bodyId: 'copy-modal-body',
    body: `
      <div class="modal-section-title">Search Scryfall</div>
      <div class="modal-search-bar">
        <input type="text" id="copy-search-input" placeholder="Search for a card\u2026" autocomplete="off">
      </div>
      <div class="modal-search-results" id="copy-search-results"></div>

      <div class="modal-section-title">Or Select from Battlefield</div>
      <div class="modal-perm-list" id="copy-bf-list"></div>`,
    footerId: 'copy-modal-footer',
    footer: `<button class="btn btn-sm" onclick="closeCopyModal()">Cancel</button>`,
  });

  document.body.appendChild(overlay);

  // Populate battlefield list - use final evaluated states for restriction checking
  const bfList = document.getElementById('copy-bf-list');
  // Only show top cards of mutate stacks; non-top cards are not valid copy targets
  const perms = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === permId) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack[0] !== p.id) return false;
    return true;
  });
  const finalStates = Battlefield.getAllFinalStates();
  bfList.innerHTML = perms.map(p => {
    const fs = finalStates.get(p.id);
    const state = fs
      ? { types: fs.types || [], supertypes: fs.supertypes || [], subtypes: fs.subtypes || [], colors: fs.colors || [], isAllCreatureTypes: fs.isAllCreatureTypes, isToken: p.isToken }
      : createBaseState(p);
    const mvValid = spentToCast === null || (p.manaValue || 0) <= spentToCast;
    const valid = (!restriction || restriction(state)) && mvValid;
    return `
    <div class="modal-perm-item ${valid ? '' : 'disabled'}" data-id="${p.id}" ${valid ? `onclick="selectCopyFromBattlefield('${p.id}')"` : ''}>
      ${p.imageUri ? `<img src="${p.imageUri}" alt="">` : ''}
      <div class="perm-info">
        <div class="perm-name">${escapeHtml(fs ? fs.name : p.name)}</div>
        <div class="perm-type">${escapeHtml([...(fs ? fs.types : p.printedTypes)].join(' '))}${(fs ? fs.subtypes : p.printedSubtypes).length ? '  \u2014  ' + (fs ? fs.subtypes : p.printedSubtypes).join(' ') : ''}</div>
      </div>
      ${!valid ? '<span class="dim">(invalid target)</span>' : ''}
    </div>`;
  }).join('') || '<div class="dim" style="padding:8px">No other permanents on battlefield</div>';

  // Bind search
  const input = document.getElementById('copy-search-input');
  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { document.getElementById('copy-search-results').innerHTML = ''; return; }
      document.getElementById('copy-search-results').innerHTML = '<div class="search-loading">Searching\u2026</div>';
      const cards = await searchScryfall(q);
      renderCopySearchResults(cards, restriction, spentToCast);
    }, 350);
  });
  input.focus();
}

function renderCopySearchResults(cards, restriction, spentToCast = null) {
  const container = document.getElementById('copy-search-results');
  if (!cards.length) { container.innerHTML = '<div class="search-empty">No results</div>'; return; }
  container.innerHTML = cards.slice(0, 20).map((card, i) => {
    const parsed = parseTypeLine(card.type_line || '');
    const fakeState = {
      types: parsed.types,
      subtypes: parsed.subtypes,
      supertypes: parsed.supertypes,
    };
    const mvValid = spentToCast === null || (card.cmc || 0) <= spentToCast;
    const valid = (!restriction || restriction(fakeState)) && mvValid;
    return `
    <div class="modal-perm-item ${valid ? '' : 'disabled'}" ${valid ? `onclick="selectCopyFromSearch(${i})"` : ''}>
      <img src="${card.image_uris?.small || ''}" alt="" onerror="this.style.display='none'" style="width:28px;height:39px;object-fit:cover;border-radius:3px">
      <div class="perm-info">
        <div class="perm-name">${escapeHtml(card.name)}</div>
        <div class="perm-type">${escapeHtml(card.type_line || '')}</div>
      </div>
      ${!valid ? '<span class="dim">(invalid)</span>' : ''}
    </div>`;
  }).join('');
}

/* Phase 1 -> Phase 2: user selected a card, now show the copy editor */
function selectCopyFromSearch(idx) {
  const card = _scryfallLastResults[idx];
  if (!card) return;
  _copyModalSelectedPermId = null; // a searched card is not a battlefield permanent
  showCopyEditor(card);
}

function selectCopyFromBattlefield(permId) {
  const perm = Battlefield.getPermById(permId);
  if (!perm || !perm.scryfallData) return;
  // Remember which battlefield permanent is the copy source, so the engine can re-derive
  // its copiable values live if it is (or becomes) a copy itself (CR 707.2 copy-of-copy).
  _copyModalSelectedPermId = permId;

  // CR 707.2: copiable values are the permanent's state at the END of Layer 1 —
  // after all copy effects (including "except" clause overrides) have been applied.
  // Don't trace back to the original copy source card; evaluate Layer 1 directly.
  // For perms with no active copy source, use scryfallData directly (no regression).
  let baseCardData = perm.scryfallData;
  const hasCopySource = Battlefield.effects.some(e =>
    e.sourceId === permId && e.type === EFFECT_TYPE.COPY && e.params && e.params.copySource
  );
  if (hasCopySource) {
    const evalResult = evaluatePermanent(perm, Battlefield.permanents, Battlefield.effects, permId);
    const l1 = evalResult?.layers?.[0]?.stateAfter;
    if (l1) {
      const typeLine = [...(l1.supertypes || []), ...(l1.types || [])].join(' ') +
        (l1.subtypes?.length ? ' — ' + l1.subtypes.join(' ') : '');
      baseCardData = {
        name: l1.name,
        type_line: typeLine,
        oracle_text: l1.oracleText || (l1.abilities || []).join('\n'),
        colors: [...(l1.colors || [])],
        power: l1.power != null ? String(l1.power) : undefined,
        toughness: l1.toughness != null ? String(l1.toughness) : undefined,
        cmc: l1.manaValue || 0,
        mana_cost: l1.manaCost || '',
      };
    }
  }

  // CR 702.140: If the target is the top of a mutate stack, include ALL abilities
  // from all cards in the stack merged together.
  const mutateStack = Battlefield.getStack(permId);
  if (mutateStack && mutateStack[0] === permId && mutateStack.length > 1) {
    const topOracle = (baseCardData.oracle_text || '').split('\n').map(l => l.trim()).filter(Boolean);
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
        if (allowDup || !seenAb.has(ab)) { seenAb.add(ab); allAbilities.push(ab); }
      }
    }
    showCopyEditor({ ...baseCardData, oracle_text: allAbilities.join('\n') });
  } else {
    showCopyEditor(baseCardData);
  }
}

/* Phase 2: Copy Editor — show editable fields for the selected card */
function showCopyEditor(card) {
  _copyModalSelectedCard = card;
  const body = document.getElementById('copy-modal-body');
  const footer = document.getElementById('copy-modal-footer');
  const header = document.querySelector('#copy-modal-overlay .modal-header h3');
  if (!body || !footer) return;
  if (header) header.textContent = 'Edit Copy';

  // Parse the type line into left (supertypes + types) and right (subtypes)
  const parsed = parseTypeLine(card.type_line || '');
  const leftPart = [...parsed.supertypes, ...parsed.types].join(' ');
  const rightPart = parsed.subtypes.join(' ');

  // Detect if creature for P/T display
  const isCreature = parsed.types.includes('Creature');
  const hasPT = card.power !== undefined || card.toughness !== undefined;

  // Color checkboxes
  const colorMap = [
    { code: 'W', label: 'White', symbol: 'W' },
    { code: 'U', label: 'Blue', symbol: 'U' },
    { code: 'B', label: 'Black', symbol: 'B' },
    { code: 'R', label: 'Red', symbol: 'R' },
    { code: 'G', label: 'Green', symbol: 'G' },
  ];
  const cardColors = (card.colors || []).map(c => c.toUpperCase());

  body.innerHTML = `
    <div class="copy-editor-banner">
      ${card.image_uris?.small ? `<img src="${card.image_uris.small}" alt="" class="copy-editor-thumb">` : ''}
      <div>
        <div style="font-weight:600;font-size:13px;">${escapeHtml(card.name)}</div>
        <div class="dim" style="font-size:11px;">${escapeHtml(card.type_line || '')}</div>
      </div>
    </div>
    <div style="color:var(--text-dim);font-size:11px;margin-bottom:8px;">
      Note: Edit any field below. Incorrect oracle text wording may cause abilities to not parse properly.
    </div>

    <div class="copy-editor-field">
      <label class="copy-editor-label">Name</label>
      <input type="text" id="copy-ed-name" class="copy-editor-input" value="${escapeAttr(card.name || '')}">
    </div>

    <div class="copy-editor-field">
      <label class="copy-editor-label">Type Line</label>
      <div class="copy-editor-typeline">
        <input type="text" id="copy-ed-types-left" class="copy-editor-input" value="${escapeAttr(leftPart)}" placeholder="Supertypes + Types">
        <span class="copy-editor-mdash">\u2014</span>
        <input type="text" id="copy-ed-types-right" class="copy-editor-input" value="${escapeAttr(rightPart)}" placeholder="Subtypes">
      </div>
    </div>

    <div class="copy-editor-field">
      <label class="copy-editor-label">Colors</label>
      <div class="copy-editor-colors">
        ${colorMap.map(c => `
          <label class="copy-editor-color-cb">
            <input type="checkbox" id="copy-ed-color-${c.code}" ${cardColors.includes(c.code) ? 'checked' : ''}>
            <span>${c.symbol} ${c.label}</span>
          </label>
        `).join('')}
      </div>
    </div>

    <div class="copy-editor-field" id="copy-ed-pt-row" style="${(isCreature || hasPT) ? '' : 'display:none'}">
      <label class="copy-editor-label">Power / Toughness</label>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="text" id="copy-ed-power" class="copy-editor-input" style="width:60px;text-align:center;" value="${escapeAttr(card.power != null ? String(card.power) : '')}">
        <span style="color:var(--text-dim);font-weight:600;">/</span>
        <input type="text" id="copy-ed-toughness" class="copy-editor-input" style="width:60px;text-align:center;" value="${escapeAttr(card.toughness != null ? String(card.toughness) : '')}">
      </div>
    </div>

    <div class="copy-editor-field">
      <label class="copy-editor-label">Current text</label>
      <textarea id="copy-ed-oracle" class="copy-editor-textarea" rows="5">${escapeHtml(_stripReminderText(card.oracle_text || ''))}</textarea>
    </div>`;

  footer.innerHTML = `
    <button class="btn btn-sm" onclick="copyEditorBack()">\u2190 Back</button>
    <button class="btn-accent" onclick="applyCopyFromEditor()">Apply Copy</button>`;

  // Auto-show/hide P/T row when types change
  const leftInput = document.getElementById('copy-ed-types-left');
  if (leftInput) {
    leftInput.addEventListener('input', () => {
      const ptRow = document.getElementById('copy-ed-pt-row');
      if (ptRow) {
        const val = leftInput.value.toLowerCase();
        ptRow.style.display = (val.includes('creature') || val.includes('vehicle')) ? '' : 'none';
      }
    });
  }
}

/* Phase 2 -> Phase 1: go back to card selection */
function copyEditorBack() {
  _copyModalSelectedCard = null;
  const sourceId = _copyModalSourceId;
  closeCopyModal();
  openCopyModal(sourceId);
}

/* Phase 2 -> Apply: build a synthetic card from the editor fields */
function applyCopyFromEditor() {
  const name = document.getElementById('copy-ed-name')?.value?.trim() || 'Unknown';
  const leftTypes = document.getElementById('copy-ed-types-left')?.value?.trim() || '';
  const rightTypes = document.getElementById('copy-ed-types-right')?.value?.trim() || '';
  const typeLine = rightTypes ? leftTypes + ' \u2014 ' + rightTypes : leftTypes;

  const colors = [];
  for (const code of ['W', 'U', 'B', 'R', 'G']) {
    if (document.getElementById('copy-ed-color-' + code)?.checked) colors.push(code);
  }

  const powerStr = document.getElementById('copy-ed-power')?.value?.trim();
  const toughStr = document.getElementById('copy-ed-toughness')?.value?.trim();
  const oracle = document.getElementById('copy-ed-oracle')?.value?.trim() || '';

  const syntheticCard = {
    name,
    type_line: typeLine,
    oracle_text: oracle,
    colors,
    power: powerStr !== undefined && powerStr !== '' ? powerStr : undefined,
    toughness: toughStr !== undefined && toughStr !== '' ? toughStr : undefined,
    cmc: _copyModalSelectedCard?.cmc || 0,
    mana_cost: _copyModalSelectedCard?.mana_cost || '',
  };

  Battlefield.setCopySource(_copyModalSourceId, syntheticCard);

  // Record which battlefield permanent we copied so the engine can re-derive copiable
  // values from its live Layer-1 state (CR 707.2 copy-of-copy). Clear it for searched cards.
  const copyEff = Battlefield.effects.find(e => e.sourceId === _copyModalSourceId && e.type === EFFECT_TYPE.COPY);
  if (copyEff) {
    if (_copyModalSelectedPermId) copyEff.params._copyTargetPermId = _copyModalSelectedPermId;
    else delete copyEff.params._copyTargetPermId;
  }

  // If the copy source matches a known card, inject those effects (tokens too)
  _injectKnownCardEffectsForCopy(_copyModalSourceId, syntheticCard);

  closeCopyModal();
  Battlefield.evaluate();
  renderAll();
}

function closeCopyModal() {
  const overlay = document.getElementById('copy-modal-overlay');
  if (overlay) overlay.remove();
  _copyModalSourceId = null;
  _copyModalSelectedCard = null;
  _copyModalSelectedPermId = null;
}
/* [END: MODAL-COPY] */
