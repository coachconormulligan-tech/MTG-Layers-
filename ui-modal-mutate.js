/* ui-modal-mutate.js — Mutate target selection modal (CR 702.140).
   Extracted from ui-modals.js. */

/* [KEY: MODAL-MUTATE]  —  Mutate position selection + target selection modal */
function openMutateModal(permId) {
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;

  // Find non-Human creature targets (other than this card itself or cards in its own stack)
  const myStack = Battlefield.getStack(permId) || [];
  const finalStates = Battlefield.getAllFinalStates();

  // Valid targets: non-Human creatures the mutating card's controller controls, not in its own stack
  const mutatersController = perm.controller || perm.owner || 'player_0';
  const validTargets = Battlefield.permanents.filter(p => {
    if (p.isManualEffect || p.id === permId) return false;
    if (myStack.includes(p.id)) return false; // can't mutate within same stack
    const fs = finalStates.get(p.id);
    const types = fs ? fs.types : p.printedTypes;
    const subtypes = fs ? fs.subtypes : (p.printedSubtypes || []);
    // CR 702.140b: you can only mutate onto a non-Human creature you control
    const targetController = (fs && fs.controller) ? fs.controller : (p.controller || p.owner || 'player_0');
    return types.includes('Creature') && !subtypes.includes('Human') && targetController === mutatersController;
  });

  // Determine currently selected target (if already in a stack together)
  const currentStack = Battlefield.getStack(permId);
  let currentTargetId = '';
  if (currentStack) {
    const pos = currentStack.indexOf(permId);
    // Current adjacent card in the stack
    if (pos === 0) currentTargetId = currentStack[1] || '';
    else currentTargetId = currentStack[pos - 1] || '';
  }

  // Figure out current position in the stack
  const currentPos = currentStack
    ? (currentStack[0] === permId ? 'top' : 'under')
    : 'top';

  // Group targets: standalone vs already-in-a-stack
  const standaloneTargets = validTargets.filter(p => !Battlefield.getStack(p.id));
  const stackedTargets = validTargets.filter(p => {
    const s = Battlefield.getStack(p.id);
    return s && s.length >= 2;
  });
  // Deduplicate stacked targets — show one entry per stack (representing the whole stack)
  const shownStackIds = new Set();
  const stackTargetGroups = [];
  for (const p of stackedTargets) {
    const s = Battlefield.getStack(p.id);
    const key = s.join(',');
    if (!shownStackIds.has(key)) {
      shownStackIds.add(key);
      stackTargetGroups.push({ stack: s, perms: s.map(id => Battlefield.permanents.find(pp => pp.id === id)).filter(Boolean) });
    }
  }

  const overlay = _createModalOverlay('mutate-modal-overlay', closeMutateModal);

  const renderTarget = (t, targetIdToUse) => _renderPermItem(t, finalStates, {
    onClick: `selectMutateTarget('${permId}', '${targetIdToUse}', this)`,
    selectedId: currentTargetId,
    selectedClass: 'mutate-target-selected',
    idForClick: targetIdToUse,
  });

  let targetsHtml = '';
  if (standaloneTargets.length === 0 && stackTargetGroups.length === 0) {
    targetsHtml = '<div class="dim" style="padding:8px 0">No valid non-Human creatures on the battlefield.</div>';
  } else {
    if (standaloneTargets.length > 0) {
      targetsHtml += `<div class="modal-perm-list">${standaloneTargets.map(t => renderTarget(t, t.id)).join('')}</div>`;
    }
    if (stackTargetGroups.length > 0) {
      targetsHtml += `<div class="modal-section-title">Existing Mutate Stacks</div>`;
      for (const grp of stackTargetGroups) {
        const topPerm = grp.perms[0];
        const topFs = finalStates.get(topPerm ? topPerm.id : '');
        const stackName = topFs ? topFs.name : (topPerm ? topPerm.name : 'Stack');
        targetsHtml += `<div class="mutate-stack-group">
          <div class="mutate-stack-group-label">Mutate: ${escapeHtml(stackName)} (${grp.perms.length} cards)</div>
          <div class="modal-perm-list">${grp.perms.map(t => renderTarget(t, t.id)).join('')}</div>
        </div>`;
      }
    }
  }

  overlay.innerHTML = _modalShell({
    title: `Mutate - ${escapeHtml(perm.name)}`,
    closeFn: 'closeMutateModal',
    body: `
      <div class="modal-section-title">Position</div>
      <div class="mutate-position-row">
        <label class="mutate-position-label">
          <input type="radio" name="mutate-pos" value="top" ${currentPos === 'top' ? 'checked' : ''}>
          <span><strong>On top</strong> — this card's name, types &amp; P/T become the merged creature's identity; it gains all abilities from the stack</span>
        </label>
        <label class="mutate-position-label">
          <input type="radio" name="mutate-pos" value="under" ${currentPos === 'under' ? 'checked' : ''}>
          <span><strong>Under</strong> — goes under the target (or stack); target's top card keeps its identity; this card contributes its abilities</span>
        </label>
      </div>
      <div class="modal-section-title">Select Non-Human Creature Target</div>
      ${targetsHtml}`,
    footer: `
      <button class="btn btn-sm" onclick="closeMutateModal()">Cancel</button>
      <button class="btn-accent" onclick="applyMutateModal('${permId}')">Apply Mutate</button>`,
  });

  document.body.appendChild(overlay);

  // Pre-select the currently tracked target if any
  if (currentTargetId) {
    _mutateSelectedTargetId = currentTargetId;
  }
}

let _mutateSelectedTargetId = null;

function selectMutateTarget(mutaterId, targetId, el) {
  _mutateSelectedTargetId = targetId;
  _selectOneOf('mutate-modal-overlay', el, 'mutate-target-selected');
}

function applyMutateModal(mutaterId) {
  const posInput = document.querySelector('input[name="mutate-pos"]:checked');
  const position = posInput ? posInput.value : 'top';

  if (!_mutateSelectedTargetId) {
    alert('Please select a target creature.');
    return;
  }

  Battlefield.applyMutate(mutaterId, _mutateSelectedTargetId, position);
  _mutateSelectedTargetId = null;
  closeMutateModal();
  Battlefield.evaluate();
  renderAll();
  // Re-select the currently inspected permanent so the inspector reflects the new mutate state
  if (Battlefield.inspectedId) {
    selectPermanent(Battlefield.inspectedId);
  }
}

function closeMutateModal() {
  const overlay = document.getElementById('mutate-modal-overlay');
  if (overlay) overlay.remove();
  _mutateSelectedTargetId = null;
}

function removeMutate(permId) {
  Battlefield.removeMutate(permId);
  Battlefield.evaluate();
  renderAll();
}
/* [END: MODAL-MUTATE] */

