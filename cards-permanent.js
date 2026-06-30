/* cards-permanent.js — permanent factory, card-face resolution, special card types
   (saga, class, leveler, spacecraft), oracle text preprocessing helpers. */

/* [KEY: PERMANENT] */
let _permIdCounter = 0;
function _escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* Layouts where only one face is active at a time (transformable) */
const TRANSFORMABLE_LAYOUTS = new Set(['transform', 'modal_dfc', 'reversible_card']);

/* Layouts where the user picks one half to play (split cards, aftermath, adventure) */
const CHOOSEABLE_FACE_LAYOUTS = new Set(['split', 'aftermath', 'adventure']);

/* Compute CMC from a mana cost string like "{2}{G}" → 3.
   Handles generic numbers, variable (X=0), twobrid ({2/W}=2), and all pip symbols (=1 each). */
function _cmcFromManaCost(manaCost) {
  if (!manaCost) return 0;
  let total = 0;
  for (const m of manaCost.matchAll(/\{([^}]+)\}/g)) {
    const sym = m[1];
    if (/^\d+$/.test(sym)) {
      total += parseInt(sym);
    } else if (/^[XYZ]$/.test(sym)) {
      // variable mana contributes 0
    } else if (/^\d+\//.test(sym)) {
      total += parseInt(sym.split('/')[0]); // twobrid: {2/W} → 2
    } else {
      total += 1; // colored pip, hybrid, phyrexian, snow, colorless
    }
  }
  return total;
}

/* Resolve card data for the active face of a multi-face card.
   For transform/modal_dfc: returns the active face's data merged with top-level card data.
   For split/adventure: uses the chosen face's data.
   For room: combines both faces' oracle text. */
function _resolveCardFace(card, faceIndex) {
  const faces = card.card_faces;
  if (!faces || faces.length < 2) return card;
  const layout = card.layout || '';

  // Room cards share layout:'split' with split cards but both halves coexist on the battlefield
  const isRoomCard = faces.some(f => (f.type_line || '').includes('Room'));
  if (isRoomCard) {
    const combinedOracle = faces.map(f => f.oracle_text || '').filter(Boolean).join('\n');
    return {
      ...card,
      oracle_text: card.oracle_text || combinedOracle,
      type_line: card.type_line || faces.map(f => f.type_line).filter(Boolean).join(' // '),
      mana_cost: card.mana_cost || faces.map(f => f.mana_cost || '').filter(Boolean).join(' // '),
      image_uris: card.image_uris || (faces[0] && faces[0].image_uris) || null,
      _isFaceResolved: true,
    };
  }

  if (TRANSFORMABLE_LAYOUTS.has(layout)) {
    // Transform/MDFC: use the specified face's data
    const face = faces[faceIndex] || faces[0];
    return {
      ...card,
      name: face.name || card.name,
      oracle_text: face.oracle_text || '',
      type_line: face.type_line || card.type_line || '',
      power: face.power,
      toughness: face.toughness,
      colors: face.colors || card.colors || [],
      mana_cost: face.mana_cost || '',
      image_uris: face.image_uris || card.image_uris || null,
      _activeFace: faceIndex,
      _isFaceResolved: true,
    };
  }
  
  if (layout === 'battle') {
    // Battles: front face is the battle, back face is what it transforms into
    const face = faces[faceIndex] || faces[0];
    return {
      ...card,
      name: faceIndex === 0 ? card.name : face.name || card.name,
      oracle_text: face.oracle_text || '',
      type_line: face.type_line || card.type_line || '',
      power: face.power,
      toughness: face.toughness,
      colors: face.colors || card.colors || [],
      mana_cost: face.mana_cost || card.mana_cost || '',
      image_uris: face.image_uris || card.image_uris || null,
      _activeFace: faceIndex,
      _isFaceResolved: true,
    };
  }

  // Chooseable-face (split/aftermath): use the specific face's data like transform
  if (CHOOSEABLE_FACE_LAYOUTS.has(layout)) {
    const face = faces[faceIndex] || faces[0];
    return {
      ...card,
      name: face.name || card.name,
      oracle_text: face.oracle_text || '',
      type_line: face.type_line || card.type_line || '',
      power: face.power,
      toughness: face.toughness,
      colors: face.colors || card.colors || [],
      mana_cost: face.mana_cost || '',
      image_uris: card.image_uris || face.image_uris || null,
      _activeFace: faceIndex,
      _isFaceResolved: true,
    };
  }

  // Room (and other fallback layouts): combine oracle text from all faces
  // Use the top-level card data but fill in missing fields from faces
  const combinedOracle = faces.map(f => f.oracle_text || '').filter(Boolean).join('\n');
  const combinedManaCost = faces.map(f => f.mana_cost || '').filter(Boolean).join(' // ');
  return {
    ...card,
    oracle_text: card.oracle_text || combinedOracle,
    type_line: card.type_line || faces.map(f => f.type_line).filter(Boolean).join(' // '),
    mana_cost: card.mana_cost || combinedManaCost,
    image_uris: card.image_uris || (faces[0] && faces[0].image_uris) || null,
    _isFaceResolved: true,
  };
}

