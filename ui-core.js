/* [KEY: INIT] */
document.addEventListener('DOMContentLoaded', () => {
  TypeCatalog.init();
  _initDataTooltip();
  bindSearchUI();
  bindLandingUI();
  initPanelResize();
  initSectionResize();

  // Entry routing: a shared-board link (#board=) goes straight to the sandbox; any
  // other arrival opens the landing page, which defers the board restore until the
  // player presses "Examine final state" (see examineFinalState in ui-landing.js).
  if (_getBoardPayloadFromUrl()) {
    _restoreFromUrlOrAutosave();
    renderAll();
  } else {
    showLandingPage();
  }

  // Global Escape dismissal — closes the topmost open overlay or floating popup.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    // Small floating popups (not full overlays) — dismiss first
    const dep = document.getElementById('dep-reason-popup');
    if (dep) { dep.remove(); return; }

    const fdMenu = document.getElementById('facedown-menu');
    if (fdMenu) { fdMenu.remove(); return; }

    // Any visible .modal-overlay — trigger its existing click-outside handler
    const overlays = [...document.querySelectorAll('.modal-overlay')];
    const topVisible = overlays.filter(el => getComputedStyle(el).display !== 'none').pop();
    if (topVisible) { topVisible.click(); return; }

    // Dismiss open search results
    if (document.getElementById('search-results')?.children.length) {
      closeSearch();
    }
  });

  // Keyboard shortcuts (ignored while typing in a field or when a modal is open).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return; // handled above
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Don't act on the hidden sandbox while the landing page is up.
    if (document.body.classList.contains('landing-active')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // Don't fire while a modal overlay is open (Escape is the way out of those).
    const modalOpen = [...document.querySelectorAll('.modal-overlay')].some(el => getComputedStyle(el).display !== 'none');
    if (modalOpen) return;

    switch (e.key) {
      case '/':
        e.preventDefault();
        { const input = document.getElementById('card-search-input'); if (input) { input.focus(); input.select(); } }
        break;
      case 'c': case 'C':
        e.preventDefault();
        confirmAction('Clear all permanents from the battlefield?', () => { Battlefield.clear(); renderAll(); });
        break;
      case 'h': case 'H':
        e.preventDefault();
        if (typeof toggleHideAbilityPerms === 'function') toggleHideAbilityPerms();
        break;
      case '?':
        e.preventDefault();
        openShortcutsHelp();
        break;
    }
  });
});

/* Discoverable keyboard-shortcuts reference (opened with "?"). */
function openShortcutsHelp() {
  const overlayId = 'shortcuts-help-overlay';
  if (document.getElementById(overlayId)) return;
  const rows = [
    ['/', 'Card search'],
    ['c', 'Clear battlefield'],
    ['h', 'Toggle Hide abilities'],
    ['Esc', 'Close a dialog or clear search'],
  ];
  function _close() { const el = document.getElementById(overlayId); if (el) el.remove(); }
  const overlay = _createModalOverlay(overlayId, _close);
  const modal = document.createElement('div');
  modal.className = 'modal shortcuts-help-modal';
  modal.innerHTML = `
    <div class="modal-header">
      <h3>Keyboard shortcuts</h3>
      <button class="modal-close" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <table class="shortcuts-help-table">
        ${rows.map(([k, d]) => `<tr><td><kbd>${escapeHtml(k)}</kbd></td><td>${escapeHtml(d)}</td></tr>`).join('')}
      </table>
    </div>`;
  modal.querySelector('.modal-close').addEventListener('click', _close);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}


function _doRenderAll() {
  renderPlayerTabs();
  renderBattlefield();
  renderTimestampPanel();
  renderCounterPanel();
  renderGameStatePanel();
  renderCommanderPanel();
  renderEmblemPanel();
  renderGraveyardPanel();
  renderExilePanel();
  renderInspector();
}

/* Lightweight selection change: update inspectedId and refresh inspector + timestamp
   panel without re-evaluating the board or rebuilding the battlefield grid. */
function selectInspected(id) {
  const prevId = Battlefield.inspectedId;
  Battlefield.inspectedId = id;

  // Toggle bf-card-selected CSS class directly on existing DOM nodes — no innerHTML rebuild.
  if (prevId) {
    const prev = document.querySelector(`.bf-card[data-id="${prevId}"]`);
    if (prev) {
      prev.classList.remove('bf-card-selected');
      // Clear selection on parent mutate-stack wrapper if any
      const stack = prev.closest('.bf-mutate-stack');
      if (stack) stack.classList.remove('bf-mutate-stack-selected');
    }
  }
  if (id) {
    const next = document.querySelector(`.bf-card[data-id="${id}"]`);
    if (next) {
      next.classList.add('bf-card-selected');
      // Mark parent mutate-stack wrapper as selected if any
      const stack = next.closest('.bf-mutate-stack');
      if (stack) stack.classList.add('bf-mutate-stack-selected');
    }
  }

  renderInspector();
  renderTimestampPanel();
  renderCounterPanel();
}

