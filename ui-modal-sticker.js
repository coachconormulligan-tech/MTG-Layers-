/* ui-modal-sticker.js — Stickers pop-up (CR 123, Unfinity): the stickers on a card, and placing
   one from a sticker sheet. Only real sheets' stickers are offered and ticket costs are not
   modelled (Conor, 2026-11-26: "just focus on stickers being placed").
   No game logic: Battlefield.addSticker / removeSticker and engine-stickers.js do the work. */

/* [KEY: MODAL-STICKER] */
let _stickerSheets = null;        // the 48 Unfinity sheets from Scryfall, fetched once: [{ name, stickers }]
let _stickerSheetsFailed = false;
let _stickerSheetsLoading = false;
let _stkTarget = null;            // a permanent's id, or a zone card: { zone: 'graveyard', playerId, index } / { zone: 'exile', id }
let _stkSheet = '';               // the sheet chosen in the pop-up
let _stkPendingName = null;       // a name sticker waiting for its place: { text, where }

/* A sheet's stickers from its Scryfall card: lines "{TK}{TK} — <ability>" and "{TK}{TK}{TK} — 4/4",
   three name stickers in its name, and one art sticker. A name sticker may be two words ("Ancestral
   Hot Dog Minotaur"): the first and last words are stickers and the words between are one. */
