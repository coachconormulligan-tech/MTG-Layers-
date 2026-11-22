/* ============================================================
   MTG Layer Inspector — data.js
   Constants, layer definitions, effect templates, type catalog.
   [KEY: TYPE-CATALOG]  — Scryfall type/subtype/supertype catalogs
   [KEY: LAYERS]        — Layer enum and metadata
   [KEY: EFFECT-TYPES]  — Effect type constants
   [KEY: TEMPLATES]     — Manual effect templates
   [KEY: AURA-PARSE]    — Aura/targeted effect detection patterns
   ============================================================ */

/* [KEY: TYPE-CATALOG] — Card types, supertypes and subtypes: CR 205, written out below
   (RULES-LISTS), plus what Scryfall's catalogs add for the parser when they arrive.
   Must be defined before engine.js (which uses it in SET_TYPE). */
const TypeCatalog = {
  supertypes: new Set(['Basic', 'Legendary', 'Snow', 'World', 'Ongoing']),
  cardTypes: new Set(['Artifact', 'Battle', 'Conspiracy', 'Creature', 'Dungeon',
    'Enchantment', 'Instant', 'Kindred', 'Land', 'Phenomenon', 'Plane', 'Planeswalker',
    'Scheme', 'Sorcery', 'Vanguard']),
  // The parser's vocabulary: CR 205.3's lists (filled in below the object) and, once Scryfall
  // has answered, the types it knows of that the rules do not have yet (previewed cards).
  // Not what "every land type" or "all creature types" gives: officialSubtypes, everyCreatureType().
  landTypes: new Set(),
  creatureTypes: new Set(),
  artifactTypes: new Set(),
  enchantmentTypes: new Set(),
  planeswalkerTypes: new Set(),
  spellTypes: new Set(),
  battleTypes: new Set(),
  loaded: false,

  /* Fetches every catalog from Scryfall. Resolves true only when all of them arrived
     and populated; false when the network is unreachable, a response was not OK / not
     JSON, or a catalog came back empty. DOM-free — the caller (ui-core.js) surfaces a
     failure to the player. The rules' lists stand whether or not it answers; `loaded` says
     the lists are filled, which is what the parser gates on. */
  async init() {
    const endpoints = [
      ['landTypes',        'https://api.scryfall.com/catalog/land-types'],
      ['creatureTypes',    'https://api.scryfall.com/catalog/creature-types'],
      ['artifactTypes',    'https://api.scryfall.com/catalog/artifact-types'],
      ['enchantmentTypes', 'https://api.scryfall.com/catalog/enchantment-types'],
      ['planeswalkerTypes','https://api.scryfall.com/catalog/planeswalker-types'],
      ['spellTypes',       'https://api.scryfall.com/catalog/spell-types'],
      ['battleTypes',      'https://api.scryfall.com/catalog/battle-types'],
    ];
    let complete = true;
    await Promise.all(endpoints.map(async ([key, url]) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data || !Array.isArray(data.data)) throw new Error('Malformed catalog');
        if (!data.data.length) throw new Error('Empty catalog');
        this.scryfallCatalogs[key.slice(0, -'Types'.length)] = data.data;   // as sent, for updateTypesFromScryfall
        // Scryfall's catalogs are not the rules' lists: they have types CR 205.3 has not, and
        // can lack ones it has (Lander, Mutagen). An official type is never lost to them, and
        // only creature types keep the unofficial ones (Naga is still printed on tokens).
        const kind = key.slice(0, -'Types'.length);
        const extra = kind === 'creature' ? data.data
          : data.data.filter(t => !this.unofficialSubtypes[kind].has(t));
        this[key] = new Set([...this.officialList(kind), ...extra]);
      } catch (e) {
        complete = false;
        console.warn('TypeCatalog: Scryfall fetch failed for ' + key + ', using the rules\' lists.', e);
      }
    }));
    this.loaded = this.creatureTypes.size > 0;
    return complete && this.loaded;
  },

  // Map from card type name to the subtype category key
  // (Tribal is Kindred's old name, still on boards saved with it.)
  _typeToCategory: {
    'Land': 'land', 'Creature': 'creature', 'Kindred': 'creature', 'Tribal': 'creature',
    'Artifact': 'artifact', 'Enchantment': 'enchantment', 'Planeswalker': 'planeswalker',
    'Instant': 'spell', 'Sorcery': 'spell', 'Battle': 'battle',
    'Plane': 'planar', 'Dungeon': 'dungeon',
  },

  /* [KEY: RULES-LISTS] — every subtype list of CR 205.3, WRITTEN FROM SCRYFALL'S DATA by
     `python3 tests/run.py --catalog` (tests/subtypes.py, cards-types.js says how): do not
     edit them by hand. Between refreshes the site adds new types itself at startup
     (updateTypesFromScryfall). No other file may keep a copy of a subtype list. */

  // The day of the Scryfall card file the lists were written from.
  typesAsOf: '2026-11-20',

  /* The official subtypes of every card type but creature and kindred (theirs follow). What
     "every land type" gives and "choose a land type" offers, and the parser's vocabulary. */
  officialSubtypes: {
    // CR 205.3g
    artifact: new Set([
      "Attraction", "Blood", "Bobblehead", "Book", "Clue", "Communicator", "Contraption",
      "Equipment", "Food", "Fortification", "Gold", "Heartwood", "Incubator", "Infinity", "Junk",
      "Lander", "Map", "Mutagen", "Powerstone", "Spacecraft", "Stone", "Treasure", "Vehicle",
      "Vibranium"
    ]),
    // CR 205.3h
    enchantment: new Set([
      "Aura", "Background", "Cartouche", "Case", "Class", "Curse", "Plan", "Role", "Room", "Rune",
      "Saga", "Shard", "Shrine"
    ]),
    // CR 205.3i
    land: new Set([
      "Cave", "Desert", "Forest", "Gate", "Island", "Lair", "Locus", "Mine", "Mountain", "Plains",
      "Planet", "Power-Plant", "Sphere", "Swamp", "Tower", "Town", "Urza's"
    ]),
    // CR 205.3j
    planeswalker: new Set([
      "Ajani", "Aminatou", "Angrath", "Arlinn", "Arzakon", "Ashiok", "Bahamut", "Basri", "Bolas",
      "Calix", "Chandra", "Comet", "Dack", "Dakkon", "Daretti", "Davriel", "Dellian", "Dihada",
      "Domri", "Dovin", "Dyfed", "Ellywick", "Elminster", "Elspeth", "Estrid", "Feroz",
      "Freyalise", "Garruk", "Gideon", "Greensleeves", "Grist", "Guff", "Huatli", "Jace", "Jared",
      "Jaya", "Jeska", "Kaito", "Karn", "Kasmina", "Kaya", "Kiora", "Koth", "Liliana", "Lolth",
      "Lukka", "Minsc", "Mordenkainen", "Nahiri", "Narset", "Niko", "Nissa", "Nixilis", "Oko",
      "Quintorius", "Ral", "Rowan", "Saheeli", "Samut", "Sarkhan", "Serra", "Sifa", "Sivitri",
      "Sorin", "Szat", "Tamiyo", "Tasha", "Teferi", "Teyo", "Tezzeret", "Thomil", "Tibalt",
      "Tyvar", "Ugin", "Urza", "Venser", "Vivien", "Vraska", "Vronos", "Will", "Windgrace",
      "Worzel", "Wrenn", "Xenagos", "Yanggu", "Yanling", "Zariel"
    ]),
    // CR 205.3k
    spell: new Set([
      "Adventure", "Arcane", "Lesson", "Omen", "Trap"
    ]),
    // CR 205.3n
    planar: new Set([
      "Alara", "Alfava Metraxis", "Amonkhet", "Androzani Minor", "Antausia", "Apalapucia",
      "Arcavios", "Arkhos", "Avishkar", "Azgol", "Belenon", "Bolas's Meditation Realm", "Capenna",
      "Cridhe", "Darillium", "Dominaria", "Earth", "Echoir", "Eldraine", "Equilor", "Ergamon",
      "Fabacin", "Fiora", "Gallifrey", "Gargantikar", "Gobakhan", "Horsehead Nebula", "Ikoria",
      "Innistrad", "Iquatana", "Ir", "Ixalan", "Kaldheim", "Kamigawa", "Kandoka", "Karsus",
      "Kephalai", "Kinshala", "Kolbahan", "Kylem", "Kyneth", "Lorwyn", "Luvion", "Mars",
      "Mercadia", "Mirrodin", "Moag", "Mongseng", "Moon", "Muraganda", "Necros", "New Earth",
      "New Phyrexia", "Outside Mutter's Spiral", "Phyrexia", "Pyrulea", "Rabiah", "Rath",
      "Ravnica", "Regatha", "Segovia", "Serra's Realm", "Shadowmoor", "Shandalar", "Shenmeng",
      "Skaro", "Spacecraft", "Tarkir", "The Abyss", "The Dalek Asylum", "The Library", "Theros",
      "Time", "Trenzalore", "Ulgrotha", "Unknown Planet", "Valla", "Vryn", "Wildfire", "Xerex",
      "Zendikar", "Zhalfir"
    ]),
    // CR 205.3p
    dungeon: new Set([
      "Undercity"
    ]),
    // CR 205.3q
    battle: new Set([
      "Siege"
    ]),
  },

  /* Subtypes printed on cards that CR 205.3 does not list: Un-cards, playtest and other cards
     legal in no format, the Arena-only Chorus, and Scryfall's Terminus. A permanent that has
     one loses it with the card type it belongs to; nothing gives, offers or reads one. */
  unofficialSubtypes: {
    artifact: new Set(["Key", "Terminus"]),
    enchantment: new Set(["Quest", "Realm"]),
    land: new Set(["Barnyard", "Cloud", "Omenpath", "Ulamog's"]),
    planeswalker: new Set([
      "Abian", "B.O.B.", "Deb", "Duck", "Dungeon", "Ersta", "Explainer", "Inzerva", "Luxior",
      "Master", "Monopoly", "Svega", "Wanderer", "You"
    ]),
    spell: new Set(["Chorus", "Fire", "Vengeance"]),
    planar: new Set([
      "Amsterdam", "Blind Eternities", "Bloomburrow", "Chicago", "Clamhattan", "Duskmourn",
      "Foldaria", "Foundations", "Hell", "Las Vegas", "MagicCon", "Secret Lair",
      "Thunder Junction", "Universia Beyondia"
    ]),
    dungeon: new Set([]),
    battle: new Set(["Control", "Point"]),
  },

  // CR 205.3r: these card types have no subtypes.
  cardTypesWithoutSubtypes: new Set(['Phenomenon', 'Scheme', 'Vanguard', 'Conspiracy']),

  /* The official creature types (CR 205.3m): the types a changeling has. Not Scryfall's
     catalog (creatureTypes), which also has Naga, Brainiac and Chicken: what Scryfall's
     cards show to be official. */
  officialCreatureTypes: new Set([
    "Advisor", "Aenar", "Aetherborn", "Alien", "Ally", "Andorian", "Android", "Angel", "Antelope",
    "Ape", "Archer", "Archon", "Armadillo", "Army", "Artificer", "Assassin", "Assembly-Worker",
    "Astartes", "Atog", "Aurochs", "Avatar", "Azra", "Badger", "Bajoran", "Balloon", "Barbarian",
    "Bard", "Basilisk", "Bat", "Bear", "Beast", "Beaver", "Beeble", "Beholder", "Berserker",
    "Betazoid", "Bird", "Bison", "Blinkmoth", "Boar", "Bolian", "Borg", "Brikar", "Bringer",
    "Brushwagg", "C'tan", "Caitian", "Camarid", "Camel", "Capybara", "Cardassian", "Caribou",
    "Carrier", "Cat", "Centaur", "Child", "Chimera", "Citizen", "Cleric", "Clown", "Cockatrice",
    "Construct", "Coward", "Coyote", "Crab", "Crocodile", "Custodes", "Cyberman", "Cyclops",
    "Dalek", "Dauthi", "Demigod", "Demon", "Denobulan", "Deserter", "Detective", "Devil",
    "Dinosaur", "Djinn", "Doctor", "Dog", "Dragon", "Drake", "Dreadnought", "Drix", "Drone",
    "Druid", "Dryad", "Dwarf", "Echidna", "Edosian", "Efreet", "Egg", "El-Aurian", "Elder",
    "Eldrazi", "Elemental", "Elephant", "Elf", "Elk", "Employee", "Eternal", "Excalbian", "Eye",
    "Faerie", "Ferengi", "Ferret", "Fish", "Flagbearer", "Fox", "Fractal", "Frog", "Fungus",
    "Gamer", "Gamma", "Gargoyle", "Germ", "Giant", "Giraffe", "Gith", "Glimmer", "Gnoll", "Gnome",
    "Goat", "Goblin", "God", "Golem", "Gorgon", "Gorn", "Graveborn", "Gremlin", "Griffin", "Guest",
    "Hag", "Halfling", "Hamster", "Harpy", "Hedgehog", "Hellion", "Hero", "Hippo", "Hippogriff",
    "Hirogen", "Homarid", "Homunculus", "Horror", "Horse", "Human", "Hydra", "Hyena", "Illusion",
    "Illyrian", "Imp", "Incarnation", "Inhuman", "Inkling", "Inquisitor", "Insect", "Jackal",
    "Jellyfish", "Jem'Hadar", "Juggernaut", "Kangaroo", "Kavu", "Kelpien", "Kirin", "Kithkin",
    "Klingon", "Knight", "Kobold", "Kor", "Kraken", "Kree", "Kwejian", "Lamia", "Lammasu",
    "Lanthanite", "Leech", "Lemur", "Leviathan", "Lhurgoyf", "Licid", "Lizard", "Llama", "Lobster",
    "Manticore", "Masticore", "Medusan", "Melkotian", "Mercenary", "Merfolk", "Metathran",
    "Minion", "Minotaur", "Mite", "Mole", "Monger", "Mongoose", "Monk", "Monkey", "Moogle",
    "Moonfolk", "Mount", "Mouse", "Mutant", "Myr", "Mystic", "Na'kuhl", "Nautilus", "Necron",
    "Nephilim", "Nightmare", "Nightstalker", "Ninja", "Noble", "Noggle", "Nomad", "Nymph",
    "Ocampa", "Octopus", "Officer", "Ogre", "Ooze", "Orb", "Orc", "Orgg", "Orion", "Otter",
    "Ouphe", "Ox", "Oyster", "Pangolin", "Peasant", "Pegasus", "Pentavite", "Performer", "Pest",
    "Phelddagrif", "Phoenix", "Phyrexian", "Pilot", "Pincher", "Pirate", "Plant", "Platypus",
    "Porcupine", "Possum", "Praetor", "Primarch", "Prism", "Processor", "Q", "Qu", "Rabbit",
    "Raccoon", "Ranger", "Rat", "Rebel", "Reflection", "Rhino", "Rigger", "Robot", "Rogue",
    "Romulan", "Sable", "Salamander", "Samurai", "Sand", "Saproling", "Satyr", "Scarecrow",
    "Scientist", "Scion", "Scorpion", "Scout", "Sculpture", "Seal", "Serf", "Serpent", "Servo",
    "Shade", "Shaman", "Shapeshifter", "Shark", "Sheep", "Shi'ar", "Siren", "Skeleton", "Skrull",
    "Skunk", "Slith", "Sliver", "Sloth", "Slug", "Snail", "Snake", "Soldier", "Soltari",
    "Sorcerer", "Spawn", "Specter", "Spellshaper", "Sphinx", "Spider", "Spike", "Spirit",
    "Splinter", "Sponge", "Spy", "Squid", "Squirrel", "Starfish", "Surrakar", "Survivor",
    "Symbiote", "Synth", "Talaxian", "Talosian", "Tamarian", "Tellarite", "Tentacle", "Tetravite",
    "Thalakos", "Tholian", "Thopter", "Thrull", "Tiefling", "Time Lord", "Tosk", "Toy", "Treefolk",
    "Tribble", "Trill", "Trilobite", "Triskelavite", "Troll", "Turtle", "Tyranid", "Unicorn",
    "Utrom", "Vampire", "Varmint", "Vau-N'Akat", "Vedalken", "Villain", "Volver", "Vorta",
    "Vulcan", "Wall", "Walrus", "Warlock", "Warrior", "Weasel", "Weird", "Werewolf", "Whale",
    "Wizard", "Wolf", "Wolverine", "Wombat", "Worm", "Wraith", "Wurm", "Xindi", "Yeti", "Zombie",
    "Zubera"
  ]),

  /* Every other creature type is silver-bordered: these, which cards in the card file print
     or create, and whatever else Scryfall's catalog has that 205.3m does not (silverTypes). */
  silverCreatureTypes: new Set([
    "Alicorn", "Armored", "Art", "Artist", "Athlete", "Attendee", "Autobot", "Automaton",
    "Booster", "Boxer", "Brainiac", "Bureaucrat", "Cephalid", "Chameleon", "Champion", "Chef",
    "Chicken", "Clamfolk", "Cow", "Critter", "Cyborg", "Deer", "Designer", "Die", "Donkey",
    "Elemental?", "Elves", "Expansion-Symbol", "Fan", "Gorilla", "Grandchild", "Gus", "Half",
    "Hatificer", "Hawk", "Head", "Human?", "Igpay", "Judge", "Killbot", "Koala",
    "Lady of Proper Etiquette", "Mammoth", "Mime", "Mindless-One", "Mummy", "Naga", "Paratrooper",
    "Penguin", "Perfomer", "Pony", "Reveler", "Rukh", "Scotsman", "Ship", "Sketch", "Spuzzem",
    "Stained Glass", "Teddy", "The Biggest, Baddest, Nastiest, Scariest Creature You'll Ever See",
    "Townsfolk", "Tree", "Urzan", "Vampyre", "Waiter", "Windmill", "Wrestler", "Zonian"
  ]),

  /* [END: RULES-LISTS] */

  _silverOn() { return typeof Battlefield !== 'undefined' && !!Battlefield.silverBorder; },

  // The sets built from the lists, until init() or the test harness replaces the catalog.
  _creatureLists() {
    if (this._lists && this._lists.base === this.creatureTypes) return this._lists;
    const official = this.officialCreatureTypes;
    const silver = new Set([...this.silverCreatureTypes, ...[...this.creatureTypes].filter(t => !official.has(t))]);
    const both = new Set([...official, ...silver]);
    // (A type line is split at spaces, so a silver type of several words is known by each.)
    const onBoard = new Set([...both, ...[...silver].flatMap(t => t.split(' '))]);
    this._lists = { base: this.creatureTypes, silver, both, onBoard };
    return this._lists;
  },

  silverTypes() { return this._creatureLists().silver; },

  /* What a changeling, or a permanent with "all creature types", has: the official types,
     plus the silver-bordered ones while the "Silver border" switch is on
     (Battlefield.silverBorder, saved with the board; off by default). */
  everyCreatureType() { return this._silverOn() ? this._creatureLists().both : this.officialCreatureTypes; },

  /* Is this subtype on a permanent a creature type? Either list, whatever the switch says:
     a Clamfolk that becomes a Frog stops being a Clamfolk. For the engine, not for reading
     rules text (creatureTypes: Tree, Ship and Judge would be misread). */
  isCreatureType(s) { return this._creatureLists().onBoard.has(s); },

  /* What "choose a creature type" offers (CR 205.3e: an existing type): the same types a
     changeling has, in alphabetical order. */
  creatureTypeChoices() {
    // Not the silver-bordered phrases (Lady of Proper Etiquette): written into a card's text
    // as the chosen type they would be read as several words.
    return [...this.everyCreatureType()].filter(t => this.officialCreatureTypes.has(t) || !t.includes(' '))
      .sort((a, b) => a.localeCompare(b));
  },

  // The creature type chosen for the card being re-read (Battlefield._reparseWithChoices): a
  // type there although the parser knows no silver-bordered words. Null at any other time.
  chosenType: null,

  /* The type of `types` that typed text names, spelled as listed ("time lord" is Time Lord,
     "elves" is Elf), or null. */
  creatureTypeNamed(text, types) {
    const list = [...(types || this.creatureTypeChoices())];
    const find = (w) => list.find(t => t.toLowerCase() === String(w).toLowerCase()) || null;
    const typed = String(text || '').trim().replace(/\u2019/g, "'");
    return find(typed) || (typed && typeof singularizeCreatureType === 'function' ? find(singularizeCreatureType(typed)) : null);
  },

  scryfallCatalogs: {},

  /* Types Scryfall's cards have shown to be official since the lists were written
     (updateTypesFromScryfall): { kind: [types] }. Returns those that were new. */
  addOfficialTypes(found) {
    const added = [];
    for (const kind of Object.keys(found || {})) {
      if (kind !== 'creature' && !Object.prototype.hasOwnProperty.call(this.officialSubtypes, kind)) continue;
      const official = this.officialList(kind);
      for (const type of Array.isArray(found[kind]) ? found[kind] : []) {
        // (It comes from the network or storage and is drawn into the page: a word and no more.)
        if (!this.isTypeShaped(type) || official.has(type)) continue;
        official.add(type);
        (this._addedTypes || (this._addedTypes = new Set())).add(kind + ':' + type);
        (kind === 'creature' ? this.silverCreatureTypes : this.unofficialSubtypes[kind]).delete(type);
        // A new Set: the caches are keyed on it.
        if (this[kind + 'Types']) this[kind + 'Types'] = new Set([...this[kind + 'Types'], type]);
        if (kind === 'land') _addLandSubtypeWord(type);
        if (this._readOnly) this._readOnly.delete(kind + ':' + type);
        added.push({ kind, type });
      }
    }
    if (added.length) {
      this._lists = null;
      this._categories = null;
    }
    return added;
  },

  // (It comes from the network or storage and is drawn into the page: a word and no more.)
  isTypeShaped(type) { return typeof type === 'string' && /^\p{Lu}[\p{L}'\- ]{0,47}$/u.test(type); },

  /* Types a card in hand has shown the parser (learnTypesFromCard): read as types, and only
     official once addOfficialTypes says so. Returns those that were new. */
  addReadTypes(found) {
    const added = [];
    for (const kind of Object.keys(found || {})) {
      const read = this[kind + 'Types'];
      if (!(read instanceof Set) || !this.officialList(kind).size) continue;
      for (const type of found[kind]) {
        if (!this.isTypeShaped(type) || read.has(type)) continue;
        // (Known joke types stay unread; the silver-bordered are only met here on real cards.)
        if (kind !== 'creature' && this.unofficialSubtypes[kind].has(type)) continue;
        this[kind + 'Types'] = new Set([...this[kind + 'Types'], type]);
        (this._readOnly || (this._readOnly = new Set())).add(kind + ':' + type);
        if (kind === 'land') _addLandSubtypeWord(type);
        added.push({ kind, type });
      }
    }
    return added;
  },

  // Scryfall's creature types asked for again: a type can be new since the page was opened.
  async refreshCreatureCatalog() {
    try {
      const res = await fetch('https://api.scryfall.com/catalog/creature-types', { cache: 'no-cache' });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || !Array.isArray(data.data) || !data.data.length) return false;
      this.scryfallCatalogs.creature = data.data;
      const fresh = data.data.filter(t => this.isTypeShaped(t) && !this.creatureTypes.has(t));
      if (fresh.length) this.creatureTypes = new Set([...this.creatureTypes, ...fresh]);
      return true;
    } catch (e) {
      return false;
    }
  },

  // Words read off a card as two types that the catalog has since shown to be one of two words.
  dropSplitPhraseWords() {
    if (!this._readOnly) return [];
    const catalog = new Set(this.scryfallCatalogs.creature || []), gone = [];
    for (const phrase of catalog) {
      if (!phrase.includes(' ')) continue;
      for (const word of phrase.split(' ')) {
        if (catalog.has(word) || this.officialCreatureTypes.has(word) || !this._readOnly.delete('creature:' + word)) continue;
        this.creatureTypes = new Set([...this.creatureTypes].filter(t => t !== word));
        gone.push({ kind: 'creature', type: word });
      }
    }
    return gone;
  },

  // Is this type official in the lists as written, the visit's additions aside?
  writtenOfficial(kind, type) {
    return this.officialList(kind).has(type) && !(this._addedTypes && this._addedTypes.has(kind + ':' + type));
  },

  // The kinds of subtype the parser reads: a <kind>Types set each.
  vocabularyKinds() {
    return ['creature', ...Object.keys(this.officialSubtypes)].filter(kind => this[kind + 'Types'] instanceof Set);
  },

  officialList(category) {
    return (category === 'creature' ? this.officialCreatureTypes : this.officialSubtypes[category]) || new Set();
  },

  /* Which subtypes on a permanent belong to a card type, for losing and replacing them:
     official or not, and whatever the Silver border switch says. */
  getSubtypeCategory(category) {
    if (category === 'creature') return this._creatureLists().onBoard;
    if (!this.officialSubtypes[category]) return new Set();
    const read = this[category + 'Types'];   // (none for planar and dungeon types)
    const cache = this._categories || (this._categories = {});
    if (!cache[category] || cache[category].read !== read) {
      const set = new Set([...this.officialSubtypes[category], ...this.unofficialSubtypes[category], ...(read || [])]);
      cache[category] = { read, set };
    }
    return cache[category].set;
  },

  getSubtypesForCardType(cardType) {
    const cat = this._typeToCategory[cardType];
    return cat ? this.getSubtypeCategory(cat) : new Set();
  },

  classifySubtype(subtype) {
    if (this.chosenType && subtype === this.chosenType) return 'creature';
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
  isCardType(word) { return this.cardTypes.has(word) || word === 'Tribal'; },
};
// The parser starts with the rules' lists, so it reads every official type before Scryfall
// answers and where Scryfall is blocked.
for (const kind of ['creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'spell', 'battle']) {
  TypeCatalog[kind + 'Types'] = new Set(TypeCatalog.officialList(kind));
}
TypeCatalog.loaded = true;
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

  /* Balduvian Shaman: color text change on white enchantment + grants cumulative upkeep.
     The fired ability's text, as _addAbilityPseudo writes it (no "{T}: ", "That enchantment" read as
     its target): until it is activated it does nothing. */
  'change the text of target white enchantment you control that doesn\'t have cumulative upkeep by replacing all instances of one color word with another. target white enchantment you control gains "cumulative upkeep {1}."': [
    // (The restriction on the effects themselves, as the target pickers and _pinAbilityEffectsToSource
    // read it: unpicked, the cumulative upkeep landed on the Shaman.)
    { layer: '3', type: EFFECT_TYPE.TEXT_CHANGE,
      params: { changeType: 'color_only', replacements: [] },
      targetRestriction: (p) => (p.types || []).includes('Enchantment') && (p.colors || []).includes('W') &&
        !(p.abilities || []).some(a => /^cumulative upkeep\b/i.test(String(a))),
      appliesTo: null, scope: 'targeted', youControlRequired: true,
      desc: 'Change one color word in target white enchantment\'s text to another. (Must not have cumulative upkeep.)' },
    { layer: '6', type: EFFECT_TYPE.ADD_ABILITY,
      params: { ability: 'Cumulative upkeep {1}' },
      targetRestriction: (p) => (p.types || []).includes('Enchantment') && (p.colors || []).includes('W') &&
        !(p.abilities || []).some(a => /^cumulative upkeep\b/i.test(String(a))),
      appliesTo: null, scope: 'targeted', youControlRequired: true,
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
