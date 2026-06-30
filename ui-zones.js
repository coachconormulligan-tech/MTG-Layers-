/* [KEY: COMMANDER-UI] */
let _commanderSearchOpen = false;

function renderCommanderPanel() {
  const panel = document.getElementById('commander-panel');
  if (!panel) return;

  let html = '';

  // Show current commanders
  if (Battlefield.commanders.length > 0) {
    html += '<div class="commander-list">';
    Battlefield.commanders.forEach((c, i) => {
      const onBf = c.linkedPermId
        ? Battlefield.permanents.some(p => p.id === c.linkedPermId)
        : Battlefield.permanents.some(p => !p.isManualEffect && p.name === c.name);
      // Detect eminence abilities for commanders in the command zone only
      // (on the battlefield, eminence works as a normal parsed ability)
      let eminenceHtml = '';
      if (!onBf) {
        const face = c.card.card_faces ? c.card.card_faces[0] : c.card;
        const oracleText = face.oracle_text || c.card.oracle_text || '';
        const abilities = extractAbilities(oracleText);
        const eminenceAbilities = [];
        for (let ai = 0; ai < abilities.length; ai++) {
          if (/in the command zone or on the battlefield/i.test(abilities[ai])) {
            eminenceAbilities.push({ index: ai, text: abilities[ai] });
          }
        }
        if (eminenceAbilities.length > 0) {
          const sourceId = 'cmdzone_' + i;
          for (const ea of eminenceAbilities) {
            const strippedText = ea.text.replace(/^[^{\n.;"—\u2014]+[\u2014—]\s*/g, '');
            const triggers = Battlefield.extractTriggeredAbilities([strippedText]);
            const activated = Battlefield.extractActivatedAbilities([strippedText]);
            const tooltipText = escapeAttr(ea.text);
            if (triggers.length > 0) {
              const t = triggers[0];
              const count = Battlefield.getTriggerCount(sourceId, ea.index);
              const atLimit = t.triggerLimit !== null && count >= t.triggerLimit;
              eminenceHtml += `<div class="commander-eminence-row">
                <span class="commander-eminence-badge" data-tooltip="${tooltipText}">Eminence</span>
                <button class="btn btn-sm btn-commander-trigger${atLimit ? ' disabled' : ''}"
                  onclick="fireCommandZoneAbility(${i}, ${ea.index}, 'trigger')"
                  ${atLimit ? 'disabled' : ''}>Trigger</button>
              </div>`;
            } else if (activated.length > 0) {
              const a = activated[0];
              const count = Battlefield.getActivateCount(sourceId, ea.index);
              const atLimit = a.activateLimit !== null && count >= a.activateLimit;
              eminenceHtml += `<div class="commander-eminence-row">
                <span class="commander-eminence-badge" data-tooltip="${tooltipText}">Eminence</span>
                <button class="btn btn-sm btn-commander-trigger${atLimit ? ' disabled' : ''}"
                  onclick="fireCommandZoneAbility(${i}, ${ea.index}, 'activated')"
                  ${atLimit ? 'disabled' : ''}>Activate</button>
              </div>`;
            } else {
              eminenceHtml += `<div class="commander-eminence-row">
                <span class="commander-eminence-badge" data-tooltip="${tooltipText}">Eminence</span>
                <span class="commander-eminence-static">Static</span>
              </div>`;
            }
          }
        }
      }
      html += `<div class="commander-card">
        ${c.imageUri ? `<img src="${c.imageUri}" class="commander-img" alt="${escapeAttr(c.name)}">` : ''}
        <div class="commander-info">
          <span class="commander-name">${escapeHtml(c.name)}</span>
          ${!onBf ? `<button class="btn btn-sm zone-details-btn" onclick="openZoneCardDetails('commander',${i})">Details</button>` : ''}
          <div class="commander-actions">
            ${!onBf ? `<button class="btn btn-sm btn-commander-add" onclick="putCommanderOnBattlefield(${i})" title="Put onto battlefield">⬇ Battlefield</button>` : '<span class="commander-on-bf">On battlefield</span>'}
            <button class="btn btn-sm btn-commander-remove" onclick="removeCommander(${i})" title="Remove">✕</button>
          </div>
          <div class="commander-cast-row">
            <span class="commander-cast-label">Times cast:</span>
            <button class="gs-btn" onclick="modifyCommanderCast(${i}, -1)">−</button>
            <span class="commander-cast-value">${c.castCount || 0}</span>
            <button class="gs-btn" onclick="modifyCommanderCast(${i}, 1)">+</button>
          </div>
          ${eminenceHtml ? `<div class="commander-eminence">${eminenceHtml}</div>` : ''}
        </div>
      </div>`;
    });
    html += '</div>';
  }

  // Set commander button / search
  if (_commanderSearchOpen) {
    html += `<div class="commander-search">
      <input type="text" id="commander-search-input" placeholder="Search commander…" autocomplete="off">
      <div id="commander-search-results"></div>
      <button class="btn btn-sm" onclick="closeCommanderSearch()">Cancel</button>
    </div>`;
  } else {
    html += `<button class="btn btn-sm btn-set-commander" onclick="openCommanderSearch()">+ Set Commander</button>`;
  }

  panel.innerHTML = html;

  // Bind search if open
  if (_commanderSearchOpen) {
    const input = document.getElementById('commander-search-input');
    if (input) {
      let debounce = null;
      input.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => doCommanderSearch(input.value.trim()), 300);
      });
      input.focus();
    }
  }
}

