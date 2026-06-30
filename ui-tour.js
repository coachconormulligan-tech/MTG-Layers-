/* ui-tour.js — First-visit welcome popup + spotlight tour of the sandbox.

   The welcome popup appears once, the first time a player arrives in the sandbox (it is
   triggered from examineFinalState in ui-landing.js). It asks whether they'd like a quick
   tour. If they accept, a spotlight walks through the major features one at a time; any
   click or keypress advances, Escape ends. */

/* [KEY: TOUR] */
const WELCOME_KEY = 'layerInspector.welcomed.v1';

/* Show the welcome popup the first time only. Marks the flag immediately so a refresh
   mid-tour doesn't re-prompt. */
function maybeShowWelcomePopup() {
  let seen = false;
  try { seen = !!localStorage.getItem(WELCOME_KEY); } catch (e) { seen = true; }
  if (seen) return;
  try { localStorage.setItem(WELCOME_KEY, '1'); } catch (e) { /* ignore */ }
  _showWelcomePopup();
}

function _showWelcomePopup() {
  const overlayId = 'welcome-overlay';
  if (document.getElementById(overlayId)) return;

  function _close() {
    const el = document.getElementById(overlayId);
    if (el) el.remove();
  }

  const overlay = _createModalOverlay(overlayId, _close);
  overlay.classList.add('welcome-overlay');

  const modal = document.createElement('div');
  modal.className = 'modal welcome-modal';
  modal.innerHTML = `
    <div class="modal-header">
      <h3>Welcome to Layer Inspector</h3>
      <button class="modal-close" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <p>This is the sandbox, where you build a board and watch every continuous effect resolve layer by layer.</p>
      <p>Would you like a quick tour of the main features?</p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-primary btn-sm" id="welcome-tour-btn">Yes, show me around</button>
      <button class="btn btn-sm" id="welcome-skip-btn">No thanks</button>
    </div>`;

  modal.querySelector('.modal-close').addEventListener('click', _close);
  modal.querySelector('#welcome-skip-btn').addEventListener('click', _close);
  modal.querySelector('#welcome-tour-btn').addEventListener('click', () => { _close(); startSandboxTour(); });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector('#welcome-tour-btn').focus();
}

/* Each step: a selector for the element to spotlight, the caption text, and optional
   padding (px) around the highlight box. Missing selectors are skipped at runtime. */
const TOUR_STEPS = [
  { sel: '.search-section',  text: 'Search for cards here, then press the + on a result to add it to the battlefield.' },
  { sel: '#battlefield',     text: 'Your cards live on the battlefield. Click one to inspect how every layer affects it.', pad: 8 },
  { sel: '.panel:last-child', text: 'Examine the layer-by-layer changes here. Each CR 613 layer is shown in order, ending with the final characteristics.' },
  { sel: '#timestamp-section', text: 'Drag cards in Timestamp Order to change which effect applies first. The board updates automatically.' },
  { sel: '.bf-title-actions', text: 'Export, import, or share your board as a link from these buttons.' },
  { sel: 'a.header-icon-button[href="#tutorial"]', text: 'Open the full written tutorial and practice scenarios any time from here.' },
];

function startSandboxTour() {
  if (document.getElementById('tour-overlay')) return;

  let i = 0;

  const overlay = document.createElement('div');
  overlay.id = 'tour-overlay';
  overlay.className = 'tour-overlay';
  overlay.innerHTML = `
    <div class="tour-spotlight" id="tour-spotlight"></div>
    <div class="tour-caption" id="tour-caption">
      <div class="tour-caption-text" id="tour-caption-text"></div>
      <div class="tour-caption-foot">
        <span class="tour-progress" id="tour-progress"></span>
        <span class="tour-hint">Click or press any key to continue</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  function cleanup() {
    overlay.remove();
    window.removeEventListener('resize', position);
    document.removeEventListener('keydown', onKey, true);
  }

  function next() {
    i++;
    if (i >= TOUR_STEPS.length) { cleanup(); return; }
    position();
  }

  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { cleanup(); return; }
    next();
  }

  function position() {
    // Skip any steps whose target isn't present.
    while (i < TOUR_STEPS.length && !document.querySelector(TOUR_STEPS[i].sel)) i++;
    if (i >= TOUR_STEPS.length) { cleanup(); return; }

    const step = TOUR_STEPS[i];
    const el = document.querySelector(step.sel);
    const pad = step.pad ?? 6;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    const r = el.getBoundingClientRect();
    const spot = document.getElementById('tour-spotlight');
    spot.style.top = (r.top - pad) + 'px';
    spot.style.left = (r.left - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';

    document.getElementById('tour-caption-text').textContent = step.text;
    document.getElementById('tour-progress').textContent = `${i + 1} of ${TOUR_STEPS.length}`;

    // Place the caption below the highlight, flipping above / clamping to the viewport.
    const cap = document.getElementById('tour-caption');
    cap.style.visibility = 'hidden';
    cap.style.top = '0px';
    cap.style.left = '0px';
    requestAnimationFrame(() => {
      const cw = cap.offsetWidth;
      const ch = cap.offsetHeight;
      let top = r.bottom + pad + 12;
      if (top + ch > window.innerHeight - 8) top = r.top - pad - 12 - ch;
      if (top < 8) top = 8;
      let left = r.left;
      if (left + cw > window.innerWidth - 8) left = window.innerWidth - cw - 8;
      if (left < 8) left = 8;
      cap.style.top = top + 'px';
      cap.style.left = left + 'px';
      cap.style.visibility = 'visible';
    });
  }

  overlay.addEventListener('click', next);
  document.addEventListener('keydown', onKey, true); // capture so global shortcuts don't fire
  window.addEventListener('resize', position);
  position();
}
/* [END: TOUR] */
