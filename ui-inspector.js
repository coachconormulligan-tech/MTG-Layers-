/* Global toggle: highlight (in red) anything in a computed state that deviates
   from the card's printed Base State. Off by default; flipped by the button in
   the Final Computed State / Final State on the Stack section heads. */
let _highlightChanges = true;
function toggleHighlightChanges() {
  _highlightChanges = !_highlightChanges;
  renderInspector();
}

/* Small pill button shown in the Final-state section heads that flips the
   highlight-changes toggle. Active state is conveyed via the 'active' class. */
function _renderHighlightToggleBtn() {
  return `<button class="insp-highlight-toggle${_highlightChanges ? ' active' : ''}"`
    + ` onclick="event.stopPropagation(); toggleHighlightChanges()"`
    + ` title="Highlight everything that differs from the printed Base State">`
    + `Highlight changes</button>`;
}

/* Split a string into alternating word / non-word tokens, preserving order and
   separators. Used to diff a text-changed ability (e.g. Mind Bend / New Blood
   swapping "Human" -> "Vampire") against its printed origin so only the swapped
   word is reddened instead of the whole ability line. */
function _tokenizeForDiff(s) {
  return s.match(/[A-Za-z0-9']+|[^A-Za-z0-9']+/g) || [];
}

/* Global toggle: show all effects in the layer vs only those affecting the inspected card */
let _orderShowAll = false;
function toggleOrderShowAll() {
  _orderShowAll = !_orderShowAll;
  // Re-render only the body of each layer section — preserves collapsed state and scroll position
  const result = Battlefield.evaluate();
  if (!result) return;
  const isRulesMode = Battlefield.explanationMode === 'rules';
  const cardName = result.base.name;
  document.querySelectorAll('.insp-section').forEach(section => {
    const badge = section.querySelector('.layer-badge');
    if (!badge) return;
    const layerId = badge.textContent.trim();
    const layer = result.layers.find(l => String(l.id) === layerId);
    if (!layer) return;
    const body = section.querySelector('.insp-section-body');
    if (body) body.innerHTML = renderLayerBody(layer, isRulesMode, cardName, result.base);
  });
}

