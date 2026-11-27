/* ui-modal-sticker.js — Stickers pop-up (CR 123, Unfinity): list, remove and add the stickers on a card.
   No game logic: Battlefield.addSticker / removeSticker and engine-stickers.js do the work. */

/* [KEY: MODAL-STICKER] */
let _stickerSheets = null;        // Scryfall sticker sheets, fetched once: [{ name, stickers: [{ kind, text, cost, label }] }]
let _stickerSheetsFailed = false;
let _stickerSheetsLoading = false;
let _stkPermId = null;
let _stkDraft = null;

function _stkFreshDraft(kind) {
  return { kind: kind || 'name', text: '', where: 0, cost: 0, power: 1, toughness: 1, pay: true, sheet: '', sheetPick: '' };
}

function _stkParseSheet(card) {
  const name = card.name || '';
  const stickers = [];
  const lines = String(card.oracle_text || '').split('\n');
  for (const line of lines) {
    const m = line.match(/^((?:\{TK\})+)\s*[—-]\s*(.+)$/);
    if (!m) continue;
    const cost = (m[1].match(/\{TK\}/g) || []).length;
    const body = m[2].trim();
    const pt = body.match(/^(\d+)\/(\d+)$/);
    if (pt) {
      stickers.push({ kind: 'pt', cost, power: +pt[1], toughness: +pt[2], label: `${pt[1]}/${pt[2]}` });
    } else {
      const text = _stripReminderText(body);
      if (text) stickers.push({ kind: 'ability', cost, text, label: text });
    }
  }
  const words = name.split(/\s+/).filter(Boolean);
  for (const w of words) stickers.push({ kind: 'name', cost: 0, text: w, label: w });
  stickers.push({ kind: 'art', cost: 0, text: name, label: name });
  return { name, stickers };
}

async function _stkLoadSheets() {
  if (_stickerSheets || _stickerSheetsLoading) return;
  _stickerSheetsLoading = true;
  try {
    const res = await fetch('https://api.scryfall.com/cards/search?q=t%3Astickers+set%3Asunf&unique=cards&order=name');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _stickerSheets = (data.data || []).map(_stkParseSheet).filter(s => s.name);
    if (!_stickerSheets.length) throw new Error('No sheets');
  } catch (e) {
    _stickerSheetsFailed = true;
  }
  _stickerSheetsLoading = false;
  if (document.getElementById('sticker-modal-overlay')) _stkRender();
}

function openStickerModal(permId) {
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;
  closeStickerModal();
  _stkPermId = permId;
  _stkDraft = _stkFreshDraft('name');
  const overlay = _createModalOverlay('sticker-modal-overlay', closeStickerModal);
  document.body.appendChild(overlay);
  _stkRender();
  if (!_stickerSheets && !_stickerSheetsFailed) _stkLoadSheets();
}

function closeStickerModal() {
  const overlay = document.getElementById('sticker-modal-overlay');
  if (overlay) overlay.remove();
  _stkPermId = null;
  _stkDraft = null;
}

function _stkCurrentName() {
  const fs = Battlefield.getAllFinalStates().get(_stkPermId);
  const perm = Battlefield.getPermById(_stkPermId);
  return (fs && fs.name) || (perm && perm.name) || '';
}

