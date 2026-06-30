/* engine-compute.js — auto-compute helpers used by Layer 7 effects.

   Public functions:
     _computeForEachCount(forEachDesc, allStates, selfState, effect) → number|null
     _computeDevotionCounts(allStates, controller) → { W, U, B, R, G }

   Extracted from engine-helpers.js. */

/* [KEY: FOR-EACH-COMPUTE]  —  Auto-compute "for each" counts from battlefield state */
function _computeForEachCount(forEachDesc, allStates, selfState, effect) {
  // Resolve the SOURCE permanent's state for self-references like "counter on this creature".
  // When an effect says "for each counter on [source name]", selfState is the TARGET being
  // modified, but counters are on the SOURCE. Look up source state from allStates.
  const sourceState = (effect && effect.sourceId && allStates)
    ? (allStates.get(effect.sourceId) || selfState) : selfState;

  // Detect "you control" / "your opponents control" before stripping them from desc.
  const rawDesc = forEachDesc.toLowerCase().trim();
  const youControl = rawDesc.includes('you control');
  const opponentsControl = rawDesc.includes('your opponents control') || rawDesc.includes("opponents' control") || rawDesc.includes('opponents control');
  const ctrlId = (selfState && selfState.controller) || 'player_0';

  const desc = forEachDesc.toLowerCase().trim()
    .replace(/\s+you control$/, '')
    .replace(/\s+your opponents control$/, '')
    .replace(/\s+on the battlefield$/, '')
    .replace(/,?\s*to a maximum of \d+$/, '');

  // Compound CDA: "[A] plus the number of [B]" — sum two independently-computed counts.
  // e.g. Soulless One: "Zombies on the battlefield plus the number of Zombie cards in all graveyards".
  // Each half may be a battlefield type/subtype count or a zone-card (graveyard/exile) count.
  const _plusSplit = desc.split(/\s+plus\s+(?:the\s+)?(?:number|total number|amount)\s+of\s+/);
  if (_plusSplit.length === 2) {
    const _left = _computeCountClause(_plusSplit[0], allStates, selfState);
    const _right = _computeCountClause(_plusSplit[1], allStates, selfState);
    if (_left !== null && _right !== null) return _left + _right;
  }

  // Imprint "for each X with the same name as the exiled card" — Strata Scythe.
  // Count battlefield permanents matching the type filter whose name matches the most-recent
  // exile entry tagged with the effect's source permanent.
  const sameNameExiledMatch = desc.match(/^([\w-]+)(?:\s+on\s+the\s+battlefield)?\s+with\s+the\s+same\s+name\s+as\s+the\s+(?:exiled|imprinted)\s+card\b/);
  if (sameNameExiledMatch && effect && effect.sourceId) {
    const typeWord = sameNameExiledMatch[1];
    const entries = (typeof _getImprintedExileEntries === 'function')
      ? _getImprintedExileEntries(effect.sourceId) : [];
    const last = entries.length ? entries[entries.length - 1] : null;
    if (!last || !last.card || !last.card.name) return 0;
    const targetName = last.card.name;
    const typeCap = typeWord.charAt(0).toUpperCase() + typeWord.slice(1);
    let count = 0;
    for (const [, st] of allStates) {
      if (!st.types.includes(typeCap)) continue;
      if (st.name === targetName) count++;
    }
    return count;
  }

  // "supertype, card type, and subtype it has" — count type categories on the target itself (e.g. Embiggen)
  if (/\bit\s+has\b/.test(desc) && (/\bsupertype\b/.test(desc) || /\bcard\s+type\b/.test(desc) || /\bsubtype\b/.test(desc))) {
    let total = 0;
    if (/\bsupertype\b/.test(desc)) total += (selfState.supertypes || []).length;
    if (/\bcard\s+type\b/.test(desc)) total += (selfState.types || []).length;
    if (/\bsubtype\b/.test(desc)) {
      // Subtypes are now materialized into state.subtypes when gainsAllCreatureTypes
      // applies, so the simple count works for Changeling-granted permanents too.
      total += (selfState.subtypes || []).length;
    }
    return total;
  }

  // "Greatest mana value among [type]" — Karn, Legacy Reforged and similar CDAs.
  if (effect && effect.params && effect.params.isGreatestMV) {
    const filter = (effect.params.greatestMVFilter || '').toLowerCase().trim();
    const ctrlOnly = effect.params.greatestMVController;
    const sourceCtrl = sourceState && sourceState.controller;
    let greatest = 0;
    for (const [, st] of allStates) {
      if (ctrlOnly && st.controller !== sourceCtrl) continue;
      // Match by type/subtype using the existing TYPE_MAP logic inline
      let matches = false;
      if (filter === 'permanent' || filter === 'permanents') {
        matches = true;
      } else if (filter === 'artifact' || filter === 'artifacts') {
        matches = st.types.includes('Artifact');
      } else if (filter === 'creature' || filter === 'creatures') {
        matches = st.types.includes('Creature');
      } else if (filter === 'enchantment' || filter === 'enchantments') {
        matches = st.types.includes('Enchantment');
      } else if (filter === 'land' || filter === 'lands') {
        matches = st.types.includes('Land');
      } else if (filter === 'planeswalker' || filter === 'planeswalkers') {
        matches = st.types.includes('Planeswalker');
      } else {
        // Try subtype match (e.g. "humans", "zombies", "dragons")
        const singular = filter.endsWith('s') ? filter.slice(0, -1) : filter;
        const cap = singular.charAt(0).toUpperCase() + singular.slice(1);
        const capPlural = filter.charAt(0).toUpperCase() + filter.slice(1);
        matches = st.subtypes.includes(cap) || st.subtypes.includes(capPlural);
        // Also try compound "artifact creature" etc.
        if (!matches) {
          const words = filter.split(/\s+/);
          const lastWord = words[words.length - 1];
          const typeMap = { artifact: 'Artifact', artifacts: 'Artifact', creature: 'Creature', creatures: 'Creature',
            enchantment: 'Enchantment', enchantments: 'Enchantment', land: 'Land', lands: 'Land',
            planeswalker: 'Planeswalker', planeswalkers: 'Planeswalker' };
          const baseType = typeMap[lastWord];
          if (baseType && words.length > 1) {
            const subtypeWords = words.slice(0, -1);
            const sub = subtypeWords.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            matches = st.types.includes(baseType) && st.subtypes.includes(sub);
          }
        }
      }
      if (matches && (st.manaValue || 0) > greatest) greatest = st.manaValue || 0;
    }
    return greatest;
  }

  // "Total mana value of [type] you control" — sum mana values across matching permanents
  // (e.g. Ancient Ooze: "total mana value of other creatures you control"). Unlike the
  // "number of" CDAs this accumulates st.manaValue rather than counting cards.
  if (effect && effect.params && effect.params.isManaValueSum) {
    const excludeSelf = /\bother\b/.test(rawDesc);
    const mvDesc = desc.replace(/^other\s+/, '').trim();
    const mvWord = mvDesc.replace(/s$/, '');
    const baseTypes = { artifact: 'Artifact', creature: 'Creature', enchantment: 'Enchantment', land: 'Land', planeswalker: 'Planeswalker' };
    let total = 0;
    for (const [pid, st] of allStates) {
      if (excludeSelf && effect.sourceId && pid === effect.sourceId) continue;
      if (youControl && st.controller !== ctrlId) continue;
      if (opponentsControl && st.controller === ctrlId) continue;
      let matches = false;
      if (mvDesc === 'permanent' || mvDesc === 'permanents') {
        matches = true;
      } else if (baseTypes[mvWord]) {
        matches = st.types.includes(baseTypes[mvWord]);
      } else {
        const sub = mvWord.charAt(0).toUpperCase() + mvWord.slice(1);
        matches = (st.subtypes || []).includes(sub);
      }
      if (matches) total += (st.manaValue || 0);
    }
    return total;
  }

  // Exile counting: count cards in exile owned by this permanent's controller (e.g. Cosmogoyf).
  if (effect && effect.params && effect.params.isExileCount) {
    if (typeof Battlefield !== 'undefined' && Battlefield.exile) {
      const ctrl = (selfState && selfState.controller) || 'player_0';
      return Battlefield.exile.filter(e => e.owner === ctrl).length;
    }
    return null;
  }

  // Graveyard counting for effects flagged as graveyard-based (e.g. Lord of Extinction,
  // Nighthowler, Mortivore). Count actual cards across ALL players' graveyards, honoring a
  // "creature cards" qualifier in the desc so non-creature cards don't inflate the count
  // (CR 613.4f — a "number of creature cards in all graveyards" CDA only counts creatures).
  if (effect && effect.params && effect.params.isGraveyardCount) {
    if (typeof Battlefield !== 'undefined' && Array.isArray(Battlefield.players)) {
      const creatureOnly = /\bcreature\b/.test(desc);
      let count = 0;
      for (const player of Battlefield.players) {
        for (const card of (player.graveyard || [])) {
          if (creatureOnly) {
            const isCreature = (typeof _isCreatureCardInZone === 'function')
              ? _isCreatureCardInZone(card, 'graveyard')
              : /creature/i.test((card && card.type_line) || '');
            if (!isCreature) continue;
          }
          count++;
        }
      }
      return count;
    }
    return null; // fall back to user input
  }

  // "experience counter(s) [you have]" — read from gameState.experienceCounters
  if (/\bexperience\s+counters?\b/.test(desc)) {
    if (typeof Battlefield !== 'undefined' && Battlefield.gameState) {
      return Battlefield.gameState.experienceCounters || 0;
    }
    return null;
  }

  // "poison counter(s) [you have]" — read from gameState.poisonCounters
  if (/\bpoison\s+counters?\b/.test(desc)) {
    if (typeof Battlefield !== 'undefined' && Battlefield.gameState) {
      return Battlefield.gameState.poisonCounters || 0;
    }
    return null;
  }

  // "cards in hand" / "cards in all players' hands" — use gameState.handSize
  if (/\bcards?\s+in\s+.*\bhands?\b/.test(desc)) {
    if (typeof Battlefield !== 'undefined' && Battlefield.gameState) {
      return Battlefield.gameState.handSize || 0;
    }
    return null;
  }

  // "time you've cast your commander from the command zone this game" (Commander's Insignia, etc.)
  // Matches patterns like: "time you've cast your commander from the command zone"
  if (/\btimes?\s+you(?:'ve|'ve|\s+have)\s+cast\s+your\s+commander\b/.test(desc)) {
    if (typeof Battlefield !== 'undefined' && Battlefield.commanders) {
      let totalCasts = 0;
      for (const cmd of Battlefield.commanders) {
        totalCasts += (cmd.castCount || 0);
      }
      return totalCasts;
    }
    return null; // fall back to user input if no commander data
  }

  // "color among permanents" / "color among permanents you control"
  // Count distinct colors across all permanents on the battlefield
  if (/\bcolou?rs?\s+among\s+permanents?\b/.test(desc) || /\bcolou?r\s+among\s+permanents?\b/.test(desc)) {
    const distinctColors = new Set();
    for (const [, st] of allStates) {
      for (const c of (st.colors || [])) distinctColors.add(c);
    }
    return distinctColors.size;
  }

  // "its creature types" / "of its creature types"  —  count subtypes on the creature itself
  if (/\b(its|of its)\s+creature\s+types?\b/.test(desc)) {
    // Materialized subtypes (Changeling) participate naturally in this count, and
    // a REMOVE_TYPE that strips a creature subtype reduces it as expected.
    const creatureSubtypes = selfState.subtypes.filter(s => {
      if (typeof TypeCatalog !== 'undefined' && TypeCatalog.creatureTypes.size > 0) {
        return TypeCatalog.creatureTypes.has(s);
      }
      return true; // assume all subtypes are creature types if catalog unavailable
    });
    return creatureSubtypes.length;
  }

  // Count by type/subtype across all permanents on the battlefield
  let count = 0;
  const _typeEntries = [
    ['artifact', 'Artifact'], ['creature', 'Creature'], ['enchantment', 'Enchantment'],
    ['land', 'Land'], ['planeswalker', 'Planeswalker'],
  ];
  const TYPE_MAP = Object.fromEntries([
    ..._typeEntries.flatMap(([k, v]) => { const fn = (st) => st.types.includes(v); return [[k, fn], [k + 's', fn]]; }),
    ['permanent', () => true], ['permanents', () => true],
  ]);

  // Handle supertype + type combos: "snow permanent", "snow creature", "legendary creature", etc.
  const SUPERTYPE_MAP = {
    'snow': 'Snow', 'legendary': 'Legendary', 'basic': 'Basic', 'world': 'World',
  };

  // Negated type qualifier: "nonland permanents", "noncreature artifacts", "nontoken creatures", etc.
  // (e.g. Regal Bunnicorn — "nonland permanents you control"). Count permanents matching the base
  // type but NOT the negated type/supertype/token.
  const nonTypeMatch = desc.match(/^non-?([a-z]+)\s+(.+)$/);
  if (nonTypeMatch) {
    const negWord = nonTypeMatch[1];
    const baseDesc = nonTypeMatch[2].trim();
    const baseChecker = TYPE_MAP[baseDesc];
    let negChecker = TYPE_MAP[negWord];
    if (!negChecker && SUPERTYPE_MAP[negWord]) { const sv = SUPERTYPE_MAP[negWord]; negChecker = (st) => st.supertypes.includes(sv); }
    if (!negChecker && (negWord === 'token' || negWord === 'tokens')) negChecker = (st) => st.isToken;
    if (baseChecker && negChecker) {
      for (const [, st] of allStates) {
        if (youControl && st.controller !== ctrlId) continue;
        if (opponentsControl && st.controller === ctrlId) continue;
        if (baseChecker(st) && !negChecker(st)) count++;
      }
      return count;
    }
  }
  for (const [stWord, stVal] of Object.entries(SUPERTYPE_MAP)) {
    // "snow permanents" / "snow permanent"
    if (desc === stWord + ' permanent' || desc === stWord + ' permanents') {
      for (const [, st] of allStates) {
        if (youControl && st.controller !== ctrlId) continue;
        if (opponentsControl && st.controller === ctrlId) continue;
        if (st.supertypes.includes(stVal)) count++;
      }
      return count;
    }
    // "snow creatures" / "snow lands" etc.
    for (const [typeWord, typeChecker] of Object.entries(TYPE_MAP)) {
      if (desc === stWord + ' ' + typeWord) {
        for (const [, st] of allStates) {
          if (youControl && st.controller !== ctrlId) continue;
          if (opponentsControl && st.controller === ctrlId) continue;
          if (st.supertypes.includes(stVal) && typeChecker(st)) count++;
        }
        return count;
      }
    }
  }

  // Check if desc matches a simple type: "artifact", "creature", etc.
  const typeChecker = TYPE_MAP[desc];
  if (typeChecker) {
    for (const [, st] of allStates) {
      if (youControl && st.controller !== ctrlId) continue;
      if (opponentsControl && st.controller === ctrlId) continue;
      if (typeChecker(st)) count++;
    }
    return count;
  }

  // Handle "and/or" and "or" compound types: "artifact and/or enchantment", "creature or planeswalker"
  const andOrParts = desc.split(/\s+and\/or\s+|\s+or\s+/);
  if (andOrParts.length > 1) {
    const checkers = andOrParts.map(p => TYPE_MAP[p.trim()]).filter(Boolean);
    if (checkers.length === andOrParts.length) {
      // All parts are recognized types — count permanents matching ANY
      for (const [, st] of allStates) {
        if (youControl && st.controller !== ctrlId) continue;
        if (opponentsControl && st.controller === ctrlId) continue;
        if (checkers.some(fn => fn(st))) count++;
      }
      return count;
    }
  }

  // Check for "[subtype] [type]" e.g. "merfolk you control", "zombie creature", "elf creatures"
  const words = desc.split(/\s+/);
  const IRREGULAR_PLURAL_MAP_LOCAL = {
    'elves': 'Elf', 'dwarves': 'Dwarf', 'wolves': 'Wolf', 'werewolves': 'Werewolf',
    'allies': 'Ally', 'faeries': 'Faerie', 'zombies': 'Zombie', 'harpies': 'Harpy',
    'valkyries': 'Valkyrie', 'gargoyles': 'Gargoyle', 'fungi': 'Fungus',
    'oxen': 'Ox', 'mice': 'Mouse', 'geese': 'Goose',
  };
  function _singularize(s) {
    if (IRREGULAR_PLURAL_MAP_LOCAL[s]) return IRREGULAR_PLURAL_MAP_LOCAL[s];
    const cap = s.charAt(0).toUpperCase() + s.slice(1);
    if (s.endsWith('s') && s.length > 2) return s.charAt(0).toUpperCase() + s.slice(1, -1);
    return cap;
  }

  // "[type] (you control) that are [subtype] and/or [subtype]" — count permanents of the base
  // type matching ANY of the listed subtypes, each counted once. The "and/or" wording exists
  // precisely so a permanent carrying several of the listed subtypes isn't double-counted.
  // e.g. The Mycotyrant: "creatures you control that are Fungi and/or Saprolings".
  const thatAreMatch = desc.match(/^(creatures?|permanents?|artifacts?|enchantments?|lands?|planeswalkers?)\s+(?:you control\s+|your opponents control\s+)?that\s+are\s+(.+)$/);
  if (thatAreMatch) {
    const baseCheck = TYPE_MAP[thatAreMatch[1]];
    const subParts = thatAreMatch[2].split(/\s+and\/or\s+|\s+and\s+|\s+or\s+/)
      .map(s => _singularize(s.trim())).filter(Boolean);
    if (baseCheck && subParts.length) {
      for (const [, st] of allStates) {
        if (youControl && st.controller !== ctrlId) continue;
        if (opponentsControl && st.controller === ctrlId) continue;
        if (baseCheck(st) && subParts.some(sub => st.subtypes.includes(sub))) count++;
      }
      return count;
    }
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const typeCheck = TYPE_MAP[w];
    if (typeCheck) {
      // Words before this are subtype qualifiers
      const subtypeWords = words.slice(0, i);
      if (subtypeWords.length > 0) {
        const subtype = subtypeWords.map(s => _singularize(s)).join(' ');
        for (const [, st] of allStates) {
          if (youControl && st.controller !== ctrlId) continue;
          if (opponentsControl && st.controller === ctrlId) continue;
          if (typeCheck(st) && st.subtypes.includes(subtype)) count++;
        }
        return count;
      }
    }
  }

  // --- Counter patterns (checked BEFORE bare subtype to avoid changeling false positives) ---

  // Specific counter type on self: "+1/+1 counters on it" / "+1/+1 counter on this card"
  const selfCounterMatch = desc.match(/([+-]\d+\/[+-]\d+)\s+counters?\s+on\s+(.+)/);
  if (selfCounterMatch) {
    const counterType = selfCounterMatch[1];
    const selfRef = selfCounterMatch[2].trim();
    // If the "on X" target is a known self-reference, count specific counter type on SOURCE
    if (/^(it|this creature|this permanent|this card|this token)$/.test(selfRef)) {
      return (sourceState.counters && sourceState.counters[counterType]) || 0;
    }
    // "+1/+1 counters on creatures" -- count across all matching permanents
    if (/creatures?/.test(selfRef)) {
      for (const [, st] of allStates) {
        count += (st.counters && st.counters[counterType]) || 0;
      }
      return count;
    }
    // Fallback for "+1/+1 counter on [card name]" etc -- treat as source
    return (sourceState.counters && sourceState.counters[counterType]) || 0;
  }

  // Generic "counters on it/self" (any counter type): "counters on it", "counter on this creature"
  if (/counters?\s+on\s+(it|this creature|this permanent|this card|this token)\b/.test(desc)) {
    let total = 0;
    for (const [cType, cCount] of Object.entries(sourceState.counters || {})) {
      total += cCount;
    }
    return total;
  }

  // Broader "counter on [anything]" -- if desc contains "counter(s) on", treat as source-targeting
  if (/counters?\s+on\s+/.test(desc)) {
    let total = 0;
    for (const [cType, cCount] of Object.entries(sourceState.counters || {})) {
      total += cCount;
    }
    return total;
  }

  // Generic "[type] counters" across all permanents (e.g. "+1/+1 counters")
  const genericCounterMatch = desc.match(/([+-]\d+\/[+-]\d+)\s+counters?/);
  if (genericCounterMatch) {
    const counterType = genericCounterMatch[1];
    for (const [, st] of allStates) {
      count += (st.counters && st.counters[counterType]) || 0;
    }
    return count;
  }

  // "Aura and Equipment attached to it" — count permanents of specified subtypes/types
  // that are attached (equipped/enchanting) to the target creature (selfState).
  // Used by cards like Mantle of the Ancients: "gets +1/+1 for each Aura and Equipment attached to it."
  const attachedMatch = desc.match(/^(.+?)\s+attached\s+to\s+(?:it|him|her|them|this creature|this permanent|this card)\s*$/);
  if (attachedMatch) {
    const thingDesc = attachedMatch[1].trim();
    if (typeof Battlefield !== 'undefined' && Battlefield.effects) {
      // Find the ID of the creature that things are attached to (= the boost target / selfState).
      let creatureId = null;
      if (effect) {
        creatureId = effect.targetId || (effect.selfTarget ? effect.sourceId : null);
      }
      if (!creatureId && allStates) {
        for (const [id, st] of allStates) {
          if (st === selfState) { creatureId = id; break; }
        }
      }
      if (creatureId) {
        // Gather sourceIds of all effects targeting this creature (things attached to it).
        const attachedSourceIds = new Set();
        for (const eff of Battlefield.effects) {
          if (eff.targetId === creatureId && !eff.selfTarget && eff.sourceId !== creatureId) {
            attachedSourceIds.add(eff.sourceId);
          }
        }
        // Split "aura and equipment" into parts to match by subtype or type.
        const parts = thingDesc.split(/\s+and\s+|\s+or\s+/).map(s => s.trim()).filter(Boolean);
        count = 0;
        for (const srcId of attachedSourceIds) {
          const srcState = allStates.get(srcId);
          if (!srcState) continue;
          for (const part of parts) {
            const subCap = part.charAt(0).toUpperCase() + part.slice(1);
            const subSing = _singularize(part);
            const tCheck = TYPE_MAP[part];
            if ((tCheck && tCheck(srcState)) ||
                srcState.subtypes.includes(subCap) ||
                srcState.subtypes.includes(subSing)) {
              count++;
              break; // matched one part — avoid double-counting this permanent
            }
          }
        }
        return count;
      }
    }
  }

  // --- Bare subtype: "merfolk", "goblin", "elves", "humans", etc. ---
  const irregularLookup = IRREGULAR_PLURAL_MAP_LOCAL[desc];
  const subtype = irregularLookup || (desc.charAt(0).toUpperCase() + desc.slice(1));
  // Also try without trailing 's'
  const subtypeSingular = _singularize(desc);
  // Guard: skip bare subtype check if desc contains counter/non-subtype words
  if (!/\bcounters?\b|\bon\b/.test(desc)) {
    for (const [, st] of allStates) {
      if (youControl && st.controller !== ctrlId) continue;
      if (opponentsControl && st.controller === ctrlId) continue;
      if (st.subtypes.includes(subtype) || st.subtypes.includes(subtypeSingular)) count++;
    }
    if (count > 0) return count;
  }

  return null; // couldn't auto-compute; fall back to user input
}

