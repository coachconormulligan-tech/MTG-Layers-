/* ui-landing.js — Dedicated landing page.

   The front door of the app: a big card search where the player stages cards in
   timestamp order, then presses "Examine final state" to enter the sandbox with
   those cards auto-added. Pressing it with nothing staged restores the saved board
   (or the bundled Default Board for a first-time visitor).

   Visibility is driven by `body.landing-active` (see styles.css), mirroring the
   `body.utility-page-open` pattern. The sandbox DOM stays in place underneath and is
   only rendered once we leave the landing page. */

/* [KEY: LANDING] */
let _landingStaged = [];        // [{ uid, card }] in timestamp order (earliest first)
let _landingStageSeq = 0;       // monotonic id source for stable drag identity
let _landingLastResults = [];   // last Scryfall result set (indexed by the "+" buttons)
let _landingSearchTokens = false;
let _landingLastQuery = '';

function bindLandingUI() {
  const input = document.getElementById('landing-search-input');
  const tokenToggle = document.getElementById('landing-token-toggle');
  if (!input) return;
  let debounce = null;

  if (tokenToggle) {
    tokenToggle.addEventListener('change', () => {
      _landingSearchTokens = tokenToggle.checked;
      if (_landingLastQuery.length >= 2) _doLandingSearch(_landingLastQuery);
    });
  }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const q = input.value.trim();
      const results = document.getElementById('landing-search-results');
      if (q.length < 2) { if (results) results.innerHTML = ''; return; }
      _landingLastQuery = q;
      _doLandingSearch(q);
    }, 350);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounce);
      const q = input.value.trim();
      if (!q) return;
      _landingLastQuery = q;
      _doLandingSearch(q);
    }
  });
}

function showLandingPage() {
  document.body.classList.add('landing-active');

  // Offer a one-click return to the autosaved board, if one exists.
  const cont = document.getElementById('landing-continue-btn');
  if (cont) {
    let hasSaved = false;
    try { hasSaved = !!localStorage.getItem(AUTOSAVE_KEY); } catch (e) { /* ignore */ }
    cont.hidden = !hasSaved;
  }

  renderLandingStage();
  const input = document.getElementById('landing-search-input');
  if (input) setTimeout(() => input.focus(), 50);
}

function hideLandingPage() {
  document.body.classList.remove('landing-active');
}

async function _doLandingSearch(query) {
  const results = document.getElementById('landing-search-results');
  if (!results) return;
  results.innerHTML = '<div class="search-loading">Searching…</div>';
  const cards = await searchScryfall(query, { searchTokens: _landingSearchTokens });
  // Guard against an out-of-order response after the query changed.
  if (query !== _landingLastQuery) return;
  _landingLastResults = cards;
  _renderLandingSearchResults(cards);
}

