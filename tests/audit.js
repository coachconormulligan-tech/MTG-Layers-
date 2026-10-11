/* Behavioural audit of the target pickers for the Layer Inspector.
   Runs under macOS's built-in JavaScriptCore shell (jsc) or Node — no DOM, no network.
   Driven by tests/audit.py; not loaded by index.html.

   Usage:  <engine> tests/audit.js -- <scripts.json> <cards.json>
   Output: one line per card face, prefixed "@@AUDIT ", holding
     { name, face, layout, typeLine, units[], skipped[], errors[] }
   and one "@@KEYWORDS " line.

   Every card is added last to a fixed two-player board (tests/audit-board.json) and each thing a
   user fires and then targets (a spell, a triggered ability, an activated ability, an "or" option)
   is a unit. Abilities are fired with exactly the arguments the site passes (ui-abilities.js).
   For every unit whose text names one permanent target:
     Check 2 - the picker kind is "single", and the permanents it lists are the ones the text allows
               (worked out by a small interpreter below that does NOT use the parser);
     Check 1 - with no target chosen no permanent changes; with each listed permanent chosen, exactly
               that permanent changes.
   The unit's text decides whether it is audited at all; nothing the parser built is trusted. */

/* ─── Engine shims (same as tests/sweep.js) ─── */
var _args;
if (typeof load === 'function' && typeof readFile === 'function') {
  _args = Array.prototype.slice.call(arguments);
} else {
  const fs = require('fs'), vm = require('vm');
  globalThis.readFile = (p) => fs.readFileSync(p, 'utf8');
  globalThis.load = (p) => vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
  globalThis.print = (...a) => console.log(...a);
  _args = process.argv.slice(2).filter(a => a !== '--');
}

const X_VALUE = 2;
const BOARD_PATH = 'tests/audit-board.json';

function errInfo(stage, e) {
  const stack = String((e && e.stack) || '').split('\n').map(s => s.trim()).filter(Boolean);
  const frame = stack.find(s => /\.js/.test(s) && !/audit\.js/.test(s)) || stack[0] || '';
  const m = frame.match(/([\w$.<>]*)@?.*?([\w-]+\.js):(\d+)/);
  return { stage, msg: String(e && e.message || e).slice(0, 200), where: m ? m[2] + ':' + m[3] + (m[1] ? ' ' + m[1] : '') : frame.slice(0, 120) };
}

/* ═════════════════════════ The board ═════════════════════════ */

let BOARD = null;          // parsed tests/audit-board.json
let roleOf = new Map();    // permanent id -> role

function resetBattlefield() {
  Battlefield.clear();
  Battlefield.exile = [];
  Battlefield.nextExileId = 1;
  Battlefield.bestowTargets = new Map();
  Battlefield.triggerCounts = new Map();
  Battlefield.activateCounts = new Map();
}

// Builds the fixed board through the real add pipeline. Counters, tapped and attacking are set with
// the Battlefield methods the UI handlers call (modifyCounter -> addCounter, toggleTapped,
// toggleAttacking in ui-state-panels.js / ui-battlefield.js).
function buildBoard() {
  resetBattlefield();
  roleOf = new Map();
  Battlefield.players[0].name = BOARD.players[0];
  const opponent = Battlefield.addPlayer(BOARD.players[1]);
  const who = (c) => c === 'p2' ? opponent.id : 'player_0';
  for (const e of BOARD.permanents) {
    const card = JSON.parse(JSON.stringify(e.card));
    const c = who(e.controller);
    // addPermanent gives the permanent to the active player (the site adds from a player's tab).
    Battlefield.activePlayerId = c;
    const perm = Battlefield.addPermanent(card, { suppressPrompt: true, controller: c, owner: c, isToken: !!e.token });
    roleOf.set(perm.id, e.role);
    for (const k of Object.keys(e.counters || {})) Battlefield.addCounter(perm.id, k, e.counters[k]);
    if (e.tapped) Battlefield.toggleTapped(perm.id);
    if (e.attacking) Battlefield.toggleAttacking(perm.id);
  }
  Battlefield.activePlayerId = 'player_0';
  Battlefield._invalidate();
}

function withOracle(card, faceIndex, text) {
  const c = JSON.parse(JSON.stringify(card));
  if (c.card_faces && c.card_faces[faceIndex] && c.card_faces[faceIndex].oracle_text !== undefined) {
    c.card_faces[faceIndex].oracle_text = text;
    if (typeof c.oracle_text === 'string') c.oracle_text = text;
  } else c.oracle_text = text;
  return c;
}

// Adds the audited card last, controlled by player 1, the way tests/sweep.js's addCard does
// (X = 2 and the fixed choices red, Goblin, Forest, artifact, Grizzly Bears).
function addAuditedCard(card, faceIndex, isSpell) {
  const opts = { suppressPrompt: true, controller: 'player_0', owner: 'player_0', xValue: X_VALUE };
  if (card.card_faces && card.card_faces.length >= 2) opts.faceIndex = faceIndex;
  if (isSpell) {
    const spell = Battlefield.addSpell(card, opts);
    if (spell.needsChosenColor) Battlefield.setChosenColor(spell.id, 'red');
    if (spell.needsChosenCreatureType) Battlefield.setChosenCreatureType(spell.id, 'Goblin');
    if (spell.needsChosenLandType) Battlefield.setChosenLandType(spell.id, 'Forest');
    return spell;
  }
  opts.isToken = _isTokenCard(card);
  const perm = Battlefield.addPermanent(card, opts);
  if (perm.isRoom && perm.roomFaces) perm.roomFaces.forEach((_, i) => Battlefield.toggleRoomLock(perm.id, i));
  if (perm.needsChosenColor) Battlefield.setChosenColor(perm.id, 'red');
  if (perm.needsChosenCreatureType) Battlefield.setChosenCreatureType(perm.id, 'Goblin');
  if (perm.needsChosenLandType) Battlefield.setChosenLandType(perm.id, 'Forest');
  if (perm.needsChosenCardType) Battlefield.setChosenCardType(perm.id, 'artifact');
  if (perm.needsChosenCardName) Battlefield.setChosenCardName(perm.id, 'Grizzly Bears');
  if (perm.needsChosenAbilities) Battlefield.setChosenAbilities(perm.id, perm.abilityChoices.slice(0, perm.abilityChoiceCount).join(' and '));
  return perm;
}