function createPermanent(card, timestamp, opts = {}) {
  // Resolve multi-face card data
  const faceIndex = opts.faceIndex || 0;
  const resolvedCard = card._isFaceResolved ? card : _resolveCardFace(card, faceIndex);
  
  const types = parseTypeLine(resolvedCard.type_line || '');
  const isToken = opts.isToken || card.layout === 'token' || card.layout === 'double_faced_token' || false;
  // Replace proper nouns in oracle text that match the card name with "this card"/"this token"
  let oracleText = resolvedCard.oracle_text || '';
  oracleText = _stripReminderText(oracleText);
  oracleText = _replaceProperNounSelfRef(resolvedCard.name, oracleText, isToken);
  
  // For multi-face cards with card_faces, also try replacing the full card name (both faces)
  if (card.card_faces && card.name !== resolvedCard.name) {
    oracleText = _replaceProperNounSelfRef(card.name, oracleText, isToken);
  }
  
  // Detect X in mana cost and prompt for value (handled at addPermanent level)
  const imageUri = resolvedCard.image_uris?.small || resolvedCard.image_uris?.normal || null;
  
  const perm = {
    id: 'perm_' + (++_permIdCounter),
    name: resolvedCard.name,
    timestamp,
    owner: (typeof Battlefield !== 'undefined' ? Battlefield.activePlayerId : 'player_0'),
    controller: (typeof Battlefield !== 'undefined' ? Battlefield.activePlayerId : 'player_0'),
    printedTypes:      types.types,
    printedSupertypes: types.supertypes,
    printedSubtypes:   types.subtypes,
    printedPower:      resolvedCard.power !== undefined ? parseInt(resolvedCard.power) || 0 : null,
    printedToughness:  resolvedCard.toughness !== undefined ? parseInt(resolvedCard.toughness) || 0 : null,
    printedAbilities:  extractAbilities(oracleText),
    printedColors:     resolvedCard.colors || [],
    manaValue:         _cmcFromManaCost(resolvedCard.mana_cost) || resolvedCard.cmc || card.cmc || 0,
    manaCost:          resolvedCard.mana_cost || '',
    oracleText:        oracleText,
    imageUri:          imageUri,
    illustrator:       resolvedCard.artist || card.artist || '',
    isManualEffect:    types.types.includes('Instant') || types.types.includes('Sorcery'),
    isToken:           isToken,
    scryfallData:      card,
    cdaUserValue:      null,
    counters:          {},
    counterTimestamps: {},
    oracleCounterTypes: _extractOracleCounterTypes(resolvedCard.oracle_text || '', types.subtypes, types.types),
  };
  // CR 305.6: basic land subtypes grant intrinsic mana abilities (stripped by Scryfall parentheses)
  _addIntrinsicLandMana(perm.printedAbilities, perm.printedSubtypes);

  // Store multi-face info for transform/flip support
  if (card.card_faces && card.card_faces.length >= 2) {
    const layout = card.layout || '';
    perm.isMultiFace = true;
    perm.cardLayout = layout;
    perm.activeFaceIndex = faceIndex;
    perm.isTransformable = TRANSFORMABLE_LAYOUTS.has(layout) || layout === 'battle';
    const _isRoomCard = card.card_faces.some(f => (f.type_line || '').includes('Room'));
    perm.isChooseableFace = CHOOSEABLE_FACE_LAYOUTS.has(layout) && !_isRoomCard;
    perm.isRoom = _isRoomCard;
    // Store face names for display
    perm.faceNames = card.card_faces.map(f => f.name || '');
    // Store face images
    perm.faceImages = card.card_faces.map(f => f.image_uris?.small || f.image_uris?.normal || null);
    // For non-transformable, non-chooseable, non-room layouts, store that all faces are active
    if (!perm.isTransformable && !perm.isChooseableFace && !perm.isRoom) {
      perm.allFacesActive = true;
    }
    // Store the full card name (e.g. "Commit // Memory") for chooseable-face cards
    if (perm.isChooseableFace) {
      perm.fullCardName = card.name;
    }
    // Room cards: store per-face data and start with both doors locked
    if (perm.isRoom) {
      perm.roomLocked = [true, true];
      perm.roomFaces = card.card_faces.map(f => ({
        name: f.name || '',
        mana_cost: f.mana_cost || '',
        type_line: f.type_line || '',
        oracle_text: f.oracle_text || '',
      }));
      perm.oracleText = '';
      perm.printedAbilities = [];
    }
  }

  // Detect sideways card layouts (Battles, split/Room cards)
  // These cards display their images rotated and need orientation adjustment
  const _layout = card.layout || '';
  if (_layout === 'battle' || _layout === 'split' || _layout === 'planar') {
    perm.isSideways = true;
  }

  // Detect Mutate keyword in oracle text
  if (/\bmutate\b/i.test(resolvedCard.oracle_text || '')) {
    perm.hasMutate = true;
  }

  // Detect Bestow keyword in oracle text (CR 702.102)
  if (/\bbestow\b/i.test(resolvedCard.oracle_text || '')) {
    perm.hasBestow = true;
  }

  // Detect Imprint keyword in oracle text (CR 702.49). The keyword itself does nothing —
  // only the payoff sentences create effects. The flag drives the Imprint button UI.
  if (/^imprint\s*[—\-]/im.test(resolvedCard.oracle_text || '')) {
    perm.hasImprint = true;
  }

  // Detect saga chapter thresholds from ability lines
  // Roman numerals at start of ability lines indicate lore counter requirements
  if (types.subtypes.includes('Saga') && perm.printedAbilities.length > 0) {
    const sagaData = _parseSagaChapters(perm.printedAbilities);
    if (sagaData) {
      perm._sagaChapterThresholds = sagaData.thresholds;
      perm._sagaMaxChapter = sagaData.maxChapter;
    }
  }

  // Detect class level thresholds from ability lines
  // Lines like "{cost}: Level N" indicate level-up boundaries
  if (types.subtypes.includes('Class') && perm.printedAbilities.length > 0) {
    perm._classLevelThresholds = _parseClassLevels(perm.printedAbilities);
    perm.classLevel = 1; // Classes start at level 1
  }

  // Detect leveler (Level up) creatures from ability lines
  // Oracle format: "Level up {cost}" followed by "LEVEL N-M" / "LEVEL N+" brackets
  // Each bracket defines a P/T and optional abilities active only in that level range.
  if (perm.printedAbilities.length > 0 && !perm._classLevelThresholds) {
    perm._levelerData = _parseLevelerLevels(perm.printedAbilities, perm.printedPower, perm.printedToughness);
    if (perm._levelerData) {
      // Auto-add 'level' counter type so counter UI shows it
      if (!perm.oracleCounterTypes.includes('level')) {
        perm.oracleCounterTypes.push('level');
      }
    }
  }

  // Detect spacecraft station abilities from ability lines
  // Oracle format: "N+ | [ability]" lines gated by charge counters >= N (cumulative).
  if (perm.printedAbilities.length > 0 && !perm._classLevelThresholds && !perm._levelerData) {
    perm._spacecraftData = _parseSpacecraftStations(perm.printedAbilities, resolvedCard.oracle_text || '');
    if (perm._spacecraftData) {
      // Auto-add 'charge' counter type so counter UI shows it (station uses charge counters)
      if (!perm.oracleCounterTypes.includes('charge')) {
        perm.oracleCounterTypes.push('charge');
      }
    }
  }
  
  return perm;
}