function _showProcessingBar() {
  let bar = document.getElementById('processing-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'processing-bar';
    document.body.appendChild(bar);
  }
  bar.style.display = 'block';
}

function _hideProcessingBar() {
  const bar = document.getElementById('processing-bar');
  if (bar) bar.style.display = 'none';
}

function renderAll() {
  _showProcessingBar();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      _doRenderAll();
      _autosaveBoard();
      _hideProcessingBar();
    });
  });
}

/* ─── Board persistence ─── */
const AUTOSAVE_KEY = 'layerInspector.board.v1';
let _autosaveTimer = null;
let _restoreInProgress = false;
let _urlRestoreInFlight = false;  // true while a shared-link board is being re-fetched

/* True when the board has anything worth persisting. */
function _boardHasContent(data) {
  return data.perms.length > 0 ||
    data.players.length > 1 ||
    data.exile.length > 0 ||
    data.players.some(p => (p.graveyard && p.graveyard.length) ||
                           (p.commanders && p.commanders.length) ||
                           (p.emblems && p.emblems.length));
}

/* Debounced autosave to localStorage on every board mutation (via renderAll). */
function _autosaveBoard() {
  if (_restoreInProgress || _urlRestoreInFlight) return;
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => {
    try {
      const data = Battlefield.serialize();
      if (_boardHasContent(data)) {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
      } else {
        localStorage.removeItem(AUTOSAVE_KEY);
      }
    } catch (e) { /* quota / serialization error — ignore */ }
  }, 600);
}

/* Auto-restore the autosaved board on page load, if present. */
function _autoRestoreBoard() {
  let raw;
  try { raw = localStorage.getItem(AUTOSAVE_KEY); } catch (e) { return false; }
  if (!raw) return false;
  let data;
  try { data = JSON.parse(raw); } catch (e) { return false; }
  return _restoreFromData(data);
}

/* First-visit fallback: when there's no shared-link board and no autosaved board,
   load the bundled Default Board scenario so a new player lands on a populated board
   instead of an empty one. The file is fetched (async), so this renders again on its
   own when done — mirroring the URL-restore path's in-flight guard + processing bar.
   Failure is silent: a new player simply gets the empty board. */
const DEFAULT_BOARD_FILE = 'Default Board.json';
function _loadDefaultBoard() {
  _urlRestoreInFlight = true;  // suppress autosave until the async restore settles
  _showProcessingBar();
  fetch('assets/Scenarios/' + encodeURIComponent(DEFAULT_BOARD_FILE), { cache: 'no-store' })
    .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(data => { _restoreFromData(data); })
    .catch(e => { console.error('Default board load failed:', e); })
    .finally(() => { _urlRestoreInFlight = false; _hideProcessingBar(); renderAll(); });
}

/* Shared restore wrapper — guards autosave re-entry and reports failure. */
function _restoreFromData(data) {
  _restoreInProgress = true;
  let ok = false;
  try { ok = Battlefield.restore(data); }
  catch (e) { console.error('Board restore failed:', e); ok = false; }
  _restoreInProgress = false;
  return ok;
}

/* Download the current board as a JSON file. */
function exportBoard() {
  const data = Battlefield.serialize();
  if (!_boardHasContent(data)) {
    if (typeof _showSBAToast === 'function') _showSBAToast('The board is empty — nothing to export.');
    return;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'layer-inspector-board.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* Pick a JSON file and restore the board from it. */
function importBoard() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); }
      catch (e) {
        if (typeof _showSBAToast === 'function') _showSBAToast('That file is not valid board JSON.');
        return;
      }
      if (_restoreFromData(data)) {
        renderAll();
      } else if (typeof _showSBAToast === 'function') {
        _showSBAToast('Could not load this board file.');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

/* ─── Share board as a link ───
   The board is encoded into the URL hash under `#board=<payload>`, where payload is
   URL-safe base64 of a JSON "lite recipe". Opening that link rebuilds the exact board.

   Unlike file export (which embeds each card's full ~5KB Scryfall object), the share
   link stores only each card's NAME plus the user's mutable state (counters, targets,
   tapped, chosen values, timestamps, ...). On open, the cards are re-fetched by name
   from Scryfall — the same lookup used when adding a card. A card's rules-relevant
   data (oracle text, type line, P/T, layout, colors, mana cost, faces) is identical
   across printings, so a name re-fetch rebuilds a board that evaluates identically,
   while keeping the URL short enough to actually share. */

/* Conservative max share-URL length. ~2000 chars is the limit that reliably
   survives across browsers (old IE/Edge capped near 2083), and — more importantly
   here — across the chat apps, messaging clients, and email programs people paste
   links into, many of which silently truncate or line-wrap longer URLs. A truncated
   #board= payload decodes to garbage and rebuilds a corrupt board, so we refuse to
   generate a link past this ceiling rather than hand out one that may break. */
const MAX_SHARE_URL_LEN = 2000;
const BOARD_HASH_KEY = 'board';

/* Drop keys whose value is a default (null / false / empty array / empty object) so
   the share payload doesn't spend ~600 chars per perm on unset fields. Battlefield
   .restore() reads every such field through a `?? default` / `if (...)` guard, so a
   missing key rebuilds identically to an explicit default. Mutates and returns obj. */
function _stripDefaults(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === null || v === false ||
        (Array.isArray(v) && v.length === 0) ||
        (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) {
      delete obj[k];
    }
  }
  return obj;
}

