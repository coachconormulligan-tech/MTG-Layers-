/* [KEY: COUNTER-UI] */
const COUNTER_PRESETS = [
  { label: '+1/+1', type: '+1/+1' },
  { label: '-1/-1', type: '-1/-1' },
  { label: 'Flying', type: 'flying' },
  { label: 'First Strike', type: 'first strike' },
  { label: 'Double Strike', type: 'double strike' },
  { label: 'Deathtouch', type: 'deathtouch' },
  { label: 'Haste', type: 'haste' },
  { label: 'Hexproof', type: 'hexproof' },
  { label: 'Indestructible', type: 'indestructible' },
  { label: 'Lifelink', type: 'lifelink' },
  { label: 'Menace', type: 'menace' },
  { label: 'Reach', type: 'reach' },
  { label: 'Trample', type: 'trample' },
  { label: 'Vigilance', type: 'vigilance' },
  { label: 'Defender', type: 'defender' },
  { label: 'Shield', type: 'shield' },
];

function renderCounterPanel() {
  const section = document.getElementById('counter-section');
  const panel = document.getElementById('counter-panel');
  if (!section) return;
  if (!Battlefield.inspectedId) { section.style.display = 'none'; return; }
  const perm = Battlefield.getPermById(Battlefield.inspectedId);
  if (!perm || perm.isManualEffect) { section.style.display = 'none'; return; }
  section.style.display = '';

  const counters = perm.counters || {};
  const counterEntries = Object.entries(counters).filter(([,v]) => v > 0);

  let html = `<div class="counter-perm-name">${escapeHtml(perm.name)}</div>`;
  if (counterEntries.length > 0) {
    html += `<div class="counter-list">`;
    for (const [type, count] of counterEntries) {
      html += `<div class="counter-row">
        <span class="counter-type">${escapeHtml(type)}</span>
        <span class="counter-count">x${count}</span>
        <button class="counter-btn counter-minus" onclick="modifyCounter('${perm.id}', '${type}', -1)">−</button>
        <button class="counter-btn counter-plus" onclick="modifyCounter('${perm.id}', '${type}', 1)">+</button>
      </div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="dim" style="font-size:11px;padding:4px 0;">No counters</div>`;
  }
  // Collect oracle counter types from ALL permanents (not just this one)
  // so card-specific counter types are available everywhere
  const allOracleCounterTypes = new Set();
  for (const p2 of Battlefield.permanents) {
    if (p2.oracleCounterTypes) {
      for (const t of p2.oracleCounterTypes) allOracleCounterTypes.add(t);
    }
  }
  // Also include this permanent's own types first
  if (perm.oracleCounterTypes) {
    for (const t of perm.oracleCounterTypes) allOracleCounterTypes.add(t);
  }
  const oracleCounterTypes = [...allOracleCounterTypes];

  html += `<div class="counter-add">
    <select id="counter-type-select" class="counter-select">
      ${oracleCounterTypes.map(t => `<option value="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</option>`).join('')}
      ${COUNTER_PRESETS.map(p => `<option value="${p.type}">${p.label}</option>`).join('')}
    </select>
    <button class="btn btn-sm" onclick="addCounterFromUI('${perm.id}')">Add Counter</button>
  </div>`;

  // Class enchantment level controls
  if (perm._classLevelThresholds) {
    const maxLevel = Math.max(...perm._classLevelThresholds.values());
    const curLevel = perm.classLevel || 1;
    html += `<div class="class-level-control">
      <span class="class-level-label">Class Level</span>
      <div class="class-level-buttons">
        <button class="counter-btn counter-minus" onclick="modifyClassLevel('${perm.id}', -1)" ${curLevel <= 1 ? 'disabled' : ''}>−</button>
        <span class="class-level-value">${curLevel}</span>
        <button class="counter-btn counter-plus" onclick="modifyClassLevel('${perm.id}', 1)" ${curLevel >= maxLevel ? 'disabled' : ''}>+</button>
      </div>
    </div>`;
  }

  panel.innerHTML = html;
}

function modifyCounter(permId, counterType, delta) {
  if (delta > 0) Battlefield.addCounter(permId, counterType, delta);
  else Battlefield.removeCounter(permId, counterType, -delta);
  Battlefield.evaluate();
  renderAll();
}

function addCounterFromUI(permId) {
  const select = document.getElementById('counter-type-select');
  if (!select) return;
  Battlefield.addCounter(permId, select.value, 1);
  Battlefield.evaluate();
  renderAll();
}

function modifyClassLevel(permId, delta) {
  const perm = Battlefield.getPermById(permId);
  if (!perm) return;
  Battlefield.setClassLevel(permId, (perm.classLevel || 1) + delta);
}
/* [END: COUNTER-UI] */

/* [KEY: GAME-STATE-UI] */
// Niche game-state stats (Monarch, Initiative, Starting Life, Poison,
// Experience, Draws) are tucked behind a "More" expander to keep the panel
// quiet by default. The common three (Your Turn, Current Life, Cards in Hand)
// are always shown.
let _gsShowAdvanced = false;
function toggleGsAdvanced() {
  _gsShowAdvanced = !_gsShowAdvanced;
  renderGameStatePanel();
}

function _adjustGameStat(key, delta) {
  const gs = Battlefield.gameState;
  gs[key] = Math.max(0, (gs[key] || 0) + delta);
  Battlefield._invalidate();
  Battlefield.evaluate();
  renderAll();
}

function _setStartingLife(value) {
  Battlefield.gameState.startingLife = parseInt(value) || 0;
  Battlefield._invalidate();
  Battlefield.evaluate();
  renderAll();
}

function toggleYourTurn() {
  const gs = Battlefield.gameState;
  const newValue = !gs.isYourTurn;
  gs.isYourTurn = newValue;
  // Turning on your turn: clear it for all other players (only one player can have their turn at a time)
  if (newValue) {
    for (const player of Battlefield.players) {
      if (player.id !== Battlefield.activePlayerId) {
        player.gameState.isYourTurn = false;
      }
    }
  }
  Battlefield._invalidate();
  Battlefield.evaluate();
  renderAll();
}

function toggleMonarch() {
  const gs = Battlefield.gameState;
  const newValue = !gs.isMonarch;
  gs.isMonarch = newValue;
  // Only one player can be the monarch at a time.
  if (newValue) {
    for (const player of Battlefield.players) {
      if (player.id !== Battlefield.activePlayerId) player.gameState.isMonarch = false;
    }
  }
  Battlefield._invalidate();
  Battlefield.evaluate();
  renderAll();
}

function toggleInitiative() {
  const gs = Battlefield.gameState;
  const newValue = !gs.hasInitiative;
  gs.hasInitiative = newValue;
  // Only one player can have the initiative at a time.
  if (newValue) {
    for (const player of Battlefield.players) {
      if (player.id !== Battlefield.activePlayerId) player.gameState.hasInitiative = false;
    }
  }
  Battlefield._invalidate();
  Battlefield.evaluate();
  renderAll();
}

function renderGameStatePanel() {
  const panel = document.getElementById('game-state-panel');
  if (!panel) return;
  const gs = Battlefield.gameState;
  const h = escapeHtml;
  let html = '';
  // Show player name header when multiplayer
  if (Battlefield.players.length > 1) {
    const playerName = Battlefield.getActivePlayer().name;
    html += `<div class="gs-player-name">${h(playerName)}'s Game State</div>`;
  }
  const statRow = (label, key) => `<div class="gs-row">
    <span class="gs-label">${label}</span>
    <div class="gs-controls">
      <button class="gs-btn" onclick="_adjustGameStat('${key}', -1)">−</button>
      <span class="gs-value">${gs[key]}</span>
      <button class="gs-btn" onclick="_adjustGameStat('${key}', 1)">+</button>
    </div>
  </div>`;
  const toggleRow = (label, active, onclick) => `<div class="gs-row gs-turn-row">
    <span class="gs-label">${label}</span>
    <div class="gs-controls">
      <button class="gs-turn-toggle ${active ? 'active' : ''}" onclick="${onclick}">
        ${active ? 'Yes' : 'No'}
      </button>
    </div>
  </div>`;
  const startingLifeRow = `<div class="gs-row">
    <span class="gs-label">Starting Life</span>
    <div class="gs-controls">
      <input type="number" class="gs-input" value="${gs.startingLife}" min="0"
        onchange="_setStartingLife(this.value)">
    </div>
  </div>`;

  // Common stats — always visible.
  html += '<div class="game-state-grid">';
  html += toggleRow('Your Turn', gs.isYourTurn, 'toggleYourTurn();');
  html += statRow('Current Life', 'currentLife');
  html += statRow('Cards in Hand', 'handSize');
  html += '</div>';

  // More / fewer toggle for the niche stats.
  html += `<button class="gs-more-toggle" onclick="toggleGsAdvanced()">${_gsShowAdvanced ? 'Fewer game-state options' : 'More game-state options'}</button>`;

  // Advanced stats — hidden until expanded.
  html += `<div class="game-state-grid gs-advanced"${_gsShowAdvanced ? '' : ' style="display:none"'}>`;
  html += toggleRow('Monarch', gs.isMonarch, 'toggleMonarch();');
  html += toggleRow('Have Initiative', gs.hasInitiative, 'toggleInitiative();');
  html += startingLifeRow;
  html += statRow('Poison Counters', 'poisonCounters');
  html += statRow('Experience Counters', 'experienceCounters');
  html += statRow('Draws This Turn', 'drawsThisTurn');
  html += '</div>';

  // Reset trigger counts (for once-per-turn triggered abilities) — shown when present.
  const hasTriggerCounts = Battlefield.triggerCounts.size > 0;
  if (hasTriggerCounts) {
    html += `<div class="gs-custom-row">
      <span class="gs-label" style="flex:1">Trigger Counts</span>
      <button class="gs-add-btn" onclick="resetTriggerCounts()" title="Reset all once-per-turn trigger counts">↻ New Turn</button>
    </div>`;
  }

  panel.innerHTML = html;
}

/* [END: GAME-STATE-UI] */