/* [KEY: INSPECTOR-UI] */
function renderInspector() {
  const panel = document.getElementById('inspector');

  // Check if inspected card is a triggered/activated ability pseudo-perm — show simplified view
  const inspPerm = Battlefield.inspectedId
    ? Battlefield.getPermById(Battlefield.inspectedId) : null;
  // Triggered/activated ability pseudo-perms: simplified view only, no layer inspector.
  // Real spells (isSpell=true, isManualEffect=false) fall through to the full layer inspector below.
  if (inspPerm && inspPerm.isManualEffect && !inspPerm.isSpell) {
    const spellEffects = Battlefield.effects.filter(e => e.sourceId === inspPerm.id);
    const detailLabel = inspPerm.isTriggeredAbility ? 'Triggered Ability'
      : inspPerm.isActivatedAbility ? 'Activated Ability' : 'Spell Details';
    const sourcePerm = inspPerm.abilitySourceId
      ? Battlefield.getPermById(inspPerm.abilitySourceId) : null;
    let html = `<div class="insp-header">
      <div class="insp-title-block">
        <h2 class="insp-title">${escapeHtml(inspPerm.name)}${inspPerm.fullCardName ? `<span class="insp-split-full-name"> (${escapeHtml(inspPerm.fullCardName)})</span>` : ''}</h2>
        ${inspPerm.illustrator ? `<div class="insp-illustrator">Illus. ${escapeHtml(inspPerm.illustrator)}</div>` : ''}
      </div>
      ${inspPerm.imageUri ? `<img src="${inspPerm.imageUri}" class="insp-thumb" alt="">` : ''}
      ${inspPerm.isTransformable ? `<button class="insp-flip-btn" onclick="flipCard('${inspPerm.id}')" title="Transform / Flip">\u21C4 Flip</button>` : ''}
      ${inspPerm.isChooseableFace ? `<button class="insp-flip-btn" onclick="switchSplitFace('${inspPerm.id}')" title="Switch to other half">\u21C4 Switch Half</button>` : ''}
    </div>`;
    html += `<div class="insp-section">
      <div class="insp-section-head insp-section-head-row">
        <h3>${detailLabel}</h3>
        ${inspPerm._firedAtSnapshot ? _renderSnapshotCameraBtn(inspPerm.id) : ''}
      </div>
      <div class="insp-section-body">
        <div class="state-block">`;
    if (sourcePerm) {
      html += `<div class="state-row"><span class="state-label">Source:</span> ${escapeHtml(sourcePerm.name)}</div>`;
    }
    if (inspPerm.abilityFullText) {
      html += `<div class="state-row"><span class="state-label">Full Ability:</span></div>
        <div class="state-oracle">${escapeHtml(_replaceYouControl(inspPerm.abilityFullText, inspPerm.abilitySourceId || inspPerm.id))}</div>`;
    }
    if (!inspPerm.isTriggeredAbility && !inspPerm.isActivatedAbility) {
      html += `<div class="state-row"><span class="state-label">Type:</span> ${escapeHtml([...inspPerm.printedSupertypes, ...inspPerm.printedTypes].join(' '))}${inspPerm.printedSubtypes.length ? ' — ' + escapeHtml(inspPerm.printedSubtypes.join(' ')) : ''}</div>
          <div class="state-row"><span class="state-label">Mana Value:</span> ${escapeHtml(inspPerm.manaCost || '(none)')}</div>`;
    }
    html += `<div class="state-row"><span class="state-label">Effect Text:</span></div>
          <div class="state-oracle">${escapeHtml(_replaceYouControl(inspPerm.oracleText || '(none)', inspPerm.abilitySourceId || inspPerm.id))}</div>
        </div>
      </div>
    </div>`;
    if (spellEffects.length) {
      // Show inline target picker for the pseudo-perm if any of its effects need a target.
      const needsTargetPicker = spellEffects.some(e =>
        e.scope === 'targeted' && !e.selfTarget && !e._isCounterEffect && !e._autoTargetSource);
      html += `<div class="insp-section">
        <div class="insp-section-head"><h3>Effects Produced (${spellEffects.length})</h3></div>
        <div class="insp-section-body"><div class="state-block">`;
      if (needsTargetPicker) {
        html += `<div class="state-row"><span class="state-label">Target:</span> ${renderTargetSelect(inspPerm.id)}</div>`;
      }
      for (const eff of spellEffects) {
        const layerName = LAYER_MAP[eff.layer]?.name || eff.layer;
        const targetName = eff.targetId
          ? (Battlefield.getPermById(eff.targetId)?.name || 'unset')
          : (eff.scope === 'global' ? 'all matching'
             : eff.selfTarget ? 'self'
             : '(no target chosen)');
        html += `<div class="state-row">
          <span class="state-label">${escapeHtml(layerName)}:</span>
          ${escapeHtml(capitalizeFirst(_replaceYouControl(eff.description || eff.type, eff.sourceId || inspPerm.id)))} → <em>${escapeHtml(targetName)}</em>
        </div>`;
      }
      html += `</div></div></div>`;
    }
    panel.innerHTML = html;
    return;
  }

  // Real spells (isSpell=true, isManualEffect=false): build Spell Details prefix, then render
  // the full layer inspector below it so the user can see Layer 3/6 changes applied to the spell.
  const result = Battlefield.evaluate();
  let spellPrefix = '';
  if (inspPerm && inspPerm.isSpell) {
    const spellEffects = Battlefield.effects.filter(e => e.sourceId === inspPerm.id);
    spellPrefix += `<div class="insp-header">
      <div class="insp-title-block">
        <h2 class="insp-title">${escapeHtml(inspPerm.name)}${inspPerm.fullCardName ? `<span class="insp-split-full-name"> (${escapeHtml(inspPerm.fullCardName)})</span>` : ''}</h2>
        ${inspPerm.illustrator ? `<div class="insp-illustrator">Illus. ${escapeHtml(inspPerm.illustrator)}</div>` : ''}
      </div>
      ${inspPerm.imageUri ? `<img src="${inspPerm.imageUri}" class="insp-thumb" alt="">` : ''}
      ${inspPerm.isTransformable ? `<button class="insp-flip-btn" onclick="flipCard('${inspPerm.id}')" title="Transform / Flip">&#x21C4; Flip</button>` : ''}
      ${inspPerm.isChooseableFace ? `<button class="insp-flip-btn" onclick="switchSplitFace('${inspPerm.id}')" title="Switch to other half">&#x21C4; Switch Half</button>` : ''}
    </div>`;
    if (result) {
      const isRulesMode = Battlefield.explanationMode === 'rules';
      spellPrefix += `<div class="insp-section insp-final">
        <div class="insp-section-head insp-section-head-row">
          <h3>Final State on the Stack</h3>
          <span class="insp-head-actions">${_renderHighlightToggleBtn()}${inspPerm._firedAtSnapshot ? _renderSnapshotCameraBtn(inspPerm.id) : ''}</span>
        </div>
        <div class="insp-section-body">
          ${renderStateBlock(result.final, isRulesMode, result.final.name, result.base, true)}
          ${result.final.types.includes('Creature') ? `<div class="insp-final-pt">${_finalPtHtml(result.final, result.base)}</div>` : ''}
        </div>
      </div>`;
    }
    if (spellEffects.length) {
      const needsTargetPicker = spellEffects.some(e =>
        e.scope === 'targeted' && !e.selfTarget && !e._isCounterEffect && !e._autoTargetSource);
      spellPrefix += `<div class="insp-section">
        <div class="insp-section-head"><h3>Effects Produced (${spellEffects.length})</h3></div>
        <div class="insp-section-body"><div class="state-block">`;
      if (needsTargetPicker) {
        spellPrefix += `<div class="state-row"><span class="state-label">Target:</span> ${renderTargetSelect(inspPerm.id)}</div>`;
      }
      for (const eff of spellEffects) {
        const layerName = LAYER_MAP[eff.layer]?.name || eff.layer;
        const targetName = eff.targetId
          ? (Battlefield.getPermById(eff.targetId)?.name || 'unset')
          : (eff.scope === 'global' ? 'all matching'
             : eff.selfTarget ? 'self'
             : '(no target chosen)');
        spellPrefix += `<div class="state-row">
          <span class="state-label">${escapeHtml(layerName)}:</span>
          ${escapeHtml(capitalizeFirst(_replaceYouControl(eff.description || eff.type, eff.sourceId || inspPerm.id)))} → <em>${escapeHtml(targetName)}</em>
        </div>`;
      }
      spellPrefix += `</div></div></div>`;
    }
  }

  if (!result) {
    panel.innerHTML = `<div class="insp-empty">
      <div class="insp-empty-icon">?</div>
      <div>Select a permanent to inspect</div>
      <div class="insp-empty-sub">Click a card on the battlefield</div>
    </div>`;
    return;
  }

  const isRulesMode = Battlefield.explanationMode === 'rules';
  const perm = Battlefield.getPermById(Battlefield.inspectedId);
  const inspFs = perm ? Battlefield.getAllFinalStates().get(perm.id) : null;

  let html = spellPrefix;

  if (!spellPrefix) {
    html += `<div class="insp-header">
    <div class="insp-title-block">
      <h2 class="insp-title">${_highlightChanges && result.final.name !== result.base.name ? `<span class="state-new">${escapeHtml(result.final.name)}</span>` : escapeHtml(result.final.name)}${inspFs?.copySource ? '<span class="insp-copy-label"> (Copy)</span>' : ''}${perm?.fullCardName ? `<span class="insp-split-full-name"> (${escapeHtml(perm.fullCardName)})</span>` : ''}</h2>
      ${perm?.illustrator ? `<div class="insp-illustrator">Illus. ${escapeHtml(perm.illustrator)}</div>` : ''}
    </div>
    ${perm?.imageUri ? `<img src="${perm.imageUri}" class="insp-thumb" alt="">` : ''}
    ${perm?.isTransformable ? `<button class="insp-flip-btn" onclick="flipCard('${perm.id}')" title="Transform / Flip">\u21C4 Flip</button>` : ''}
    ${perm?.isChooseableFace ? `<button class="insp-flip-btn" onclick="openDualOptionsPopup('${perm.id}')" title="Choose half">\u21C4 Choose Half</button>` : ''}
  </div>`;
  }

  if (perm?.isRoom && perm.roomFaces) {
    html += `<div class="insp-section insp-rooms-section">
      <div class="insp-section-head" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="insp-section-arrow">\u25BC</span>
        <h3>Rooms</h3>
      </div>
      <div class="insp-section-body">
        ${perm.roomFaces.map((rf, i) => `
          <div class="insp-room-entry ${perm.roomLocked[i] ? 'insp-room-locked' : 'insp-room-unlocked'}">
            <div class="insp-room-header">
              <span class="insp-room-name">${escapeHtml(rf.name)}</span>
              <span class="insp-room-cost">${escapeHtml(rf.mana_cost)}</span>
              <button class="insp-room-toggle" onclick="toggleRoomLock('${perm.id}', ${i})">
                ${perm.roomLocked[i] ? 'Locked' : 'Unlocked'}
              </button>
            </div>
            ${rf.oracle_text ? `<div class="insp-room-oracle">${escapeHtml(rf.oracle_text).replace(/\n/g, '<br>')}</div>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
  }

  if (!spellPrefix) {
    html += `<div class="insp-section insp-final">
      <div class="insp-section-head insp-section-head-row">
        <h3>Final Computed State</h3>
        <span class="insp-head-actions">${_renderHighlightToggleBtn()}</span>
      </div>
      <div class="insp-section-body">
        ${renderStateBlock(result.final, isRulesMode, result.final.name, result.base, true)}
        ${result.final.types.includes('Creature') ? `<div class="insp-final-pt">${_finalPtHtml(result.final, result.base)}</div>` : ''}
      </div>
    </div>`;
  }

  // Render one layer as its own collapsible section (shared by the Layer 7 group
  // and every standalone layer below).
  const renderLayerSection = (layer) => {
    const hasChanges = layer.applicationLog.some(a => a.changes.length > 0);
    // An effect can apply to the inspected card without producing a visible delta (e.g.
    // "gain control of target creature" cast on a creature you already control). Highlight
    // the layer green whenever an effect applies to this card, even with no net change.
    const appliesToInspected = layer.applicationLog.some(a => a.changes.length > 0 || a.appliedToInspected);
    const statusClass = !layer.active ? 'layer-inactive' : appliesToInspected ? 'layer-changed' : 'layer-unchanged';
    return `<div class="insp-section ${statusClass} collapsed">
      <div class="insp-section-head" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="insp-section-arrow">\u25BC</span>
        <h3>
          <span class="layer-badge">${layer.id}</span>
          ${escapeHtml(layer.name)}
          ${!layer.active ? '<span class="layer-tag inactive">inactive</span>' : ''}
          ${hasChanges ? '<span class="layer-tag changed">modified</span>' : appliesToInspected ? '<span class="layer-tag changed">applied</span>' : ''}
        </h3>
        <span class="layer-cr">${layer.cr}</span>
      </div>
      <div class="insp-section-body">
        ${renderLayerBody(layer, isRulesMode, result.base.name, result.base)}
      </div>
    </div>`;
  };

  const reversed = [...result.layers].reverse();
  const seventh = reversed.filter(l => String(l.id).startsWith('7'));

  // Group the Layer 7 sub-layers (7a\u20137d) under one collapsible "Power/Toughness"
  // accordion at the top, matching their prior top placement. Each sub-layer keeps
  // its own independent collapse state.
  if (seventh.length) {
    const grpApplies = seventh.some(l => l.applicationLog.some(a => a.changes.length > 0 || a.appliedToInspected));
    const grpChanges = seventh.some(l => l.applicationLog.some(a => a.changes.length > 0));
    const grpActive = seventh.some(l => l.active);
    const grpStatus = !grpActive ? 'layer-inactive' : grpApplies ? 'layer-changed' : 'layer-unchanged';
    html += `<div class="insp-section insp-layer-group ${grpStatus} collapsed">
      <div class="insp-section-head" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="insp-section-arrow">\u25BC</span>
        <h3>
          <span class="layer-badge">7</span>
          Power/Toughness
          ${grpChanges ? '<span class="layer-tag changed">modified</span>' : grpApplies ? '<span class="layer-tag changed">applied</span>' : ''}
        </h3>
        <span class="layer-cr">613.4</span>
      </div>
      <div class="insp-section-body insp-layer-group-body">
        ${seventh.map(renderLayerSection).join('')}
      </div>
    </div>`;
  }

  // Remaining layers (6 \u2192 1), each as its own section.
  for (const layer of reversed) {
    if (String(layer.id).startsWith('7')) continue;
    html += renderLayerSection(layer);
  }

  html += `<div class="insp-section collapsed">
    <div class="insp-section-head" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="insp-section-arrow">\u25BC</span>
      <h3>Base State (Printed Characteristics)</h3>
    </div>
    <div class="insp-section-body">
      ${renderStateBlock(result.base, isRulesMode, result.base.name)}
    </div>
  </div>`;

  panel.innerHTML = html;
}

function renderLayerBody(layer, isRulesMode, cardName, baseState) {
  if (!layer.active) {
    return `<div class="layer-note">${isRulesMode
      ? `Layer ${layer.id} (${layer.cr}) is not active in the current MVP build.`
      : 'This layer is not yet active  —  planned for a future update.'}</div>`;
  }

  let html = '';

  if (layer.orderLog.length) {
    // Filter orderLog to only show entries mentioning effects that affect the selected card.
    // Include both the computed source name AND the display name (source + label) because
    // orderLog dependency entries are built with _effectDisplayName (which appends the
    // permanent's label, e.g. "Dralnu's Crusade A") while a.source stores only the base name.
    const relevantSources = new Set(
      layer.applicationLog
        .filter(a => a.changes.length > 0 || a.appliedToInspected || a.reason.includes('lost its abilities'))
        .flatMap(a => {
          const perm = a.sourceId
            ? (typeof Battlefield !== 'undefined' && Battlefield.permanents
                ? Battlefield.getPermById(a.sourceId)
                : null)
            : null;
          const displayName = perm && perm.label ? `${a.source} ${perm.label}` : a.source;
          return [a.source, displayName];
        })
    );
    const filteredLog = layer.orderLog.filter(l => {
      // Always show general status messages and loop warnings
      if (/^No dependencies|^Fallback|^All effects|^Dependency loop/i.test(l)) return true;
      // Show dependency/ordering lines only if they mention a relevant source
      return [...relevantSources].some(s => l.includes(`"${s}"`));
    });

    const displayLog = _orderShowAll ? layer.orderLog : filteredLog;
    if (displayLog.length) {
      let orderHtml = '';
      let appliedCount = 0;
      for (const l of displayLog) {
        const isApplied = /^Applied "/i.test(l) || /^Skipped "/i.test(l);
        const isDep = /^Dependency/i.test(l);
        const isLoop = /^Dependency loop/i.test(l);
        if (isApplied) appliedCount++;
        const reason = layer.orderLogReasons && layer.orderLogReasons[l];
        const btn = reason
          ? ` <button class="dep-reason-btn" onclick="showDepReasonPopup(this)" data-reason="${escapeAttr(reason)}" data-is-loop="${isLoop}" title="${isLoop ? 'Why is this a dependency loop?' : 'Why is this a dependency?'}">?</button>`
          : '';
        const lineClass = isDep ? ' layer-order-dep' : '';
        const numHtml = isApplied ? `<span class="layer-order-num">${appliedCount}.</span>` : '';
        orderHtml += `<div class="layer-order-line${lineClass}">${numHtml}${escapeHtml(capitalizeFirst(_replaceThisCard(l, cardName)))}${btn}</div>`;
      }
      html += `<div class="layer-order">
        <div class="layer-order-title-row">
          <div class="layer-order-title">${isRulesMode ? 'Effect Ordering (CR 613.8):' : 'How effects are ordered:'}</div>
          <button class="layer-order-toggle" onclick="toggleOrderShowAll()">${_orderShowAll ? 'This card only' : 'Show all'}</button>
        </div>
        ${orderHtml}
      </div>`;
    }
  }

  if (layer.applicationLog.length) {
    // In "show all" mode, display every entry in the log.
    // In normal mode, only show effects that directly affected the inspected permanent.
    const logEntries = _orderShowAll
      ? layer.applicationLog
      : layer.applicationLog.filter(entry => entry.changes.length > 0 ||
          entry.appliedToInspected || entry.reason.includes('lost its abilities'));
    if (logEntries.length === 0) {
      html += `<div class="layer-note">${isRulesMode
        ? 'No applicable effects target this permanent in this layer.'
        : 'No effects affect this permanent in this layer.'}</div>`;
    } else {
    html += `<div class="layer-app-log">`;
    let entryNum = 0;
    for (const entry of logEntries) {
      entryNum++;
      const entrySourcePerm = entry.sourceId ? Battlefield.getPermById(entry.sourceId) : null;
      const entryDisplaySource = entrySourcePerm && entrySourcePerm.label
        ? `${entry.source} ${entrySourcePerm.label}` : entry.source;
      const isOther = entry.changes.length === 0 && !entry.appliedToInspected && !entry.reason.includes('lost its abilities');
      html += `<div class="layer-app-entry${isOther ? ' layer-app-entry-other' : ''}">
        <div class="layer-app-source">
          <span class="layer-app-num">${entryNum}.</span>
          <strong>${escapeHtml(entryDisplaySource)}</strong>
          <span class="layer-app-ts">ts:${entry.timestamp}</span>
        </div>
        <div class="layer-app-reason">${isRulesMode
          ? escapeHtml(capitalizeFirst(_replaceYouControl(_replaceThisCard(entry.reason, cardName), entry.sourceId)))
          : escapeHtml(capitalizeFirst(simplifyReason(_replaceYouControl(_replaceThisCard(entry.reason, cardName), entry.sourceId))))}</div>
        ${entry.changes.length ? entry.changes.map(c => {
          const isSubtypeLoss = /associated with lost type/i.test(c);
          const ruleBtn = isSubtypeLoss
            ? ` <button class="dep-reason-btn" onclick="showDepReasonPopup(this)" data-reason="${escapeAttr(isRulesMode ? 'CR 205.1a: When a permanent loses a card type, it also loses all subtypes associated with that type.' : 'When a permanent loses a card type, it also loses all the subtypes of that type.')}" data-title="Why did this subtype disappear?" title="Why did this subtype disappear?">?</button>`
            : '';
          return `<div class="layer-app-change">\u2192 ${escapeHtml(capitalizeFirst(_replaceYouControl(_replaceThisCard(c, cardName), entry.sourceId)))}${ruleBtn}</div>`;
        }).join('') :
          `<div class="layer-app-change dim">\u2192 ${isOther ? '(applied to other permanents)' : '(no change)'}</div>`}
      </div>`;
    }
    html += `</div>`;
    } // end logEntries check
  } else {
    html += `<div class="layer-note">${isRulesMode
      ? 'No applicable continuous effects in this layer and sublayer.'
      : 'No effects apply in this layer.'}</div>`;
  }

  html += `<div class="layer-state-after">
    <div class="layer-state-after-title">State after Layer ${layer.id}:</div>
    ${renderStateBlock(layer.stateAfter, isRulesMode, cardName, baseState)}
  </div>`;

  return html;
}

function _replaceThisCard(text, cardName) {
  if (!cardName || !text) return text;
  return text.replace(/\bthis (?:card|token)\b/gi, cardName);
}

function _replaceYouForPlayer(text, playerId) {
  if (!text || !playerId) return text;
  const name = Battlefield.getPlayerName(playerId);
  if (!name) return text;
  return text
    .replace(/\byou control\b/gi, `${name} controls`)
    .replace(/\byour control\b/gi, `${name}'s control`)
    .replace(/\byou own\b/gi, `${name} owns`)
    .replace(/\byou cast\b/gi, `${name} casts`)
    .replace(/\byou lose\b/gi, `${name} loses`)
    .replace(/\byou gain\b/gi, `${name} gains`)
    .replace(/\byou draw\b/gi, `${name} draws`)
    .replace(/\byou pay\b/gi, `${name} pays`)
    .replace(/\byou may\b/gi, `${name} may`)
    .replace(/\byour\b/gi, `${name}'s`)
    .replace(/\byou\b/gi, name);
}

function _replaceYouControl(text, sourceId) {
  if (!text || !sourceId) return text;
  const perm = Battlefield.getPermById(sourceId);
  const ctrl = perm ? (perm.controller || perm.owner || 'player_0') : null;
  return _replaceYouForPlayer(text, ctrl);
}

/* Sort ability lines so identical ones are grouped together.
   Preserves order of first occurrence for each unique line. */
function _groupAbilityLines(lines) {
  const firstIndex = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!firstIndex.has(lines[i])) firstIndex.set(lines[i], i);
  }
  return [...lines].sort((a, b) => firstIndex.get(a) - firstIndex.get(b));
}