/* Replace every embedded Scryfall card object in a serialized board with just its
   name, and strip default-valued fields. Returns a deep copy — the original `data`
   (used by file export / autosave) keeps its full card objects. Cards live on perms,
   commanders, emblems, and exile. */
function _boardToLiteRecipe(data) {
  const lite = JSON.parse(JSON.stringify(data));
  for (const p of lite.perms || []) {
    p.cardName = (p.scryfallData && p.scryfallData.name) || null;
    delete p.scryfallData;
    _stripDefaults(p);
  }
  for (const f of lite.firedAbilities || []) _stripDefaults(f);
  for (const pl of lite.players || []) {
    // Drop gameState keys still at their default (restore backfills from DEFAULT_GAME_STATE).
    if (pl.gameState && typeof DEFAULT_GAME_STATE !== 'undefined') {
      const gs = pl.gameState;
      for (const k of Object.keys(gs)) {
        const v = gs[k];
        if (v === DEFAULT_GAME_STATE[k] ||
            (v && typeof v === 'object' && Object.keys(v).length === 0)) delete gs[k];
      }
    }
    for (const c of pl.commanders || []) { c.cardName = c.card && c.card.name; delete c.card; _stripDefaults(c); }
    for (const em of pl.emblems || []) { em.cardName = em.card && em.card.name; delete em.card; _stripDefaults(em); }
    _stripDefaults(pl);
  }
  for (const e of lite.exile || []) { e.cardName = e.card && e.card.name; delete e.card; _stripDefaults(e); }
  return lite;
}

/* Inverse of _boardToLiteRecipe: re-fetch each card by name (tokens via the token
   search) and put a real Scryfall object back where the stub was, producing a recipe
   Battlefield.restore() can consume. Fetches are deduped and run in parallel. Any
   card that can't be re-fetched is dropped so restore doesn't choke on a null card. */
async function _hydrateLiteRecipe(lite) {
  const cache = new Map();
  const getCard = (name, isToken) => {
    if (!name) return Promise.resolve(null);
    const key = (isToken ? 'T:' : 'C:') + name;
    if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      let card = isToken ? await fetchTokenByName(name) : await fetchCardByName(name);
      if (!card && isToken) card = await fetchCardByName(name);  // token search missed — try as a card
      return card;
    })();
    cache.set(key, p);
    return p;
  };

  // Kick off every fetch, then await them all.
  const jobs = [];
  for (const p of lite.perms || []) jobs.push(getCard(p.cardName, p.isToken).then(c => { p.scryfallData = c; delete p.cardName; }));
  for (const pl of lite.players || []) {
    for (const c of pl.commanders || []) jobs.push(getCard(c.cardName, false).then(card => { c.card = card; delete c.cardName; }));
    for (const em of pl.emblems || []) jobs.push(getCard(em.cardName, false).then(card => { em.card = card; delete em.cardName; }));
  }
  for (const e of lite.exile || []) jobs.push(getCard(e.cardName, false).then(card => { e.card = card; delete e.cardName; }));
  await Promise.all(jobs);

  // Drop anything whose card could not be resolved.
  lite.perms = (lite.perms || []).filter(p => p.scryfallData);
  lite.exile = (lite.exile || []).filter(e => e.card);
  for (const pl of lite.players || []) {
    pl.commanders = (pl.commanders || []).filter(c => c.card);
    pl.emblems = (pl.emblems || []).filter(em => em.card);
  }
  return lite;
}

