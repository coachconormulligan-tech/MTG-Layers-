/* ui-modal-analyze.js — "Analyze abilities" popup.

   Right-click a battlefield card -> small "Analyze" context menu -> a two-pane
   popup that teaches the inverse of the main inspector: given ONE ability, which
   CR 613 layer does each part of it apply in, and which layer does it start in.

   Left pane: card image + oracle text, each static layered ability highlighted
   and clickable. Right pane: the selected ability broken into per-layer rows,
   color-matched to the highlighted text fragments, with hover-linking between
   a phrase and its layer row.

   Pure presentation over already-parsed effect data (Battlefield.effects). The
   engine is never touched. Fragment location is best-effort: when a phrase can't
   be located the layer row still renders, just without an inline highlight. */

function _aaLayerIndex(layerId) {
  const i = LAYERS.findIndex(l => l.id === layerId);
  return i === -1 ? 999 : i;
}
function _aaLayerName(layerId) {
  const l = LAYER_MAP[layerId];
  return l ? l.name : layerId;
}

/* ============================================================================
   Right-click "Analyze" context menu (mirrors openFaceDownMenu)
   ========================================================================= */
function openAnalyzeMenu(event, permId) {
  document.getElementById('analyze-menu')?.remove();
  document.getElementById('facedown-menu')?.remove();

  const perm = Battlefield.getPermById(permId);
  if (!perm || perm.isManualEffect) return;

  const menu = document.createElement('div');
  menu.id = 'analyze-menu';
  menu.className = 'facedown-popup-menu aa-context-menu';
  menu.innerHTML = `
    <button class="facedown-menu-btn aa-examine-btn" onclick="document.getElementById('analyze-menu')?.remove(); openAnalyzeAbilities('${permId}')">Analyze</button>`;
  document.body.appendChild(menu);

  // Position at the cursor, clamped to the viewport.
  const scrollX = window.scrollX || 0;
  const scrollY = window.scrollY || 0;
  const mw = menu.offsetWidth || 120;
  const mh = menu.offsetHeight || 36;
  let left = event.clientX;
  let top = event.clientY;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = window.innerHeight - mh - 8;
  menu.style.left = (left + scrollX) + 'px';
  menu.style.top = (top + scrollY) + 'px';

  const close = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', close, true);
      document.removeEventListener('contextmenu', close, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', close, true);
    document.addEventListener('contextmenu', close, true);
  }, 0);
}

/* ============================================================================
   The popup
   ========================================================================= */
let _aaState = null;

function openAnalyzeAbilities(permId) {
  const perm = Battlefield.getPermById(permId);
  if (!perm || perm.isManualEffect) return;

  const effects = Battlefield.effects.filter(e => e.sourceId === perm.id);
  const oracle = perm.oracleText || '';
  const abilities = _aaSplitAbilities(oracle);
  _aaAssignEffects(abilities, effects, oracle);
  // Static effects cover continuous abilities (Bello). Also analyze activated /
  // triggered abilities (Kenrith) — parse each one's effect to show which layer
  // it lands in WHEN IT RESOLVES.
  _aaAttachResolvedAbilities(perm, abilities);

  // Prefer the first ability with a layer breakdown; else the first one-shot ability.
  let selectedIdx = abilities.findIndex(a => a.effects.length > 0);
  if (selectedIdx === -1) selectedIdx = abilities.findIndex(a => a.isAbility);
  _aaState = { perm, abilities, selectedIdx };

  const overlay = _createModalOverlay('analyze-modal-overlay', closeAnalyzeAbilities);
  overlay.innerHTML = _modalShell({
    title: `Analyze — ${escapeHtml(perm.name)}`,
    closeFn: 'closeAnalyzeAbilities',
    bodyId: 'aa-modal-body',
    body: `
      <p class="aa-intro">Each part of an ability is grouped by the layer it applies in. Hover either side to link them.</p>
      <div class="aa-split">
        <div class="aa-pane-left">
          ${perm.imageUri ? `<img src="${escapeAttr(perm.imageUri)}" alt="${escapeAttr(perm.name)}" class="aa-card-img">` : ''}
          <div class="aa-text" id="aa-text-container"></div>
        </div>
        <div class="aa-pane-right" id="aa-breakdown-container"></div>
      </div>`,
    footer: `<button class="btn" onclick="closeAnalyzeAbilities()">Close</button>`,
  });
  document.body.appendChild(overlay);

  _aaRenderText();
  _aaRenderBreakdown();
  _aaBindHoverLinks(overlay);
}