/* Parse saga chapter roman numerals from ability lines.
   Returns { thresholds: Map<abilityIndex, requiredLoreCounters>, maxChapter: number } or null.
   E.g. "I, II — Draw a card." means indices for that line need lore >= 1 (for I) and lore >= 2 (for II).
   The threshold stored is the MINIMUM lore counters needed (the first roman numeral in the line).
   maxChapter is the HIGHEST roman numeral found across ALL chapter lines (the final chapter). */
function _parseSagaChapters(abilities) {
  const ROMAN_MAP = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10 };
  const thresholds = new Map();
  let maxChapter = 0;
  // Match lines starting with roman numerals like "I —", "I, II —", "III, IV, V —"
  const chapterRegex = /^([IVXLC]+(?:\s*,\s*[IVXLC]+)*)\s*\u2014/;
  for (let i = 0; i < abilities.length; i++) {
    const match = abilities[i].match(chapterRegex);
    if (match) {
      // Parse the roman numerals in the chapter header
      const numerals = match[1].split(',').map(s => s.trim());
      const values = numerals.map(n => ROMAN_MAP[n]).filter(v => v !== undefined);
      if (values.length > 0) {
        // Store the minimum lore counter threshold needed to activate this chapter
        thresholds.set(i, Math.min(...values));
        // Track the highest chapter numeral across all lines
        maxChapter = Math.max(maxChapter, ...values);
      }
    }
  }
  return thresholds.size > 0 ? { thresholds, maxChapter } : null;
}

