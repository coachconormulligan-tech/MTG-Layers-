/* A type nobody has heard of must work from its card alone, with no refresh of the project's
   data (Conor, 2026-11-22: "when a new creature type is added, the website just figures that
   out", and the same for the subtypes of all card types; a new card type is out of scope): a
   creature type and a subtype of every other card type. A preview is read at once and official
   only once legal.
   tests/rules.py runs this on every full tests/run.py.

   Each invented type has a shape that has broken the parser before. It is learned only as
   the site learns it, from a card being added, and then read in the common templates.

   Usage:  <engine> tests/newtypes.js -- <scripts.json> */
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
for (const f of JSON.parse(readFile(_args[0]))) load(f);

const INVENTED = [
  ['Zorblin', 'Zorblins'], ['Quarl-Vex', 'Quarl-Vexes'], ["Zor'Thal", "Zor'Thals"], ['McGorn', 'McGorns'],
  ['Moon Walker', 'Moon Walkers'], ['Lost Star Child', 'Lost Star Children'], ['Z', 'Zs'], ['Zö', 'Zös'],
  ['Glaxy', 'Glaxies'], ['Skelf', 'Skelves'], ['Vorpus', 'Vorpi'], ['Xandes', 'Xandes'], ['Mirefolk', 'Mirefolk'],
  ['Marshman', 'Marshmen'], ['Ship', 'Ships'],
];
const card = (name, typeLine, text) => ({
  name, type_line: typeLine, oracle_text: text || '', layout: 'normal', set_type: 'expansion', border_color: 'black',
  released_at: '2030-01-01', legalities: { vintage: 'legal', commander: 'legal' },
  colors: [], cmc: 2, mana_cost: '{2}', power: '2', toughness: '2',
});
// Scryfall lists a type in its creature catalog when it lists the first card with it.
TypeCatalog.scryfallCatalogs = { creature: [...TypeCatalog.officialCreatureTypes, ...INVENTED.map(x => x[0])] };

const problems = [], opts = { suppressPrompt: true };
const stateOf = (perm) => {
  Battlefield._invalidate();
  return Battlefield.getAllFinalStates().get(perm.id);
};
for (const [type, plural] of INVENTED) {
  const fail = (what) => problems.push(`A new creature type like "${type}" is not figured out: ${what}`);
  const a = /^[AEIOU]/.test(type) ? 'an' : 'a';
  try {
    Battlefield.clear();
    const changeling = Battlefield.addPermanent(card('Test Changeling', 'Creature — Shapeshifter', 'Changeling'), opts);
    const one = Battlefield.addPermanent(card('Test Witness', `Creature — ${type}`), opts);   // it is learned here
    const other = Battlefield.addPermanent(card('Test Bystander', 'Creature — Bear'), opts);
    if (stateOf(one).subtypes.join('|') !== type) fail('its own type line');
    if (!stateOf(changeling).subtypes.includes(type)) fail('a changeling does not have it');
    if (!TypeCatalog.creatureTypeChoices().includes(type)) fail('it cannot be chosen');

    const lord = Battlefield.addPermanent(card('Test Captain', 'Creature — Human', `Other ${plural} you control get +1/+1.`), opts);
    if (stateOf(one).power !== 3 || stateOf(other).power !== 2) fail('"Other <plural> you control get +1/+1"');
    Battlefield.removePermanent(lord.id);

    const word = Battlefield.addPermanent(card('Test Banner', 'Enchantment', `${type} creatures you control have flying.`), opts);
    if (!(stateOf(one).abilities || []).some(x => /^flying$/i.test(x))) fail('"<type> creatures you control have"');
    Battlefield.removePermanent(word.id);

    // The witness and the changeling.
    const count = Battlefield.addPermanent(card('Test Reckoner', 'Creature — Human', `This creature gets +1/+0 for each ${type} you control.`), opts);
    if (stateOf(count).power !== 4) fail('"for each <type> you control"');
    Battlefield.removePermanent(count.id);

    const when = Battlefield.addPermanent(card('Test Sentry', 'Creature — Human', `As long as you control ${a} ${type}, this creature gets +3/+0.`), opts);
    if (stateOf(when).power !== 5) fail('"as long as you control a <type>"');
    Battlefield.removePermanent(when.id);

    const spell = Battlefield.addSpell(card('Test Rally', 'Instant', `Target ${type} gets +2/+2 until end of turn.`), opts);
    const listed = (getTargetCandidates(spell.id, { kind: 'single' }).candidates || []).map(c => c.perm.name).sort().join('|');
    if (listed !== 'Test Changeling|Test Witness') fail('"target <type>"');
    Battlefield.removePermanent(spell.id);

    const becomes = Battlefield.addPermanent(card('Test Mold', 'Creature — Human', `This creature is ${a} ${type} in addition to its other types.`), opts);
    if (!stateOf(becomes).subtypes.includes(type)) fail('"is a <type> in addition to its other types"');
  } catch (e) {
    fail(String(e));
  }
}