function openCommanderSearch() {
  _commanderSearchOpen = true;
  // The section defaults to collapsed; expand it so the search box is visible.
  document.getElementById('commander-section')?.classList.remove('collapsed');
  renderCommanderPanel();
}

function closeCommanderSearch() {
  _commanderSearchOpen = false;
  renderCommanderPanel();
}

async function doCommanderSearch(query) {
  const resultsDiv = document.getElementById('commander-search-results');
  if (!resultsDiv) return;
  if (query.length < 2) { resultsDiv.innerHTML = ''; return; }

  // Search scryfall for any legal commander. is:commander covers legendary creatures, the
  // "can be your commander" cards, and oddities like Grist, the Hunger Tide — a legendary
  // planeswalker that's a creature while not on the battlefield (so it qualifies as a commander).
  const scryfallQuery = `${query} is:commander`;
  try {
    const cards = await searchScryfall(scryfallQuery);
    _commanderSearchResults = cards || [];
    resultsDiv.innerHTML = _commanderSearchResults.slice(0, 10).map((card, i) => {
      const face = card.card_faces ? card.card_faces[0] : card;
      const name = face.name || card.name;
      const imgUri = face.image_uris?.small || card.image_uris?.small || '';
      return `<div class="commander-search-result" onclick="selectCommander(${i})">
        ${imgUri ? `<img src="${imgUri}" class="commander-result-img">` : ''}
        <span>${escapeHtml(name)}</span>
      </div>`;
    }).join('') || '<div class="dim" style="padding:4px;">No results</div>';
  } catch (e) {
    resultsDiv.innerHTML = '<div class="dim" style="padding:4px;">Search error</div>';
  }
}

let _commanderSearchResults = [];

function selectCommander(index) {
  const card = _commanderSearchResults[index];
  if (!card) return;
  Battlefield.addCommander(card);
  _commanderSearchOpen = false;
  renderCommanderPanel();
}

