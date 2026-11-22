/* What the site really uses for every subtype list, printed as JSON for tests/rules.py.

   Runs under jsc or Node like tests/harness.js (no DOM, no network). It does not read
   data.js as text: it loads the scripts and asks them, so a list that is right in data.js
   and replaced at startup, or not used by the engine, is still caught.

   Usage:  <engine> tests/rules.js -- <scripts.json> */
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
// The "choose a land type" box builds its options without the DOM.
load('ui-effect-inputs.js');
globalThis.escapeAttr = (s) => String(s);
globalThis.escapeHtml = (s) => String(s);

const VOCABULARY = ['creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'spell', 'battle'];
const list = (set) => [...(set || [])];
const byCategory = (obj) => {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = list(obj[k]);
  return out;
};

// "Every land type" and "all creature types" as the engine applies them, and the choices offered.
function inUse() {
  const gains = (param) => {
    const state = { types: ['Creature', 'Land'], subtypes: [], supertypes: [], abilities: [], colors: [], traits: [] };
    applyEffect(state, { type: EFFECT_TYPE.ADD_TYPE, layer: '4', params: { [param]: true } }, {});
    return state.subtypes;
  };
  const options = (text) => {
    const html = renderChosenLandTypeInput({ id: 'p', chosenLandType: '', originalOracleText: text });
    return (html.match(/value="[^"]+"/g) || []).map(v => v.slice(7, -1));
  };
  const vocabulary = {}, category = {};
  for (const k of VOCABULARY) vocabulary[k] = list(TypeCatalog[k + 'Types']);
  for (const k of VOCABULARY.concat(['planar', 'dungeon'])) category[k] = list(TypeCatalog.getSubtypeCategory(k));
  return {
    everyLandType: gains('gainsAllLandTypes'),
    everyCreatureType: gains('gainsAllCreatureTypes'),
    creatureChoices: TypeCatalog.creatureTypeChoices(),
    landChoices: options('Choose a land type.'),
    nonbasicLandChoices: options('Choose a nonbasic land type.'),
    vocabulary, category,
  };
}

const out = {
  cardTypes: list(TypeCatalog.cardTypes),
  supertypes: list(TypeCatalog.supertypes),
  noSubtypes: list(TypeCatalog.cardTypesWithoutSubtypes),
  typeToCategory: TypeCatalog._typeToCategory,
  official: Object.assign({ creature: list(TypeCatalog.officialCreatureTypes) }, byCategory(TypeCatalog.officialSubtypes)),
  unofficial: Object.assign({ creature: list(TypeCatalog.silverCreatureTypes) }, byCategory(TypeCatalog.unofficialSubtypes)),
  outlaws: list(OUTLAW_CREATURE_TYPES),
  basicLandMana: Object.keys(BASIC_LAND_MANA),
  landWords: [...new Set(Object.values(LAND_SUBTYPE_WORDS))],
  typesAsOf: TypeCatalog.typesAsOf,
  misread: [],
};

// Every official type survives being read: off a type line, and from rules text.
for (const [category, types] of Object.entries(out.official)) {
  if (category === 'planar' || category === 'dungeon') continue;
  for (const t of types) {
    const read = parseTypeLine('Creature — ' + t).subtypes;
    if (read.length !== 1 || read[0] !== t) out.misread.push(`${category[0].toUpperCase() + category.slice(1)} type "${t}" is read off a type line as "${read.join('", "')}"`);
    if (category === 'creature' && singularizeCreatureType(t.toLowerCase()) !== t) {
      out.misread.push(`Creature type "${t}" is read from rules text as "${singularizeCreatureType(t.toLowerCase())}"`);
    }
    if (category === 'land' && LAND_SUBTYPE_WORDS[t.toLowerCase()] !== t) out.misread.push(`Land type "${t}" is no land word to the parser`);
  }
}

/* The site at startup, three ways: before (or without) Scryfall; with a Scryfall catalog
   that lacks every official type and lists every unofficial one; with Scryfall unreachable. */
if (typeof console === 'undefined') globalThis.console = { log: print };
console.warn = () => {};   // init() warns when the stand-in fetch fails
out.offline = inUse();
const unofficial = out.unofficial;
globalThis.fetch = (url) => {
  const category = String(url).match(/catalog\/(\w+)-types/)[1];
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: (unofficial[category] || []).concat(['Previewedtype']) }) });
};
TypeCatalog.init().then(() => {
  out.wrongCatalog = inUse();
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  return TypeCatalog.init();
}).then(() => {
  out.failedFetch = inUse();
  print('@@RULES ' + JSON.stringify(out));
}).catch((e) => print('@@RULES ' + JSON.stringify({ error: String(e) + ' ' + ((e && e.stack) || '') })));
