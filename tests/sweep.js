/* Whole-card-pool parser sweep for the Layer Inspector.
   Runs under macOS's built-in JavaScriptCore shell (jsc) or Node — no DOM, no network.
   Driven by tests/sweep.py; not loaded by index.html.

   Usage:  <engine> tests/sweep.js -- <scripts.json> <cards.json>
   Output: one line per card face, prefixed "@@SWEEP ", holding
     { name, face, layout, typeLine, nEffects, errors[], nonsense[], sentences[] }

   For every face it (1) adds the card through the real add pipeline next to a vanilla
   2/2 and points its targeted effects at that creature, (2) fires every triggered and
   activated ability the way the site's buttons do, (3) evaluates the board after each
   step, and (4) for every sentence of rules text, re-parses with that sentence removed.
   A sentence whose removal leaves the parsed effects unchanged produced no effect. */

/* ─── Engine shims (same as tests/harness.js) ─── */
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

const DUMMY = {
  name: 'Sweep Dummy', layout: 'normal', type_line: 'Creature — Bear', oracle_text: '',
  mana_cost: '{1}{G}', cmc: 2, power: '2', toughness: '2', colors: ['G'], color_identity: ['G'], keywords: [],
};

const X_VALUE = 2;
// The permanent's abilities have X already substituted; oracle lines still say X.
const withX = (s) => s.replace(/\bX\b/g, String(X_VALUE));

/* ─── Sentence splitting ─── */
// Splits on newlines and on sentence-ending periods outside double quotes.
// Returns [{ start, end, line, text }] with offsets into the input.
function splitSentences(text) {
  const out = [];
  let line = 0, start = 0, inQuote = false;
  const push = (end) => {
    const raw = text.slice(start, end);
    if (raw.trim()) out.push({ start, end, line, text: raw.trim() });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') { push(i); start = i + 1; line++; inQuote = false; continue; }
    if (c === '"' || c === '“' || c === '”') { inQuote = !inQuote; }
    if (inQuote) continue;
    const endsHere = (c === '.' || (c === '"' && text[i - 1] === '.')) && text[i + 1] === ' ';
    if (endsHere) push(i + 1);
  }
  push(text.length);
  return out;
}

function removeSpan(text, s) {
  return (text.slice(0, s.start) + text.slice(s.end))
    .split('\n').map(l => l.replace(/\s{2,}/g, ' ').trim())
    // A line reduced to a bare cost / trigger condition no longer says anything.
    .filter(l => l && !/^[^.]*[:,—]$/.test(l))
    .join('\n');
}

/* ─── Effect signatures ─── */
function _sigVal(v) {
  if (typeof v === 'function') return '"[fn]"';
  if (v instanceof Map || v instanceof Set) return '"[coll]"';
  if (Array.isArray(v)) return '[' + v.map(_sigVal).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined && k[0] !== '_')
      .map(k => k + ':' + _sigVal(v[k])).join(',') + '}';
  }
  if (typeof v === 'string') return JSON.stringify(v.replace(/\b(?:c|trig|act|spell|perm)_[\w]+/g, '@'));
  return String(v);
}
function effectSigs(effs) {
  return effs.map(e => [e.layer, e.type, e.scope, e.selfTarget ? 'self' : '', e.asLongAsCondition ? 'cond' : '',
    e.duration || '', _sigVal(e.params || {})].join('|')).sort().join('\n');
}

/* ─── Sanity checks ─── */
// Filled in main() once the app scripts are loaded.
let VALID_LAYERS, VALID_TYPES;

function _badValue(v, path, out, depth) {
  if (depth > 6) return;
  if (typeof v === 'number' && isNaN(v)) out.push(path + ' is NaN');
  else if (typeof v === 'string' && /\b(?:undefined|NaN)\b/.test(v)) out.push(path + ' contains "' + v.slice(0, 60) + '"');
  else if (Array.isArray(v)) v.forEach((x, i) => {
    if (x === undefined || x === null || x === '') out.push(path + '[' + i + '] is ' + JSON.stringify(x === undefined ? 'undefined' : x));
    else _badValue(x, path + '[' + i + ']', out, depth + 1);
  });
  else if (v && typeof v === 'object' && !(v instanceof Map) && !(v instanceof Set)) {
    for (const k of Object.keys(v)) if (k[0] !== '_') _badValue(v[k], path + '.' + k, out, depth + 1);
  }
}

