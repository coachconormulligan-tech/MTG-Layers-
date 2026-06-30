/* [KEY: TIMESTAMP-UI] */
function renderTimestampPanel() {
  const container = document.getElementById('timestamp-list');
  const allItems = Battlefield.permanents.slice().sort((a, b) => a.timestamp - b.timestamp);

  if (allItems.length === 0) {
    container.innerHTML = '<div class="ts-empty">No cards added yet</div>';
    return;
  }

  // Compute final states for all real permanents to extract triggered/activated abilities
  const finalStates = Battlefield.getAllFinalStates();

  container.innerHTML = allItems.map((p, i) => {
    const effInfo = getEffectInfo(p.id, finalStates.get(p.id));
    let textBadgeLabel = 'Text';
    if (effInfo.textChangeType === 'creature_type') textBadgeLabel = 'Type-text';
    else if (effInfo.textChangeType === 'color_global') textBadgeLabel = 'Color-all';
    else if (effInfo.textChangeType === 'exchange_text') textBadgeLabel = 'Exchange';
    else if (effInfo.textChangeType === 'volrath_text') textBadgeLabel = 'Volrath';
    const stack = Battlefield.getStack(p.id);
    const stackPresent = stack ? stack.filter(id => Battlefield.permanents.some(pp => pp.id === id)) : null;
    const inStack = stackPresent && stackPresent.length >= 2;
    const isTop = inStack && stackPresent[0] === p.id;
    const stackPos = inStack ? (isTop ? 'top' : (stackPresent[stackPresent.length-1] === p.id ? 'bottom' : 'middle')) : null;
    const mutateBadge = inStack
      ? `<span class="ts-badge ts-badge-mutate" title="Mutate stack position: ${stackPos}">Mutate: ${stackPos}</span>`
      : '';
    const bestowTarget = Battlefield.getBestowTarget(p.id);
    const isBestowActive = !!bestowTarget;
    const bestowTargetPerm = bestowTarget ? Battlefield.permanents.find(pp => pp.id === bestowTarget) : null;
    const bestowBadge = isBestowActive
      ? `<span class="ts-badge ts-badge-bestow" title="Enchanting: ${bestowTargetPerm ? bestowTargetPerm.name : bestowTarget}">Aura</span>`
      : '';
    const showBestowBtn = p.hasBestow && !p.isManualEffect && !_isNonTokenCopyCard(p);
    const showMutateBtn = p.hasMutate && !p.isManualEffect && !_isNonTokenCopyCard(p);
    const showImprintBtn = p.hasImprint && !p.isManualEffect && !_isNonTokenCopyCard(p);

    // --- Triggered/activated ability badge for spell-like entries ---
    let abilityBadge = '';
    if (p.isTriggeredAbility) abilityBadge = '<span class="ts-badge ts-badge-trigger">Triggered ability</span>';
    else if (p._isCrewEffect) abilityBadge = '<span class="ts-badge ts-badge-crew">Crewed</span>';
    else if (p._isSaddleEffect) abilityBadge = '<span class="ts-badge ts-badge-saddle">Saddled</span>';
    else if (p.isActivatedAbility) abilityBadge = '<span class="ts-badge ts-badge-activated">Activated ability</span>';

    // --- Triggered/activated ability buttons for real permanents ---
    let abilityButtonsHtml = '';
    let hasAnyParsableAbility = false;
    if (!p.isManualEffect) {
      const fState = finalStates.get(p.id);
      const permEffects = Battlefield.effects.filter(e => e.sourceId === p.id);
      if (fState) {
        const triggers = Battlefield.extractTriggeredAbilities(fState.abilities || []);
        const activated = Battlefield.extractActivatedAbilities(fState.abilities || []);
        if (triggers.length || activated.length) {
          hasAnyParsableAbility = true;
          const total = triggers.length + activated.length;
          abilityButtonsHtml = `<div class="ts-ability-buttons">
            <button class="ts-ability-btn ts-ability-popup-btn"
              onclick="event.stopPropagation(); openAbilityPopup('${escapeAttr(p.id)}')"
              title="View triggered & activated abilities">Abilities (${total})</button>
          </div>`;
        }
      }
      if (permEffects.length > 0) hasAnyParsableAbility = true;
      // CR 702.16 — printed protection is a real, recognized ability even though it
      // generates no continuous effect (the engine consumes it from state.abilities).
      if (!hasAnyParsableAbility && typeof _parseProtectionAbility === 'function') {
        const printed = (fState && fState.abilities) || p.printedAbilities || [];
        if (printed.some(a => _parseProtectionAbility(a).length > 0)) {
          hasAnyParsableAbility = true;
        }
      }
    } else {
      hasAnyParsableAbility = true; // manual effects are always "parsed"
    }

    // --- Remove button for triggered/activated ability entries ---
    const showAbilityRemove = p.isTriggeredAbility || p.isActivatedAbility;

    return `
    <div class="ts-item ${p.isManualEffect ? 'ts-item-manual' : ''}${p.isTriggeredAbility ? ' ts-item-trigger' : ''}${p.isActivatedAbility ? ' ts-item-activated' : ''}${p.isEmblem ? ' ts-item-emblem' : ''}" draggable="true" data-id="${p.id}">
      <span class="ts-handle">⠿</span>
      <span class="ts-number">${i + 1}.</span>
      <span class="ts-name">${escapeHtml(p.name)}${finalStates.get(p.id)?.copySource ? '<span class="ts-copy-label"> (Copy)</span>' : ''}${p.label ? ` <span class="ts-name-label">${escapeHtml(p.label)}</span>` : ''}${Battlefield.players.length > 1 && p.owner ? ` <span class="ts-player-badge">${escapeHtml(Battlefield.getPlayerName(p.owner))}</span>` : ''}</span>
      ${p.isEmblem ? '<span class="ts-badge ts-badge-emblem">Emblem</span>' : ''}
      ${p.isManualEffect && !p.isTriggeredAbility && !p.isActivatedAbility ? '<span class="ts-badge ts-badge-spell">Spell</span>' : ''}
      ${abilityBadge}
      ${effInfo.hasCopy ? '<span class="ts-badge ts-badge-copy">Copy</span>' : ''}
      ${effInfo.hasText ? '<span class="ts-badge ts-badge-text">' + textBadgeLabel + '</span>' : ''}
      ${effInfo.hasExchangeControl ? '<span class="ts-badge ts-badge-exchange">Exchange</span>' : ''}
      ${mutateBadge}
      ${bestowBadge}
      ${effInfo.hasCopyCard ? renderCopyTargetSelect(p.id) : ''}
      ${effInfo.targetSlotCount > 0 ? Array.from({length: effInfo.targetSlotCount}, (_, i) => renderSlottedTargetSelect(p.id, i)).join('') : effInfo.hasModalTargets ? renderModalModeTargets(p.id, effInfo.activeModalTargetedModes) : effInfo.hasTargeted ? (effInfo.maxTargets > 1 ? renderMultiTargetSelect(p.id, effInfo.maxTargets) : renderTargetSelect(p.id)) : ''}
      ${p._targetsOpponentPlayer ? renderTargetOpponentSelect(p.id) : ''}
      ${p._targetsChosenPlayer ? renderTargetPlayerSelect(p.id) : ''}
      ${p._isEnchantPlayer ? renderEnchantedPlayerSelect(p.id) : ''}
      <div class="ts-actions">
        ${effInfo.hasCopyToken ? `<button class="ts-action-btn configure" onclick="event.stopPropagation(); openCopyModal('${p.id}')" title="Select copy source">Copy</button>` : ''}
        ${effInfo.hasText && effInfo.textChangeType !== 'volrath_text' ? `<button class="ts-action-btn configure" onclick="event.stopPropagation(); openTextChangeModal('${p.id}')" title="Configure text change">Edit</button>` : ''}
        ${effInfo.hasExchangeControl ? `<button class="ts-action-btn configure" onclick="event.stopPropagation(); openExchangeControlModal('${p.id}')" title="Configure exchange control">Exchange</button>` : ''}
        ${showMutateBtn ? `<button class="ts-action-btn configure mutate-btn${inStack ? ' mutate-active' : ''}" onclick="event.stopPropagation(); openMutateModal('${p.id}')" title="Mutate">Mutate</button>` : ''}
        ${inStack ? `<button class="ts-action-btn remove-mutate-btn" onclick="event.stopPropagation(); removeMutate('${p.id}')" title="Remove from mutate stack">✕</button>` : ''}
        ${showBestowBtn ? `<button class="ts-action-btn configure bestow-btn${isBestowActive ? ' bestow-active' : ''}" onclick="event.stopPropagation(); openBestowModal('${p.id}')" title="Bestow">Bestow</button>` : ''}
        ${isBestowActive ? `<button class="ts-action-btn remove-mutate-btn" onclick="event.stopPropagation(); removeBestow('${p.id}')" title="Remove bestow">✕</button>` : ''}
        ${showImprintBtn ? renderImprintButton(p.id) : ''}
        ${showAbilityRemove ? `<button class="ts-action-btn remove-mutate-btn" onclick="event.stopPropagation(); removeAbilityEffect('${p.id}')" title="Remove">✕</button>` : ''}
      </div>
      ${effInfo.hasCDA ? renderCDAInput(p) : ''}
      ${p.hasXValue ? renderXValueInput(p) : ''}
      ${p.needsChosenCardName ? renderChosenCardNameInput(p) : ''}
      ${p.needsChosenCreatureType ? renderChosenCreatureTypeInput(p) : ''}
      ${p.needsChosenLandType ? renderChosenLandTypeInput(p) : ''}
      ${p.needsChosenColor ? renderChosenColorInput(p) : ''}
      ${p.needsChosenCardType ? renderChosenCardTypeInput(p) : ''}
      ${p.isModalSpell && p.modalModeTexts && p.modalModeTexts.length > 0 ? renderModalModeToggles(p.id) : ''}
      ${abilityButtonsHtml}
      ${!hasAnyParsableAbility ? '<div class="ts-no-parse-label">no parsable abilities</div>' : ''}
    </div>`;
  }).join('');

  initDragDrop(container);
}


/* [KEY: DRAGDROP] */
function initDragDrop(container) {
  let draggedEl = null;

  container.querySelectorAll('.ts-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      draggedEl = item;
      item.classList.add('ts-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('ts-dragging');
      container.querySelectorAll('.ts-item').forEach(el => el.classList.remove('ts-dragover'));
      const newOrder = [...container.querySelectorAll('.ts-item')].map(el => el.dataset.id);
      Battlefield.reorderTimestamps(newOrder);
      Battlefield.evaluate();
      renderAll();
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (item === draggedEl) return;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        container.insertBefore(draggedEl, item);
      } else {
        container.insertBefore(draggedEl, item.nextSibling);
      }
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
/* [END: DRAGDROP] */

/* [KEY: INSPECTOR-UI] */
