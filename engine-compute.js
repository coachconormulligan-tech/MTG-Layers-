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
  // "You" is the controller of the effect's source (an Aura's controller, not the enchanted
  // creature's), falling back to the permanent being modified.
  const ctrlId = (sourceState && sourceState.controller) || (selfState && selfState.controller) || 'player_0';

  let desc = forEachDesc.toLowerCase().trim()
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

  // Life-total expressions ("your life total", "20 minus the highest life total among players").
  if (/\blife\s+total\b/.test(desc)) return _computeLifeExpression(desc, ctrlId);

  // Domain: "basic land type(s) among lands you control".
  if (/\bbasic\s+land\s+types?\s+among\s+lands\b/.test(rawDesc)) {
    const found = new Set();
    for (const [, st] of allStates) {
      if (!st.types.includes('Land')) continue;
      if (youControl && st.controller !== ctrlId) continue;
      for (const lt of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) {
        if (st.isAllLandTypes || st.subtypes.includes(lt)) found.add(lt);
      }
    }
    return found.size;
  }

  // "experience counter(s) you have" / "poison counter(s) your opponents have": the counters of
  // the player the words name, never those of the player whose tab is open (_countPlayerCounters).
  if (/\bexperience\s+counters?\b/.test(desc)) {
    return _countPlayerCounters('experienceCounters', desc, ctrlId, selfState);
  }
  if (/\bpoison\s+counters?\b/.test(desc)) {
    return _countPlayerCounters('poisonCounters', desc, ctrlId, selfState);
  }

  // Cards in a hand: the hand of the player the words name, never that of the player whose tab
  // is open (_countCardsInHand).
  if (/\bcards?\s+in\s+.*\bhands?\b/.test(desc)) {
    return _countCardsInHand(desc, ctrlId, selfState, effect);
  }

  // "time you've cast your commander from the command zone this game" (Commander's Insignia, etc.)
  // Matches patterns like: "time you've cast your commander from the command zone";
  // "cast a commander" (Captain Vargus Wrath) counts the same casts.
  if (/\btimes?\s+you(?:'ve|'ve|\s+have)\s+cast\s+(?:your|a)\s+commander\b/.test(desc)) {
    // The commanders of the effect's controller, not of the player whose tab is open.
    const caster = typeof Battlefield !== 'undefined' && Battlefield.getPlayer && Battlefield.getPlayer(ctrlId);
    if (caster) {
      let totalCasts = 0;
      for (const cmd of caster.commanders || []) {
        totalCasts += (cmd.castCount || 0);
      }
      return totalCasts;
    }
    return null; // fall back to user input if no commander data
  }

  // "Color(s) among <group>" ("permanents you control"; General Tazri's "those creatures", which
  // the fire-time snapshot replaces with the sentence's subject) and "[kind] counter(s) among
  // <group>" (Chong and Lily: "lore counter among Sagas you control"). The group is read as a
  // subject is (buildAppliesToFromText), "you control" meaning the effect's controller.
  const amongMatch = rawDesc.match(/^(?:colou?rs?|(?:(?:an?|one)\s+)?(?:([+-]\d+\/[+-]\d+|[a-z]+)\s+)?counters?)\s+among\s+(.+)$/);
  if (amongMatch && typeof buildAppliesToFromText === 'function') {
    const group = buildAppliesToFromText(amongMatch[2].replace(/\s+on the battlefield$/, ''));
    if (group && group.fn && !group.isSelf && !group.needsTargetSelection) {
      const inGroup = [...allStates].filter(([, st]) => { try { return group.fn(st, allStates, ctrlId); } catch (e) { return false; } });
      if (/^colou?r/.test(rawDesc)) {
        const found = new Set();
        for (const [, st] of inGroup) for (const c of (st.colors || [])) found.add(c);
        return found.size;
      }
      const kind = amongMatch[1];
      let total = 0;
      for (const [, st] of inGroup) for (const [k, n] of Object.entries(st.counters || {})) if (!kind || k === kind) total += n;
      return total;
    }
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

  // "for each of its colors" (Knight of New Alara, Might of the Nephilim, Civic Saber): the
  // colours of the permanent being modified.
  if (/^(?:of\s+)?its\s+colou?rs$/.test(desc)) return (selfState.colors || []).length;

  // Chroma: "[colour] mana symbol in its mana cost" (Light from Within) reads the permanent
  // being modified; "… in the mana costs of permanents you control" (Heartlash Cinder) adds up
  // every such permanent. A hybrid or Phyrexian symbol of that colour counts.
  const chromaMatch = desc.match(/^(white|blue|black|red|green) mana symbols? in (?:its mana cost|the mana costs of permanents)$/);
  if (chromaMatch) {
    const letter = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[chromaMatch[1]];
    const symbolsIn = (st) => ((st.manaCost || '').match(/\{[^}]*\}/g) || []).filter(s => s.includes(letter)).length;
    if (/\bits mana cost$/.test(desc)) return symbolsIn(selfState);
    let total = 0;
    for (const [, st] of allStates) {
      if (youControl && st.controller !== ctrlId) continue;
      if (opponentsControl && st.controller === ctrlId) continue;
      total += symbolsIn(st);
    }
    return total;
  }

  // "for each point of bushido it has" (Takeno): the bushido of the permanent being modified,
  // every instance added together.
  if (/^points? of bushido (?:it|that creature) has$/.test(desc)) {
    let total = 0;
    for (const a of (selfState.abilities || [])) {
      const m = String(a).match(/^bushido (\d+)\b/i);
      if (m) total += parseInt(m[1], 10);
    }
    return total;
  }

  // "for each time it has attacked this turn" (Moraug): typed by hand on each creature
  // (Battlefield.setTimesAttacked), as no history of combats is kept.
  if (/^times? it has attacked this turn$/.test(desc)) return selfState.timesAttackedThisTurn || 0;

  // "the number of players being attacked" (Pack Attack): the different players the attacking
  // creatures are attacking.
  if (/^players? being attacked$/.test(desc)) {
    const attacked = new Set();
    for (const [, st] of allStates) {
      const pl = _attackedPlayerId(st);
      if (pl) attacked.add(pl);
    }
    return attacked.size;
  }

  // "other [type/subtype]" — the permanent being modified doesn't count itself (Rat Colony:
  // "+1/+0 for each other Rat you control"; Coat of Arms: each creature skips itself).
  const excludeSelf = /^other\s+/.test(desc);
  if (excludeSelf) desc = desc.replace(/^other\s+/, '');
  let pool = excludeSelf ? [...allStates].filter(([, st]) => st !== selfState) : allStates;
  // "for each nonbasic land defending player controls" (Mercadia's Downfall): the player the
  // creature being modified is attacking; nobody when it is not attacking.
  if (/\s+defending player controls$/.test(desc)) {
    desc = desc.replace(/\s+defending player controls$/, '');
    const defending = _attackedPlayerId(selfState);
    pool = [...pool].filter(([, st]) => defending && st.controller === defending);
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
      for (const [, st] of pool) {
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
      for (const [, st] of pool) {
        if (youControl && st.controller !== ctrlId) continue;
        if (opponentsControl && st.controller === ctrlId) continue;
        if (st.supertypes.includes(stVal)) count++;
      }
      return count;
    }
    // "snow creatures" / "snow lands" etc.
    for (const [typeWord, typeChecker] of Object.entries(TYPE_MAP)) {
      if (desc === stWord + ' ' + typeWord) {
        for (const [, st] of pool) {
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
    for (const [, st] of pool) {
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
      for (const [, st] of pool) {
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
      for (const [, st] of pool) {
        if (youControl && st.controller !== ctrlId) continue;
        if (opponentsControl && st.controller === ctrlId) continue;
        if (baseCheck(st) && subParts.some(sub => st.subtypes.includes(sub))) count++;
      }
      return count;
    }
  }

  // "Other creature on the battlefield that shares at least one creature type with it" (Coat of
  // Arms): creatures sharing a creature type with the permanent being modified.
  if (/^creatures? (?:on the battlefield )?that shares? (?:at least one|a) creature type with (?:it|that creature)$/.test(desc)) {
    const own = new Set(selfState.subtypes || []);
    for (const [, st] of pool) {
      if (youControl && st.controller !== ctrlId) continue;
      if (opponentsControl && st.controller === ctrlId) continue;
      if (st.types.includes('Creature') && (st.subtypes || []).some(s => own.has(s) && (!TypeCatalog.creatureTypes.size || TypeCatalog.creatureTypes.has(s)))) count++;
    }
    return count;
  }
  // "Other creature you control with the same name as that creature" (Mirror Box).
  if (/^creatures? (?:you control )?with the same name as (?:that creature|it)$/.test(desc)) {
    for (const [, st] of pool) {
      if (youControl && st.controller !== ctrlId) continue;
      if (st.types.includes('Creature') && st.name === selfState.name) count++;
    }
    return count;
  }

  // "[qualifiers] [type]": "elf creatures", "blue permanents", "attacking creatures", "legendary
  // Human creatures", "artifact token". Every word in front of the last one must be a subtype,
  // colour, supertype, card type or combat state; anything else ("valor counter on this
  // creature", "Equipment attached to this creature") is another pattern, further down.
  // "Other than this card" leaves the source out (Márton Stromgald). "With <keyword>[ or
  // <keyword>]" asks for any of the keywords (Dauthi Warlord "creatures on the battlefield with
  // shadow", Tsagan "creature you control with first strike or double strike"). "With base power
  // 1" / "with base power or toughness 1" asks about base P/T (Zinnia, Valley's Voice; Sword of
  // the Squeak), read by the same helper as subject filters.
  {
    let qDesc = desc, notSource = false, withKeywords = null, withBase = null;
    const otherThan = qDesc.match(/^(.+?)\s+other than (?:this (?:card|creature|permanent)|it)$/);
    if (otherThan) { qDesc = otherThan[1]; notSource = true; }
    const baseMatch = qDesc.match(/^(.+?)\s+(?:on the battlefield\s+|you control\s+|your opponents control\s+)?with\s+(base\s+.+)$/);
    if (baseMatch && typeof _parseBasePTQualifier === 'function') {
      const q = _parseBasePTQualifier(baseMatch[2]);
      if (q) { qDesc = baseMatch[1]; withBase = q.test; }
    }
    const withMatch = qDesc.match(/^(.+?)\s+(?:on the battlefield\s+|you control\s+|your opponents control\s+)?with\s+([a-z ,/]+)$/);
    if (withMatch) {
      const kws = withMatch[2].split(/\s*,\s*(?:(?:and\/)?or\s+)?|\s+and\/or\s+|\s+or\s+/).filter(Boolean);
      if (kws.length && kws.every(k => _COUNT_FILTER_KEYWORDS.has(k))) { qDesc = withMatch[1]; withKeywords = kws; }
    }
    const qWords = qDesc.split(/\s+/);
    const head = qWords[qWords.length - 1];
    const headCheck = /^tokens?$/.test(head) ? ((st) => !!st.isToken) : TYPE_MAP[head];
    const COLOR_WORDS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    const STATE_WORDS = {
      attacking: (st) => (st.traits || []).includes('Attacking'), blocking: (st) => (st.traits || []).includes('Blocking'),
      tapped: (st) => !!st.tapped, untapped: (st) => !st.tapped, equipped: (st) => (st.traits || []).includes('Equipped'),
      historic: (st) => st.types.includes('Artifact') || (st.supertypes || []).includes('Legendary') || (st.subtypes || []).includes('Saga'),
      multicolored: (st) => (st.colors || []).length > 1, monocolored: (st) => (st.colors || []).length === 1,
      colorless: (st) => !(st.colors || []).length, token: (st) => !!st.isToken, nontoken: (st) => !st.isToken,
    };
    // Without the Scryfall catalogs any plain word counts as a subtype, as it always did.
    const catalogLoaded = typeof TypeCatalog !== 'undefined' && TypeCatalog.creatureTypes && TypeCatalog.creatureTypes.size > 0;
    const isSubtype = (s) => catalogLoaded ? _isKnownSubtypeWord(s)
      : /^[A-Z][a-z'-]+(?: [A-Z][a-z'-]+)*$/.test(s) && !/\b(?:Counters?|On|Attached|To|This|It|With|That|Of|The|In|Among|You|Your)\b/.test(s);
    if (headCheck && (qWords.length > 1 || withKeywords || withBase)) {
      const checks = [headCheck], subWords = [];
      if (withKeywords) checks.push((st) => withKeywords.some(k => _hasKeywordAbility(st.abilities || [], k)));
      if (withBase) checks.push(withBase);
      for (const w of qWords.slice(0, -1)) {
        if (COLOR_WORDS[w]) { const c = COLOR_WORDS[w]; checks.push((st) => (st.colors || []).includes(c)); }
        else if (STATE_WORDS[w]) checks.push(STATE_WORDS[w]);
        else if (SUPERTYPE_MAP[w]) { const sv = SUPERTYPE_MAP[w]; checks.push((st) => (st.supertypes || []).includes(sv)); }
        else if (TYPE_MAP[w] && !/^permanents?$/.test(w)) checks.push(TYPE_MAP[w]);
        else subWords.push(w);
      }
      // Subtype words: one subtype of several words ("Time Lord"), or each its own ("Elf Warrior").
      let subOk = true;
      if (subWords.length) {
        const joined = subWords.map(s => _singularize(s)).join(' ');
        if (isSubtype(joined)) checks.push((st) => st.subtypes.includes(joined));
        else if (subWords.every(s => isSubtype(_singularize(s)))) for (const s of subWords) { const sub = _singularize(s); checks.push((st) => st.subtypes.includes(sub)); }
        else subOk = false;
      }
      if (subOk) {
        for (const [pid, st] of pool) {
          if (notSource && effect && pid === effect.sourceId) continue;
          if (youControl && st.controller !== ctrlId) continue;
          if (opponentsControl && st.controller === ctrlId) continue;
          if (checks.every(fn => fn(st))) count++;
        }
        return count;
      }
    }
  }

  // --- Counter patterns (checked BEFORE bare subtype to avoid changeling false positives) ---

  // "[kind] counter on it / on them / on that creature" — on the permanent being modified
  // (Clamavus "Each creature you control gets +1/+1 for each +1/+1 counter on it", Toxrill
  // "… for each slime counter on them", Luxior "Equipped creature … for each counter on it").
  // "on this creature" / "on <name>" — on the effect's source. A named kind counts only that
  // kind (Thelon's spore counters); no kind counts every counter.
  const onCounterMatch = desc.match(/^(?:(?:an?|one)\s+)?(?:([+-]\d+\/[+-]\d+|[a-z]+(?:\s+strike)?)\s+)?counters?\s+on\s+(.+)$/);
  if (onCounterMatch) {
    const holderText = onCounterMatch[2].trim();
    const srcName = ((sourceState && sourceState.name) || '').toLowerCase();
    let holder = null;
    if (/^(?:it|them|that creature|that permanent|those creatures|those permanents)$/.test(holderText)) holder = selfState;
    else if (/^this\s+[a-z]+$/.test(holderText) || (srcName && holderText === srcName)) holder = sourceState;
    if (holder) {
      const counters = holder.counters || {};
      const kind = onCounterMatch[1];
      if (kind) return counters[kind] || 0;
      let total = 0;
      for (const n of Object.values(counters)) total += n;
      return total;
    }
  }

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
      // "Attached to this creature" is the effect's source (Armament Master: "Other Kor
      // creatures you control get +2/+2 for each Equipment attached to this creature").
      if (effect && effect.sourceId && /\bthis (?:creature|permanent|card)\s*$/.test(desc)) creatureId = effect.sourceId;
      if (!creatureId && effect) {
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
    for (const [, st] of pool) {
      if (youControl && st.controller !== ctrlId) continue;
      if (opponentsControl && st.controller === ctrlId) continue;
      if (st.subtypes.includes(subtype) || st.subtypes.includes(subtypeSingular)) count++;
    }
    if (count > 0) return count;
  }

  return null; // couldn't auto-compute; fall back to user input
}

// Keywords a count may ask for with "with <keyword>" (as in buildAppliesToFromText's filters).
const _COUNT_FILTER_KEYWORDS = new Set([
  'flying', 'first strike', 'double strike', 'deathtouch', 'haste', 'hexproof', 'indestructible',
  'lifelink', 'menace', 'reach', 'trample', 'vigilance', 'flash', 'defender', 'fear', 'intimidate',
  'shroud', 'wither', 'infect', 'prowess', 'shadow', 'horsemanship', 'flanking', 'banding',
  'undying', 'persist', 'skulk', 'changeling', 'ward', 'toxic',
]);

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
/* Number of cards in the hand(s) a count names, each player's "Cards in Hand" from their own
   game state. `ctrlId` is the effect's controller, `selfState` the permanent being modified.
   - "your hand", "cards in hand": the effect's controller (Ensnaring Bridge, Maro).
   - "its / that creature's / enchanted creature's controller's hand": the modified permanent's
     controller (Righteous Authority, Flunk).
   - "defending player's hand": the player the modified creature attacks (Mr. Foxglove).
   - "all players' hands" (Multani), "your opponents' hands" (Enemy of Enlightenment), "the hand
     of the opponent with the most cards in hand" (Adamaro).
   - a chosen or targeted player or opponent ("the chosen player's hand" — Nyxathid, Entropic
     Specter; "target opponent's", "an opponent's", "that player's", "their"): the player picked
     on the source, else the first opponent. */
function _countCardsInHand(desc, ctrlId, selfState, effect) {
  if (typeof Battlefield === 'undefined' || !Array.isArray(Battlefield.players)) return null;
  const players = Battlefield.players;
  const handOf = (id) => {
    const pl = players.find(p => p.id === id);
    return pl && pl.gameState ? (pl.gameState.handSize || 0) : 0;
  };
  const opps = players.filter(p => p.id !== ctrlId).map(p => p.id);
  const sum = (ids) => ids.reduce((n, id) => n + handOf(id), 0);
  if (/\ball players' hands\b|\beach player's hand\b/.test(desc)) return sum(players.map(p => p.id));
  if (/\bopponent with the most cards in hand\b/.test(desc)) return opps.length ? Math.max(...opps.map(handOf)) : 0;
  if (/\b(?:your )?opponents' hands\b|\beach opponent's hand\b/.test(desc)) return sum(opps);
  if (/\b(?:its|that creature's|that permanent's|enchanted creature's|equipped creature's) controller's hand\b/.test(desc)) {
    return handOf((selfState && selfState.controller) || ctrlId);
  }
  if (/\bdefending player's hand\b/.test(desc)) {
    const defending = _attackedPlayerId(selfState);
    return defending ? handOf(defending) : 0;
  }
  if (/\b(?:(?:the )?chosen (?:player|opponent)'s|target (?:player|opponent)'s|an opponent's|that player's|their) hand\b/.test(desc)) {
    const src = effect && effect.sourceId && typeof Battlefield.getPermById === 'function' ? Battlefield.getPermById(effect.sourceId) : null;
    const picked = src && (src._targetOpponentPlayerId || src._targetPlayerId || src._enchantedPlayerId);
    if (picked) return handOf(picked);
    return opps.length ? handOf(opps[0]) : 0;
  }
  return handOf(ctrlId);
}
/* Number of a player's own counters (`field`: 'poisonCounters', 'experienceCounters') a count
   names, from each player's game state. `ctrlId` is the effect's controller.
   - "you have": the effect's controller (Kalemne, Minthara).
   - "your opponents have" / "each opponent has": the sum over the opponents (Vishgraz, Mycosynth
     Fiend).
   - "its controller has": the modified permanent's controller (Phyresis Outbreak).
   - "each player has" / "all players have": the sum over every player. */
function _countPlayerCounters(field, desc, ctrlId, selfState) {
  if (typeof Battlefield === 'undefined' || !Array.isArray(Battlefield.players)) return null;
  const players = Battlefield.players;
  const countOf = (id) => {
    const pl = players.find(p => p.id === id);
    return pl && pl.gameState ? (pl.gameState[field] || 0) : 0;
  };
  const sum = (ids) => ids.reduce((n, id) => n + countOf(id), 0);
  if (/\b(?:each|all) players? ha(?:s|ve)\b/.test(desc)) return sum(players.map(p => p.id));
  if (/\b(?:your )?opponents have\b|\beach opponent has\b/.test(desc)) {
    return sum(players.filter(p => p.id !== ctrlId).map(p => p.id));
  }
  if (/\b(?:its|that creature's|that permanent's|enchanted creature's|equipped creature's) controller has\b/.test(desc)) {
    return countOf((selfState && selfState.controller) || ctrlId);
  }
  return countOf(ctrlId);
}
/* [END: FOR-EACH-COMPUTE] */

/* Value of a life-total expression for the player `ctrlId`, or null when the wording is not
   one of the known forms (or it needs an opponent and there is none). `probe` asks only whether
   the wording is known, so the parser can call it before any board exists. */
function _computeLifeExpression(expr, ctrlId, probe) {
  const e = (expr || '').toLowerCase().trim().replace(/\.$/, '');
  const players = (typeof Battlefield !== 'undefined' && Array.isArray(Battlefield.players)) ? Battlefield.players : [];
  const lifeOf = (pl) => (pl.gameState && pl.gameState.currentLife != null) ? pl.gameState.currentLife : 20;
  const me = players.find(pl => pl.id === ctrlId);
  const own = me ? lifeOf(me) : 20;
  const opps = players.filter(pl => pl.id !== ctrlId).map(lifeOf);
  const highestOpp = opps.length ? Math.max(...opps) : null;
  const highestAll = Math.max(own, ...opps);
  const need = (v, f) => probe ? 0 : (v === null ? null : f(v));
  let m;
  if (e === 'your life total') return own;
  if (/^your life total minus the life total of an opponent with the most life$/.test(e)) return need(highestOpp, v => own - v);
  if (/^half the highest life total among your opponents, rounded (up|down)$/.test(e)) {
    return need(highestOpp, v => /up$/.test(e) ? Math.ceil(v / 2) : Math.floor(v / 2));
  }
  if ((m = e.match(/^(\d+) minus the highest life total among players$/))) return parseInt(m[1], 10) - highestAll;
  return null;
}
