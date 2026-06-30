/* ui-modal-snapshot.js — Board snapshot popup (camera button on spells/abilities).
   Shows the captured _firedAtSnapshot states. Extracted from ui-modals.js. */

/* ============================================================================
   Board Snapshot popup ("camera" button on spells/abilities)
   ========================================================================= */

/* Inline camera SVG button, styled like the top-right header icons. */
function _renderSnapshotCameraBtn(permId) {
  return `<button class="header-icon-button insp-snapshot-btn"
      onclick="event.stopPropagation(); openSnapshotPopup('${permId}')"
      title="View board snapshot when this was added"
      aria-label="Board snapshot">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 8h3l2-2h6l2 2h3v11H4z"></path>
      <circle cx="12" cy="13.5" r="3.5"></circle>
    </svg>
  </button>`;
}

/* Holds the current snapshot popup's data + which card is selected in the right pane. */
let _snapshotPopupState = null;

function openSnapshotPopup(permId) {
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;
  const snap = perm._firedAtSnapshot;
  if (!snap) return;
  const kindLabel = perm.isSpell ? 'spell'
    : perm.isTriggeredAbility ? 'triggered ability'
    : perm.isActivatedAbility ? 'activated ability'
    : 'spell/ability';
  // Pick an initial selection: the source permanent if it's in the snapshot,
  // otherwise the first permanent in the snapshot.
  const snapPermIds = (snap.perms || []).filter(p => !p.isEmblem).map(p => p.id);
  const sourceId = perm.abilitySourceId || null;
  const initialSelected = (sourceId && snapPermIds.includes(sourceId))
    ? sourceId
    : (snapPermIds[0] || null);
  _snapshotPopupState = { snap, selectedId: initialSelected, kindLabel };

  const overlay = _createModalOverlay('snapshot-modal-overlay', closeSnapshotPopup);
  overlay.innerHTML = _modalShell({
    title: `Board Snapshot — ${escapeHtml(perm.name)}`,
    closeFn: 'closeSnapshotPopup',
    body: `
      <p class="snapshot-desc">
        This is the state of the board as of the resolution of this ${kindLabel}.
        This is what the ability checks to determine what it applies to.
      </p>
      <p class="snapshot-hint">Click a card on the left to see its final computed state at this moment on the right.</p>
      <div class="snapshot-split">
        <div class="snapshot-board" id="snapshot-board-container"></div>
        <div class="snapshot-detail" id="snapshot-detail-container"></div>
      </div>
    `,
    footer: `<button class="btn" onclick="closeSnapshotPopup()">Close</button>`,
  });
  document.body.appendChild(overlay);
  renderSnapshotBoard(document.getElementById('snapshot-board-container'), snap);
  renderSnapshotDetail();
}

function closeSnapshotPopup() {
  const el = document.getElementById('snapshot-modal-overlay');
  if (el) el.remove();
  _snapshotPopupState = null;
}

/* Click handler for a card in the snapshot popup's left pane. */
function selectSnapshotCard(permId) {
  if (!_snapshotPopupState) return;
  _snapshotPopupState.selectedId = permId;
  // Update selected outline on cards
  const board = document.getElementById('snapshot-board-container');
  if (board) {
    board.querySelectorAll('.bf-card.bf-card-snapshot-selected').forEach(el =>
      el.classList.remove('bf-card-snapshot-selected'));
    const sel = board.querySelector(`.bf-card[data-snap-id="${permId}"]`);
    if (sel) sel.classList.add('bf-card-snapshot-selected');
  }
  renderSnapshotDetail();
}

/* Render the right-pane "final computed state" view for the selected snapshot card.
   Reuses ui-inspector's renderStateBlock so the layout matches the live inspector exactly. */
function renderSnapshotDetail() {
  const detail = document.getElementById('snapshot-detail-container');
  if (!detail || !_snapshotPopupState) return;
  const { snap, selectedId } = _snapshotPopupState;
  if (!selectedId) {
    detail.innerHTML = `<div class="snapshot-detail-empty">Select a card to see its final state.</div>`;
    return;
  }
  const states = snap.states instanceof Map ? snap.states : new Map(Object.entries(snap.states || {}));
  const perm = (snap.perms || []).find(p => p.id === selectedId);
  const state = states.get(selectedId);
  if (!perm || !state) {
    detail.innerHTML = `<div class="snapshot-detail-empty">No state data for this card.</div>`;
    return;
  }
  const isRulesMode = Battlefield.explanationMode === 'rules';
  const stateHtml = (typeof renderStateBlock === 'function')
    ? renderStateBlock(state, isRulesMode, state.name || perm.name)
    : `<pre>${escapeHtml(JSON.stringify(state, null, 2))}</pre>`;
  const ptHtml = (state.types || []).includes('Creature')
    ? `<div class="insp-final-pt">${escapeHtml(String(state.power))} / ${escapeHtml(String(state.toughness))}</div>`
    : '';
  detail.innerHTML = `
    <div class="snapshot-detail-header">
      ${perm.imageUri ? `<img src="${escapeAttr(perm.imageUri)}" class="snapshot-detail-thumb" alt="">` : ''}
      <div class="snapshot-detail-title">
        <h3>${escapeHtml(state.name || perm.name)}</h3>
        <div class="snapshot-detail-sub">Final computed state at this moment</div>
      </div>
    </div>
    <div class="snapshot-detail-body">
      ${stateHtml}
      ${ptHtml}
    </div>
  `;
}