/* Build the Types row for renderStateBlock as HTML.
   When state.isAllCreatureTypes is true and TypeCatalog is loaded, render the
   creature subtypes as a clickable "All Creature Types[ except X]" chip and
   keep any non-creature subtypes as plain text alongside it. */
function _buildTypeLineHtml(state, baseState, highlight) {
  const allSubs = state.subtypes || [];
  // Token-level highlight: wrap a type/subtype word in red when it isn't present in the base state.
  const baseLeftSet = highlight ? new Set([...(baseState.supertypes || []), ...(baseState.types || [])]) : null;
  const baseSubSet = highlight ? new Set(baseState.subtypes || []) : null;
  const _wrapTok = (tok, set) => (highlight && set && !set.has(tok))
    ? `<span class="state-new">${escapeHtml(tok)}</span>` : escapeHtml(tok);
  const left = [...state.supertypes, ...state.types].map(t => _wrapTok(t, baseLeftSet)).join(' ');
  const creatureCatalogReady = typeof TypeCatalog !== 'undefined'
    && TypeCatalog.creatureTypes && TypeCatalog.creatureTypes.size > 0;
  const landCatalogReady = typeof TypeCatalog !== 'undefined'
    && TypeCatalog.landTypes && TypeCatalog.landTypes.size > 0;

  if ((state.isAllCreatureTypes && creatureCatalogReady) || (state.isAllLandTypes && landCatalogReady)) {
    const chips = [];
    const chipSubtypeSet = new Set();

    if (state.isAllCreatureTypes && creatureCatalogReady) {
      const creatureSubs = allSubs.filter(s => TypeCatalog.creatureTypes.has(s)).sort();
      const excluded = [...TypeCatalog.creatureTypes].filter(t => !creatureSubs.includes(t)).sort();
      creatureSubs.forEach(s => chipSubtypeSet.add(s));
      let chipLabel;
      if (excluded.length === 0) chipLabel = 'All Creature Types';
      else if (excluded.length <= 3) chipLabel = `All Creature Types except ${excluded.join(', ')}`;
      else chipLabel = `All Creature Types except ${excluded.length} types`;
      chips.push(`<span class="bf-card-alltypes-chip${highlight && !baseState.isAllCreatureTypes ? ' state-new' : ''}" `
        + `onclick="event.stopPropagation(); openAllTypesPopup('creature', this.dataset.subs, this.dataset.excluded)" `
        + `data-subs="${escapeAttr(creatureSubs.join(','))}" data-excluded="${escapeAttr(excluded.join(','))}" `
        + `title="Click to see every creature type currently in effect">${escapeHtml(chipLabel)}</span>`);
    }

    if (state.isAllLandTypes && landCatalogReady) {
      const landSubs = allSubs.filter(s => TypeCatalog.landTypes.has(s)).sort();
      const excluded = [...TypeCatalog.landTypes].filter(t => !landSubs.includes(t)).sort();
      landSubs.forEach(s => chipSubtypeSet.add(s));
      let chipLabel;
      if (excluded.length === 0) chipLabel = 'All Land Types';
      else if (excluded.length <= 3) chipLabel = `All Land Types except ${excluded.join(', ')}`;
      else chipLabel = `All Land Types except ${excluded.length} types`;
      chips.push(`<span class="bf-card-alltypes-chip${highlight && !baseState.isAllLandTypes ? ' state-new' : ''}" `
        + `onclick="event.stopPropagation(); openAllTypesPopup('land', this.dataset.subs, this.dataset.excluded)" `
        + `data-subs="${escapeAttr(landSubs.join(','))}" data-excluded="${escapeAttr(excluded.join(','))}" `
        + `title="Click to see every land type currently in effect">${escapeHtml(chipLabel)}</span>`);
    }

    const otherSubs = allSubs.filter(s => !chipSubtypeSet.has(s));
    const otherText = otherSubs.length ? ' ' + otherSubs.map(s => _wrapTok(s, baseSubSet)).join(' ') : '';
    // `left` is already escaped HTML (token-level highlight applied above).
    return left + (chips.length || otherSubs.length ? '  —  ' + chips.join(' ') + otherText : '');
  }

  // Default: plain-text type line. `left` is already escaped HTML.
  const sub = allSubs.length ? '  —  ' + allSubs.map(s => _wrapTok(s, baseSubSet)).join(' ') : '';
  return left + sub;
}