const preview = (c) => Object.assign(c, { released_at: '2099-01-01', legalities: { vintage: 'not_legal', commander: 'not_legal' } });
const hasAbility = (perm, word) => (stateOf(perm).abilities || []).some(x => x.toLowerCase() === word);
const targets = (text) => {
  const spell = Battlefield.addSpell(card('Test Order', 'Instant', text), opts);
  const names = (getTargetCandidates(spell.id, { kind: 'single' }).candidates || []).map(c => c.perm.name).sort().join('|');
  Battlefield.removePermanent(spell.id);
  return names;
};
const aThing = (word) => (/^[aeiou]/i.test(word) ? 'an ' : 'a ') + word;

// What every kind of permanent's type is tried in. `one` and `many` are the type as a text writes it.
function inText(fail, one, many, typeLine) {
  const witness = Battlefield.addPermanent(card('Test Witness', typeLine), opts);      // it is learned here
  const other = Battlefield.addPermanent(card('Test Bystander', 'Creature — Bear'), opts);

  const lord = Battlefield.addPermanent(card('Test Banner', 'Artifact', `${many[0].toUpperCase() + many.slice(1)} you control have hexproof.`), opts);
  if (!hasAbility(witness, 'hexproof') || hasAbility(other, 'hexproof')) fail('"<plural> you control have"');
  Battlefield.removePermanent(lord.id);

  const count = Battlefield.addPermanent(card('Test Reckoner', 'Creature — Human', `This creature gets +1/+0 for each ${one} you control.`), opts);
  if (stateOf(count).power !== 3) fail('"for each <type> you control"');
  Battlefield.removePermanent(count.id);

  const when = Battlefield.addPermanent(card('Test Sentry', 'Creature — Human', `As long as you control ${aThing(one)}, this creature gets +3/+0.`), opts);
  if (stateOf(when).power !== 5) fail('"as long as you control a <type>"');
  Battlefield.removePermanent(when.id);

  if (targets(`Target ${one} gains indestructible until end of turn.`) !== 'Test Witness') fail('"target <type>"');
  return { witness, other };
}

const SUBTYPES = [
  ['artifact', 'Artifact', 'Gizmo', 'Gizmos'], ['artifact', 'Artifact', 'Relicry', 'Relicries'], ['artifact', 'Artifact', "Za'Vox", "Za'Voxes"],
  ['enchantment', 'Enchantment', 'Rite-Song', 'Rite-Songs'], ['enchantment', 'Enchantment', 'Motif', 'Motives'],
  ['land', 'Land', 'Harbor', 'Harbors'], ['land', 'Land', 'Wharf', 'Wharves'], ['land', 'Land', 'Estuary', 'Estuaries'],
  ['planeswalker', 'Legendary Planeswalker', "Kro'Nax", "Kro'Naxes"],
  ['battle', 'Battle', 'Skirmish', 'Skirmishes'], ['spell', 'Sorcery', 'Cantrip', 'Cantrips'],
];
for (const [kind, host, type, plural] of SUBTYPES) {
  const fail = (what) => problems.push(`A new ${kind} type like "${type}" is not figured out: ${what}`);
  try {
    Battlefield.clear();
    if (kind === 'spell') {
      const spell = Battlefield.addSpell(card('Test Witness', `${host} — ${type}`, 'Draw a card.'), opts);
      if (!(spell.printedSubtypes || []).includes(type)) fail('its own type line');
    } else {
      const { witness } = inText(fail, type, plural, `${host} — ${type}`);
      if (!stateOf(witness).subtypes.includes(type)) fail('its own type line');
    }
    if (!TypeCatalog.officialList(kind).has(type)) fail('it is not official though its card is legal');
    if (!TypeCatalog.getSubtypeCategory(kind).has(type)) fail('it is not lost with its card type');
    const early = 'Early' + type.replace(/\W/g, '').toLowerCase();
    learnTypesFromCard(preview(card('Test Preview', `${host} — ${early}`)));
    if (!TypeCatalog[kind + 'Types'].has(early)) fail('a preview of one is not read');
    if (TypeCatalog.officialList(kind).has(early)) fail('a preview of one is official before it is legal');
  } catch (e) {
    fail(String(e));
  }
}
try {
  Battlefield.clear();
  const all = { types: ['Land'], subtypes: [], supertypes: [], abilities: [], colors: [], traits: [] };
  applyEffect(all, { type: EFFECT_TYPE.ADD_TYPE, layer: '4', params: { gainsAllLandTypes: true } }, {});
  if (!all.subtypes.includes('Harbor') || all.subtypes.includes('Earlyharbor')) problems.push('"Every land type" does not follow the land types that are learned');
} catch (e) {
  problems.push('"Every land type": ' + e);
}

print('@@NEWTYPES ' + JSON.stringify(problems));