/* Read-only board renderer driven by a captured _firedAtSnapshot.
   Mirrors the visual structure of renderBattlefield (per-player grouping, card art,
   P/T overlay, counter badges, attached fan) but does not bind interactive handlers
   and does not run SBA detection. */
function renderSnapshotBoard(container, snap) {
  if (!container) return;
  const { perms, states, mutateStacks, bestowTargets, players, activePlayerId } = snap;
  const finalStates = states instanceof Map ? states : new Map(Object.entries(states || {}));

  // Map id -> perm for lookups, filter out emblems and triggered abilities
  const battlefieldPerms = perms.filter(p => !p.isEmblem && !p.isTriggeredAbility && !p.isActivatedAbility);
  const permById = new Map(battlefieldPerms.map(p => [p.id, p]));

  // Group perms by controller (post-Layer-2 controller from final state, falling back to owner)
  const groupsByController = new Map();
  for (const p of battlefieldPerms) {
    const ctrl = (finalStates.get(p.id)?.controller) || p.owner || (activePlayerId || 'player_0');
    if (!groupsByController.has(ctrl)) groupsByController.set(ctrl, []);
    groupsByController.get(ctrl).push(p);
  }

  // Player render order: active player first, then others
  const playerOrder = [];
  if (activePlayerId && groupsByController.has(activePlayerId)) playerOrder.push(activePlayerId);
  for (const pl of (players || [])) {
    if (pl.id !== activePlayerId && groupsByController.has(pl.id)) playerOrder.push(pl.id);
  }
  // Add any controller seen in perms that wasn't in the players array (defensive)
  for (const ctrl of groupsByController.keys()) {
    if (!playerOrder.includes(ctrl)) playerOrder.push(ctrl);
  }

  if (battlefieldPerms.length === 0) {
    container.innerHTML = `<div class="snapshot-empty">No permanents were on the battlefield.</div>`;
    return;
  }

  // Pre-compute attachers per target so we can fan auras/equipment behind their target.
  // Snapshot perms don't carry effects, so we infer attachment from perm.targetId + bestowTargets.
  const attachersByTarget = new Map();
  const attacherIds = new Set();
  for (const p of battlefieldPerms) {
    const fs = finalStates.get(p.id);
    const subs = fs ? (fs.subtypes || []) : (p.printedSubtypes || []);
    const isAura = subs.includes('Aura');
    const isEquipment = subs.includes('Equipment');
    if (!isAura && !isEquipment) continue;
    let targetId = (p.hasBestow && bestowTargets) ? bestowTargets[p.id] : null;
    if (!targetId) targetId = p.targetId || null;
    if (!targetId || !permById.has(targetId) || targetId === p.id) continue;
    if (!attachersByTarget.has(targetId)) attachersByTarget.set(targetId, []);
    attachersByTarget.get(targetId).push(p);
    attacherIds.add(p.id);
  }

  // Mutate stacks (one card == one stack-top in the snapshot)
  const stackTopById = new Map();
  const inAnyStack = new Set();
  for (const stack of (mutateStacks || [])) {
    if (stack.length >= 2) {
      stackTopById.set(stack[0], stack);
      for (const id of stack) inAnyStack.add(id);
    }
  }

  function renderSnapPT(p) {
    const fs = finalStates.get(p.id);
    if (!fs) return '';
    if (!(fs.types || []).includes('Creature')) return '';
    const pw = (fs.power !== null && fs.power !== undefined) ? fs.power : p.printedPower;
    const tg = (fs.toughness !== null && fs.toughness !== undefined) ? fs.toughness : p.printedToughness;
    if (pw === null || pw === undefined) return '';
    return `<div class="snapshot-card-pt">${escapeHtml(String(pw))}/${escapeHtml(String(tg))}</div>`;
  }

  function renderSnapBadges(p) {
    const parts = [];
    if (p.isToken) parts.push('<div class="bf-card-token-badge">TOKEN</div>');
    if (p.isSpell || (p.isManualEffect && !p.isTriggeredAbility && !p.isActivatedAbility))
      parts.push('<div class="bf-card-spell-badge">SPELL</div>');
    if (p.isTriggeredAbility) parts.push('<div class="bf-card-spell-badge bf-card-trigger-badge">TRIGGER</div>');
    if (p.isActivatedAbility) parts.push('<div class="bf-card-spell-badge bf-card-activated-badge">ACTIVATED</div>');
    if (p._isCrewEffect) parts.push('<div class="bf-card-spell-badge bf-card-crew-badge">CREWED</div>');
    if (p._isSaddleEffect) parts.push('<div class="bf-card-spell-badge bf-card-saddle-badge">SADDLED</div>');
    if (p.isFaceDown) {
      const m = p.faceDownMode === 'cloak' ? 'CLOAK' : p.faceDownMode === 'manifest' ? 'MANIFEST' : 'MORPH';
      parts.push(`<div class="bf-card-facedown-badge">${m}</div>`);
    }
    return parts.join('');
  }

  function renderSnapCounters(p) {
    if (typeof renderBfCounterBadges === 'function') return renderBfCounterBadges(p);
    return '';
  }

  function renderSnapCard(p) {
    const tapped = p.tapped ? ' bf-card-tapped' : '';
    const faceDown = p.isFaceDown ? ' bf-card-facedown' : '';
    const sideways = p.isSideways ? ' bf-card-sideways' : '';
    const spellish = (p.isManualEffect || p.isSpell) ? ' bf-card-spell' : '';
    const selected = (_snapshotPopupState && _snapshotPopupState.selectedId === p.id) ? ' bf-card-snapshot-selected' : '';
    const img = p.imageUri
      ? `<img src="${escapeAttr(p.imageUri)}" alt="${escapeAttr(p.name)}" class="bf-card-img">`
      : `<div class="bf-card-no-img"><span>${escapeHtml(p.name)}</span></div>`;
    return `<div class="bf-card bf-card-snapshot${tapped}${faceDown}${sideways}${spellish}${selected}"
        data-snap-id="${escapeAttr(p.id)}"
        onclick="selectSnapshotCard('${escapeAttr(p.id)}')">
      ${img}
      ${p.label ? `<div class="bf-card-label" aria-hidden="true">${escapeHtml(p.label)}</div>` : ''}
      <div class="bf-card-overlay"></div>
      ${renderSnapBadges(p)}
      ${renderSnapCounters(p)}
    </div>`;
  }

  function renderSnapAttached(targetPerm, innerHtml) {
    const list = attachersByTarget.get(targetPerm.id) || [];
    if (!list.length) return innerHtml;
    const total = list.length;
    const fan = list.map((ap, i) =>
      `<div class="bf-attached" style="--i:${i}; --n:${total};">${renderSnapAttached(ap, renderSnapCard(ap))}</div>`
    ).join('');
    return `<div class="bf-attach-group"><div class="bf-attach-target">${innerHtml}</div><div class="bf-attached-fan">${fan}</div></div>`;
  }

  function renderPerm(p) {
    if (attacherIds.has(p.id)) return ''; // fan'd behind their target
    if (inAnyStack.has(p.id) && !stackTopById.has(p.id)) return ''; // only top of stack renders
    if (stackTopById.has(p.id)) {
      const stack = stackTopById.get(p.id);
      const cards = stack.map(id => permById.get(id)).filter(Boolean);
      const top = cards[0];
      const topFs = finalStates.get(top.id);
      const mergedName = topFs ? topFs.name : top.name;
      const stackHtml = `<div class="bf-mutate-stack">
        <div class="bf-mutate-stack-label">Mutate: ${escapeHtml(mergedName)}</div>
        <div class="bf-mutate-stack-cards">
          ${cards.map((sp, idx) => {
            const isNonTop = idx !== 0;
            const stackLabel = idx === 0 ? '<div class="bf-mutate-pos-badge">TOP</div>'
              : (idx === cards.length - 1 ? '<div class="bf-mutate-pos-badge bf-mutate-pos-bottom">BTM</div>'
                 : '<div class="bf-mutate-pos-badge bf-mutate-pos-mid">MID</div>');
            const cardHtml = renderSnapCard(sp).replace('class="bf-card', `class="bf-card bf-card-in-stack${isNonTop ? ' bf-card-stack-non-top' : ''}`);
            return cardHtml + stackLabel;
          }).join('')}
        </div>
      </div>`;
      return renderSnapAttached(top, stackHtml);
    }
    return renderSnapAttached(p, renderSnapCard(p));
  }

  function playerLabel(ctrl) {
    const found = (players || []).find(pl => pl.id === ctrl);
    return found ? found.name : ctrl;
  }

  const sections = playerOrder.map(ctrl => {
    const ownPerms = (groupsByController.get(ctrl) || []).slice().sort((a, b) => a.timestamp - b.timestamp);
    const isActive = ctrl === activePlayerId;
    const cardsHtml = ownPerms.map(renderPerm).filter(Boolean).join('');
    if (!cardsHtml.trim()) return '';
    return `<div class="snapshot-player-section">
      <div class="snapshot-player-label${isActive ? ' snapshot-player-label-active' : ''}">${escapeHtml(playerLabel(ctrl))}${isActive ? ' (active player)' : ''}</div>
      <div class="snapshot-player-cards">${cardsHtml}</div>
    </div>`;
  }).join('');

  container.innerHTML = sections;
}