/* Uint8Array → URL-safe base64 (btoa is Latin-1, so feed it a binary string). */
function _bytesToB64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* URL-safe base64 → Uint8Array. */
function _b64urlToBytes(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* Pipe bytes through a CompressionStream / DecompressionStream and collect the result. */
async function _streamBytes(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  const buf = await new Response(piped).arrayBuffer();
  return new Uint8Array(buf);
}

/* JSON → URL-safe payload. Preferred path: deflate-raw compress → base64url, marked with
   a leading '~' (URL-safe, not in the base64url alphabet) so decode knows the scheme.
   The board JSON is full of repeated keys/ids, which deflate collapses dramatically,
   typically shrinking the link several-fold. Fallback when CompressionStream is missing
   (or fails): the legacy encodeURIComponent→btoa base64url, with no '~' prefix —
   encodeURIComponent first so non-ASCII (accented card names) survives btoa's Latin-1. */
async function _encodeBoardToPayload(data) {
  const json = JSON.stringify(data);
  if (typeof CompressionStream !== 'undefined') {
    try {
      const input = new TextEncoder().encode(json);
      const packed = await _streamBytes(input, new CompressionStream('deflate-raw'));
      return '~' + _bytesToB64url(packed);
    } catch (e) { /* fall through to plain base64 */ }
  }
  const b64 = btoa(encodeURIComponent(json));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Inverse of _encodeBoardToPayload. A leading '~' marks the deflate-raw scheme; anything
   else is a legacy plain-base64 payload. Async (decompression is stream-based). Throws on
   malformed input (caller catches). */
async function _decodeBoardFromPayload(payload) {
  if (payload[0] === '~') {
    const bytes = _b64urlToBytes(payload.slice(1));
    const out = await _streamBytes(bytes, new DecompressionStream('deflate-raw'));
    return JSON.parse(new TextDecoder().decode(out));
  }
  let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const json = decodeURIComponent(atob(b64));
  return JSON.parse(json);
}

/* Pull the board payload out of the current URL hash, or null if none. */
function _getBoardPayloadFromUrl() {
  const hash = window.location.hash || '';
  const m = hash.match(/[#&]board=([^&]+)/);
  return m ? m[1] : null;
}

/* Remove the #board= payload from the address bar without reloading, so later
   edits/refreshes persist via autosave instead of re-sharing the original link. */
function _stripBoardHash() {
  history.replaceState('', document.title, window.location.pathname + window.location.search);
}

/* Page-load restore: a #board= URL takes precedence over the localStorage autosave.
   The URL path is async (cards are re-fetched by name), so it renders again on its
   own when done. On success the hash is stripped (autosave then owns ongoing
   persistence). A corrupt payload or failed restore falls back to the autosave. */
function _restoreFromUrlOrAutosave() {
  const payload = _getBoardPayloadFromUrl();
  if (!payload) {
    // No shared-link board: restore the autosaved board, or — on a first visit with
    // nothing remembered — fall back to the bundled Default Board scenario.
    if (!_autoRestoreBoard()) _loadDefaultBoard();
    return;
  }

  // Strip the hash immediately so a slow/failed decode/fetch can't leave a re-shareable URL.
  _stripBoardHash();

  // Suppress autosave until the async restore settles, so the empty initial render
  // can't wipe the user's autosaved board before (or instead of) the URL board loads.
  // Decode is async (decompression is stream-based), so it lives inside the chain too.
  _urlRestoreInFlight = true;
  _showProcessingBar();
  Promise.resolve()
    .then(() => _decodeBoardFromPayload(payload))
    .then(lite => _hydrateLiteRecipe(lite))
    .then(hydrated => { if (!_restoreFromData(hydrated)) _autoRestoreBoard(); })
    .catch(e => { console.error('Shared board restore failed:', e); _autoRestoreBoard(); })
    .finally(() => { _urlRestoreInFlight = false; _hideProcessingBar(); renderAll(); });
}

/* Copy text to the clipboard, resolving true/false. Uses the async Clipboard API
   when available (secure contexts), with a legacy execCommand fallback. */
function _copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return Promise.resolve(ok);
  } catch (e) {
    return Promise.resolve(false);
  }
}

/* Build a shareable URL for the current board and copy it to the clipboard.
   Refuses (with guidance) when the board is empty or the link would be too long. */
async function shareBoard() {
  const data = Battlefield.serialize();
  if (!_boardHasContent(data)) {
    if (typeof _showSBAToast === 'function') _showSBAToast('The board is empty — nothing to share.');
    return;
  }

  const payload = await _encodeBoardToPayload(_boardToLiteRecipe(data));
  const base = window.location.origin + window.location.pathname;
  const url = base + '#' + BOARD_HASH_KEY + '=' + payload;

  if (url.length > MAX_SHARE_URL_LEN) {
    _showShareTooLargeDialog();
    return;
  }

  _copyToClipboard(url).then(ok => {
    if (typeof _showSBAToast !== 'function') return;
    if (ok) _showSBAToast('Share link copied to clipboard. Opening it re-fetches each card by name from Scryfall, so it needs an internet connection, and any custom or unmatched cards (e.g. hand-made tokens) may not carry over — use "Export board to file" for an exact, offline copy.', 'success');
    else _showShareLinkFallback(url);
  });
}

/* Shown when the encoded board exceeds MAX_SHARE_URL_LEN: explains why no link was
   produced and how to share the board anyway. Non-dismissive info modal — no link
   is generated and nothing is written to the clipboard. */
function _showShareTooLargeDialog() {
  const overlayId = 'share-too-large-overlay';
  const existing = document.getElementById(overlayId);
  if (existing) existing.remove();

  function _close() {
    const el = document.getElementById(overlayId);
    if (el) el.remove();
  }

  const overlay = _createModalOverlay(overlayId, _close);
  const modal = document.createElement('div');
  modal.className = 'modal confirm-modal';
  modal.innerHTML = `
    <div class="modal-header">
      <h3>Board too large to share as a link</h3>
      <button class="modal-close" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <p>This board is too big to fit in a shareable link. Links have a practical
         length limit (about ${MAX_SHARE_URL_LEN} characters), and longer ones get
         truncated or broken by many chat and email programs — which would rebuild a
         corrupt board when opened. So no link was created.</p>
      <p>To share it anyway, try one of these:</p>
      <ul class="share-advice-list">
        <li><strong>Share the file instead.</strong> Use "Export board to file" to
            download a .json with no size limit; the other person opens it with
            "Import board from file".</li>
        <li><strong>Make the board smaller.</strong> Remove any permanents that
            aren't needed to demonstrate the interaction you want to share.</li>
        <li><strong>Trim extra zones and players.</strong> Clear the graveyard,
            exile, and emblems, and remove extra players, unless they're part of the
            effect you're showing.</li>
      </ul>
    </div>
    <div class="modal-footer">
      <button class="btn btn-sm" id="share-too-large-ok">Got it</button>
    </div>`;

  modal.querySelector('.modal-close').addEventListener('click', _close);
  modal.querySelector('#share-too-large-ok').addEventListener('click', _close);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector('#share-too-large-ok').focus();
}

/* Shown when the link fits but the clipboard write was blocked — offers the URL for
   manual copy so the share still works. */
function _showShareLinkFallback(url) {
  const overlayId = 'share-link-fallback-overlay';
  const existing = document.getElementById(overlayId);
  if (existing) existing.remove();

  function _close() {
    const el = document.getElementById(overlayId);
    if (el) el.remove();
  }

  const overlay = _createModalOverlay(overlayId, _close);
  const modal = document.createElement('div');
  modal.className = 'modal confirm-modal';
  modal.innerHTML = `
    <div class="modal-header">
      <h3>Copy share link</h3>
      <button class="modal-close" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <p>Your browser blocked automatic copying. Select the link below and copy it
         manually:</p>
      <textarea class="share-link-textarea" readonly rows="4"></textarea>
    </div>
    <div class="modal-footer">
      <button class="btn btn-sm" id="share-link-fallback-ok">Close</button>
    </div>`;

  const ta = modal.querySelector('.share-link-textarea');
  ta.value = url;
  modal.querySelector('.modal-close').addEventListener('click', _close);
  modal.querySelector('#share-link-fallback-ok').addEventListener('click', _close);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  ta.focus();
  ta.select();
}

/* Player tab bar: switch between players' boards */
function renderPlayerTabs() {
  const container = document.getElementById('player-tabs');
  if (!container) return;

  container.style.display = 'flex';

  let html = '';
  for (const player of Battlefield.players) {
    const isActive = player.id === Battlefield.activePlayerId;
    html += `<button class="player-tab${isActive ? ' active' : ''}" onclick="switchPlayer('${player.id}')">
      <span class="player-tab-name">${escapeHtml(player.name)}</span>
      <span class="player-tab-life">${player.gameState.currentLife}</span>
      ${player.id !== 'player_0' ? `<span class="player-tab-remove" onclick="event.stopPropagation(); removePlayer('${player.id}')">&times;</span>` : ''}
    </button>`;
  }
  html += `<button class="player-tab player-tab-add" onclick="addPlayerPrompt()">+</button>`;
  container.innerHTML = html;
}

function switchPlayer(playerId) {
  Battlefield.setActivePlayer(playerId);
  Battlefield.evaluate();
  renderAll();
}

function addPlayerPrompt() {
  const name = prompt('Enter player name:', 'Player ' + (Battlefield.players.length + 1));
  if (!name) return;
  Battlefield.addPlayer(name);
  Battlefield.evaluate();
  renderAll();
}

function removePlayer(playerId) {
  confirmAction('Remove this player and all their permanents?', () => {
    Battlefield.removePlayer(playerId);
    Battlefield.evaluate();
    renderAll();
  });
}

/* Draggable resize handle for left panel width */
function initPanelResize() {
  const handle = document.getElementById('left-resize-handle');
  if (!handle) return;
  const layout = document.querySelector('.app-layout');
  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = document.querySelector('.left-panel').getBoundingClientRect().width;
    // The thinnest the battlefield may get is the width of the player-identification
    // bars: shrinking it further would push the tabs into the Layer Inspector. Cap the
    // left-panel width so the center column never narrows past that single-row tab width.
    const maxLeftWidth = _maxLeftPanelWidth(layout);
    _setupDrag(handle, 'col-resize', (e2) => {
      const newWidth = Math.max(200, Math.min(maxLeftWidth, startWidth + (e2.clientX - startX)));
      layout.style.setProperty('--left-panel-width', newWidth + 'px');
    });
  });
}