function openAllCreatureTypesPopup(subsCsv, excludedCsv) {
  openAllTypesPopup('creature', subsCsv, excludedCsv);
}

function openAllTypesPopup(kind, subsCsv, excludedCsv) {
  const subs = (subsCsv || '').split(',').filter(Boolean);
  const excluded = (excludedCsv || '').split(',').filter(Boolean);
  let overlay = document.getElementById('all-creature-types-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'all-creature-types-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = 'none'; };
  overlay.style.display = 'flex';
  const label = kind === 'land' ? 'Land' : 'Creature';
  const header = excluded.length === 0
    ? `All ${label} Types (${subs.length})`
    : `All ${label} Types except ${excluded.length === 1 ? excluded[0] : excluded.length + ' types'} (${subs.length} of ${subs.length + excluded.length})`;
  const subsHtml = subs.length
    ? `<div class="all-types-grid">${subs.map(s => `<span class="all-types-item">${escapeHtml(s)}</span>`).join('')}</div>`
    : '<div class="dim">(none)</div>';
  const excludedHtml = excluded.length
    ? `<div class="modal-section-title" style="margin-top:12px;">Excluded</div>`
      + `<div class="all-types-grid all-types-grid-excluded">${excluded.map(s => `<span class="all-types-item all-types-item-excluded">${escapeHtml(s)}</span>`).join('')}</div>`
    : '';
  overlay.innerHTML = `
    <div class="modal ability-popup all-types-popup">
      <div class="modal-header">
        <h3>${escapeHtml(header)}</h3>
        <button class="modal-close" onclick="document.getElementById('all-creature-types-overlay').style.display='none'">&times;</button>
      </div>
      <div class="modal-body">
        ${subsHtml}
        ${excludedHtml}
      </div>
    </div>`;
}