function putCommanderOnBattlefield(index) {
  const commander = Battlefield.commanders[index];
  if (!commander) return;
  const isToken = commander.card.layout === 'token' || commander.card.layout === 'double_faced_token';
  const perm = Battlefield.addPermanent(commander.card, { isToken });
  commander.linkedPermId = perm.id;
  document.getElementById('card-search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
  Battlefield.evaluate();
  renderAll();
  if (Battlefield.permanents.filter(p => !p.isManualEffect).length === 1) {
    selectPermanent(perm.id);
  }
}

function removeCommander(index) {
  Battlefield.removeCommander(index);
  renderCommanderPanel();
}

function modifyCommanderCast(index, delta) {
  const c = Battlefield.commanders[index];
  if (!c) return;
  c.castCount = Math.max(0, (c.castCount || 0) + delta);
  renderCommanderPanel();
}

/* Fire an eminence ability from a commander in the command zone. */
function fireCommandZoneAbility(commanderIdx, abilityIdx, kind) {
  const commander = Battlefield.commanders[commanderIdx];
  if (!commander) return;
  const face = commander.card.card_faces ? commander.card.card_faces[0] : commander.card;
  const oracleText = face.oracle_text || commander.card.oracle_text || '';
  const abilities = extractAbilities(oracleText);
  const abilityText = abilities[abilityIdx];
  if (!abilityText) return;
  // Strip ability word prefix (e.g. "Eminence — ") so extract functions see "Whenever..."
  const strippedText = abilityText.replace(/^[^{\n.;"—\u2014]+[\u2014—]\s*/g, '');
  const extractFn = kind === 'trigger'
    ? Battlefield.extractTriggeredAbilities
    : Battlefield.extractActivatedAbilities;
  const extracted = extractFn([strippedText]);
  if (extracted.length === 0) return;
  const effectText = extracted[0].effectText;
  const firedAtStates = Battlefield.getAllFinalStates();
  Battlefield.addCommandZoneAbility(commanderIdx, abilityIdx, effectText, abilityText, kind, firedAtStates);
  Battlefield.evaluate();
  renderAll();
}
/* [END: COMMANDER-UI] */

/* [KEY: EMBLEM-UI] */
let _emblemSearchOpen = false;
let _emblemSearchResults = [];

function renderEmblemPanel() {
  const panel = document.getElementById('emblem-panel');
  if (!panel) return;

  let html = '';

  if (Battlefield.emblems.length > 0) {
    html += '<div class="emblem-list">';
    Battlefield.emblems.forEach((e, i) => {
      const previewText = e.card.oracle_text || (e.card.card_faces?.[0]?.oracle_text) || '';
      html += `<div class="emblem-card">
        ${e.imageUri ? `<img src="${e.imageUri}" class="emblem-img" alt="${escapeAttr(e.name)}">` : '<div class="emblem-img-placeholder">EMB</div>'}
        <div class="emblem-info">
          <span class="emblem-name">${escapeHtml(e.name)}</span>
          ${previewText ? `<div class="emblem-oracle">${escapeHtml(previewText).replace(/\n/g, '<br>')}</div>` : ''}
          <div class="emblem-actions">
            <button class="btn btn-sm btn-emblem-remove" onclick="removeEmblemUI(${i})" title="Remove emblem">✕ Remove</button>
          </div>
        </div>
      </div>`;
    });
    html += '</div>';
  }

  if (_emblemSearchOpen) {
    html += `<div class="emblem-search">
      <input type="text" id="emblem-search-input" placeholder="Search emblem by planeswalker name…" autocomplete="off">
      <div id="emblem-search-results"></div>
      <button class="btn btn-sm" onclick="closeEmblemSearch()">Cancel</button>
    </div>`;
  } else {
    html += `<button class="btn btn-sm btn-set-commander" onclick="openEmblemSearch()">+ Add Emblem</button>`;
  }

  panel.innerHTML = html;

  if (_emblemSearchOpen) {
    const input = document.getElementById('emblem-search-input');
    if (input) {
      let debounce = null;
      input.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => doEmblemSearch(input.value.trim()), 300);
      });
      input.focus();
    }
  }
}

function openEmblemSearch() {
  _emblemSearchOpen = true;
  // The section defaults to collapsed; expand it so the search box is visible.
  document.getElementById('emblem-section')?.classList.remove('collapsed');
  renderEmblemPanel();
}

function closeEmblemSearch() {
  _emblemSearchOpen = false;
  renderEmblemPanel();
}

async function doEmblemSearch(query) {
  const resultsDiv = document.getElementById('emblem-search-results');
  if (!resultsDiv) return;
  if (query.length < 2) { resultsDiv.innerHTML = ''; return; }

  const scryfallQuery = `t:emblem ${query}`;
  try {
    const cards = await searchScryfall(scryfallQuery);
    _emblemSearchResults = cards || [];
    resultsDiv.innerHTML = _emblemSearchResults.slice(0, 10).map((card, i) => {
      const imgUri = card.image_uris?.small || '';
      return `<div class="commander-search-result" onclick="selectEmblem(${i})">
        ${imgUri ? `<img src="${imgUri}" class="commander-result-img">` : ''}
        <span>${escapeHtml(card.name)}</span>
      </div>`;
    }).join('') || '<div class="dim" style="padding:4px;">No results</div>';
  } catch (e) {
    resultsDiv.innerHTML = '<div class="dim" style="padding:4px;">Search error</div>';
  }
}

function selectEmblem(index) {
  const card = _emblemSearchResults[index];
  if (!card) return;
  Battlefield.addEmblem(card);
  _emblemSearchOpen = false;
  Battlefield.evaluate();
  renderAll();
}

function removeEmblemUI(index) {
  Battlefield.removeEmblem(index);
  Battlefield.evaluate();
  renderAll();
}
/* [END: EMBLEM-UI] */

/* ===== Graveyard Panel & Modal ===== */

function renderGraveyardPanel() {
  const panel = document.getElementById('graveyard-panel');
  if (!panel) return;

  let html = '';
  for (const player of Battlefield.players) {
    const graveyard = player.graveyard || [];
    const count = graveyard.length;
    const topCard = count > 0 ? graveyard[count - 1] : null;
    const playerLabel = Battlefield.players.length > 1
      ? escapeHtml(player.name) + "'s Graveyard"
      : 'Graveyard';
    html += `<div class="graveyard-row" onclick="openGraveyardModal('${player.id}')">
      <span class="graveyard-label">${playerLabel}</span>
      <span class="graveyard-count">${count}</span>
      ${topCard
        ? `<span class="graveyard-top-name dim">${escapeHtml(topCard.name)}</span>`
        : '<span class="graveyard-empty dim">empty</span>'}
    </div>`;
  }

  panel.innerHTML = html || '<div class="dim" style="font-size:11px;padding:4px 0;">No players</div>';
}

let _graveyardModalPlayerId = null;

function openGraveyardModal(playerId) {
  _graveyardModalPlayerId = playerId;
  const player = Battlefield.getPlayer(playerId);
  if (!player) return;

  const graveyard = player.graveyard || [];
  const playerLabel = Battlefield.players.length > 1
    ? escapeHtml(player.name) + "'s Graveyard"
    : 'Graveyard';

  const overlay = _createModalOverlay('graveyard-modal-overlay', closeGraveyardModal);

  overlay.innerHTML = `
    <div class="modal modal-graveyard">
      <div class="modal-header">
        <h3>${playerLabel}</h3>
        <button class="modal-close" onclick="closeGraveyardModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-section-title">Add a card to the graveyard:</div>
        <div class="modal-search-bar">
          <input type="text" id="graveyard-search-input" placeholder="Search for a card\u2026" autocomplete="off">
        </div>
        <div class="modal-search-results" id="graveyard-search-results"></div>
        <div class="graveyard-divider"></div>
        <div class="modal-section-title">Cards in graveyard <span class="graveyard-modal-count">(${graveyard.length})</span>:</div>
        <div id="graveyard-card-list">${_renderGraveyardList(graveyard, playerId)}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-sm" onclick="closeGraveyardModal()">Close</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const input = document.getElementById('graveyard-search-input');
  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { document.getElementById('graveyard-search-results').innerHTML = ''; return; }
      document.getElementById('graveyard-search-results').innerHTML = '<div class="search-loading">Searching\u2026</div>';
      const cards = await searchScryfall(q);
      _renderGraveyardSearchResults(cards);
    }, 350);
  });
  input.focus();
}

function _renderGraveyardList(graveyard, playerId) {
  if (!graveyard || graveyard.length === 0) {
    return '<div class="graveyard-empty-msg">No cards in graveyard.</div>';
  }
  // Show newest first (top of graveyard = last element in array)
  let html = '<div class="graveyard-list">';
  for (let i = graveyard.length - 1; i >= 0; i--) {
    const card = graveyard[i];
    const isTop = i === graveyard.length - 1;
    const imgUrl = card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || '';
    html += `<div class="graveyard-card-item${isTop ? ' graveyard-top-card' : ''}">
      ${imgUrl
        ? `<img src="${imgUrl}" alt="" onerror="this.style.display='none'" class="graveyard-card-img">`
        : '<div class="graveyard-card-img-placeholder"></div>'}
      <div class="perm-info">
        <div class="perm-name">${escapeHtml(card.name)}${isTop ? ' <span class="graveyard-top-badge">top</span>' : ''}</div>
        <div class="perm-type">${escapeHtml(card.type_line || '')}</div>
        <button class="btn btn-sm zone-details-btn" onclick="openZoneCardDetails('graveyard','${escapeAttr(playerId)}',${i})">Details</button>
      </div>
      <button class="graveyard-remove-btn" onclick="graveyardRemoveCard('${escapeAttr(playerId)}', ${i})" title="Remove">&times;</button>
    </div>`;
  }
  html += '</div>';
  return html;
}

function _renderGraveyardSearchResults(cards) {
  const container = document.getElementById('graveyard-search-results');
  if (!container) return;
  if (!cards || !cards.length) { container.innerHTML = '<div class="search-empty">No results</div>'; return; }
  container.innerHTML = cards.slice(0, 20).map((card, i) => {
    const imgUrl = card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || '';
    return `<div class="modal-perm-item" onclick="graveyardAddCard(${i})">
      ${imgUrl ? `<img src="${imgUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="perm-info">
        <div class="perm-name">${escapeHtml(card.name)}</div>
        <div class="perm-type">${escapeHtml(card.type_line || '')}</div>
      </div>
    </div>`;
  }).join('');
}

