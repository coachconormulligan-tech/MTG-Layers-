/* engine-stickers.js — stickers (CR 123): the effects a permanent's stickers make.

   A sticker is no counter, token or object (123.1): it is a marker on the card that changes its
   characteristics, and those changes are not part of its copiable values. So a sticker is an
   effect of the permanent it is on, applied to itself, with a timestamp of its own (613.7k):
   - a name sticker adds its word(s) to the name in layer 3, a text-changing effect (612.9), at
     the place the player chose (123.6b-c);
   - an ability sticker gives the ability in layer 6 (123.7), and a static ability on it ("This
     creature gets +3/+3 as long as you have no cards in hand") works as the card's own would;
   - a power and toughness sticker sets P/T in layer 7b (123.8), only while it is a creature;
   - an art sticker changes nothing (123.9): it is a marker other cards read.
   The stickers themselves live on `perm.stickers` (Battlefield.addSticker); these effects are
   built as the board is evaluated (_evaluateBoard), never kept in Battlefield.effects, so no
   re-parse of the card can drop them. A Clone copying a stickered creature gets none of them
   (layer 1 reads copiable values only), and one on a creature that becomes a copy still
   applies. */

const STICKER_KINDS = ['name', 'ability', 'pt', 'art'];
const STICKER_KIND_LABEL = { name: 'Name sticker', ability: 'Ability sticker', pt: 'Power and toughness sticker', art: 'Art sticker' };

/* A blank line in a name ("_____ Goblin", "Wolf in _____ Clothing") is no word (123.6a). */
function _isNameBlank(w) { return /^_+$/.test(w); }

/* The words of a name as the name-sticker rules count them (123.6a): blanks left out. */
function nameStickerWords(name) {
  return String(name || '').split(/\s+/).filter(w => w && !_isNameBlank(w));
}

/* The name with a name sticker's word(s) added after `afterWords` of its words (123.6b-c): at
   the end when the name now has fewer words, the whole name when it has none. A sticker placed
   where a blank line is printed covers that blank. */
function addNameStickerWord(name, word, afterWords) {
  word = String(word || '').trim();
  if (!word) return name || '';
  const parts = String(name || '').split(/\s+/).filter(Boolean);
  if (!parts.length) return word;
  let i = 0, seen = 0;
  const k = Math.max(0, afterWords | 0);
  while (i < parts.length && seen < k) { if (!_isNameBlank(parts[i])) seen++; i++; }
  if (seen < k) i = parts.length;                       // fewer words now: at the end
  if (i < parts.length && _isNameBlank(parts[i])) parts.splice(i, 1, word);
  else parts.splice(i, 0, word);
  return parts.join(' ');
}

/* "unique vowels on that sticker" (123.6e): A, E, I, O, U and Y, each counted once. */
function stickerUniqueVowels(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^aeiouy]/g, '').split('').filter(Boolean)).size;
}

/* "the number of o's in name stickers" (123.6d): either case. */
function stickerLetterCount(text, letter) {
  const l = String(letter || '').toLowerCase();
  return l ? String(text || '').toLowerCase().split('').filter(c => c === l).length : 0;
}

/* Letters on a name sticker ("with seven or fewer letters"): letters only, not spaces,
   hyphens or apostrophes. */
function stickerLetters(text) {
  return String(text || '').replace(/[^A-Za-zÀ-ɏ]/g, '').length;
}

/* The line a sticker reads as in the inspector. */
function stickerLabel(s) {
  if (!s) return '';
  if (s.kind === 'name') return `Name sticker "${s.text}"`;
  if (s.kind === 'pt') return `Power and toughness sticker ${s.power}/${s.toughness}`;
  if (s.kind === 'art') return s.text ? `Art sticker (${s.text})` : 'Art sticker';
  return `Ability sticker "${s.text}"`;
}

