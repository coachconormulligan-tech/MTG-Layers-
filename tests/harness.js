/* Headless regression harness for the Layer Inspector.
   Runs under macOS's built-in JavaScriptCore shell (jsc) or Node — no DOM, no network.
   Driven by tests/run.py; not loaded by index.html.

   Usage:  <engine> tests/harness.js -- <scripts.json> <fixture.json> [<fixture.json> ...]
   Output: one line per fixture, prefixed "@@RESULT ", holding { path, actual } or { path, error }.

   A fixture is { name, notes, board, expected } where `board` is Battlefield.serialize()
   output (the same JSON the site's Download button writes). The harness restores the
   board through the real add pipeline and emits a compact, wording-independent summary. */

/* ─── Engine shims (jsc has load/readFile/print; Node gets equivalents) ─── */
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

/* ─── Summary ─── */
// Permanent ids come from a counter that is never reset, so the same board gets
// different ids depending on what was restored before it. Anywhere an id appears in
// the summary it is swapped for "@Name" to keep fixtures independent of run order.
function _permRef(id) {
  const p = typeof id === 'string' && /^[a-z]+_/.test(id) ? Battlefield.getPermById(id) : null;
  return p ? '@' + p.name + (p.label ? ' ' + p.label : '') : id;
}

// JSON-safe copy: functions/Maps/Sets collapse to markers, undefined drops out.
function _plain(v) {
  if (typeof v === 'function') return '[fn]';
  if (typeof v === 'string') return _permRef(v);
  if (v instanceof Map) return { '[Map]': [...v.entries()].map(_plain) };
  if (v instanceof Set) return { '[Set]': [...v].map(_plain) };
  if (Array.isArray(v)) return v.map(_plain);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] !== undefined) o[_permRef(k)] = _plain(v[k]);
    }
    return o;
  }
  return v;
}

function _summarizeState(st) {
  const s = {
    name: st.name,
    controller: st.controller,
    supertypes: st.supertypes || [],
    types: st.types || [],
    subtypes: st.subtypes || [],
    power: st.power ?? null,
    toughness: st.toughness ?? null,
    colors: st.colors || [],
    abilities: st.abilities || [],
  };
  // Flags only recorded when set, so adding a new default-false flag to the engine
  // doesn't invalidate every fixture.
  for (const k of ['isAllCreatureTypes', 'isAllLandTypes', 'allAbilitiesRemoved', 'oracleTextModified']) {
    if (st[k]) s[k] = true;
  }
  if (st.counters && Object.keys(st.counters).length) s.counters = _plain(st.counters);
  if (st.traits && st.traits.length) s.traits = st.traits.slice();
  return s;
}

function summarizeBoard() {
  const finalStates = Battlefield.getAllFinalStates();
  const realPerms = Battlefield.permanents.filter(p => !p.isManualEffect)
    .slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const nameOf = (id) => {
    const p = Battlefield.getPermById(id);
    return p ? p.name + (p.label ? ' ' + p.label : '') : id;
  };

  const permanents = [];
  let order = null;
  for (const p of realPerms) {
    const st = finalStates.get(p.id);
    const entry = { perm: nameOf(p.id), final: st ? _summarizeState(st) : null, changedBy: {} };
    const ev = evaluatePermanent(p, Battlefield.permanents, Battlefield.effects, p.id);
    const thisOrder = {};
    for (const L of (ev && ev.layers) || []) {
      const log = L.applicationLog || [];
      if (!log.length) continue;
      thisOrder[L.id] = log.map(a => a.source);
      // Which sources actually changed THIS permanent in this layer, in application order.
      const changed = log.filter(a => a.changes && a.changes.length).map(a => a.source);
      if (changed.length) entry.changedBy[L.id] = changed;
    }
    // Application order per layer is global (same for every inspected permanent).
    if (!order) order = thisOrder;
    permanents.push(entry);
  }

  const effects = Battlefield.effects.map(e => {
    const o = {
      source: e.sourceName || nameOf(e.sourceId),
      layer: e.layer,
      type: e.type,
      scope: e.scope,
    };
    if (e.selfTarget) o.selfTarget = true;
    if (e.disabled) o.disabled = true;
    if (e.targetId) o.target = nameOf(e.targetId);
    if (e.targetIds && e.targetIds.length) o.targets = e.targetIds.map(t => t ? nameOf(t) : null);
    if (e.condition) o.condition = _plain(e.condition);
    o.params = _plain(e.params || {});
    return o;
  });

  return { permanents, order: order || {}, effects };
}

/* ─── Recipe builder ───
   A recipe builds a board from card names instead of a downloaded board:
     { "add": "Card Name", "as": "alias", "controller": "p2", "spell": true, "x": 3, "opts": {...} }
     { "call": ["anyBattlefieldMethod", arg, ...], "as": "alias" }
     { "fire": "@alias", "trigger": 1, "as": "alias", "vote": ["blue", "red"] }   (or "activated": 0)
   "fire" fires the ability at that index of the permanent's current ability list, taking the
   effect text from extractTriggeredAbilities / extractActivatedAbilities as the site's ability
   popup does — use it when the fix is in how an ability line is split into condition and effect.
   "vote" lists the option(s) that got the most votes, as picked in the site's vote pop-up.
   "as" on a call names what the method returns (the pseudo-permanent of a fired ability).
   In call args, "@alias" becomes that permanent's id, "p2" the second player's id, and
   "card:Card Name" the Scryfall card object. Players beyond the first need
   { "call": ["addPlayer", "Name"] } before they are referenced. */