/* Largest left-panel width that still leaves the center battlefield at least as wide
   as the player-tabs row — i.e. the point where the player bars just touch the Layer
   Inspector. Measured live so it tracks the current player count. */
function _maxLeftPanelWidth(layout) {
  const layoutWidth = layout.getBoundingClientRect().width;
  // Right column (Layer Inspector) and the resize handle are fixed-width in the grid.
  const inspector = layout.querySelector('.panel:last-child');
  const inspectorWidth = inspector ? inspector.getBoundingClientRect().width : 380;
  const handle = document.getElementById('left-resize-handle');
  const handleWidth = handle ? handle.getBoundingClientRect().width : 6;
  const tabsWidth = _playerTabsRowWidth();
  // Keep at least the original 200px minimum so the left panel stays usable.
  return Math.max(200, layoutWidth - inspectorWidth - handleWidth - tabsWidth);
}

/* Intrinsic single-row width of the player-tabs container (sum of tab widths + gaps +
   horizontal padding), independent of any current flex-wrapping. */
function _playerTabsRowWidth() {
  const tabsEl = document.getElementById('player-tabs');
  if (!tabsEl) return 200;
  const cs = getComputedStyle(tabsEl);
  const padX = parseFloat(cs.paddingLeft || 0) + parseFloat(cs.paddingRight || 0);
  const gap = parseFloat(cs.columnGap || cs.gap || 0) || 0;
  const kids = Array.from(tabsEl.children);
  if (!kids.length) return 200;
  const childrenW = kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0);
  // +4px guards against sub-pixel rounding so the last tab (the add "+" button) never
  // wraps onto a second row right at the minimum width.
  return Math.ceil(padX + childrenW + gap * (kids.length - 1)) + 4;
}
/* Vertical resize handles between left-panel sections.
   Dragging a handle resizes only the section ABOVE it (growing or shrinking it).
   The left panel scrolls naturally if total content exceeds viewport. */