/* Statics an ability sticker carries, parsed as the card's own text once per sticker and card
   state (the parse reads the card's name and types); kept per evaluation version. */
const _stickerStaticMemo = new WeakMap();
function _stickerStaticEffects(perm, s) {
  if (typeof parseCardEffects !== 'function') return [];
  const ver = (typeof Battlefield !== 'undefined' && Battlefield._cacheVersion) || 0;
  const key = ver + '|' + perm.id + '|' + perm.name + '|' + (perm.controller || perm.owner || '');
  const hit = _stickerStaticMemo.get(s);
  if (hit && hit.key === key) return hit.effects;
  let effects = [];
  try {
    // A copy of the permanent, so the parse's own bookkeeping (conditional lines, chapters)
    // is not written onto the card.
    const text = String(s.text || '');
    const clone = Object.assign({}, perm, {
      printedAbilities: [text], oracleText: text,
      _conditionalAbilityIndices: undefined, _conditionalAbilityConditions: undefined,
    });
    const card = {
      name: perm.name, oracle_text: text,
      type_line: (perm.scryfallData && perm.scryfallData.type_line) || '',
      colors: perm.printedColors || [], cmc: perm.manaValue || 0,
    };
    effects = (parseCardEffects(clone, card) || []).filter(e => e && e.layer);
  } catch (e) { effects = []; }
  _stickerStaticMemo.set(s, { key, effects });
  return effects;
}

/* The effects one permanent's stickers make, each stamped with its sticker's timestamp. */
function stickerEffectsFor(perm) {
  const out = [];
  if (!perm || !Array.isArray(perm.stickers) || !perm.stickers.length || perm.isManualEffect) return out;
  const base = {
    scope: 'targeted', selfTarget: true, appliesTo: null,
    sourceId: perm.id, sourceName: perm.name, ownerId: perm.owner || 'player_0',
    _isStickerEffect: true,
  };
  // A card in a graveyard or in exile keeps its stickers (123.5), and they apply to it there
  // (123.6-123.8: "a card in a zone other than the battlefield"). The statics an ability sticker
  // carries do not: abilities function only on the battlefield (CR 113.6).
  const inZone = !!perm.isZoneCard;
  if (inZone) Object.assign(base, { appliesToNonBattlefieldZones: true, zoneCardsOnly: true, inZone: perm.zone });
  for (const s of perm.stickers) {
    const ts = s.timestamp != null ? s.timestamp : perm.timestamp;
    const id = `${perm.id}_sticker_${s.id}`;
    if (s.kind === 'name') {
      out.push(Object.assign({}, base, {
        id, layer: '3', type: EFFECT_TYPE.SET_NAME, timestamp: ts,
        params: { stickerWord: s.text, afterWords: s.afterWords || 0 },
        desc: `Name sticker adds "${s.text}" to its name`, _stickerId: s.id,
      }));
    } else if (s.kind === 'pt') {
      out.push(Object.assign({}, base, {
        id, layer: '7b', type: EFFECT_TYPE.SET_PT, timestamp: ts,
        params: { power: Number(s.power), toughness: Number(s.toughness) },
        desc: `Power and toughness sticker sets its power and toughness to ${s.power}/${s.toughness}`, _stickerId: s.id,
      }));
    } else if (s.kind === 'ability' && s.text) {
      out.push(Object.assign({}, base, {
        id, layer: '6', type: EFFECT_TYPE.ADD_ABILITY, timestamp: ts,
        params: { ability: s.text },
        desc: `Ability sticker gives it "${s.text}"`, _stickerId: s.id,
      }));
      if (!inZone) _stickerStaticEffects(perm, s).forEach((e, i) => {
        out.push(Object.assign({}, e, {
          id: `${id}_static_${i}`, timestamp: ts, sourceId: perm.id, sourceName: perm.name,
          _isStickerEffect: true, _stickerId: s.id, _stickerStatic: true,
        }));
      });
    }
  }
  return out;
}