function graveyardAddCard(idx) {
  const card = _scryfallLastResults[idx];
  if (!card || !_graveyardModalPlayerId) return;
  Battlefield.addToGraveyard(_graveyardModalPlayerId, card);
  renderAll();
  // Refresh list inside the open modal
  const player = Battlefield.getPlayer(_graveyardModalPlayerId);
  if (player) {
    const listEl = document.getElementById('graveyard-card-list');
    if (listEl) listEl.innerHTML = _renderGraveyardList(player.graveyard || [], _graveyardModalPlayerId);
    const countEl = document.querySelector('.graveyard-modal-count');
    if (countEl) countEl.textContent = `(${(player.graveyard || []).length})`;
  }
  // Clear the search field and results
  const input = document.getElementById('graveyard-search-input');
  if (input) input.value = '';
  const results = document.getElementById('graveyard-search-results');
  if (results) results.innerHTML = '';
}

function graveyardRemoveCard(playerId, index) {
  Battlefield.removeFromGraveyard(playerId, index);
  renderAll();
  // Refresh list inside the open modal
  const player = Battlefield.getPlayer(playerId);
  if (player) {
    const listEl = document.getElementById('graveyard-card-list');
    if (listEl) listEl.innerHTML = _renderGraveyardList(player.graveyard || [], playerId);
    const countEl = document.querySelector('.graveyard-modal-count');
    if (countEl) countEl.textContent = `(${(player.graveyard || []).length})`;
  }
}