function initSectionResize() {
  document.querySelectorAll('.section-v-resize').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const aboveSel = handle.dataset.resizeAbove;
      const above = handle.parentElement.querySelector(aboveSel);
      if (!above) return;

      const startY = e.clientY;
      const startAboveH = above.getBoundingClientRect().height;

      _setupDrag(handle, 'row-resize', (e2) => {
        const dy = e2.clientY - startY;
        const newAboveH = Math.max(60, startAboveH + dy);
        above.style.flex = `0 0 ${newAboveH}px`;
      });
    });
  });
}
/* [END: INIT] */


/* [KEY: SEARCH-UI] */
let _lastSearchQuery = '';
let _searchTokensMode = false;

function bindSearchUI() {
  const input = document.getElementById('card-search-input');
  const results = document.getElementById('search-results');
  const tokenToggle = document.getElementById('search-token-toggle');
  let debounce = null;

  if (tokenToggle) {
    tokenToggle.addEventListener('change', () => {
      _searchTokensMode = tokenToggle.checked;
      if (_lastSearchQuery.length >= 2) {
        doSearch(_lastSearchQuery);
      }
    });
  }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      _lastSearchQuery = q;
      doSearch(q);
    }, 350);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounce);
      const q = input.value.trim();
      if (!q) return;
      _lastSearchQuery = q;
      doSearch(q);
    }
  });
}

async function doSearch(query) {
  const results = document.getElementById('search-results');
  results.innerHTML = '<div class="search-loading">Searching…</div>';
  const cards = await searchScryfall(query, { searchTokens: _searchTokensMode });
  renderSearchResults(cards);
}

function renderSearchResults(cards) {
  const results = document.getElementById('search-results');
  if (!cards.length) {
    results.innerHTML = '<div class="search-empty">No cards found</div>';
    return;
  }

  let html = `<div class="search-results-header"><span class="search-count">${cards.length} result${cards.length !== 1 ? 's' : ''}</span><button class="search-close-btn" onclick="closeSearch()" title="Close search results">&#x2715; Close</button></div>`;
  html += cards.map((card, i) => {
    const isToken = card.layout === 'token' || card.layout === 'double_faced_token';
    const imgUri = card.image_uris?.small || (card.card_faces && card.card_faces[0]?.image_uris?.small) || '';
    return `
    <div class="search-result-card" data-idx="${i}">
      <img src="${imgUri}" alt="${escapeAttr(card.name)}" loading="lazy" onerror="this.style.display='none'">
      <div class="search-result-info">
        <strong>${escapeHtml(card.name)}${isToken ? '<span class="search-result-token-badge">TOKEN</span>' : ''}</strong>
        <span class="search-result-type">${escapeHtml(card.type_line || '')}</span>
      </div>
      <button class="btn-add-card" title="Add to battlefield">+</button>
    </div>`;
  }).join('');

  if (hasMoreScryfallResults()) {
    html += `<button class="btn-load-more" id="load-more-btn">Load more results…</button>`;
  }

  results.innerHTML = html;

  results.querySelectorAll('.btn-add-card').forEach((btn) => {
    const idx = parseInt(btn.closest('.search-result-card').dataset.idx);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      addCardToBattlefield(cards[idx]);
    });
  });

  const loadMoreBtn = document.getElementById('load-more-btn');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', async () => {
      loadMoreBtn.textContent = 'Loading…';
      loadMoreBtn.disabled = true;
      const moreCards = await searchScryfall(_lastSearchQuery, { loadMore: true, searchTokens: _searchTokensMode });
      renderSearchResults(moreCards);
    });
  }
}