function closeAnalyzeAbilities() {
  document.getElementById('analyze-modal-overlay')?.remove();
  _aaState = null;
}

/* ----------------------------------------------------------------------------
   Split oracle text into ability blocks (one per non-empty line). Each block
   keeps its [start,end) char span over the oracle string so _oraclePos-tagged
   effects can be assigned by position.
   ------------------------------------------------------------------------- */
function _aaSplitAbilities(oracle) {
  const blocks = [];
  let pos = 0;
  oracle.split('\n').forEach((line, lineIndex) => {
    const start = pos;
    const end = pos + line.length;
    if (line.trim().length > 0) blocks.push({ text: line, start, end, lineIndex, effects: [] });
    pos = end + 1; // +1 for the consumed '\n'
  });
  return blocks;
}

/* Oracle line index for a regex match position. Skips forward over whitespace /
   sentence punctuation so a position landing on the '\n' separator (a common
   boost/haveAbility match index) snaps to the following line's content — the
   same approach the parser uses for modal-mode tagging (cards-parser.js:4582). */
function _aaLineIndexForPos(oracle, pos) {
  let adj = pos;
  while (adj < oracle.length && /[.\s;]/.test(oracle[adj])) adj++;
  return oracle.substring(0, adj).split('\n').length - 1;
}