function closeGraveyardModal() {
  const overlay = document.getElementById('graveyard-modal-overlay');
  if (overlay) overlay.remove();
  _graveyardModalPlayerId = null;
}

/* ─── Exile Zone ──────────────────────────────────────────────────────────── */
/* [KEY: EXILE-UI] */

function renderExilePanel() {
  const panel = document.getElementById('exile-panel');
  if (!panel) return;
  const count = Battlefield.getExileCount();
  panel.innerHTML = `<div class="exile-row" onclick="openExileModal()">
    <span class="exile-label">Exile</span>
    <span class="exile-count">${count}</span>
    ${count === 0 ? '<span class="exile-empty dim">empty</span>' : ''}
  </div>`;
}

function openExileModal() {
  const overlay = _createModalOverlay('exile-modal-overlay', closeExileModal);
  overlay.innerHTML = `
    <div class="modal modal-exile">
      <div class="modal-header">
        <h3>Exile</h3>
        <button class="modal-close" onclick="closeExileModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-section-title">Add a card to exile:</div>
        <div class="modal-search-bar">
          <input type="text" id="exile-search-input" placeholder="Search for a card…" autocomplete="off">
        </div>
        <div class="modal-search-results" id="exile-search-results"></div>
        <div class="graveyard-divider"></div>
        <div class="modal-section-title">Cards in exile <span class="exile-modal-count">(${Battlefield.exile.length})</span>:</div>
        <div id="exile-card-list">${_renderExileList()}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-sm" onclick="closeExileModal()">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = document.getElementById('exile-search-input');
  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { document.getElementById('exile-search-results').innerHTML = ''; return; }
      document.getElementById('exile-search-results').innerHTML = '<div class="search-loading">Searching…</div>';
      const cards = await searchScryfall(q);
      _renderExileSearchResults(cards);
    }, 350);
  });
  input.focus();
}

function _renderExileList() {
  if (!Battlefield.exile.length) {
    return '<div class="exile-empty-msg">No cards in exile.</div>';
  }
  let html = '<div class="exile-list">';
  // Show newest first
  for (let i = Battlefield.exile.length - 1; i >= 0; i--) {
    const entry = Battlefield.exile[i];
    const card = entry.card;
    const imgUrl = !entry.isFaceDown ? (card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || '') : '';
    const displayName = entry.isFaceDown ? 'Face-down card' : escapeHtml(card.name || '');
    const typeLine = entry.isFaceDown ? '' : escapeHtml(card.type_line || '');

    // Owner dropdown
    const ownerOpts = Battlefield.players.map(p =>
      `<option value="${escapeAttr(p.id)}"${entry.owner === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`
    ).join('');
    const ownerSelect = Battlefield.players.length > 1
      ? `<label class="exile-with-label">Owner:</label><select class="exile-owner-select" title="Owner" onchange="exileSetOwner('${escapeAttr(entry.id)}', this.value)">${ownerOpts}</select>`
      : '';

    // "Exiled with" dropdown
    const noneOpt = `<option value=""${!entry.exiledWithId ? ' selected' : ''}>(none)</option>`;
    const permOpts = Battlefield.permanents
      .filter(p => !p.isManualEffect || p.targetId)
      .map(p => {
        const pLabel = p.label ? ` [${p.label}]` : '';
        return `<option value="${escapeAttr(p.id)}"${entry.exiledWithId === p.id ? ' selected' : ''}>${escapeHtml(p.name)}${pLabel}</option>`;
      }).join('');
    const tagSelect = `<label class="exile-with-label">Exiled with:</label><select class="exile-tag-select" title="Exiled with" onchange="exileSetTag('${escapeAttr(entry.id)}', this.value)">${noneOpt}${permOpts}</select>`;

    // Counter pills
    const counterPills = Object.entries(entry.counters || {}).map(([type, n]) =>
      `<span class="exile-counter-pill" title="${n}x ${escapeHtml(type)}">${escapeHtml(type)} ×${n}
        <button class="exile-counter-minus" onclick="exileRemoveCounter('${escapeAttr(entry.id)}','${escapeAttr(type)}',1)" title="Remove 1">−</button>
      </span>`
    ).join('');

    // Counter dropdown — oracle types from this card + all battlefield permanents + global presets, deduplicated
    const _cardTypes = (typeof parseTypeLine === 'function') ? parseTypeLine(card.type_line || '') : { subtypes: [], types: [] };
    const _oracleCtrTypes = (typeof _extractOracleCounterTypes === 'function')
      ? _extractOracleCounterTypes(card.oracle_text || '', _cardTypes.subtypes, _cardTypes.types) : [];
    const _allOracleCtrSet = new Set(_oracleCtrTypes);
    for (const _bp of Battlefield.permanents) {
      if (_bp.oracleCounterTypes) {
        for (const _t of _bp.oracleCounterTypes) _allOracleCtrSet.add(_t);
      }
    }
    const _seenCtr = _allOracleCtrSet;
    const _oracleCtrTypesFull = [..._allOracleCtrSet];
    const _allCtrOpts = [
      ..._oracleCtrTypesFull.map(t => `<option value="${escapeAttr(t)}">${escapeHtml(t.charAt(0).toUpperCase() + t.slice(1))}</option>`),
      ...COUNTER_PRESETS.filter(p => !_seenCtr.has(p.type)).map(p => `<option value="${escapeAttr(p.type)}">${escapeHtml(p.label)}</option>`),
    ].join('');
    const addCounterRow = `<div class="exile-add-counter-row">
      <select id="exile-counter-select-${escapeAttr(entry.id)}" class="exile-counter-select">${_allCtrOpts}</select>
      <button class="exile-add-counter-btn" onclick="exileAddCounterFromSelect('${escapeAttr(entry.id)}')">Add</button>
    </div>`;

    // Face-down toggle
    const faceDownBtn = `<button class="exile-facedown-btn${entry.isFaceDown ? ' active' : ''}" onclick="exileToggleFaceDown('${escapeAttr(entry.id)}')" title="${entry.isFaceDown ? 'Turn face up' : 'Turn face down'}">${entry.isFaceDown ? 'Face up' : 'Face down'}</button>`;

    html += `<div class="exile-card-item" id="exile-item-${escapeAttr(entry.id)}">
      <div class="exile-card-img-wrap">
        ${imgUrl
          ? `<img src="${imgUrl}" alt="" onerror="this.style.display='none'" class="exile-card-img">`
          : `<div class="exile-card-img-placeholder">${entry.isFaceDown ? '?' : ''}</div>`}
      </div>
      <div class="exile-card-info">
        <div class="perm-name">${displayName}${Battlefield.players.length > 1 ? (() => { const op = Battlefield.players.find(p => p.id === entry.owner); return op ? ` <span class="exile-owner-tag">${escapeHtml(op.name)}</span>` : ''; })() : ''}</div>
        ${typeLine ? `<div class="perm-type">${typeLine}</div>` : ''}
        ${!entry.isFaceDown ? `<button class="btn btn-sm zone-details-btn" onclick="openZoneCardDetails('exile','${escapeAttr(entry.id)}')">Details</button>` : ''}
        <div class="exile-card-controls">
          ${ownerSelect}
          ${tagSelect}
          ${faceDownBtn}
        </div>
        <div class="exile-counters-row">
          ${counterPills}
        </div>
        ${addCounterRow}
      </div>
      <button class="exile-remove-btn" onclick="exileRemoveEntry('${escapeAttr(entry.id)}')" title="Remove">&times;</button>
    </div>`;
  }
  html += '</div>';
  return html;
}

function _renderExileSearchResults(cards) {
  const container = document.getElementById('exile-search-results');
  if (!container) return;
  if (!cards || !cards.length) { container.innerHTML = '<div class="search-empty">No results</div>'; return; }
  container.innerHTML = cards.slice(0, 20).map((card, i) => {
    const imgUrl = card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || '';
    return `<div class="modal-perm-item" onclick="exileAddCard(${i})">
      ${imgUrl ? `<img src="${imgUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="perm-info">
        <div class="perm-name">${escapeHtml(card.name)}</div>
        <div class="perm-type">${escapeHtml(card.type_line || '')}</div>
      </div>
    </div>`;
  }).join('');
}

