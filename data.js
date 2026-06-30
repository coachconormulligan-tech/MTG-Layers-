/* ============================================================
   MTG Layer Inspector — data.js
   Constants, layer definitions, effect templates, type catalog.
   [KEY: TYPE-CATALOG]  — Scryfall type/subtype/supertype catalogs
   [KEY: LAYERS]        — Layer enum and metadata
   [KEY: EFFECT-TYPES]  — Effect type constants
   [KEY: TEMPLATES]     — Manual effect templates
   [KEY: AURA-PARSE]    — Aura/targeted effect detection patterns
   ============================================================ */

/* [KEY: TYPE-CATALOG] — Canonical type classifications from Scryfall.
   Fetched at boot; fallback to hardcoded sets if offline.
   Must be defined before engine.js (which uses it in SET_TYPE). */
const TypeCatalog = {
  supertypes: new Set(['Basic', 'Legendary', 'Snow', 'World', 'Ongoing']),
  cardTypes: new Set(['Artifact', 'Battle', 'Conspiracy', 'Creature', 'Dungeon',
    'Enchantment', 'Instant', 'Land', 'Phenomenon', 'Plane', 'Planeswalker',
    'Scheme', 'Sorcery', 'Tribal', 'Vanguard']),
  landTypes: new Set(['Cave', 'Cloud', 'Desert', 'Forest', 'Gate', 'Island',
    'Lair', 'Locus', 'Mine', 'Mountain', 'Sphere', 'Plains', 'Planet',
    'Power-Plant', 'Swamp', 'Tower', 'Town', "Urza's"]),
  creatureTypes: new Set(),
  artifactTypes: new Set(),
  enchantmentTypes: new Set(),
  planeswalkerTypes: new Set(),
  spellTypes: new Set(),
  battleTypes: new Set(),
  loaded: false,

  async init() {
    try {
      const endpoints = [
        ['landTypes',        'https://api.scryfall.com/catalog/land-types'],
        ['creatureTypes',    'https://api.scryfall.com/catalog/creature-types'],
        ['artifactTypes',    'https://api.scryfall.com/catalog/artifact-types'],
        ['enchantmentTypes', 'https://api.scryfall.com/catalog/enchantment-types'],
        ['planeswalkerTypes','https://api.scryfall.com/catalog/planeswalker-types'],
        ['spellTypes',       'https://api.scryfall.com/catalog/spell-types'],
        ['battleTypes',      'https://api.scryfall.com/catalog/battle-types'],
      ];
      const responses = await Promise.all(endpoints.map(([, url]) => fetch(url)));
      for (let i = 0; i < endpoints.length; i++) {
        const [key] = endpoints[i];
        if (responses[i].ok) {
          const data = await responses[i].json();
          this[key] = new Set(data.data || []);
        }
      }
      this.loaded = true;
    } catch (e) {
      console.warn('TypeCatalog: Scryfall fetch failed, using fallback data.', e);
    }
  },

  // Map from card type name to the subtype category key
  _typeToCategory: {
    'Land': 'land', 'Creature': 'creature', 'Artifact': 'artifact',
    'Enchantment': 'enchantment', 'Planeswalker': 'planeswalker',
    'Instant': 'spell', 'Sorcery': 'spell', 'Battle': 'battle',
  },

  getSubtypeCategory(category) {
    switch (category) {
      case 'land':         return this.landTypes;
      case 'creature':     return this.creatureTypes;
      case 'artifact':     return this.artifactTypes;
      case 'enchantment':  return this.enchantmentTypes;
      case 'planeswalker': return this.planeswalkerTypes;
      case 'spell':        return this.spellTypes;
      case 'battle':       return this.battleTypes;
      default:             return new Set();
    }
  },

  getSubtypesForCardType(cardType) {
    const cat = this._typeToCategory[cardType];
    return cat ? this.getSubtypeCategory(cat) : new Set();
  },

  classifySubtype(subtype) {
    if (this.landTypes.has(subtype)) return 'land';
    if (this.creatureTypes.has(subtype)) return 'creature';
    if (this.artifactTypes.has(subtype)) return 'artifact';
    if (this.enchantmentTypes.has(subtype)) return 'enchantment';
    if (this.planeswalkerTypes.has(subtype)) return 'planeswalker';
    if (this.spellTypes.has(subtype)) return 'spell';
    if (this.battleTypes.has(subtype)) return 'battle';
    return 'unknown';
  },

  isSupertype(word) { return this.supertypes.has(word); },
  isCardType(word) { return this.cardTypes.has(word); },
};
/* [END: TYPE-CATALOG] */

