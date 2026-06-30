/* Shared UI helpers */
function _createModalOverlay(id, closeFn) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = id;
  overlay.onclick = (e) => { if (e.target === overlay) closeFn(); };
  return overlay;
}
function _setupDrag(handle, cursor, onMove) {
  handle.classList.add('dragging');
  document.body.style.cursor = cursor;
  document.body.style.userSelect = 'none';
  function onUp() {
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/* Show / hide the dependency-reason popup attached to a '?' button.
   Clicking the same button a second time dismisses the popup (toggle). */
function showDepReasonPopup(btn) {
  const existing = document.getElementById('dep-reason-popup');
  if (existing) {
    const wasThisBtn = existing.dataset.srcBtn === btn.dataset.reason;
    existing.remove();
    if (wasThisBtn) return; // toggle off
  }

  const reason = btn.dataset.reason || '';
  const isLoop = btn.dataset.isLoop === 'true';
  const popup = document.createElement('div');
  popup.id = 'dep-reason-popup';
  popup.className = 'dep-reason-popup';
  popup.dataset.srcBtn = reason;
  const title = btn.dataset.title || (isLoop ? 'Why is this a dependency loop?' : 'Why is this a dependency?');
  popup.innerHTML = `<div class="dep-reason-popup-title">${escapeHtml(title)}</div>
    <div class="dep-reason-popup-text">${escapeHtml(capitalizeFirst(reason))}</div>`;
  document.body.appendChild(popup);

  // Position below the button, aligned to its left edge
  const rect = btn.getBoundingClientRect();
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;
  popup.style.left = `${rect.left + scrollX}px`;
  popup.style.top  = `${rect.bottom + scrollY + 4}px`;

  // Clamp to viewport width
  const popupW = 280;
  const maxLeft = document.documentElement.clientWidth - popupW - 8;
  if (rect.left + scrollX > maxLeft) {
    popup.style.left = `${maxLeft + scrollX}px`;
  }

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function _closeDep(e) {
      if (!popup.contains(e.target) && e.target !== btn) {
        popup.remove();
        document.removeEventListener('click', _closeDep);
      }
    });
  }, 0);
}

function simplifyReason(reason) {
  return reason.replace(/CR \d+\.\d+[a-z]?/g, '').replace(/\s{2,}/g, ' ').trim() || reason;
}



/* [KEY: HELPERS] */
/* Strip MTG reminder text (text in parentheses) from oracle text.
   Lines that become empty after stripping are removed. */
function _stripReminderText(text) {
  return (text || '').split('\n').map(line =>
    line.replace(/\([^)]+\)/g, '').replace(/\s+/g, ' ').trim()
  ).filter(Boolean).join('\n');
}

/* Universal data-tooltip handler — appended to <body> so it escapes overflow
   clipping on any panel. Call _initDataTooltip() once on DOMContentLoaded. */
function _initDataTooltip() {
  const el = document.createElement('div');
  el.id = 'data-tooltip';
  el.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;display:none;' +
    'background:var(--surface2);color:var(--text);border:1px solid var(--border-hl);' +
    'border-radius:4px;padding:6px 8px;font-size:11px;line-height:1.4;' +
    'max-width:300px;white-space:normal;box-shadow:0 4px 16px rgba(0,0,0,.35);';
  document.body.appendChild(el);

  document.addEventListener('mouseover', e => {
    const target = e.target.closest('[data-tooltip]');
    if (!target) return;
    el.textContent = target.dataset.tooltip;
    el.style.display = 'block';
    _positionDataTooltip(el, target);
  });
  document.addEventListener('mouseout', e => {
    const target = e.target.closest('[data-tooltip]');
    if (target) el.style.display = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (el.style.display === 'none') return;
    const target = e.target.closest('[data-tooltip]');
    if (target) _positionDataTooltip(el, target);
  });
}

