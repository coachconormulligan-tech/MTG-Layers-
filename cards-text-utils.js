/* cards-text-utils.js — CARD_TYPE_WORDS / LAND_SUBTYPE_WORDS, plurals, filterReferencesPermanents,
   extractTargetInfo, buildAppliesToFromText (+inner), parseBecomesType, buildAuraRestriction,
   _evaluateTriggerCondition. */

const CARD_TYPE_WORDS = {
  'land': { check: 'type', value: 'Land' },
  'lands': { check: 'type', value: 'Land' },
  'creature': { check: 'type', value: 'Creature' },
  'creatures': { check: 'type', value: 'Creature' },
  'artifact': { check: 'type', value: 'Artifact' },
  'artifacts': { check: 'type', value: 'Artifact' },
  'enchantment': { check: 'type', value: 'Enchantment' },
  'enchantments': { check: 'type', value: 'Enchantment' },
  'planeswalker': { check: 'type', value: 'Planeswalker' },
  'planeswalkers': { check: 'type', value: 'Planeswalker' },
  'permanent': { check: 'any', value: null },
  'permanents': { check: 'any', value: null },
};
/* Look up a word in CARD_TYPE_WORDS, falling back to its singular form (strip trailing 's').
   Replaces the pattern `CARD_TYPE_WORDS[w] || CARD_TYPE_WORDS[w.replace(/s$/, '')]` repeated
   across the parser and text utils. */
function normalizeTypeWord(w) {
  return CARD_TYPE_WORDS[w] || CARD_TYPE_WORDS[w.replace(/s$/, '')];
}

const LAND_SUBTYPE_WORDS = {
  'plains': 'Plains', 'island': 'Island', 'islands': 'Island',
  'swamp': 'Swamp', 'swamps': 'Swamp',
  'mountain': 'Mountain', 'mountains': 'Mountain',
  'forest': 'Forest', 'forests': 'Forest',
  'cave': 'Cave', 'caves': 'Cave',
  'desert': 'Desert', 'deserts': 'Desert',
  'gate': 'Gate', 'gates': 'Gate',
};

/* Check if a filter/subject text references permanents or permanent types.
   Used to skip non-permanent "is/are" clauses like "each opponent's hand size is increased by 5". */
function filterReferencesPermanents(filterText) {
  const f = filterText.toLowerCase().trim()
    .replace(/^(?:all|each|every|other)\s+/, '')
    .replace(/\s+you (?:control|own)(?=\s|$)/g, '')
    // Normalize commas to spaces so comma-separated subtype enumerations
    // ("Spiders, Boars, Bats, and Wolves") split into recognizable words below.
    // Without this, the trailing comma on each word ("spiders,") blocks the
    // TypeCatalog lookup and the whole filter is wrongly treated as non-permanent.
    .replace(/,/g, ' ');
  // A filter that explicitly names "spell/spells" targets stack objects, not permanents —
  // even if it also contains type words like "instant" or "sorcery".
  if (/\bspells?\b/.test(f)) return false;
  // Direct card type words — check at start, end, or as a standalone word within
  for (const w of Object.keys(CARD_TYPE_WORDS)) {
    if (f === w || f.endsWith(' ' + w) || f.startsWith(w + ' ') || f.includes(' ' + w + ' ')) return true;
  }
  // Land subtype words
  for (const w of Object.keys(LAND_SUBTYPE_WORDS)) {
    if (f === w || f.endsWith(' ' + w) || f.startsWith(w + ' ') || f.includes(' ' + w + ' ')) return true;
  }
  // Known creature subtypes (from TypeCatalog)
  if (typeof TypeCatalog !== 'undefined' && TypeCatalog.creatureTypes.size > 0) {
    const words = f.split(/\s+/);
    for (const w of words) {
      const cap = w.charAt(0).toUpperCase() + w.slice(1).replace(/s$/, '');
      if (TypeCatalog.creatureTypes.has(cap)) return true;
      if (TypeCatalog.creatureTypes.has(w.charAt(0).toUpperCase() + w.slice(1))) return true;
    }
  }
  // Known artifact subtypes (from TypeCatalog) — e.g. "Clues", "Treasures", "Food"
  // Hardcoded fallback covers the pre-load window before TypeCatalog.artifactTypes is populated.
  const KNOWN_ARTIFACT_SUBTYPES = ['Treasure', 'Equipment', 'Vehicle', 'Food', 'Clue', 'Blood', 'Map', 'Powerstone', 'Incubator', 'Contraption'];
  {
    const words = f.split(/\s+/);
    for (const w of words) {
      const cap = w.charAt(0).toUpperCase() + w.slice(1);
      const singular = cap.endsWith('s') ? cap.slice(0, -1) : cap;
      if (KNOWN_ARTIFACT_SUBTYPES.includes(cap) || KNOWN_ARTIFACT_SUBTYPES.includes(singular)) return true;
      if (typeof TypeCatalog !== 'undefined' && TypeCatalog.artifactTypes.size > 0) {
        if (TypeCatalog.artifactTypes.has(cap) || TypeCatalog.artifactTypes.has(singular)) return true;
      }
    }
  }
  // Known enchantment subtypes — e.g. "Aura", "Saga", "Class"
  const KNOWN_ENCHANTMENT_SUBTYPES = ['Aura', 'Curse', 'Shrine', 'Rune', 'Saga', 'Cartouche', 'Class', 'Role', 'Background', 'Shard'];
  {
    const words = f.split(/\s+/);
    for (const w of words) {
      const cap = w.charAt(0).toUpperCase() + w.slice(1);
      const singular = cap.endsWith('s') ? cap.slice(0, -1) : cap;
      if (KNOWN_ENCHANTMENT_SUBTYPES.includes(cap) || KNOWN_ENCHANTMENT_SUBTYPES.includes(singular)) return true;
      if (typeof TypeCatalog !== 'undefined' && TypeCatalog.enchantmentTypes && TypeCatalog.enchantmentTypes.size > 0) {
        if (TypeCatalog.enchantmentTypes.has(cap) || TypeCatalog.enchantmentTypes.has(singular)) return true;
      }
    }
  }
  // Planeswalker subtypes (e.g. "Gideon", "Jace") and battle subtypes — all refer to permanents
  if (typeof TypeCatalog !== 'undefined') {
    const words = f.split(/\s+/);
    for (const w of words) {
      const cap = w.charAt(0).toUpperCase() + w.slice(1);
      const singular = cap.endsWith('s') ? cap.slice(0, -1) : cap;
      if (TypeCatalog.planeswalkerTypes && TypeCatalog.planeswalkerTypes.size > 0) {
        if (TypeCatalog.planeswalkerTypes.has(cap) || TypeCatalog.planeswalkerTypes.has(singular)) return true;
      }
      if (TypeCatalog.battleTypes && TypeCatalog.battleTypes.size > 0) {
        if (TypeCatalog.battleTypes.has(cap) || TypeCatalog.battleTypes.has(singular)) return true;
      }
    }
  }
  // Self-references
  if (/^(this creature|this permanent|this card|this token|it|itself|enchanted|equipped)/.test(f)) return true;
  // "non-[type]" patterns
  if (/^non-?\w+/.test(f)) {
    const inner = f.replace(/^non-?/, '');
    for (const w of Object.keys(CARD_TYPE_WORDS)) {
      if (inner === w || inner.startsWith(w)) return true;
    }
  }
  // Supertype words that indicate permanents
  if (/\b(legendary|basic|snow|token)\b/.test(f)) return true;
  // "commander" / "commanders" reference permanents in commander games
  if (/\bcommanders?\b/.test(f)) return true;
  return false;
}

/* Check if a filter/subject text references spells (non-permanent objects on the stack).
   Used to detect effects like "instant and sorcery spells you cast have lifelink". */
function filterReferencesSpells(filterText) {
  const f = filterText.toLowerCase().trim()
    .replace(/^(?:all|each|every|other)\s+/, '')
    .replace(/\s+you (?:control|own|cast)(?=\s|$)/g, '');
  const spellWords = ['instant', 'instants', 'sorcery', 'sorceries', 'spell', 'spells', 'burn spell', 'burn spells'];
  for (const w of spellWords) {
    if (f === w || f.endsWith(' ' + w) || f.startsWith(w + ' ') || f.includes(' ' + w + ' ')) return true;
  }
  return false;
}