/* ─── State summaries ─── */
function summarizeState(st) {
  const sorted = (a) => (a || []).slice().map(String).sort();
  return {
    name: st.name,
    controller: st.controller,
    supertypes: sorted(st.supertypes),
    types: sorted(st.types),
    subtypes: sorted(st.subtypes),
    power: st.power === undefined ? null : st.power,
    toughness: st.toughness === undefined ? null : st.toughness,
    colors: sorted(st.colors),
    abilities: sorted(st.abilities),
    counters: JSON.stringify(Object.keys(st.counters || {}).sort().map(k => [k, st.counters[k]]).filter(x => x[1])),
    traits: sorted(st.traits),
    flags: ['isAllCreatureTypes', 'isAllLandTypes', 'allAbilitiesRemoved', 'oracleTextModified'].filter(k => st[k]).join(','),
  };
}

// Summary of every real permanent (not an ability or spell pseudo-permanent): Map id -> summary.
function summarizeBoard() {
  const states = Battlefield.getAllFinalStates();
  const out = new Map();
  for (const p of Battlefield.permanents) {
    if (p.isManualEffect || p.isSpell) continue;
    const st = states.get(p.id);
    out.set(p.id, st ? summarizeState(st) : null);
  }
  return out;
}

function roleName(id) {
  if (roleOf.has(id)) return roleOf.get(id);
  const p = Battlefield.getPermById(id);
  return p ? 'unknown: ' + p.name : 'unknown: ' + id;
}

function describeChange(a, b) {
  if (!a || !b) return 'state missing';
  const parts = [];
  const pname = (c) => Battlefield.getPlayerName(c) || c;
  for (const k of ['name', 'power', 'toughness', 'controller', 'counters', 'flags']) {
    if (a[k] !== b[k]) parts.push(k + ' ' + (k === 'controller' ? pname(a[k]) + ' → ' + pname(b[k]) : a[k] + ' → ' + b[k]));
  }
  for (const k of ['supertypes', 'types', 'subtypes', 'colors', 'abilities', 'traits']) {
    const add = b[k].filter(x => !a[k].includes(x)), rem = a[k].filter(x => !b[k].includes(x));
    if (add.length) parts.push(k + ' +' + add.join(', +'));
    if (rem.length) parts.push(k + ' -' + rem.join(', -'));
  }
  return parts.join('; ').slice(0, 160);
}

// Permanents whose summary differs between two summaries: [{ id, role, what }].
function diffSummaries(before, after) {
  const changed = [];
  for (const [id, a] of before) {
    const b = after.get(id);
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push({ id, role: roleName(id), what: describeChange(a, b) });
  }
  return changed;
}

/* ═════════════════════════ Classification from the text ═════════════════════════ */