function checkEffects(effs, out) {
  for (const e of effs) {
    const tag = (e.type || '?') + ': ';
    if (!VALID_LAYERS.has(e.layer)) out.push(tag + 'effect has no valid layer (' + JSON.stringify(e.layer === undefined ? null : e.layer) + ')');
    if (!VALID_TYPES.has(e.type)) out.push(tag + 'unknown effect type');
    if (e.scope !== 'targeted' && e.scope !== 'global') out.push(tag + 'effect scope is ' + JSON.stringify(e.scope === undefined ? null : e.scope));
    if (e.scope === 'global' && typeof e.appliesTo !== 'function') out.push(tag + 'global effect with no filter function');
    if (!e.params || typeof e.params !== 'object') out.push(tag + 'effect has no params');
    else _badValue(e.params, tag + 'params', out, 0);
  }
}

function checkStates(out) {
  const states = Battlefield.getAllFinalStates();
  for (const p of Battlefield.permanents) {
    if (p.isManualEffect) continue;
    const st = states.get(p.id);
    if (!st) { out.push('no final state for ' + (p.id === dummyId ? 'the target creature' : 'the card')); continue; }
    const who = p.id === dummyId ? 'target creature: ' : '';
    for (const k of ['power', 'toughness']) {
      const v = st[k];
      if (v === null || v === undefined) {
        if ((st.types || []).includes('Creature') && !p.isSpell) out.push(who + k + ' is ' + v + ' on a creature');
      } else if (typeof v !== 'number' || isNaN(v)) {
        // Unsubstituted "*" / "X" strings are legitimate printed values; anything else is not.
        if (!(typeof v === 'string' && /^[-+]?(?:\d+|\*|X|\d*[+-]?\*|\?)$/.test(v))) out.push(who + k + ' is ' + JSON.stringify(typeof v === 'number' ? 'NaN' : v));
      }
    }
    _badValue({ types: st.types, subtypes: st.subtypes, supertypes: st.supertypes, colors: st.colors, abilities: st.abilities },
      who + 'state', out, 0);
    // Exercise the per-layer log path the inspector uses.
    evaluatePermanent(p, Battlefield.permanents, Battlefield.effects, p.id);
  }
  return states;
}

function errInfo(stage, e) {
  const stack = String((e && e.stack) || '').split('\n').map(s => s.trim()).filter(Boolean);
  // First frame that names an app file tells us where it blew up.
  const frame = stack.find(s => /\.js/.test(s) && !/sweep\.js/.test(s)) || stack[0] || '';
  const m = frame.match(/([\w$.<>]*)@?.*?([\w-]+\.js):(\d+)/);
  return { stage, msg: String(e && e.message || e).slice(0, 200), where: m ? m[2] + ':' + m[3] + (m[1] ? ' ' + m[1] : '') : frame.slice(0, 120) };
}

/* ─── One card face ─── */
let dummyId = null;

function resetBoard() {
  Battlefield.clear();
  Battlefield.exile = [];
  Battlefield.nextExileId = 1;
  Battlefield.bestowTargets = new Map();
  if (Battlefield.triggerCounts) Battlefield.triggerCounts = new Map();
  if (Battlefield.activateCounts) Battlefield.activateCounts = new Map();
  const d = Battlefield.addPermanent(JSON.parse(JSON.stringify(DUMMY)), { suppressPrompt: true, controller: 'player_0', owner: 'player_0' });
  dummyId = d.id;
}

function withOracle(card, faceIndex, text) {
  const c = JSON.parse(JSON.stringify(card));
  if (c.card_faces && c.card_faces[faceIndex] && c.card_faces[faceIndex].oracle_text !== undefined) {
    // A Room is swept as one face holding both doors' text, so the other door must not
    // keep its own copy or removing one of its sentences would change nothing.
    if (c.card_faces.some(f => (f.type_line || '').includes('Room'))) c.card_faces.forEach(f => { f.oracle_text = ''; });
    c.card_faces[faceIndex].oracle_text = text;
    if (typeof c.oracle_text === 'string') c.oracle_text = text;
  } else {
    c.oracle_text = text;
  }
  return c;
}