/* Build an appliesTo-style result for a filter that targets stack spells.
   Returns { fn, desc, isSpellFilter: true } where fn(spellState, allStates, effectCtrl) => bool.
   Handles: color qualifiers ("red"), type qualifiers ("instant", "sorcery"), "you cast" ownership. */
function buildSpellAppliesToFromText(filterText) {
  const f = filterText.toLowerCase().trim();
  const youCast = /\byou (?:cast|control|own)\b/.test(f);
  const clean = f
    .replace(/\byou (?:cast|control|own)\b.*/g, '')
    .replace(/\bspells?\b/g, '')
    .replace(/\b(?:and|or)\b/g, ' ')
    .trim();

  const requiredTypes = [];
  if (/\binstants?\b/.test(clean)) requiredTypes.push('Instant');
  if (/\bsorcer(?:y|ies)\b/.test(clean)) requiredTypes.push('Sorcery');

  const SPELL_COLOR_MAP = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
  const requiredColors = [];
  for (const [name, code] of Object.entries(SPELL_COLOR_MAP)) {
    if (new RegExp('\\b' + name + '\\b').test(clean)) requiredColors.push(code);
  }

  // "burn spells" — instants/sorceries that deal damage; treat as instant-or-sorcery for now
  if (/\bburn\b/.test(clean) && requiredTypes.length === 0) {
    requiredTypes.push('Instant', 'Sorcery');
  }

  return {
    fn: (p, allStates, effectCtrl) => {
      if (!p.isSpell) return false;
      if (youCast && effectCtrl && p.controller !== effectCtrl) return false;
      if (requiredTypes.length > 0 && !requiredTypes.some(t => (p.types || []).includes(t))) return false;
      if (requiredColors.length > 0 && !requiredColors.every(c => (p.colors || []).includes(c))) return false;
      return true;
    },
    desc: `Applies to: ${filterText.trim()} (stack spells)`,
    isSpellFilter: true,
  };
}

/* Singularize creature type words. Handles irregular MTG plurals.
   Input: lowercase word (e.g. "elves", "humans", "wolves")
   Output: Title-cased singular (e.g. "Elf", "Human", "Wolf") */
const IRREGULAR_PLURALS = {
  'elves': 'Elf', 'dwarves': 'Dwarf', 'wolves': 'Wolf', 'halves': 'Half',
  'selves': 'Self', 'leaves': 'Leaf', 'knives': 'Knife', 'lives': 'Life',
  'thieves': 'Thief', 'calves': 'Calf', 'loaves': 'Loaf', 'hooves': 'Hoof',
  'werewolves': 'Werewolf', 'mice': 'Mouse', 'lice': 'Louse', 'geese': 'Goose',
  'oxen': 'Ox', 'children': 'Child', 'fungi': 'Fungus', 'cacti': 'Cactus',
  'octopi': 'Octopus', 'hippopotami': 'Hippo', 'djinn': 'Djinn',
  'efreet': 'Efreet', 'efreets': 'Efreet', 'sheep': 'Sheep', 'fish': 'Fish',
  'merfolk': 'Merfolk', 'kithkin': 'Kithkin', 'samurai': 'Samurai',
  'allies': 'Ally', 'faeries': 'Faerie', 'zombies': 'Zombie',
  'harpies': 'Harpy', 'valkyries': 'Valkyrie', 'banshees': 'Banshee',
  'gargoyles': 'Gargoyle',
};
function singularizeCreatureType(word) {
  const low = word.toLowerCase();
  // Check irregular map first
  if (IRREGULAR_PLURALS[low]) return IRREGULAR_PLURALS[low];
  const cap = low.charAt(0).toUpperCase() + low.slice(1);
  // Check TypeCatalog before stripping trailing s -- some types end in s (e.g. "Fungus")
  if (typeof TypeCatalog !== 'undefined' && TypeCatalog.creatureTypes.has(cap)) return cap;
  // Remove trailing 's' for standard plurals (e.g. "Goblins" -> "Goblin")
  if (low.endsWith('s') && low.length > 2) {
    const withoutS = low.slice(0, -1);
    return withoutS.charAt(0).toUpperCase() + withoutS.slice(1);
  }
  return cap;
}

/* Reverse map: singular — irregular plural form. Built from IRREGULAR_PLURALS. */
const SINGULAR_TO_PLURAL = {};
for (const [plural, singular] of Object.entries(IRREGULAR_PLURALS)) {
  const singLow = singular.toLowerCase();
  if (!SINGULAR_TO_PLURAL[singLow] || plural.length > SINGULAR_TO_PLURAL[singLow].length) {
    SINGULAR_TO_PLURAL[singLow] = plural.charAt(0).toUpperCase() + plural.slice(1);
  }
}

/* Pluralize a creature type name.
   "Elf" — "Elves", "Dwarf" — "Dwarves", "Goblin" — "Goblins", "Merfolk" — "Merfolk" */
function pluralizeCreatureType(singular) {
  const low = singular.toLowerCase();
  const sameForm = ['merfolk', 'kithkin', 'samurai', 'djinn', 'efreet', 'sheep', 'fish'];
  if (sameForm.includes(low)) return singular;
  if (SINGULAR_TO_PLURAL[low]) return SINGULAR_TO_PLURAL[low];
  if (low.endsWith('s') || low.endsWith('x') || low.endsWith('z') || low.endsWith('sh') || low.endsWith('ch')) {
    return singular + 'es';
  }
  if (low.endsWith('y') && !'aeiou'.includes(low[low.length - 2])) {
    return singular.slice(0, -1) + 'ies';
  }
  return singular + 's';
}

/* Build all from—to pairs for a creature type replacement, including plural forms.
   E.g. from="Wyvern", to="Elf" — [{ from: "Wyvern", to: "Elf" }, { from: "Wyverns", to: "Elves" }]
   Ensures text like "Other Wyverns get +1/+1" properly becomes "Other Elves get +1/+1". */
function buildCreatureTypeReplacementPairs(from, to) {
  const fromSingular = singularizeCreatureType(from);
  const toSingular = singularizeCreatureType(to);
  const fromPlural = pluralizeCreatureType(fromSingular);
  const toPlural = pluralizeCreatureType(toSingular);
  const pairs = [{ from: fromSingular, to: toSingular }];
  if (fromPlural.toLowerCase() !== fromSingular.toLowerCase() ||
      toPlural.toLowerCase() !== toSingular.toLowerCase()) {
    pairs.push({ from: fromPlural, to: toPlural });
  }
  return pairs;
}

/* Build singular+plural replacement pairs for basic land type words.
   Handles the "Plains" edge case: singular and plural are the same word,
   so we use word-boundary context ("Plains" alone = singular "Swamp",
   but the engine's substring regex handles "Mountains" — "Islands" naturally
   since "Mountain" is a substring of "Mountains").
   For Plains—Swamp specifically: we must also generate "Plains"—"Swamps"
   as a separate plural-form pair, relying on context or longest-match. */
const LAND_SINGULAR_TO_PLURAL = {
  'plains': 'Plains',   // same form — special case
  'island': 'Islands',
  'swamp': 'Swamps',
  'mountain': 'Mountains',
  'forest': 'Forests',
};
const LAND_PLURAL_TO_SINGULAR = {};
for (const [s, p] of Object.entries(LAND_SINGULAR_TO_PLURAL)) {
  LAND_PLURAL_TO_SINGULAR[p.toLowerCase()] = s.charAt(0).toUpperCase() + s.slice(1);
}

function buildLandTypeReplacementPairs(from, to) {
  const fromLow = from.toLowerCase();
  const toLow = to.toLowerCase();
  // Only expand for land type words
  const landWords = ['plains', 'island', 'swamp', 'mountain', 'forest'];
  if (!landWords.includes(fromLow) || !landWords.includes(toLow)) {
    return [{ from, to }]; // not land types, return as-is
  }
  const fromSingular = LAND_PLURAL_TO_SINGULAR[fromLow]
    || from.charAt(0).toUpperCase() + from.slice(1);
  const toSingular = LAND_PLURAL_TO_SINGULAR[toLow]
    || to.charAt(0).toUpperCase() + to.slice(1);
  const fromPlural = LAND_SINGULAR_TO_PLURAL[fromSingular.toLowerCase()] || fromSingular + 's';
  const toPlural = LAND_SINGULAR_TO_PLURAL[toSingular.toLowerCase()] || toSingular + 's';
  const pairs = [];
  if (fromPlural.toLowerCase() !== fromSingular.toLowerCase()) {
    // Different singular/plural forms (Mountain/Mountains) — add both pairs
    pairs.push({ from: fromSingular, to: toSingular });
    pairs.push({ from: fromPlural, to: toPlural });
  } else {
    // Same singular/plural form (Plains) — single pair with pluralTo for context detection
    pairs.push({ from: fromSingular, to: toSingular, pluralTo: toPlural });
  }
  return pairs;
}