function _renderLandingSearchResults(cards) {
  const results = document.getElementById('landing-search-results');
  if (!results) return;
  if (!cards.length) {
    results.innerHTML = '<div class="search-empty">No cards found</div>';
    return;
  }

  let html = `<div class="search-results-header"><span class="search-count">${cards.length} result${cards.length !== 1 ? 's' : ''}</span></div>`;
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
      <button class="btn-add-card" title="Add to the examination list">+</button>
    </div>`;
  }).join('');

  if (hasMoreScryfallResults()) {
    html += `<button class="btn-load-more" id="landing-load-more-btn">Load more results…</button>`;
  }

  results.innerHTML = html;

  results.querySelectorAll('.btn-add-card').forEach((btn) => {
    const idx = parseInt(btn.closest('.search-result-card').dataset.idx);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _landingAddStaged(cards[idx]);
    });
  });

  const loadMoreBtn = document.getElementById('landing-load-more-btn');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', async () => {
      loadMoreBtn.textContent = 'Loading…';
      loadMoreBtn.disabled = true;
      const moreCards = await searchScryfall(_landingLastQuery, { loadMore: true, searchTokens: _landingSearchTokens });
      _landingLastResults = moreCards;
      _renderLandingSearchResults(moreCards);
    });
  }
}

function _landingAddStaged(card) {
  if (!card) return;
  _landingStaged.push({ uid: 'ls_' + (++_landingStageSeq), card });
  renderLandingStage();
  const input = document.getElementById('landing-search-input');
  if (input) input.value = '';
  const results = document.getElementById('landing-search-results');
  if (results) results.innerHTML = '';
  _landingLastQuery = '';
}

function removeLandingStaged(uid) {
  _landingStaged = _landingStaged.filter(entry => entry.uid !== uid);
  renderLandingStage();
}

function renderLandingStage() {
  const list = document.getElementById('landing-stage-list');
  const wrap = document.getElementById('landing-stage');
  const btn = document.getElementById('landing-examine-btn');
  if (!list) return;

  if (!_landingStaged.length) {
    list.innerHTML = '';
    if (wrap) wrap.hidden = true;
    if (btn) btn.textContent = 'Examine';
    return;
  }

  if (wrap) wrap.hidden = false;
  list.innerHTML = _landingStaged.map((entry, i) => {
    const card = entry.card;
    const imgUri = card.image_uris?.small || (card.card_faces && card.card_faces[0]?.image_uris?.small) || '';
    return `
    <div class="landing-stage-item" draggable="true" data-uid="${entry.uid}">
      <span class="landing-stage-handle" title="Drag to reorder">⠿</span>
      <span class="landing-stage-number">${i + 1}.</span>
      ${imgUri ? `<img class="landing-stage-thumb" src="${imgUri}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="landing-stage-info">
        <div class="landing-stage-name">${escapeHtml(card.name)}</div>
        <div class="landing-stage-type">${escapeHtml(card.type_line || '')}</div>
      </div>
      <button class="landing-stage-remove" title="Remove" onclick="removeLandingStaged('${entry.uid}')">×</button>
    </div>`;
  }).join('');

  if (btn) btn.textContent = `Examine (${_landingStaged.length})`;
  _initLandingStageDrag(list);
}

/* HTML5 drag reorder — mirrors initDragDrop() in ui-timestamp.js, but reorders the
   _landingStaged array (the staging list is local, not a battlefield). */
function _initLandingStageDrag(container) {
  let draggedEl = null;

  container.querySelectorAll('.landing-stage-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      draggedEl = item;
      item.classList.add('ts-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('ts-dragging');
      container.querySelectorAll('.landing-stage-item').forEach(el => el.classList.remove('ts-dragover'));
      const order = [...container.querySelectorAll('.landing-stage-item')].map(el => el.dataset.uid);
      _landingStaged.sort((a, b) => order.indexOf(a.uid) - order.indexOf(b.uid));
      renderLandingStage();
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (item === draggedEl || !draggedEl) return;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) container.insertBefore(draggedEl, item);
      else container.insertBefore(draggedEl, item.nextSibling);
    });

    item.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (item !== draggedEl) item.classList.add('ts-dragover');
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('ts-dragover');
    });
  });
}

/* Add one staged card to the battlefield, reusing the sandbox add path. Split / MDFC
   cards default to their first face so a batch add never stops on a face-choice modal;
   the player can switch faces in the sandbox afterward. */
function _addStagedCardToBattlefield(card) {
  const layout = card.layout || '';
  const isRoom = card.card_faces?.some(f => (f.type_line || '').includes('Room'));
  const needsFaceChoice = !isRoom && card.card_faces?.length >= 2 &&
    (CHOOSEABLE_FACE_LAYOUTS.has(layout) || layout === 'modal_dfc');
  _doAddCardToBattlefield(card, needsFaceChoice ? { faceIndex: 0 } : {});
}

/* The landing-page call to action. Leaves the landing page and enters the sandbox:
   - With staged cards (and not an explicit "Continue"): replace the board with exactly
     those cards, in the staged timestamp order.
   - Otherwise: restore the saved board, or the bundled Default Board for a first visit. */
function examineFinalState(forceContinue) {
  const staged = _landingStaged.slice();
  hideLandingPage();

  if (!forceContinue && staged.length) {
    Battlefield.clear();
    for (const entry of staged) _addStagedCardToBattlefield(entry.card);
    Battlefield.evaluate();
    renderAll();
    _landingStaged = [];
  } else {
    // No staged cards (or explicit "Continue"): no #board= here, so this is
    // autosave-else-default. Both paths render on their own, but renderAll() covers
    // the synchronous autosave-restore case.
    _restoreFromUrlOrAutosave();
    renderAll();
  }

  if (typeof maybeShowWelcomePopup === 'function') maybeShowWelcomePopup();
}
/* [END: LANDING] */
