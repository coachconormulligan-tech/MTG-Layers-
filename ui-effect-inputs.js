/* Returns true if permId is a non-token copy card (has COPY effect and is not a token).
   Copy tokens should show bestow/mutate buttons; copy cards should not. */
function _isNonTokenCopyCard(perm) {
  if (!perm || perm.isToken) return false;
  // Imprint-driven copies (Dermotaxi) don't count: the imprint button still belongs on
  // the source so the user can change what's exiled with it.
  return Battlefield.effects.some(e =>
    e.sourceId === perm.id &&
    e.type === EFFECT_TYPE.COPY &&
    !(e.params && e.params.copyFromExiledCard)
  );
}

function getEffectInfo(permId, finalState) {
  const effs = Battlefield.effects.filter(e => e.sourceId === permId);
  const perm = Battlefield.getPermById(permId);
  const textEff = effs.find(e => e.type === EFFECT_TYPE.TEXT_CHANGE);
  const copyEff = effs.find(e => e.type === EFFECT_TYPE.COPY);
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

/* Render X value input for cards with variable X */
function renderXValueInput(perm) {
  // null = "X letter" (display X, treat as 0); 0 = explicitly 0; N = specific number
  const displayVal = perm.xValue === null ? 'X' : (perm.xValue === 0 ? '' : perm.xValue);
  return `<div class="cda-counter-row" onclick="event.stopPropagation()">
    <span class="cda-label" title="Variable X value">X =</span>
    <input type="text" class="cda-counter-input" value="${displayVal}"
           placeholder="X" title="Adjust X value (type a number, or 'X' to display as variable)"
           onchange="setXValue('${perm.id}', this.value)"
           style="width:50px;text-align:center;">
  </div>`;
}

function setXValue(permId, rawValue) {
  // "X" or empty → null (display as X, treat as 0); otherwise parse as number
  const strVal = String(rawValue).trim();
  const numVal = (strVal === '' || strVal.toLowerCase() === 'x') ? null : (parseInt(strVal) || 0);
  Battlefield.setXValue(permId, numVal);
  Battlefield.evaluate();
  renderAll();
}

function renderCDAInput(perm) {
  const val = perm.cdaUserValue ?? '';
  // Find the CDA effect to get forEachDesc if available
  const cdaEff = Battlefield.effects.find(e => e.sourceId === perm.id &&
    ((e.type === EFFECT_TYPE.CDA_PT && (e.params.userAdjustable || (!e.params.forEachDesc && !e.params.compute))) ||
     (e.type === EFFECT_TYPE.MODIFY_PT && e.params.forEachDesc !== undefined && e.params.userAdjustable)));
  const forEachDesc = cdaEff?.params?.forEachDesc || '';
  const placeholder = forEachDesc ? `# ${forEachDesc}` : '#';
  const title = forEachDesc ? `Count of: ${forEachDesc}` : 'CDA count (e.g. card types in graveyard)';
  return `<div class="cda-counter-row" onclick="event.stopPropagation()">
    <input type="number" class="cda-counter-input" value="${val}" min="0" max="999"
           placeholder="${escapeAttr(placeholder)}"
           title="${escapeAttr(title)}"
           onchange="setCDAValue('${perm.id}', parseInt(this.value) || 0)">
    ${forEachDesc ? `<span class="cda-label" title="${escapeAttr(forEachDesc)}">${escapeHtml(forEachDesc.length > 20 ? forEachDesc.slice(0, 18) + '...' : forEachDesc)}</span>` : ''}
  </div>`;
}

function setCDAValue(permId, value) {
  Battlefield.setCDAValue(permId, value);
  Battlefield.evaluate();
  renderAll();
}

/* Render a card name text input for cards with "choose a creature card name" */
function renderChosenCardNameInput(perm) {
  const val = perm.chosenCardName || '';
  return `<div class="cda-counter-row chosen-type-row" onclick="event.stopPropagation()">
    <span class="cda-label" title="Choose a creature card name">Name:</span>
    <div class="chosen-type-wrapper">
      <input type="text" class="chosen-type-input" value="${escapeAttr(val)}"
             placeholder="e.g. Grizzly Bears" autocomplete="off"
             title="Choose a creature card name"
             id="chosen-name-${perm.id}"
             oninput="_cardNameAutocompleteForChosen('${perm.id}', this.value)"
             onchange="setChosenCardName('${perm.id}', this.value)"
             onkeydown="if(event.key==='Enter'){this.blur();}">
      <div class="chosen-type-autocomplete" id="chosen-name-ac-${perm.id}"></div>
    </div>
  </div>`;
}

let _cardNameSearchTimeout = null;
function _cardNameAutocompleteForChosen(permId, query) {
  const dropdown = document.getElementById('chosen-name-ac-' + permId);
  if (!dropdown) return;
  if (!query || query.length < 2) { dropdown.style.display = 'none'; return; }

  // Debounce Scryfall API calls
  if (_cardNameSearchTimeout) clearTimeout(_cardNameSearchTimeout);
  _cardNameSearchTimeout = setTimeout(async () => {
    try {
      const res = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(query)}&include_extras=false`);
      const data = await res.json();
      const matches = (data.data || []).slice(0, 8);
      if (matches.length === 0) { dropdown.style.display = 'none'; return; }
      dropdown.innerHTML = matches.map(m =>
        `<div class="chosen-type-option" onmousedown="event.preventDefault(); _selectChosenCardName('${permId}', '${escapeAttr(m)}')">${escapeHtml(m)}</div>`
      ).join('');
      dropdown.style.display = 'block';
    } catch (e) {
      dropdown.style.display = 'none';
    }
  }, 250);
}

function _selectChosenCardName(permId, name) {
  const input = document.getElementById('chosen-name-' + permId);
  if (input) input.value = name;
  const dropdown = document.getElementById('chosen-name-ac-' + permId);
  if (dropdown) dropdown.style.display = 'none';
  setChosenCardName(permId, name);
}

function setChosenCardName(permId, name) {
  const trimmed = (name || '').trim();
  Battlefield.setChosenCardName(permId, trimmed || null);
  Battlefield.evaluate();
  renderAll();
}

/* Render a creature type text input for cards with "choose a creature type" */
function renderChosenCreatureTypeInput(perm) {
  const val = perm.chosenCreatureType || '';
  return `<div class="cda-counter-row chosen-type-row" onclick="event.stopPropagation()">
    <span class="cda-label" title="Choose a creature type">Type:</span>
    <div class="chosen-type-wrapper">
      <input type="text" class="chosen-type-input" value="${escapeAttr(val)}"
             placeholder="e.g. Vampire" autocomplete="off"
             title="Choose a creature type"
             id="chosen-type-${perm.id}"
             oninput="_creatureTypeAutocompleteForChosen('${perm.id}', this.value)"
             onchange="setChosenCreatureType('${perm.id}', this.value)"
             onkeydown="if(event.key==='Enter'){this.blur();}">
      <div class="chosen-type-autocomplete" id="chosen-type-ac-${perm.id}"></div>
    </div>
  </div>`;
}

function _creatureTypeAutocompleteForChosen(permId, query) {
  const dropdown = document.getElementById('chosen-type-ac-' + permId);
  if (!dropdown) return;
  if (!query || query.length < 1) { dropdown.style.display = 'none'; return; }
  const q = query.toLowerCase();
  const matches = (TypeCatalog.creatureTypes || []).filter(t => t.toLowerCase().startsWith(q)).slice(0, 8);
  if (matches.length === 0) { dropdown.style.display = 'none'; return; }
  dropdown.innerHTML = matches.map(m =>
    `<div class="chosen-type-option" onmousedown="event.preventDefault(); _selectChosenCreatureType('${permId}', '${escapeAttr(m)}')">${escapeHtml(m)}</div>`
  ).join('');
  dropdown.style.display = 'block';
}

function _selectChosenCreatureType(permId, type) {
  const input = document.getElementById('chosen-type-' + permId);
  if (input) input.value = type;
  const dropdown = document.getElementById('chosen-type-ac-' + permId);
  if (dropdown) dropdown.style.display = 'none';
  setChosenCreatureType(permId, type);
}

function setChosenCreatureType(permId, type) {
  const trimmed = (type || '').trim();
  // Capitalize first letter
  const capitalized = trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : '';
  Battlefield.setChosenCreatureType(permId, capitalized || null);
  Battlefield.evaluate();
  renderAll();
}

/* Render a basic land type dropdown for cards with "choose a basic land type" */
function renderChosenLandTypeInput(perm) {
  const val = perm.chosenLandType || '';
  const types = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  const options = types.map(t =>
    `<option value="${t}" ${val === t ? 'selected' : ''}>${t}</option>`
  ).join('');
  return `<div class="cda-counter-row chosen-color-row" onclick="event.stopPropagation()">
    <span class="cda-label" title="Choose a basic land type">Land type:</span>
    <select class="chosen-color-select" onchange="setChosenLandType('${perm.id}', this.value)">
      <option value="">— pick —</option>
      ${options}
    </select>
  </div>`;
}

function setChosenLandType(permId, type) {
  Battlefield.setChosenLandType(permId, type || null);
  Battlefield.evaluate();
  renderAll();
}

/* Render a color dropdown for cards with "choose a color" */
function renderChosenColorInput(perm) {
  const val = perm.chosenColor || '';
  const colors = ['White', 'Blue', 'Black', 'Red', 'Green'];
  const options = colors.map(c =>
    `<option value="${c}" ${val === c ? 'selected' : ''}>${c}</option>`
  ).join('');
  return `<div class="cda-counter-row chosen-color-row" onclick="event.stopPropagation()">
    <span class="cda-label" title="Choose a color">Color:</span>
    <select class="chosen-color-select" onchange="setChosenColor('${perm.id}', this.value)">
      <option value="">— pick —</option>
      ${options}
    </select>
  </div>`;
}

/* Render a card type dropdown for cards with "choose a card type" (e.g. Serra's Emissary) */
function renderChosenCardTypeInput(perm) {
  const val = perm.chosenCardType || '';
  const types = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Land', 'Planeswalker', 'Sorcery', 'Tribal'];
  const options = types.map(t =>
    `<option value="${t}" ${val === t ? 'selected' : ''}>${t}</option>`
  ).join('');
  return `<div class="cda-counter-row chosen-color-row" onclick="event.stopPropagation()">
    <span class="cda-label" title="Choose a card type">Card type:</span>
    <select class="chosen-color-select" onchange="setChosenCardType('${perm.id}', this.value)">
      <option value="">— pick —</option>
      ${options}
    </select>
  </div>`;
}

function setChosenCardType(permId, type) {
  Battlefield.setChosenCardType(permId, type || null);
  Battlefield.evaluate();
  renderAll();
}

function setChosenColor(permId, color) {
  Battlefield.setChosenColor(permId, color || null);
  Battlefield.evaluate();
  renderAll();
}