/* Tokens characteristic of an effect, used to match it to its oracle line. */
function _aaEffectTokens(eff) {
  const toks = new Set();
  const add = (s) => {
    (String(s || '').toLowerCase().match(/[a-z0-9'+\-/]+/g) || [])
      .forEach(w => { if (w.length > 2) toks.add(w); });
  };
  const p = eff.params || {};
  (p.types || []).forEach(add);
  (p.subtypes || []).forEach(add);
  (p.supertypes || []).forEach(add);
  (p.colors || []).forEach(c => add(_aaColorName(c)));
  if (p.ability) add(p.ability);
  if (p.power != null && p.toughness != null) add(p.power + '/' + p.toughness);
  add(eff.desc);
  return toks;
}

/* Assign every effect to one ability block. Effects that share an abilityGroupId
   are kept together. Preference: _oraclePos within a block, else best token
   overlap, else the first block. */
function _aaAssignEffects(abilities, effects, oracle) {
  if (!abilities.length) return;

  const groups = new Map();
  effects.forEach((e, i) => {
    const key = e.abilityGroupId || ('__solo_' + i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  });

  for (const grpEffs of groups.values()) {
    let blockIdx = -1;

    for (const e of grpEffs) {
      if (e._oraclePos != null) {
        const li = _aaLineIndexForPos(oracle, e._oraclePos);
        const bi = abilities.findIndex(b => b.lineIndex === li);
        if (bi !== -1) { blockIdx = bi; break; }
      }
    }

    if (blockIdx === -1) {
      const tokens = new Set();
      grpEffs.forEach(e => _aaEffectTokens(e).forEach(t => tokens.add(t)));
      let bestScore = 0;
      abilities.forEach((b, bi) => {
        const bt = b.text.toLowerCase();
        let s = 0;
        tokens.forEach(t => { if (bt.includes(t)) s++; });
        if (s > bestScore) { bestScore = s; blockIdx = bi; }
      });
    }

    if (blockIdx === -1) blockIdx = 0;
    grpEffs.forEach(e => abilities[blockIdx].effects.push(e));
  }
}

/* ----------------------------------------------------------------------------
   Activated / triggered abilities (Kenrith). Static effects only cover
   continuous abilities; an activated ability's effect creates its continuous
   effect WHEN IT RESOLVES, so we parse each ability's effect text read-only
   (the same parse the engine runs when firing) to discover its layer(s).
   ------------------------------------------------------------------------- */
function _aaAttachResolvedAbilities(perm, abilities) {
  const printed = perm.printedAbilities || [];
  if (!printed.length) return;

  let abList = [];
  try {
    abList = abList.concat((Battlefield.extractActivatedAbilities(printed) || []).map(a => ({ ...a, _kind: 'activated' })));
  } catch (e) { /* ignore */ }
  try {
    abList = abList.concat((Battlefield.extractTriggeredAbilities(printed) || []).map(a => ({ ...a, _kind: 'triggered' })));
  } catch (e) { /* ignore */ }

  for (const ab of abList) {
    const et = String(ab.effectText || '').trim().replace(/\.$/, '');
    if (!et) continue;
    const probe = et.slice(0, Math.min(et.length, 40));
    // Only consider blocks that have no static effect yet (don't clobber Bello-style blocks).
    const block = abilities.find(b => b.effects.length === 0 && b.text.includes(probe));
    if (!block || block._resolvedDone) continue;
    block._resolvedDone = true;
    block.isAbility = true;
    block.abilityKind = ab._kind;
    const parsed = _aaParseAbilityEffects(perm, ab.effectText);
    if (parsed.length) {
      block.resolved = true;
      parsed.forEach(e => block.effects.push(e));
    }
  }
}

/* Read-only parse of one ability's effect text into layered effects. Builds a
   throwaway pseudo-permanent and calls parseCardEffects (which returns an array
   and does NOT mutate Battlefield.effects). Mirrors cards-battlefield.js:506-517. */
function _aaParseAbilityEffects(perm, effectText) {
  const out = [];
  const fakeCard = { name: perm.name, oracle_text: effectText, type_line: 'Instant', colors: perm.printedColors || [], cmc: 0 };
  const pseudo = {
    id: '_aa_tmp', name: perm.name, timestamp: 0,
    owner: perm.owner || 'player_0', controller: perm.controller || perm.owner || 'player_0',
    printedTypes: ['Instant'], printedSupertypes: [], printedSubtypes: [],
    printedPower: null, printedToughness: null, printedAbilities: [],
    printedColors: perm.printedColors || [], oracleText: effectText, counters: {}, manaValue: 0, manaCost: '',
  };
  let parsed = [];
  try { parsed = (parseCardEffects(pseudo, fakeCard) || []).filter(e => e.layer); } catch (e) { parsed = []; }
  parsed.forEach((e, i) => out.push({ ...e, id: '_aa_res_' + i, _resolved: true }));

  // The parser models counter placement as counter state, not a continuous effect,
  // so "put a +1/+1 counter on …" yields nothing. Synthesize it: +N/+N counters apply
  // in Layer 7c (CR 613.4c); keyword counters grant an ability in Layer 6.
  const ceff = _aaCounterAbilityEffect(effectText);
  if (ceff && !out.some(e => e.type === ceff.type)) out.push(ceff);
  return out;
}

function _aaCounterAbilityEffect(effectText) {
  const m = effectText.match(/\bput\s+(?:a|an|one|two|three|four|five|x|\d+)\s+([+\-]?\d+\/[+\-]?\d+|[a-z]+)\s+counters?\b/i);
  if (!m) return null;
  const kind = m[1].trim();
  if (/^[+\-]?\d+\/[+\-]?\d+$/.test(kind)) {
    return { id: '_aa_res_ctr', layer: '7c', type: EFFECT_TYPE.ADD_COUNTERS, params: { counterType: kind }, _resolved: true };
  }
  return { id: '_aa_res_ctr', layer: '6', type: EFFECT_TYPE.KEYWORD_COUNTER, params: { keyword: kind }, _resolved: true };
}

/* ----------------------------------------------------------------------------
   Fragment location — best-effort char range(s) within an ability for an effect.
   ------------------------------------------------------------------------- */
function _aaColorName(c) {
  const map = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
  return map[c] || (typeof c === 'string' ? c.toLowerCase() : '');
}

/* Find the quoted granted-ability span (handles straight and curly quotes). */
function _aaFindQuoted(text, ability) {
  const probe = ability.slice(0, 20).toLowerCase();
  if (!probe) return null;
  const idx = text.toLowerCase().indexOf(probe);
  if (idx === -1) return null;
  const QUOTE = /["“”‘’]/;
  let s = idx;
  for (let i = idx - 1; i >= 0 && idx - i <= 3; i--) {
    if (QUOTE.test(text[i])) { s = i; break; }
  }
  let e = text.length;
  const from = Math.min(text.length, idx + Math.max(probe.length, ability.length - 4));
  for (let i = from; i < text.length; i++) {
    if (QUOTE.test(text[i])) { e = i + 1; break; }
  }
  return [s, e];
}

function _aaLocateFragments(text, eff) {
  const ranges = [];
  const p = eff.params || {};
  const lc = text.toLowerCase();

  const pushRe = (re) => {
    const m = re.exec(text);
    if (m && m[0].length) { ranges.push([m.index, m.index + m[0].length]); return true; }
    return false;
  };
  const pushWord = (word) => {
    if (!word) return false;
    const idx = lc.indexOf(String(word).toLowerCase());
    if (idx !== -1) { ranges.push([idx, idx + String(word).length]); return true; }
    return false;
  };

  switch (eff.type) {
    case EFFECT_TYPE.SET_PT:
    case EFFECT_TYPE.MODIFY_PT:
    case EFFECT_TYPE.CDA_PT:
      pushRe(/[+\-]?\d+\/[+\-]?\d+/);
      break;

    case EFFECT_TYPE.ADD_COUNTERS:
      pushRe(/[+\-]?\d+\/[+\-]?\d+\s+counters?/i) || pushRe(/[+\-]?\d+\/[+\-]?\d+/);
      break;

    case EFFECT_TYPE.KEYWORD_COUNTER:
      pushRe(new RegExp('\\b' + String(p.keyword || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+counters?', 'i')) || pushWord(p.keyword);
      break;

    case EFFECT_TYPE.SWITCH_PT:
      pushRe(/switch[^.]*?power and toughness/i) || pushRe(/power and toughness/i);
      break;

    case EFFECT_TYPE.ADD_TYPE: {
      if (p.gainsAllCreatureTypes) { pushRe(/(?:every|all) creature types?/i) || pushWord('changeling'); break; }
      if (p.gainsAllLandTypes) { pushRe(/(?:every|all) (?:basic )?land types?/i); break; }
      const words = [...(p.subtypes || []), ...(p.types || []), ...(p.supertypes || [])];
      let minI = Infinity, maxI = -1;
      for (const w of words) {
        const idx = lc.indexOf(String(w).toLowerCase());
        if (idx !== -1) { minI = Math.min(minI, idx); maxI = Math.max(maxI, idx + String(w).length); }
      }
      if (maxI !== -1) {
        // Extend through a trailing "in addition to its other types" phrase.
        const m = /in addition to its other types/i.exec(text.slice(maxI));
        if (m && m.index <= 6) maxI = maxI + m.index + m[0].length;
        ranges.push([minI, maxI]);
      }
      break;
    }

    case EFFECT_TYPE.REMOVE_TYPE:
      pushRe(/loses all (?:creature )?(?:sub)?types/i) || pushRe(/is no longer [^.,]*/i);
      break;

    case EFFECT_TYPE.SET_TYPE:
      pushRe(/becomes? an? [^.,;]*/i);
      break;

    case EFFECT_TYPE.ADD_ABILITY: {
      const ab = String(p.ability || '').trim();
      if (/^(?:when|whenever|at|\{)/i.test(ab)) {
        const q = _aaFindQuoted(text, ab);
        if (q) ranges.push(q); else pushWord(ab.split(/[.,]/)[0]);
      } else {
        // Keyword(s) — also handle "protection from X" / "hexproof from X".
        if (!pushWord(ab)) pushWord(ab.split(/\s+from\s+/i)[0]);
      }
      break;
    }

    case EFFECT_TYPE.REMOVE_ABILITIES:
      pushRe(/loses? all abilities/i);
      break;

    case EFFECT_TYPE.SET_COLOR:
    case EFFECT_TYPE.ADD_COLOR:
      (p.colors || []).forEach(c => pushWord(_aaColorName(c)));
      break;

    case EFFECT_TYPE.COPY:
      pushRe(/(?:becomes?|enters?(?:\s+the\s+battlefield)?)\s+(?:as\s+)?a copy of[^.]*/i);
      break;

    case EFFECT_TYPE.CONTROL:
      pushRe(/gains? control of[^.]*/i) || pushRe(/gain control/i);
      break;

    case EFFECT_TYPE.SET_NAME:
      pushRe(/name(?:'s| is)? [^.,]*/i);
      break;

    default:
      break;
  }
  return ranges;
}

/* ----------------------------------------------------------------------------
   Concise, player-facing description per effect (for the right-pane rows).
   Built from params rather than the verbose global-scoped eff.desc.
   ------------------------------------------------------------------------- */
function _aaArticle(s) { return /^[aeiou]/i.test(s) ? 'an ' : 'a '; }

function _aaAbilityLabel(ab) {
  ab = String(ab || '').trim();
  if (/^(?:when|whenever|at|\{)/i.test(ab)) return `"${ab}"`;
  return ab.toLowerCase();
}

function _aaDescribeEffect(eff) {
  const p = eff.params || {};
  const sign = (n) => (n >= 0 ? '+' + n : String(n));
  switch (eff.type) {
    case EFFECT_TYPE.SET_PT:
      if (p.useMV) return 'Base power and toughness each become its mana value';
      return `Base power/toughness set to ${p.power}/${p.toughness}`;
    case EFFECT_TYPE.MODIFY_PT:
      if (p.charBoost || p.power == null) return 'Power/toughness modified by a variable amount';
      return `Power/toughness modified by ${sign(p.power)}/${sign(p.toughness)}`;
    case EFFECT_TYPE.CDA_PT:
      return 'Power/toughness defined by a characteristic-defining ability';
    case EFFECT_TYPE.SWITCH_PT:
      return 'Power and toughness are switched';
    case EFFECT_TYPE.ADD_TYPE: {
      if (p.gainsAllCreatureTypes) return 'Becomes every creature type';
      if (p.gainsAllLandTypes) return 'Becomes every land type';
      const parts = [...(p.supertypes || []), ...(p.subtypes || []), ...(p.types || [])].join(' ');
      return parts ? `Becomes ${_aaArticle(parts)}${parts} in addition to its other types` : 'Gains a type';
    }
    case EFFECT_TYPE.REMOVE_TYPE: {
      if (p.losesAllCreatureTypesOnly) return 'Loses all creature types';
      const parts = [...(p.subtypes || []), ...(p.types || [])].join(' ');
      return parts ? `Loses the ${parts} type` : 'Loses a type';
    }
    case EFFECT_TYPE.SET_TYPE: {
      const parts = [...(p.supertypes || []), ...(p.subtypes || []), ...(p.types || [])].join(' ');
      return parts ? `Becomes ${_aaArticle(parts)}${parts} (loses its other types)` : 'Type is set';
    }
    case EFFECT_TYPE.ADD_ABILITY:
      return `Gains ${_aaAbilityLabel(p.ability)}`;
    case EFFECT_TYPE.ADD_COUNTERS:
      return `Gets a ${p.counterType || '+1/+1'} counter (counters apply in Layer 7c)`;
    case EFFECT_TYPE.KEYWORD_COUNTER:
      return `Gets a ${p.keyword || p.ability || 'keyword'} counter — grants ${_aaAbilityLabel(p.ability || p.keyword)}`;
    case EFFECT_TYPE.REMOVE_ABILITIES:
      return 'Loses all abilities';
    case EFFECT_TYPE.SET_COLOR:
      return `Color set to ${(p.colors || []).map(_aaColorName).join(' and ') || 'a chosen color'}`;
    case EFFECT_TYPE.ADD_COLOR:
      return `Also becomes ${(p.colors || []).map(_aaColorName).join(' and ') || 'another color'}`;
    case EFFECT_TYPE.COPY: {
      // Surface the copy's "except …" modifications. They aren't separate layered
      // effects — they're part of choosing the copiable values, which all happens
      // here in Layer 1 (e.g. Spark Double losing legendary).
      const ex = [];
      if (p.notLegendary) ex.push("it isn't legendary");
      if (p.keepLegendary) ex.push("it's still legendary");
      if (p.setPT) ex.push(`it's ${p.setPT.power}/${p.setPT.toughness}`);
      if (p.setColors && p.setColors.length) ex.push(`it's ${p.setColors.map(_aaColorName).join(' and ')}`);
      if (p.setTypes && p.setTypes.length) ex.push(`it's ${_aaArticle(p.setTypes.join(' '))}${p.setTypes.join(' ')}`);
      if (p.addTypes && p.addTypes.length) ex.push(`it's also ${p.addTypes.join(' and ')}`);
      if (p.addSubtypes && p.addSubtypes.length) ex.push(`it's also ${p.addSubtypes.join(' and ')}`);
      if (p.addSupertypes && p.addSupertypes.length) ex.push(`it's also ${p.addSupertypes.join(' and ')}`);
      if (p.removeTypes && p.removeTypes.length) ex.push(`it isn't ${p.removeTypes.join(' or ')}`);
      if (p.keepName) ex.push('it keeps its name');
      if (p.addAbilities && p.addAbilities.length) ex.push('it gains extra abilities');
      const base = 'Becomes a copy of another object';
      return ex.length ? `${base}, except ${ex.join(', and ')}` : base;
    }
    case EFFECT_TYPE.CONTROL:
      return 'Control changes to another player';
    case EFFECT_TYPE.SET_NAME:
      return `Name becomes ${p.name || 'a new name'}`;
    case EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS:
    case EFFECT_TYPE.GAIN_ACTIVATED_FROM_GRAVEYARDS:
    case EFFECT_TYPE.GAIN_ACTIVATED_FROM_EXILE:
      return 'Gains activated abilities from other objects';
    case EFFECT_TYPE.IMPRINT_PROTECTION_FROM_TYPES:
      return "Gains protection from the imprinted card's types";
    default:
      return capitalizeFirst(eff.desc || eff.type || 'Applies an effect');
  }
}

/* ----------------------------------------------------------------------------
   Rendering
   ------------------------------------------------------------------------- */
function _aaRenderText() {
  const { abilities, selectedIdx } = _aaState;
  const container = document.getElementById('aa-text-container');
  if (!container) return;
  let html = '';
  abilities.forEach((b, i) => {
    const hasEff = b.effects.length > 0;
    const clickable = hasEff || b.isAbility;
    const isSel = i === selectedIdx;
    const cls = ['aa-ability'];
    cls.push(hasEff ? 'aa-ability-layered' : (b.isAbility ? 'aa-ability-nonlayer' : 'aa-ability-plain'));
    if (isSel) cls.push('aa-ability-selected');
    const onclick = clickable ? ` onclick="_aaSelectAbility(${i})"` : '';
    const inner = (hasEff && isSel) ? _aaRenderFragments(b) : escapeHtml(b.text);
    html += `<div class="${cls.join(' ')}"${onclick}>${inner}</div>`;
  });
  container.innerHTML = html;
}

/* Emit one ability's text with non-overlapping colored fragment spans.
   Overlaps resolved longest-first, then earliest. */
function _aaRenderFragments(block) {
  const text = block.text;
  const raw = [];
  block.effects.forEach(eff => {
    _aaLocateFragments(text, eff).forEach(([s, e]) => {
      if (e > s) raw.push({ s, e, layer: eff.layer, eff });
    });
  });
  raw.sort((a, b) => (b.e - b.s) - (a.e - a.s) || a.s - b.s);
  const accepted = [];
  for (const r of raw) {
    if (!accepted.some(a => r.s < a.e && a.s < r.e)) accepted.push(r);
  }
  accepted.sort((a, b) => a.s - b.s);

  let html = '', pos = 0;
  for (const r of accepted) {
    if (r.s > pos) html += escapeHtml(text.slice(pos, r.s));
    html += `<span class="aa-frag" data-eff="${escapeAttr(r.eff.id)}" data-layer="${escapeAttr(r.layer)}">${escapeHtml(text.slice(r.s, r.e))}</span>`;
    pos = r.e;
  }
  if (pos < text.length) html += escapeHtml(text.slice(pos));
  return html;
}

function _aaSelectAbility(i) {
  if (!_aaState) return;
  _aaState.selectedIdx = i;
  _aaRenderText();
  _aaRenderBreakdown();
}

function _aaRenderBreakdown() {
  const { abilities, selectedIdx } = _aaState;
  const container = document.getElementById('aa-breakdown-container');
  if (!container) return;

  const block = abilities[selectedIdx];
  if (!block || !block.effects.length) {
    if (block && block.isAbility) {
      const kind = block.abilityKind === 'triggered' ? 'triggered' : 'activated';
      container.innerHTML = `<div class="aa-empty"><strong>One-shot effect — no layer.</strong><br>This ${kind} ability resolves as a one-time action (drawing cards, gaining life, moving a card between zones, and the like). It doesn't create a continuous effect, so it never enters the CR 613 layer system.</div>`;
    } else {
      container.innerHTML = `<div class="aa-empty">Select a highlighted ability on the left to see which CR 613 layer each part of it applies in.</div>`;
    }
    return;
  }

  const byLayer = new Map();
  block.effects.forEach(eff => {
    if (!byLayer.has(eff.layer)) byLayer.set(eff.layer, []);
    byLayer.get(eff.layer).push(eff);
  });
  const layerIds = [...byLayer.keys()].sort((a, b) => _aaLayerIndex(a) - _aaLayerIndex(b));
  const startLayer = layerIds[0];

  // Activated/triggered abilities create their continuous effect only on resolution.
  let html = block.resolved
    ? `<div class="aa-resolve-note">When this ${block.abilityKind === 'triggered' ? 'triggered' : 'activated'} ability resolves, it creates a continuous effect that applies in:</div>`
    : '';
  html += `<div class="aa-start-note">Begins at
    <span class="layer-badge aa-start-badge" data-layer="${escapeAttr(startLayer)}">Layer ${escapeHtml(startLayer)}</span></div>`;

  for (const lid of layerIds) {
    const cr = LAYER_MAP[lid] ? LAYER_MAP[lid].cr : '';
    const rows = byLayer.get(lid).map(eff =>
      `<div class="aa-eff-line" data-eff="${escapeAttr(eff.id)}" data-layer="${escapeAttr(lid)}">${escapeHtml(capitalizeFirst(_aaDescribeEffect(eff)))}</div>`
    ).join('');
    html += `<div class="aa-layer-row" data-layer="${escapeAttr(lid)}">
      <div class="aa-layer-head">
        <span class="layer-badge">${escapeHtml(lid)}</span>
        <span class="aa-layer-name">${escapeHtml(_aaLayerName(lid))}</span>
        ${cr ? `<span class="layer-cr">${escapeHtml(cr)}</span>` : ''}
      </div>
      <div class="aa-layer-effects">${rows}</div>
    </div>`;
  }
  container.innerHTML = html;
}

/* ----------------------------------------------------------------------------
   Hover-linking between fragments (left) and layer rows (right).
   ------------------------------------------------------------------------- */
function _aaClearActive(scope) {
  scope.querySelectorAll('.aa-active').forEach(n => n.classList.remove('aa-active'));
  scope.querySelectorAll('.aa-lit').forEach(n => n.classList.remove('aa-lit'));
}

function _aaBindHoverLinks(overlay) {
  const scope = overlay.querySelector('.modal-body') || overlay;
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"'));

  // Links the two sides both ways. Hovering a phrase on the LEFT, or a layer row
  // / start badge on the RIGHT, lights the whole layer: every phrase of that
  // layer fills on the left, and that layer's color shows on the right (the
  // matching row's border/badge and, if it's the start layer, the "Begins
  // applying at" badge). With nothing hovered, the right pane is neutral grey.
  const activateLayer = (layer) => {
    _aaClearActive(scope);
    if (layer == null) return;
    scope.querySelectorAll(`.aa-frag[data-layer="${esc(layer)}"]`)
      .forEach(n => n.classList.add('aa-active'));
    const lr = scope.querySelector(`.aa-layer-row[data-layer="${esc(layer)}"]`);
    if (lr) lr.classList.add('aa-lit');
    const sb = scope.querySelector(`.aa-start-badge[data-layer="${esc(layer)}"]`);
    if (sb) sb.classList.add('aa-lit');
  };

  const TRIGGERS = '.aa-frag, .aa-layer-row, .aa-start-badge';
  scope.addEventListener('mouseover', (e) => {
    const el = e.target.closest(TRIGGERS);
    _aaClearActive(scope);
    if (el) activateLayer(el.getAttribute('data-layer'));
  });

  scope.addEventListener('mouseout', (e) => {
    if (e.target.closest(TRIGGERS)) _aaClearActive(scope);
  });
}