function _stkWhereOptionsHtml() {
  const name = _stkCurrentName();
  const n = nameStickerWords(name).length;
  const word = (_stkDraft.text || '').trim();
  let html = '';
  for (let k = 0; k <= n; k++) {
    const label = addNameStickerWord(name, word || '\u2026', k);
    html += `<option value="${k}"${_stkDraft.where === k ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }
  return html;
}

function _stkRender() {
  const overlay = document.getElementById('sticker-modal-overlay');
  const perm = Battlefield.getPermById(_stkPermId);
  if (!overlay || !perm) { closeStickerModal(); return; }
  // (It fades in as it opens, not again on every change.)
  if (overlay.firstChild) overlay.classList.add('stk-shown');
  const d = _stkDraft;
  const owner = Battlefield.getPlayer(perm.owner || 'player_0');
  const tickets = (owner && owner.gameState && owner.gameState.ticketCounters) || 0;
  const ownerName = owner ? owner.name : 'Player 1';

  const stickers = perm.stickers || [];
  const listHtml = stickers.length
    ? stickers.map(s => {
        const bits = [];
        if (s.ticketCost) bits.push(`${s.ticketCost} ticket${s.ticketCost === 1 ? '' : 's'}`);
        if (s.paid) bits.push(`paid ${s.paid}`);
        if (s.sheet) bits.push(s.sheet);
        return `<div class="sticker-row">
          <span class="sticker-row-label">${escapeHtml(stickerLabel(s))}</span>
          <span class="dim sticker-row-meta">${escapeHtml(bits.join(', '))}</span>
          <button class="btn btn-sm" data-sid="${escapeAttr(s.id)}" onclick="_stkRemove(this.dataset.sid)">Remove</button>
        </div>`;
      }).join('')
    : '<div class="dim" style="padding:4px 0">No stickers on this card.</div>';

  const kinds = [['name', 'Name'], ['ability', 'Ability'], ['pt', 'Power and toughness'], ['art', 'Art']];
  const tabs = kinds.map(([k, l]) =>
    `<button class="btn btn-sm${d.kind === k ? ' btn-accent' : ''}" data-kind="${k}" onclick="_stkSetKind(this.dataset.kind)">${l}</button>`).join('');

  let form = '';
  if (d.kind === 'name') {
    form = `<label class="sticker-field">Word or words
        <input type="text" id="stk-text" value="${escapeAttr(d.text)}" oninput="_stkInput('text', this.value)"></label>
      <label class="sticker-field">Where
        <select id="stk-where" onchange="_stkInput('where', this.value)">${_stkWhereOptionsHtml()}</select></label>`;
  } else if (d.kind === 'ability') {
    form = `<label class="sticker-field">Ability text
        <textarea id="stk-text" rows="3" oninput="_stkInput('text', this.value)">${escapeHtml(d.text)}</textarea></label>`;
  } else if (d.kind === 'pt') {
    form = `<div class="sticker-field sticker-pt">
        <label>Power <input type="number" value="${escapeAttr(String(d.power))}" oninput="_stkInput('power', this.value)"></label>
        <label>Toughness <input type="number" value="${escapeAttr(String(d.toughness))}" oninput="_stkInput('toughness', this.value)"></label>
      </div>`;
  } else {
    form = `<label class="sticker-field">Label (optional)
        <input type="text" id="stk-text" value="${escapeAttr(d.text)}" oninput="_stkInput('text', this.value)"></label>`;
  }
  if (d.kind === 'ability' || d.kind === 'pt') {
    form += `<div class="sticker-field sticker-pt">
        <label>Ticket cost <input type="number" min="0" value="${escapeAttr(String(d.cost))}" oninput="_stkInput('cost', this.value)"></label>
        <label><input type="checkbox"${d.pay ? ' checked' : ''} onchange="_stkInput('pay', this.checked)"> Pay the ticket cost</label>
      </div>`;
  }

  let sheetHtml;
  if (_stickerSheets) {
    const sel = _stickerSheets.find(s => s.name === d.sheetPick);
    const opts = ['<option value="">Choose a sticker sheet</option>']
      .concat(_stickerSheets.map(s => `<option value="${escapeAttr(s.name)}"${s.name === d.sheetPick ? ' selected' : ''}>${escapeHtml(s.name)}</option>`)).join('');
    let btns = '';
    if (sel) {
      btns = `<div class="sticker-sheet-buttons">${sel.stickers.map((st, i) => {
        const k = st.kind === 'pt' ? 'Power and toughness' : st.kind === 'ability' ? 'Ability' : st.kind === 'name' ? 'Name' : 'Art';
        const cost = st.cost ? `, ${st.cost} ticket${st.cost === 1 ? '' : 's'}` : '';
        return `<button class="btn btn-sm" data-i="${i}" onclick="_stkPickSheetSticker(this.dataset.i)" title="${escapeAttr(k + cost)}">${escapeHtml(k + ': ' + st.label + cost)}</button>`;
      }).join('')}</div>
      <div class="dim" style="font-size:0.85em">A name sticker of two words, such as Hot Dog, can be typed in the Name field.</div>`;
    }
    sheetHtml = `<select class="sticker-sheet-select" onchange="_stkChooseSheet(this.value)">${opts}</select>${btns}`;
  } else if (_stickerSheetsFailed) {
    sheetHtml = '<div class="dim">Sticker sheets could not be loaded; type a sticker in instead.</div>';
  } else {
    sheetHtml = '<div class="dim">Loading sticker sheets.</div>';
  }

  overlay.innerHTML = _modalShell({
    title: `Stickers - ${escapeHtml(_stkCurrentName())}`,
    closeFn: 'closeStickerModal',
    body: `
      <p class="dim" style="margin-bottom:10px;font-size:0.85em">Stickers are put on by the card's owner, ${escapeHtml(ownerName)}, who has ${tickets} ticket${tickets === 1 ? '' : 's'}.</p>
      <div class="modal-section-title">Current stickers</div>
      ${listHtml}
      <div class="modal-section-title" style="margin-top:12px">From a sticker sheet</div>
      ${sheetHtml}
      <div class="modal-section-title" style="margin-top:12px">Add a sticker</div>
      <div class="sticker-tabs">${tabs}</div>
      ${form}`,
    footer: `
      <button class="btn btn-sm" onclick="closeStickerModal()">Close</button>
      <button class="btn-accent" onclick="_stkAdd()">Add</button>`,
  });
}

function _stkSetKind(kind) {
  _stkDraft.kind = kind;
  _stkRender();
}

function _stkInput(field, value) {
  const d = _stkDraft;
  if (field === 'text') {
    d.text = value;
    if (d.kind === 'name') {
      const sel = document.getElementById('stk-where');
      if (sel) sel.innerHTML = _stkWhereOptionsHtml();
    }
  } else if (field === 'where') d.where = parseInt(value, 10) || 0;
  else if (field === 'pay') d.pay = !!value;
  else d[field] = parseInt(value, 10) || 0;
}

function _stkChooseSheet(name) {
  _stkDraft.sheetPick = name;
  _stkRender();
}

function _stkPickSheetSticker(i) {
  const sheet = (_stickerSheets || []).find(s => s.name === _stkDraft.sheetPick);
  const st = sheet && sheet.stickers[parseInt(i, 10)];
  if (!st) return;
  const d = _stkDraft;
  d.kind = st.kind;
  d.sheet = sheet.name;
  d.cost = st.cost || 0;
  d.text = st.kind === 'pt' ? '' : (st.text || '');
  if (st.kind === 'pt') { d.power = st.power; d.toughness = st.toughness; }
  d.where = 0;
  _stkRender();
}

function _stkAdd() {
  const d = _stkDraft;
  const perm = Battlefield.getPermById(_stkPermId);
  if (!perm) return;
  const text = (d.text || '').trim();
  if ((d.kind === 'name' || d.kind === 'ability') && !text) return;
  const spec = { kind: d.kind, text };
  if (d.sheet) spec.sheet = d.sheet;
  if (d.kind === 'name') spec.afterWords = d.where;
  if (d.kind === 'ability' || d.kind === 'pt') spec.ticketCost = Math.max(0, d.cost || 0);
  if (d.kind === 'pt') { spec.power = d.power; spec.toughness = d.toughness; }
  Battlefield.addSticker(_stkPermId, spec, { pay: (d.kind === 'ability' || d.kind === 'pt') && d.pay });
  const keep = d.sheetPick;
  _stkDraft = _stkFreshDraft(d.kind);
  _stkDraft.sheetPick = keep;
  renderAll();
  _stkRender();
}

function _stkRemove(stickerId) {
  Battlefield.removeSticker(_stkPermId, stickerId);
  renderAll();
  _stkRender();
}
/* [END: MODAL-STICKER] */