// Adds the card the way ui-core's _doAddCardToBattlefield does. Returns the permanent.
function addCard(card, faceIndex, isSpell) {
  resetBoard();
  // X is given a value, as the site's prompt would; unsubstituted X text parses to nothing.
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
  // A Room enters with both doors locked and no abilities; the sweep reads it with both open.
  if (perm.isRoom && perm.roomFaces) perm.roomFaces.forEach((_, i) => Battlefield.toggleRoomLock(perm.id, i));
  // "As this enters, choose a …" cards parse to nothing until the choice is made.
  if (perm.needsChosenColor) Battlefield.setChosenColor(perm.id, 'red');
  if (perm.needsChosenCreatureType) Battlefield.setChosenCreatureType(perm.id, 'Goblin');
  if (perm.needsChosenLandType) Battlefield.setChosenLandType(perm.id, 'Forest');
  if (perm.needsChosenCardType) Battlefield.setChosenCardType(perm.id, 'artifact');
  if (perm.needsChosenCardName) Battlefield.setChosenCardName(perm.id, 'Grizzly Bears');
  return perm;
}

function ownEffects(perm) { return Battlefield.effects.filter(e => e.sourceId === perm.id); }

// Fires one ability with the given effect text; returns its effects and removes it again.
function fireAbility(perm, ab, kind, effectText, states, check) {
  const savedPerms = Battlefield.permanents.slice(), savedEffects = Battlefield.effects.slice();
  const before = new Set(savedEffects);
  let effs = [];
  try {
    let text = effectText;
    if (kind === 'activated') {
      // Mirrors fireActivatedAbility's colour-choice substitutions (choosing red).
      if (/gains?\s+protection\s+from\s+the\s+color\s+of\s+your\s+choice/i.test(text)) text = text.replace(/the\s+color\s+of\s+your\s+choice/i, 'red');
      else if (/^choose a color\./i.test(text)) text = text.replace(/^choose a color\.\s*/i, '').replace(/\bthat color\b/gi, 'red');
    }
    const pseudo = kind === 'trigger'
      ? Battlefield.addTriggeredAbility(perm.id, ab.index, text, ab.fullText, states)
      : Battlefield.addActivatedAbility(perm.id, ab.index, text, ab.fullText, states);
    if (pseudo && pseudo.needsChosenColor) Battlefield.setChosenColor(pseudo.id, 'red');
    if (pseudo && pseudo.needsChosenCreatureType) Battlefield.setChosenCreatureType(pseudo.id, 'Goblin');
    if (pseudo && pseudo.needsChosenLandType) Battlefield.setChosenLandType(pseudo.id, 'Forest');
    if (pseudo && kind === 'trigger') {
      Battlefield.injectTriggeredExchange(pseudo, perm.id, text);
      Battlefield.injectTriggeredBecomesLand(pseudo, perm.id, text);
    }
    effs = Battlefield.effects.filter(e => !before.has(e));
    if (check) {
      if (pseudo) { try { Battlefield.setTarget(pseudo.id, dummyId); } catch (e) { check.errors.push(errInfo('target ' + kind, e)); } }
      checkEffects(effs, check.nonsense);
      checkStates(check.nonsense);
    }
  } finally {
    Battlefield.permanents = savedPerms;
    Battlefield.effects = savedEffects;
    Battlefield.triggerCounts = new Map();
    Battlefield.activateCounts = new Map();
    Battlefield._invalidate();
  }
  return effs;
}