/* Compute the derived "Traits" chips for a state (Token, Nonbasic, Modified, plus
   any custom traits). Shared so the highlight toggle can diff a computed state's
   traits against the base state's traits. */
function _displayTraits(state) {
  const traits = [];
  if (state.isToken) traits.push('Token');
  if (state.types.includes('Land') && !state.supertypes.includes('Basic')) traits.push('Nonbasic');
  // Custom traits (e.g. "Has all card names" from Spy Kit)
  if (state.traits && state.traits.length) {
    for (const t of state.traits) {
      if (!traits.includes(t)) traits.push(t);
    }
  }
  // Modified: creature that is enchanted, equipped, or has any counter (CR 701.52)
  const isCreatureState = state.types && state.types.includes('Creature');
  const hasCounter = Object.values(state.counters || {}).some(v => v > 0);
  const isEnchanted = (state.traits || []).includes('Enchanted');
  const isEquipped = (state.traits || []).includes('Equipped');
  if (isCreatureState && (hasCounter || isEnchanted || isEquipped)) traits.push('Modified');
  return traits;
}

/* Corner P/T (card-layout style) for the Final-state blocks. Each number turns red
   when it differs from the base state and the highlight toggle is on. */
function _finalPtHtml(state, baseState) {
  const hl = _highlightChanges && !!baseState;
  const wrap = (chg, v) => chg
    ? `<span class="state-new">${escapeHtml(String(v))}</span>` : escapeHtml(String(v));
  return `${wrap(hl && String(state.power) !== String(baseState.power), state.power)} / `
    + `${wrap(hl && String(state.toughness) !== String(baseState.toughness), state.toughness)}`;
}