function addCardToBattlefield(card) {
  const layout = card.layout || '';
  const isRoom = card.card_faces?.some(f => (f.type_line || '').includes('Room'));
  const needsFaceChoice = !isRoom && card.card_faces?.length >= 2 &&
    (CHOOSEABLE_FACE_LAYOUTS.has(layout) || layout === 'modal_dfc');
  if (needsFaceChoice) {
    _showSplitFaceModal(card);
    return;
  }
  _doAddCardToBattlefield(card, {});
}

function _doAddCardToBattlefield(card, opts) {
  const resolvedFace = (opts.faceIndex !== undefined && card.card_faces)
    ? card.card_faces[opts.faceIndex]
    : card;
  const typeLine = (resolvedFace.type_line || card.type_line || '').toLowerCase();
  const isSpellType = /\b(instant|sorcery)\b/.test(typeLine);

  if (isSpellType) {
    const spell = Battlefield.addSpell(card, {
      ...opts,
      controller: Battlefield.activePlayerId,
      owner: Battlefield.activePlayerId,
    });
    document.getElementById('card-search-input').value = '';
    document.getElementById('search-results').innerHTML = '';
    Battlefield.inspectedId = spell.id;
    Battlefield.evaluate();
    renderAll();
    return;
  }

  const isToken = card.layout === 'token' || card.layout === 'double_faced_token';
  const perm = Battlefield.addPermanent(card, { isToken, ...opts });
  document.getElementById('card-search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
  Battlefield.evaluate();
  renderAll();
  if (Battlefield.permanents.filter(p => !p.isManualEffect).length === 1) {
    selectPermanent(perm.id);
  }
}

let _pendingSplitCard = null;

function _showSplitFaceModal(card) {
  _pendingSplitCard = card;
  const faces = card.card_faces;
  const faceCards = faces.map((face, i) => `
    <div class="split-face-option" onclick="_confirmSplitFace(${i})">
      <div class="split-face-header">
        <span class="split-face-name">${escapeHtml(face.name || '')}</span>
        <span class="split-face-cost">${escapeHtml(face.mana_cost || '')}</span>
      </div>
      <div class="split-face-type">${escapeHtml(face.type_line || '')}</div>
      ${face.oracle_text ? `<div class="split-face-oracle">${escapeHtml(face.oracle_text).replace(/\n/g, '<br>')}</div>` : ''}
    </div>`).join('<div class="split-face-divider">//</div>');

  const html = `<div class="modal-overlay" id="split-face-modal" onclick="if(event.target===this)_closeSplitFaceModal()">
    <div class="modal split-face-modal-box">
      <div class="modal-header">
        <h3>Choose which half to play — <em>${escapeHtml(card.name)}</em></h3>
        <button class="modal-close" onclick="_closeSplitFaceModal()">\u00D7</button>
      </div>
      <div class="modal-body split-face-body">${faceCards}</div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function _confirmSplitFace(faceIndex) {
  const card = _pendingSplitCard;
  _closeSplitFaceModal();
  if (!card) return;
  _doAddCardToBattlefield(card, { faceIndex });
}

function _closeSplitFaceModal() {
  const modal = document.getElementById('split-face-modal');
  if (modal) modal.remove();
  _pendingSplitCard = null;
}

function switchSplitFace(id) {
  Battlefield.switchSplitFace(id);
  Battlefield.evaluate();
  renderAll();
}

function toggleRoomLock(id, faceIndex) {
  Battlefield.toggleRoomLock(id, faceIndex);
  Battlefield.evaluate();
  renderAll();
}

/* [KEY: DUAL-OPTIONS-POPUP]  —  Popup for Room / split cards */
let _dualOptionsPermId = null;
let _dualOptionsTempFace = null; // for split cards: temp selected face index

function openDualOptionsPopup(permId) {
  _dualOptionsPermId = permId;
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;
  if (perm.isChooseableFace) {
    _dualOptionsTempFace = perm.activeFaceIndex ?? 0;
  }

  let overlay = document.getElementById('dual-options-overlay');
  if (!overlay) {
    overlay = _createModalOverlay('dual-options-overlay', closeDualOptionsPopup);
    document.body.appendChild(overlay);
  }
  overlay.onclick = (e) => { if (e.target === overlay) closeDualOptionsPopup(); };
  overlay.style.display = 'flex';
  _renderDualOptionsContent();
}

function _renderDualOptionsContent() {
  const permId = _dualOptionsPermId;
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;
  const overlay = document.getElementById('dual-options-overlay');
  if (!overlay) return;

  const isRoom = perm.isRoom;
  const isChooseable = perm.isChooseableFace;

  let optionsHtml = '';
  let footerHtml = '';

  if (isRoom && perm.roomFaces) {
    const unlocked = perm.roomFaces.filter((_, i) => !perm.roomLocked[i]).length;
    optionsHtml = perm.roomFaces.map((rf, i) => {
      const locked = perm.roomLocked[i];
      return `<div class="dual-opt-entry ${locked ? '' : 'dual-opt-active'}">
        <div class="dual-opt-header">
          <span class="dual-opt-name">${escapeHtml(rf.name)}</span>
          <span class="dual-opt-cost">${escapeHtml(rf.mana_cost)}</span>
          <button class="dual-opt-toggle-btn ${locked ? 'dual-opt-locked' : 'dual-opt-unlocked'}"
            onclick="_dualOptionsRoomToggle(${i})">
            ${locked ? 'Locked' : 'Unlocked'}
          </button>
        </div>
        ${rf.oracle_text ? `<div class="dual-opt-oracle">${escapeHtml(rf.oracle_text).replace(/\n/g, '<br>')}</div>` : ''}
      </div>`;
    }).join('');
    // No footer needed for rooms — changes apply immediately
    footerHtml = `<div class="modal-footer">
      <button class="modal-popup-cancel-btn" onclick="closeDualOptionsPopup()">Done</button>
    </div>`;
  } else if (isChooseable && perm.scryfallData?.card_faces) {
    const faces = perm.scryfallData.card_faces;
    optionsHtml = faces.map((f, i) => {
      const isSelected = _dualOptionsTempFace === i;
      const oracleRaw = f.oracle_text || '';
      const typeLine = f.type_line || '';
      return `<div class="dual-opt-entry ${isSelected ? 'dual-opt-active' : ''}" onclick="_dualOptionsFaceSelect(${i})">
        <div class="dual-opt-header">
          <label class="dual-opt-radio-label">
            <input type="radio" name="dual_opt_face" ${isSelected ? 'checked' : ''}
              onchange="_dualOptionsFaceSelect(${i})">
            <span class="dual-opt-name">${escapeHtml(f.name || '')}</span>
          </label>
          <span class="dual-opt-cost">${escapeHtml(f.mana_cost || '')}</span>
        </div>
        ${typeLine ? `<div class="dual-opt-type">${escapeHtml(typeLine)}</div>` : ''}
        ${oracleRaw ? `<div class="dual-opt-oracle">${escapeHtml(oracleRaw).replace(/\n/g, '<br>')}</div>` : ''}
      </div>`;
    }).join('');
    footerHtml = `<div class="modal-footer">
      <button class="modal-popup-apply-btn" onclick="applyDualOptionsPopup()">Apply</button>
      <button class="modal-popup-cancel-btn" onclick="closeDualOptionsPopup()">Cancel</button>
    </div>`;
  }

  const title = isRoom ? `${perm.name} — Rooms` : `${perm.scryfallData?.name || perm.name} — Choose Half`;
  overlay.innerHTML = `
    <div class="modal modal-dual-options">
      <div class="modal-header">
        <h3>${escapeHtml(title)}</h3>
        <button class="modal-close" onclick="closeDualOptionsPopup()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="dual-opt-list">${optionsHtml}</div>
      </div>
      ${footerHtml}
    </div>`;
}

function _dualOptionsRoomToggle(faceIndex) {
  if (!_dualOptionsPermId) return;
  Battlefield.toggleRoomLock(_dualOptionsPermId, faceIndex);
  Battlefield.evaluate();
  renderAll();
  _renderDualOptionsContent();
}

function _dualOptionsFaceSelect(faceIndex) {
  _dualOptionsTempFace = faceIndex;
  _renderDualOptionsContent();
}

function applyDualOptionsPopup() {
  if (!_dualOptionsPermId) return;
  const perm = Battlefield.getPermById(_dualOptionsPermId);
  if (!perm || !perm.isChooseableFace) { closeDualOptionsPopup(); return; }
  if (_dualOptionsTempFace !== null && _dualOptionsTempFace !== perm.activeFaceIndex) {
    Battlefield.switchSplitFace(_dualOptionsPermId, _dualOptionsTempFace);
    Battlefield.evaluate();
    renderAll();
  }
  closeDualOptionsPopup();
}

function closeDualOptionsPopup() {
  _dualOptionsPermId = null;
  _dualOptionsTempFace = null;
  const overlay = document.getElementById('dual-options-overlay');
  if (overlay) overlay.style.display = 'none';
}

function closeSearch() {
  document.getElementById('card-search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
  _lastSearchQuery = '';
}

function toggleTimestampExpand() {
  const section = document.getElementById('timestamp-section');
  if (!section) return;
  section.classList.toggle('ts-collapsed');
}

/* Independent accordion toggle for a left-panel section: collapse/expand just this
   section's body (state is in-memory only — resets each session). */
function toggleLeftSection(headerEl) {
  const section = headerEl.closest('.accordion-section');
  if (section) section.classList.toggle('collapsed');
}
/* [END: SEARCH-UI] */