/* [KEY: TARGET-EXTRACT] — Extract "target"/"choose" metadata from filter text.
   Returns { cleaned, needsTargetSelection, maxTargets }.
   The cleaned text has "target"/"a target" stripped so buildAppliesToFromText can parse the type filter.
   "choose a creature" is normalized to the same output as "target creature". */
const _TARGET_NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
function extractTargetInfo(filterText) {
  const raw = filterText.toLowerCase().trim();
  let needsTargetSelection = false;
  let maxTargets = 1;
  let cleaned = filterText;

  // "up to N other target [type]" — e.g. "up to one other target creature" (Abigale)
  const upToOtherTargetMatch = raw.match(/^up to (\w+)\s+other\s+target\s+/i);
  if (upToOtherTargetMatch) {
    needsTargetSelection = true;
    const numWord = upToOtherTargetMatch[1].toLowerCase();
    maxTargets = _TARGET_NUMBER_WORDS[numWord] || parseInt(numWord) || 1;
    cleaned = filterText.replace(/^up to \w+\s+other\s+target\s+/i, '').trim();
    return { cleaned, needsTargetSelection, maxTargets };
  }

  // "up to N target [type]" — multi-target
  const upToTargetMatch = raw.match(/^up to (\w+)\s+target\s+/i);
  if (upToTargetMatch) {
    needsTargetSelection = true;
    const numWord = upToTargetMatch[1].toLowerCase();
    maxTargets = _TARGET_NUMBER_WORDS[numWord] || parseInt(numWord) || 1;
    cleaned = filterText.replace(/^up to \w+\s+target\s+/i, '').trim();
    return { cleaned, needsTargetSelection, maxTargets };
  }

  // "N target [type]" — exact count multi-target (e.g. "two target creatures")
  const nTargetMatch = raw.match(/^(\w+)\s+target\s+/i);
  if (nTargetMatch && _TARGET_NUMBER_WORDS[nTargetMatch[1].toLowerCase()]) {
    needsTargetSelection = true;
    maxTargets = _TARGET_NUMBER_WORDS[nTargetMatch[1].toLowerCase()];
    cleaned = filterText.replace(/^\w+\s+target\s+/i, '').trim();
    return { cleaned, needsTargetSelection, maxTargets };
  }

  // "target [type]" or "a target [type]" or "another target [type]" — single target
  const plainTargetMatch = raw.match(/^(?:a\s+|another\s+)?target\s+(.+)/i);
  if (plainTargetMatch) {
    needsTargetSelection = true;
    cleaned = plainTargetMatch[1].trim();
    return { cleaned, needsTargetSelection, maxTargets };
  }

  // "choose a [type] you control" / "choose [N] [type]" — choose pattern
  const chooseMatch = raw.match(/^choose\s+(?:a|an|up to (\w+))\s+(.+?)(?:\s+you (?:control|own))?$/i);
  if (chooseMatch) {
    needsTargetSelection = true;
    if (chooseMatch[1]) {
      const numWord = chooseMatch[1].toLowerCase();
      maxTargets = _TARGET_NUMBER_WORDS[numWord] || parseInt(numWord) || 1;
    }
    cleaned = chooseMatch[2].trim();
    return { cleaned, needsTargetSelection, maxTargets };
  }

  return { cleaned, needsTargetSelection, maxTargets };
}
/* [END: TARGET-EXTRACT] */

function buildAppliesToFromText(filterText) {
  // Extract target/choose metadata first
  const _tinfo = extractTargetInfo(filterText);
  const _result = _buildAppliesToFromTextInner(_tinfo.cleaned);
  // Attach targeting metadata to the result
  if (_tinfo.needsTargetSelection) {
    _result.needsTargetSelection = true;
    _result.maxTargets = _tinfo.maxTargets;
    // "target creature" is a targeted effect, similar to "enchanted creature"
    _result.isTargeted = true;
    // Mark as spell-target (not aura/equipment) so parsers can set targetRestriction
    _result.isSpellTarget = true;
  }
  // Multiplayer: wrap "you control" filter with controller check.
  // The inner function already handles "opponents control" directly.
  // For "you control", wrap the type filter so it only matches permanents
  // controlled by the effect's source controller (passed as 3rd arg by engine.js).
  const rawLower = filterText.toLowerCase();
  if (!_result.isOpponentsControl && !_result.isSelf && !_result.isTargeted &&
      /\byou (?:control|own)\b/.test(rawLower) && _result.fn) {
    const innerFn = _result.fn;
    _result.fn = (p, allStates, effectCtrl) => {
      if (effectCtrl && p.controller !== effectCtrl) return false;
      return innerFn(p, allStates, effectCtrl);
    };
    _result.isYouControl = true;
  }
  // Multiplayer: "[type] target player controls" scopes to permanents controlled by a
  // user-chosen player. The engine passes the chosen player as the 3rd arg (effectCtrl)
  // via the _targetPlayerScoped override, so reuse the same controller-check wrapper.
  if (!_result.isOpponentsControl && !_result.isSelf && !_result.isTargeted &&
      /\btarget player controls?\b/.test(rawLower) && _result.fn) {
    const innerFn = _result.fn;
    _result.fn = (p, allStates, effectCtrl) => {
      if (effectCtrl && p.controller !== effectCtrl) return false;
      return innerFn(p, allStates, effectCtrl);
    };
    _result.isTargetPlayerControl = true;
  }
  return _result;
}

