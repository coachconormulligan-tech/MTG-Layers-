/* Returns true if permId is a non-token copy card (has COPY effect and is not a token).
   Copy tokens should show bestow/mutate buttons; copy cards should not. */
function _isNonTokenCopyCard(perm) {
  if (!perm || perm.isToken) return false;
  // Imprint-driven copies (Dermotaxi) don't count: the imprint button still belongs on
  // the source so the user can change what's exiled with it.
  return Battlefield.effects.some(e =>
    e.sourceId === perm.id &&
    e.type === EFFECT_TYPE.COPY &&
    !(e.params && (e.params.copyFromExiledCard || e.params.copiesAbilitySource || e.params.massCopy))
  );
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

/* Toggle for a spell's optional additional cost ("Kicked", "Bargained", "Mayhem cost paid").
   A spell with two cast conditions (Cankerous Thirst: "{B} spent", "{G} spent") gets two. */
function renderAdditionalCostToggle(perm) {
  const button = (slot) => {
    const suffix = slot > 1 ? String(slot) : '';
    const paid = !!perm['additionalCostPaid' + suffix];
    return `<button class="ts-action-btn configure mutate-btn${paid ? ' mutate-active' : ''}"
            onclick="event.stopPropagation(); toggleAdditionalCostPaid('${perm.id}', ${slot})"
            title="Whether this was true when the spell or ability resolved">${escapeHtml(perm['additionalCostLabel' + suffix])}: ${paid ? 'Yes' : 'No'}</button>`;
  };
  return `<div class="cda-counter-row" onclick="event.stopPropagation()">
    ${[1, 2, 3, 4, 5, 6].filter(n => perm['additionalCostLabel' + (n > 1 ? n : '')]).map(button).join('')}
  </div>`;
}

function toggleAdditionalCostPaid(permId, slot = 1) {
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;
  Battlefield.setAdditionalCostPaid(permId, !perm['additionalCostPaid' + (slot > 1 ? slot : '')], slot);
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

/* Render a card name text input for cards with "choose a creature card name" (or, Alpine Moon,
   "a nonbasic land card name") */
function renderChosenCardNameInput(perm) {
  const val = perm.chosenCardName || '';
  return `<div class="cda-counter-row chosen-type-row" onclick="event.stopPropagation()">
    <span class="cda-label" title="Choose a card name">Name:</span>
    <div class="chosen-type-wrapper">
      <input type="text" class="chosen-type-input" value="${escapeAttr(val)}"
             placeholder="e.g. Grizzly Bears" autocomplete="off"
             title="Choose a card name"
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
  const basics = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  // "Choose a nonbasic land type" (March from Velis Vel): every land type but the five basics.
  const nonbasic = /\bchoose a nonbasic land type\b/i.test(perm.originalOracleText || '');
  // "Choose a land type" (Barbarian Guides): the basics first, then every other land type.
  const anyType = /\bchoose a land type\b/i.test(perm.originalOracleText || '');
  const others = (nonbasic || anyType)
    ? [...((typeof TypeCatalog !== 'undefined' && TypeCatalog.landTypes) || [])].filter(t => !basics.includes(t)).sort()
    : [];
  const types = nonbasic ? others : [...basics, ...others];
  const options = types.map(t =>
    `<option value="${t}" ${val === t ? 'selected' : ''}>${t}</option>`
  ).join('');
  return `<div class="cda-counter-row chosen-color-row" onclick="event.stopPropagation()">
    <span class="cda-label" title="Choose a ${nonbasic ? 'nonbasic ' : anyType ? '' : 'basic '}land type">Land type:</span>
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

/* Render a dropdown for "choose two abilities from among …" (Greymond, Avacyn's Stalwart):
   every way of choosing that many of the listed abilities. */
function renderChosenAbilitiesInput(perm) {
  const val = perm.chosenAbilities || '';
  const picks = [];
  const walk = (start, taken) => {
    if (taken.length === (perm.abilityChoiceCount || 2)) { picks.push(taken); return; }
    for (let i = start; i < (perm.abilityChoices || []).length; i++) walk(i + 1, [...taken, perm.abilityChoices[i]]);
  };
  walk(0, []);
  const options = picks.map(p => {
    const text = p.length > 2 ? p.slice(0, -1).join(', ') + ', and ' + p[p.length - 1] : p.join(' and ');
    return `<option value="${escapeAttr(text)}" ${val === text ? 'selected' : ''}>${escapeHtml(text.charAt(0).toUpperCase() + text.slice(1))}</option>`;
  }).join('');
  return `<div class="cda-counter-row chosen-color-row" onclick="event.stopPropagation()">
    <span class="cda-label" title="Choose abilities">Abilities:</span>
    <select class="chosen-color-select" onchange="setChosenAbilities('${perm.id}', this.value)">
      <option value="">— pick —</option>
      ${options}
    </select>
  </div>`;
}

function setChosenAbilities(permId, abilities) {
  Battlefield.setChosenAbilities(permId, abilities || null);
  Battlefield.evaluate();
  renderAll();
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