function _refreshExileModal() {
  const listEl = document.getElementById('exile-card-list');
  if (listEl) listEl.innerHTML = _renderExileList();
  const countEl = document.querySelector('.exile-modal-count');
  if (countEl) countEl.textContent = `(${Battlefield.exile.length})`;
}

function exileAddCard(idx) {
  const card = _scryfallLastResults[idx];
  if (!card) return;
  Battlefield.addToExile(card, { owner: Battlefield.activePlayerId });
  renderAll();
  _refreshExileModal();
  const input = document.getElementById('exile-search-input');
  if (input) input.value = '';
  const results = document.getElementById('exile-search-results');
  if (results) results.innerHTML = '';
}

function exileRemoveEntry(entryId) {
  Battlefield.removeFromExile(entryId);
  renderAll();
  _refreshExileModal();
}

function exileSetTag(entryId, permanentId) {
  Battlefield.setExileTag(entryId, permanentId || null);
  renderAll();
  _refreshExileModal();
}

function exileSetOwner(entryId, playerId) {
  Battlefield.setExileOwner(entryId, playerId);
  renderAll();
  _refreshExileModal();
}

function exileToggleFaceDown(entryId) {
  const entry = Battlefield.exile.find(e => e.id === entryId);
  if (!entry) return;
  Battlefield.setExileFaceDown(entryId, !entry.isFaceDown);
  renderAll();
  _refreshExileModal();
}