const _ZONE_CLAUSE_TYPE_WORDS = {
  artifact: 'Artifact', creature: 'Creature', enchantment: 'Enchantment',
  land: 'Land', planeswalker: 'Planeswalker', instant: 'Instant', sorcery: 'Sorcery',
  battle: 'Battle', tribal: 'Tribal',
};

// Match a real card object (from a graveyard/exile zone) against a type/subtype qualifier
// like "zombie", "creature", or "zombie creature". Returns true if the card satisfies ALL words.
function _zoneCardMatchesQualifier(card, qualifier) {
  const parsed = (typeof parseTypeLine === 'function')
    ? parseTypeLine((card && card.type_line) || '')
    : { types: [], subtypes: [], supertypes: [] };
  for (const w of qualifier.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (w === 'card' || w === 'cards') continue;
    const sing = (typeof singularizeCreatureType === 'function')
      ? singularizeCreatureType(w)
      : (w.endsWith('s') && w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1, -1) : w.charAt(0).toUpperCase() + w.slice(1));
    const lw = sing.toLowerCase();
    if (_ZONE_CLAUSE_TYPE_WORDS[lw]) {
      if (!parsed.types.includes(_ZONE_CLAUSE_TYPE_WORDS[lw])) return false;
    } else if (!parsed.subtypes.includes(sing)) {
      return false;
    }
  }
  return true;
}