/* [KEY: TEXT-CHANGE-WORDS] — Words that text-changing effects can target */
const COLOR_WORDS = ['white', 'blue', 'black', 'red', 'green'];
const BASIC_LAND_TYPE_WORDS = ['plains', 'island', 'swamp', 'mountain', 'forest'];

/* Text-change category constants for changeType param */
const TEXT_CHANGE_TYPES = {
  COLOR_OR_LAND: 'color_or_land',
  LAND_ONLY: 'land_only',
  COLOR_ONLY: 'color_only',
  CREATURE_TYPE: 'creature_type',
  COLOR_GLOBAL: 'color_global',
  EXCHANGE_TEXT: 'exchange_text',
  VOLRATH_TEXT: 'volrath_text',
};
/* [END: TEXT-CHANGE-WORDS] */

/* [KEY: LAYERS] */
const LAYERS = [
  { id: '1',  name: 'Copy/Mutate Effects',    cr: '613.1a', active: true  },
  { id: '2',  name: 'Control',         cr: '613.1b', active: true  },
  { id: '3',  name: 'Text',            cr: '613.1c', active: true  },
  { id: '4',  name: 'Type',            cr: '613.1d', active: true  },
  { id: '5',  name: 'Color',           cr: '613.1e', active: true  },
  { id: '6',  name: 'Abilities',       cr: '613.1f', active: true  },
  { id: '7a', name: 'P/T CDAs',        cr: '613.4a', active: true  },
  { id: '7b', name: 'P/T Set',         cr: '613.4b', active: true  },
  { id: '7c', name: 'P/T Modify',      cr: '613.4c', active: true  },
  { id: '7d', name: 'P/T Switch',      cr: '613.4d', active: true  },
];

const LAYER_MAP = Object.fromEntries(LAYERS.map(l => [l.id, l]));
/* [END: LAYERS] */

/* [KEY: EFFECT-TYPES] */
const EFFECT_TYPE = {
  ADD_TYPE:       'add_type',
  REMOVE_TYPE:    'remove_type',
  SET_TYPE:       'set_types',
  ADD_ABILITY:    'add_ability',
  REMOVE_ABILITIES: 'remove_abilities',
  SET_PT:         'set_pt',          // Layer 7b
  MODIFY_PT:      'modify_pt',       // Layer 7c
  ADD_COUNTERS:   'add_counters',    // Layer 7c (CR 613.4c — counters apply with other P/T modifications)
  SET_COLOR:      'set_color',       // Layer 5
  ADD_COLOR:      'add_color',
  COPY:           'copy',            // Layer 1 — replace state with copy source
  CONTROL:        'control',         // Layer 2 — stub
  TEXT_CHANGE:    'text_change',     // Layer 3 — word replacement in oracle text
  CDA_PT:         'cda_pt',          // Layer 7a — P/T from CDA (computed or user-set)
  SWITCH_PT:      'switch_pt',       // Layer 7d — swap P and T
  KEYWORD_COUNTER: 'keyword_counter', // Layer 6 2014 keyword counters grant abilities
  SET_NAME:       'set_name',        // Layer 3 (text-changing) 2014 rename (e.g. Witness Protection)
  GAIN_ACTIVATED_FROM_OTHERS: 'gain_activated_from_others', // Layer 6 — gain activated abilities from other permanents
  GAIN_ACTIVATED_FROM_GRAVEYARDS: 'gain_activated_from_graveyards', // Layer 6 — gain activated abilities from creature cards in graveyards
  GAIN_ACTIVATED_FROM_EXILE: 'gain_activated_from_exile', // Layer 6 — gain activated abilities from cards in exile
  IMPRINT_PROTECTION_FROM_TYPES: 'imprint_protection_from_types', // Layer 6 — Mirror Golem: protection from each of the imprinted card's card types
};
/* [END: EFFECT-TYPES] */



/* [KEY: KNOWN-ABILITIES] — Known ability patterns for effects too unique for generic parsing.
   Maps normalized ability text (lowercase, after self-ref replacement + reminder text stripping)
   to arrays of effects they generate. Matched per-ability-line, not per-card-name.
   This means any card that gains one of these abilities (via copy, text exchange, etc.)
   will automatically get the correct effects.
   `scope: 'targeted'` — only applies to attached/selected permanent.
   `scope: 'global'`   — applies to all matching permanents.
   `affectsSelf: true`  — "all" / "each" wording → source card included.
   `affectsSelf: false` — "other" / "each other" → source card excluded. */