/* Parse class enchantment level lines from ability lines.
   Returns Map<abilityIndex, requiredLevel> or null.
   Class oracle text has lines like "{2}{U}: Level 2" which mark boundaries.
   Level 1 abilities appear before the first "Level 2" line.
   Level 2 abilities appear between "Level 2" and "Level 3" lines.
   Level 3 abilities appear after "Level 3" line.
   The level-up lines themselves are stored with threshold = the level they grant.
   E.g. "{2}{U}: Level 2" gets threshold = 2 (it's the activation line for level 2). */
function _parseClassLevels(abilities) {
  const thresholds = new Map();
  const levelLineRegex = /^[{][^}]*[}].*:\s*Level\s+(\d+)\s*$/i;
  let currentLevel = 1;
  for (let i = 0; i < abilities.length; i++) {
    const match = abilities[i].match(levelLineRegex);
    if (match) {
      const level = parseInt(match[1], 10);
      // The level-up line itself belongs to the level it grants
      thresholds.set(i, level);
      currentLevel = level;
    } else {
      // Ability line: belongs to currentLevel
      thresholds.set(i, currentLevel);
    }
  }
  return thresholds.size > 0 ? thresholds : null;
}

/* Parse leveler (Level up) creature ability lines.
   Leveler oracle text format:
     Level up {cost}
     LEVEL 1-3
     4/4
     LEVEL 4+
     6/6
     Trample
   Returns object with:
     brackets: array of { min, max, power, toughness, abilityIndices: [] }
     abilityIndexToBracket: Map<abilityIndex, bracketIndex>  (for display active/inactive)
     levelUpLineIndex: index of the "Level up {cost}" line
   Or null if not a leveler card. */