function _buildAppliesToFromTextInner(filterText) {
  const raw = filterText.toLowerCase().trim();
  // Detect "your opponents control"  —  mark effect but return empty (nothing applies)
  const opponentsControl = raw.includes('your opponents control') || raw.includes("opponents' control")
    || raw.includes("opponent controls") || raw.includes("opponents control")
    || /\bopponent'?s?\b/.test(raw);
  const youControl = !opponentsControl && (/\byou (?:control|own)\b/.test(raw));
  const f = raw
    .replace(/^(?:all|each|every|up to \w+( other)?)\s+/, '')
    .replace(/\s+you (?:control|own)(?=\s|$)/g, '')
    .replace(/\s+your opponents control(?=\s|$)/g, '')
    .replace(/\s+opponents control(?=\s|$)/g, '')
    .replace(/\s+target\s+opponent\s+controls?(?=\s|$)/g, '')
    .replace(/\s+target\s+player\s+controls?(?=\s|$)/g, '')
    .replace(/^(?:other|another)\s+/, '');

  // --- "this creature" / "this permanent" / "it" — selfTarget ---
  if (/^(this creature|this permanent|this card|this token|it|itself|that creature|that permanent)$/.test(f)) {
    return { fn: () => true, desc: 'Applies to: this permanent (self)', isSelf: true };
  }
  // "enchanted creature" and "equipped creature" are targeted (apply to attached permanent, not self)
  // Matches any "enchanted/equipped [optional-non-prefix] [type-word]" pattern
  if (/^(?:equipped|enchanted)\s+(?:non\w+\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle)$/.test(f)) {
    return { fn: () => true, desc: `Applies to: ${f}`, isSelf: false, isTargeted: true };
  }

  // "enchanted creatures" / "equipped creatures" (plural) = filter for creatures with the Enchanted/Equipped trait
  const enchEquipPluralMatch = f.match(/^(enchanted|equipped)\s+(.+)$/);
  if (enchEquipPluralMatch) {
    const traitName = enchEquipPluralMatch[1] === 'enchanted' ? 'Enchanted' : 'Equipped';
    const typeWord = enchEquipPluralMatch[2].replace(/s$/, '');
    const typeInfo = CARD_TYPE_WORDS[typeWord] || CARD_TYPE_WORDS[enchEquipPluralMatch[2]];
    if (typeInfo && typeInfo.check === 'type') {
      return {
        fn: (p) => p.types.includes(typeInfo.value) && (p.traits || []).includes(traitName),
        desc: `Applies to: ${f} (${traitName.toLowerCase()} ${typeInfo.value}s)`,
      };
    }
    // Fallback: match any permanent with the trait
    return {
      fn: (p) => (p.traits || []).includes(traitName),
      desc: `Applies to: ${f} (${traitName.toLowerCase()} permanents)`,
    };
  }

  // "modified creatures" = filter for modified permanents (CR 701.52)
  // Modified: has a counter, an Aura attached (Enchanted trait), or Equipment attached (Equipped trait)
  const modifiedMatch = f.match(/^modified\s+(.+)$/);
  if (modifiedMatch) {
    const typeInfo = CARD_TYPE_WORDS[modifiedMatch[1]] || CARD_TYPE_WORDS[modifiedMatch[1].replace(/s$/, '')];
    const _isModified = (p) => {
      const hasCounter = Object.values(p.counters || {}).some(v => v > 0);
      return hasCounter || (p.traits || []).includes('Enchanted') || (p.traits || []).includes('Equipped');
    };
    if (typeInfo && typeInfo.check === 'type') {
      return {
        fn: (p) => p.types.includes(typeInfo.value) && _isModified(p),
        desc: `Applies to: modified ${typeInfo.value.toLowerCase()}s`,
      };
    }
    return {
      fn: (p) => _isModified(p),
      desc: 'Applies to: modified permanents',
    };
  }

  // --- "your opponents control"  —  nothing on your battlefield matches, but track it ---
  if (opponentsControl) {
    // Multiplayer: applies to permanents controlled by a different player than the effect's source
    // The 3rd argument (effectCtrl) is passed by effectAppliesToPerm in engine.js.
    // If f still has a type qualifier (e.g. "creature" from "each creature target opponent controls"),
    // fold a type check into the filter so non-matching permanents are excluded.
    const oppTypeInfo = normalizeTypeWord(f);
    if (oppTypeInfo && oppTypeInfo.check === 'type') {
      return {
        fn: (p, allStates, effectCtrl) =>
          p.controller !== (effectCtrl || p.controller) && p.types.includes(oppTypeInfo.value),
        desc: `Applies to: ${oppTypeInfo.value.toLowerCase()}s opponents control`,
        isOpponentsControl: true,
      };
    }
    return {
      fn: (p, allStates, effectCtrl) => p.controller !== (effectCtrl || p.controller),
      desc: 'Applies to: permanents opponents control',
      isOpponentsControl: true,
    };
  }

  // --- "and/or" conditions: "Elves and/or Goblins" ---
  if (f.includes(' and/or ')) {
    const parts = f.split(/\s+and\/or\s+/);
    if (parts.length === 2) {
      const a = buildAppliesToFromText(parts[0]);
      const b = buildAppliesToFromText(parts[1]);
      if (!a.isFallback && !b.isFallback) {
        return {
          fn: (p) => a.fn(p) || b.fn(p),
          desc: `Applies to: ${a.desc.replace('Applies to: ', '')} OR ${b.desc.replace('Applies to: ', '')}`,
        };
      }
    }
  }

  // --- Comma-separated permanent type list (OR): "artifacts, creatures, enchantments, and lands" ---
  // In MTG oracle text, listing permanent type words separated by commas (with optional trailing "and")
  // means OR semantics — a permanent qualifies if it has ANY one of those types.
  // e.g. "Artifacts, creatures, enchantments, and lands you control have indestructible."
  // Also handles lists of creature subtypes ("Pests, Bats, Insects, Snakes, and Spiders") and
  // lists of land subtypes — the comma is the OR signal.
  if (f.includes(',')) {
    const _commaParts = f.split(/,\s*(?:and\s+)?|\s+and\s+/).map(s => s.trim()).filter(Boolean);
    if (_commaParts.length >= 2) {
      const _commaTypeInfos = _commaParts.map(p => {
        const info = normalizeTypeWord(p);
        return (info && info.check === 'type') ? info : null;
      });
      if (_commaTypeInfos.every(Boolean)) {
        const _typeVals = [...new Set(_commaTypeInfos.map(t => t.value))];
        return {
          fn: (p) => _typeVals.some(t => p.types.includes(t)),
          desc: `Applies to: ${_typeVals.map(t => t + 's').join(' OR ')}`,
        };
      }
      // Fallback: each segment is a creature subtype or land subtype (e.g. "Pests, Bats, Insects, Snakes, and Spiders")
      const _commaSubInfos = _commaParts.map(p => {
        const typeInfo = normalizeTypeWord(p);
        if (typeInfo) return null;
        const landSub = LAND_SUBTYPE_WORDS[p] || LAND_SUBTYPE_WORDS[p.replace(/s$/, '')];
        if (landSub) return { kind: 'land', value: landSub };
        // Treat as creature subtype if it singularizes to something non-empty and isn't a generic stopword
        const stopwords = ['and', 'or', 'the', 'a', 'an', 'each', 'every', 'all', 'other', 'another', 'it', 'them'];
        if (stopwords.includes(p)) return null;
        const sub = singularizeCreatureType(p);
        if (!sub) return null;
        return { kind: 'creature', value: sub };
      });
      if (_commaSubInfos.every(Boolean)) {
        const _creatureSubs = [...new Set(_commaSubInfos.filter(s => s.kind === 'creature').map(s => s.value))];
        const _landSubs = [...new Set(_commaSubInfos.filter(s => s.kind === 'land').map(s => s.value))];
        if (_creatureSubs.length > 0 && _landSubs.length === 0) {
          return {
            fn: (p) => p.types.includes('Creature') && _creatureSubs.some(s => p.subtypes.includes(s)),
            desc: `Applies to: ${_creatureSubs.join(' OR ')}`,
          };
        }
        if (_landSubs.length > 0 && _creatureSubs.length === 0) {
          return {
            fn: (p) => _landSubs.some(s => p.subtypes.includes(s)),
            desc: `Applies to: ${_landSubs.join(' OR ')} (land subtypes)`,
          };
        }
      }
    }
  }

  // --- OR conditions: "Islands and Leviathans", "Elves and Goblins" ---
  // Also handles compound filters with trailing qualifiers:
  //   "non-Equipment artifact and non-Aura enchantment with mana value 4 or greater"
  //   → the "with ..." qualifier applies to the whole compound, not just the last part
  if (f.includes(' and ') && !f.includes(' and have') && !f.includes(' and get') && !f.includes(' and gain')) {
    // Extract trailing "with mana value/power/toughness N or greater/less" before splitting
    const trailingQualifier = f.match(/\s+with\s+(?:mana\s+value|converted\s+mana\s+cost|power|toughness)\s+\d+\s+or\s+(?:greater|more|less|fewer)$/);
    const baseF = trailingQualifier ? f.substring(0, trailingQualifier.index) : f;
    const parts = baseF.split(/\s+and\s+/);
    if (parts.length === 2) {
      const a = buildAppliesToFromText(parts[0]);
      const b = buildAppliesToFromText(parts[1]);
      if (!a.isFallback && !b.isFallback) {
        let combinedFn = (p) => a.fn(p) || b.fn(p);
        let combinedDesc = `${a.desc.replace('Applies to: ', '')} OR ${b.desc.replace('Applies to: ', '')}`;
        // If there was a trailing qualifier, wrap the combined filter with it
        if (trailingQualifier) {
          const qualText = trailingQualifier[0].trim();
          const mvMatch = qualText.match(/with\s+(?:mana\s+value|converted\s+mana\s+cost)\s+(\d+)\s+or\s+(greater|more|less|fewer)/);
          const pwMatch = qualText.match(/with\s+power\s+(\d+)\s+or\s+(greater|more|less|fewer)/);
          const thMatch = qualText.match(/with\s+toughness\s+(\d+)\s+or\s+(greater|more|less|fewer)/);
          const innerFn = combinedFn;
          if (mvMatch) {
            const val = parseInt(mvMatch[1]);
            const isGreater = /greater|more/.test(mvMatch[2]);
            combinedFn = (p) => innerFn(p) && (isGreater ? (p.manaValue || 0) >= val : (p.manaValue || 0) <= val);
            combinedDesc += ` with mana value ${isGreater ? val + '+' : val + '-'}`;
          } else if (pwMatch) {
            const val = parseInt(pwMatch[1]);
            const isGreater = /greater|more/.test(pwMatch[2]);
            combinedFn = (p) => innerFn(p) && p.power !== null && p.power !== undefined && (isGreater ? p.power >= val : p.power <= val);
            combinedDesc += ` with power ${isGreater ? val + '+' : val + '-'}`;
          } else if (thMatch) {
            const val = parseInt(thMatch[1]);
            const isGreater = /greater|more/.test(thMatch[2]);
            combinedFn = (p) => innerFn(p) && p.toughness !== null && p.toughness !== undefined && (isGreater ? p.toughness >= val : p.toughness <= val);
            combinedDesc += ` with toughness ${isGreater ? val + '+' : val + '-'}`;
          }
        }
        return {
          fn: combinedFn,
          desc: `Applies to: ${combinedDesc}`,
        };
      }
    }
  }

  // --- OR with "or": "Elves or Goblins" ---
  if (f.includes(' or ') && !f.includes('more or') && !/\d+\s+or\s+(?:greater|more|less|fewer)/i.test(f)) {
    const parts = f.split(/\s+or\s+/);
    if (parts.length === 2) {
      const a = buildAppliesToFromText(parts[0]);
      const b = buildAppliesToFromText(parts[1]);
      if (!a.isFallback && !b.isFallback) {
        return {
          fn: (p) => a.fn(p) || b.fn(p),
          desc: `Applies to: ${a.desc.replace('Applies to: ', '')} OR ${b.desc.replace('Applies to: ', '')}`,
        };
      }
    }
  }

  // --- Power/toughness filters: "creatures with power 4 or greater" ---
  const powerFilter = f.match(/^(.+?)\s+with\s+power\s+(\d+)\s+or\s+(?:greater|more)$/);
  if (powerFilter) {
    const baseFilter = buildAppliesToFromText(powerFilter[1]);
    const minPower = parseInt(powerFilter[2]);
    return {
      fn: (p) => baseFilter.fn(p) && p.power !== null && p.power !== undefined && p.power >= minPower,
      desc: `Applies to: ${baseFilter.desc.replace('Applies to: ', '')} with power ${minPower}+`,
    };
  }
  const toughnessFilter = f.match(/^(.+?)\s+with\s+toughness\s+(\d+)\s+or\s+(?:greater|more)$/);
  if (toughnessFilter) {
    const baseFilter = buildAppliesToFromText(toughnessFilter[1]);
    const minToughness = parseInt(toughnessFilter[2]);
    return {
      fn: (p) => baseFilter.fn(p) && p.toughness !== null && p.toughness !== undefined && p.toughness >= minToughness,
      desc: `Applies to: ${baseFilter.desc.replace('Applies to: ', '')} with toughness ${minToughness}+`,
    };
  }
  // --- Mana value filters: "artifacts with mana value 3 or greater" ---
  const manaValueFilter = f.match(/^(.+?)\s+with\s+(?:mana\s+value|converted\s+mana\s+cost)\s+(\d+)\s+or\s+(?:greater|more)$/);
  if (manaValueFilter) {
    const baseFilter = buildAppliesToFromText(manaValueFilter[1]);
    const minMV = parseInt(manaValueFilter[2]);
    return {
      fn: (p) => baseFilter.fn(p) && (p.manaValue || 0) >= minMV,
      desc: `Applies to: ${baseFilter.desc.replace('Applies to: ', '')} with mana value ${minMV}+`,
    };
  }
  const manaValueLessFilter = f.match(/^(.+?)\s+with\s+(?:mana\s+value|converted\s+mana\s+cost)\s+(\d+)\s+or\s+(?:less|fewer)$/);
  if (manaValueLessFilter) {
    const baseFilter = buildAppliesToFromText(manaValueLessFilter[1]);
    const maxMV = parseInt(manaValueLessFilter[2]);
    return {
      fn: (p) => baseFilter.fn(p) && (p.manaValue || 0) <= maxMV,
      desc: `Applies to: ${baseFilter.desc.replace('Applies to: ', '')} with mana value ${maxMV}-`,
    };
  }

  // --- "with no abilities" filter: "creatures with no abilities" ---
  const noAbilitiesFilter = f.match(/^(.+?)\s+with\s+no\s+abilit(?:y|ies)$/);
  if (noAbilitiesFilter) {
    const baseFilter = buildAppliesToFromText(noAbilitiesFilter[1]);
    return {
      fn: (p) => baseFilter.fn(p) && p.abilities.length === 0,
      desc: `Applies to: ${baseFilter.desc.replace('Applies to: ', '')} with no abilities`,
    };
  }

  // --- Counter filters: "creatures with a +1/+1 counter on it/them" ---
  const counterFilter = f.match(/^(.+?)\s+with\s+(?:(?:a|an)\s+)?([\w+/]+)\s+counter(?:s)?\s+on\s+(?:it|them)$/);
  if (counterFilter) {
    const baseFilter = buildAppliesToFromText(counterFilter[1]);
    const counterType = counterFilter[2];
    return {
      fn: (p) => baseFilter.fn(p) && p.counters && p.counters[counterType] && p.counters[counterType] > 0,
      desc: `Applies to: ${baseFilter.desc.replace('Applies to: ', '')} with ${counterType} counters`,
    };
  }

  // --- Keyword ability filters: "creatures with flying", "creatures with haste" ---
  // Matches "with [keyword]" where keyword is a recognized MTG keyword ability.
  const FILTER_KEYWORDS = new Set([
    'flying', 'first strike', 'double strike', 'deathtouch', 'haste',
    'hexproof', 'indestructible', 'lifelink', 'menace', 'reach',
    'trample', 'vigilance', 'flash', 'defender', 'fear', 'intimidate',
    'shroud', 'wither', 'infect', 'prowess', 'shadow', 'horsemanship',
    'flanking', 'phasing', 'banding', 'undying', 'persist', 'skulk',
    'changeling', 'partner', 'decayed', 'training', 'toxic',
  ]);
  const withKeywordFilter = f.match(/^(.+?)\s+with\s+(.+)$/);
  if (withKeywordFilter) {
    const kwCandidate = withKeywordFilter[2].toLowerCase().trim();
    if (FILTER_KEYWORDS.has(kwCandidate)) {
      const baseFilter = buildAppliesToFromText(withKeywordFilter[1]);
      const kw = kwCandidate;
      return {
        fn: (p) => baseFilter.fn(p) && p.abilities.some(a => a.toLowerCase().trim() === kw),
        desc: `Applies to: ${baseFilter.desc.replace('Applies to: ', '')} with ${kw}`,
      };
    }
  }

  // --- Complex multi-qualifier: "non-human artifact enchantment creatures" ---
  // Tokenize the filter and build a set of required types, subtypes, and negations
  const words = f.split(/\s+/);
  const requiredTypes = [];
  const requiredSubtypes = [];
  const requiredSupertypes = [];
  const requiredColors = [];
  const requiredTraits = [];
  const negatedTypes = [];
  const negatedSubtypes = [];
  const negatedSupertypes = [];
  const negatedColors = [];
  let requireNontoken = false;
  let requireToken = false;
  let requireCommander = false;
  let requireTapped = false;
  let requireUntapped = false;
  let baseTypeWord = null;
  let hasNegation = false;
  const FILTER_COLOR_MAP = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

  for (let i = 0; i < words.length; i++) {
    let word = words[i].replace(/,$/, ''); // strip trailing commas ("noncreature," → "noncreature")
    if (!word) continue;
    let isNeg = false;

    // Detect "non-" or "non" prefix
    if (word.startsWith('non-') || word.startsWith('non')) {
      const afterNon = word.startsWith('non-') ? word.slice(4) : word.slice(3);
      if (afterNon === 'token' || afterNon === 'tokens') { requireNontoken = true; continue; }
      if (afterNon.length > 0) {
        word = afterNon;
        isNeg = true;
        hasNegation = true;
      }
    }

    const singular = word.replace(/s$/, '');
    const typeInfo = CARD_TYPE_WORDS[word] || CARD_TYPE_WORDS[singular];
    const landSub = LAND_SUBTYPE_WORDS[word] || LAND_SUBTYPE_WORDS[singular];
    const cap = word.charAt(0).toUpperCase() + word.slice(1);

    if (typeInfo) {
      if (typeInfo.check === 'any') {
        baseTypeWord = 'any';
      } else if (isNeg) {
        negatedTypes.push(typeInfo.value);
      } else {
        // Last type word is the "base type" (e.g. "artifact enchantment creatures" — Creature is base)
        baseTypeWord = typeInfo.value;
        requiredTypes.push(typeInfo.value);
      }
    } else if (landSub) {
      if (isNeg) negatedSubtypes.push(landSub);
      else requiredSubtypes.push(landSub);
    } else if (word === 'nontoken' || singular === 'nontoken') {
      requireNontoken = true;
    } else if (word === 'token' || singular === 'token') {
      requireToken = true;
    } else if (word === 'commander' || word === 'commanders') {
      requireCommander = true;
    } else if (['basic', 'legendary', 'snow', 'world'].includes(singular)) {
      if (isNeg) negatedSupertypes.push(cap);
      else requiredSupertypes.push(cap);
    } else if (FILTER_COLOR_MAP[singular]) {
      // Color words: "white", "blue", "black", "red", "green"
      if (isNeg) negatedColors.push(FILTER_COLOR_MAP[singular]);
      else requiredColors.push(FILTER_COLOR_MAP[singular]);
    } else if (word === 'attacking' || word === 'attackers' || word === 'attacker') {
      // Trait-based filter: creature has 'Attacking' trait (set by toggleAttacking)
      requiredTraits.push('Attacking');
    } else if (word === 'blocking' || word === 'blockers' || word === 'blocker') {
      // Trait-based filter: creature has 'Blocking' trait (set by toggleBlocking)
      requiredTraits.push('Blocking');
    } else if (word === 'enchanted') {
      requiredTraits.push('Enchanted');
    } else if (word === 'equipped') {
      requiredTraits.push('Equipped');
    } else if (word === 'tapped') {
      requireTapped = true;
    } else if (word === 'untapped') {
      requireUntapped = true;
    } else {
      // Assume creature subtype
      const subtype = singularizeCreatureType(word);
      const knownGenerics = ['creature', 'permanent', 'land', 'artifact', 'enchantment',
        'a', 'an', 'the', 'each', 'every', 'all', 'those', 'these', 'that', 'also',
        'are', 'is', 'has', 'have', 'with', 'or', 'and', 'its', 'their', 'other',
        'it', 'they', 'was', 'were', 'been', 'being'];
      if (!knownGenerics.includes(singular) && !knownGenerics.includes(word)) {
        if (isNeg) negatedSubtypes.push(subtype);
        else requiredSubtypes.push(subtype);
      }
    }
  }

  // --- "nonbasic lands" / "non-basic lands" ---
  const nonMatch = f.match(/^non-?(\w+)\s+(\w+)s?$/);
  if (nonMatch && requiredTypes.length <= 1 && requiredSubtypes.length === 0) {
    const negated = nonMatch[1].charAt(0).toUpperCase() + nonMatch[1].slice(1);
    const baseWord = nonMatch[2].toLowerCase();
    const typeInfo = CARD_TYPE_WORDS[baseWord] || CARD_TYPE_WORDS[baseWord + 's'];
    if (typeInfo && typeInfo.check === 'type' && negated.toLowerCase() !== 'token') {
      // "token" is excluded here: tokens are identified by p.isToken, not by a card type
      // named "Token". "nontoken creatures" must fall through to the nontokenMatch path.
      // Materialized creature subtypes (Changeling) participate naturally in p.subtypes.
      // A color word ("nonblack creatures") is never a type/supertype/subtype, so it must
      // be excluded by p.colors instead — otherwise the filter excludes nothing and the
      // effect wrongly applies to every permanent of that card type.
      const COLOR_LETTERS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
      const negColor = COLOR_LETTERS[negated.toLowerCase()];
      if (negColor) {
        return {
          fn: (p) => p.types.includes(typeInfo.value) && !(p.colors || []).includes(negColor),
          desc: `Applies to: non-${negated.toLowerCase()} ${typeInfo.value}s`,
        };
      }
      return {
        fn: (p) => p.types.includes(typeInfo.value) && !p.supertypes.includes(negated) && !p.types.includes(negated) && !p.subtypes.includes(negated),
        desc: `Applies to: non-${negated} ${typeInfo.value}s`,
      };
    }
  }

  // --- "nontoken creatures" ---
  const nontokenMatch = f.match(/^nontoken\s+(\w+)s?$/);
  if (nontokenMatch && requiredSubtypes.length === 0) {
    const baseWord = nontokenMatch[1].toLowerCase();
    const typeInfo = CARD_TYPE_WORDS[baseWord] || CARD_TYPE_WORDS[baseWord + 's'];
    if (typeInfo && typeInfo.check === 'type') {
      return {
        fn: (p) => p.types.includes(typeInfo.value) && !p.isToken,
        desc: `Applies to: nontoken ${typeInfo.value}s`,
      };
    }
  }

  // If we parsed multiple qualifiers, build a composite filter
  if (requiredTypes.length > 0 || requiredSubtypes.length > 0 || requiredSupertypes.length > 0 ||
      requiredColors.length > 0 || negatedColors.length > 0 || requiredTraits.length > 0 ||
      negatedTypes.length > 0 || negatedSubtypes.length > 0 || negatedSupertypes.length > 0 || requireNontoken || requireToken || requireCommander || requireTapped || requireUntapped) {
    const checks = [];
    const descParts = [];

    for (const t of requiredTypes) {
      checks.push((p) => p.types.includes(t));
      descParts.push(t);
    }
    for (const sup of requiredSupertypes) {
      checks.push((p) => p.supertypes.includes(sup));
      descParts.push(sup);
    }
    for (const c of requiredColors) {
      checks.push((p) => (p.colors || []).includes(c));
      descParts.push(c);
    }
    for (const c of negatedColors) {
      checks.push((p) => !(p.colors || []).includes(c));
      descParts.push(`non-${c}`);
    }
    for (const s of requiredSubtypes) {
      // All subtypes are checked uniformly: Changeling-granted creature types are
      // materialized into p.subtypes by the engine, so no flag check is needed.
      checks.push((p) => p.subtypes.includes(s));
      descParts.push(s);
    }
    for (const t of negatedTypes) {
      checks.push((p) => !p.types.includes(t));
      descParts.push(`non-${t}`);
    }
    for (const s of negatedSubtypes) {
      checks.push((p) => !p.subtypes.includes(s));
      descParts.push(`non-${s}`);
    }
    for (const s of negatedSupertypes) {
      checks.push((p) => !p.supertypes.includes(s));
      descParts.push(`non-${s}`);
    }
    for (const trait of requiredTraits) {
      checks.push((p) => (p.traits || []).includes(trait));
      descParts.push(trait.toLowerCase());
    }
    if (requireNontoken) {
      checks.push((p) => !p.isToken);
      descParts.push('nontoken');
    }
    if (requireToken) {
      checks.push((p) => p.isToken);
      descParts.push('token');
    }
    if (requireCommander) {
      checks.push((p) => p.isCommander);
      descParts.push('commander');
    }
    if (requireTapped) {
      checks.push((p) => p.tapped === true);
      descParts.push('tapped');
    }
    if (requireUntapped) {
      checks.push((p) => p.tapped === false);
      descParts.push('untapped');
    }

    if (checks.length > 0) {
      return {
        fn: (p) => checks.every(check => check(p)),
        desc: `Applies to: ${descParts.join(' ')}`,
      };
    }
  }

  // --- Simple single type word ---
  const singleWord = f.replace(/s$/, '');
  const typeInfo = CARD_TYPE_WORDS[f] || CARD_TYPE_WORDS[singleWord];
  if (typeInfo) {
    if (typeInfo.check === 'any') {
      return { fn: () => true, desc: 'Applies to: all permanents' };
    }
    return {
      fn: (p) => p.types.includes(typeInfo.value),
      desc: `Applies to: ${typeInfo.value}s`,
    };
  }

  // --- Simple land subtype ---
  const landSub = LAND_SUBTYPE_WORDS[f] || LAND_SUBTYPE_WORDS[singleWord];
  if (landSub) {
    return {
      fn: (p) => p.subtypes.includes(landSub),
      desc: `Applies to: ${landSub}s (land subtype)`,
    };
  }

  // "[Subtype] creatures" / "[Subtype]s" / "[Subtype] [Subtype] creatures"
  const subtypeCreatureMatch = f.match(/^(\w+)\s+creatures?$/);
  const knownGenerics = ['creature', 'permanent', 'land', 'artifact', 'enchantment'];
  if (subtypeCreatureMatch && !knownGenerics.includes(subtypeCreatureMatch[1])) {
    const sub = subtypeCreatureMatch[1];
    const maybeLand = LAND_SUBTYPE_WORDS[sub] || LAND_SUBTYPE_WORDS[sub + 's'];
    if (maybeLand) {
      return {
        fn: (p) => p.subtypes.includes(maybeLand),
        desc: `Applies to: ${maybeLand}s (land subtype)`,
      };
    }
    const subtype = singularizeCreatureType(sub);
    return {
      fn: (p) => p.types.includes('Creature') && p.subtypes.includes(subtype),
      desc: `Applies to: ${subtype} creatures`,
    };
  }

  // Bare subtype word: "elves", "zombies", "merfolk"
  // Use the full word for singularization (irregular plurals like "elves" need the full form)
  if (f.match(/^\w+$/) && !knownGenerics.includes(f) && !knownGenerics.includes(f.replace(/s$/, ''))) {
    const maybeLand = LAND_SUBTYPE_WORDS[f] || LAND_SUBTYPE_WORDS[f.replace(/s$/, '')];
    if (maybeLand) {
      return {
        fn: (p) => p.subtypes.includes(maybeLand),
        desc: `Applies to: ${maybeLand}s (land subtype)`,
      };
    }
    const subtype = singularizeCreatureType(f);
    return {
      fn: (p) => p.types.includes('Creature') && p.subtypes.includes(subtype),
      desc: `Applies to: ${subtype} creatures`,
    };
  }

  return {
    fn: (p) => p.types.includes('Creature'),
    desc: 'Applies to: all creatures',
    isFallback: true,
  };
}