function _positionDataTooltip(tip, anchor) {
  const rect = anchor.getBoundingClientRect();
  const tipW = tip.offsetWidth || 300;
  const tipH = tip.offsetHeight || 40;
  let left = rect.left;
  let top = rect.bottom + 4;
  // Clamp right edge
  if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
  if (left < 4) left = 4;
  // Flip above if too close to bottom
  if (top + tipH > window.innerHeight - 8) top = rect.top - tipH - 4;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

/* Standard modal wrapper: header (title + ×) + body + optional footer.
   Caller is responsible for escaping `title` / passing HTML in `body` and `footer`. */
function _modalShell({ title, closeFn, body, footer, bodyId, footerId }) {
  const bodyIdAttr = bodyId ? ` id="${bodyId}"` : '';
  const footerIdAttr = footerId ? ` id="${footerId}"` : '';
  const footerHtml = footer != null ? `<div class="modal-footer"${footerIdAttr}>${footer}</div>` : '';
  return `<div class="modal">
    <div class="modal-header">
      <h3>${title}</h3>
      <button class="modal-close" onclick="${closeFn}()">×</button>
    </div>
    <div class="modal-body"${bodyIdAttr}>${body}</div>
    ${footerHtml}
  </div>`;
}

/* Render one row in a modal target picker. `onClick` is the JS string for the row's
   onclick attribute. `idForClick` lets the caller bind selection to a different id
   than perm.id (used by the mutate-stack picker, where one stack maps to many ids). */
function _renderPermItem(perm, finalStates, { onClick, selectedId, selectedClass = 'modal-target-selected', idForClick } = {}) {
  const fs = finalStates.get(perm.id);
  const name = fs ? fs.name : perm.name;
  let typeLineHtml;
  if (fs && typeof _buildTypeLineHtml === 'function') {
    typeLineHtml = _buildTypeLineHtml(fs);
  } else {
    const sups = [...(perm.printedSupertypes || []), ...(perm.printedTypes || [])];
    const subs = perm.printedSubtypes || [];
    const typeStr = subs.length ? sups.join(' ') + ' — ' + subs.join(' ') : sups.join(' ');
    typeLineHtml = escapeHtml(typeStr);
  }
  const cmpId = idForClick != null ? idForClick : perm.id;
  const sel = cmpId === selectedId ? selectedClass : '';
  const img = perm.imageUri ? `<img src="${escapeAttr(perm.imageUri)}" alt="">` : '';
  return `<div class="modal-perm-item ${sel}" onclick="${onClick}">${img}<div class="perm-info"><div class="perm-name">${escapeHtml(name)}</div><div class="perm-type">${typeLineHtml}</div></div></div>`;
}

/* Toggle a selected-class on a single .modal-perm-item within a modal scope. */
function _selectOneOf(overlayId, el, selectedClass) {
  document.querySelectorAll(`#${overlayId} .modal-perm-item`).forEach(item => {
    item.classList.remove(selectedClass);
  });
  el.classList.add(selectedClass);
}

function escapeHtml(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
/* Capitalize the first letter of a user-facing string (UI style rule: every
   sentence presented to the user starts with a capital). Only the leading
   character is touched, and only if it's a lowercase letter — strings that
   begin with a symbol/number (e.g. "+1/+1", "{T}: ...") are left untouched so
   we never wrongly uppercase a mid-phrase word. Apply at render boundaries,
   after any _replaceThisCard / _replaceYouControl / simplifyReason substitution. */
function capitalizeFirst(str) {
  if (str == null) return str;
  const s = String(str);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* In-app confirm dialog. Replaces native confirm() for destructive actions.
   message: plain text to display.  onConfirm: called if user clicks Confirm. */
function confirmAction(message, onConfirm) {
  const overlayId = 'confirm-action-overlay';
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
      <h3>Confirm</h3>
      <button class="modal-close">×</button>
    </div>
    <div class="modal-body">
      <p class="confirm-message">${escapeHtml(message)}</p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-danger btn-sm" id="confirm-action-ok">Confirm</button>
      <button class="btn btn-sm" id="confirm-action-cancel">Cancel</button>
    </div>`;

  modal.querySelector('.modal-close').addEventListener('click', _close);
  modal.querySelector('#confirm-action-cancel').addEventListener('click', _close);
  modal.querySelector('#confirm-action-ok').addEventListener('click', () => { _close(); onConfirm(); });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector('#confirm-action-ok').focus();
}
/* [END: HELPERS] */
