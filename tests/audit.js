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
   A unit with several targets, or "up to N" (classifyTargets), expects a multi-target picker of N
   or one picker per target, and each list gets both checks against its own target's words
   (auditFiredTargets).
   An Aura is a unit too ("attach", auditAttach): its attach picker against its "Enchant ..." line,
   with protection, shroud and hexproof judged on witnesses added for it alone.
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
const WORD_COUNT = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PERMANENT_NOUNS = new Set(['creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'permanent', 'battle']);

function stripReminder(text) {
  return _stripReminderText(String(text || '')).replace(/\s+/g, ' ').trim();
}

// Where the phrase after "target" ends: at a verb that says what happens to it, a clause break, or
// the end. A comma inside a list of types ("artifact, creature, or enchantment") does not end it.
// "For as long as …" says how long, "if its power is …" what must hold on resolution, and "each"
// is "This creature and another target creature each get …": none of them is who can be targeted.
const PHRASE_STOP = /\s+(?:gets?|gains?|has|have|becomes?|become|loses?|lose|can|can't|cannot|deals?|is|are|isn't|doesn't|attacks?|blocks?|untaps?|taps?|fights?|phases?|perpetually|assumes|switches|and(?!\/or)|then|until|this|for as long as|if|each|both)\b|[;:.]/;
// Stop words that are part of the phrase: "with power less than this creature's power", "less than
// or equal to this creature's power", "Vampire that isn't a Demon".
const PHRASE_STOP_KEPT = /(?:\bthan|\bequal to|\bcounters on)$|\bthat$/;
function extractPhrase(after) {
  let from = 0;
  for (;;) {
    const rest = after.slice(from);
    let m = rest.match(PHRASE_STOP);
    if (m && /^\s+(?:this|isn't)$/.test(m[0]) && PHRASE_STOP_KEPT.test(after.slice(0, from + m.index))) {
      from += m.index + m[0].length;
      continue;
    }
    const c = rest.indexOf(',');
    // "you don't control" is part of the phrase; the stop list's "doesn't" is not "don't".
    if (c >= 0 && (!m || c < m.index)) {
      // A comma followed by another type of a list continues the phrase.
      if (/^,\s*(?:or\s+|and\s+)?(?:(?:non-?)?(?:artifact|creature|enchantment|land|planeswalker|battle|permanent)\b|non-?[a-z]+\b)/.test(rest.slice(c))) {
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
// One-shot verbs after which the target is still the same permanent on the battlefield.
const SAME_PERMANENT_VERBS = /^(?:put|puts|untap|tap|taps|attach|choose|goad)$/;
// A later sentence whose subject is the target, through a pronoun ("…. Untap it. Until end of turn,
// it gets +1/+1 and becomes a Doctor").
// ("… Then that creature gets +1/+1 until end of turn and fights …" — Ent's Fury.)
const LATER_PRONOUN_EFFECT = /\.\s+(?:until end of turn,\s*|then\s+)?(?:it|that (?:creature|permanent|land|artifact))\s+(?:also\s+)?(?:gets?|gains?|has|becomes?|loses?|is)\b/;

/* Does every event of a trigger's condition happen with the card in the hand or off the
   battlefield ("When you cycle this card", "When this creature dies", "When you cycle this card and
   when this creature dies")? Then the card cannot be one of its targets. Read from the text alone,
   event by event; "enters or dies" and "this or another creature dies" keep the card. */
function offBattlefieldTrigger(fullText) {
  const line = String(fullText || '').split('\n')[0].replace(/’/g, "'").replace(/^[^{\n.;"—]+—\s*/, '');
  const m = line.match(/^when(?:ever)?\s+([^,]+),/i);
  if (!m) return false;
  const events = m[1].replace(/\bcycle or discard\b/gi, 'cycle').replace(/\bdies or is put into exile\b/gi, 'dies')
    .split(/,?\s+(?:and|or)\s+(?:when(?:ever)?\s+)?/i);
  return events.every(e => /^you (?:cycle|discard) this \w+$/i.test(e) ||
    /causes you to discard this \w+$/i.test(e) ||
    /^this \w+ (?:dies|leaves the battlefield|is put into (?:a|your) graveyard from the battlefield)(?: while .+)?$/i.test(e));
}

/* Is this unit's text a "singular permanent target" unit? Returns { singular: true, phrase,
   excludeSource, targetIndex } or { skip: '<reason code>' }. Works from the text alone. A text
   that names more than one target, or "up to N target …", is read by classifyTargets: it can be a
   singular unit too (one target the site models, the others one-shot), or { targets: [...] }. */
function classifyUnitText(text) {
  const t0 = String(text || '').replace(/’/g, "'");
  const quotedTarget = /["“][^"”]*\btargets?\b[^"”]*["”]/i.test(t0);
  const masked = t0.replace(/["“][^"”]*["”]/g, 'QUOTED');
  const lower = masked.toLowerCase();
  const hits = [...lower.matchAll(/\btargets?\b/g)];
  if (!hits.length) return { skip: quotedTarget ? 'target-in-quote' : 'no-target' };
  if (hits.length > 1) return classifyTargets(text, 'multiple-targets');
  if (hits[0][0] === 'targets') return { skip: 'targets-verb' };
  const idx = hits[0].index;
  const before = lower.slice(0, idx);
  if (/\bup to (?:\w+ )?(?:other )?$/.test(before)) return classifyTargets(text, 'up-to');
  if (/\bany number of (?:other )?$/.test(before)) return classifyTargets(text, 'any-number');
  if (/\beach $/.test(before)) return { skip: 'each-target' };
  if (/\bany $/.test(before)) return { skip: 'any-target' };
  if (new RegExp('\\b' + NUMBER_WORDS + ' (?:other )?$').test(before)) return classifyTargets(text, 'n-target');
  const r = classifyAt(lower, idx, lower.length, {});
  return r.layer ? { singular: true, phrase: r.phrase, excludeSource: r.excludeSource, targetIndex: r.targetIndex } : { skip: r.skip };
}

/* One "target" of a unit's text, at `idx` of `lower` (the text, lower-cased, quotes masked), its
   own words running to `end` (the next "target", or the end). { layer: true, phrase, excludeSource,
   targetIndex } when the target is the subject of a continuous effect, otherwise { skip: reason }.
   opts (classifyTargets only; a singular unit passes none, so it reads exactly as before):
     plural    - the count before it is more than one ("up to two target creatures"): a plural
                 phrase is expected, and "those creatures" / "they" in a later sentence is the target;
     each      - "… target creatures each get +1/+1": "each" is not a verb of its own. */
function classifyAt(lower, idx, end, opts) {
  const before = lower.slice(0, idx);
  const after = lower.slice(idx + 'target'.length, end).trim();
  const phrase = extractPhrase(after);
  if (!phrase) return { skip: 'empty-phrase' };
  // The engine models continuous effects only. "Destroy / exile / put a counter on / create a token
  // that's a copy of target ..." is a one-shot action: the target is the object of a verb, not the
  // subject of "gets / gains / becomes", and no parse could be expected to give it a targeted effect.
  let clauseBefore = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf(';')) + 1);
  let verbAfter = after.slice(phrase.length).trim();
  // (classifyTargets: "Target player creates X Zombies, then up to one target creature gets -1/-1".)
  if (opts.each) clauseBefore = clauseBefore.replace(/^.*(?:,\s*|\s)then\s/, ' ');
  if (opts.each) verbAfter = verbAfter.replace(/^(?:each|both)\s+/, '');
  // (Gaining control is a continuous effect, layer 2. "… gains control of up to three target …".)
  const takesControl = /\bgains? control of (?:another |that |the )?$/.test(opts.each
    ? clauseBefore.replace(new RegExp('\\b(?:up to \\w+|' + NUMBER_WORDS + ') (?:other )?$'), '') : clauseBefore);
  // "Put a +1/+1 counter on target creature you control. It gains hexproof until end of turn"
  // (Snakeskin Veil): the action leaves the target where it is and a later sentence makes it the
  // subject of a continuous verb, so that sentence is a targeted effect. Not "create a token that's
  // a copy of target …. It gains haste" (the token is "it") nor return / exile / destroy (the target
  // leaves or changes zones): every one-shot verb before the target must be one of these.
  const actionVerbs = [...clauseBefore.replace(/\bputs? [^.;]*?\bcounters? (?:and [^.;]*?\bcounters? )?on $/, 'put on ')
    .matchAll(new RegExp(ONE_SHOT_VERBS.source, 'g'))].map(m => m[0]);
  const keepsTarget = actionVerbs.length > 0 && actionVerbs.every(v => SAME_PERMANENT_VERBS.test(v));
  const pronounEffect = keepsTarget && (opts.plural ? LATER_PLURAL_PRONOUN_EFFECT : LATER_PRONOUN_EFFECT).test(verbAfter);
  if (!takesControl && !pronounEffect && (ONE_SHOT_VERBS.test(clauseBefore) || !CONTINUOUS_VERBS.test(verbAfter))) return { skip: 'one-shot-action' };
  // "Target creature can't be blocked this turn" / "can't be regenerated" / "can attack as though
  // it didn't have defender": a rule about the target, not a change to what it is. The site does
  // not model these, so there is no targeted effect to expect.
  // Judged on the target's own sentence ("as though it didn't have defender" is not a "have"), plus any
  // later sentence that gives the target something through a pronoun ("It gains haste").
  {
    const ownSentence = verbAfter.split('.')[0].replace(/\bas though it (?:didn't|doesn't|did not) have \w+/, '');
    const later = verbAfter.slice(verbAfter.split('.')[0].length);
    const pronounGrant = (opts.plural
      ? /\b(?:they|those (?:creatures|permanents|lands|artifacts))\s+(?:each\s+)?(?:also\s+)?(?:gain|have|become|lose|get)\b/
      : /\b(?:it|that (?:creature|permanent|land|artifact))\s+(?:also\s+)?(?:gets?|gains?|has|becomes?|loses?)\b/).test(later);
    if (/^(?:can|can't|cannot)\b/.test(verbAfter) && !/\b(?:gets?|gains?|has|have|becomes?|loses?)\b/.test(ownSentence) && !pronounGrant) return { skip: 'not-a-layer-effect' };
  }
  // Likewise: "target unblocked creature becomes blocked", damage "… by target creature is dealt to
  // its controller instead", "which player … target attacking creature is attacking", "When target
  // creature is put into your graveyard …", "If target Plains is tapped for mana, …".
  // ("Becomes prepared / unprepared" is a designation the site does not track.)
  if (/^(?:becomes? (?:blocked|prepared|unprepared)|is (?:dealt|attacking|put into|tapped for mana))\b/.test(verbAfter)) return { skip: 'not-a-layer-effect' };
  // A spell's own text followed by its cycling trigger ("When you cycle this card, you may have target
  // creature gain fear" — Dirge of Dread) is not something the spell does.
  if (/\bwhen you cycle\b/.test(clauseBefore)) return { skip: 'cycling-trigger' };
  // ("… with power less than this creature's power" compares with the source; not a possessive target.)
  if (/'s\b/.test(phrase.replace(/\b(?:than|equal to) this \w+'s\b/g, ''))) return { skip: 'possessive-target' };
  // "creature or player", "target opponent", "creature card in a graveyard", "spell". ("creature that
  // player controls" and "this card creature" are permanents; the interpreter reports what it cannot read.)
  if (!/^this /.test(phrase) && /\b(?:spell|spells|ability|abilities|card|cards|graveyard|library|hand|instant|sorcery)\b/.test(phrase.replace(/\b(?:than|equal to) this card's\b/g, ''))) return { skip: 'not-a-permanent' };
  if (/^(?:players?|opponents?)\b|(?:\bor|\band\/or|,)\s+(?:another\s+)?(?:players?|opponents?)\b/.test(phrase)) return { skip: 'not-a-permanent' };
  if (!opts.plural && /\b(?:creatures|artifacts|enchantments|lands|planeswalkers|permanents)\b/.test(phrase)) return { skip: 'plural-target' };
  // ("Up to one other target creature": classifyTargets only, so a singular unit reads as before.)
  return { layer: true, phrase, excludeSource: /\banother $/.test(before) || /^other /.test(phrase) || (!!opts.each && /\bother $/.test(before)), targetIndex: idx };
}
// The count of "any number of target …" (classifyTargets).
const ANY_NUMBER = 'any';
// The plural of LATER_PRONOUN_EFFECT: "Untap up to two target creatures. They gain haste" / "Those
// creatures each get +1/+1", in the very next sentence ("Tap up to two target creatures. … Create a
// 1/1 Eldrazi Scion token. It has …": the token is "it").
// ("Choose any number of target creatures. Each of those creatures gains persist" - Cauldron Haze.)
const LATER_PLURAL_PRONOUN_EFFECT = /^[^.]*\.\s+(?:until end of turn,\s*)?(?:(?:they|those (?:creatures|permanents|lands|artifacts))\s+(?:each\s+)?(?:also\s+)?(?:gain|have|become|lose|get|are(?! now attacking))|each of (?:those (?:creatures|permanents|lands|artifacts)|them)\s+(?:also\s+)?(?:gains|has|becomes|loses|gets|is))\b/;

/* A unit whose text names more than one target, or "up to N target …" (`origin`, which is also the
   first part of every skip reason it returns). Each target is read on its own (classifyAt) and how
   many it allows from the words before it ("up to two", "up to one", "two", none). Only the targets
   that are the subject of a continuous effect count; a one-shot target ("Destroy target land. Up to
   two target creatures can't block") is not one the site models:
     one target, of one             -> a singular unit (the single picker), read as before;
     one target, of N >= 2          -> { targets: [t], expectKind: 'multi', maxTargets: N }
                                       ("Up to two target creatures each get +1/+1");
     K >= 2 targets, each of one    -> { targets: [t1 … tK], expectKind: 'slotted' }, slot k being the
                                       k-th target of the text ("Target creature gets +2/+0 and
                                       target creature an opponent controls gets -2/-0");
     anything else                  -> skipped.
   Each t is { phrase, excludeSource, targetIndex, plural, sourceNotJudged }. "Another target
   creature" after an earlier target means one other than that target, which the audit does not
   check; whether the source may be chosen is then not judged (sourceNotJudged). */
function classifyTargets(text, origin) {
  const t0 = String(text || '').replace(/’/g, "'");
  // (Masked to the same length, so offsets are offsets into the text.)
  const lower = t0.replace(/["“][^"”]*["”]/g, (q) => 'q'.repeat(q.length)).toLowerCase();
  const hits = [...lower.matchAll(/\btarget\b/g)].map(m => m.index);
  const skip = (why) => ({ skip: origin + ': ' + why });
  if (!hits.length) return skip('targets-verb');
  const layers = [], reasons = [];
  for (let k = 0; k < hits.length; k++) {
    const idx = hits[k], before = lower.slice(0, idx);
    let count = 1, m;
    if ((m = before.match(/\bup to (\w+) (?:other )?$/))) count = m[1] === 'x' ? X_VALUE : (WORD_COUNT[m[1]] || parseInt(m[1], 10) || 0);
    // ("Any number of target creatures": as many picks as the site offers, at least two.)
    else if (/\bany number of (?:other )?$/.test(before)) count = ANY_NUMBER;
    else if (/\beach $/.test(before)) return skip('each-target');
    else if (/\bany (?:other )?$/.test(before)) { reasons.push('any-target'); continue; }
    else if ((m = before.match(new RegExp('\\b(' + NUMBER_WORDS + ') (?:other )?$')))) count = m[1] === 'x' ? X_VALUE : (WORD_COUNT[m[1]] || parseInt(m[1], 10) || 0);
    if (!count) return skip('count-not-read');
    // "Creatures target player controls get -1/-1": the player picker decides a group.
    if (/^\s+(?:player|opponent)s? controls\b/.test(lower.slice(idx + 6))) return skip('player-group');
    const r = classifyAt(lower, idx, k + 1 < hits.length ? hits[k + 1] : lower.length, { plural: count === ANY_NUMBER || count > 1, each: true });
    if (r.skip === 'possessive-target') return skip('possessive-target');
    if (!r.layer) { reasons.push(r.skip); continue; }
    layers.push({ phrase: r.phrase, excludeSource: r.excludeSource, targetIndex: r.targetIndex, count,
      plural: count === ANY_NUMBER || count > 1, sourceNotJudged: r.excludeSource && /\b(?:an)?other $/.test(before) && layers.length + reasons.length > 0 });
  }
  if (!layers.length) {
    const why = [...new Set(reasons)];
    return skip(why.length === 1 ? why[0] : why.includes('one-shot-action') ? 'one-shot-action' : why.sort().join('+'));
  }
  if (layers.length === 1 && layers[0].count === 1 && !layers[0].sourceNotJudged) {
    const t = layers[0];
    return { singular: true, phrase: t.phrase, excludeSource: t.excludeSource, targetIndex: t.targetIndex, origin };
  }
  if (layers.length === 1) {
    const t = layers[0];
    if (t.count === 1) return skip('another-of-one-shot-target');
    return { targets: [t], expectKind: 'multi', maxTargets: t.count, origin };
  }
  if (layers.some(t => t.count !== 1)) return skip('several-targets-of-several');
  return { targets: layers, expectKind: 'slotted', origin };
}

/* Does the text outside the target's own clause also name the source or a group? Kept as one
   small function so it can be tuned: { source, group }. */
const SELF_WORDS = /\bthis (?:creature|permanent|card|artifact|enchantment|land|token|vehicle|equipment|aura|planeswalker|spell|saga|class)\b|~/;
const GROUP_WORDS = /(?<!for )\beach (?:other )?(?:creature|permanent|artifact|land|enchantment|planeswalker)\b|\b(?:all|every) (?:other )?(?:creatures|permanents|artifacts|lands|enchantments|planeswalkers)\b|\bother (?:\w+ )?(?:creatures|permanents|artifacts|lands|enchantments)\b|\b\w+s you control (?:get|have|gain)\b/;
function mixedSubject(text, targetIndex, cardName, isSpell) {
  const lower = String(text).replace(/’/g, "'").replace(/["“][^"”]*["”]/g, 'QUOTED').toLowerCase()
    // "… for as long as this creature remains tapped" says how long, not who (same length kept:
    // targetIndex is an offset into the text).
    .replace(/\bfor as long as [^.;]*/g, (d) => ' '.repeat(d.length));
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
  else if (w === 'monocolored') c = { kind: 'adj', test: (st) => stateColors(st).length === 1 };
  else if (SUPERTYPE_WORDS.has(w)) c = { kind: 'adj', test: (st) => hasCI(st.supertypes, w) };
  else if (w === 'token') c = { kind: 'adj', test: (st, p) => !!p.isToken };
  else if (w === 'attacking') c = { kind: 'adj', test: (st, p) => traitsOf(st, p).includes('Attacking') };
  else if (w === 'blocking') c = { kind: 'adj', test: (st, p) => traitsOf(st, p).includes('Blocking') };
  else if (w === 'tapped') c = { kind: 'adj', test: (st, p) => !!p.tapped || traitsOf(st, p).includes('Tapped') };
  else if (w === 'untapped') c = { kind: 'adj', test: (st, p) => !(p.tapped || traitsOf(st, p).includes('Tapped')) };
  else if (w === 'blocked') c = { kind: 'adj', test: (st, p) => traitsOf(st, p).includes('Blocked') };
  else if (w === 'equipped') c = { kind: 'adj', test: (st, p) => traitsOf(st, p).includes('Equipped') };
  else if (w === 'enchanted') c = { kind: 'adj', test: (st, p) => traitsOf(st, p).includes('Enchanted') };
  // CR 700.9: a counter on it, an Equipment attached, or an Aura its controller controls.
  else if (w === 'modified') c = { kind: 'adj', test: (st, p) => anyCounter(st, p) > 0 || traitsOf(st, p).includes('Equipped') || traitsOf(st, p).includes('Enchanted') };
  // CR 700.6: legendary, artifact or Saga.
  else if (w === 'historic') c = { kind: 'adj', test: (st) => hasCI(st.supertypes, 'legendary') || hasCI(st.types, 'artifact') || hasCI(st.subtypes, 'saga') };
  // "Target 1/1 creature" (Aegis of the Meek).
  else if (/^\d+\/\d+$/.test(w)) { const [pw, tg] = w.split('/').map(Number); c = { kind: 'adj', test: (st, p) => statValue(st, p, 'power') === pw && statValue(st, p, 'toughness') === tg }; }
  else if (w === 'commander') c = { kind: 'noun', test: (st, p) => !!(p.isCommander || st.isCommander) };
  else if (w === 'permanent') c = { kind: 'noun', test: () => true };
  else if (PERMANENT_NOUNS.has(w)) c = { kind: 'noun', test: (st) => hasCI(st.types, w) };
  else if (subtypeWords().has(w)) c = { kind: 'noun', test: (st) => hasCI(st.subtypes, w) || (!!st.isAllCreatureTypes && TypeCatalog.creatureTypes.has(cap1(w))) };
  if (c && negated) { const t = c.test; c = { kind: 'adj', test: (st, p) => !t(st, p) }; }
  return c;
}

// "Up to two target creatures / Elves / Zombies": the singular of a plural word, by the audit's own
// rules (not the parser's helper). Tried only for a target of more than one.
const IRREGULAR_SINGULAR = { elves: 'elf', dwarves: 'dwarf', wolves: 'wolf', mice: 'mouse', oxen: 'ox', werewolves: 'werewolf', men: 'man', octopuses: 'octopus', fungi: 'fungus' };
function singularForms(w) {
  if (IRREGULAR_SINGULAR[w]) return [IRREGULAR_SINGULAR[w]];
  const out = [];
  if (/ies$/.test(w)) out.push(w.slice(0, -3) + 'y');
  if (/(?:ch|sh|ss|x)es$/.test(w)) out.push(w.slice(0, -2));
  if (/s$/.test(w) && !/ss$/.test(w)) out.push(w.slice(0, -1));
  return out;
}

function parseHeadItem(words, unknown, plural) {
  const adj = [], noun = [];
  for (const w of words) {
    let neg = false, base = w;
    const m = w.match(/^non-?(.+)$/);
    if (m) { neg = true; base = m[1]; }
    let c = wordConstraint(base, neg);
    if (!c && plural) for (const sg of singularForms(base)) { c = wordConstraint(sg, neg); if (c) break; }
    if (!c) { unknown.push(w); continue; }
    (c.kind === 'noun' ? noun : adj).push(c.test);
  }
  // "Target token you control" (Halsin): a token is a permanent.
  if (!noun.length && (words.includes('token') || (plural && words.includes('tokens')))) noun.push(() => true);
  return { adj, noun };
}

/* Which player "that player" / "they" is, read from the words before the target: a trigger on
   an opponent's event ("each opponent's upkeep", "an opponent becomes the monarch", "for each
   opponent"), or on the player your permanent attacks or deals combat damage to, means an opponent
   ('opponent'). Anything else ("each player's upkeep", "a player") can be any player (null). */
function thatPlayerReading(before) {
  const s = String(before || '').toLowerCase().replace(/’/g, "'");
  if (/\b(?:each|an|target|for each) opponent\b|\bopponent's\b/.test(s)) return 'opponent';
  if (/\b(?:this \w+|~|you control) (?:deals?|deal) combat damage to a player\b/.test(s)) return 'opponent';
  if (/\b(?:this \w+|~|you control) attacks? a player\b/.test(s)) return 'opponent';
  return null;
}

// "… the number of Vampires you control", "… the number of treasure counters on this enchantment":
// counted on the board before the unit fired. Returns a function (ctx) => number, or null.
function boardCount(words) {
  let m;
  if ((m = words.match(/^the number of ([a-z+/-]+?) counters on this \w+$/))) {
    const kind = m[1];
    return (ctx) => { const st = ctx.preStates.get(ctx.sourceId); const p = Battlefield.getPermById(ctx.sourceId) || {}; return counterCount(st, p, kind); };
  }
  if ((m = words.match(/^the number of ([a-z-]+?)s? you control$/))) {
    const c = wordConstraint(m[1].replace(/ie$/, 'y'), false) || wordConstraint(m[1], false);
    if (!c) return null;
    return (ctx) => ctx.universe.filter(p => { const st = ctx.preStates.get(p.id); return st && ctrlOf(st, p) === ctx.sourceCtrl && c.test(st, p); }).length;
  }
  return null;
}

const allOf = (tests) => (st, p) => tests.every(t => t(st, p));

// Returns { test(st, perm, ctx), excludeSource } or { unknown: [words] }.
// `env`: { before } — the unit's words before the target, for "that player".
function interpretPhrase(phrase, env) {
  const unknown = [];
  let s = String(phrase).toLowerCase().replace(/\s+/g, ' ').trim()
    // "Target creature of their choice" (Death Match): who chooses, not what.
    .replace(/ of their choice$/, '')
    .replace(/\b(power|toughness|mana value) x\b/g, '$1 ' + X_VALUE);
  let excludeSource = false;
  s = s.replace(/^(?:another|other) /, () => { excludeSource = true; return ''; });
  const cut = s.search(/ (?:you control|you don't control|you own|an opponent controls|that player controls|they control|defending player controls|other than|that isn't|whose controller|attacking the same|with |without )/);
  const head = cut >= 0 ? s.slice(0, cut) : s;
  let tail = cut >= 0 ? s.slice(cut).trim() : '';

  // Head: items joined by "or" / commas; an item is the AND of its words. "Nonartifact, nonblack
  // creature", "noncreature, nonland permanent": a leading item of "non-" words only is part of
  // the next one.
  // ("Creatures and/or planeswalkers" - Mass Manipulation - is either.)
  const rawItems = head.split(/\s*,\s*(?:or\s+)?|\s+(?:and\/)?or\s+/).map(x => x.trim()).filter(Boolean);
  for (let i = rawItems.length - 2; i >= 0; i--) {
    if (rawItems[i].split(' ').every(w => /^non-?[a-z]/.test(w)) && new RegExp('\\b' + rawItems[i] + '\\s*,\\s*' + rawItems[i + 1].split(' ')[0]).test(head)) {
      rawItems.splice(i, 2, rawItems[i] + ' ' + rawItems[i + 1]);
    }
  }
  const items = rawItems.map(x => parseHeadItem(x.split(' '), unknown, !!(env && env.plural)));
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
    if ((m = tail.match(/^you own but don't control\b\s*/))) { clauseTests.push((st, p, ctx) => (p.owner || 'player_0') === ctx.sourceCtrl && ctrlOf(st, p) !== ctx.sourceCtrl); tail = tail.slice(m[0].length); continue; }
    // "Target creature that player controls": see thatPlayerReading.
    if ((m = tail.match(/^(?:that player controls|they control)\b\s*/))) {
      if (thatPlayerReading(env && env.before) === 'opponent') clauseTests.push((st, p, ctx) => ctrlOf(st, p) !== ctx.sourceCtrl);
      tail = tail.slice(m[0].length); continue;
    }
    // CR 506.2: in a two-player game the defending player is the one being attacked. On the board
    // "your soldier" attacks the opponent, and every attack trigger is one of yours.
    if ((m = tail.match(/^defending player controls\b\s*/))) { clauseTests.push((st, p, ctx) => ctrlOf(st, p) !== ctx.sourceCtrl); tail = tail.slice(m[0].length); continue; }
    // "Target creature you control other than this creature" (Hisoka's Guard): "another".
    if ((m = tail.match(/^other than this [a-z-]+\b\s*/))) { clauseTests.push((st, p, ctx) => p.id !== ctx.sourceId); tail = tail.slice(m[0].length); continue; }
    // "Target creature that isn't of the chosen type" (Callous Oppressor): with no type chosen on
    // the card, every creature.
    if ((m = tail.match(/^that isn't of the chosen type\b\s*/))) {
      clauseTests.push((st, p, ctx) => { const src = Battlefield.getPermById(ctx.sourceId) || {}; const t = src.chosenCreatureType; return !t || !hasCI(st.subtypes, String(t).toLowerCase()); });
      tail = tail.slice(m[0].length); continue;
    }
    // "Target creature you control other than enchanted creature" (Due Diligence).
    if ((m = tail.match(/^other than (?:enchanted|equipped) creature\b\s*/))) {
      clauseTests.push((st, p, ctx) => { const src = Battlefield.getPermById(ctx.sourceId) || {}; return !src.targetId || p.id !== src.targetId; });
      tail = tail.slice(m[0].length); continue;
    }
    // "Attacking Vampire that isn't a Demon" (Clavileño).
    if ((m = tail.match(/^that isn't (?:a |an )?([a-z-]+)\b\s*/))) {
      const c = wordConstraint(m[1], true);
      if (!c) { unknown.push('that', "isn't", m[1]); break; }
      clauseTests.push(c.test); tail = tail.slice(m[0].length); continue;
    }
    // "Creature whose controller controls an Island" (Seasinger).
    if ((m = tail.match(/^whose controller controls (?:a |an )([a-z-]+)\b\s*/))) {
      const c = wordConstraint(m[1], false);
      if (!c) { unknown.push('whose', 'controller', m[1]); break; }
      clauseTests.push((st, p, ctx) => ctx.universe.some(q => { const qs = ctx.preStates.get(q.id); return qs && ctrlOf(qs, q) === ctrlOf(st, p) && c.test(qs, q); }));
      tail = tail.slice(m[0].length); continue;
    }
    // "Another target creature attacking the same player or planeswalker" (Kitesail Skirmisher):
    // the trigger's source is attacking, and on a two-player board so is every attacker of yours.
    if ((m = tail.match(/^attacking the same player or planeswalker\b\s*/))) {
      clauseTests.push((st, p, ctx) => traitsOf(st, p).includes('Attacking') && ctrlOf(st, p) === ctx.sourceCtrl);
      tail = tail.slice(m[0].length); continue;
    }
    // "With power less than [or equal to] this creature's power", "… the number of Vampires you control".
    if ((m = tail.match(/^with (power|toughness|mana value) (less than or equal to|less than|greater than or equal to|greater than) (this \w+'s (?:power|toughness|mana value)|the number of [a-z+/ -]+?)(?= you control\b(?! )| an opponent controls| with | without |$)( you control)?\s*/))) {
      const [, stat, rel, what, yc] = m;
      let amount = null;
      const own = what.match(/^this \w+'s (power|toughness|mana value)$/);
      if (own) amount = (ctx) => { const st0 = ctx.preStates.get(ctx.sourceId); return st0 ? statValue(st0, Battlefield.getPermById(ctx.sourceId) || {}, own[1]) : null; };
      else amount = boardCount(what + (yc || ''));
      if (!amount) { unknown.push(...what.split(' ').slice(0, 4)); break; }
      const cmp = { 'less than or equal to': (a, b) => a <= b, 'less than': (a, b) => a < b, 'greater than or equal to': (a, b) => a >= b, 'greater than': (a, b) => a > b }[rel];
      clauseTests.push((st, p, ctx) => { const v = statValue(st, p, stat), n = amount(ctx); return v !== null && n !== null && cmp(v, n); });
      tail = tail.slice(m[0].length); continue;
    }
    // "Enchant creature with another Aura attached to it" (Daybreak Coronet): an Aura other than
    // the source attached to it now.
    if ((m = tail.match(/^with another aura attached to it\s*/))) {
      clauseTests.push((st, p, ctx) => Battlefield.effects.some(e => e.sourceId !== ctx.sourceId && e.targetId === p.id && e.scope === 'targeted' &&
        hasCI((Battlefield.getPermById(e.sourceId) || {}).printedSubtypes, 'aura')));
      tail = tail.slice(m[0].length); continue;
    }
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
    if ((m = tail.match(/^(with|without) ((?:[a-z' ]+?)(?:(?:,\s*|\s+or\s+|\s+and\s+)[a-z' ]+?)*)(?= you control| you don't control| an opponent controls| that player controls| they control| defending player controls| with | without |$)/))) {
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
  if (a.isEquip || a.isReconfigure || a.isFortify) return [];   // openEquipModal: a unit of auditEquip
  // fireActivatedAbility: "or" options -> openActivateOptionsPopup -> _chooseActivateOption, which calls
  // addActivatedAbility(permId, idx, option, a.fullText, finalStates) with freshly read final states.
  if (a.options && a.options.length >= 2) {
    // (_chooseActivateOption: an option that still says "the color of your choice" -> openColorChoicePopup; red.)
    return a.options.map((opt, i) => {
      const text = PROTECTION_CHOICE.test(opt) ? opt.replace(/the\s+color\s+of\s+your\s+choice/i, COLOR_NAME.R) : opt;
      return { label: 'option ' + (i + 1), text,
        fire: () => Battlefield.addActivatedAbility(permId, a.index, text, a.fullText, Battlefield.getAllFinalStates()) };
    });
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

/* ─── A second attempt on an adjusted board ───
   Each entry changes the board in one way the unit's own words ask for, and returns how to undo
   it: { what, apply() -> undo, only?: ids to try }. Read from the text, never from the parse. */
const LOSES_RE = /\bloses?\s+(all\s+)?(?:"([^"]+)"\s+abilities|([a-z][a-z' -]*?))(?=\s+(?:and|until|end of turn|this turn)\b|[.,]|$)/i;
function boardAdjustments(ctx, u, unitId, pseudo, tryIds) {
  const out = [];
  const src = Battlefield.getPermById(ctx.sourceId);
  const others = tryIds.filter(x => x !== ctx.sourceId);
  // "… for as long as this creature remains tapped": the cost tapped it.
  if (/\bremains tapped\b/i.test(u.text) && src && !src.tapped) {
    out.push({ what: 'source tapped', apply: () => { Battlefield.toggleTapped(src.id); return () => Battlefield.toggleTapped(src.id); } });
  }
  // "becomes the basic land type of your choice": Forest on a Forest shows nothing.
  if (pseudo && pseudo.needsChosenLandType) {
    out.push({ what: 'land type Island chosen', apply: () => { Battlefield.setChosenLandType(unitId, 'Island'); return () => Battlefield.setChosenLandType(unitId, 'Forest'); } });
  }
  // "If this spell was kicked / bargained, …": the toggle the site shows on the spell.
  // (Every toggle the unit has: "Kicked", and the conditions asked of the player — "Sacrifice a Food",
  // "You win the flip".)
  if (pseudo && pseudo.additionalCostLabel && !pseudo.additionalCostPaid) {
    const slots = [1, 2, 3, 4, 5, 6].filter(n => pseudo['additionalCostLabel' + (n > 1 ? n : '')]);
    out.push({ what: 'additional cost paid', apply: () => {
      slots.forEach(n => Battlefield.setAdditionalCostPaid(unitId, true, n));
      return () => slots.forEach(n => Battlefield.setAdditionalCostPaid(unitId, false, n));
    } });
  }
  // "When you do, if it has four or more quest counters on it, …" (Earthbender Ascension): the
  // counters the source's own words ask for. "It" is the source only before any "target" in the text.
  const onSelf = u.text.match(/\b(this [a-z]+|it) has (one|two|three|four|five|six|seven|eight|nine|ten|\d+) or more ([\w+/]+) counters? on it\b/i);
  if (onSelf && src && !(onSelf[1].toLowerCase() === 'it' && /\btarget\b/i.test(u.text.slice(0, onSelf.index)))) {
    const n = WORD_COUNT[onSelf[2].toLowerCase()] || parseInt(onSelf[2], 10);
    const kind = onSelf[3].toLowerCase();
    const have = (src.counters || {})[kind] || 0;
    if (n > have) {
      out.push({ what: (n - have) + ' ' + kind + ' counters put on the source', apply: () => {
        Battlefield.addCounter(src.id, kind, n - have);
        return () => Battlefield.removeCounter(src.id, kind, n - have);
      } });
    }
  }
  // "Put a flood counter on target land. That land is an Island … for as long as it has a flood counter
  // on it" (Aquitect's Will): the site leaves placing the counter to the player, so every listed
  // permanent is given the counters the target's words ask for. Each target must still change only itself.
  const onTarget = u.text.match(/\b(it|that [a-z]+) has (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)(?: or more)? ([\w+/]+) counters? on it\b/i);
  if (onTarget && tryIds.length && /\btarget\b/i.test(u.text.slice(0, onTarget.index))) {
    const word = onTarget[2].toLowerCase();
    const n = word === 'a' || word === 'an' ? 1 : WORD_COUNT[word] || parseInt(word, 10);
    const kind = onTarget[3].toLowerCase();
    const given = tryIds.map(tid => [tid, Math.max(0, n - (((Battlefield.getPermById(tid) || {}).counters || {})[kind] || 0))]).filter(g => g[1] > 0);
    if (given.length) {
      out.push({ what: n + ' ' + kind + ' counter' + (n > 1 ? 's' : '') + ' put on every listed permanent', apply: () => {
        given.forEach(([tid, k]) => Battlefield.addCounter(tid, kind, k));
        return () => given.forEach(([tid, k]) => Battlefield.removeCounter(tid, kind, k));
      } });
    }
  }
  // "Gain control of target creature for as long as that creature is enchanted" (Rootwater
  // Matriarch): the board has no Aura, so every listed permanent is made enchanted (or equipped) as
  // the target's words ask. Each target must still change only itself.
  const attached = u.text.match(/\b(?:it|that [a-z]+) is (enchanted|equipped)\b/i);
  if (attached && tryIds.length && /\btarget\b/i.test(u.text.slice(0, attached.index))) {
    const trait = cap1(attached[1].toLowerCase());
    const given = tryIds.map(tid => Battlefield.getPermById(tid)).filter(p => p && !(p.traits || []).includes(trait));
    if (given.length) {
      out.push({ what: 'every listed permanent made ' + trait.toLowerCase(), apply: () => {
        const saved = given.map(p => p.traits);
        given.forEach(p => { p.traits = (p.traits || []).concat([trait]); });
        return () => given.forEach((p, k) => { p.traits = saved[k]; });
      } });
    }
  }
  // "Gain control of target artifact" when every artifact is already yours: one becomes the opponent's.
  if (/\bgains? control of\b/i.test(u.text) && others.length) {
    const p = Battlefield.getPermById(others[0]);
    const opp = (Battlefield.players.find(pl => pl.id !== ctx.sourceCtrl) || {}).id;
    if (p && opp && (p.owner || 'player_0') === ctx.sourceCtrl) {
      out.push({ what: roleName(p.id) + ' given to the opponent', only: [p.id], apply: () => {
        const saved = [p.owner, p.controller];
        p.owner = p.controller = opp;
        return () => { [p.owner, p.controller] = saved; };
      } });
    }
  }
  // "Target creature loses first strike": a listed creature is given the keyword first.
  const loses = u.text.match(LOSES_RE);
  if (loses && others.length) {
    const named = (loses[2] || loses[3] || '').trim().toLowerCase();
    const kw = loses[2] ? cap1(named) + ' legendary creatures'
      : /^landwalk abilit/.test(named) ? 'Swampwalk'
      : cap1(named.replace(/^all\s+/, ''));
    const p = Battlefield.getPermById(others[0]);
    if (p && kw) {
      out.push({ what: roleName(p.id) + ' given ' + kw.toLowerCase(), only: [p.id], apply: () => {
        const saved = p.printedAbilities;
        p.printedAbilities = (saved || []).concat([kw]);
        return () => { p.printedAbilities = saved; };
      } });
    }
  }
  return out;
}

/* What the fixed board cannot show however it is adjusted, or null. Read from the text and the
   board as it was before the unit, never from the parse. */
function boardCannotShow(ctx, u, tryIds) {
  // Every listed permanent already has every keyword the text gives.
  const gains = u.text.match(/\b(?:gains?|ha(?:s|ve))\s+([a-z][a-z ,]*?)(?=\s+(?:until|this turn|for as long)\b|[.]|$)/i);
  if (gains && !/\b(?:gets?|becomes?|loses?)\b/i.test(u.text)) {
    const kws = gains[1].toLowerCase().split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map(k => k.trim()).filter(Boolean);
    const all = kws.length && kws.every(k => KEYWORD_SET.has(k)) &&
      tryIds.every(tid => kws.every(k => hasKeyword(ctx.preStates.get(tid), k)));
    if (all) return 'every listed permanent already has ' + kws.join(' and ');
  }
  // "Gain control of target Sliver" when the only one listed is the source itself.
  if (/\bgains? control of\b/i.test(u.text) && tryIds.every(tid => ctrlOf(ctx.preStates.get(tid), Battlefield.getPermById(tid) || {}) === ctx.sourceCtrl)) {
    return 'every listed permanent is already yours';
  }
  // The only continuous effect is in a sentence with its own condition ("Target creature can't be
  // blocked this turn. If it's a Vampire, it also gains lifelink …").
  const unconditional = u.text.split(/(?<=\.)\s+/).filter(x => !/\bif\b/i.test(x)).join(' ');
  if (unconditional !== u.text && !/\b(?:gets?|gains?|ha(?:s|ve)|becomes?|loses?)\b/i.test(unconditional)) {
    return 'the only continuous effect is conditional';
  }
  return null;
}

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
    // No targeted effect does not mean no effect: the parse may have gone global instead ("you
    // may have target creature get -1/-1" once gave every creature -1/-1). Check 1's first half
    // still applies.
    const mixed0 = mixedSubject(u.text, u.targetIndex, ctx.cardName, u.kind === 'spell');
    const changed0 = diffSummaries(ctx.before, summarizeBoard());
    u.check1 = { noTarget: changed0.map(c => ({ role: c.role, what: c.what })), perTarget: [] };
    if (!(mixed0.source || mixed0.group) && changed0.length) {
      finding('check1', 'changes-with-no-target', { changed: changed0.map(c => ({ role: c.role, what: c.what })) });
    }
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
  // The words before the target: a trigger's condition, then the effect up to "target".
  const effStart = u.fullText ? u.fullText.toLowerCase().indexOf(u.text.toLowerCase().slice(0, 24)) : -1;
  const wordsBefore = (effStart > 0 ? u.fullText.slice(0, effStart) : '') + ' ' + u.text.slice(0, u.targetIndex);
  const interp = interpretPhrase(u.phrase, { before: wordsBefore });
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
      if (!interp.test(st, p, ctx)) continue;
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
  // Chooses each of `ids` in turn against the summary `from`. `record` is false for a second
  // attempt on an adjusted board, which only answers "did a target change itself and nothing else?".
  const tryTargets = (ids, from, record) => {
    let ok = false, clean = true;
    for (const tid of ids.slice(0, 14)) {
      let changed = [];
      try {
        applyTarget(id, picker, tid);
        changed = diffSummaries(from, summarizeBoard());
      } catch (e) {
        if (record) finding('check1', 'crash', { error: errInfo('set target', e) });
        clean = false;
        break;
      } finally {
        try { applyTarget(id, picker, null); } catch (e) { /* the board is restored by the caller */ }
      }
      const role = roleName(tid);
      let counted = changed;
      if (mixed.source) counted = counted.filter(c => c.id !== ctx.sourceId);
      const targetChanged = changed.some(c => c.id === tid) && !(mixed.source && tid === ctx.sourceId);
      const others = mixed.group ? [] : counted.filter(c => c.id !== tid);
      if (targetChanged) ok = true;
      if (others.length) clean = false;
      if (!record) continue;
      u.check1.perTarget.push({ target: role, changed: changed.map(c => ({ role: c.role, what: c.what })) });
      if (targetChanged) anyTargetChanged = true; else noOp.push(role);
      if (others.length) othersSeen.push({ target: role, others: others.map(c => ({ role: c.role, what: c.what })) });
    }
    return ok && clean;
  };
  tryTargets(tryIds, before, true);
  if (othersSeen.length) finding('check1', 'target-changes-others', { examples: othersSeen.slice(0, 3), count: othersSeen.length });
  if (tryIds.length && !anyTargetChanged && !othersSeen.length) {
    // "-1/-1 for each Swamp you control", "where X is the number of cards in your graveyard": the board has
    // none, so the right answer may be a change of 0. Only for text that does nothing but give +N/-N,
    // so a keyword grant beside a count cannot hide behind it.
    if (COUNT_DEPENDENT.test(u.text) && /\bgets?\b/i.test(u.text) && !/\b(?:gains?|has|have|becomes?|loses?)\b/i.test(u.text)) u.infos.push({ code: 'count-or-condition-dependent', roles: [] });
    else {
      // The fixed board may simply have nothing the text can change (no creature with the keyword
      // being removed, every artifact already yours). The board is adjusted in the one way the
      // text asks for and the targets are tried again; only a unit that still changes nothing
      // is a finding.
      const shown = [];
      for (const adj of boardAdjustments(ctx, u, id, pseudo, tryIds)) {
        let undo = null, worked = false;
        try {
          undo = adj.apply();
          Battlefield._invalidate();
          const from = summarizeBoard();
          const r = picker.kind === 'none' ? null : candidatesFor(id, picker);
          const ids = r && r.candidates && r.candidates.length ? r.candidates.map(c => c.id) : tryIds;
          worked = tryTargets(adj.only ? ids.filter(x => adj.only.includes(x)) : ids, from, false);
        } catch (e) { worked = false; }
        finally { try { if (undo) undo(); } catch (e) { /* restored by the caller */ } Battlefield._invalidate(); }
        if (worked) { shown.push(adj.what); break; }
      }
      const limit = shown.length ? null : boardCannotShow(ctx, u, tryIds);
      if (shown.length) u.infos.push({ code: 'shown-on-adjusted-board', roles: [], what: shown[0] });
      else if (limit) u.infos.push({ code: 'board-cannot-show', roles: [], what: limit });
      else finding('check1', 'target-changes-nothing', { tried: tryIds.length });
    }
  }
  if (anyTargetChanged && noOp.length) u.infos.push({ code: 'no-op-on-some', roles: noOp });
  return { audited: true };
}

/* ─── Units with several targets, or "up to N" (classifyTargets) ───
   A pick is one target list of the site: { kind: 'single' } | { kind: 'multi', slotIndex } |
   { kind: 'slotted', slot }, and textSlot, the target of the text it stands for (null when the
   site's picker does not line up with the text, so its list is not judged). */
function pickLabel(pick) {
  return pick.kind === 'multi' ? 'pick ' + (pick.slotIndex + 1) : pick.kind === 'slotted' ? 'slot ' + (pick.slot + 1) : 'single';
}
function applyPick(unitId, pick, targetId) {
  if (pick.kind === 'multi') Battlefield.setMultiTarget(unitId, pick.slotIndex, targetId);
  else if (pick.kind === 'slotted') Battlefield.setSlottedTarget(unitId, pick.slot, targetId);
  else Battlefield.setTarget(unitId, targetId);
  Battlefield._invalidate();
}
function candidatesForPick(unitId, pick) {
  return getTargetCandidates(unitId, pick.kind === 'multi' ? { kind: 'multi', slotIndex: pick.slotIndex }
    : pick.kind === 'slotted' ? { kind: 'slotted', slot: pick.slot } : { kind: 'single' });
}

/* The permanents the text allows for target t of unit u, or { unknown }. */
function expectedForTarget(ctx, u, t) {
  const effStart = u.fullText ? u.fullText.toLowerCase().indexOf(u.text.toLowerCase().slice(0, 24)) : -1;
  const wordsBefore = (effStart > 0 ? u.fullText.slice(0, effStart) : '') + ' ' + u.text.slice(0, t.targetIndex);
  const interp = interpretPhrase(t.phrase, { before: wordsBefore, plural: t.plural });
  if (interp.unknown) return { unknown: interp.unknown };
  const exclude = interp.excludeSource || t.excludeSource || u.excludeSource;
  const ids = [];
  for (const p of ctx.universe) {
    if (exclude && !t.sourceNotJudged && p.id === ctx.sourceId) continue;
    const st = ctx.preStates.get(p.id);
    if (!st || !interp.test(st, p, ctx)) continue;
    const kws = keywordsOf(st);
    if (kws.includes('shroud')) continue;
    if (kws.includes('hexproof') && ctrlOf(st, p) !== ctx.sourceCtrl) continue;
    ids.push(p.id);
  }
  return { ids };
}

function auditFiredTargets(ctx, u, id) {
  const finding = (check, code, extra) => u.findings.push(Object.assign({ check, code }, extra || {}));
  const effs = Battlefield.effects.filter(e => e.sourceId === id);
  const targeted = effs.filter(e => e.scope === 'targeted' && !e.selfTarget);
  const finalStates = Battlefield.getAllFinalStates();
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

  const mixedOf = (t) => mixedSubject(u.text, t.targetIndex, ctx.cardName, u.kind === 'spell');
  const mixedAll = u.targets.map(mixedOf);
  const anyMixed = mixedAll.some(m => m.source || m.group);
  u.mixed = { source: mixedAll.some(m => m.source), group: mixedAll.some(m => m.group) };
  const before = ctx.before;
  const noTargetChanged = diffSummaries(before, summarizeBoard());
  u.check1 = { noTarget: noTargetChanged.map(c => ({ role: c.role, what: c.what })), perTarget: [] };
  if (!anyMixed && noTargetChanged.length) {
    finding('check1', 'changes-with-no-target', { changed: noTargetChanged.map(c => ({ role: c.role, what: c.what })) });
  }
  if (!targeted.length) { finding('check2', 'no-targeted-effect'); return { audited: true }; }

  /* ── Check 2: the picker kind ── */
  const picker = getTargetPickerKind(id, finalStates.get(id));
  u.pickerKind = picker.kind + (picker.kind === 'multi' ? ' of ' + picker.maxTargets : picker.kind === 'slotted' ? ' of ' + picker.slots : '');
  const want = u.expectKind;
  let picks = [];
  if (picker.kind === 'none') finding('check2', 'no-picker');
  else if (picker.kind === 'modal') finding('check2', 'picker-not-' + want, { actual: 'modal' });
  else if (want === 'multi') {
    if (picker.kind !== 'multi') finding('check2', 'picker-not-multi', { actual: picker.kind, expectedCount: u.maxTargets === ANY_NUMBER ? 'any number' : u.maxTargets });
    else if (u.maxTargets === ANY_NUMBER ? picker.maxTargets < 2 : picker.maxTargets !== u.maxTargets) finding('check2', 'max-targets-mismatch', { actual: picker.maxTargets, expectedCount: u.maxTargets === ANY_NUMBER ? 'any number' : u.maxTargets });
    // The one target of the text, whatever picker shows it.
    picks = [picker.kind === 'multi' ? { kind: 'multi', slotIndex: 0, textSlot: 0 } : picker.kind === 'slotted' ? { kind: 'slotted', slot: 0, textSlot: null } : { kind: 'single', textSlot: 0 }];
  } else {
    const n = u.targets.length;
    if (picker.kind !== 'slotted') finding('check2', 'picker-not-slotted', { actual: picker.kind, expectedCount: n });
    else if (picker.slots !== n) finding('check2', 'slot-count-mismatch', { actual: picker.slots, expectedCount: n });
    if (picker.kind === 'slotted') for (let s = 0; s < picker.slots; s++) picks.push({ kind: 'slotted', slot: s, textSlot: picker.slots === n ? s : null });
    else if (picker.kind === 'multi') picks = [{ kind: 'multi', slotIndex: 0, textSlot: null }];
    else picks = [{ kind: 'single', textSlot: null }];
  }

  /* ── Check 2: each list; Check 1: each target of each list ── */
  u.picks = [];
  for (const pick of picks) {
    const label = pickLabel(pick);
    const t = pick.textSlot !== null ? u.targets[pick.textSlot] : null;
    const rec = { pick: label, phrase: t ? t.phrase : null, expected: null, actual: null, perTarget: [] };
    u.picks.push(rec);
    let siteIds = null;
    try {
      const r = candidatesForPick(id, pick);
      if (r.blocked) rec.blocked = r.blocked; else siteIds = r.candidates.map(c => c.id);
    } catch (e) { finding('check2', 'crash', { slot: label, error: errInfo('candidates', e) }); }
    rec.actual = siteIds ? rolesOf(siteIds) : null;
    let expectedIds = null;
    if (t) {
      const ex = expectedForTarget(ctx, u, t);
      if (ex.unknown) { rec.phraseUnknown = ex.unknown; u.phraseUnknown = (u.phraseUnknown || []).concat(ex.unknown); }
      else {
        expectedIds = ex.ids;
        rec.expected = rolesOf(expectedIds);
        if (siteIds) {
          const judged = (x) => !(t.sourceNotJudged && x === ctx.sourceId);
          const missing = expectedIds.filter(x => judged(x) && !siteIds.includes(x)), extra = siteIds.filter(x => judged(x) && !expectedIds.includes(x));
          if (!siteIds.length && expectedIds.length) finding('check2', 'empty-list', { slot: label, missing: rolesOf(missing), extra: [] });
          else if (missing.length || extra.length) finding('check2', 'list-mismatch', { slot: label, missing: rolesOf(missing), extra: rolesOf(extra) });
        }
      }
    }
    // Check 1, this list: each listed permanent in turn (the others left empty).
    const mixed = t ? mixedOf(t) : u.mixed;
    const tryIds = siteIds && siteIds.length ? siteIds : (expectedIds || []);
    rec.via = siteIds && siteIds.length ? 'picker' : 'text';
    const othersSeen = [], noOp = [];
    let anyTargetChanged = false;
    const tryTargets = (ids, from, record) => {
      let ok = false, clean = true;
      for (const tid of ids.slice(0, 14)) {
        let changed = [];
        try { applyPick(id, pick, tid); changed = diffSummaries(from, summarizeBoard()); }
        catch (e) { if (record) finding('check1', 'crash', { slot: label, error: errInfo('set target', e) }); clean = false; break; }
        finally { try { applyPick(id, pick, null); } catch (e) { /* restored by the caller */ } }
        const role = roleName(tid);
        const counted = mixed.source ? changed.filter(c => c.id !== ctx.sourceId) : changed;
        const targetChanged = changed.some(c => c.id === tid) && !(mixed.source && tid === ctx.sourceId);
        const others = mixed.group ? [] : counted.filter(c => c.id !== tid);
        if (targetChanged) ok = true;
        if (others.length) clean = false;
        if (!record) continue;
        rec.perTarget.push({ target: role, changed: changed.map(c => ({ role: c.role, what: c.what })) });
        if (targetChanged) anyTargetChanged = true; else noOp.push(role);
        if (others.length) othersSeen.push({ target: role, others: others.map(c => ({ role: c.role, what: c.what })) });
      }
      return ok && clean;
    };
    tryTargets(tryIds, before, true);
    if (othersSeen.length) finding('check1', 'target-changes-others', { slot: label, examples: othersSeen.slice(0, 3), count: othersSeen.length });
    if (tryIds.length && !anyTargetChanged && !othersSeen.length) {
      if (COUNT_DEPENDENT.test(u.text) && /\bgets?\b/i.test(u.text) && !/\b(?:gains?|has|have|becomes?|loses?)\b/i.test(u.text)) u.infos.push({ code: 'count-or-condition-dependent', roles: [], slot: label });
      else {
        const shown = [];
        for (const adj of boardAdjustments(ctx, u, id, pseudo, tryIds)) {
          let undo = null, worked = false;
          try {
            undo = adj.apply();
            Battlefield._invalidate();
            const from = summarizeBoard();
            const r = candidatesForPick(id, pick);
            const ids = r && r.candidates && r.candidates.length ? r.candidates.map(c => c.id) : tryIds;
            worked = tryTargets(adj.only ? ids.filter(x => adj.only.includes(x)) : ids, from, false);
          } catch (e) { worked = false; }
          finally { try { if (undo) undo(); } catch (e) { /* restored by the caller */ } Battlefield._invalidate(); }
          if (worked) { shown.push(adj.what); break; }
        }
        const limit = shown.length ? null : boardCannotShow(ctx, u, tryIds);
        if (shown.length) u.infos.push({ code: 'shown-on-adjusted-board', roles: [], what: shown[0], slot: label });
        else if (limit) u.infos.push({ code: 'board-cannot-show', roles: [], what: limit, slot: label });
        else finding('check1', 'target-changes-nothing', { slot: label, tried: tryIds.length });
      }
    }
    if (anyTargetChanged && noOp.length) u.infos.push({ code: 'no-op-on-some', roles: noOp, slot: label });

    // "Up to two target creatures": a second pick must reach its own target too, with the first.
    if (pick.kind === 'multi' && picker.maxTargets >= 2) {
      const good = rec.perTarget.filter(x => x.changed.some(c => c.role === x.target)).map(x => x.target);
      const ids = tryIds.filter(x => good.includes(roleName(x)) && !(mixed.source && x === ctx.sourceId)).slice(0, 2);
      if (ids.length === 2) {
        let changed = [];
        try {
          applyPick(id, { kind: 'multi', slotIndex: 0 }, ids[0]);
          applyPick(id, { kind: 'multi', slotIndex: 1 }, ids[1]);
          changed = diffSummaries(before, summarizeBoard());
        } catch (e) { finding('check1', 'crash', { slot: 'pick 2', error: errInfo('set second target', e) }); }
        finally {
          try { applyPick(id, { kind: 'multi', slotIndex: 1 }, null); applyPick(id, { kind: 'multi', slotIndex: 0 }, null); } catch (e) { /* restored by the caller */ }
        }
        rec.together = { targets: rolesOf(ids), changed: changed.map(c => ({ role: c.role, what: c.what })) };
        if (!changed.some(c => c.id === ids[1])) finding('check1', 'second-pick-changes-nothing', { slot: 'pick 2', target: roleName(ids[1]) });
        const others = mixed.group ? [] : changed.filter(c => !ids.includes(c.id) && !(mixed.source && c.id === ctx.sourceId));
        if (others.length) finding('check1', 'target-changes-others', { slot: 'picks 1 and 2', examples: [{ target: rolesOf(ids).join(' + '), others: others.map(c => ({ role: c.role, what: c.what })) }], count: 1 });
      }
    }
  }
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
    try { return u.modePair ? auditFiredModePair(ctx, u, id) : u.targets ? auditFiredTargets(ctx, u, id) : auditFired(ctx, u, id); }
    catch (e) { u.findings.push({ check: 'check2', code: 'crash', error: errInfo('audit', e) }); return { audited: true }; }
  });
}

/* ═════════════════════════ One card face ═════════════════════════ */

function newUnit(kind, index, label, text, cls) {
  const u = { kind, index, label, text, findings: [], infos: [],
    phrase: cls.phrase, excludeSource: cls.excludeSource, targetIndex: cls.targetIndex };
  // Several targets, or "up to N" (classifyTargets): one phrase per target of the text.
  if (cls.targets) Object.assign(u, { targets: cls.targets, expectKind: cls.expectKind, maxTargets: cls.maxTargets,
    phrase: cls.targets.map(t => t.phrase).join(' / '), targetIndex: cls.targets[0].targetIndex });
  if (cls.origin) u.origin = cls.origin;
  return u;
}

/* ─── Modal spells ───
   The Modes pop-up (ui-abilities.js applyModalModePopup) picks the modes: a repeatable spell
   ("you may choose the same mode more than once") by counts, any other by the set of active
   modes. Each mode is a unit of its own, picked alone, and read from its own line
   (perm.modalModeTexts, the line as printed less its bullet or cost): which picker the site
   then shows and what it lists is judged against that line's words, exactly as a spell of that
   one line would be. */
function pickModes(perm, modeIndices) {
  if (perm.modalRepeatable) {
    const counts = {};
    for (const mi of modeIndices) counts[mi] = (counts[mi] || 0) + 1;
    Battlefield.setModalModeCounts(perm.id, counts);
    perm._unparseableCounts = {};
  } else {
    Battlefield.setModalModeSelections(perm.id, new Set(modeIndices));
    perm._unparseableActive = new Set();
  }
  Battlefield.evaluate();
}

function auditModes(rec, perm, ctx, run, skip, spellText) {
  const modes = perm.modalModeTexts || [];
  if (!modes.length) { skip('spell', undefined, '', spellText, 'modal-spell: no-modes'); return; }
  const saved = { counts: perm.modalModeCounts, unpC: perm._unparseableCounts, unpA: perm._unparseableActive };
  const restore = () => {
    perm.modalModeCounts = saved.counts;
    perm._unparseableCounts = saved.unpC;
    perm._unparseableActive = saved.unpA;
  };
  // The modes that name one permanent target, or one target of up to N:
  // { mi, text, phrase, targetIndex, excludeSource, plural, max } (max: how many picks the text allows).
  const oneTarget = [];
  modes.forEach((modeText, mi) => {
    const label = 'mode ' + (mi + 1);
    const text = stripReminder(modeText);
    const cls = classifyUnitText(text);
    if (!cls.singular && !cls.targets) { skip('spell', undefined, label, text, 'mode: ' + cls.skip); return; }
    if (cls.singular) oneTarget.push({ mi, text, phrase: cls.phrase, targetIndex: cls.targetIndex, excludeSource: cls.excludeSource, max: 1 });
    else if (cls.expectKind === 'multi' && cls.targets.length === 1) {
      const t = cls.targets[0];
      oneTarget.push({ mi, text, phrase: t.phrase, targetIndex: t.targetIndex, excludeSource: t.excludeSource, sourceNotJudged: t.sourceNotJudged, plural: t.plural, max: cls.maxTargets });
    }
    const u = newUnit('spell', undefined, label, text, cls);
    u.modeIndex = mi;
    try { run(u, () => { pickModes(perm, [mi]); return perm; }); }
    finally { restore(); }
  });
  // Two modes picked at once, each naming one target ("Choose two —", "Choose one or both —",
  // Entwine, Spree): the site shows one picker per mode (getTargetPickerKind 'modal'), and each
  // must list what its own mode's words allow and reach only its own target. A mode of up to N
  // targets ("Up to X target creatures gain fear") has N pickers of its own (modeMaxTargets).
  if ((perm.modalMaxActive ?? 1) < 2) return;
  for (let i = 0; i < oneTarget.length; i++) {
    for (let j = i + 1; j < oneTarget.length; j++) {
      const pair = [oneTarget[i], oneTarget[j]];
      const label = 'modes ' + (pair[0].mi + 1) + '+' + (pair[1].mi + 1);
      const u = { kind: 'spell', index: undefined, label, text: pair.map(m => m.text).join(' + '), findings: [], infos: [],
        phrase: pair.map(m => m.phrase).join(' / '), modePair: pair, expectKind: 'modal' };
      try { run(u, () => { pickModes(perm, pair.map(m => m.mi)); return perm; }); }
      finally { restore(); }
    }
  }
}

/* Two modes of a modal spell picked together (auditModes): Check 2 is that the site shows the
   per-mode picker for exactly these two modes and that each mode's list is what that mode's words
   allow; Check 1 is that no permanent changes with no target, that a target chosen for one mode (the
   other left empty) changes only itself, and that a target for each mode at once changes both. */
function auditFiredModePair(ctx, u, id) {
  const finding = (check, code, extra) => u.findings.push(Object.assign({ check, code }, extra || {}));
  const finalStates = Battlefield.getAllFinalStates();
  const info = getEffectInfo(id, finalStates.get(id));
  if (info.hasText) return { skip: 'text-change-modal' };
  if (info.hasExchangeControl) return { skip: 'exchange-control-modal' };
  if (info.hasCopy) return { skip: 'copy-picker' };
  const pair = u.modePair;
  const mixedOf = (m) => mixedSubject(m.text, m.targetIndex, ctx.cardName, true);
  const mixed = pair.map(mixedOf);
  const anyMixed = mixed.some(x => x.source || x.group);
  u.mixed = { source: mixed.some(x => x.source), group: mixed.some(x => x.group) };
  const before = ctx.before;
  const noTargetChanged = diffSummaries(before, summarizeBoard());
  u.check1 = { noTarget: noTargetChanged.map(c => ({ role: c.role, what: c.what })), perTarget: [] };
  if (!anyMixed && noTargetChanged.length) finding('check1', 'changes-with-no-target', { changed: u.check1.noTarget });

  /* ── Check 2: the picker kind ── */
  const picker = getTargetPickerKind(id, finalStates.get(id));
  const want = pair.map(m => m.mi);
  u.pickerKind = picker.kind + (picker.kind === 'modal' ? ' of modes ' + picker.modes.map(x => x + 1 + ((picker.modeMaxTargets || {})[x] > 1 ? ' (' + picker.modeMaxTargets[x] + ' picks)' : '')).join('+') : '');
  if (picker.kind !== 'modal') { finding('check2', 'picker-not-modal', { actual: picker.kind }); return { audited: true }; }
  const got = picker.modes.slice().sort((a, b) => a - b);
  if (got.length !== 2 || got[0] !== want[0] || got[1] !== want[1]) finding('check2', 'modal-modes-mismatch', { actual: got.map(x => x + 1), expectedCount: want.map(x => x + 1) });

  // Each mode's number of picks.
  const modeMax = picker.modeMaxTargets || {};
  for (const m of pair) {
    const got = modeMax[m.mi] || 1;
    if (m.max === ANY_NUMBER ? got < 2 : got !== m.max) finding('check2', 'max-targets-mismatch', { slot: 'mode ' + (m.mi + 1), actual: got, expectedCount: m.max === ANY_NUMBER ? 'any number' : m.max });
  }
  // (A mode of several picks is judged on its first; the rest are the same list.)
  const slotOf = (m) => (modeMax[m.mi] || 1) > 1 ? 0 : undefined;

  /* ── Check 2: each mode's list; Check 1: each target of it ── */
  u.picks = [];
  const good = [];   // per mode: the listed targets that changed themselves and nothing else
  pair.forEach((m, k) => {
    const label = 'mode ' + (m.mi + 1);
    const rec = { pick: label, phrase: m.phrase, expected: null, actual: null, perTarget: [] };
    u.picks.push(rec);
    let siteIds = null;
    try {
      const r = getTargetCandidates(id, { kind: 'modal', modeIndex: m.mi, slotIndex: slotOf(m) });
      if (r.noEffect) finding('check2', 'no-targeted-effect', { slot: label });
      else siteIds = r.candidates.map(c => c.id);
    } catch (e) { finding('check2', 'crash', { slot: label, error: errInfo('candidates', e) }); }
    rec.actual = siteIds ? rolesOf(siteIds) : null;
    const ex = expectedForTarget(ctx, { text: m.text, excludeSource: m.excludeSource }, m);
    let expectedIds = null;
    if (ex.unknown) { rec.phraseUnknown = ex.unknown; u.phraseUnknown = (u.phraseUnknown || []).concat(ex.unknown); }
    else {
      expectedIds = ex.ids;
      rec.expected = rolesOf(expectedIds);
      if (siteIds) {
        const judged = (x) => !(m.sourceNotJudged && x === ctx.sourceId);
        const missing = expectedIds.filter(x => judged(x) && !siteIds.includes(x)), extra = siteIds.filter(x => judged(x) && !expectedIds.includes(x));
        if (!siteIds.length && expectedIds.length) finding('check2', 'empty-list', { slot: label, missing: rolesOf(missing), extra: [] });
        else if (missing.length || extra.length) finding('check2', 'list-mismatch', { slot: label, missing: rolesOf(missing), extra: rolesOf(extra) });
      }
    }
    const tryIds = siteIds && siteIds.length ? siteIds : (expectedIds || []);
    rec.via = siteIds && siteIds.length ? 'picker' : 'text';
    const othersSeen = [], noOp = [], ok = [];
    for (const tid of tryIds.slice(0, 14)) {
      let changed = [];
      try { Battlefield.setModalModeTarget(id, m.mi, tid, slotOf(m)); Battlefield._invalidate(); changed = diffSummaries(before, summarizeBoard()); }
      catch (e) { finding('check1', 'crash', { slot: label, error: errInfo('set target', e) }); break; }
      finally { try { Battlefield.setModalModeTarget(id, m.mi, null, slotOf(m)); Battlefield._invalidate(); } catch (e) { /* restored by the caller */ } }
      const role = roleName(tid);
      const counted = mixed[k].source ? changed.filter(c => c.id !== ctx.sourceId) : changed;
      const targetChanged = changed.some(c => c.id === tid) && !(mixed[k].source && tid === ctx.sourceId);
      const others = mixed[k].group ? [] : counted.filter(c => c.id !== tid);
      rec.perTarget.push({ target: role, changed: changed.map(c => ({ role: c.role, what: c.what })) });
      if (targetChanged) { if (!others.length) ok.push(tid); } else noOp.push(role);
      if (others.length) othersSeen.push({ target: role, others: others.map(c => ({ role: c.role, what: c.what })) });
    }
    good.push(ok);
    if (othersSeen.length) finding('check1', 'target-changes-others', { slot: label, examples: othersSeen.slice(0, 3), count: othersSeen.length });
    // (Each mode alone was already judged on its own line; a target that changes nothing here as
    // well is information unless it changed itself there.)
    if (tryIds.length && !ok.length && !othersSeen.length) {
      if (COUNT_DEPENDENT.test(m.text) && /\bgets?\b/i.test(m.text)) u.infos.push({ code: 'count-or-condition-dependent', roles: [], slot: label });
      else finding('check1', 'target-changes-nothing', { slot: label, tried: tryIds.length });
    } else if (ok.length && noOp.length) u.infos.push({ code: 'no-op-on-some', roles: noOp, slot: label });
    // A mode of several picks: a second target, with one in the first pick, changes too.
    if ((modeMax[m.mi] || 1) > 1 && ok.length >= 2) {
      let changed2 = [];
      try {
        Battlefield.setModalModeTarget(id, m.mi, ok[0], 0);
        Battlefield.setModalModeTarget(id, m.mi, ok[1], 1);
        Battlefield._invalidate();
        changed2 = diffSummaries(before, summarizeBoard());
      } catch (e) { finding('check1', 'crash', { slot: label + ' pick 2', error: errInfo('set second target', e) }); }
      finally { try { Battlefield.setModalModeTarget(id, m.mi, null, 1); Battlefield.setModalModeTarget(id, m.mi, null, 0); Battlefield._invalidate(); } catch (e) { /* restored by the caller */ } }
      rec.together = { targets: rolesOf(ok.slice(0, 2)), changed: changed2.map(c => ({ role: c.role, what: c.what })) };
      if (!changed2.some(c => c.id === ok[1])) finding('check1', 'second-pick-changes-nothing', { slot: label + ' pick 2', target: roleName(ok[1]) });
    }
  });
  // A target for each mode at once: both change.
  if (good[0].length && good[1].length) {
    const a = good[0][0], b = good[1].find(x => x !== a) || good[1][0];
    let changed = [];
    try {
      Battlefield.setModalModeTarget(id, pair[0].mi, a, slotOf(pair[0]));
      Battlefield.setModalModeTarget(id, pair[1].mi, b, slotOf(pair[1]));
      Battlefield._invalidate();
      changed = diffSummaries(before, summarizeBoard());
    } catch (e) { finding('check1', 'crash', { slot: 'both modes', error: errInfo('set both targets', e) }); }
    finally {
      try { Battlefield.setModalModeTarget(id, pair[0].mi, null, slotOf(pair[0])); Battlefield.setModalModeTarget(id, pair[1].mi, null, slotOf(pair[1])); Battlefield._invalidate(); } catch (e) { /* restored by the caller */ }
    }
    u.together = { targets: rolesOf([a, b]), changed: changed.map(c => ({ role: c.role, what: c.what })) };
    if (a !== b && !changed.some(c => c.id === b)) finding('check1', 'second-mode-changes-nothing', { slot: 'mode ' + (pair[1].mi + 1), target: roleName(b) });
    if (a !== b && !changed.some(c => c.id === a)) finding('check1', 'second-mode-changes-nothing', { slot: 'mode ' + (pair[0].mi + 1), target: roleName(a) });
  }
  return { audited: true };
}

/* ═════════════════════════ Auras: the attach picker ═════════════════════════
   An Aura on the battlefield is attached with the ordinary single picker (setTarget). Its unit is
   read from its own "Enchant …" line, on a board of its own: the fixed board plus the witnesses
   below, which only an attach picker needs (none of the other units see them). Check 2: the
   picker is the single one and lists what the Enchant line allows, less the Aura itself (CR
   303.4d), what has shroud, what an opponent controls with hexproof (an Aura spell targets, CR
   303.4a) and what has protection from the Aura (CR 702.16c, judged below from the witness's own
   words and the Aura's colours and types). Check 1: the Aura with nothing attached changes no
   permanent, and attached to each listed permanent changes that permanent and no other; a plain
   "Enchanted creature gets +N/+N / has <keywords>" must change more than the Enchanted trait. */

const AURA_COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];
function auraWitnesses(auraColors) {
  const mk = (name, text, colors, controller, role) => ({ role, controller, card: {
    name, layout: 'normal', type_line: 'Creature — Elemental', oracle_text: text, mana_cost: '{2}', cmc: 2,
    power: '2', toughness: '2', colors, color_identity: colors, keywords: [] } });
  const out = [
    mk('Audit Veiled Elemental', 'Hexproof', ['G'], 'p2', "opponent's hexproof creature"),
    mk('Audit Warded Elemental', 'Hexproof', ['G'], 'p1', 'your hexproof creature'),
    mk('Audit Shrouded Elemental', 'Shroud', ['G'], 'p1', 'your shroud creature'),
    mk('Audit Aura-Proof Elemental', 'Protection from enchantments', ['G'], 'p2', "opponent's creature with protection from enchantments"),
  ];
  const own = AURA_COLOR_ORDER.find(c => auraColors.includes(c));
  const other = AURA_COLOR_ORDER.find(c => !auraColors.includes(c));
  if (own) out.push(mk('Audit Warded Spirit', 'Protection from ' + COLOR_NAME[own], ['G'], 'p2', "opponent's creature with protection from the Aura's colour"));
  if (other) out.push(mk('Audit Bright Spirit', 'Protection from ' + COLOR_NAME[other], ['G'], 'p1', 'your creature with protection from another colour'));
  return out;
}

/* Is the permanent with state st protected from the Aura (aura: its state)? By the protection
   words on st alone: colours, mono/multicolored, card types and subtypes (plural), everything.
   null when a quality is not one of these. */
function auditProtectedFrom(st, aura) {
  let unknown = false, hit = false;
  const auraColors = stateColors(aura);
  for (const kw of keywordsOf(st)) {
    const m = kw.match(/^protection from (.+)$/);
    if (!m) continue;
    for (let q of m[1].split(/\s*,\s*(?:and\s+)?(?:from\s+)?|\s+and\s+from\s+|\s+and\s+/)) {
      q = q.replace(/^from\s+/, '').trim();
      if (COLOR_CODES[q]) { if (auraColors.includes(COLOR_CODES[q])) hit = true; }
      else if (q === 'everything') hit = true;
      else if (q === 'multicolored') { if (auraColors.length >= 2) hit = true; }
      else if (q === 'monocolored') { if (auraColors.length === 1) hit = true; }
      else if (q === 'colorless') { if (!auraColors.length) hit = true; }
      else {
        const sg = singularForms(q);
        const w = sg.find(s => PERMANENT_NOUNS.has(s) || subtypeWords().has(s));
        if (!w) { unknown = true; continue; }
        if (hasCI(aura.types, w) || hasCI(aura.subtypes, w)) hit = true;
      }
    }
  }
  return hit ? true : unknown ? null : false;
}

// "Enchanted creature gets +2/+2" / "Enchanted creature has flying and vigilance", on its own and
// with nothing that makes it depend on the board: attaching must show more than the Enchanted trait.
function plainEnchantedGrant(text, word) {
  const w = word || 'enchanted';
  for (const s of String(text).replace(/’/g, "'").split(/(?<=\.)\s+|\n/)) {
    const l = s.toLowerCase().trim();
    if (!new RegExp('^' + w + ' (?:creature|permanent|land|artifact|planeswalker) ').test(l)) continue;
    if (/\b(?:as long as|if|for each|where x|equal to|during|unless|for as long|x\/|\/x|chosen|as though)\b/.test(l)) continue;
    let m;
    if ((m = l.match(new RegExp('^' + w + ' \\w+ gets ([+-]\\d+)/([+-]\\d+)\\.?$'))) && (+m[1] || +m[2])) return { pt: [+m[1], +m[2]] };
    if ((m = l.match(new RegExp('^' + w + ' \\w+ (?:has|gains) ([a-z ,]+?)\\.?$')))) {
      const kws = m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map(k => k.trim()).filter(Boolean);
      if (kws.length && kws.every(k => KEYWORD_SET.has(k))) return { kws };
    }
    if ((m = l.match(new RegExp('^' + w + ' \\w+ gets ([+-]\\d+)/([+-]\\d+) and has ([a-z ,]+?)\\.?$')))) {
      const kws = m[3].split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map(k => k.trim()).filter(Boolean);
      if (kws.every(k => KEYWORD_SET.has(k))) return { pt: [+m[1], +m[2]], kws };
    }
  }
  return null;
}

function auditAttach(card, faceIndex, rec, face) {
  const typeLine = face.type_line || card.type_line || '';
  if (!/\bAura\b/.test(typeLine)) return;
  const text = String(face.oracle_text || '').split('\n').map(stripReminder).filter(Boolean).join('\n');
  const em = text.match(/^Enchant (.+)$/im);
  const skip = (reason) => rec.skipped.push({ unit: 'attach', reason, text: text.slice(0, 140) });
  if (!em) { skip('attach: no-enchant-line'); return; }
  const phrase = em[1].trim().replace(/\.$/, '');
  const lower = phrase.toLowerCase();
  if (/\b(?:player|opponent)s?\b/.test(lower.replace(/\b(?:an opponent|that player) controls\b/g, ''))) { skip('attach: enchant-player'); return; }
  if (/\b(?:card|cards|graveyard|hand|library|spell)\b/.test(lower)) { skip('attach: enchant-card'); return; }
  const u = { kind: 'attach', index: undefined, label: '', text: text.slice(0, 400), phrase, findings: [], infos: [] };
  const finding = (check, code, extra) => u.findings.push(Object.assign({ check, code }, extra || {}));
  let perm, ctx;
  try {
    buildBoard();
    const colors = (face.colors || card.colors || []).map(String);
    for (const e of auraWitnesses(colors)) {
      const c = e.controller === 'p2' ? Battlefield.players[1].id : 'player_0';
      Battlefield.activePlayerId = c;
      const p = Battlefield.addPermanent(JSON.parse(JSON.stringify(e.card)), { suppressPrompt: true, controller: c, owner: c });
      roleOf.set(p.id, e.role);
    }
    Battlefield.activePlayerId = 'player_0';
    Battlefield._invalidate();
    const beforeAura = summarizeBoard();
    perm = addAuditedCard(card, faceIndex, false);
    roleOf.set(perm.id, 'source');
    if (perm.hasBestow) { skip('attach: bestow'); return; }
    const preStates = Battlefield.getAllFinalStates();
    const before = summarizeBoard();
    const universe = Battlefield.permanents.filter(p => !p.isManualEffect && !p.isSpell);
    ctx = { cardName: rec.name, sourceCtrl: 'player_0', sourceId: perm.id, preStates, before, beforeAura, universe };
  } catch (e) { rec.errors.push(errInfo('attach add', e)); return; }

  try {
    // What else the text names besides the enchanted permanent: the Aura itself, or a group.
    const rest = text.replace(/^Enchant .+$/im, '').replace(/["“][^"”]*["”]/g, 'QUOTED');
    const restLower = rest.toLowerCase().replace(/’/g, "'");
    const names = [String(rec.name || '').toLowerCase()];
    if (names[0].indexOf(',') > 0) names.push(names[0].slice(0, names[0].indexOf(',')));
    const mixed = {
      source: SELF_WORDS.test(restLower) || names.some(n => n.length > 2 && restLower.includes(n)),
      group: GROUP_WORDS.test(restLower) || /\b(?:creatures|permanents|lands|artifacts) (?:you control|your opponents control|an opponent controls)\b|\ball \w+s?\b|\beach (?:other )?\w+\b/.test(restLower),
    };
    u.mixed = { source: false, group: mixed.group };

    // Check 1: with nothing attached, no permanent changes.
    const noTarget = diffSummaries(ctx.beforeAura, ctx.before);
    u.check1 = { noTarget: noTarget.map(c => ({ role: c.role, what: c.what })), perTarget: [] };
    if (!mixed.group && noTarget.length) finding('check1', 'changes-with-no-target', { changed: u.check1.noTarget });

    // Check 2: the picker.
    const finalStates = Battlefield.getAllFinalStates();
    const picker = getTargetPickerKind(perm.id, finalStates.get(perm.id));
    u.pickerKind = picker.kind;
    if (picker.kind === 'none') finding('check2', 'no-picker');
    else if (picker.kind !== 'single') finding('check2', 'picker-kind-' + picker.kind);
    let siteIds = null;
    if (picker.kind !== 'none') {
      try {
        const r = getTargetCandidates(perm.id, { kind: 'single' });
        if (r.blocked) u.blocked = r.blocked; else siteIds = r.candidates.map(c => c.id);
      } catch (e) { finding('check2', 'crash', { error: errInfo('candidates', e) }); }
    }
    u.actual = siteIds ? rolesOf(siteIds) : null;
    if (u.blocked) finding('check2', 'blocked', { what: u.blocked });

    let expectedIds = null;
    const interp = interpretPhrase(phrase, { before: '' });
    if (interp.unknown) u.phraseUnknown = interp.unknown;
    else {
      expectedIds = [];
      const auraSt = ctx.preStates.get(perm.id) || {};
      const unjudged = [];
      for (const p of ctx.universe) {
        if (p.id === perm.id) continue;               // CR 303.4d
        const st = ctx.preStates.get(p.id);
        if (!st || !interp.test(st, p, ctx)) continue;
        const kws = keywordsOf(st);
        if (kws.includes('shroud')) continue;
        if (kws.includes('hexproof') && ctrlOf(st, p) !== ctx.sourceCtrl) continue;
        const prot = auditProtectedFrom(st, auraSt);
        if (prot === null) { unjudged.push(p.id); continue; }
        if (prot) continue;
        expectedIds.push(p.id);
      }
      u.expected = rolesOf(expectedIds);
      if (siteIds) {
        const judged = (x) => !unjudged.includes(x);
        const missing = expectedIds.filter(x => !siteIds.includes(x)), extra = siteIds.filter(x => judged(x) && !expectedIds.includes(x));
        if (!siteIds.length && expectedIds.length) finding('check2', 'empty-list', { missing: rolesOf(missing), extra: [] });
        else if (missing.length || extra.length) finding('check2', 'list-mismatch', { missing: rolesOf(missing), extra: rolesOf(extra) });
      }
    }

    // Check 1: attached to each listed permanent (or, with an empty list, each one the text allows).
    const tryIds = siteIds && siteIds.length ? siteIds : (expectedIds || []);
    u.check1.via = siteIds && siteIds.length ? 'picker' : 'text';
    const grant = plainEnchantedGrant(text);
    const othersSeen = [], noOp = [], traitOnly = [];
    for (const tid of tryIds.slice(0, 16)) {
      let changed = [];
      try {
        withRestore(() => {
          Battlefield.setTarget(perm.id, tid);   // setEffectTarget in ui-targeting.js
          Battlefield._invalidate();
          changed = diffSummaries(ctx.before, summarizeBoard());
        });
      } catch (e) { finding('check1', 'crash', { error: errInfo('attach', e) }); break; }
      const role = roleName(tid);
      u.check1.perTarget.push({ target: role, changed: changed.map(c => ({ role: c.role, what: c.what })) });
      const mine = changed.find(c => c.id === tid);
      if (!mine) noOp.push(role);
      else if (grant && /^traits \+Enchanted$/.test(mine.what)) {
        // A creature that already has every keyword granted shows nothing more.
        const st = ctx.preStates.get(tid);
        if (grant.pt || !(grant.kws || []).every(k => hasKeyword(st, k))) traitOnly.push(role);
      }
      const others = mixed.group ? [] : changed.filter(c => c.id !== tid && !(mixed.source && c.id === perm.id));
      if (others.length) othersSeen.push({ target: role, others: others.map(c => ({ role: c.role, what: c.what })) });
    }
    if (othersSeen.length) finding('check1', 'target-changes-others', { examples: othersSeen.slice(0, 3), count: othersSeen.length });
    if (noOp.length) finding('check1', 'attach-changes-nothing', { roles: noOp });
    if (traitOnly.length) finding('check1', 'grant-not-applied', { roles: traitOnly, what: grant.pt ? 'gets ' + grant.pt.join('/') : 'has ' + grant.kws.join(', ') });
  } catch (e) { u.findings.push({ check: 'check2', code: 'crash', error: errInfo('attach audit', e) }); }
  finally { Battlefield._invalidate(); }
  rec.units.push(u);
}

/* ═════════════════════════ Equipment: the equip list ═════════════════════════
   "Equip {cost}", "Equip [quality] {cost}", "Reconfigure {cost}" and "Fortify {cost}" are each a
   unit ("equip"), read from the line itself by the audit: CR 702.6a "Equip" is "Attach to target
   creature you control", "Equip [quality]" is "target [quality] creature you control" (a quality
   that names a card type is that type: "Equip planeswalker"), CR 702.151a Reconfigure is "another
   target creature you control", CR 702.67a Fortify "target land you control". A quality the card
   defines in its reminder text ("Equip worthy {1} (A creature is worthy if it's a legendary
   non-Villain that's red and/or white.)") is read from that definition. The site's list is
   getEquipCandidates (cards-targeting.js), which the Equip pop-up renders, on a board of its own:
   the fixed board plus the witnesses below. Check 2: the site reads the line as an equip ability
   (equip-not-detected), shows no other picker for it (single-picker-shown), and lists what the
   line allows, less the Equipment itself, shroud and protection from the Equipment (CR 702.16c);
   hexproof does not keep a permanent you control out. An Equipment or Fortification that is a
   creature can't equip unless it has reconfigure (CR 301.5c, 704.5p): the list must then be
   blocked (creature-equip-not-blocked), and it is also tried with the Equipment made an artifact
   creature. Check 1: unattached, the Equipment changes no permanent; attached (applyEquipAttachment,
   as the pop-up's Apply does) to each listed permanent it changes that permanent and no other; a
   plain "Equipped creature gets +N/+N / has <keywords>" must show more than the Equipped trait. */

const EQUIP_LINE_RE = /^(Equip|Reconfigure|Fortify)(?:\s+(?!abilities\b|costs?\b)([a-z][a-z ,'’-]*?))?\s*(?:—|\{|\d)/i;
function equipLines(rawText) {
  const out = [];
  for (const raw of String(rawText || '').split('\n')) {
    const line = stripReminder(raw);
    const m = line.match(EQUIP_LINE_RE);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    if (kind !== 'equip' && m[2]) continue;
    out.push({ kind, quality: kind === 'equip' && m[2] ? m[2].trim().toLowerCase() : null, line, raw: raw.trim() });
  }
  return out;
}

// The phrase after "target" the line stands for, by the audit's own reading, and a test for a
// quality the reminder text defines. { phrase, extra(st, p) | null, excludeSource }.
function equipPhrase(el) {
  if (el.kind === 'fortify') return { phrase: 'land you control' };
  if (el.kind === 'reconfigure') return { phrase: 'creature you control', excludeSource: true };
  if (!el.quality) return { phrase: 'creature you control' };
  const def = el.raw.replace(/’/g, "'").match(/\(a (?:creature|permanent) is ([a-z]+) if it's an? ([^)]+?)\.?\)/i);
  if (def && def[1].toLowerCase() === el.quality) {
    // "a legendary non-Villain that's red and/or white": the words before "that's", and its colours.
    const m = def[2].toLowerCase().match(/^(.+?) that's ((?:white|blue|black|red|green)(?:(?:,\s*|\s+and\/or\s+|\s+or\s+)(?:white|blue|black|red|green))*)$/);
    if (m) {
      const cols = m[2].split(/,\s*|\s+and\/or\s+|\s+or\s+/).map(c => COLOR_CODES[c]);
      return { phrase: m[1] + ' creature you control', extra: (st) => stateColors(st).some(c => cols.includes(c)), defined: def[2] };
    }
    return { phrase: def[2].toLowerCase() + (/\b(?:creature|planeswalker)\b/.test(def[2].toLowerCase()) ? '' : ' creature') + ' you control', defined: def[2] };
  }
  const hasNoun = el.quality.split(/[\s,]+/).some(w => PERMANENT_NOUNS.has(w));
  return { phrase: el.quality + (hasNoun ? '' : ' creature') + ' you control' };
}

function equipWitnesses(colors, lines) {
  const mk = (name, typeLine, text, wColors, controller, role, extra) => Object.assign({ role, controller, card: {
    name, layout: 'normal', type_line: typeLine, oracle_text: text, mana_cost: '{2}', cmc: 2,
    power: /Creature/.test(typeLine) ? '2' : undefined, toughness: /Creature/.test(typeLine) ? '2' : undefined,
    loyalty: /Planeswalker/.test(typeLine) ? '3' : undefined, colors: wColors, color_identity: wColors, keywords: [] } }, extra || {});
  const out = [
    mk('Audit Warded Elemental', 'Creature — Elemental', 'Hexproof', ['G'], 'p1', 'your hexproof creature'),
    mk('Audit Shrouded Elemental', 'Creature — Elemental', 'Shroud', ['G'], 'p1', 'your shroud creature'),
    mk('Audit Rustproof Elemental', 'Creature — Elemental', 'Protection from artifacts', ['G'], 'p1', 'your creature with protection from artifacts'),
    mk('Audit Elemental Token', 'Token Creature — Elemental', '', ['G'], 'p1', 'your creature token', { token: true }),
    mk('Audit Commander', 'Legendary Creature — Elemental', '', ['G'], 'p1', 'your commander', { commander: true }),
    mk('Audit Planeswalker', 'Legendary Planeswalker — Audit', '', ['G'], 'p1', 'your planeswalker'),
  ];
  const own = AURA_COLOR_ORDER.find(c => colors.includes(c));
  const other = AURA_COLOR_ORDER.find(c => !colors.includes(c));
  if (own) out.push(mk('Audit Warded Spirit', 'Creature — Spirit', 'Protection from ' + COLOR_NAME[own], ['G'], 'p1', "your creature with protection from the Equipment's colour"));
  if (other) out.push(mk('Audit Bright Spirit', 'Creature — Spirit', 'Protection from ' + COLOR_NAME[other], ['G'], 'p1', 'your creature with protection from another colour'));
  // A creature of each subtype the quality names, one yours and one the opponent's.
  const seen = new Set();
  for (const el of lines) {
    for (const w of String(el.quality || '').split(/[\s,]+/)) {
      if (!w || w === 'or' || seen.has(w) || !subtypeWords().has(w) || PERMANENT_NOUNS.has(w)) continue;
      seen.add(w);
      out.push(mk('Audit ' + cap1(w), 'Creature — ' + cap1(w), '', ['G'], 'p1', 'your ' + w));
      out.push(mk('Audit ' + cap1(w), 'Creature — ' + cap1(w), '', ['G'], 'p2', "opponent's " + w));
    }
    // A quality defined in the reminder text: a creature that is all of it and one that misses a part.
    if (el.quality && equipPhrase(el).defined && !seen.has('(defined)')) {
      seen.add('(defined)');
      out.push(mk('Audit Worthy Hero', 'Legendary Creature — Human', '', ['R'], 'p1', 'your creature of the defined quality'));
      out.push(mk('Audit Unworthy Villain', 'Legendary Creature — Human Villain', '', ['R'], 'p1', 'your Villain of the quality\'s colour'));
      out.push(mk('Audit Pale Hero', 'Legendary Creature — Human', '', ['B'], 'p1', 'your legendary creature of another colour'));
    }
  }
  return out;
}

function auditEquip(card, faceIndex, rec, face) {
  const typeLine = face.type_line || card.type_line || '';
  if (/\b(?:instant|sorcery)\b/i.test(typeLine)) return;
  const lines = equipLines(face.oracle_text || '');
  if (!lines.length) return;
  const text = String(face.oracle_text || '').split('\n').map(stripReminder).filter(Boolean).join('\n');
  const colors = (face.colors || card.colors || []).map(String);
  let perm, ctx;
  try {
    buildBoard();
    for (const e of equipWitnesses(colors, lines)) {
      const c = e.controller === 'p2' ? Battlefield.players[1].id : 'player_0';
      Battlefield.activePlayerId = c;
      const p = Battlefield.addPermanent(JSON.parse(JSON.stringify(e.card)), { suppressPrompt: true, controller: c, owner: c, isToken: !!e.token });
      roleOf.set(p.id, e.role);
      // A commander on the battlefield is one its owner's command zone links to (isCommander).
      if (e.commander) Battlefield.players[0].commanders.push({ card: null, name: p.name, imageUri: null, castCount: 0, linkedPermId: p.id });
    }
    Battlefield.activePlayerId = 'player_0';
    Battlefield._invalidate();
    const beforeEquip = summarizeBoard();
    perm = addAuditedCard(card, faceIndex, false);
    roleOf.set(perm.id, 'source');
    const preStates = Battlefield.getAllFinalStates();
    const before = summarizeBoard();
    const universe = Battlefield.permanents.filter(p => !p.isManualEffect && !p.isSpell);
    ctx = { cardName: rec.name, sourceCtrl: 'player_0', sourceId: perm.id, preStates, before, beforeEquip, universe };
  } catch (e) { rec.errors.push(errInfo('equip add', e)); return; }

  // What else the text names besides the equipped permanent: a group ("Equipment you control",
  // "other creatures you control get …").
  const rest = text.split('\n').filter(l => !EQUIP_LINE_RE.test(l)).join('\n').replace(/["“][^"”]*["”]/g, 'QUOTED');
  const restLower = rest.toLowerCase().replace(/’/g, "'");
  const group = GROUP_WORDS.test(restLower) || /\b(?:creatures|permanents|lands|artifacts|equipment) (?:you control|your opponents control|an opponent controls)\b|\ball \w+s?\b|\beach (?:other )?\w+\b/.test(restLower);
  const grant = plainEnchantedGrant(text, lines.some(l => l.kind === 'fortify') ? 'fortified' : 'equipped');

  const fState = ctx.preStates.get(perm.id) || {};
  let siteAbilities = [];
  try { siteAbilities = Battlefield.extractActivatedAbilities(fState.abilities || []).filter(a => a.isEquip || a.isReconfigure || a.isFortify); }
  catch (e) { rec.errors.push(errInfo('equip extract', e)); return; }
  const used = new Set();

  lines.forEach((el, li) => {
    const u = { kind: 'equip', index: li, label: el.line.slice(0, 60), text: text.slice(0, 400), phrase: equipPhrase(el).phrase, findings: [], infos: [] };
    const finding = (check, code, extra) => u.findings.push(Object.assign({ check, code }, extra || {}));
    try {
      // The site's ability for this line: same keyword, same words.
      const norm = (s) => stripReminder(s).toLowerCase().replace(/[.\s]+$/, '');
      const ab = siteAbilities.find(a => !used.has(a.index) && norm(a.fullText) === norm(el.line))
        || siteAbilities.find(a => !used.has(a.index) && (el.kind === 'equip' ? a.isEquip : el.kind === 'fortify' ? a.isFortify : a.isReconfigure) && norm(a.fullText).startsWith(norm(el.line).split(/\s*[{—]/)[0]));
      u.mixed = { source: false, group };
      if (!ab) { finding('check2', 'equip-not-detected', { line: el.line }); return; }
      used.add(ab.index);
      u.abilityIndex = ab.index;

      // Check 1: unattached, nothing changes.
      const noTarget = diffSummaries(ctx.beforeEquip, ctx.before);
      u.check1 = { noTarget: noTarget.map(c => ({ role: c.role, what: c.what })), perTarget: [] };
      if (!group && noTarget.length) finding('check1', 'changes-with-no-target', { changed: u.check1.noTarget });

      // Check 2: no other picker for it, and the list.
      const finalStates = Battlefield.getAllFinalStates();
      const isAura = /\bAura\b/.test(typeLine);
      const pk = getTargetPickerKind(perm.id, finalStates.get(perm.id));
      u.pickerKind = 'equip';
      if (!isAura && pk.kind !== 'none') finding('check2', 'single-picker-shown', { kind: pk.kind });
      const srcSt = finalStates.get(perm.id) || {};
      const isCreature = hasCI(srcSt.types, 'creature');
      const hasReconfigure = lines.some(l => l.kind === 'reconfigure');
      let r = null;
      try { r = getEquipCandidates(perm.id, ab.index); } catch (e) { finding('check2', 'crash', { error: errInfo('equip candidates', e) }); return; }
      if (isCreature && !hasReconfigure) {
        u.expectBlocked = true;
        if (!r.blocked) finding('check2', 'creature-equip-not-blocked', { listed: rolesOf(r.candidates.map(c => c.id)) });
        else u.blocked = r.blocked;
        return;
      }
      if (r.blocked) { u.blocked = r.blocked; finding('check2', 'blocked', { what: r.blocked }); return; }
      const siteIds = r.candidates.map(c => c.id);
      u.actual = rolesOf(siteIds);
      u.siteWords = r.targetWords;

      const ep = equipPhrase(el);
      const interp = interpretPhrase(ep.phrase, { before: '' });
      let expectedIds = null;
      if (interp.unknown) u.phraseUnknown = interp.unknown;
      else {
        expectedIds = [];
        const unjudged = [];
        for (const p of ctx.universe) {
          if (p.id === perm.id) continue;                 // CR 301.5c: not itself
          const st = ctx.preStates.get(p.id);
          if (!st || !interp.test(st, p, ctx) || (ep.extra && !ep.extra(st, p))) continue;
          if (keywordsOf(st).includes('shroud')) continue;
          const prot = auditProtectedFrom(st, srcSt);
          if (prot === null) { unjudged.push(p.id); continue; }
          if (prot) continue;
          expectedIds.push(p.id);
        }
        u.expected = rolesOf(expectedIds);
        const judged = (x) => !unjudged.includes(x);
        const missing = expectedIds.filter(x => !siteIds.includes(x)), extra = siteIds.filter(x => judged(x) && !expectedIds.includes(x));
        if (!siteIds.length && expectedIds.length) finding('check2', 'empty-list', { missing: rolesOf(missing), extra: [] });
        else if (missing.length || extra.length) finding('check2', 'list-mismatch', { missing: rolesOf(missing), extra: rolesOf(extra) });
      }

      // Check 1: attached to each listed permanent (or, with an empty list, each one the line allows).
      const tryIds = siteIds.length ? siteIds : (expectedIds || []);
      u.check1.via = siteIds.length ? 'picker' : 'text';
      const othersSeen = [], noOp = [], traitOnly = [];
      for (const tid of tryIds.slice(0, 16)) {
        let changed = [];
        try {
          withRestore(() => {
            Battlefield.applyEquipAttachment(perm.id, ab.index, tid);   // applyEquipModal
            Battlefield._invalidate();
            changed = diffSummaries(ctx.before, summarizeBoard());
          });
        } catch (e) { finding('check1', 'crash', { error: errInfo('equip', e) }); break; }
        const role = roleName(tid);
        u.check1.perTarget.push({ target: role, changed: changed.map(c => ({ role: c.role, what: c.what })) });
        const mine = changed.find(c => c.id === tid);
        if (!mine) noOp.push(role);
        else if (grant && /^traits \+(?:Equipped|Fortified)$/.test(mine.what)) {
          const st = ctx.preStates.get(tid);
          if (grant.pt || !(grant.kws || []).every(k => hasKeyword(st, k))) traitOnly.push(role);
        }
        // (The Equipment itself may change: a reconfigured one stops being a creature.)
        const others = group ? [] : changed.filter(c => c.id !== tid && c.id !== perm.id);
        if (others.length) othersSeen.push({ target: role, others: others.map(c => ({ role: c.role, what: c.what })) });
      }
      if (othersSeen.length) finding('check1', 'target-changes-others', { examples: othersSeen.slice(0, 3), count: othersSeen.length });
      if (noOp.length) finding('check1', 'attach-changes-nothing', { roles: noOp });
      if (traitOnly.length) finding('check1', 'grant-not-applied', { roles: traitOnly, what: grant.pt ? 'gets ' + grant.pt.join('/') : 'has ' + grant.kws.join(', ') });

      // CR 301.5c / 704.5p: made an artifact creature (as Bludgeon Brawl or March of the Machines
      // would), an Equipment without reconfigure can't equip.
      if (!hasReconfigure) {
        withRestore(() => {
          Battlefield.effects.push({
            id: perm.id + '_audit_animate', sourceId: perm.id, sourceName: perm.name, type: EFFECT_TYPE.ADD_TYPE, layer: '4',
            params: { types: ['Artifact', 'Creature'] }, scope: 'targeted', selfTarget: false, targetId: perm.id,
            timestamp: Battlefield.nextTimestamp++, ownerId: 'player_0', desc: 'Audit: this Equipment is an artifact creature.',
            _autoTargetSource: true, isSpellEffect: true,
          });
          Battlefield._invalidate();
          const st = Battlefield.getAllFinalStates().get(perm.id) || {};
          if (!hasCI(st.types, 'creature')) { u.infos.push('animate-did-not-apply'); return; }
          const r2 = getEquipCandidates(perm.id, ab.index);
          u.asCreature = r2.blocked ? 'blocked' : rolesOf(r2.candidates.map(c => c.id));
          if (!r2.blocked) finding('check2', 'creature-equip-not-blocked', { as: 'made an artifact creature', listed: u.asCreature });
        });
      }
    } catch (e) { u.findings.push({ check: 'check2', code: 'crash', error: errInfo('equip audit', e) }); }
    finally { Battlefield._invalidate(); rec.units.push(u); }
  });
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
    if (perm.isModalSpell) { auditModes(rec, perm, ctx, run, skip, text); return rec; }
    const cls = classifyUnitText(text);
    if (!cls.singular && !cls.targets) { skip('spell', undefined, '', text, cls.skip); return rec; }
    const u = newUnit('spell', undefined, '', text, cls);
    // Casting happened in addAuditedCard; the spell's own effects are the unit's.
    run(u, () => perm);
    return rec;
  }

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
      if (!cls.singular && !cls.targets) { skip(kind, ab.index, plan.label, text, cls.skip); continue; }
      const u = newUnit(kind, ab.index, plan.label, text, cls);
      // (Not written to the raw output.)
      Object.defineProperty(u, 'fullText', { value: stripReminder(ab.fullText || ''), enumerable: false });
      // "{2}{B}, Exile this card from your graveyard: … target creature" (CR 602.2, 601.2h): the
      // ability is used from the graveyard and the card is exiled as its cost, so it is never on
      // the battlefield to be a target.
      if (kind === 'activated' && /\bexile this (?:card|creature) from your graveyard\b/i.test(ab.costText || '')) u.excludeSource = true;
      // Likewise "{1}{R}, Discard this card: …" and "Reveal this card from your hand: …" (used from
      // the hand), and a trigger whose every event finds the card in the hand or gone from the
      // battlefield: "When you cycle this card", "When this creature dies", "When you cycle this
      // card and when this creature dies".
      if (kind === 'activated' && /\b(?:discard this|reveal this \w+ from your hand)\b/i.test(ab.costText || '')) u.excludeSource = true;
      if (kind === 'trigger' && offBattlefieldTrigger(ab.fullText)) u.excludeSource = true;
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
  /* An Aura's attach picker, on a board of its own (the last thing done with this face). */
  try { auditAttach(card, faceIndex, rec, face); }
  catch (e) { rec.errors.push(errInfo('attach', e)); }
  /* An Equipment's equip lists, on a board of their own. */
  try { auditEquip(card, faceIndex, rec, face); }
  catch (e) { rec.errors.push(errInfo('equip', e)); }
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