function sweepFace(card, faceIndex) {
  const face = _resolveCardFace(card, faceIndex);
  const typeLine = face.type_line || card.type_line || '';
  const isSpell = /\b(instant|sorcery)\b/i.test(typeLine);
  const isToken = _isTokenCard(card);
  const rec = { name: face.name || card.name, face: faceIndex, layout: card.layout, typeLine,
                nEffects: 0, errors: [], nonsense: [], sentences: [] };
  const norm = (s) => _replaceProperNounSelfRef(face.name || card.name, s, isToken);

  /* 1. The card exactly as printed. */
  let perm;
  try {
    perm = addCard(card, faceIndex, isSpell);
    rec.nEffects = ownEffects(perm).length;
    checkEffects(ownEffects(perm), rec.nonsense);
  } catch (e) { rec.errors.push(errInfo('add', e)); return rec; }
  try { checkStates(rec.nonsense); } catch (e) { rec.errors.push(errInfo('evaluate', e)); }
  try {
    Battlefield.setTarget(perm.id, dummyId);
    checkStates(rec.nonsense);
  } catch (e) { rec.errors.push(errInfo('evaluate with target', e)); }

  /* 2. Sentence-by-sentence: does the parse change when the sentence is removed? */
  const W = _stripReminderText(face.oracle_text || '');
  if (!W.trim()) return rec;
  let base, baseSigs, states;
  try {
    base = addCard(withOracle(card, faceIndex, W), faceIndex, isSpell);
    baseSigs = effectSigs(ownEffects(base));
    // Everything this face parsed to, so two runs can be compared card by card.
    rec.fx = baseSigs ? baseSigs.split('\n') : [];
    states = Battlefield.getAllFinalStates();
  } catch (e) { rec.errors.push(errInfo('add (reminder text stripped)', e)); return rec; }

  // Fire every triggered / activated ability, as the site's ability popup would.
  const fired = [];   // { kind, text (normalised sentence), line, covered }
  try {
    const fState = states.get(base.id);
    const abilities = ((fState && fState.abilities) || []).slice();
    // Abilities the site currently hides ("If this creature is a Spirit, …") are still text
    // the parser must understand, so fire those straight from the oracle lines too.
    const have = new Set(abilities.map(a => String(a).trim().toLowerCase()));
    for (const l of W.split('\n').map(norm)) {
      const k = l.trim().toLowerCase();
      if (k && !have.has(k) && !have.has(withX(l.trim()).toLowerCase())) abilities.push(l);
    }
    const jobs = [
      ...Battlefield.extractTriggeredAbilities(abilities).map(a => ['trigger', a]),
      ...Battlefield.extractActivatedAbilities(abilities)
        .filter(a => !(a.isMonstrosity || a.isCrew || a.isSaddle || a.isEquip || a.isReconfigure || a.isFortify))
        .map(a => ['activated', a]),
    ];
    for (const [kind, ab] of jobs) {
      try {
        const check = { errors: rec.errors, nonsense: rec.nonsense };
        const full = fireAbility(base, ab, kind, ab.effectText, states, check);
        const fullSigs = effectSigs(full);
        for (const l of fullSigs ? fullSigs.split('\n') : []) rec.fx.push(kind + ' ' + ab.index + '|' + l);
        // "+1/-1 or -1/+1"-style abilities are offered as separate options in the site.
        let optionHit = false;
        // A "choose one —" trigger's modes are whole effects of their own: judge each mode's
        // sentences by firing that mode.
        const bulletModes = kind === 'trigger' && ab.options && /\n\s*\u2022/.test(ab.fullText);
        if (bulletModes) {
          ab.options.forEach((opt, oi) => {
            const optEffs = fireAbility(base, ab, kind, opt, states, check);
            const optSigs = effectSigs(optEffs);
            if (oi > 0) for (const l of optSigs ? optSigs.split('\n') : []) rec.fx.push(kind + ' ' + ab.index + ' mode ' + oi + '|' + l);
            for (const s of splitSentences(opt)) {
              const rest = removeSpan(opt, s);
              const covered = rest ? effectSigs(fireAbility(base, ab, kind, rest, states, null)) !== optSigs : optEffs.length > 0;
              fired.push({ kind, text: norm(s.text), line: norm('\u2022 ' + opt), covered });
            }
          });
          continue;
        }
        (ab.options || []).forEach((opt, oi) => {
          const optEffs = fireAbility(base, ab, kind, opt, states, check);
          if (optEffs.length) optionHit = true;
          // A trigger's one-line options ("become 4/1 or 1/4", Master of Winds) are recorded
          // like modes, so a diff shows when one of them changes.
          if (kind === 'trigger') for (const l of effectSigs(optEffs).split('\n').filter(Boolean)) rec.fx.push(kind + ' ' + ab.index + ' mode ' + oi + '|' + l);
        });
        const sents = splitSentences(ab.effectText);
        for (const s of sents) {
          let covered = optionHit;
          if (!covered) {
            const rest = removeSpan(ab.effectText, s);
            covered = rest ? effectSigs(fireAbility(base, ab, kind, rest, states, null)) !== fullSigs : full.length > 0;
          }
          fired.push({ kind, text: norm(s.text), line: norm(ab.fullText), covered });
        }
      } catch (e) { rec.errors.push(errInfo('fire ' + kind, e)); }
    }
  } catch (e) { rec.errors.push(errInfo('extract abilities', e)); }

  // Which oracle lines are abilities (so their sentences are judged by firing too)?
  const lines = W.split('\n');
  const abilityLine = new Set();
  try {
    for (const a of Battlefield.extractTriggeredAbilities(lines)) {
      abilityLine.add(a.index);
      // The "• …" mode lines of a "choose one —" trigger belong to it.
      if (/\n\s*\u2022/.test(a.fullText)) a.options.forEach((_, oi) => abilityLine.add(a.index + 1 + oi));
    }
    for (const a of Battlefield.extractActivatedAbilities(lines)) abilityLine.add(a.index);
  } catch (e) { /* classification only */ }

  const usedFired = new Set();
  for (const s of splitSentences(W)) {
    let covered = false;
    try {
      const rest = removeSpan(W, s);
      const p2 = addCard(withOracle(card, faceIndex, rest), faceIndex, isSpell);
      covered = effectSigs(ownEffects(p2)) !== baseSigs;
    } catch (e) { rec.errors.push(errInfo('add (sentence removed)', e)); covered = true; }
    const text = norm(s.text);
    let ctx = isSpell ? 'spell' : 'static';
    if (abilityLine.has(s.line)) {
      ctx = 'ability';
      // The fired copy of this sentence has its cost / trigger condition cut off the front.
      const lc = text.toLowerCase();
      fired.forEach((f, i) => {
        const ft = f.text.toLowerCase();
        if (lc.endsWith(ft) || withX(text).toLowerCase().endsWith(ft)) { usedFired.add(i); ctx = f.kind; covered = covered || f.covered; }
      });
    }
    rec.sentences.push({ ctx, text, line: norm(lines[s.line] || ''), covered });
  }
  // Abilities the permanent has that are not lines of its own text (saga chapters, levels, …).
  fired.forEach((f, i) => { if (!usedFired.has(i)) rec.sentences.push({ ctx: f.kind, text: f.text, line: f.line, covered: f.covered }); });
  return rec;
}