// Count real cards in a zone ('graveyard' | 'exile') across all players that match a qualifier.
function _countZoneCardsByQualifier(qualifier, zone) {
  if (typeof Battlefield === 'undefined') return 0;
  const cards = [];
  if (zone === 'graveyard' && Array.isArray(Battlefield.players)) {
    for (const p of Battlefield.players) for (const c of (p.graveyard || [])) cards.push(c);
  } else if (zone === 'exile' && Array.isArray(Battlefield.exile)) {
    for (const e of Battlefield.exile) cards.push(e.card || e);
  }
  const q = (qualifier || '').toLowerCase().trim();
  let count = 0;
  for (const card of cards) {
    if (!q || q === 'card' || q === 'cards') { count++; continue; }
    if (_zoneCardMatchesQualifier(card, q)) count++;
  }
  return count;
}

// Compute one clause of a compound CDA count (see _computeForEachCount). A clause is either a
// zone-card count ("zombie cards in all graveyards") or a battlefield type/subtype count
// ("zombies on the battlefield"). Returns a number (never null) so a zero half doesn't void the sum.
function _computeCountClause(clause, allStates, selfState) {
  let c = (clause || '').toLowerCase().trim().replace(/\.$/, '');
  let zone = null;
  if (/\bgraveyards?\b/.test(c)) zone = 'graveyard';
  else if (/\bexile\b/.test(c)) zone = 'exile';
  if (zone) {
    const qualifier = c
      .replace(/\s+in\s+(?:all|your|each|their|every)?\s*graveyards?$/, '')
      .replace(/\s+in\s+exile$/, '')
      .trim();
    return _countZoneCardsByQualifier(qualifier, zone);
  }
  // Battlefield clause: count permanents matching the type/subtype.
  c = c.replace(/\s+on\s+the\s+battlefield$/, '').trim();
  const youControl = /\byou control$/.test(c);
  c = c.replace(/\s+you control$/, '').trim();
  const ctrlId = (selfState && selfState.controller) || 'player_0';
  if (c === 'permanent' || c === 'permanents') {
    let n = 0;
    for (const [, st] of allStates) { if (youControl && st.controller !== ctrlId) continue; n++; }
    return n;
  }
  const sing = (typeof singularizeCreatureType === 'function')
    ? singularizeCreatureType(c)
    : (c.endsWith('s') && c.length > 2 ? c.charAt(0).toUpperCase() + c.slice(1, -1) : c.charAt(0).toUpperCase() + c.slice(1));
  const lw = sing.toLowerCase();
  let n = 0;
  for (const [, st] of allStates) {
    if (youControl && st.controller !== ctrlId) continue;
    if (_ZONE_CLAUSE_TYPE_WORDS[lw]) {
      if (st.types.includes(_ZONE_CLAUSE_TYPE_WORDS[lw])) n++;
    } else if (st.subtypes.includes(sing)) {
      n++;
    }
  }
  return n;
}

/* [KEY: DEVOTION-COMPUTE]  —  Compute devotion from mana costs of permanents on battlefield */
function _computeDevotionCounts(allStates, controller) {
  const devotion = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const colorMap = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G' };
  for (const [, st] of allStates) {
    if (controller && st.controller !== controller) continue;
    const cost = st.manaCost || '';
    for (const ch of cost) {
      if (colorMap[ch]) devotion[ch]++;
    }
  }
  return devotion;
}
/* [END: FOR-EACH-COMPUTE] */