const NUMBER_WORDS = '(?:one|two|three|four|five|six|seven|eight|nine|ten|x|\\d+)';
const PERMANENT_NOUNS = new Set(['creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'permanent', 'battle']);

function stripReminder(text) {
  return _stripReminderText(String(text || '')).replace(/\s+/g, ' ').trim();
}

// Where the phrase after "target" ends: at a verb that says what happens to it, a clause break, or
// the end. A comma inside a list of types ("artifact, creature, or enchantment") does not end it.
const PHRASE_STOP = /\s+(?:gets?|gains?|has|have|becomes?|become|loses?|lose|can|can't|cannot|deals?|is|are|isn't|doesn't|attacks?|blocks?|untaps?|taps?|fights?|phases?|perpetually|assumes|switches|and|then|until|this)\b|[;:.]/;
function extractPhrase(after) {
  let from = 0;
  for (;;) {
    const rest = after.slice(from);
    let m = rest.match(PHRASE_STOP);
    const c = rest.indexOf(',');
    // "you don't control" is part of the phrase; the stop list's "doesn't" is not "don't".
    if (c >= 0 && (!m || c < m.index)) {
      // A comma followed by another type of a list continues the phrase.
      if (/^,\s*(?:or\s+|and\s+)?(?:non-?)?(?:artifact|creature|enchantment|land|planeswalker|battle|permanent)\b/.test(rest.slice(c))) {
        from += c + 1;
        continue;
      }
      return after.slice(0, from + c).trim();
    }
    return (m ? after.slice(0, from + m.index) : after).trim();
  }
}

const ONE_SHOT_VERBS = /\b(?:create|creates|destroy|destroys|exile|exiles|put|puts|return|returns|untap|tap|taps|sacrifice|deals?|draw|choose|attach|fights?|regenerate|counter|search|reveal|goad|transform|flip|amass|bolster|manifest|populate|copy|copies|proliferate|remove|move)\b/;
const CONTINUOUS_VERBS = /^(?:gets?|gains?|has|have|becomes?|become|loses?|lose|can|can't|cannot|assumes|is|are|isn't)\b/;

/* Is this unit's text a "singular permanent target" unit? Returns { singular: true, phrase,
   excludeSource, targetIndex } or { skip: '<reason code>' }. Works from the text alone. */
function classifyUnitText(text) {
  const t0 = String(text || '').replace(/’/g, "'");
  const quotedTarget = /["“][^"”]*\btargets?\b[^"”]*["”]/i.test(t0);
  const masked = t0.replace(/["“][^"”]*["”]/g, 'QUOTED');
  const lower = masked.toLowerCase();
  const hits = [...lower.matchAll(/\btargets?\b/g)];
  if (!hits.length) return { skip: quotedTarget ? 'target-in-quote' : 'no-target' };
  if (hits.length > 1) return { skip: 'multiple-targets' };
  if (hits[0][0] === 'targets') return { skip: 'targets-verb' };
  const idx = hits[0].index;
  const before = lower.slice(0, idx);
  if (/\bup to (?:\w+ )?(?:other )?$/.test(before)) return { skip: 'up-to' };
  if (/\bany number of (?:other )?$/.test(before)) return { skip: 'any-number' };
  if (/\beach $/.test(before)) return { skip: 'each-target' };
  if (/\bany $/.test(before)) return { skip: 'any-target' };
  if (new RegExp('\\b' + NUMBER_WORDS + ' (?:other )?$').test(before)) return { skip: 'n-target' };
  const after = lower.slice(idx + 'target'.length).trim();
  const phrase = extractPhrase(after);
  if (!phrase) return { skip: 'empty-phrase' };
  // The engine models continuous effects only. "Destroy / exile / put a counter on / create a token
  // that's a copy of target ..." is a one-shot action: the target is the object of a verb, not the
  // subject of "gets / gains / becomes", and no parse could be expected to give it a targeted effect.
  const clauseBefore = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf(';')) + 1);
  const verbAfter = after.slice(phrase.length).trim();
  // (Gaining control is a continuous effect, layer 2.)
  const takesControl = /\bgains? control of (?:another |that |the )?$/.test(clauseBefore);
  if (!takesControl && (ONE_SHOT_VERBS.test(clauseBefore) || !CONTINUOUS_VERBS.test(verbAfter))) return { skip: 'one-shot-action' };
  // "Target creature can't be blocked this turn" / "can't be regenerated" / "can attack as though
  // it didn't have defender": a rule about the target, not a change to what it is. The site does
  // not model these, so there is no targeted effect to expect.
  if (/^(?:can|can't|cannot)\b/.test(verbAfter) && !/\b(?:gets?|gains?|has|have|becomes?|loses?)\b/.test(verbAfter)) return { skip: 'not-a-layer-effect' };
  if (/'s\b/.test(phrase)) return { skip: 'possessive-target' };
  // "creature or player", "target opponent", "creature card in a graveyard", "spell". ("creature that
  // player controls" and "this card creature" are permanents; the interpreter reports what it cannot read.)
  if (!/^this /.test(phrase) && /\b(?:spell|spells|ability|abilities|card|cards|graveyard|library|hand|instant|sorcery)\b/.test(phrase)) return { skip: 'not-a-permanent' };
  if (/^(?:players?|opponents?)\b|(?:\bor|\band\/or|,)\s+(?:another\s+)?(?:players?|opponents?)\b/.test(phrase)) return { skip: 'not-a-permanent' };
  if (/\b(?:creatures|artifacts|enchantments|lands|planeswalkers|permanents)\b/.test(phrase)) return { skip: 'plural-target' };
  return { singular: true, phrase, excludeSource: /\banother $/.test(before) || /^other /.test(phrase), targetIndex: idx };
}

/* Does the text outside the target's own clause also name the source or a group? Kept as one
   small function so it can be tuned: { source, group }. */
const SELF_WORDS = /\bthis (?:creature|permanent|card|artifact|enchantment|land|token|vehicle|equipment|aura|planeswalker|spell|saga|class)\b|~/;
const GROUP_WORDS = /(?<!for )\beach (?:other )?(?:creature|permanent|artifact|land|enchantment|planeswalker)\b|\b(?:all|every) (?:other )?(?:creatures|permanents|artifacts|lands|enchantments|planeswalkers)\b|\bother (?:\w+ )?(?:creatures|permanents|artifacts|lands|enchantments)\b|\b\w+s you control (?:get|have|gain)\b/;
function mixedSubject(text, targetIndex, cardName, isSpell) {
  const lower = String(text).replace(/’/g, "'").replace(/["“][^"”]*["”]/g, 'QUOTED').toLowerCase();
  // Clauses: sentences, then "and" / "then" / ";" within them.
  const clauses = [];
  const re = /[^.;]+/g;
  let m;
  while ((m = re.exec(lower))) {
    let off = m.index;
    for (const piece of m[0].split(/(\s+and\s+|,\s*then\s+|\s+then\s+)/)) {
      if (/^(?:\s+and\s+|,\s*then\s+|\s+then\s+)$/.test(piece)) { off += piece.length; continue; }
      clauses.push({ start: off, end: off + piece.length, text: piece });
      off += piece.length;
    }
  }
  const own = clauses.find(c => targetIndex >= c.start && targetIndex < c.end);
  const others = clauses.filter(c => c !== own);
  const names = [String(cardName || '').toLowerCase()];
  const comma = names[0].indexOf(',');
  if (comma > 0) names.push(names[0].slice(0, comma));
  const mentionsName = (s) => names.some(n => n.length > 2 && s.includes(n));
  const itBefore = own ? clauses.filter(c => c.end <= own.start).some(c => /\bit(?:s)?\b/.test(c.text)) : false;
  return {
    // A spell is not on the battlefield, so "this spell" and its own name name nothing a target could be.
    source: !isSpell && (others.some(c => SELF_WORDS.test(c.text) || mentionsName(c.text)) || itBefore),
    group: others.some(c => GROUP_WORDS.test(c.text)),
  };
}

/* ═════════════════════════ The independent phrase interpreter ═════════════════════════ */
/* Closed vocabulary; never calls the parser. A word outside it makes the whole phrase "not
   understood". TypeCatalog (data) is used only to recognise a subtype word. */

const COLOR_CODES = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const SUPERTYPE_WORDS = new Set(['legendary', 'basic', 'snow']);
let SUBTYPE_WORDS = null;
function subtypeWords() {
  if (SUBTYPE_WORDS) return SUBTYPE_WORDS;
  SUBTYPE_WORDS = new Set();
  for (const k of ['creatureTypes', 'landTypes', 'artifactTypes', 'enchantmentTypes', 'planeswalkerTypes']) {
    for (const w of (TypeCatalog[k] || [])) SUBTYPE_WORDS.add(String(w).toLowerCase());
  }
  // Words that are also plain vocabulary here stay vocabulary.
  for (const w of [...PERMANENT_NOUNS, 'token', 'tapped', 'untapped', 'attacking', 'blocking']) SUBTYPE_WORDS.delete(w);
  return SUBTYPE_WORDS;
}

const cap1 = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const hasCI = (arr, w) => (arr || []).some(x => String(x).toLowerCase() === w);
function traitsOf(st, perm) { return (st && st.traits) || perm.traits || []; }
function stateColors(st) {
  return (st.colors || []).map(c => { const l = String(c).toLowerCase(); return COLOR_CODES[l] || String(c).toUpperCase(); });
}
function keywordsOf(st) {
  const out = [];
  for (const line of (st.abilities || [])) for (const piece of String(line).split(/,\s*|\s+and\s+/)) out.push(piece.trim().toLowerCase());
  return out;
}
function hasKeyword(st, kw) { return keywordsOf(st).some(a => a === kw || a.startsWith(kw + ' ')); }

// One word of a head item -> { kind: 'adj' | 'noun', test(st, perm) } or null.
function wordConstraint(w, negated) {
  let c = null;
  if (COLOR_CODES[w]) c = { kind: 'adj', test: (st) => stateColors(st).includes(COLOR_CODES[w]) };
  else if (w === 'colorless') c = { kind: 'adj', test: (st) => stateColors(st).length === 0 };
  else if (w === 'multicolored') c = { kind: 'adj', test: (st) => stateColors(st).length >= 2 };
  else if (SUPERTYPE_WORDS.has(w)) c = { kind: 'adj', test: (st) => hasCI(st.supertypes, w) };
  else if (w === 'token') c = { kind: 'adj', test: (st, p) => !!p.isToken };
  else if (w === 'attacking') c = { kind: 'adj', test: (st, p) => traitsOf(st, p).includes('Attacking') };
  else if (w === 'blocking') c = { kind: 'adj', test: (st, p) => traitsOf(st, p).includes('Blocking') };
  else if (w === 'tapped') c = { kind: 'adj', test: (st, p) => !!p.tapped || traitsOf(st, p).includes('Tapped') };
  else if (w === 'untapped') c = { kind: 'adj', test: (st, p) => !(p.tapped || traitsOf(st, p).includes('Tapped')) };
  else if (w === 'permanent') c = { kind: 'noun', test: () => true };
  else if (PERMANENT_NOUNS.has(w)) c = { kind: 'noun', test: (st) => hasCI(st.types, w) };
  else if (subtypeWords().has(w)) c = { kind: 'noun', test: (st) => hasCI(st.subtypes, w) || (!!st.isAllCreatureTypes && TypeCatalog.creatureTypes.has(cap1(w))) };
  if (c && negated) { const t = c.test; c = { kind: 'adj', test: (st, p) => !t(st, p) }; }
  return c;
}

function parseHeadItem(words, unknown) {
  const adj = [], noun = [];
  for (const w of words) {
    let neg = false, base = w;
    const m = w.match(/^non-?(.+)$/);
    if (m) { neg = true; base = m[1]; }
    const c = wordConstraint(base, neg);
    if (!c) { unknown.push(w); continue; }
    (c.kind === 'noun' ? noun : adj).push(c.test);
  }
  return { adj, noun };
}

const allOf = (tests) => (st, p) => tests.every(t => t(st, p));

// Returns { test(st, perm, ctx), excludeSource } or { unknown: [words] }.
function interpretPhrase(phrase) {
  const unknown = [];
  let s = String(phrase).toLowerCase().replace(/\s+/g, ' ').trim();
  let excludeSource = false;
  s = s.replace(/^(?:another|other) /, () => { excludeSource = true; return ''; });
  const cut = s.search(/ (?:you control|you don't control|an opponent controls|with |without )/);
  const head = cut >= 0 ? s.slice(0, cut) : s;
  let tail = cut >= 0 ? s.slice(cut).trim() : '';

  // Head: items joined by "or" / commas; an item is the AND of its words.
  const items = head.split(/\s*,\s*(?:or\s+)?|\s+or\s+/).map(x => x.trim()).filter(Boolean).map(x => parseHeadItem(x.split(' '), unknown));
  if (!items.length) unknown.push('(nothing)');
  let headTest = null;
  if (items.length) {
    const last = items[items.length - 1];
    const adjOnly = items.slice(0, -1).filter(i => !i.noun.length);
    if (adjOnly.length) {
      // "attacking or blocking creature": the leading items are adjectives of the last one.
      if (!last.noun.length || !last.adj.length || adjOnly.length !== items.length - 1) unknown.push('(adjective list)');
      else {
        const alts = [...adjOnly.map(i => allOf(i.adj)), allOf(last.adj)];
        const nounTest = allOf(last.noun);
        headTest = (st, p) => alts.some(a => a(st, p)) && nounTest(st, p);
      }
    } else {
      if (items.some(i => !i.noun.length)) unknown.push('(no noun)');
      const alts = items.map(i => allOf([...i.adj, ...i.noun]));
      headTest = (st, p) => alts.some(a => a(st, p));
    }
  }

  // Tail clauses, in any order.
  const clauseTests = [];
  let guard = 0;
  while (tail && guard++ < 10) {
    let m;
    if ((m = tail.match(/^you control\b\s*/))) { clauseTests.push((st, p, ctx) => ctrlOf(st, p) === ctx.sourceCtrl); tail = tail.slice(m[0].length); continue; }
    if ((m = tail.match(/^(?:you don't control|an opponent controls)\b\s*/))) { clauseTests.push((st, p, ctx) => ctrlOf(st, p) !== ctx.sourceCtrl); tail = tail.slice(m[0].length); continue; }
    if ((m = tail.match(/^with (?:a|an) \+1\/\+1 counter on it\s*/))) { clauseTests.push((st, p) => counterCount(st, p, '+1/+1') > 0); tail = tail.slice(m[0].length); continue; }
    if ((m = tail.match(/^with (?:a|an) counter on it\s*/))) { clauseTests.push((st, p) => anyCounter(st, p) > 0); tail = tail.slice(m[0].length); continue; }
    if ((m = tail.match(/^with (power|toughness|mana value) (\d+) or (less|greater|more)\s*/))) {
      const [, stat, n, dir] = m; const num = Number(n);
      clauseTests.push((st, p) => { const v = statValue(st, p, stat); return v !== null && (dir === 'less' ? v <= num : v >= num); });
      tail = tail.slice(m[0].length); continue;
    }
    if ((m = tail.match(/^with (power|toughness|mana value) (\d+)\b\s*/))) {
      const [, stat, n] = m; const num = Number(n);
      clauseTests.push((st, p) => statValue(st, p, stat) === num);
      tail = tail.slice(m[0].length); continue;
    }
    if ((m = tail.match(/^(with|without) ((?:[a-z' ]+?)(?:(?:,\s*|\s+or\s+|\s+and\s+)[a-z' ]+?)*)(?= you control| you don't control| an opponent controls| with | without |$)/))) {
      const without = m[1] === 'without';
      const kws = m[2].split(/,\s*(?:or\s+|and\s+)?|\s+or\s+|\s+and\s+/).map(x => x.trim()).filter(Boolean);
      const isAnd = / and /.test(m[2]) && !/ or /.test(m[2]);
      if (!kws.length || !kws.every(k => KEYWORD_SET.has(k))) { unknown.push(...kws.filter(k => !KEYWORD_SET.has(k)), m[1]); break; }
      clauseTests.push((st) => { const hits = kws.map(k => hasKeyword(st, k)); const any = isAnd ? hits.every(Boolean) : hits.some(Boolean); return without ? !any : any; });
      tail = tail.slice(m[0].length).trim(); continue;
    }
    unknown.push(...tail.split(' ').slice(0, 4));
    break;
  }
  if (unknown.length) return { unknown };
  return { test: (st, p, ctx) => headTest(st, p) && clauseTests.every(t => t(st, p, ctx)), excludeSource };
}
function ctrlOf(st, p) { return (st && st.controller) || p.controller || p.owner || 'player_0'; }
function counterCount(st, p, kind) { const c = (st && st.counters) || p.counters || {}; return c[kind] || 0; }
function anyCounter(st, p) { const c = (st && st.counters) || p.counters || {}; return Object.keys(c).reduce((n, k) => n + (c[k] || 0), 0); }
function statValue(st, p, stat) {
  if (stat === 'mana value') return Number(st.manaValue !== undefined ? st.manaValue : (p.manaValue || 0));
  const v = st[stat];
  return typeof v === 'number' ? v : (v !== null && v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : null);
}

/* ═════════════════════════ Firing, as the site does it ═════════════════════════ */

const COLOR_NAME = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
const PROTECTION_CHOICE = /gains?\s+protection\s+from\s+the\s+color\s+of\s+your\s+choice/i;

function finishPseudo(pseudo) {
  if (!pseudo) return;
  if (pseudo.hasXValue) Battlefield.setXValue(pseudo.id, X_VALUE);
  if (pseudo.needsChosenColor) Battlefield.setChosenColor(pseudo.id, 'red');
  if (pseudo.needsChosenCreatureType) Battlefield.setChosenCreatureType(pseudo.id, 'Goblin');
  if (pseudo.needsChosenLandType) Battlefield.setChosenLandType(pseudo.id, 'Forest');
}

// Mirrors ui-abilities.js _fireTriggeredWithText.
function fireTriggeredWithText(permId, abilityIdx, effectText, fullText, finalStates) {
  const pseudo = Battlefield.addTriggeredAbility(permId, abilityIdx, effectText, fullText, finalStates);
  if (pseudo) Battlefield.injectTriggeredExchange(pseudo, permId, effectText);
  if (pseudo) Battlefield.injectTriggeredBecomesLand(pseudo, permId, effectText);
  Battlefield.evaluate();
  return pseudo;
}

/* What a click on a triggered ability's "Trigger" button leads to, one entry per distinct way of
   firing it. Mirrors ui-abilities.js fireTriggeredAbility branch for branch. Returns
   [{ label, text, fire() -> pseudo }] or [{ skip }]. */
function triggerPlans(permId, t) {
  const finalStates = Battlefield.getAllFinalStates();
  const fState = finalStates.get(permId);
  if (!fState) return [{ skip: 'no-final-state' }];
  // (fireTriggeredAbility: the trigger limit check - the count is 0 on a fresh board.)
  // fireTriggeredAbility: an "if [condition]," prefix that is evaluable and false does nothing.
  const ifCondMatch = t.effectText.match(/^if\s+([^,]+),\s*/i);
  if (ifCondMatch) {
    const condResult = _evaluateTriggerCondition(ifCondMatch[1].trim(), fState);
    if (condResult === false) return [{ skip: 'trigger-condition-false' }];
  }
  // fireTriggeredAbility: "choose one —" modes -> openActivateOptionsPopup -> _chooseTriggerMode, which
  // fires t.options[i] with t.fullText and freshly read final states.
  if (t.options && t.options.length >= 2) {
    return t.options.map((opt, i) => ({ label: 'option ' + (i + 1), text: opt,
      fire: () => fireTriggeredWithText(permId, t.index, opt, t.fullText, Battlefield.getAllFinalStates()) }));
  }
  // fireTriggeredAbility: a vote decided by most votes -> openVotePopup. The first option is taken as the winner.
  const vote = parseVoteOptions(t.effectText);
  if (vote && vote.decidedByMost) {
    const text = resolveVoteText(t.effectText, [vote.options[0]]);
    return [{ label: 'vote ' + vote.options[0], text, fire: () => fireTriggeredWithText(permId, t.index, text, t.fullText, finalStates) }];
  }
  // fireTriggeredAbility: "gains protection from the color of your choice" -> openColorChoicePopup; red is chosen.
  if (PROTECTION_CHOICE.test(t.effectText)) {
    const text = t.effectText.replace(/the\s+color\s+of\s+your\s+choice/i, COLOR_NAME.R);
    return [{ label: '', text, fire: () => fireTriggeredWithText(permId, t.index, text, t.fullText, finalStates) }];
  }
  return [{ label: '', text: t.effectText, fire: () => fireTriggeredWithText(permId, t.index, t.effectText, t.fullText, finalStates) }];
}

/* The same for an activated ability: ui-abilities.js fireActivatedAbility. */
function activatedPlans(permId, a) {
  const finalStates = Battlefield.getAllFinalStates();
  const fState = finalStates.get(permId);
  if (!fState) return [{ skip: 'no-final-state' }];
  // (fireActivatedAbility: the activation limit check - the count is 0 on a fresh board.)
  // fireActivatedAbility: the Coven condition (N creatures with different powers).
  const covenMatch = a.effectText.match(/activate\s+only\s+if\s+you\s+control\s+(\w+)\s+or\s+more\s+creatures\s+with\s+different\s+powers/i);
  if (covenMatch) {
    const threshold = _parseWordNumber(covenMatch[1]) || parseInt(covenMatch[1], 10) || 3;
    const srcPerm = Battlefield.getPermById(permId);
    const controller = srcPerm ? (srcPerm.controller || srcPerm.owner || Battlefield.activePlayerId) : Battlefield.activePlayerId;
    const distinctPowers = new Set();
    for (const [pid, st] of finalStates) {
      const pp = Battlefield.getPermById(pid);
      if (!pp || pp.isManualEffect) continue;
      if ((pp.controller || pp.owner || Battlefield.activePlayerId) !== controller) continue;
      if (!st.types || !st.types.includes('Creature')) continue;
      if (st.power !== null && st.power !== undefined) distinctPowers.add(Number(st.power));
    }
    if (distinctPowers.size < threshold) return [{ skip: 'activation-condition-false' }];
  }
  if (a.isMonstrosity) return [{ skip: 'monstrosity' }];            // fireActivatedAbility adds a trait only
  if (a.isCrew || a.isSaddle) return [{ skip: 'crew-saddle' }];     // applyCrew / applySaddle
  if (a.isEquip || a.isReconfigure || a.isFortify) return [{ skip: 'equip' }];   // openEquipModal
  // fireActivatedAbility: "or" options -> openActivateOptionsPopup -> _chooseActivateOption, which calls
  // addActivatedAbility(permId, idx, option, a.fullText, finalStates) with freshly read final states.
  if (a.options && a.options.length >= 2) {
    return a.options.map((opt, i) => ({ label: 'option ' + (i + 1), text: opt,
      fire: () => Battlefield.addActivatedAbility(permId, a.index, opt, a.fullText, Battlefield.getAllFinalStates()) }));
  }
  // fireActivatedAbility: "gains protection from the color of your choice" -> openColorChoicePopup. Red is chosen.
  // NOTE the site calls addActivatedAbility with NO final states here (the other branches pass them).
  if (PROTECTION_CHOICE.test(a.effectText)) {
    const text = a.effectText.replace(/the\s+color\s+of\s+your\s+choice/i, COLOR_NAME.R);
    return [{ label: '', text, fire: () => Battlefield.addActivatedAbility(permId, a.index, text, a.fullText) }];
  }
  // fireActivatedAbility: "Choose a color. …" -> openColorChoicePopup, with final states.
  if (/^choose a color\./i.test(a.effectText)) {
    const text = a.effectText.replace(/^choose a color\.\s*/i, '').replace(/\bthat color\b/gi, COLOR_NAME.R);
    return [{ label: '', text, fire: () => Battlefield.addActivatedAbility(permId, a.index, text, a.fullText, finalStates) }];
  }
  // fireActivatedAbility: a vote decided by most votes -> openVotePopup. The first option is taken as the winner.
  const vote = parseVoteOptions(a.effectText);
  if (vote && vote.decidedByMost) {
    const text = resolveVoteText(a.effectText, [vote.options[0]]);
    return [{ label: 'vote ' + vote.options[0], text, fire: () => Battlefield.addActivatedAbility(permId, a.index, text, a.fullText, finalStates) }];
  }
  return [{ label: '', text: a.effectText, fire: () => Battlefield.addActivatedAbility(permId, a.index, a.effectText, a.fullText, finalStates) }];
}

/* ═════════════════════════ Auditing one unit ═════════════════════════ */

// Runs fn, then puts the board back exactly as it was (as tests/sweep.js's fireAbility does).
function withRestore(fn) {
  const savedPerms = Battlefield.permanents.slice(), savedEffects = Battlefield.effects.slice();
  const effState = savedEffects.map(e => [e, e.targetId, e.targetIds ? e.targetIds.slice() : undefined, e.timestamp, e.disabled]);
  try { return fn(); }
  finally {
    Battlefield.permanents = savedPerms;
    Battlefield.effects = savedEffects;
    for (const [e, tid, tids, ts, dis] of effState) {
      e.targetId = tid;
      if (tids !== undefined) e.targetIds = tids;
      e.timestamp = ts;
      e.disabled = dis;
    }
    Battlefield.triggerCounts = new Map();
    Battlefield.activateCounts = new Map();
    Battlefield.updateLabels();
    Battlefield._invalidate();
  }
}

// Chooses (or clears) the target the way the picker of this kind does.
function applyTarget(unitId, picker, targetId) {
  if (picker.kind === 'multi') {
    // Clearing slot 0 of a multi-target effect.
    Battlefield.setMultiTarget(unitId, 0, targetId);
  } else if (picker.kind === 'slotted') {
    Battlefield.setSlottedTarget(unitId, 0, targetId);
  } else if (picker.kind === 'modal') {
    for (const m of picker.modes) Battlefield.setModalModeTarget(unitId, m, targetId);
  } else {
    Battlefield.setTarget(unitId, targetId);   // setEffectTarget in ui-targeting.js
  }
  Battlefield._invalidate();
}

function candidatesFor(unitId, picker) {
  const opts = picker.kind === 'multi' ? { kind: 'multi', slotIndex: 0 }
    : picker.kind === 'slotted' ? { kind: 'slotted', slot: 0 }
    : picker.kind === 'modal' ? { kind: 'modal', modeIndex: picker.modes[0] }
    : { kind: 'single' };
  return getTargetCandidates(unitId, opts);
}

function rolesOf(ids) { return ids.map(roleName); }

/* The shortest sentence about a unit that a report line needs. */
function unitSummary(u) { return u.kind + (u.index !== undefined ? ' ' + u.index : '') + (u.label ? ' (' + u.label + ')' : ''); }

const COUNT_DEPENDENT = /\bfor each\b|\bwhere x is\b|\bequal to the number\b|\bequal to (?:the|that|its|your)\b/i;

/* Audits one unit that has already been fired/cast: `id` is the permanent whose effects are the
   unit's (the ability pseudo-permanent, or the spell). */
function auditFired(ctx, u, id) {
  const finding = (check, code, extra) => u.findings.push(Object.assign({ check, code }, extra || {}));
  const effs = Battlefield.effects.filter(e => e.sourceId === id);
  const targeted = effs.filter(e => e.scope === 'targeted' && !e.selfTarget);
  const finalStates = Battlefield.getAllFinalStates();

  // Parts of the site that take over from the ordinary list.
  const info = getEffectInfo(id, finalStates.get(id));
  const pseudo = Battlefield.getPermById(id);
  if (info.hasText) return { skip: 'text-change-modal' };
  if (info.hasExchangeControl) return { skip: 'exchange-control-modal' };
  if (info.hasCopy) return { skip: 'copy-picker' };
  if (info.hasEquipSource) return { skip: 'equip' };
  if (pseudo && pseudo._refPick) return { skip: 'ref-picker' };
  if (pseudo && (pseudo._targetsOpponentPlayer || pseudo._targetsChosenPlayer || pseudo._isEnchantPlayer)) return { skip: 'player-picker' };
  if (pseudo && pseudo.hasBestow) return { skip: 'bestow' };
  if (effs.some(e => e.auraRestriction)) return { skip: 'aura-attach' };

  if (!targeted.length) {
    finding('check2', 'no-targeted-effect');
    return { audited: true };
  }

  /* ── Check 2: the picker ── */
  const picker = getTargetPickerKind(id, finalStates.get(id));
  u.pickerKind = picker.kind;
  if (picker.kind === 'none') finding('check2', 'no-picker');
  else if (picker.kind !== 'single') finding('check2', 'picker-kind-' + picker.kind);

  let siteIds = null, siteBlocked = null;
  if (picker.kind !== 'none') {
    try {
      const r = candidatesFor(id, picker);
      if (r.blocked) siteBlocked = r.blocked; else siteIds = r.candidates.map(c => c.id);
    } catch (e) { finding('check2', 'crash', { error: errInfo('candidates', e) }); }
  }
  u.actual = siteIds ? rolesOf(siteIds) : null;
  if (siteBlocked) u.blocked = siteBlocked;

  let expectedIds = null;
  const interp = interpretPhrase(u.phrase);
  if (interp.unknown) {
    u.phraseUnknown = interp.unknown;
  } else {
    const sourceCtrl = ctx.sourceCtrl;
    const exclude = interp.excludeSource || u.excludeSource;
    expectedIds = [];
    for (const p of ctx.universe) {
      if (exclude && p.id === ctx.sourceId) continue;
      const st = ctx.preStates.get(p.id);
      if (!st) continue;
      if (!interp.test(st, p, { sourceCtrl })) continue;
      // Shroud and hexproof (CR 702.18, 702.11): not targeting rules of the phrase, but of the game.
      const kws = keywordsOf(st);
      if (kws.includes('shroud')) continue;
      if (kws.includes('hexproof') && ctrlOf(st, p) !== sourceCtrl) continue;
      expectedIds.push(p.id);
    }
    u.expected = rolesOf(expectedIds);
    if (siteIds) {
      const missing = expectedIds.filter(x => !siteIds.includes(x)), extra = siteIds.filter(x => !expectedIds.includes(x));
      if (!siteIds.length && expectedIds.length) finding('check2', 'empty-list', { missing: rolesOf(missing), extra: [] });
      else if (missing.length || extra.length) finding('check2', 'list-mismatch', { missing: rolesOf(missing), extra: rolesOf(extra) });
    }
  }

  /* ── Check 1: what changes ── */
  const mixed = mixedSubject(u.text, u.targetIndex, ctx.cardName, u.kind === 'spell');
  u.mixed = mixed;
  const isMixed = mixed.source || mixed.group;
  const before = ctx.before;

  const noTargetChanged = diffSummaries(before, summarizeBoard());
  u.check1 = { noTarget: noTargetChanged.map(c => ({ role: c.role, what: c.what })), perTarget: [] };
  if (!isMixed && noTargetChanged.length) {
    finding('check1', 'changes-with-no-target', { changed: noTargetChanged.map(c => ({ role: c.role, what: c.what })) });
  }

  // Each permanent the picker lists in turn; if it lists none, the ones the text allows.
  let tryIds = siteIds && siteIds.length ? siteIds : (expectedIds || []);
  u.check1.via = siteIds && siteIds.length ? 'picker' : 'text';
  const othersSeen = [], noOp = [];
  let anyTargetChanged = false;
  for (const tid of tryIds.slice(0, 14)) {
    let changed = [];
    try {
      applyTarget(id, picker, tid);
      changed = diffSummaries(before, summarizeBoard());
    } catch (e) {
      finding('check1', 'crash', { error: errInfo('set target', e) });
      break;
    } finally {
      try { applyTarget(id, picker, null); } catch (e) { /* the board is restored by the caller */ }
    }
    const role = roleName(tid);
    let counted = changed;
    if (mixed.source) counted = counted.filter(c => c.id !== ctx.sourceId);
    const targetChanged = changed.some(c => c.id === tid) && !(mixed.source && tid === ctx.sourceId);
    const others = mixed.group ? [] : counted.filter(c => c.id !== tid);
    u.check1.perTarget.push({ target: role, changed: changed.map(c => ({ role: c.role, what: c.what })) });
    if (targetChanged) anyTargetChanged = true; else noOp.push(role);
    if (others.length) othersSeen.push({ target: role, others: others.map(c => ({ role: c.role, what: c.what })) });
  }
  if (othersSeen.length) finding('check1', 'target-changes-others', { examples: othersSeen.slice(0, 3), count: othersSeen.length });
  if (tryIds.length && !anyTargetChanged && !othersSeen.length) {
    // "-1/-1 for each Swamp you control", "where X is the number of cards in your graveyard": the board has
    // none, so the right answer may be a change of 0. Only for text that does nothing but give +N/-N,
    // so a keyword grant beside a count cannot hide behind it.
    if (COUNT_DEPENDENT.test(u.text) && /\bgets?\b/i.test(u.text) && !/\b(?:gains?|has|have|becomes?|loses?)\b/i.test(u.text)) u.infos.push({ code: 'count-or-condition-dependent', roles: [] });
    else finding('check1', 'target-changes-nothing', { tried: tryIds.length });
  }
  if (anyTargetChanged && noOp.length) u.infos.push({ code: 'no-op-on-some', roles: noOp });
  return { audited: true };
}

function auditUnit(ctx, u, fire) {
  // Everything about a unit happens on a board that is put back afterwards.
  return withRestore(() => {
    let id;
    try {
      const pseudo = fire();
      if (!pseudo) return { skip: 'fire-returned-nothing' };
      finishPseudo(pseudo);
      id = pseudo.id;
    } catch (e) {
      u.findings.push({ check: 'check2', code: 'crash', error: errInfo('fire ' + u.kind, e) });
      return { audited: true };
    }
    try { return auditFired(ctx, u, id); }
    catch (e) { u.findings.push({ check: 'check2', code: 'crash', error: errInfo('audit', e) }); return { audited: true }; }
  });
}

/* ═════════════════════════ One card face ═════════════════════════ */

function newUnit(kind, index, label, text, cls) {
  return { kind, index, label, text, findings: [], infos: [],
    phrase: cls.phrase, excludeSource: cls.excludeSource, targetIndex: cls.targetIndex };
}

function auditFace(card, faceIndex) {
  const face = _resolveCardFace(card, faceIndex);
  const typeLine = face.type_line || card.type_line || '';
  const isSpell = /\b(instant|sorcery)\b/i.test(typeLine);
  const rec = { name: face.name || card.name, face: faceIndex, layout: card.layout, typeLine, units: [], skipped: [], errors: [] };
  const skip = (kind, index, label, text, reason) => rec.skipped.push({ unit: kind + (index !== undefined ? ' ' + index : '') + (label ? ' (' + label + ')' : ''), reason, text: String(text || '').slice(0, 140) });

  let perm, ctx;
  try {
    buildBoard();
    const sourceCtrl = 'player_0';
    if (isSpell) {
      // The board before the spell exists: what the spell must (not) change is measured against it.
      const preStates = Battlefield.getAllFinalStates();
      const before = summarizeBoard();
      const universe = Battlefield.permanents.filter(p => !p.isManualEffect && !p.isSpell);
      perm = addAuditedCard(card, faceIndex, true);
      ctx = { cardName: rec.name, sourceCtrl, sourceId: perm.id, preStates, before, universe };
    } else {
      perm = addAuditedCard(card, faceIndex, false);
      roleOf.set(perm.id, 'source');
      const preStates = Battlefield.getAllFinalStates();
      const before = summarizeBoard();
      const universe = Battlefield.permanents.filter(p => !p.isManualEffect && !p.isSpell);
      ctx = { cardName: rec.name, sourceCtrl, sourceId: perm.id, preStates, before, universe };
    }
  } catch (e) { rec.errors.push(errInfo('add', e)); return rec; }

  const run = (u, fire) => {
    const out = auditUnit(ctx, u, fire);
    if (out.skip) skip(u.kind, u.index, u.label, u.text, out.skip);
    else rec.units.push(u);
  };

  /* Spells: the unit is the spell itself. */
  if (isSpell) {
    const text = stripReminder(face.oracle_text || '');
    if (perm.isModalSpell) { skip('spell', undefined, '', text, 'modal-spell'); return rec; }
    const cls = classifyUnitText(text);
    if (!cls.singular) { skip('spell', undefined, '', text, cls.skip); return rec; }
    const u = newUnit('spell', undefined, '', text, cls);
    // Casting happened in addAuditedCard; the spell's own effects are the unit's.
    run(u, () => perm);
    return rec;
  }

  /* Permanents: an Aura's attach target is out of scope. */
  if (Battlefield.effects.some(e => e.sourceId === perm.id && e.auraRestriction)) skip('attach', undefined, '', face.oracle_text, 'aura-attach');

  const states = Battlefield.getAllFinalStates();
  const fState = states.get(perm.id);
  const abilities = ((fState && fState.abilities) || []).slice();
  let triggers = [], activated = [];
  try {
    triggers = Battlefield.extractTriggeredAbilities(abilities);
    activated = Battlefield.extractActivatedAbilities(abilities);
  } catch (e) { rec.errors.push(errInfo('extract abilities', e)); return rec; }

  const unitsFor = (kind, ab, plans) => {
    for (const plan of plans) {
      if (plan.skip) { skip(kind, ab.index, '', stripReminder(ab.effectText), plan.skip); continue; }
      const text = stripReminder(plan.text);
      const cls = classifyUnitText(text);
      if (!cls.singular) { skip(kind, ab.index, plan.label, text, cls.skip); continue; }
      const u = newUnit(kind, ab.index, plan.label, text, cls);
      run(u, plan.fire);
    }
  };
  for (const t of triggers) {
    try { unitsFor('trigger', t, triggerPlans(perm.id, t)); }
    catch (e) { rec.errors.push(errInfo('trigger ' + t.index, e)); }
  }
  for (const a of activated) {
    try { unitsFor('activated', a, activatedPlans(perm.id, a)); }
    catch (e) { rec.errors.push(errInfo('activated ' + a.index, e)); }
  }
  return rec;
}

/* ═════════════════════════ Main ═════════════════════════ */
(function main() {
  const scripts = JSON.parse(readFile(_args[0]));
  for (const f of scripts) load(f);
  const catalog = JSON.parse(readFile('tests/type-catalog.json'));
  for (const k of Object.keys(catalog)) {
    TypeCatalog[k] = new Set([...(TypeCatalog[k] || []), ...catalog[k]]);
  }
  TypeCatalog.loaded = true;
  globalThis.prompt = () => { throw new Error('prompt() called headlessly'); };
  Battlefield._randomPick = (options) => options[0];
  globalThis.console = globalThis.console || {};
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) console[k] = () => {};
  BOARD = JSON.parse(readFile(BOARD_PATH));

  print('@@KEYWORDS ' + JSON.stringify([...KEYWORD_SET]));
  const cards = JSON.parse(readFile(_args[1]));
  for (const card of cards) {
    const isRoom = (card.card_faces || []).some(f => (f.type_line || '').includes('Room'));
    const multi = card.card_faces && card.card_faces.length >= 2 && !isRoom &&
      (TRANSFORMABLE_LAYOUTS.has(card.layout) || _hasChooseableFaces(card) || _isTransformingToken(card) || card.layout === 'battle' || card.layout === 'flip');
    const nFaces = multi ? card.card_faces.length : 1;
    for (let fi = 0; fi < nFaces; fi++) {
      let rec;
      try { rec = auditFace(card, fi); }
      catch (e) { rec = { name: card.name, face: fi, layout: card.layout, typeLine: card.type_line || '', units: [], skipped: [], errors: [errInfo('audit', e)] }; }
      print('@@AUDIT ' + JSON.stringify(rec));
    }
  }
})();