function parseBecomesType(text) {
  const t = text.trim().replace(/\.$/, '');

  // Special case: "all basic land types" or "every basic land type" -> all 5 subtypes
  if (/\ball\s+basic\s+land\s+types?\b/i.test(t) || /\bevery\s+basic\s+land\s+type\b/i.test(t)) {
    return { types: ['Land'], subtypes: ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'], isLandSubtype: true, grantedAbilities: [] };
  }
  if (/\b(?:all|every)\s+land\s+types?\b/i.test(t)) {
    return { types: [], subtypes: [], isLandSubtype: true, gainsAllLandTypes: true, grantedAbilities: [] };
  }
  if (/\b(?:all|every)\s+creature\s+types?\b/i.test(t)) {
    return { types: [], subtypes: [], isLandSubtype: false, gainsAllCreatureTypes: true, grantedAbilities: [] };
  }

  // Split on "with" to separate type info from granted abilities.
  // "1/1 green Insect creature with flying and trample" -> types+subtypes | abilities
  const withIdx = t.search(/\bwith\b/i);
  const typePart = withIdx >= 0 ? t.substring(0, withIdx).trim() : t;
  const withPart = withIdx >= 0 ? t.substring(withIdx + 4).trim() : '';

  const words = typePart.split(/\s+/);
  const types = [];
  const subtypes = [];
  const supertypes = [];
  let isLandSubtype = false;
  const grantedAbilities = [];

  // CR 205.4: supertypes ("legendary Soldier", "basic Forest", "snow land").
  const SUPERTYPE_WORDS = { legendary: 'Legendary', basic: 'Basic', snow: 'Snow', world: 'World' };

  for (const word of words) {
    const w = word.toLowerCase();
    if (['a', 'an', 'the', 'and', 'that', 'are', 'is', 'it', 'they'].includes(w)) continue;
    if (/^\d+\/\d+$/.test(w)) continue;
    if (/^\d+$/.test(w)) continue;
    if (SUPERTYPE_WORDS[w]) { if (!supertypes.includes(SUPERTYPE_WORDS[w])) supertypes.push(SUPERTYPE_WORDS[w]); continue; }
    const ct = CARD_TYPE_WORDS[w];
    if (ct && ct.check === 'type') { types.push(ct.value); continue; }
    const ls = LAND_SUBTYPE_WORDS[w];
    if (ls) { subtypes.push(ls); isLandSubtype = true; continue; }
    const cap = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    if (cap.length > 1 && !['In', 'To', 'Of', 'Their', 'Its', 'Other', 'Still', 'Also',
        'Addition', 'Types', 'Type', 'All', 'Each', 'Every', 'Basic', 'Nonbasic',
        'Non', 'Control', 'You', 'Your', 'Colors', 'Color', 'Mana', 'Any',
        'Has', 'Have', 'Gains', 'Gain', 'Gets', 'Get', 'Loses', 'Lose',
        'Abilities', 'Ability', 'Plus', 'Except', 'But', 'Not', 'No',
        'They', 'Them', 'These', 'Those', 'This', 'That', 'Same',
        'Colorless', 'White', 'Blue', 'Black', 'Red', 'Green',
        'Named', 'Called', 'Chosen', 'Target',
        // Keyword abilities should not be treated as subtypes
        'Flying', 'Lifelink', 'Deathtouch', 'Menace', 'Trample', 'Vigilance',
        'Haste', 'Hexproof', 'Indestructible', 'Reach', 'Defender', 'Flash',
        'Fear', 'Intimidate', 'Shroud', 'Wither', 'Infect', 'Prowess',
        'Ward', 'Shadow', 'Horsemanship', 'Undying', 'Persist', 'Decayed',
        'First', 'Double', 'Strike', 'Protection', 'From',
        'Commander', 'Commanders'].includes(cap)) {
      const singular = singularizeCreatureType(word);
      if (!subtypes.includes(singular)) subtypes.push(singular);
    }
  }
  if (isLandSubtype && !types.includes('Land')) {
    types.push('Land');
  }

  // Parse abilities from "with [abilities]" portion
  if (withPart) {
    if (/^no\s+abilit/i.test(withPart)) {
      grantedAbilities.push('__NO_ABILITIES__'); // sentinel for "with no abilities"
    } else {
      // Extract quoted abilities (allow apostrophes inside)
      const quotedMatch = withPart.match(/[""\u201c]((?:[^""\u201d]|'(?!(?:\s|$|,)))*)[""\u201d]/g);
      if (quotedMatch) {
        for (const q of quotedMatch) {
          grantedAbilities.push(q.replace(/^[""\u201c]|[""\u201d]$/g, '').trim());
        }
      }
      // Keyword abilities: "with flying, vigilance, and first strike"
      const kwText = withPart.replace(/[""\u201c](?:[^""\u201d]|'(?!(?:\s|$|,)))*[""\u201d]/g, '').trim();
      if (kwText) {
        // Handle "base power and toughness X/Y" — not an ability
        const cleaned = kwText.replace(/base\s+power\s+and\s+toughness\s+\d+\/\d+/i, '')
                              .replace(/power\s+and\s+toughness\s+\d+\/\d+/i, '').trim();
        if (cleaned) {
          const parts = cleaned.split(/\s*,\s*|\s+and\s+/i).filter(Boolean);
          for (const p of parts) {
            const trimmed = p.trim();
            if (trimmed) {
              // Capitalize each word: "first strike" — "First Strike"
              const capitalized = trimmed.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              grantedAbilities.push(capitalized);
            }
          }
        }
      }
    }
  }

  // Validate subtypes against Scryfall's TypeCatalog: filter out words that aren't
  // real MTG subtypes. This catches parser noise like "that's" or other misidentified words.
  const validatedSubtypes = (typeof TypeCatalog !== 'undefined' && TypeCatalog.loaded)
    ? [...new Set(subtypes)].filter(s => TypeCatalog.classifySubtype(s) !== 'unknown')
    : [...new Set(subtypes)];

  return { types: [...new Set(types)], subtypes: validatedSubtypes, supertypes: [...new Set(supertypes)], isLandSubtype, grantedAbilities };
}
/* Build an aura restriction function from "Enchant [type(s)]" text.
   Supports any combination of permanent types joined by "or", "and/or", or commas.
   Handles negation: "nonland permanent" = any permanent that is NOT a Land.
   Returns null if the target cannot be a battlefield permanent (e.g. "player"). */
function buildAuraRestriction(enchantTarget) {
  const t = enchantTarget.toLowerCase();
  if (/\bplayer\b/.test(t) && !/\b(creature|artifact|planeswalker|enchantment|land|permanent)\b/.test(t)) {
    return null; // player-only auras have no permanent-targeting restriction; UI handles player picker
  }
  // Detect "non[type] permanent" patterns: "nonland permanent", "noncreature permanent", etc.
  const NON_TYPE_MAP = { nonland: 'Land', noncreature: 'Creature', nonartifact: 'Artifact',
    nonenchantment: 'Enchantment', nonplaneswalker: 'Planeswalker' };
  const excludedTypes = [];
  for (const [word, type] of Object.entries(NON_TYPE_MAP)) {
    if (t.includes(word)) excludedTypes.push(type);
  }
  // Detect "non[color] creature/permanent" patterns: "nonblack creature", "nonwhite permanent", etc.
  const NON_COLOR_MAP = { nonwhite: 'W', nonblue: 'U', nonblack: 'B', nonred: 'R', nongreen: 'G' };
  const excludedColors = [];
  for (const [word, color] of Object.entries(NON_COLOR_MAP)) {
    if (t.includes(word)) excludedColors.push(color);
  }
  if (/\bpermanent\b/.test(t)) {
    if (excludedTypes.length > 0 || excludedColors.length > 0) {
      return (p) => !excludedTypes.some(ex => p.types.includes(ex))
        && !excludedColors.some(ec => (p.colors || []).includes(ec));
    }
    return () => true;
  }
  // Handle "or" disjunction: "creature or Vehicle", "artifact or enchantment"
  if (/\bor\b/.test(t) && !excludedTypes.length && !excludedColors.length) {
    const orParts = t.split(/\s+or\s+/).map(s => s.trim()).filter(Boolean);
    if (orParts.length >= 2) {
      const subRestrictions = orParts.map(part => buildAuraRestriction(part)).filter(Boolean);
      if (subRestrictions.length >= 2) {
        return (p) => subRestrictions.some(r => r(p));
      }
      if (subRestrictions.length === 1) return subRestrictions[0];
    }
  }
  // Collect all type keywords present in the target string
  const TYPE_CHECKS = [
    ['Creature',     /\bcreature\b/],
    ['Artifact',     /\bartifact\b/],
    ['Enchantment',  /\bench[a-z]*ment\b/],
    ['Land',         /\bland\b/],
    ['Planeswalker', /\bplaneswalker\b/],
    ['Battle',       /\bbattle\b/],
  ];
  const required = TYPE_CHECKS.filter(([, rx]) => rx.test(t)).map(([type]) => type);
  // Remove types that appear in "non" form (e.g. "nonland" matched Land but we don't want to require it)
  const filtered = required.filter(r => !excludedTypes.includes(r));
  
  // Check for subtype-based restrictions: "Enchant Human", "Enchant Vehicle", "Enchant Goblin", etc.
  // Extract words from the enchant target that aren't card types, non-prefixes, or articles
  const SKIP_WORDS = new Set(['a', 'an', 'the', 'or', 'and', 'with', 'you', 'control',
    'creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'permanent', 'battle',
    'nonland', 'noncreature', 'nonartifact', 'nonenchantment', 'nonplaneswalker',
    'nonwhite', 'nonblue', 'nonblack', 'nonred', 'nongreen', 'player', 'opponent']);
  const words = t.split(/\s+/);
  const requiredSubtypes = [];
  for (const word of words) {
    const clean = word.replace(/[^a-z]/g, '');
    if (!clean || SKIP_WORDS.has(clean)) continue;
    // Skip color words
    if (['white', 'blue', 'black', 'red', 'green'].includes(clean)) continue;
    // Check if it could be a subtype (creature type, land type, etc.)
    const capWord = clean.charAt(0).toUpperCase() + clean.slice(1);
    // Check known creature types
    if (typeof TypeCatalog !== 'undefined' && TypeCatalog.creatureTypes.size > 0) {
      if (TypeCatalog.creatureTypes.has(capWord)) {
        requiredSubtypes.push(capWord);
        continue;
      }
      // Also try singularized form
      const singular = singularizeCreatureType(clean);
      if (TypeCatalog.creatureTypes.has(singular)) {
        requiredSubtypes.push(singular);
        continue;
      }
    }
    // Check known land types
    if (typeof TypeCatalog !== 'undefined' && TypeCatalog.getSubtypeCategory) {
      const landTypes = TypeCatalog.getSubtypeCategory('land');
      if (landTypes.has(capWord)) {
        requiredSubtypes.push(capWord);
        continue;
      }
    }
    // Check common subtypes that might not be in TypeCatalog yet
    const KNOWN_SUBTYPES = ['Vehicle', 'Equipment', 'Aura', 'Saga', 'Food', 'Treasure',
      'Blood', 'Clue', 'Map', 'Powerstone', 'Shrine', 'Cartouche', 'Curse', 'Rune'];
    if (KNOWN_SUBTYPES.includes(capWord)) {
      requiredSubtypes.push(capWord);
      continue;
    }
    // If the word isn't a known type and isn't in the skip list, treat it as a potential subtype
    // This handles future creature types and edge cases
    if (!filtered.length && capWord.length > 2 && /^[A-Z][a-z]+$/.test(capWord)) {
      requiredSubtypes.push(capWord);
    }
  }
  
  if (!filtered.length && !excludedTypes.length && !excludedColors.length && !requiredSubtypes.length) return null;
  // Build combined restriction
  const checks = [];
  if (filtered.length === 1) {
    checks.push((p) => p.types.includes(filtered[0]));
  } else if (filtered.length > 1) {
    checks.push((p) => filtered.some(type => p.types.includes(type)));
  } else if (excludedTypes.length > 0) {
    checks.push((p) => !excludedTypes.some(ex => p.types.includes(ex)));
  }
  if (excludedColors.length > 0) {
    checks.push((p) => !excludedColors.some(ec => (p.colors || []).includes(ec)));
  }
  if (requiredSubtypes.length > 0) {
    checks.push((p) => requiredSubtypes.every(st => (p.subtypes || []).includes(st)));
  }
  if (checks.length === 0) return null;
  if (checks.length === 1) return checks[0];
  return (p) => checks.every(check => check(p));
}

/* Evaluate a simple condition from a triggered ability's "if [condition]," prefix at fire time.
   Returns true/false if the condition is known and evaluable, null if unknown (don't block). */
function _evaluateTriggerCondition(condText, sourceState) {
  const ct = condText.toLowerCase().trim();
  const traits = sourceState ? (sourceState.traits || []) : [];
  if (/\bis monstrous\b/.test(ct)) return traits.includes('Monstrous');
  if (/\bisn'?t monstrous\b|\bis not monstrous\b/.test(ct)) return !traits.includes('Monstrous');
  if (/\bis saddled\b/.test(ct)) return traits.includes('Saddled');
  if (/\bisn'?t saddled\b|\bis not saddled\b/.test(ct)) return !traits.includes('Saddled');
  if (/\bis crewed\b/.test(ct)) return traits.includes('Crewed');
  if (/\bisn'?t crewed\b|\bis not crewed\b/.test(ct)) return !traits.includes('Crewed');
  if (/\b(?:it(?:'s| is)\s+your\s+turn|during\s+your\s+turn|on\s+your\s+turn)\b/.test(ct)) {
    return (typeof Battlefield !== 'undefined' && Battlefield.gameState) ? Battlefield.gameState.isYourTurn : null;
  }
  if (/\b(?:it(?:'s| is)\s+not\s+your\s+turn|not\s+your\s+turn)\b/.test(ct)) {
    return (typeof Battlefield !== 'undefined' && Battlefield.gameState) ? !Battlefield.gameState.isYourTurn : null;
  }
  if (/\byou\s+have\s+the\s+initiative\b/.test(ct)) {
    return (typeof Battlefield !== 'undefined' && Battlefield.gameState) ? !!Battlefield.gameState.hasInitiative : null;
  }
  if (/\byou(?:'re| are)\s+the\s+monarch\b/.test(ct)) {
    return (typeof Battlefield !== 'undefined' && Battlefield.gameState) ? !!Battlefield.gameState.isMonarch : null;
  }
  // "if she was a nonland creature" (Princess Yue): only qualifies while the source is
  // a creature that isn't a land. Once she's already a land, the trigger does nothing.
  if (/\bnonland\s+creature\b/.test(ct)) {
    const types = sourceState ? (sourceState.types || []) : [];
    return types.includes('Creature') && !types.includes('Land');
  }
  return null; // unknown condition — don't block firing
}
