/* engine-compute.js — auto-compute helpers used by Layer 7 effects.

   Public functions:
     _computeForEachCount(forEachDesc, allStates, selfState, effect) → number|null
     _computeDevotionCounts(allStates, controller) → { W, U, B, R, G }

   Extracted from engine-helpers.js. */

/* A mutated permanent is one permanent (CR 702.140e), but each card of its stack keeps a state
   of its own in allStates. Counts read it once, as its top card: the cards under it are left out. */
function _buriedMutateIds() {
  const ids = new Set();
  if (typeof Battlefield === 'undefined' || !Battlefield.mutateStacks) return ids;
  for (const stack of Battlefield.mutateStacks) {
    for (let i = 1; i < stack.length; i++) ids.add(stack[i]);
  }
  return ids;
}

/* The permanent a card is part of: the top card of its mutate stack, or the card itself. */
function _mutateTopId(id) {
  const stack = (id && typeof Battlefield !== 'undefined' && Battlefield.getStack) ? Battlefield.getStack(id) : null;
  return stack && stack.length >= 2 ? stack[0] : id;
}

/* allStates without the cards under a mutated permanent's top card (allStates itself when none). */
function _withoutBuriedMutateCards(allStates) {
  if (!allStates) return allStates;
  const buried = _buriedMutateIds();
  if (![...buried].some(id => allStates.has(id))) return allStates;
  const out = new Map();
  for (const [id, st] of allStates) if (!buried.has(id)) out.set(id, st);
  return out;
}

/* Is this state counted as a permanent on the battlefield? Not an emblem or a zone card
   (_isPermanent) and not a spell being cast (Battlefield.addSpell): a spell is on the stack and
   a zone card is in a graveyard, exile or the command zone, and neither is a permanent (CR 110.1). */
function _countsAsPermanent(st) {
  return _isPermanent(st) && !st.isSpell;
}

/* allStates without emblems, spells and zone cards, for iterating: a lookup by id (get / has) still
   finds them, so a condition or count whose source is one of them can read its controller. */
class _PermanentStatesView extends Map {
  constructor(full) {
    super();
    this._full = full;
    for (const [id, st] of full) if (_countsAsPermanent(st)) super.set(id, st);
  }
  get(id) {
    const st = super.get(id);
    return st !== undefined ? st : this._full.get(id);
  }
  has(id) {
    return super.has(id) || this._full.has(id);
  }
}

// Per state map: its view without emblems, spells and zone cards, or null when it holds none. States are changed in
// place and a map's ids are fixed once it is built (checked by its size), so a map is read once.
const _permanentViewCache = new WeakMap();
function _withoutNonPermanents(allStates) {
  if (!allStates || typeof allStates.values !== 'function') return allStates;
  const hit = _permanentViewCache.get(allStates);
  if (hit && hit.size === allStates.size) return hit.view || allStates;
  let view = null;
  for (const st of allStates.values()) if (!_countsAsPermanent(st)) { view = new _PermanentStatesView(allStates); break; }
  _permanentViewCache.set(allStates, { size: allStates.size, view });
  return view || allStates;
}

/* The states a count or a "you control" condition reads: each permanent on the battlefield once
   (a mutated permanent as its top card), and no emblem, spell or zone card. allStates itself when nothing is left out. */
function _permanentStates(allStates) {
  return _withoutNonPermanents(_withoutBuriedMutateCards(allStates));
}

