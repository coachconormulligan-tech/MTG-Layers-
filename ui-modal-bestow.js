/* ui-modal-bestow.js — Bestow target selection modal (CR 702.102).
   Extracted from ui-modals.js. */

/* [KEY: MODAL-BESTOW]  —  Bestow target selection modal */
function openBestowModal(permId) {
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;

  const finalStates = Battlefield.getAllFinalStates();
  const currentTargetId = Battlefield.getBestowTarget(permId) || '';

  const bestowCtrl = perm.controller || perm.owner || 'player_0';
  // Valid targets: any creature on the battlefield that is not the bestow creature itself.
  // Non-top mutate stack members are not independently targetable (CR 702.140 — stack is one permanent).
  const validTargets = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === permId) return false;
    const fs = finalStates.get(p.id);
    const types = fs ? fs.types : (p.printedTypes || []);
    if (!types.includes('Creature')) return false;
    const stack = Battlefield.getStack(p.id);
    if (stack && stack.length >= 2 && stack[0] !== p.id) return false;
    const tAbilities = fs ? (fs.abilities || []) : [];
    // Shroud prevents being targeted by anyone
    if (tAbilities.some(a => /\bshroud\b/i.test(a))) return false;
    // Hexproof prevents being targeted by opponents
    const tCtrl = p.controller || p.owner || 'player_0';
    if (tCtrl !== bestowCtrl && tAbilities.some(a => /\bhexproof\b/i.test(a))) return false;
    // CR 702.16 — protection: bestow targets the creature, so protection from source applies.
    const sourceFs = finalStates.get(permId);
    if (typeof _isProtectedFromSource === 'function'
        && _isProtectedFromSource(fs, sourceFs, perm, p)) return false;
    return true;
  });

  const overlay = _createModalOverlay('bestow-modal-overlay', closeBestowModal);

  const renderTarget = (t) => _renderPermItem(t, finalStates, {
    onClick: `selectBestowTarget('${permId}', '${t.id}', this)`,
    selectedId: currentTargetId,
    selectedClass: 'bestow-target-selected',
  });

  const targetsHtml = validTargets.length === 0
    ? '<div class="dim" style="padding:8px 0">No creatures on the battlefield to enchant.</div>'
    : `<div class="modal-perm-list">${validTargets.map(renderTarget).join('')}</div>`;

  overlay.innerHTML = _modalShell({
    title: `Bestow - ${escapeHtml(perm.name)}`,
    closeFn: 'closeBestowModal',
    body: `
      <p class="dim" style="margin-bottom:10px;font-size:0.85em">
      CR 702.102: While enchanting a creature via bestow, this card is an Aura enchantment, not a creature.
      If the enchanted creature leaves the battlefield, this card becomes a creature again.
      </p>
      <div class="modal-section-title">Select Creature to Enchant</div>
      ${targetsHtml}`,
    footer: `
      <button class="btn btn-sm" onclick="closeBestowModal()">Cancel</button>
      <button class="btn-accent" onclick="applyBestowModal('${permId}')">Apply Bestow</button>`,
  });

  document.body.appendChild(overlay);

  if (currentTargetId) {
    _bestowSelectedTargetId = currentTargetId;
  }
}

let _bestowSelectedTargetId = null;

function selectBestowTarget(bestowPermId, targetId, el) {
  _bestowSelectedTargetId = targetId;
  _selectOneOf('bestow-modal-overlay', el, 'bestow-target-selected');
}

function applyBestowModal(bestowPermId) {
  if (!_bestowSelectedTargetId) {
    alert('Please select a creature to enchant.');
    return;
  }
  Battlefield.applyBestow(bestowPermId, _bestowSelectedTargetId);
  _bestowSelectedTargetId = null;
  closeBestowModal();
  Battlefield.evaluate();
  renderAll();
  if (Battlefield.inspectedId) {
    selectPermanent(Battlefield.inspectedId);
  }
}

function closeBestowModal() {
  const overlay = document.getElementById('bestow-modal-overlay');
  if (overlay) overlay.remove();
  _bestowSelectedTargetId = null;
}

function removeBestow(permId) {
  Battlefield.removeBestow(permId);
  Battlefield.evaluate();
  renderAll();
}
/* [END: MODAL-BESTOW] */

