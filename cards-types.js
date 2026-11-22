/* ============================================================
   MTG Layer Inspector — cards-types.js
   The official subtype lists, worked out from Scryfall's own data.

   Scryfall's type catalogs are not the official lists (they have Naga, Cloud and joke
   planeswalker types, and lack Lander), but its card data says which types are real. A
   subtype of a card type is official when Scryfall shows it one of these ways:

     printed   on the type line of a card that is legal, restricted or banned in Vintage,
               Legacy or Commander. That leaves out silver-bordered, acorn, playtest and
               Arena-only cards, and previews until Scryfall makes them legal.
     token     on a token that such a card makes (all_parts), and named in the rules text
               of such a card. (Naga is still on old tokens of cards that now say Snake.)
     named     in Scryfall's catalog for creature, artifact or enchantment types, and used
               as a type in the rules text of such a card: "Camarid creature tokens",
               "becomes a 1/1 Blinkmoth artifact creature", "assemble a Contraption".
     variant   for planes and dungeons, which no format makes legal: on a released card
               that is not funny, playtest, acorn, silver- or gold-bordered, or digital.

   Nothing here waits on a refresh of the project's data. A new type reaches the site:
     - at once, with the first card that has it: every card searched for, added or restored
       is read (learnTypesFromCard)
     - at startup, from the cards released since the lists in data.js were written, however
       long ago that was (updateTypesFromScryfall)
   and however it is spelled: its plurals, capitals and number of words are worked out from
   the type itself (_knownTypeWord, _typePhraseAt).
   `python3 tests/run.py --catalog` runs the same rule over the whole card file to rewrite
   the lists in data.js (tests/subtypes.py), which only spares visitors the catching up.
   No DOM.
   ============================================================ */