function exileAddCounter(entryId, type, n) {
  Battlefield.addExileCounter(entryId, type, n);
  renderAll();
  _refreshExileModal();
}

function exileRemoveCounter(entryId, type, n) {
  Battlefield.removeExileCounter(entryId, type, n);
  renderAll();
  _refreshExileModal();
}

function exileAddCounterFromSelect(entryId) {
  const sel = document.getElementById('exile-counter-select-' + entryId);
  if (!sel || !sel.value) return;
  Battlefield.addExileCounter(entryId, sel.value, 1);
  renderAll();
  _refreshExileModal();
}

function closeExileModal() {
  const overlay = document.getElementById('exile-modal-overlay');
  if (overlay) overlay.remove();
}
/* [END: EXILE-UI] */

/* ---- Zone-card details popup ----
   Cards in exile / graveyard / the command zone aren't part of Battlefield.permanents, so
   getAllFinalStates() never evaluates them. This runs the real CR 613 engine on a throwaway
   permanent built from the raw card data — evaluated alongside the live battlefield perms so
   board effects flagged for non-battlefield zones (e.g. Mycosynth Lattice's colorless clause)
   reach it — then renders the full layer-inspector breakdown for an identical look. */
let _zoneDetailsCard = null;

/* Run the layer engine on a single zone card. The throwaway perm is flagged isZoneCard so
   effectAppliesToPerm only feeds it non-battlefield-zone effects; it contributes no effects
   of its own and isn't registered in Battlefield, so battlefield perms evaluate unchanged. */