function renderStateBlock(state, isRulesMode, cardName, baseState, omitPtRow) {
  const _rcName = cardName || state.name;
  const _repAb = (ab) => _replaceThisCard(_replaceYouForPlayer(ab, state.controller), _rcName);
  // Highlight mode: only when toggle is on and we're rendering a computed (non-base) state.
  const highlight = _highlightChanges && !!baseState && baseState !== state;
  const _hl = (changed, inner) => (highlight && changed) ? `<span class="state-new">${inner}</span>` : inner;
  const typeLineHtml = _buildTypeLineHtml(state, baseState, highlight);
  const colorDisplay = state.colors.length ? state.colors.join(', ') : 'Colorless';
  const traits = _displayTraits(state);
  const baseTraitSet = highlight ? new Set(_displayTraits(baseState)) : null;
  // Set of base ability strings (raw, pre-substitution) for ability-level highlighting.
  const baseAbSet = highlight
    ? new Set([...(baseState.abilities || []), ...(baseState.allPrintedAbilities || [])])
    : null;
  // Base abilities rendered with the same substitution + tokenized, so a text-changed
  // ability can be diffed word-for-word against its printed origin (only the swapped
  // word reddens, not the whole line).
  const baseAbDisp = highlight
    ? [...new Set([...(baseState.abilities || []), ...(baseState.allPrintedAbilities || [])])]
        .map(b => _tokenizeForDiff(_repAb(b)))
    : null;
  // Render one ability line. Returns { html, cls }:
  //  - unchanged ability        -> plain text, no class
  //  - text-changed ability     -> only the changed words wrapped in .state-new
  //  - genuinely new ability     -> plain text + .state-ability-new (whole line red)
  const _abRender = (ab) => {
    const disp = _repAb(ab);
    if (!highlight || (baseAbSet && baseAbSet.has(ab))) return { html: escapeHtml(disp), cls: '' };
    const toks = _tokenizeForDiff(disp);
    const isWord = (t) => /[A-Za-z0-9']/.test(t);
    const wordTotal = toks.filter(isWord).length;
    let best = null, bestMatch = -1;
    for (const bt of (baseAbDisp || [])) {
      if (bt.length !== toks.length) continue;
      let m = 0;
      for (let i = 0; i < toks.length; i++) {
        if (toks[i] === bt[i] && isWord(toks[i])) m++;
      }
      if (m > bestMatch) { bestMatch = m; best = bt; }
    }
    // A same-length origin sharing more than half its words is a text-changed variant.
    if (best && bestMatch >= wordTotal / 2 && bestMatch < wordTotal) {
      const html = toks.map((t, i) => (isWord(t) && t !== best[i])
        ? `<span class="state-new">${escapeHtml(t)}</span>` : escapeHtml(t)).join('');
      return { html, cls: '' };
    }
    if (best && bestMatch === wordTotal) return { html: escapeHtml(disp), cls: '' };
    return { html: escapeHtml(disp), cls: ' state-ability-new' };
  };

  const counterEntries = Object.entries(state.counters || {}).filter(([,v]) => v > 0);
  const baseCounters = highlight ? (baseState.counters || {}) : null;
  const counterHtml = counterEntries.length
    ? `<div class="state-row"><span class="state-label">Counters:</span> <span class="state-traits">${counterEntries.map(([t,c]) => _hl(baseCounters && (baseCounters[t] || 0) !== c, c + 'x ' + escapeHtml(t))).join(', ')}</span></div>`
    : '';

  // Show abilities: active ones normally, conditional ones dimmed (from allPrintedAbilities)
  // Saga chapters: dim chapters whose lore counter threshold hasn't been reached
  // Class levels: dim abilities whose class level hasn't been reached
  // Leveler: dim abilities not in the active level bracket
  // Conditional abilities: dim when condition not met, normal when met
  // Only show printed abilities still present in state.abilities (effects may have removed some)
  let abilitiesHtml;
  const loreCount = (state.counters && state.counters['lore']) || 0;
  const sagaThresholds = state.sagaChapterThresholds;
  const classThresholds = state.classLevelThresholds;
  const classLevel = state.classLevel || 1;
  const levelerData = state.levelerData;
  const levelCount = (state.counters && state.counters['level']) || 0;
  const spacecraftData = state.spacecraftData;
  const chargeCount = (state.counters && state.counters['charge']) || 0;
  if (state.allPrintedAbilities && (state.conditionalAbilityIndices || sagaThresholds || classThresholds || levelerData || spacecraftData)) {
    const lines = [];
    for (let i = 0; i < state.allPrintedAbilities.length; i++) {
      const ab = state.allPrintedAbilities[i];
      if (levelerData && levelerData.abilityIndexToBracket && levelerData.abilityIndexToBracket.has(i)) {
        // Leveler ability: check if the current level counter is in this bracket's range
        const bracketIdx = levelerData.abilityIndexToBracket.get(i);
        const bracket = levelerData.brackets[bracketIdx];
        if (bracket) {
          const isLevelUpLine = (i === levelerData.levelUpLineIndex);
          const inRange = isLevelUpLine || (levelCount >= bracket.min && levelCount <= bracket.max);
          if (inRange) {
            const title = isLevelUpLine ? 'Level up ability (always active)' :
              `Level ${bracket.min}${bracket.max === Infinity ? '+' : '-' + bracket.max} (active, ${levelCount} level counters)`;
            lines.push(`<div class="state-ability-line state-ability-saga-active" title="${title}">${escapeHtml(_repAb(ab))}</div>`);
          } else {
            const title = `Level ${bracket.min}${bracket.max === Infinity ? '+' : '-' + bracket.max} (inactive, ${levelCount} level counters)`;
            lines.push(`<div class="state-ability-line state-ability-saga-inactive" title="${title}">${escapeHtml(_repAb(ab))}</div>`);
          }
        } else {
          lines.push(`<div class="state-ability-line">${escapeHtml(_repAb(ab))}</div>`);
        }
      } else if (classThresholds && classThresholds.has(i)) {
        // Class level ability: dim if class level hasn't reached threshold
        const threshold = classThresholds.get(i);
        if (classLevel >= threshold) {
          lines.push(`<div class="state-ability-line state-ability-saga-active" title="Level ${threshold} ability (active)">${escapeHtml(_repAb(ab))}</div>`);
        } else {
          lines.push(`<div class="state-ability-line state-ability-saga-inactive" title="Level ${threshold} ability (needs level ${threshold}, currently ${classLevel})">${escapeHtml(_repAb(ab))}</div>`);
        }
      } else if (spacecraftData && spacecraftData.abilityIndexToBracket && spacecraftData.abilityIndexToBracket.has(i)) {
        // Spacecraft station ability: check if charge counters >= threshold
        const minCharge = spacecraftData.abilityIndexToBracket.get(i);
        if (minCharge === -1) {
          // Station keyword line — always active
          lines.push(`<div class="state-ability-line state-ability-saga-active" title="Station keyword (always active)">${escapeHtml(_repAb(ab))}</div>`);
        } else {
          const isActive = chargeCount >= minCharge;
          if (isActive) {
            lines.push(`<div class="state-ability-line state-ability-saga-active" title="Station ${minCharge}+ (active, ${chargeCount} charge counters)">${escapeHtml(_repAb(ab))}</div>`);
          } else {
            lines.push(`<div class="state-ability-line state-ability-saga-inactive" title="Station ${minCharge}+ (inactive, needs ${minCharge} charge counters, currently ${chargeCount})">${escapeHtml(_repAb(ab))}</div>`);
          }
        }
      } else if (state.conditionalAbilityIndices && state.conditionalAbilityIndices.has(i)) {
        // Conditional abilities: evaluate condition to show active/inactive
        if (!state.allAbilitiesRemoved) {
          const isMet = state.conditionalAbilitiesMet && state.conditionalAbilitiesMet.has(i);
          if (isMet) {
            lines.push(`<div class="state-ability-line state-ability-conditional-active" title="Conditional (condition met)">${escapeHtml(_repAb(ab))}</div>`);
          } else {
            lines.push(`<div class="state-ability-line state-ability-conditional" title="Conditional (inactive — condition not met)">${escapeHtml(_repAb(ab))}</div>`);
          }
        }
      } else if (sagaThresholds && sagaThresholds.has(i)) {
        // Saga chapter: dim if lore counters haven't reached threshold
        const threshold = sagaThresholds.get(i);
        if (loreCount >= threshold) {
          lines.push(`<div class="state-ability-line state-ability-saga-active" title="Chapter active (lore \u2265 ${threshold})">${escapeHtml(_repAb(ab))}</div>`);
        } else {
          lines.push(`<div class="state-ability-line state-ability-saga-inactive" title="Chapter inactive (needs lore \u2265 ${threshold}, currently ${loreCount})">${escapeHtml(_repAb(ab))}</div>`);
        }
      } else {
        // Non-conditional printed abilities: only show if still in state.abilities
        if (state.abilities.includes(ab)) {
          lines.push(`<div class="state-ability-line">${escapeHtml(_repAb(ab))}</div>`);
        }
      }
    }
    // Also add any abilities in state.abilities that aren't in allPrintedAbilities (e.g. from effects)
    for (const ab of state.abilities) {
      if (!state.allPrintedAbilities.includes(ab)) {
        const r = _abRender(ab);
        lines.push(`<div class="state-ability-line${r.cls}">${r.html}</div>`);
      }
    }
    // Equip and Reconfigure always appear last in the text box
    lines.sort((a, b) => {
      const aLast = />\s*(?:equip|reconfigure)\b/i.test(a);
      const bLast = />\s*(?:equip|reconfigure)\b/i.test(b);
      return aLast === bLast ? 0 : aLast ? 1 : -1;
    });
    abilitiesHtml = lines.length > 0 ? _groupAbilityLines(lines).join('') : '<span class="dim">(none)</span>';
  } else {
    // Equip and Reconfigure always appear last in the text box
    const sortedAbilities = [...state.abilities].sort((a, b) => {
      const aLast = /^(?:equip|reconfigure)\b/i.test(a);
      const bLast = /^(?:equip|reconfigure)\b/i.test(b);
      return aLast === bLast ? 0 : aLast ? 1 : -1;
    });
    abilitiesHtml = sortedAbilities.length
      ? _groupAbilityLines(sortedAbilities.map(a => {
          const r = _abRender(a);
          return `<div class="state-ability-line${r.cls}">${r.html}</div>`;
        })).join('')
      : '<span class="dim">(none)</span>';
  }

  const ptHtml = (state.types.includes('Creature') && !omitPtRow)
    ? `<div class="state-row"><span class="state-label">P/T:</span> <span class="state-pt">${_hl(highlight && String(state.power) !== String(baseState.power), escapeHtml(String(state.power)))}/${_hl(highlight && String(state.toughness) !== String(baseState.toughness), escapeHtml(String(state.toughness)))}</span></div>`
    : '';
  const traitsHtml = traits.length
    ? `<div class="state-row"><span class="state-label">Traits:</span> <span class="state-traits">${traits.map(t => _hl(baseTraitSet && !baseTraitSet.has(t), escapeHtml(t))).join(', ')}</span></div>`
    : '';

  return `<div class="state-block">
    <div class="state-row"><span class="state-label">Name:</span> <span>${_hl(highlight && state.name !== baseState.name, escapeHtml(state.name || '(none)'))}</span></div>
    <div class="state-row"><span class="state-label">Mana Value:</span> <span>${_hl(highlight && (state.manaCost || '') !== (baseState.manaCost || ''), escapeHtml(state.manaCost || '(none)'))}</span></div>
    <div class="state-row"><span class="state-label">Types:</span> <span>${typeLineHtml || '(none)'}</span></div>
    <div class="state-row"><span class="state-label">Color:</span> <span>${_hl(highlight && state.colors.join(',') !== baseState.colors.join(','), escapeHtml(colorDisplay))}</span></div>
    ${ptHtml}
    ${traitsHtml}
    ${counterHtml}
    <div class="state-row state-row-abilities"><span class="state-label">Abilities:</span> <div class="state-abilities">${abilitiesHtml}</div></div>
  </div>`;
}

/* ---- Stack spell inspector ---- */