const SUBTYPE_KINDS = ['artifact', 'battle', 'creature', 'dungeon', 'enchantment', 'land', 'planar', 'planeswalker', 'spell'];
// Types that can exist on tokens alone, so that only rules text names them.
const TOKEN_ONLY_KINDS = ['creature', 'artifact', 'enchantment'];
// "1/1 blue Camarid creature tokens", "Phyrexian Blinkmoth artifact creature", "Treasure token".
const TYPE_IN_USE_RE = /((?:\p{Lu}[\p{L}'-]*\s+)+)(?:(?:artifact|enchantment|land|legendary|snow|colorless)\s+)*(?:creatures?|tokens?)\b/gu;
const TYPE_ASSEMBLED_RE = /\bassembles?\s+(?:an?|two|three|X)\s+(\p{Lu}[\p{L}'-]*)/gu;

function _scryfallWords(s) {
  return String(s || '').replace(/’/g, "'");
}

function _isSanctionedCard(card) {
  const legal = card.legalities || {};
  return ['vintage', 'legacy', 'commander'].some(f => legal[f] === 'legal' || legal[f] === 'restricted' || legal[f] === 'banned');
}

function _isRealVariantCard(card, today) {
  return !['funny', 'memorabilia', 'minigame'].includes(card.set_type) && !['silver', 'gold'].includes(card.border_color) &&
    !['acorn', 'heart'].includes(card.security_stamp) && !(card.promo_types || []).includes('playtest') &&
    !card.digital && (card.released_at || '') <= today;
}

function _typeLinesOf(card) {
  const all = [card.type_line].concat((card.card_faces || []).map(f => f.type_line));
  const out = new Set();
  for (const line of all) for (const face of _scryfallWords(line).split(' // ')) if (face.includes(' — ')) out.add(face);
  return [...out];
}

// A type line's subtypes, and the kinds of subtype its card types can have.
function _subtypesOnLine(line, phrases) {
  const at = line.indexOf(' — ');
  const left = line.slice(0, at).split(/\s+/), right = line.slice(at + 3).trim();
  const kinds = [...new Set(left.map(w => TypeCatalog._typeToCategory[w]).filter(Boolean))];
  if (kinds.includes('planar')) return { kinds: ['planar'], words: [right] };   // all one subtype (CR 205.3b)
  return { kinds, words: _splitSubtypes(right, phrases).filter(w => w !== 'and/or') };
}

// A card's rules text without its own names and the names it gives to tokens.
function _rulesTextForTypes(card) {
  const faces = card.card_faces || [];
  let text = _scryfallWords(card.oracle_text || faces.map(f => f.oracle_text || '').join('\n'));
  const names = [card.name].concat(faces.map(f => f.name)).filter(Boolean).map(_scryfallWords);
  const short = names.map(n => n.split(',')[0]).filter(n => n.length > 3);
  for (const n of [...new Set(names.concat(short))].sort((a, b) => b.length - a.length)) text = text.split(n).join('~');
  return text.replace(/\bnamed [^.,"]+/g, 'named ~');
}

/* cards: Scryfall card objects. catalogs: { creature: [...], artifact: [...], ... }.
   known: { kind: iterable }, to place a word on a line of two card types ("Artifact Creature —
   Equipment Construct"); a word known nowhere is a creature type there.
   Returns { official: { kind: { type: { how, name, date } } }, seen: { kind: [every type word] } }. */
function deriveSubtypes(cards, catalogs, known, today) {
  const official = {}, seen = {}, catalog = {}, placed = {};
  for (const k of SUBTYPE_KINDS) {
    official[k] = new Map();
    seen[k] = new Set((catalogs && catalogs[k]) || []);
    catalog[k] = new Set((catalogs && catalogs[k]) || []);
    placed[k] = new Set((known && known[k]) || []);
  }
  // Creature types of several words (Time Lord) are whole in Scryfall's catalog and in the lists.
  const phrases = [...new Set([...catalog.creature, ...placed.creature, ...TypeCatalog.officialCreatureTypes])].filter(t => t.includes(' ') && catalogPhrase(t));
  function catalogPhrase(t) { return catalog.creature.has(t) || TypeCatalog.officialCreatureTypes.has(t); }
  const printed = [], tokens = [], everyLine = [];
  const named = new Map(), inUse = new Map();      // word -> the first card that shows it
  const note = (map, word, card) => {
    const had = map.get(word);
    if (!had || (card.released_at || '') < (had.released_at || '')) map.set(word, card);
  };
  for (const card of cards) {
    if (card.layout === 'art_series') continue;
    const lines = _typeLinesOf(card).map(l => _subtypesOnLine(l, phrases)).filter(l => l.kinds.length);
    for (const l of lines) {
      everyLine.push(l);
      if ((l.kinds[0] === 'planar' || l.kinds[0] === 'dungeon') && l.kinds.length === 1 && _isRealVariantCard(card, today)) {
        for (const w of l.words) _keepType(official[l.kinds[0]], w, 'variant', card);
      }
    }
    if (!_isSanctionedCard(card)) continue;
    for (const l of lines) {
      if (l.kinds[0] === 'planar' || l.kinds[0] === 'dungeon') continue;
      printed.push({ kinds: l.kinds, words: l.words, card });
      if (l.kinds.length === 1) for (const w of l.words) placed[l.kinds[0]].add(w);
    }
    for (const part of card.all_parts || []) {
      if (part.component !== 'token') continue;
      for (const face of _scryfallWords(part.type_line).split(' // ')) {
        if (!face.includes(' — ')) continue;
        const l = _subtypesOnLine(face, phrases);
        if (l.kinds.length && l.kinds[0] !== 'planar' && l.kinds[0] !== 'dungeon') tokens.push({ kinds: l.kinds, words: l.words, card });
      }
    }
    const text = _rulesTextForTypes(card);
    for (const w of text.match(/\p{Lu}[\p{L}'-]*/gu) || []) note(named, w, card);
    for (const t of phrases) if (text.includes(t)) { note(named, t, card); note(inUse, t, card); }
    for (const m of text.matchAll(TYPE_IN_USE_RE)) for (const w of m[1].trim().split(/\s+/)) note(inUse, w, card);
    for (const m of text.matchAll(TYPE_ASSEMBLED_RE)) note(inUse, m[1], card);
  }
  const kindFor = (word, kinds) => kinds.length === 1 ? kinds[0]
    : kinds.find(k => placed[k].has(word)) || kinds.find(k => catalog[k].has(word))
      || (kinds.includes('creature') ? 'creature' : kinds[0]);

  for (const { kinds, words, card } of printed) for (const w of words) _keepType(official[kindFor(w, kinds)], w, 'printed', card);
  for (const { kinds, words, card } of tokens) {
    for (const w of words) if (_typeWordForms(w).some(f => named.has(f))) _keepType(official[kindFor(w, kinds)], w, 'token', card);
  }
  for (const k of TOKEN_ONLY_KINDS) {
    for (const w of catalog[k]) {
      if (official[k].has(w)) continue;
      const card = _typeWordForms(w).map(f => inUse.get(f)).find(Boolean);
      if (card) _keepType(official[k], w, 'named', card);
    }
  }
  for (const { kinds, words } of everyLine) for (const w of words) seen[kindFor(w, kinds)].add(w);

  const out = { official: {}, seen: {} };
  for (const k of SUBTYPE_KINDS) {
    out.official[k] = {};
    for (const [w, why] of [...official[k]].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.official[k][w] = why;
    out.seen[k] = [...seen[k]].sort();
  }
  return out;
}

// The earliest evidence for a type is the one kept.
function _keepType(map, word, how, card) {
  const date = card.released_at || '', had = map.get(word);
  if (!had || date < had.date) map.set(word, { how, name: card.name, date });
}

/* ---- Reading a type whatever its shape ---- */

/* The ways a type can be written in the plural. All are accepted: which one a new type
   takes is not known until a card prints it, and a form nothing prints does no harm. */
function _typeWordForms(type) {
  const t = String(type), out = [t, t + 's'];
  const end = (re, put) => { if (re.test(t)) out.push(t.replace(re, put)); };
  end(/([sxz]|ch|sh|o)$/i, '$1es');
  end(/([^aeiou\s-])y$/i, '$1ies');
  end(/fe?$/i, 'ves');
  end(/us$/i, 'i');
  end(/man$/, 'men'); end(/Man$/, 'Men');
  end(/child$/, 'children'); end(/Child$/, 'Children');
  end(/ouse$/i, 'ice');
  end(/foot$/, 'feet'); end(/tooth$/, 'teeth');
  end(/sis$/i, 'ses');
  end(/([ie])x$/i, 'ices');
  return out;
}

/* Lower-case word or phrase -> the subtype it is, of any card type, spelled as the type is,
   from every type the parser knows now. A type's own name wins over another type's plural,
   and a creature type over another card type's. */
let _typeForms = null;
function _subtypeForms() {
  const sets = [TypeCatalog.officialCreatureTypes, TypeCatalog.creatureTypes];
  for (const kind of TypeCatalog.vocabularyKinds()) if (kind !== 'creature') sets.push(TypeCatalog[kind + 'Types']);
  const was = _typeForms;
  if (was && was.sets.length === sets.length && sets.every((s, i) => s === was.sets[i] && s.size === was.sizes[i])) return was;
  const all = new Set(), map = new Map();
  for (const s of sets) for (const t of s) all.add(t);
  for (const t of all) if (!map.has(t.toLowerCase())) map.set(t.toLowerCase(), t);
  for (const t of all) for (const f of _typeWordForms(t)) if (!map.has(f.toLowerCase())) map.set(f.toLowerCase(), t);
  const phrases = [...all].filter(t => t.includes(' '));
  const longest = phrases.reduce((n, t) => Math.max(n, t.split(' ').length), 1);
  // Types that are not one plain word (Assembly-Worker, Urza's, Time Lord), each with a plain
  // word to stand for it where rules text is read a \w+ at a time (_plainTypeWords).
  const standIn = new Map();
  let n = 0;
  for (const t of all) {
    if (/^\w+$/.test(t) || !/^[\p{L}'\- ]+$/u.test(t)) continue;
    const word = `qqtype${n++}qq`;
    map.set(word, t);
    for (const f of _typeWordForms(t)) if (!standIn.has(f.toLowerCase())) standIn.set(f.toLowerCase(), word);
  }
  const standInRe = standIn.size ? new RegExp('(?<![\\p{L}\\p{N}_\'-])(?:'
    + [...standIn.keys()].sort((a, b) => b.length - a.length).join('|') + ')(?![\\p{L}\\p{N}_-]|\'(?!s\\b))', 'gu') : null;
  _typeForms = { sets, sizes: sets.map(s => s.size), map, phrases, longest, standIn, standInRe };
  return _typeForms;
}

function _knownTypeWord(word) {
  return _subtypeForms().map.get(String(word).toLowerCase()) || null;
}

/* Lower-case rules text with each creature type that is not one plain word written as one:
   conditions and "for each" counts are read a \w+ at a time, and singularizeCreatureType
   turns the stand-in back into the type. Text naming a card is left alone. */
function _plainTypeWords(text) {
  const { standIn, standInRe } = _subtypeForms();
  if (!standInRe || /\bnamed\b/.test(text)) return text;
  return text.replace(standInRe, form => standIn.get(form));
}

/* "This Mech becomes an artifact creature": a card names itself by any subtype it has, a new
   one too, and the parser's self words are "this permanent", "this creature" and the few
   subtypes with rules of their own, which keep their word. */
const SELF_WORD_SUBTYPES = new Set(['Vehicle', 'Equipment', 'Aura', 'Saga', 'Spacecraft', 'Case', 'Room', 'Class', 'Fortification']);
function _ownTypeAsSelf(text, perm) {
  if (!text || !perm || !/\bthis /i.test(text)) return text;
  const creature = TypeCatalog.officialCreatureTypes;
  const own = (perm.printedSubtypes || []).filter(t => !SELF_WORD_SUBTYPES.has(t) && !creature.has(t) && !TypeCatalog.creatureTypes.has(t));
  let out = text;
  for (const t of own) {
    const word = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b([Tt])his ${word}(?![\\p{L}\\p{N}_-]|'s\\b)`, 'gu'), '$1his permanent')
      .replace(new RegExp(`\\b([Tt])his ${word}(?='s\\b)`, 'gu'), '$1his permanent');
  }
  return out;
}

// The creature type of several words that starts at words[i] ("time", "lords,"): { type, length }.
function _typePhraseAt(words, i) {
  const { map, longest } = _subtypeForms();
  for (let n = Math.min(longest, words.length - i); n > 1; n--) {
    const type = map.get(words.slice(i, i + n).join(' ').replace(/[,.;:]$/, '').toLowerCase());
    if (type && type.includes(' ')) return { type, length: n };
  }
  return null;
}

// Words with each type of several words made one ("a", "Time Lord", "in", ...).
function _joinTypePhrases(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const phrase = _typePhraseAt(words, i);
    if (phrase) { out.push(phrase.type); i += phrase.length - 1; } else out.push(words[i]);
  }
  return out;
}

function _mentionsTypePhrase(text) {
  const { phrases } = _subtypeForms();
  if (!phrases.length) return false;
  const words = String(text).split(/\s+/);
  return words.some((w, i) => !!_typePhraseAt(words, i));
}


/* ---- Learning from a card in hand ----

   A card of a real set (not funny, silver- or gold-bordered, acorn, playtest or digital)
   teaches the parser the types on it at once, a preview too. A type becomes official (a
   changeling has it) by deriveSubtypes' rule, so when Scryfall says a card with it is
   legal. A new creature type is checked against Scryfall's creature catalog first, which
   is how one type of two words is told from two types; if the catalog in hand has not
   got it, it is asked for again (_confirmNewTypes). */
const _typesToConfirm = [];
let _confirming = null;

function learnTypesFromCard(card, confirmed) {
  // (Only Scryfall's card objects: not the cards the site makes up for abilities and copies.)
  // (A legal card is real whichever printing is in hand: an Unfinity card, a gold-bordered or
  // Magic Online printing of Taiga. Otherwise the printing has to say so.)
  if (!card || !card.legalities || !(_isSanctionedCard(card) || _isRealVariantCard(card, '9999-12-31'))) return [];
  const catalogs = TypeCatalog.scryfallCatalogs;
  const phrases = [...new Set([..._subtypeForms().phrases, ...(catalogs.creature || []).filter(t => t.includes(' '))])];
  const lists = _typeLinesOf(card).map(l => _subtypesOnLine(l, phrases)).filter(l => l.kinds.length);
  const onTokens = (card.all_parts || []).filter(p => p.component === 'token' && String(p.type_line).includes(' — '))
    .map(p => _subtypesOnLine(_scryfallWords(p.type_line).split(' // ')[0], phrases)).filter(l => l.kinds.length);
  const isOfficial = (w, kinds) => kinds.some(k => TypeCatalog.officialList(k).has(w));
  const isNew = lists.concat(onTokens).some(l => l.words.some(w => !isOfficial(w, l.kinds)));
  const text = (card.oracle_text || '') + (card.card_faces || []).map(f => f.oracle_text || '').join('\n');
  const namesNew = TOKEN_ONLY_KINDS.some(k => (catalogs[k] || []).some(t => !TypeCatalog.officialList(k).has(t) && text.includes(t)));
  if (!isNew && !namesNew) return [];

  let changed = [], unconfirmed = false;
  for (const { kinds, words } of lists) {
    if (kinds[0] === 'planar' || kinds[0] === 'dungeon') continue;
    for (const w of words) {
      if (isOfficial(w, kinds)) continue;
      const kind = kinds.find(k => (catalogs[k] || []).includes(w)) || (kinds.includes('creature') ? 'creature' : kinds[0]);
      if (kind === 'creature' && words.length > 1 && !confirmed && !(catalogs.creature || []).includes(w)) unconfirmed = true;
      changed = changed.concat(TypeCatalog.addReadTypes({ [kind]: [w] }));
    }
  }
  if (unconfirmed) {
    _typesToConfirm.push(card);
    Promise.resolve().then(_confirmNewTypes);   // (one request at a time)
  } else {
    const known = {};
    for (const k of SUBTYPE_KINDS) known[k] = TypeCatalog.officialList(k);
    const today = new Date().toISOString().slice(0, 10);
    const { official } = deriveSubtypes([card], catalogs, known, today), found = {};
    for (const k of SUBTYPE_KINDS) found[k] = Object.keys(official[k]);
    changed = changed.concat(TypeCatalog.addOfficialTypes(found));
  }
  if (changed.length && TypeCatalog.onTypesChanged) TypeCatalog.onTypesChanged(changed);
  return changed;
}

// Asks Scryfall for its creature types again, then learns the cards that were waiting for them.
function _confirmNewTypes() {
  if (_confirming || !_typesToConfirm.length || typeof fetch !== 'function') return _confirming;
  _confirming = TypeCatalog.refreshCreatureCatalog().then(ok => {
    _confirming = null;
    if (!ok) return;                                  // learnWaitingTypes tries again after the next init
    learnWaitingTypes();
  });
  return _confirming;
}

function learnWaitingTypes() {
  if (!(TypeCatalog.scryfallCatalogs.creature || []).length) return;
  const waiting = _typesToConfirm.splice(0);
  for (const card of waiting) {
    // What was read as two types while a type of two words was unknown is read as that one.
    const gone = TypeCatalog.dropSplitPhraseWords();
    learnTypesFromCard(card, true);
    if (gone.length && TypeCatalog.onTypesChanged) TypeCatalog.onTypesChanged(gone);
  }
}


/* ---- The site's own update at startup ----

   Asks Scryfall for the cards first printed since the lists in data.js were written, works
   out their types as above and adds those that are new. It only ever adds. It is meant to
   run for years with nobody refreshing data.js: the time since then is asked for in windows
   of a season, the newest first so a new set counts within seconds, and what is covered is
   kept, so a browser catches up once and afterwards asks only about the last two weeks.
   The requests carry card-search words and dates, nothing about the player.

   `store` ({ read(), write(value) }) keeps { asOf, day, from, to, found }: the types found
   and the days covered. `day` is set when the whole time is covered, and it is not asked
   again that day. */
const TYPES_UPDATE_MARGIN_DAYS = 14;      // cards can become legal after they are listed
const TYPES_UPDATE_WINDOW_DAYS = 120;
const TYPES_UPDATE_MAX_PAGES = 60;        // per window: one has about 8
const TYPES_UPDATE_MAX_NEW = 300;         // per window
const TYPES_UPDATE_PAUSE_MS = 1100;       // half of Scryfall's limit, leaving the player's searches room

function _dayPlus(day, n) {
  return new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);
}

function _typesUpdateQuery(from, to) {
  return `date>=${from} date<=${to} (((f:vintage or f:legacy or f:commander or banned:vintage or banned:commander) -is:reprint) or t:plane or t:dungeon)`;
}

async function _fetchCardsForTypes(query) {
  let url = 'https://api.scryfall.com/cards/search?' +
    new URLSearchParams({ q: query, include_extras: 'true', order: 'released', dir: 'desc' });
  const cards = [];
  for (let page = 0; page < TYPES_UPDATE_MAX_PAGES; page++) {
    const res = await fetch(url);
    if (res.status === 404) return cards;     // no card matches
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.data)) throw new Error('Malformed search result');
    cards.push(...data.data);
    if (!data.has_more || !data.next_page) return cards;
    url = data.next_page;
    await new Promise(resolve => setTimeout(resolve, TYPES_UPDATE_PAUSE_MS));
  }
  throw new Error('Too many cards in one window');
}

function _savedTypeUpdate(store) {
  const saved = store && store.read();
  return saved && saved.asOf === TypeCatalog.typesAsOf && saved.found && typeof saved.found === 'object' ? saved : null;
}

// The types saved by earlier visits, added at once. Returns those that were new.
function applySavedTypeUpdate(store) {
  const saved = _savedTypeUpdate(store);
  return saved ? TypeCatalog.addOfficialTypes(saved.found) : [];
}

// The spans of days not yet asked about, newest first.
function _typeUpdateWindows(asOf, today, covered) {
  const start = _dayPlus(asOf, -TYPES_UPDATE_MARGIN_DAYS), spans = [], out = [];
  if (covered) {
    const recent = _dayPlus(covered.to, -TYPES_UPDATE_MARGIN_DAYS);
    spans.push([recent > start ? recent : start, today]);
    if (covered.from > start) spans.push([start, covered.from]);
  } else spans.push([start, today]);
  for (const [from, to] of spans) {
    let end = to;
    for (;;) {
      const begin = _dayPlus(end, -TYPES_UPDATE_WINDOW_DAYS);
      out.push([begin > from ? begin : from, end]);
      if (begin <= from) break;
      end = begin;
    }
  }
  return out;
}

// Resolves to the types it added: [{ kind, type }].
async function updateTypesFromScryfall(store, now) {
  const today = (now || new Date()).toISOString().slice(0, 10);
  const asOf = TypeCatalog.typesAsOf;
  const saved = _savedTypeUpdate(store);
  let added = applySavedTypeUpdate(store);
  if (saved && saved.day === today) return added;
  const isDay = (d) => typeof d === 'string' && /^\d{4}-\d\d-\d\d$/.test(d) && d <= today;
  let covered = saved && isDay(saved.from) && isDay(saved.to) ? { from: saved.from, to: saved.to } : null;
  const found = {};
  for (const k of SUBTYPE_KINDS) found[k] = new Set(saved && Array.isArray(saved.found[k]) ? saved.found[k] : []);
  const save = (day) => {
    if (!store || !covered) return;
    const lists = {};
    for (const k of SUBTYPE_KINDS) lists[k] = [...found[k]];
    store.write({ asOf, day, from: covered.from, to: covered.to, found: lists });
  };
  try {
    const catalogs = TypeCatalog.scryfallCatalogs;
    for (const [from, to] of _typeUpdateWindows(asOf, today, covered)) {
      const cards = await _fetchCardsForTypes(_typesUpdateQuery(from, to));
      const known = {};
      for (const k of SUBTYPE_KINDS) known[k] = TypeCatalog.officialList(k);
      const derived = deriveSubtypes(cards, catalogs, known, today);
      const fresh = {};
      let count = 0;
      for (const k of SUBTYPE_KINDS) {
        // What was found since the lists were written: those already added in this visit too.
        fresh[k] = Object.keys(derived.official[k]).filter(t => !TypeCatalog.writtenOfficial(k, t));
        count += fresh[k].length;
      }
      if (count > TYPES_UPDATE_MAX_NEW) throw new Error(`${count} new types in one season is not believable`);
      for (const k of SUBTYPE_KINDS) for (const t of fresh[k]) found[k].add(t);
      const justAdded = TypeCatalog.addOfficialTypes(fresh);
      if (justAdded.length) {
        added = added.concat(justAdded);
        if (TypeCatalog.onTypesChanged) TypeCatalog.onTypesChanged(justAdded);
      }
      // (Without the catalogs a type only rules text names cannot be seen: that is not "covered".)
      if (!(catalogs.creature || []).length) continue;
      covered = covered ? { from: from < covered.from ? from : covered.from, to: to > covered.to ? to : covered.to } : { from, to };
      save(null);
      await new Promise(resolve => setTimeout(resolve, TYPES_UPDATE_PAUSE_MS));
    }
    if ((catalogs.creature || []).length) save(today);
  } catch (e) {
    console.warn("TypeCatalog: the update from Scryfall's cards stopped, and goes on at the next visit.", e);
  }
  return added;
}