function buildFromRecipe(recipe, cards) {
  Battlefield.clear();
  Battlefield.exile = [];
  Battlefield.nextExileId = 1;
  Battlefield.bestowTargets = new Map();
  const alias = {};
  const card = (name) => {
    if (!cards[name]) throw new Error('No card data for "' + name + '"');
    return JSON.parse(JSON.stringify(cards[name]));
  };
  const player = (ref) => {
    const pl = Battlefield.players[Number(ref.slice(1)) - 1];
    if (!pl) throw new Error('No such player: ' + ref);
    return pl.id;
  };
  const arg = (a) => {
    if (typeof a !== 'string') return a;
    if (a[0] === '@') {
      if (!alias[a.slice(1)]) throw new Error('Unknown alias: ' + a);
      return alias[a.slice(1)];
    }
    if (/^p\d+$/.test(a)) return player(a);
    if (a.startsWith('card:')) return card(a.slice(5));
    return a;
  };
  for (const step of recipe.steps || []) {
    if (step.add) {
      const who = player(step.controller || 'p1');
      Battlefield.activePlayerId = who;
      const opts = Object.assign({ suppressPrompt: true, controller: who, owner: who }, step.opts || {});
      if (step.x != null) opts.xValue = step.x;
      const perm = step.spell ? Battlefield.addSpell(card(step.add), opts) : Battlefield.addPermanent(card(step.add), opts);
      if (!perm || !perm.id) throw new Error('Adding "' + step.add + '" did not return a permanent');
      alias[step.as || step.add] = perm.id;
    } else if (step.copy) {
      // { "copy": ["@copier", "@target"] } — have a copy-card copy a permanent on the
      // battlefield, with the live link the site's copy picker sets (copy-of-a-copy follows it).
      const [copier, target] = step.copy.map(arg);
      const eff = Battlefield.effects.find(e => e.sourceId === copier && e.type === EFFECT_TYPE.COPY);
      const tp = Battlefield.getPermById(target);
      if (!eff || !tp) throw new Error('copy step: no COPY effect or no target');
      eff.params._copyTargetPermId = target;
      Battlefield.setCopySource(copier, JSON.parse(JSON.stringify(tp.scryfallData)));
    } else if (step.fire) {
      const id = arg(step.fire);
      const states = Battlefield.getAllFinalStates();
      const abilities = ((states.get(id) || {}).abilities || []).slice();
      const isTrigger = step.trigger != null;
      const index = isTrigger ? step.trigger : step.activated;
      const ab = (isTrigger ? Battlefield.extractTriggeredAbilities(abilities) : Battlefield.extractActivatedAbilities(abilities))
        .find(a => a.index === index);
      if (!ab) throw new Error('fire step: no ' + (isTrigger ? 'triggered' : 'activated') + ' ability at index ' + index + ' of ' + JSON.stringify(abilities));
      // "vote": the option(s) picked in the site's vote pop-up as having the most votes.
      const effectText = step.vote ? resolveVoteText(ab.effectText, step.vote) : ab.effectText;
      const ret = isTrigger
        ? Battlefield.addTriggeredAbility(id, ab.index, effectText, ab.fullText, states)
        : Battlefield.addActivatedAbility(id, ab.index, effectText, ab.fullText, states);
      if (step.as && ret && ret.id) alias[step.as] = ret.id;
    } else if (step.call) {
      const [method, ...rest] = step.call;
      if (typeof Battlefield[method] !== 'function') throw new Error('No Battlefield method: ' + method);
      const ret = Battlefield[method](...rest.map(arg));
      if (step.as && ret && ret.id) alias[step.as] = ret.id;
    } else {
      throw new Error('Unrecognised recipe step: ' + JSON.stringify(step));
    }
  }
  Battlefield.activePlayerId = Battlefield.players[0].id;
  return Battlefield.serialize();
}

/* ─── Main ─── */
(function main() {
  const scripts = JSON.parse(readFile(_args[0]));
  for (const f of scripts) load(f);
  // The site fills TypeCatalog from Scryfall at startup (TypeCatalog.init in ui-core.js) and
  // the parser relies on it. Load the saved copy so headless parsing matches the browser.
  const catalog = JSON.parse(readFile('tests/type-catalog.json'));
  for (const k of Object.keys(catalog)) {
    TypeCatalog[k] = new Set([...(TypeCatalog[k] || []), ...catalog[k]]);
  }
  TypeCatalog.loaded = true;
  // The page's X-value prompt has no headless equivalent; fail loudly if anything reaches it.
  globalThis.prompt = () => { throw new Error('prompt() called headlessly'); };
  let rest = _args.slice(1);
  const building = rest[0] === '--build';
  if (building) rest = rest.slice(1);
  for (const path of rest) {
    const out = { path };
    try {
      const fx = JSON.parse(readFile(path));
      let board = fx.board || fx;
      if (building) {
        // Round-trip through restore so the recorded result is what a later check will see.
        board = out.board = JSON.parse(JSON.stringify(buildFromRecipe(fx.recipe, fx.cards)));
      }
      if (!Battlefield.restore(board)) throw new Error('Battlefield.restore() rejected the board');
      out.actual = summarizeBoard();
    } catch (e) {
      out.error = String(e) + (e && e.stack ? '\n' + String(e.stack).split('\n').slice(0, 6).join('\n') : '');
    }
    print('@@RESULT ' + JSON.stringify(out));
  }
})();