function evaluateZoneCard(card, zone) {
  // Delegate to the engine-level helper so the Details popup and other-card checks (Volrath's
  // Shapeshifter reading the graveyard top) share one evaluation path.
  return computeZoneCardState(card, zone);
}

function openZoneCardDetails(zone, idA, idB) {
  let card = null;
  if (zone === 'graveyard') {
    const player = Battlefield.getPlayer(idA);
    card = player && player.graveyard ? player.graveyard[idB] : null;
  } else if (zone === 'exile') {
    const entry = Battlefield.exile.find(e => e.id === idA);
    card = entry ? entry.card : null;
  } else if (zone === 'commander') {
    const c = Battlefield.commanders[idA];
    card = c ? c.card : null;
  }
  if (!card) return;
  _zoneDetailsCard = { card, zone };
  _renderZoneDetailsModal();
}

function _renderZoneDetailsModal() {
  if (!_zoneDetailsCard) return;
  const { card, zone } = _zoneDetailsCard;
  const result = evaluateZoneCard(card, zone);
  const isRulesMode = Battlefield.explanationMode === 'rules';
  const name = result.base.name;
  const illustrator = card.artist || (card.card_faces && card.card_faces[0] && card.card_faces[0].artist) || '';
  const imageUri = card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || '';

  let body = `
    <div class="insp-header">
      <div class="insp-title-block">
        <h2 class="insp-title">${escapeHtml(name)}</h2>
        ${illustrator ? `<div class="insp-illustrator">Illus. ${escapeHtml(illustrator)}</div>` : ''}
      </div>
      ${imageUri ? `<img src="${escapeAttr(imageUri)}" class="insp-thumb" alt="">` : ''}
    </div>
    <div class="insp-section insp-final">
      <div class="insp-section-head insp-section-head-row">
        <h3>Final Computed State</h3>
        <span class="insp-head-actions"><button class="insp-highlight-toggle${_highlightChanges ? ' active' : ''}" onclick="event.stopPropagation(); toggleZoneDetailsHighlight()" title="Highlight everything that differs from the printed Base State">Highlight changes</button></span>
      </div>
      <div class="insp-section-body">
        ${renderStateBlock(result.final, isRulesMode, name, result.base, true)}
        ${result.final.types.includes('Creature') ? `<div class="insp-final-pt">${_finalPtHtml(result.final, result.base)}</div>` : ''}
      </div>
    </div>`;

  for (const layer of [...result.layers].reverse()) {
    const hasChanges = layer.applicationLog.some(a => a.changes.length > 0);
    const statusClass = !layer.active ? 'layer-inactive' : hasChanges ? 'layer-changed' : 'layer-unchanged';
    body += `<div class="insp-section ${statusClass} collapsed">
      <div class="insp-section-head" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="insp-section-arrow">▼</span>
        <h3>
          <span class="layer-badge">${layer.id}</span>
          ${escapeHtml(layer.name)}
          ${!layer.active ? '<span class="layer-tag inactive">inactive</span>' : ''}
          ${hasChanges ? '<span class="layer-tag changed">modified</span>' : ''}
        </h3>
        <span class="layer-cr">${layer.cr}</span>
      </div>
      <div class="insp-section-body">
        ${renderLayerBody(layer, isRulesMode, result.base.name, result.base)}
      </div>
    </div>`;
  }

  body += `<div class="insp-section collapsed">
    <div class="insp-section-head" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="insp-section-arrow">▼</span>
      <h3>Base State (Printed Characteristics)</h3>
    </div>
    <div class="insp-section-body">
      ${renderStateBlock(result.base, isRulesMode, result.base.name)}
    </div>
  </div>`;

  let overlay = document.getElementById('zone-details-overlay');
  if (!overlay) {
    overlay = _createModalOverlay('zone-details-overlay', closeZoneDetailsModal);
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="modal modal-zone-details">
    <div class="modal-header"><h3>Card Details</h3><button class="modal-close" onclick="closeZoneDetailsModal()">&times;</button></div>
    <div class="modal-body">${body}</div>
  </div>`;
}

function toggleZoneDetailsHighlight() {
  _highlightChanges = !_highlightChanges;
  _renderZoneDetailsModal();
}

function closeZoneDetailsModal() {
  const overlay = document.getElementById('zone-details-overlay');
  if (overlay) overlay.remove();
}