const KNOWN_ABILITY_EFFECTS = {

  /* === Text-Changing Effects (Layer 3) ===
     These use TEXT_CHANGE type. The UI prompts for target and replacement words.
     params.changeType: 'color_or_land' | 'land_only' | 'color_only' — controls which words are editable.
     params.replacements: [{from, to}] — filled by UI at add-time. */

  /* Color OR land type text change on permanent — targeted
     (Mind Bend) */
  'change the text of target permanent by replacing all instances of one color word with another or one basic land type with another.': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'color_or_land', replacements: [] },
      appliesTo: null, scope: 'targeted',
      desc: 'Change one color word or basic land type word in target permanent\'s text to another.' },
  ],
  /* Same but "until end of turn" variant (Trait Doctoring, Whim of Volrath) */
  'change the text of target permanent by replacing all instances of one color word with another or one basic land type with another until end of turn.': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'color_or_land', replacements: [] },
      appliesTo: null, scope: 'targeted',
      desc: 'Change one color word or basic land type word in target permanent\'s text to another.' },
  ],

  /* Land-only text change on spell/permanent — targeted (Magical Hack) */
  'change the text of target spell or permanent by replacing all instances of one basic land type with another.': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'land_only', replacements: [] },
      appliesTo: null, scope: 'targeted',
      desc: 'Change one basic land type word in target spell or permanent\'s text to another.' },
  ],

  /* Color-only text change on spell/permanent — targeted
     (Sleight of Mind, Alter Reality, Glamerdye) */
  'change the text of target spell or permanent by replacing all instances of one color word with another.': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'color_only', replacements: [] },
      appliesTo: null, scope: 'targeted',
      desc: 'Change one color word in target spell or permanent\'s text to another.' },
  ],

  /* Color or land text change on spell/permanent — targeted (Crystal Spray) */
  'change the text of target spell or permanent by replacing all instances of one color word with another or one basic land type with another until end of turn.': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'color_or_land', replacements: [] },
      appliesTo: null, scope: 'targeted',
      desc: 'Change one color word or basic land type word in target spell or permanent\'s text to another.' },
  ],

  /* Tidal Visionary — activated ability color change */
  '{t}: target creature becomes the color of your choice until end of turn.': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'color_only', replacements: [] },
      appliesTo: null, scope: 'targeted',
      desc: 'Change one color word in target permanent\'s text to another.' },
  ],

  /* === Special text-change abilities === */

  /* Swirl the Mists: global color word replacement */
  /* ETB instruction — no effect object, just marks the line as handled so the early return fires */
  'as this enchantment enters, choose a color word.': [],
  'all instances of color words in the text of spells and permanents are changed to the chosen color word.': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'color_global', replacements: [], chosenColor: null },
      appliesTo: (p) => true, scope: 'global', affectsSelf: false,
      appliesToSpells: true, appliesToPermanents: true,
      desc: 'All color words in the text of spells and permanents are changed to the chosen color.' },
  ],

  /* Deadpool, Trading Card: exchange text box on ETB */
  'as this card enters, you may exchange his text box and another creature\'s.': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'exchange_text', exchangeTargetId: null },
      appliesTo: null, scope: 'targeted',
      desc: 'Exchange this card\'s text box with target creature\'s text box.' },
  ],

  /* New Blood: creature type text change to Vampire */
  'gain control of target creature. change the text of that creature by replacing all instances of one creature type with vampire.': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'creature_type', replacements: [], toType: 'Vampire',
                targetRestriction: (p) => p.types.includes('Creature') },
      appliesTo: null, scope: 'targeted',
      desc: 'Change all instances of a chosen creature type in target creature\'s text to Vampire.' },
  ],

  /* Exchange of Words: handled entirely via triggered ability pseudo-permanent.
     No static effect is created when Exchange of Words enters — the exchange_text
     effect is injected onto the TRIGGER pseudo-permanent when the ETB ability fires.
     (See fireTriggeredAbility in ui.js.) */

  /* Volrath's Shapeshifter: gets characteristics of top creature card of graveyard */
  'as long as the top card of your graveyard is a creature card, this creature has the full text of that card and has the text "{2}: discard a card."': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'volrath_text', graveyardCard: null },
      appliesTo: null, scope: 'targeted', selfTarget: true,
      _sourceAbilityText: 'as long as the top card of your graveyard is a creature card',
      desc: 'This creature has the full text, name, mana cost, color, types, P/T of the top creature card of your graveyard (and adds its own abilities).' },
  ],

  /* Balduvian Shaman: color text change on white enchantment + grants cumulative upkeep */
  '{t}: change the text of target white enchantment you control that doesn\'t have cumulative upkeep by replacing all instances of one color word with another. that enchantment gains "cumulative upkeep {1}."': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'color_only', replacements: [],
                targetRestriction: (p) => p.types.includes('Enchantment') && p.colors.includes('W') && !p.oracleText.toLowerCase().includes('cumulative upkeep') },
      appliesTo: null, scope: 'targeted',
      desc: 'Change one color word in target white enchantment\'s text to another. (Must not have cumulative upkeep.)' },
    { layer: '6', type: EFFECT_TYPE.ADD_ABILITY,
      params: { ability: 'Cumulative upkeep {1}' },
      appliesTo: null, scope: 'targeted',
      desc: 'That enchantment gains "Cumulative upkeep {1}".' },
  ],

  /* Artificial Evolution: creature type text change */
  'change the text of target spell or permanent by replacing all instances of one creature type with another. the new creature type can\'t be wall.': [
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'creature_type', replacements: [], excludeTypes: ['Wall'] },
      appliesTo: null, scope: 'targeted',
      desc: 'Change one creature type word in target spell or permanent\'s text to another. (Wall cannot be chosen.)' },
  ],

  /* === Equipment / Trait Effects === */

  /* Spy Kit: grants "has all card names" trait */
  'equipped creature gets +1/+1 and has all names of nonlegendary creature cards in addition to its name.': [
    { layer: '3', type: EFFECT_TYPE.ADD_ABILITY,
      params: { ability: 'Has all card names', isTrait: true },
      appliesTo: null, scope: 'targeted',
      desc: 'Equipped creature has all card names in addition to its own. (Layer 3 trait.)' },
  ],

  /* === Ability-Granting Effects (Layer 6) === */

  /* Marvin, Murderous Mimic: gains all activated abilities of other creatures
     that don't share a name with this card. Self-targeted Layer 6 effect. */
  'this card has all activated abilities of creatures you control that don\'t have the same name as this creature.': [
    { layer: '6', type: EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS,
      params: { requireType: 'Creature', sameController: true, differentName: true },
      appliesTo: null, scope: 'targeted', selfTarget: true,
      desc: 'This creature has all activated abilities of each other permanent that doesn\'t share a name with it.' },
  ],

  /* Necrotic Ooze: gains all activated abilities of all creature cards in all graveyards.
     Two keys: raw oracle text form and the form after "as long as … , it" normalization. */
  'as long as this creature is on the battlefield, it has all activated abilities of all creature cards in all graveyards.': [
    { layer: '6', type: EFFECT_TYPE.GAIN_ACTIVATED_FROM_GRAVEYARDS,
      params: {},
      appliesTo: null, scope: 'targeted', selfTarget: true,
      desc: 'This creature has all activated abilities of all creature cards in all graveyards.' },
  ],
  'this card has all activated abilities of all creature cards in all graveyards.': [
    { layer: '6', type: EFFECT_TYPE.GAIN_ACTIVATED_FROM_GRAVEYARDS,
      params: {},
      appliesTo: null, scope: 'targeted', selfTarget: true,
      desc: 'This creature has all activated abilities of all creature cards in all graveyards.' },
  ],

  /* === Control-Changing Effects (Layer 2) ===
     params.newController is set at parse time to the permanent's owner. */

  'you control enchanted creature.': [
    { layer: '2', type: EFFECT_TYPE.CONTROL,
      params: { newController: null, useSourceController: true },
      appliesTo: null, scope: 'targeted',
      desc: 'You control enchanted creature.' },
  ],

  'you control enchanted permanent.': [
    { layer: '2', type: EFFECT_TYPE.CONTROL,
      params: { newController: null, useSourceController: true },
      appliesTo: null, scope: 'targeted',
      desc: 'You control enchanted permanent.' },
  ],

  'you control enchanted artifact.': [
    { layer: '2', type: EFFECT_TYPE.CONTROL,
      params: { newController: null, useSourceController: true },
      appliesTo: null, scope: 'targeted',
      desc: 'You control enchanted artifact.' },
  ],

};
/* [END: KNOWN-ABILITIES] */