function _stkParseSheet(card) {
  const name = card.name || '';
  const stickers = [];
  for (const line of String(card.oracle_text || '').split('\n')) {
    const m = line.match(/^(?:\{TK\})+\s*[—-]\s*(.+)$/);
    if (!m) continue;
    const body = m[1].trim();
    const pt = body.match(/^(\d+)\/(\d+)$/);
    if (pt) stickers.push({ kind: 'pt', power: +pt[1], toughness: +pt[2], label: `${pt[1]}/${pt[2]}` });
    else {
      const text = _stripReminderText(body).trim();
      if (text) stickers.push({ kind: 'ability', text, label: text });
    }
  }
  const words = name.split(/\s+/).filter(Boolean);
  const names = words.length > 3 ? [words[0], words.slice(1, -1).join(' '), words[words.length - 1]] : words;
  for (const w of names) stickers.push({ kind: 'name', text: w, label: w });
  stickers.push({ kind: 'art', text: name, label: name });
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

/* A card in a graveyard or in exile keeps its stickers (CR 123.5): the Stickers button on its row. */
function openZoneStickerModal(zone, a, b) {
  openStickerModal(zone === 'graveyard' ? { zone, playerId: a, index: b } : { zone, id: a });
}

function openStickerModal(target) {
  if (!Battlefield._stickerHolder(target)) return;
  closeStickerModal();
  _stkTarget = target;
  _stkPendingName = null;
  document.body.appendChild(_createModalOverlay('sticker-modal-overlay', closeStickerModal));
  _stkRender();
  if (!_stickerSheets && !_stickerSheetsFailed) _stkLoadSheets();
}

function closeStickerModal() {
  const overlay = document.getElementById('sticker-modal-overlay');
  if (overlay) overlay.remove();
  _stkTarget = null;
  _stkPendingName = null;
}

/* The card's name as it is now (a zone card's as its zone evaluation has it). */
function _stkCurrentName() {
  const h = Battlefield._stickerHolder(_stkTarget);
  if (!h) return '';
  if (h.zone) {
    const r = computeZoneCardState(h.obj, h.zone, h.owner);
    return (r && r.final && r.final.name) || h.obj.name || '';
  }
  const fs = Battlefield.getAllFinalStates().get(_stkTarget);
  return (fs && fs.name) || h.obj.name || '';
}

function _stkRender() {
  const overlay = document.getElementById('sticker-modal-overlay');
  const h = Battlefield._stickerHolder(_stkTarget);
  if (!overlay || !h) { closeStickerModal(); return; }
  // (It fades in as it opens, not again on every change.)
  if (overlay.firstChild) overlay.classList.add('stk-shown');

  const stickers = h.obj.stickers || [];
  const listHtml = stickers.length
    ? stickers.map(s => `<div class="sticker-row">
          <span class="sticker-row-label">${escapeHtml(stickerLabel(s))}</span>
          ${s.sheet ? `<span class="dim sticker-row-meta">${escapeHtml(s.sheet)}</span>` : ''}
          <button class="btn btn-sm" data-sid="${escapeAttr(s.id)}" onclick="_stkRemove(this.dataset.sid)">Remove</button>
        </div>`).join('')
    : '<div class="dim" style="padding:4px 0">No stickers on this card.</div>';

  let sheetHtml;
  if (_stickerSheets) {
    const opts = ['<option value="">Choose a sticker sheet</option>']
      .concat(_stickerSheets.map(s => `<option value="${escapeAttr(s.name)}"${s.name === _stkSheet ? ' selected' : ''}>${escapeHtml(s.name)}</option>`)).join('');
    sheetHtml = `<select class="sticker-sheet-select" onchange="_stkChooseSheet(this.value)">${opts}</select>`;
    const sheet = _stickerSheets.find(s => s.name === _stkSheet);
    if (sheet) {
      const groups = [['name', 'Name stickers'], ['ability', 'Ability stickers'], ['pt', 'Power and toughness stickers'], ['art', 'Art sticker']];
      for (const [kind, title] of groups) {
        const btns = sheet.stickers.map((st, i) => st.kind !== kind ? '' :
          `<button class="btn btn-sm${_stkPendingName && kind === 'name' && _stkPendingName.text === st.text ? ' btn-accent' : ''}" data-i="${i}" onclick="_stkPlace(this.dataset.i)">${escapeHtml(st.label)}</button>`).join('');
        sheetHtml += `<div class="sticker-group-title">${title}</div><div class="sticker-sheet-buttons">${btns}</div>`;
      }
    }
  } else if (_stickerSheetsFailed) {
    sheetHtml = '<div class="dim">Sticker sheets could not be loaded.</div>';
  } else {
    sheetHtml = '<div class="dim">Loading sticker sheets.</div>';
  }

  // A name sticker's word goes where its controller chooses (123.6b): each choice is the name it makes.
  let placeHtml = '';
  if (_stkPendingName) {
    const name = _stkCurrentName();
    const n = nameStickerWords(name).length;
    let opts = '';
    for (let k = 0; k <= n; k++) {
      opts += `<option value="${k}"${_stkPendingName.where === k ? ' selected' : ''}>${escapeHtml(addNameStickerWord(name, _stkPendingName.text, k))}</option>`;
    }
    placeHtml = `<div class="modal-section-title" style="margin-top:12px">Where "${escapeHtml(_stkPendingName.text)}" goes</div>
      <select class="sticker-sheet-select" onchange="_stkPendingName.where = parseInt(this.value, 10) || 0">${opts}</select>`;
  }

  overlay.innerHTML = _modalShell({
    title: `Stickers - ${escapeHtml(_stkCurrentName())}`,
    closeFn: 'closeStickerModal',
    body: `
      <div class="modal-section-title">On this card</div>
      ${listHtml}
      <div class="modal-section-title" style="margin-top:12px">Place a sticker</div>
      ${sheetHtml}
      ${placeHtml}`,
    footer: `
      <button class="btn btn-sm" onclick="closeStickerModal()">Close</button>
      ${_stkPendingName ? '<button class="btn-accent" onclick="_stkPlaceName()">Place</button>' : ''}`,
  });
}

function _stkChooseSheet(name) {
  _stkSheet = name;
  _stkPendingName = null;
  _stkRender();
}

/* A sheet's sticker clicked: placed at once, or for a name sticker once its place is chosen. */
function _stkPlace(i) {
  const sheet = (_stickerSheets || []).find(s => s.name === _stkSheet);
  const st = sheet && sheet.stickers[parseInt(i, 10)];
  if (!st) return;
  if (st.kind === 'name') {
    _stkPendingName = { text: st.text, where: 0 };
    _stkRender();
    return;
  }
  const spec = { kind: st.kind, sheet: sheet.name };
  if (st.kind === 'pt') { spec.power = st.power; spec.toughness = st.toughness; }
  else spec.text = st.text;
  _stkApply(() => Battlefield.addSticker(_stkTarget, spec));
}

function _stkPlaceName() {
  const p = _stkPendingName;
  if (!p) return;
  _stkPendingName = null;
  _stkApply(() => Battlefield.addSticker(_stkTarget, { kind: 'name', text: p.text, afterWords: p.where, sheet: _stkSheet }));
}

function _stkRemove(stickerId) {
  _stkApply(() => Battlefield.removeSticker(_stkTarget, stickerId));
}

function _stkApply(change) {
  change();
  renderAll();
  _stkRefreshZoneLists();
  _stkRender();
}

/* The graveyard or exile list under the pop-up shows a card's sticker count. */
function _stkRefreshZoneLists() {
  const t = _stkTarget;
  if (!t || typeof t !== 'object') return;
  if (t.zone === 'graveyard') {
    const pl = Battlefield.getPlayer(t.playerId);
    const listEl = document.getElementById('graveyard-card-list');
    if (pl && listEl) listEl.innerHTML = _renderGraveyardList(pl.graveyard || [], t.playerId);
  } else if (typeof _refreshExileModal === 'function') _refreshExileModal();
}
/* [END: MODAL-STICKER] */