/* [KEY: FOR-EACH-COMPUTE]  —  Auto-compute "for each" counts from battlefield state */
function _computeForEachCount(forEachDesc, allStates, selfState, effect) {
  // A mutated permanent counts once, as its top card, and a card under it that says "this
  // creature" or "other" means the whole permanent, read from the top card's state.
  const srcPermId = effect && effect.sourceId ? _mutateTopId(effect.sourceId) : null;
  const fullStates = allStates;
  allStates = _permanentStates(allStates);
  if (selfState && allStates !== fullStates) {
    for (const [id, st] of fullStates) {
      if (st !== selfState) continue;
      const topId = _mutateTopId(id);
      if (topId !== id && fullStates.get(topId)) selfState = fullStates.get(topId);
      break;
    }
  }
  // Resolve the SOURCE permanent's state for self-references like "counter on this creature".
  // When an effect says "for each counter on [source name]", selfState is the TARGET being
  // modified, but counters are on the SOURCE. Look up source state from allStates.
  const sourceState = (srcPermId && allStates)
    ? (allStates.get(srcPermId) || selfState) : selfState;

  // Detect "you control" / "your opponents control" before stripping them from desc.
  const rawDesc = forEachDesc.toLowerCase().trim();
  const youControl = rawDesc.includes('you control');
  const opponentsControl = rawDesc.includes('your opponents control') || rawDesc.includes("opponents' control") || rawDesc.includes('opponents control');
  // "You" is the controller of the effect's source (an Aura's controller, not the enchanted
  // creature's), falling back to the permanent being modified.
  const ctrlId = (sourceState && sourceState.controller) || (selfState && selfState.controller) || 'player_0';

  let desc = _plainTypeWords(forEachDesc.toLowerCase().trim())
    .replace(/\s+you control$/, '')
    .replace(/\s+your opponents control$/, '')
    .replace(/\s+on the battlefield$/, '')
    .replace(/,?\s*to a maximum of \d+$/, '');

  // Compound CDA: "[A] plus the number of [B]" — sum two independently-computed counts.
  // e.g. Soulless One: "Zombies on the battlefield plus the number of Zombie cards in all graveyards".
  // Each half may be a battlefield type/subtype count or a zone-card (graveyard/exile) count.
  const _plusSplit = desc.split(/\s+plus\s+(?:the\s+)?(?:number|total number|amount)\s+of\s+/);
  if (_plusSplit.length === 2) {
    const _left = _computeCountClause(_plusSplit[0], allStates, selfState, ctrlId);
    const _right = _computeCountClause(_plusSplit[1], allStates, selfState, ctrlId);
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
    // "… the greatest mana value among cards in your graveyard" (Monstrous War-Leech).
    if (/\bgraveyards?$/.test(filter)) {
      const you = (selfState && selfState.controller) || ctrlId;
      return _countInGraveyards('greatest mana value among ' + filter, you, selfState, effect);
    }
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
        const cap = _knownTypeWord(filter) || singular.charAt(0).toUpperCase() + singular.slice(1);
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
      if (excludeSelf && srcPermId && pid === srcPermId) continue;
      if (youControl && st.controller !== ctrlId) continue;
      if (opponentsControl && st.controller === ctrlId) continue;
      let matches = false;
      if (mvDesc === 'permanent' || mvDesc === 'permanents') {
        matches = true;
      } else if (baseTypes[mvWord]) {
        matches = st.types.includes(baseTypes[mvWord]);
      } else {
        const sub = _knownTypeWord(mvDesc) || mvWord.charAt(0).toUpperCase() + mvWord.slice(1);
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
      const owned = _countOwnedInExile(forEachDesc, ctrl, selfState, effect);
      if (owned !== null) return owned;
      return Battlefield.exile.filter(e => e.owner === ctrl).length;
    }
    return null;
  }

  // "… cards you own in exile and in your graveyard" for an effect not flagged as an exile count
  // (Candlekeep Inspiration's base power and toughness).
  if (/\byou own in exile\b/.test(rawDesc)) {
    const owned = _countOwnedInExile(forEachDesc, ctrlId, selfState, effect);
    if (owned !== null) return owned;
  }

  // A count of cards in graveyards (Knight of the Reliquary "land card in your graveyard",
  // Magnivore "sorcery cards in all graveyards"): whose and which cards are the words of the
  // count. "You" is the controller of the object with the ability: for a characteristic-defining
  // ability the permanent itself, else the effect's source, which for a fired ability has no
  // state of its own (Chupacabra Echo's target is an opponent's creature, the graveyard yours).
  if (effect && effect.params && effect.params.isGraveyardCount) {
    const src = effect.sourceId && typeof Battlefield !== 'undefined' ? Battlefield.getPermById(effect.sourceId) : null;
    const srcSt = srcPermId && fullStates ? fullStates.get(srcPermId) : null;
    // (A quoted ability granted to a group, Criminal Past's, is the carrier's: carrierCount.)
    const you = ((effect.type === EFFECT_TYPE.CDA_PT || effect.params.carrierCount) && selfState && selfState.controller)
      || (srcSt && srcSt.controller) || (src && src.controller) || effect.ownerId || ctrlId;
    // "the greatest power among other Dragons you control and Dragon cards in your graveyard"
    // (Skanos Dragonheart): the greater of the battlefield's and the graveyard's.
    const both = rawDesc.match(/^(?:the )?greatest (power|toughness|mana value) among (.+?) and ((?:[\w'-]+ )*cards? in .*graveyards?)$/);
    if (both && typeof buildAppliesToFromText === 'function') {
      const other = /^other\s+/.test(both[2]);
      const group = buildAppliesToFromText(both[2].replace(/^other\s+/, ''));
      const gy = _countInGraveyards('greatest ' + both[1] + ' among ' + both[3], you, selfState, effect);
      if (group && group.fn && !group.isSelf && !group.needsTargetSelection && gy !== null) {
        const selfIds = [srcPermId, src && src.abilitySourceId].filter(Boolean);
        let best = gy;
        for (const [id, st] of allStates) {
          if (other && selfIds.includes(id)) continue;
          let inGroup = false;
          try { inGroup = group.fn(st, allStates, you); } catch (e) { inGroup = false; }
          if (inGroup) best = Math.max(best, both[1] === 'mana value' ? (st.manaValue || 0) : (st[both[1]] || 0));
        }
        return best;
      }
    }
    return _countInGraveyards(forEachDesc, you, selfState, effect);   // null: entered by hand
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
  // <group>" (Chong and Lily: "lore counter among Sagas you control"), "creature types among
  // <group>" (Captain Jonathan Archer: "non-Borg creatures you control"). The group is read as a
  // subject is (buildAppliesToFromText), "you control" meaning the effect's controller.
  const amongMatch = rawDesc.match(/^(?:colou?rs?|creature types?|(?:(?:an?|one)\s+)?(?:([+-]\d+\/[+-]\d+|[a-z]+)\s+)?counters?)\s+among\s+(.+)$/);
  if (amongMatch && typeof buildAppliesToFromText === 'function') {
    const group = buildAppliesToFromText(amongMatch[2].replace(/\s+on the battlefield$/, ''));
    if (group && group.fn && !group.isSelf && !group.needsTargetSelection) {
      const inGroup = [...allStates].filter(([, st]) => { try { return group.fn(st, allStates, ctrlId); } catch (e) { return false; } });
      if (/^colou?r/.test(rawDesc)) {
        const found = new Set();
        for (const [, st] of inGroup) for (const c of (st.colors || [])) found.add(c);
        return found.size;
      }
      if (/^creature type/.test(rawDesc)) {
        const found = new Set();
        for (const [, st] of inGroup) for (const s of (st.subtypes || [])) if (TypeCatalog.isCreatureType(s)) found.add(s);
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
        return TypeCatalog.isCreatureType(s);
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
    const known = _knownTypeWord(s);   // any type known now, a new one too
    if (known) return known;
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
      if (st.types.includes('Creature') && (st.subtypes || []).some(s => own.has(s) && (!TypeCatalog.creatureTypes.size || TypeCatalog.isCreatureType(s)))) count++;
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
          if (notSource && srcPermId && pid === srcPermId) continue;
          if (youControl && st.controller !== ctrlId) continue;
          if (opponentsControl && st.controller === ctrlId) continue;
          if (checks.every(fn => fn(st))) count++;
        }
        return count;
      }
    }
  }

  // --- Stickers (CR 123): "for each name sticker on it" (_____ _____ _____ Trespasser), "for
  // each name sticker on this Aura with seven or fewer letters" (Last Voyage of the _____),
  // "… with eight or more letters" (Fight the _____ Fight). "It" is the permanent being
  // modified, "this <word>" or its name the effect's source, as with counters below. ---
  const stickerCountMatch = desc.match(/^(?:(?:an?|one)\s+)?(?:(name|art|ability|power and toughness)\s+)?stickers?\s+on\s+(.+?)(?:\s+with\s+(\w+)\s+or\s+(fewer|more)\s+letters)?$/);
  if (stickerCountMatch) {
    const holderText = stickerCountMatch[2].trim();
    const srcName = ((sourceState && sourceState.name) || '').toLowerCase();
    let holder = null;
    if (/^(?:it|that creature|that permanent)$/.test(holderText)) holder = selfState;
    else if (/^this\s+[a-z]+$/.test(holderText) || (srcName && holderText === srcName)) holder = sourceState;
    if (holder) {
      const kind = { name: 'name', art: 'art', ability: 'ability', 'power and toughness': 'pt' }[stickerCountMatch[1] || ''] || null;
      const n = stickerCountMatch[3] ? _parseWordNumber(stickerCountMatch[3]) : null;
      return (holder.stickers || []).filter(s => (!kind || s.kind === kind) &&
        (n == null || (stickerCountMatch[4] === 'fewer' ? stickerLetters(s.text) <= n : stickerLetters(s.text) >= n))).length;
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

/* Does this card have every creature type wherever it is? Changeling (CR 702.73a) and "This card
   is every creature type" (Mistform Ultimus) are characteristic-defining and work in every zone
   (CR 604.3), also where cards lose all abilities (layer 4 is before layer 6). Read off the
   printed text without evaluating the card: the board's own evaluation asks this. Outside the
   battlefield a card is its front face, but for a split card, which is both (CR 709.4, 712.8a). */
function _cardIsEveryCreatureType(card) {
  if (!card) return false;
  const faces = card.card_faces || [];
  const shown = card.oracle_text || !faces.length ? [card] : card.layout === 'split' ? faces : [faces[0]];
  return shown.some(f => String(f.oracle_text || '').replace(/\s*\([^)]*\)/g, '').split('\n').some(line => {
    const t = (f.name ? line.split(f.name).join('this card') : line).trim();
    return /^(?:[a-z ]+,\s*)*changeling\s*(?:,|$)/i.test(t) || /^this (?:card|creature) is (?:every|all) creature types?\.?$/i.test(t);
  }));
}

/* A card as it is outside the battlefield: its front face (CR 712.8a), a flip card's unflipped
   half (CR 710.1), an Adventure, Omen or prepare card without its spell (CR 715.4), and a split
   card both halves together (CR 709.4). Scryfall's record of such a card has "A // B" for a name
   and type line and no rules text of its own. A card saved showing its back is its front again. */
function _zoneCardFront(card) {
  const faces = card && card.card_faces;
  if (!faces || !faces.length) return card;
  const front = { ...card, layout: 'normal', card_faces: undefined };
  if (card.layout === 'split') {
    front.oracle_text = faces.map(f => f.oracle_text || '').filter(Boolean).join('\n');
    return front;
  }
  const f = faces[0];
  for (const k of ['name', 'type_line', 'oracle_text', 'mana_cost', 'power', 'toughness']) front[k] = f[k];
  front.colors = f.colors || card.colors || [];
  return front;
}

/* Is this card a creature card in that zone? Print answers, but for a card whose own text makes
   it one off the battlefield (Grist, the Hunger Tide), which is evaluated there. */
function _zoneCardIsCreature(card, zone) {
  const front = _zoneCardFront(card);
  if (parseTypeLine(front.type_line || '').types.includes('Creature')) return true;
  return /\bisn['’]t on the battlefield\b/i.test(front.oracle_text || '') && _isCreatureCardInZone(front, zone);
}

/* "The top card of your library is <quality>", "a card exiled with this creature is <quality>":
   one or more alternatives joined by "or", each of words for a colour, a card type or a subtype
   ("black", "artifact or creature", "creature or lesson"). */
function _zoneCardIs(card, quality, zone) {
  if (!card) return false;
  const front = _zoneCardFront(card);
  return String(quality).toLowerCase().split(/\s+or\s+/).some(part => part.split(/\s+/).filter(Boolean).every(word =>
    COLOR_NAMES[word] ? (front.colors || []).includes(COLOR_NAMES[word])
      : word === 'creature' ? _zoneCardIsCreature(front, zone)
      : _zoneCardMatchesQualifier(front, word)));
}

/* The last creature card exiled with a permanent (Duplicant), as it is in exile: what was exiled
   after it and is no creature card does not matter. { card, owner } or null. */
function _lastCreatureCardExiledWith(sourceId) {
  const entries = _getImprintedExileEntries(sourceId);
  for (let i = entries.length - 1; i >= 0; i--) {
    const { card, owner } = entries[i];
    if (card && _zoneCardIsCreature(card, 'exile')) return { card: _zoneCardFront(card), owner };
  }
  return null;
}

/* That card's creature types, power and toughness. Print answers unless the card works them out
   itself in exile (Tarmogoyf's star, Grist's 1/1 Insect): then it is evaluated there, once (an
   evaluation inside that one reads the print). */
function _exiledCreatureValues({ card, owner }) {
  const printed = parseTypeLine(card.type_line || '');
  const isNumber = (v) => /^-?\d+$/.test(String(v));
  let { power, toughness } = card, subtypes = printed.subtypes;
  if ((!printed.types.includes('Creature') || !isNumber(power) || !isNumber(toughness)) && _zoneEvalDepth === 0) {
    const inExile = computeZoneCardState(card, 'exile', owner);
    if (inExile && inExile.final) ({ power, toughness, subtypes } = inExile.final);
  }
  return {
    power: parseInt(power, 10) || 0, toughness: parseInt(toughness, 10) || 0,
    creatureTypes: _zoneCardSubtypes(card, subtypes).filter(s => TypeCatalog.isCreatureType(s)),
  };
}

// A card's subtypes outside the battlefield, given the ones printed on it.
function _zoneCardSubtypes(card, printed) {
  return _cardIsEveryCreatureType(card) ? [...new Set([...printed, ...TypeCatalog.everyCreatureType()])] : printed;
}

// Match a real card object (from a graveyard/exile zone) against a type/subtype qualifier
// like "zombie", "creature", or "zombie creature". Returns true if the card satisfies ALL words.
function _zoneCardMatchesQualifier(card, qualifier) {
  const parsed = (typeof parseTypeLine === 'function')
    ? parseTypeLine((card && card.type_line) || '')
    : { types: [], subtypes: [], supertypes: [] };
  const words = qualifier.toLowerCase().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'card' || w === 'cards') continue;
    const phrase = _typePhraseAt(words, i);   // a subtype of several words is one
    if (phrase) i += phrase.length - 1;
    const sing = phrase ? phrase.type : (typeof singularizeCreatureType === 'function')
      ? singularizeCreatureType(w)
      : (w.endsWith('s') && w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1, -1) : w.charAt(0).toUpperCase() + w.slice(1));
    const lw = sing.toLowerCase();
    if (_ZONE_CLAUSE_TYPE_WORDS[lw]) {
      if (!parsed.types.includes(_ZONE_CLAUSE_TYPE_WORDS[lw])) return false;
    } else if (!_zoneCardSubtypes(card, parsed.subtypes).includes(sing)) {
      return false;
    }
  }
  return true;
}

// Count the cards in exile that match a qualifier.
function _countExiledCardsByQualifier(qualifier) {
  if (typeof Battlefield === 'undefined') return 0;
  const cards = (Array.isArray(Battlefield.exile) ? Battlefield.exile : []).map(e => e.card || e);
  const q = (qualifier || '').toLowerCase().trim();
  let count = 0;
  for (const card of cards) {
    if (!q || q === 'card' || q === 'cards') { count++; continue; }
    if (_zoneCardMatchesQualifier(card, q)) count++;
  }
  return count;
}

const _PERMANENT_CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'];   // CR 110.4a

/* The graveyards a count or condition reads: as they were when the spell was cast or the ability
   fired, for one that has a snapshot of them (_snapshotGraveyards, CR 608.2h: a spell or ability
   reads the board as it resolves), else as they are now. One { id, graveyard } per player. */
function _graveyardsFor(effect) {
  const src = effect && effect.sourceId && typeof Battlefield !== 'undefined' ? Battlefield.getPermById(effect.sourceId) : null;
  if (src && Array.isArray(src._firedAtGraveyards)) {
    return Battlefield.players.map(p => {
      const snap = src._firedAtGraveyards.find(g => g.id === p.id);
      return { id: p.id, graveyard: snap ? snap.graveyard : (p.graveyard || []) };
    });
  }
  return Battlefield.players;
}

/* The graveyards of every player as they are now, for a spell or ability to keep: each card cut
   to what a count or condition reads of it. */
function _snapshotGraveyards() {
  if (typeof Battlefield === 'undefined' || !Array.isArray(Battlefield.players)) return null;
  const keep = ['name', 'type_line', 'mana_cost', 'cmc', 'colors', 'oracle_text', 'keywords', 'layout'];
  const slim = (c) => {
    const o = {};
    for (const k of keep) if (c[k] !== undefined) o[k] = c[k];
    if (Array.isArray(c.card_faces)) o.card_faces = c.card_faces.map(f => slim(f));
    return o;
  };
  return Battlefield.players.map(p => ({ id: p.id, graveyard: (p.graveyard || []).filter(Boolean).map(slim) }));
}

/* The players whose graveyards a count names, or null when the board does not say (a player not
   chosen yet, the defending player of a creature that is not attacking, words not read). */
function _graveyardPlayers(whose, you, modified, effect) {
  const players = _graveyardsFor(effect);
  if (/^(?:|all|each|every|a|any)$/.test(whose)) return players;
  if (whose === 'your') return players.filter(p => p.id === you);
  if (/^(?:your opponents'|each opponent's)$/.test(whose)) return players.filter(p => p.id !== you);
  let id = null;
  if (/^(?:its|that creature's|that permanent's|enchanted creature's|equipped creature's) controller's$/.test(whose)) {
    id = modified && modified.controller;
  } else if (whose === "defending player's") {
    id = _attackedPlayerId(modified);
  } else if (whose === "the chosen player's") {
    const src = effect && effect.sourceId ? Battlefield.getPermById(effect.sourceId) : null;
    id = src && src._targetPlayerId;
  }
  return id ? players.filter(p => p.id === id) : null;
}

// Grist is a creature card off the battlefield by its own text (CR 604.3), which a count made
// while evaluating a card in a graveyard (Lhurgoyf there) cannot evaluate again.
function _creatureByOwnText(card) {
  return /\bisn['’]t on the battlefield\b[^.]*\bcreature\b/i.test(card.oracle_text || '');
}

/* The creature types a permanent gives creature cards outside the battlefield (Maskwood Nexus:
   "The same is true for … creature cards you own that aren't on the battlefield"; Arcane
   Adaptation, the chosen type): a creature card owned by that permanent's controller has them in
   a graveyard. Read off the permanent's own type effect, which reaches only permanents. */
function _zoneCardHasGrantedSubtype(card, subtype, owner) {
  if (!owner || typeof Battlefield === 'undefined' || !Array.isArray(Battlefield.effects)) return false;
  if (!TypeCatalog.isCreatureType(subtype)) return false;
  if (!_creatureByOwnText(card) && !parseTypeLine(card.type_line || '').types.includes('Creature')) return false;
  return Battlefield.effects.some(e => {
    if (e.layer !== '4' || e.type !== EFFECT_TYPE.ADD_TYPE) return false;
    const src = Battlefield.getPermById(e.sourceId);
    if (!src || src.controller !== owner || !/\bcreature cards you own that aren['’]t on the battlefield\b/i.test(src.oracleText || '')) return false;
    if (e.params && e.params.gainsAllCreatureTypes) return true;
    return ((e.params && e.params.subtypes) || []).includes(subtype);
  });
}
function _zoneCardHasSubtype(card, subtype, owner) {
  return _zoneCardMatchesQualifier(card, subtype) || _zoneCardHasGrantedSubtype(card, subtype, owner);
}

/* A test of a card as it is in a graveyard (_zoneCardFront) for the words before "card(s)":
   "land", "nonbasic land", "instant and sorcery", "artifact and/or enchantment", "creature,
   instant, and sorcery", "noncreature, nonland", "permanent", "historic", "colorless", "Lesson".
   A list is any of them, each card once, but a list of nothing but "non" words is all of them.
   Null when a word is none of a card type, supertype, colour or subtype known now: never a guess.
   The test takes the card and its owner, whose permanents may give it a type there. */
function _graveyardCardQuality(words) {
  const oneWord = (word) => {
    const type = _ZONE_CLAUSE_TYPE_WORDS[word];
    if (word === 'creature') return (card) => _creatureByOwnText(card) || _isCreatureCardInZone(card, 'graveyard');
    if (type) return (card) => _zoneCardMatchesQualifier(card, word);
    if (word === 'permanent') return (card) => parseTypeLine(card.type_line || '').types.some(t => _PERMANENT_CARD_TYPES.includes(t));
    // Historic: an artifact, a legendary or a Saga (CR 700.6).
    if (word === 'historic') return (card) => { const p = parseTypeLine(card.type_line || ''); return p.types.includes('Artifact') || p.supertypes.includes('Legendary') || p.subtypes.includes('Saga'); };
    if (/^(?:basic|legendary|snow|world)$/.test(word)) {
      const sup = word.charAt(0).toUpperCase() + word.slice(1);
      return (card) => parseTypeLine(card.type_line || '').supertypes.includes(sup);
    }
    // "have an Adventure" (Candlekeep Inspiration): the whole card's layout, not its front.
    if (word === 'adventure') return (card, owner, raw) => ((raw || card).layout || '') === 'adventure';
    if (word === 'colorless') return (card) => !(card.colors || []).length;
    if (word === 'multicolored') return (card) => (card.colors || []).length > 1;
    if (word === 'monocolored') return (card) => (card.colors || []).length === 1;
    if (COLOR_NAMES[word]) return (card) => (card.colors || []).includes(COLOR_NAMES[word]);
    const subtype = _knownTypeWord(word);
    if (subtype) return (card, owner) => _zoneCardHasSubtype(card, subtype, owner);
    const not = word.match(/^non-?(.+)$/);
    const negated = not && oneWord(not[1]);
    return negated ? (card, owner, raw) => !negated(card, owner, raw) : null;
  };
  const items = words.split(/,?\s+(?:and\/or|and|or)\s+|,\s*/);
  const tests = [];
  for (const item of items) {
    const ws = item.split(/\s+/).filter(Boolean), all = [];
    if (!ws.length) return null;
    for (let i = 0; i < ws.length; i++) {
      const phrase = _typePhraseAt(ws, i);   // "Time Lord"
      const test = oneWord(phrase ? phrase.type.toLowerCase() : ws[i]);
      if (!test) return null;
      all.push(test);
      if (phrase) i += phrase.length - 1;
    }
    tests.push((card, owner, raw) => all.every(t => t(card, owner, raw)));
  }
  return items.every(item => /^non/.test(item))
    ? (card, owner, raw) => tests.every(t => t(card, owner, raw))
    : (card, owner, raw) => tests.some(t => t(card, owner, raw));
}

/* Does this card, as it is in that zone, have cycling (typecycling is cycling, CR 702.29f)? */
function _zoneCardHasCycling(card) {
  return /(?:^|,\s*)(?:[a-z]+ )?[a-z]*cycling(?:\s*\{|\s*[—,]|\s*$)/im.test(String(card.oracle_text || '').replace(/\([^)]*\)/g, ''));
}

/* Does this card, as it is in a graveyard, have that keyword ("a creature card in your graveyard
   has flying": Bleeding Effect, Cairn Wanderer)? Read off its print: a keyword is a line of its
   own or of a keyword list. */
function _zoneCardHasKeyword(card, keyword) {
  const kw = keyword.toLowerCase();
  if ((card.keywords || []).some(k => k.toLowerCase() === kw)) return true;
  const text = String(card.oracle_text || '').replace(/\([^)]*\)/g, '').toLowerCase();
  return text.split('\n').some(line => line.split(/,\s*/).some(part => part.trim() === kw || part.trim().startsWith(kw + ' ')));
}

/* A count of cards in graveyards, read from its own words ("land card in your graveyard",
   "card types among cards in all graveyards"), or null when the board cannot know the number
   ("cards in your graveyard with an art sticker"): then it is typed in. */
function _countInGraveyards(text, you, modified, effect) {
  if (typeof Battlefield === 'undefined' || !Array.isArray(Battlefield.players)) return null;
  const t = String(text || '').toLowerCase().replace(/’/g, "'").trim();
  // "for each graveyard with seven or more cards in it" (Master's Councillors).
  const full = t.match(/^graveyards? with (\w+) or more cards in (?:it|them)$/);
  if (full) return _graveyardsFor(effect).filter(p => (p.graveyard || []).length >= _parseWordNumber(full[1])).length;

  // "cards in your graveyard with an art sticker" (Roxi): the sticker words are the cards'.
  const stk = t.match(/^(.+?) (in (?:.+ )?graveyards?) (with (?:a|an) (?:(?:name|art|ability|power and toughness) )?stickers?(?: on (?:it|them))?)$/);
  const m = (stk ? `${stk[1]} ${stk[3]} ${stk[2]}` : t).match(/^(.+) in (?:(.+) )?graveyards?$/);
  if (!m) return null;
  const players = _graveyardPlayers(m[2] || '', you, modified, effect);
  if (!players) return null;
  return _countGraveyardCards(m[1], players, modified, effect);
}

/* What `what` counts among the cards of those players' graveyards ("creature cards", "card types
   among cards", "instant and/or sorcery cards", "other Zombie cards named …", "the greatest power
   among creature cards"), or null when its words are not read. */
function _countGraveyardCards(what, players, modified, effect) {
  const entries = [];
  for (const p of players) for (const c of (p.graveyard || [])) if (c) entries.push({ card: _zoneCardFront(c), raw: c, owner: p.id });
  return _countZoneCards(what, entries, modified, effect);
}

/* The number `what` gives over zone cards ({ card: as it is there, raw: the whole card, owner }).
   Shared by graveyard counts and counts of cards you own in exile and in your graveyard. */
function _countZoneCards(what, entries, modified, effect) {
  what = what.replace(/^(.+? cards?) among cards$/, '$1');   // "twenty or more instant and/or sorcery cards among cards in your graveyard"
  const cards = entries.map(e => e.card);

  // "the greatest power among creature cards in your graveyard" (Carrion Grub, Coram), "the
  // greatest mana value among cards in your graveyard" (Monstrous War-Leech, Wick's Patrol): 0
  // when there is none. A "*" is 0 off the battlefield, as the print has it.
  const greatest = what.match(/^(?:the )?greatest (power|toughness|mana value) among (.+)$/);
  if (greatest) {
    const among = _zoneCardsMatching(greatest[2], entries, modified, effect);
    if (!among) return null;
    const stat = (c) => greatest[1] === 'mana value' ? (c.cmc ?? (_cmcFromManaCost(c.mana_cost) || 0)) : (parseInt(c[greatest[1]], 10) || 0);
    return among.reduce((best, e) => Math.max(best, stat(e.card)), 0);
  }

  // Tarmogoyf counts types, not cards: two creature cards are one type. "Permanent types"
  // (Matzalantli) are only the permanent card types among them.
  const typesAmong = what.match(/^(card|permanent) types? among cards$/);
  if (typesAmong) {
    const found = new Set();
    for (const card of cards) {
      for (const type of parseTypeLine(card.type_line || '').types) found.add(type);
      if (_creatureByOwnText(card)) found.add('Creature');
    }
    if (typesAmong[1] === 'permanent') for (const type of [...found]) if (!_PERMANENT_CARD_TYPES.includes(type)) found.delete(type);
    return found.size;
  }
  // All-Seeing Arbiter; descend's "mana values among cards" (Aven Heartstabber) is the same.
  if (/^(?:different )?mana values among cards$/.test(what)) {
    return new Set(cards.map(c => c.cmc ?? (_cmcFromManaCost(c.mana_cost) || 0))).size;
  }
  // Chroma (Umbra Stalker): a hybrid or Phyrexian symbol of that colour counts.
  const symbols = what.match(/^(white|blue|black|red|green) mana symbols? in the mana costs of cards$/);
  if (symbols) {
    const letter = COLOR_NAMES[symbols[1]];
    return cards.reduce((n, c) => n + ((c.mana_cost || '').match(/\{[^}]*\}/g) || []).filter(s => s.includes(letter)).length, 0);
  }
  const matching = _zoneCardsMatching(what, entries, modified, effect);
  return matching ? matching.length : null;
}

/* The zone cards (as _countZoneCards takes them) that "[quality] card(s) [named …| with …]"
   names, or null when the words are not read. */
function _zoneCardsMatching(what, entries, modified, effect) {
  // "cards with an art sticker [on them]", "creature card with a sticker on it" (CR 123.5: a card
  // keeps its stickers in a graveyard or in exile; they are on the card object, `raw`).
  const stk = what.match(/^(.+?) with (?:a|an) (?:(name|art|ability|power and toughness) )?stickers?(?: on (?:it|them))?$/);
  if (stk) {
    const kind = { name: 'name', art: 'art', ability: 'ability', 'power and toughness': 'pt' }[stk[2] || ''] || null;
    const rest = _zoneCardsMatching(stk[1], entries, modified, effect);
    return rest && rest.filter(e => ((e.raw && e.raw.stickers) || []).some(s => !kind || s.kind === kind));
  }
  const w = what.match(/^(?:(.+?) )??cards?(?: named (.+)| with (cycling|[a-z]+(?: [a-z]+)?))?$/);
  if (!w) return null;
  let quality = w[1] || '';
  entries = entries.slice();
  if (/^other\b/.test(quality)) {
    quality = quality.replace(/^other\s*/, '');
    // Boneyard Mycodrax is one of the cards only while it is in that graveyard itself.
    if (effect && effect.inZone === 'graveyard' && modified && modified.isZoneCard) {
      const own = entries.findIndex(e => e.card.name === modified.name);
      if (own >= 0) entries.splice(own, 1);
    }
  }
  if (quality) {
    const test = _graveyardCardQuality(quality);
    if (!test) return null;
    entries = entries.filter(e => test(e.card, e.owner, e.raw));
  }
  if (w[2]) {
    let named = w[2];
    if (/^this (?:card|spell|creature)$/.test(named)) {   // Growth Cycle, its own name read as "this card"
      const src = effect && effect.sourceId ? Battlefield.getPermById(effect.sourceId) : null;
      if (!src || !src.name) return null;
      named = src.name.toLowerCase();
    }
    // A split card has both names (CR 709.4a). A card that says effects of a spell of that name
    // count it as a card of that name is one (Diligent Farmhand: "… named Muscle Burst count it
    // as a card named Muscle Burst"): only a spell of that name counts cards by it.
    const countsAs = (c) => new RegExp('\\bcount it as a card named ' + named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(c.oracle_text || '');
    entries = entries.filter(e => String(e.card.name || '').toLowerCase().split(' // ').includes(named) || countsAs(e.card));
  }
  if (w[3] === 'cycling') entries = entries.filter(e => _zoneCardHasCycling(e.card));
  else if (w[3]) {
    if (typeof KEYWORD_LIST !== 'undefined' && !KEYWORD_LIST.includes(w[3]) && w[3] !== 'flashback') return null;
    entries = entries.filter(e => _zoneCardHasKeyword(e.card, w[3]));
  }
  return entries;
}

/* A count of cards one player owns in exile, or in exile and in their graveyard: "instant and
   sorcery cards you own in exile and in your graveyard" (Crackling Drake), "cards you own in exile
   and in your graveyard that are instant cards, are sorcery cards, and/or have an Adventure"
   (Candlekeep Inspiration), "cards with flashback you own in exile" (Seize the Storm's token).
   A face-down card in exile has no qualities (CR 708.2), so only "cards" counts it. Null when the
   words are no such count or are not read. */
function _countOwnedInExile(text, you, modified, effect) {
  if (typeof Battlefield === 'undefined') return null;
  const t = String(text || '').toLowerCase().replace(/’/g, "'").trim();
  const m = t.match(/^(.+?) you own in exile( and in your graveyard)?(?: that (.+))?$/);
  if (!m) return null;
  let what = m[1];
  if (m[3]) {
    // "that are instant cards, are sorcery cards, and/or have an Adventure": a quality list.
    const parts = m[3].split(/,\s*(?:and\/or\s+|or\s+|and\s+)?|\s+and\/or\s+|\s+or\s+/).map(x => x.trim()).filter(Boolean)
      .map(x => x.replace(/^are\s+(?:an?\s+)?/, '').replace(/\s+cards?$/, '').replace(/^have an adventure$/, 'adventure'));
    if (!/^cards?$/.test(what) || !parts.length) return null;
    what = parts.join(' or ') + ' cards';
  }
  const entries = [];
  for (const e of (Array.isArray(Battlefield.exile) ? Battlefield.exile : [])) {
    if ((e.owner || Battlefield.activePlayerId) !== you) continue;
    const c = e.card || e;
    entries.push({ card: e.isFaceDown ? { name: '', type_line: '', oracle_text: '', colors: [] } : _zoneCardFront(c), raw: e.isFaceDown ? {} : c, owner: you });
  }
  if (m[2]) {
    for (const p of _graveyardsFor(effect)) if (p.id === you) for (const c of (p.graveyard || [])) if (c) entries.push({ card: _zoneCardFront(c), raw: c, owner: p.id });
  }
  return _countZoneCards(what, entries, modified, effect);
}

/* How many a condition asks for, as a test of a number: "seven or more", "two or fewer", "fewer
   than five", "at least twenty", "no", "a" / "an" (one or more). Null for words not read. */
function _amountTest(words) {
  const w = String(words || '').trim();
  const num = (s) => /^\d+$/.test(s) ? parseInt(s, 10) : (typeof WORD_TO_NUM !== 'undefined' ? WORD_TO_NUM[s] : undefined);
  if (/^(?:an?|one or more|any)$/.test(w)) return (n) => n >= 1;
  if (w === 'no') return (n) => n === 0;
  let m = w.match(/^(\w+) or (more|greater|fewer|less)$/);
  if (m) {
    const k = num(m[1]);
    if (k === undefined) return null;
    return /^(?:more|greater)$/.test(m[2]) ? (n) => n >= k : (n) => n <= k;
  }
  m = w.match(/^(at least|fewer than|less than|more than|exactly) (\w+)$/);
  if (m) {
    const k = num(m[2]);
    if (k === undefined) return null;
    return { 'at least': (n) => n >= k, 'fewer than': (n) => n < k, 'less than': (n) => n < k, 'more than': (n) => n > k, exactly: (n) => n === k }[m[1]];
  }
  const k = num(w);
  return k === undefined ? null : (n) => n === k;
}

const _GY_AMOUNT = "((?:\\w+ or (?:more|greater|fewer|less))|(?:at least|fewer than|less than|more than|exactly) \\w+|no|an?|\\w+)";

/* A condition about the cards in graveyards, as (you, modified, effect) => true / false, or null
   when the words are no such condition. "You" is the controller of the spell, ability or
   permanent with the condition; `modified` the permanent being changed ("its controller has seven
   or more cards in their graveyard": So Tiny); `effect.sourceId` the object whose snapshot of the
   graveyards a spell or fired ability reads. Words of a graveyard condition that are not read are
   false, never "always":
   - "there are seven or more cards in your graveyard", "there's a Lesson card in your graveyard",
     "there are four or more card types among cards in your graveyard", "there are ten or more
     cards in a single graveyard", "there are seven or more creature cards total in all graveyards"
   - "seven or more cards are in your graveyard", "an artifact card is in your graveyard"
   - "an opponent has eight or more cards in their graveyard", "you have no cards in your
     graveyard", "its controller has seven or more cards in their graveyard"
   - "a graveyard has twenty or more cards in it"
   - "an instant card and a sorcery card are in your graveyard" (each of them)
   - "a creature card in your graveyard has flying" */
function _graveyardCondition(text) {
  let t = String(text || '').toLowerCase().replace(/’/g, "'").trim()
    .replace(/^there's\b/, 'there is')
    .replace(/\s+as you cast this spell$/, '');
  if (!/\bgraveyards?\b/.test(t)) return null;
  const fail = () => false;
  // whose: the words before "graveyard(s)"; mode 'sum' adds their cards up, 'any' / 'every' asks
  // it of each of them alone.
  const build = (amount, what, whose, mode) => {
    const test = _amountTest(amount);
    if (!test) return fail;
    what = what.replace(/\s+total$/, '');
    return (you, modified, effect) => {
      if (typeof Battlefield === 'undefined' || !Array.isArray(Battlefield.players)) return false;
      let players;
      if (whose === 'a single' || whose === 'any one') { players = _graveyardsFor(effect); mode = 'any'; }
      else if (whose === "an opponent's" || whose === "target opponent's") { players = _graveyardsFor(effect).filter(p => p.id !== you); mode = 'any'; }
      else players = _graveyardPlayers(whose, you, modified, effect);
      if (!players) return false;
      const groups = mode === 'sum' ? [players] : players.map(p => [p]);
      if (!groups.length) return false;
      const results = groups.map(g => { const n = _countGraveyardCards(what, g, modified, effect); return n !== null && test(n); });
      return mode === 'every' ? results.every(Boolean) : results.some(Boolean);
    };
  };
  const WHOSE = "(your|a single|an opponent's|target opponent's|a|an|all|each|every|their|its controller's)?\\s*";
  // "an instant card and a sorcery card are in your graveyard" (Bloodfire Enforcers).
  let m = t.match(new RegExp('^((?:an? [\\w\\s/-]+? card)(?: and an? [\\w\\s/-]+? card)+) are in ' + WHOSE + 'graveyards?$'));
  if (m) {
    const parts = m[1].split(/ and (?=an? )/).map(p => build('a', p.replace(/^an? /, ''), m[2] || 'all', 'sum'));
    return (you, modified, effect) => parts.every(p => p(you, modified, effect));
  }
  // "a creature card in your graveyard has flying" (Bleeding Effect).
  m = t.match(new RegExp('^an? ([\\w\\s/-]+? card) in ' + WHOSE + 'graveyards? has ([a-z]+(?: [a-z]+)?)$'));
  if (m) return build('a', m[1] + 's with ' + m[3], m[2] || 'all', 'sum');
  m = t.match(new RegExp('^there (?:are|is) ' + _GY_AMOUNT + ' (.+?) in ' + WHOSE + 'graveyards?$'));
  if (m) return build(m[1], m[2], m[3] || 'all', 'sum');
  m = t.match(new RegExp('^' + _GY_AMOUNT + ' (.+?) (?:are|is) in ' + WHOSE + 'graveyards?$'));
  if (m) return build(m[1], m[2], m[3] || 'all', 'sum');
  m = t.match(/^a graveyard has (.+?) cards in it$/);
  if (m) return build(m[1], 'cards', 'all', 'any');
  m = t.match(new RegExp("^(you|an opponent|each opponent|target opponent|a player|each player|its controller|that creature's controller|enchanted creature's controller) (?:has|have) " + _GY_AMOUNT + " (.+?) in (?:your|their|his or her|its) graveyards?$"));
  if (m) {
    const who = m[1];
    if (who === 'you') return build(m[2], m[3], 'your', 'sum');
    if (who === 'an opponent' || who === 'target opponent') return build(m[2], m[3], "your opponents'", 'any');
    if (who === 'each opponent') return build(m[2], m[3], "your opponents'", 'every');
    if (who === 'a player') return build(m[2], m[3], 'all', 'any');
    if (who === 'each player') return build(m[2], m[3], 'all', 'every');
    return build(m[2], m[3], who.replace(/^its controller$/, 'its') + (who === 'its controller' ? " controller's" : "'s"), 'sum');
  }
  return null;
}

/* The number typed on the row of a graveyard count: kept on the effect's source, where the input
   is, and not on the creature an Aura, Equipment, spell or fired ability changes. */
function _typedGraveyardCount(effect) {
  const holder = effect.sourceId && typeof Battlefield !== 'undefined' ? Battlefield.getPermById(effect.sourceId) : null;
  return holder ? (holder.cdaUserValue ?? null) : null;
}

// Compute one clause of a compound CDA count (see _computeForEachCount). A clause is either a
// zone-card count ("zombie cards in all graveyards") or a battlefield type/subtype count
// ("zombies on the battlefield"). A zero half is 0, so it doesn't void the sum; null only for a
// graveyard half that cannot be read. `you` is whose "your graveyard" is.
function _computeCountClause(clause, allStates, selfState, you) {
  allStates = _permanentStates(allStates);
  let c = (clause || '').toLowerCase().trim().replace(/\.$/, '');
  if (/\bgraveyards?\b/.test(c)) {
    return _countInGraveyards(c, you || (selfState && selfState.controller) || 'player_0', selfState, null);
  }
  if (/\byou own in exile\b/.test(c)) return _countOwnedInExile(c, you || (selfState && selfState.controller) || 'player_0', selfState, null);
  if (/\bexile\b/.test(c)) return _countExiledCardsByQualifier(c.replace(/\s+in\s+exile$/, '').trim());
  // Battlefield clause: count permanents matching the type/subtype.
  c = c.replace(/\s+on\s+the\s+battlefield$/, '').trim();
  // "permanents you control with an art sticker" (Roxi, CR 123).
  let stickered = () => true;
  const stk = c.match(/^(.+?) with (?:a|an) (?:(name|art|ability|power and toughness) )?stickers?(?: on (?:it|them))?$/);
  if (stk) {
    const kind = { name: 'name', art: 'art', ability: 'ability', 'power and toughness': 'pt' }[stk[2] || ''] || null;
    stickered = (st) => (st.stickers || []).some(s => !kind || s.kind === kind);
    c = stk[1];
  }
  const youControl = /\byou control$/.test(c);
  c = c.replace(/\s+you control$/, '').trim();
  const ctrlId = (selfState && selfState.controller) || 'player_0';
  if (c === 'permanent' || c === 'permanents') {
    let n = 0;
    for (const [, st] of allStates) { if (youControl && st.controller !== ctrlId) continue; if (stickered(st)) n++; }
    return n;
  }
  const sing = (typeof singularizeCreatureType === 'function')
    ? singularizeCreatureType(c)
    : (c.endsWith('s') && c.length > 2 ? c.charAt(0).toUpperCase() + c.slice(1, -1) : c.charAt(0).toUpperCase() + c.slice(1));
  const lw = sing.toLowerCase();
  let n = 0;
  for (const [, st] of allStates) {
    if (youControl && st.controller !== ctrlId) continue;
    if (!stickered(st)) continue;
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
  // A mutated permanent's mana cost is its top card's (CR 702.140e): cards under it add nothing.
  for (const [, st] of _permanentStates(allStates)) {
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