/* ─── Main ─── */
(function main() {
  const scripts = JSON.parse(readFile(_args[0]));
  for (const f of scripts) load(f);
  const catalog = JSON.parse(readFile('tests/type-catalog.json'));
  for (const k of Object.keys(catalog)) {
    TypeCatalog[k] = new Set([...(TypeCatalog[k] || []), ...catalog[k]]);
  }
  TypeCatalog.loaded = true;
  VALID_LAYERS = new Set(Object.keys(LAYER_MAP));
  VALID_TYPES = new Set(Object.values(EFFECT_TYPE));
  globalThis.prompt = () => { throw new Error('prompt() called headlessly'); };
  globalThis.console = globalThis.console || {};
  for (const k of ['log', 'warn', 'error', 'info', 'debug']) console[k] = () => {};

  print('@@KEYWORDS ' + JSON.stringify([...KEYWORD_SET]));
  const cards = JSON.parse(readFile(_args[1]));
  for (const card of cards) {
    const isRoom = (card.card_faces || []).some(f => (f.type_line || '').includes('Room'));
    const multi = card.card_faces && card.card_faces.length >= 2 && !isRoom &&
      (TRANSFORMABLE_LAYOUTS.has(card.layout) || _hasChooseableFaces(card) || _isTransformingToken(card) || card.layout === 'battle' || card.layout === 'flip');
    const nFaces = multi ? card.card_faces.length : 1;
    for (let fi = 0; fi < nFaces; fi++) {
      let rec;
      try { rec = sweepFace(card, fi); }
      catch (e) { rec = { name: card.name, face: fi, layout: card.layout, typeLine: card.type_line || '', nEffects: 0, errors: [errInfo('sweep', e)], nonsense: [], sentences: [] }; }
      rec.nonsense = [...new Set(rec.nonsense)];
      print('@@SWEEP ' + JSON.stringify(rec));
    }
  }
})();