function _parseLevelerLevels(abilities, printedPower, printedToughness) {
  // First line must be "Level up {cost}"
  const levelUpIdx = abilities.findIndex(a => /^Level up\s+\{/i.test(a));
  if (levelUpIdx < 0) return null;

  const levelLineRegex = /^LEVEL\s+(\d+)([+-])(\d*)$/i;
  const ptRegex = /^(\*|\d+)\/(\*|\d+)$/;
  
  const brackets = [];
  // Bracket 0: the base level (level 0, before any LEVEL line)
  // The base P/T is the card's printed P/T, abilities are "Level up {cost}" line only
  brackets.push({
    min: 0, max: 0,
    power: printedPower, toughness: printedToughness,
    abilityIndices: [levelUpIdx], // Level up is always active
  });

  let currentBracket = null;
  const abilityIndexToBracket = new Map();
  // Level up line always belongs to bracket 0
  abilityIndexToBracket.set(levelUpIdx, 0);
  
  for (let i = 0; i < abilities.length; i++) {
    if (i === levelUpIdx) continue; // skip the level up line itself
    
    const levelMatch = abilities[i].match(levelLineRegex);
    if (levelMatch) {
      const minLevel = parseInt(levelMatch[1], 10);
      const op = levelMatch[2]; // '-' for range, '+' for open-ended
      const maxLevel = op === '+' ? Infinity : parseInt(levelMatch[3], 10);
      
      currentBracket = {
        min: minLevel, max: maxLevel,
        power: null, toughness: null,
        abilityIndices: [],
      };
      brackets.push(currentBracket);
      // The LEVEL line itself maps to this bracket
      abilityIndexToBracket.set(i, brackets.length - 1);
      continue;
    }
    
    // If we're inside a bracket, check for P/T line
    if (currentBracket) {
      const ptMatch = abilities[i].match(ptRegex);
      if (ptMatch && currentBracket.power === null) {
        currentBracket.power = ptMatch[1] === '*' ? 0 : parseInt(ptMatch[1], 10);
        currentBracket.toughness = ptMatch[2] === '*' ? 0 : parseInt(ptMatch[2], 10);
        abilityIndexToBracket.set(i, brackets.length - 1);
        continue;
      }
      // Otherwise it's an ability line for this bracket
      currentBracket.abilityIndices.push(i);
      abilityIndexToBracket.set(i, brackets.length - 1);
    }
  }
  
  // Must have at least one LEVEL bracket besides the base
  if (brackets.length < 2) return null;
  
  return {
    brackets,
    abilityIndexToBracket,
    levelUpLineIndex: levelUpIdx,
  };
}

/* Parse spacecraft station abilities from ability lines.
   Scryfall oracle text format (after reminder text stripping):
     Station
     2+ | Other creatures you control get +1/+1.
     12+ | Flying, lifelink
   "N+ | ability" on the same line, gated by charge counters >= N (cumulative).
   The creature transformation threshold comes from reminder text "artifact creature at N+".
   Returns object with:
     stationLineIndex: index of the "Station" keyword line
     thresholds: Map<abilityIndex, {min, abilityText}>
     abilityIndexToBracket: Map<abilityIndex, minCharge>  (-1 for keyword line)
     creatureThreshold: N from "artifact creature at N+" or null
   Or null if not a station card. */
function _parseSpacecraftStations(abilities, rawOracleText) {
  // Find the "Station" keyword line
  const stationKeyIdx = abilities.findIndex(a => /^Station$/i.test(a.trim()));
  if (stationKeyIdx < 0) return null;

  const stationAbilityRegex = /^(\d+)\+\s*\|\s*(.+)$/;
  const thresholds = new Map(); // abilityIndex → { min, abilityText }
  const abilityIndexToBracket = new Map();
  abilityIndexToBracket.set(stationKeyIdx, -1); // keyword line always active

  // First pass: find all N+ | lines and their thresholds
  let currentMin = -1; // track current threshold for subsequent lines
  let foundFirstThreshold = false;
  for (let i = 0; i < abilities.length; i++) {
    if (i === stationKeyIdx) continue;
    // Lines before the Station keyword are not station-gated
    if (i < stationKeyIdx) continue;
    const match = abilities[i].match(stationAbilityRegex);
    if (match) {
      const min = parseInt(match[1], 10);
      const abilityText = match[2].trim();
      thresholds.set(i, { min, abilityText });
      abilityIndexToBracket.set(i, min);
      currentMin = min;
      foundFirstThreshold = true;
    } else if (foundFirstThreshold && currentMin >= 0 && abilities[i].trim()) {
      // Subsequent line after a N+ | line inherits the same threshold
      thresholds.set(i, { min: currentMin, abilityText: abilities[i].trim() });
      abilityIndexToBracket.set(i, currentMin);
    }
  }

  if (thresholds.size === 0) return null;

  // Extract creature threshold from raw oracle text reminder: "It's an artifact creature at N+."
  let creatureThreshold = null;
  if (rawOracleText) {
    const ctMatch = rawOracleText.match(/it'?s an artifact creature at (\d+)\+/i);
    if (ctMatch) {
      creatureThreshold = parseInt(ctMatch[1], 10);
    }
  }

  return {
    stationLineIndex: stationKeyIdx,
    thresholds,
    abilityIndexToBracket,
    creatureThreshold,
  };
}

/* Scan oracle text for special counter type names (e.g., "slumber counter", "lore counter") */
function _extractOracleCounterTypes(oracleText, subtypes, types) {
  const found = new Set();
  // Auto-add lore counters for Sagas
  if (subtypes && subtypes.includes('Saga')) found.add('lore');
  // Auto-add loyalty counters for Planeswalkers
  if (types && types.includes('Planeswalker')) found.add('loyalty');
  if (!oracleText) return [...found];
  // Match P/T counter patterns: +N/+N, -N/-N, +N/+0, etc.
  const ptRegex = /([+-]\d+\/[+-]\d+)\s+counters?\b/gi;
  let ptm;
  while ((ptm = ptRegex.exec(oracleText)) !== null) {
    found.add(ptm[1]);
  }
  // Match "[word] counter(s)" patterns
  const regex = /\b(\w+)\s+counters?\b/gi;
  let m;
  while ((m = regex.exec(oracleText)) !== null) {
    const word = m[1].toLowerCase();
    // Skip generic/structural words
    const SKIP = new Set(['a', 'an', 'the', 'that', 'each', 'all', 'every', 'another',
      'its', 'more', 'no', 'those', 'these', 'this', 'any', 'such',
      'many', 'fewer', 'other', 'one', 'two', 'three', 'four', 'five',
      'six', 'seven', 'eight', 'nine', 'ten', 'with', 'or', 'and', 'of']);
    if (SKIP.has(word)) continue;
    // Skip +1/+1 and -1/-1 style (already in presets)
    if (/^[+-]?\d+$/.test(word)) continue;
    // Skip keyword abilities already in COUNTER_PRESETS
    const PRESET_TYPES = new Set(['+1/+1', '-1/-1', 'flying', 'first strike', 'double strike',
      'deathtouch', 'haste', 'hexproof', 'indestructible', 'lifelink', 'menace', 'reach',
      'trample', 'vigilance', 'defender', 'shield']);
    if (PRESET_TYPES.has(word)) continue;
    found.add(word);
  }
  return [...found];
}

/* Replace proper nouns in oracle text that match any word in the card name.
   E.g. "Blizidrox gets +2/+0" -> "this card gets +2/+0" if card is "Blizidrox, the Wyvern King"
   Uses "this token" for token cards, "this card" for all others.
   The replacement signals that the card is talking about itself. */
function _replaceProperNounSelfRef(cardName, oracleText, isToken = false) {
  if (!cardName || !oracleText) return oracleText;
  const selfWord = isToken ? 'this token' : 'this card';
  // Normalize curly apostrophes (U+2019) to straight for consistent matching
  // Scryfall uses curly in oracle text but card.name may use straight quotes
  const normalizedName = cardName.replace(/\u2019/g, "'");
  let result = oracleText.replace(/\u2019/g, "'");
  // Get first word of the name (the unique proper noun) and the full name
  // Try full name first, then first word (for "Blizidrox, the Wyvern King" -> "Blizidrox")
  const candidates = [normalizedName];
  const commaIdx = normalizedName.indexOf(',');
  if (commaIdx > 0) candidates.push(normalizedName.slice(0, commaIdx).trim());
  // Also try first word if it's a proper noun (capitalized, >2 chars)
  const firstWord = normalizedName.split(/[\s,]/)[0];
  if (firstWord.length > 2 && firstWord[0] === firstWord[0].toUpperCase() && !candidates.includes(firstWord)) {
    candidates.push(firstWord);
  }
  // Sort candidates longest first to prefer full matches
  candidates.sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('\\b' + escaped + '\\b', 'g');
    if (!regex.test(result)) continue;
    // Only replace in subject position: start of line/sentence, after comma/semicolon,
    // or after clause words. NOT after "a/an", "is a", "becomes a", "type", "subtype".
    // This prevents replacing creature-type names (e.g. "is a colorless Noggle").
    result = result.replace(regex, (match, offset) => {
      // Check what comes before this match
      const before = result.substring(Math.max(0, offset - 30), offset);
      // Non-subject contexts: after articles, "is a/an", "becomes a", "colorless/color words"
      if (/\b(?:a|an|the|is\s+a|is\s+an|becomes?\s+a|becomes?\s+an|colorless|white|blue|black|red|green)\s*$/i.test(before)) {
        return match; // keep original, not a self-reference
      }
      // After "type" or "subtype" words
      if (/\b(?:the\s+type|the\s+subtype|type|subtype)\s*$/i.test(before)) {
        return match; // keep original
      }
      // Capitalize at sentence boundaries (start of text or after . ! ? or newline)
      const trimmedBefore = before.trimEnd();
      if (trimmedBefore.length === 0 || /[.!?\n]$/.test(trimmedBefore)) {
        return selfWord.charAt(0).toUpperCase() + selfWord.slice(1);
      }
      return selfWord;
    });
    break;
  }
  return result;
}

function parseTypeLine(typeLine) {
  const supertypeWords = ['Basic', 'Legendary', 'Snow', 'World', 'Ongoing'];
  // For multi-face type lines (e.g. "Enchantment — Room // Enchantment — Room"),
  // parse only the first face's type line (or the combined if no //)
  let effectiveTypeLine = typeLine;
  if (typeLine.includes(' // ')) {
    effectiveTypeLine = typeLine.split(' // ')[0].trim();
  }
  // Split on em-dash (U+2014), en-dash (U+2013), or similar separators
  const parts = effectiveTypeLine.split(/\s*[\u2014\u2013]\s*/).map(s => s.trim());
  if (parts.length === 1) {
    // Fallback: try splitting on " - " or other dash-like chars
    const fallback = effectiveTypeLine.split(/\s+[\u2014\u2013]\s+|\s+[-][-]\s+|\s+[-]\s+/).map(s => s.trim());
    if (fallback.length > 1) { parts.length = 0; parts.push(...fallback); }
  }
  const leftWords = (parts[0] || '').split(/\s+/).filter(Boolean);
  const supertypes = leftWords.filter(w => supertypeWords.includes(w));
  const types = leftWords.filter(w => !supertypeWords.includes(w) && w !== '//' && w !== 'Token');
  const subtypes = parts[1] ? parts[1].split(/\s+/).filter(Boolean) : [];
  
  // For multi-face cards, also grab types/subtypes from the second face
  if (typeLine.includes(' // ')) {
    const secondHalf = typeLine.split(' // ').slice(1).join(' // ').trim();
    const secondParts = secondHalf.split(/\s*[\u2014\u2013]\s*/).map(s => s.trim());
    const secondLeftWords = (secondParts[0] || '').split(/\s+/).filter(Boolean);
    for (const w of secondLeftWords) {
      if (supertypeWords.includes(w)) { if (!supertypes.includes(w)) supertypes.push(w); }
      else if (w !== '//' && w !== 'Token') { if (!types.includes(w)) types.push(w); }
    }
    if (secondParts[1]) {
      for (const w of secondParts[1].split(/\s+/).filter(Boolean)) {
        if (!subtypes.includes(w)) subtypes.push(w);
      }
    }
  }
  
  return { supertypes, types, subtypes };
}

function extractAbilities(oracleText) {
  if (!oracleText) return [];
  return _stripReminderText(oracleText).split('\n').map(line => line.trim()).filter(Boolean);
}

/* CR 305.6: Basic land subtypes grant intrinsic mana abilities.
   Scryfall puts these in parentheses (reminder text) which gets stripped,
   so we re-add them based on the card's subtypes. */
function _addIntrinsicLandMana(abilities, subtypes) {
  if (typeof BASIC_LAND_MANA === 'undefined') return;
  for (const st of subtypes) {
    if (BASIC_LAND_MANA[st] && !abilities.includes(BASIC_LAND_MANA[st])) {
      abilities.push(BASIC_LAND_MANA[st]);
    }
  }
}
/* [END: PERMANENT] */
