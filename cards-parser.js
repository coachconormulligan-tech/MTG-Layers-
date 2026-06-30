/* cards-parser.js — parseCardEffects (oracle text → effect objects).
   Post-processing helpers (_parseGrantedGlobalAbilities, _parseSimpleKeywordList,
   _finalizeEffects) live in cards-parser-post.js. */

/* Shared: does this sentence start with When/Whenever/At (i.e. is it a triggered
   ability)? Used in many places to skip triggered-ability sentences when scanning
   for static effects. */
const TRIGGERED_SENTENCE_RE = /^(?:when(?:ever)?|at)\b/i;
function _isTriggeredSentence(s) { return TRIGGERED_SENTENCE_RE.test(s); }

/* Shared: strip a leading "Until end of turn, " / "Until your next turn, " duration
   prefix from a filter or oracle fragment. Used where compound activated-ability text
   bleeds a leading duration clause into what should be a subject filter. */
const DURATION_PREFIX_RE = /^until\s+(?:end\s+of\s+turn|your\s+next\s+turn)\s*,\s*/i;
function stripDurationPrefix(s) { return s.replace(DURATION_PREFIX_RE, ''); }

/* Table of simple "is X" / "isn't X" trait conditions. Iterated by _parseCondition so the
   13 sequential if-statements collapse to one loop. Order within the table preserves the
   source order (no patterns here overlap, but keeping the order makes intent clearer). */
const SIMPLE_TRAIT_CONDITIONS = [
  { re: /\bis legendary\b/, fn: s => s.supertypes.includes('Legendary') },
  { re: /\bis a creature\b/, fn: s => s.types.includes('Creature') },
  { re: /\bis an? artifact\b/, fn: s => s.types.includes('Artifact') },
  { re: /\bis an? enchantment\b/, fn: s => s.types.includes('Enchantment') },
  { re: /\bis a land\b/, fn: s => s.types.includes('Land') },
  { re: /\bis a planeswalker\b/, fn: s => s.types.includes('Planeswalker') },
  { re: /\bisn'?t a creature\b|\bis not a creature\b/, fn: s => !s.types.includes('Creature') },
  { re: /\bis monstrous\b/, fn: s => (s.traits || []).includes('Monstrous') },
  { re: /\bisn'?t monstrous\b|\bis not monstrous\b/, fn: s => !(s.traits || []).includes('Monstrous') },
  { re: /\bis saddled\b/, fn: s => (s.traits || []).includes('Saddled') },
  { re: /\bisn'?t saddled\b|\bis not saddled\b/, fn: s => !(s.traits || []).includes('Saddled') },
  { re: /\bis crewed\b/, fn: s => (s.traits || []).includes('Crewed') },
  { re: /\bisn'?t crewed\b|\bis not crewed\b/, fn: s => !(s.traits || []).includes('Crewed') },
];

/* Shared lookup tables hoisted to module scope (were duplicated inline in 5+ sections). */
const COLOR_NAMES = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const WORD_TO_NUM = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  twenty: 20, thirty: 30, forty: 40,
};
const ROMAN_MAP = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
/* Canonical MTG evergreen + historical keyword list. Used by parseKeywordList and the
   "and has" / leveler / spacecraft keyword scanners. */
const KEYWORD_LIST = [
  'flying', 'first strike', 'double strike', 'deathtouch', 'haste',
  'hexproof', 'indestructible', 'lifelink', 'menace', 'reach',
  'trample', 'vigilance', 'flash', 'defender', 'fear', 'intimidate',
  'shroud', 'wither', 'infect', 'prowess', 'ward',
  'plainswalk', 'islandwalk', 'swampwalk', 'mountainwalk', 'forestwalk',
  'landwalk', 'shadow', 'horsemanship', 'flanking', 'phasing',
  'banding', 'rampage', 'cumulative upkeep', 'bushido', 'soulshift',
  'splice', 'offering', 'ninjutsu', 'epic', 'convoke', 'dredge',
  'affinity', 'modular', 'sunburst', 'storm', 'cascade',
  'annihilator', 'totem armor', 'undying', 'persist', 'exalted',
  'battle cry', 'living weapon', 'extort', 'unleash', 'evolve',
  'bestow', 'tribute', 'dethrone', 'outlast', 'dash', 'exploit',
  'renown', 'skulk', 'emerge', 'crew', 'fabricate',
  'partner', 'afterlife', 'riot', 'spectacle', 'escape',
  'companion', 'mutate', 'boast', 'foretell',
  'decayed', 'disturb', 'daybound', 'nightbound',
  'cleave', 'training', 'compleated', 'reconfigure', 'blitz',
  'casualty', 'enlist', 'read ahead', 'ravenous', 'squad',
  'prototype', 'living metal', 'for mirrodin!', 'toxic',
  'backup', 'bargain', 'craft', 'descend', 'discover',
  'plot', 'saddle', 'offspring', 'impending',
  'myriad', 'changeling', 'delve', 'equip', 'fortify',
];
const KEYWORD_SET = new Set(KEYWORD_LIST);
const PARAMETERIZED_KEYWORDS = new Set([
  'ward', 'crew', 'renown', 'fabricate', 'bushido', 'soulshift',
  'annihilator', 'modular', 'dredge', 'casualty', 'toxic', 'backup',
  'ravenous', 'squad', 'afterlife', 'tribute', 'rampage', 'flanking',
  'sunburst', 'storm', 'cascade', 'exalted', 'battle cry',
  'exploit', 'skulk', 'enlist',
]);

/* Shared helpers used by _parseCondition's branch table below. */
function _wordThresh(w) { return WORD_TO_NUM[w.toLowerCase()] || parseInt(w) || 1; }
function _gsGet() { return (typeof Battlefield !== 'undefined' && Battlefield.gameState) ? Battlefield.gameState : null; }

/* Branch table for _parseCondition. Each entry is (ct, srcId) => predicate | null.
   The dispatcher loops in order; the first non-null wins, mirroring the historical
   if-chain. Order matters — see inline "must precede / must come after" notes.
   `srcId` is the source permanent's id (used by exile + command-zone branches that
   need to look up the source's own state). Compound preprocessing ("X and Y",
   comma lists) and the opponent-controls precedence branch stay inline at the top
   of _parseCondition so the table is purely a sequence of independent rules. */
const CONDITION_PARSERS = [
  // --- Imprint / exile-with (Death-Mask Duplicant) ---
  // "a card exiled with this <ref> has <ability>" — scan imprinted exile entries.
  (ct, srcId) => {
    const m = ct.match(/^a\s+card\s+exiled\s+with\s+this\s+(?:card|creature|permanent|token|artifact)\s+has\s+(.+)$/i);
    if (!m) return null;
    const abText = m[1].toLowerCase().trim().replace(/\s+/g, ' ');
    return () => {
      if (typeof Battlefield === 'undefined' || typeof _getImprintedExileEntries === 'undefined') return false;
      for (const e of _getImprintedExileEntries(srcId)) {
        const cardObj = e.card || {};
        const text = ((cardObj.oracle_text || '') + ' ' + (cardObj.type_line || '')).toLowerCase();
        // "landwalk" generically matches any *walk variant.
        if (abText === 'landwalk') { if (/\b\w+walk\b/.test(text)) return true; continue; }
        const re = new RegExp('\\b' + abText.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b');
        if (re.test(text)) return true;
      }
      return false;
    };
  },

  // --- Odric, Lunarch Marshal: "an X you control has [ability]" ---
  // A keyword counts only when it appears as a standalone token in a keyword-list
  // ability line, never inside the rules text of a triggered/activated/static
  // ability (Odric's own trigger lists every keyword in its tail; a naive
  // substring scan would treat Odric himself as having all 13 keywords).
  (ct) => {
    const m = ct.match(/^an?\s+(\w+(?:\s+\w+)?)\s+you\s+control\s+has\s+(.+)$/i);
    if (!m) return null;
    const typeInfo = normalizeTypeWord(m[1].toLowerCase());
    const abText = m[2].toLowerCase().trim();
    return (state, allStates) => {
      if (!allStates) return false;
      const myCtrl = state.controller;
      for (const [, s] of allStates) {
        if (myCtrl && s.controller !== myCtrl) continue;
        if (typeInfo && typeInfo.check === 'type' && !s.types.includes(typeInfo.value)) continue;
        if (typeInfo && typeInfo.check === 'subtype' && !s.subtypes.includes(typeInfo.value)) continue;
        for (const a of (s.abilities || [])) {
          const lower = a.toLowerCase().trim();
          if (_isTriggeredSentence(lower)) continue;
          if (lower.includes(':')) continue;
          if (abText === 'landwalk') { if (/\b\w+walk\b/.test(lower)) return true; continue; }
          for (const t of lower.split(/[,;.]\s*/).map(x => x.trim()).filter(Boolean)) {
            if (t === abText || t.startsWith(abText + ' ')) return true;
          }
        }
      }
      return false;
    };
  },

  // --- Simple trait/type checks (legendary, creature, etc.) ---
  // Iterates the module-top SIMPLE_TRAIT_CONDITIONS table.
  (ct) => {
    for (const { re, fn } of SIMPLE_TRAIT_CONDITIONS) if (re.test(ct)) return fn;
    return null;
  },

  // --- Equipped / enchanted traits ---
  // "equipped or enchanted" — either satisfies. Must precede the individual checks.
  (ct) => /\b(?:equipped\b.*\bor\b.*enchanted|enchanted\b.*\bor\b.*equipped)\b/.test(ct)
    ? (s) => (s.traits || []).includes('Equipped') || (s.traits || []).includes('Enchanted')
    : null,
  // "equipped and enchanted" — both required.
  (ct) => /\bequipped\b.*\benchanted\b|\benchanted\b.*\bequipped\b/.test(ct)
    ? (s) => (s.traits || []).includes('Equipped') && (s.traits || []).includes('Enchanted')
    : null,
  // "is equipped" / "equipped creature". Must precede the "is a [subtype]" branch
  // so "equipped" isn't mistaken for a subtype word.
  (ct) => (/\b(?:is\s+)?equipped\b/.test(ct) && !/enchanted/.test(ct))
    ? (s) => (s.traits || []).includes('Equipped')
    : null,
  // "enchanted permanent is a creature/artifact/enchantment/land" — subject is the
  // enchanted permanent's type. Must precede the bare "is enchanted" check.
  (ct) => /\benchanted\b.*\bis a creature\b/.test(ct) ? (s) => s.types.includes('Creature') : null,
  (ct) => /\benchanted\b.*\bis an? artifact\b/.test(ct) ? (s) => s.types.includes('Artifact') : null,
  (ct) => /\benchanted\b.*\bis an? enchantment\b/.test(ct) ? (s) => s.types.includes('Enchantment') : null,
  (ct) => /\benchanted\b.*\bis a land\b/.test(ct) ? (s) => s.types.includes('Land') : null,
  // "it is white/blue/black/red/green" — must precede "is enchanted" so
  // "enchanted creature is white" checks the color, not the Enchanted trait.
  (ct) => {
    for (const [cName, cCode] of Object.entries(COLOR_NAMES)) {
      if (ct.includes(`is ${cName}`)) return (s) => s.colors.includes(cCode);
    }
    return null;
  },
  // "is enchanted" / "enchanted creature". Must precede the "is a [subtype]" branch.
  (ct) => (/\b(?:is\s+)?enchanted\b/.test(ct) && !/equipped/.test(ct))
    ? (s) => (s.traits || []).includes('Enchanted')
    : null,
  // "it is a [subtype]" — falls through if word is a color or known type (handled above).
  (ct) => {
    const m = ct.match(/\bis (?:a |an )?(\w+)\s*$/);
    if (!m) return null;
    const word = m[1].toLowerCase();
    if (COLOR_NAMES[word] || CARD_TYPE_WORDS[word]) return null;
    const subtype = singularizeCreatureType(word);
    return (s) => s.subtypes.includes(subtype);
  },

  // --- Counter conditions ---
  // "has N or more [type] counters on it".
  (ct) => {
    const m = ct.match(/has\s+(\w+)\s+or\s+more\s+([\w+/]+)\s+counter/);
    if (!m) return null;
    const threshold = _wordThresh(m[1]);
    const counterType = m[2];
    return (s) => ((s.counters && s.counters[counterType]) || 0) >= threshold;
  },
  // "has a counter on it" — any counter type present.
  (ct) => (/\bhas\s+a\s+counter\b/.test(ct) && !/has\s+a\s+[\w+/]+\s+counter/.test(ct))
    ? (s) => Object.values(s.counters || {}).some(v => v > 0)
    : null,
  // "has a [type] counter on it".
  (ct) => {
    const m = ct.match(/has\s+a\s+([\w+/]+)\s+counter\b/);
    if (!m) return null;
    const counterType = m[1];
    return (s) => ((s.counters && s.counters[counterType]) || 0) > 0;
  },

  // --- Game-state conditions (Battlefield.gameState) ---
  (ct) => /\b(?:it(?:'s| is)\s+your\s+turn|during\s+your\s+turn|on\s+your\s+turn)\b/.test(ct)
    ? () => { const gs = _gsGet(); return gs ? gs.isYourTurn : true; }
    : null,
  (ct) => /\b(?:it(?:'s| is)\s+not\s+your\s+turn|not\s+your\s+turn|during\s+(?:an?\s+)?opponent'?s?\s+turn)\b/.test(ct)
    ? () => { const gs = _gsGet(); return gs ? !gs.isYourTurn : true; }
    : null,
  (ct) => /\bno cards in hand\b/.test(ct)
    ? () => { const gs = _gsGet(); return gs ? gs.handSize === 0 : true; }
    : null,
  (ct) => {
    const m = ct.match(/(\w+)\s+or\s+more\s+cards?\s+in\s+hand/);
    if (!m) return null;
    const threshold = _wordThresh(m[1]);
    return () => { const gs = _gsGet(); return gs ? gs.handSize >= threshold : true; };
  },

  // --- Life-total conditions ---
  // "you have N or more life" (Serra Ascendant).
  (ct) => {
    const m = ct.match(/you have (\w+)\s+or\s+more\s+life/);
    if (!m) return null;
    const threshold = _wordThresh(m[1]);
    return () => { const gs = _gsGet(); return gs ? gs.currentLife >= threshold : true; };
  },
  // "you have [at least] N life more than your starting life total" (Leyline of Hope).
  (ct) => {
    const m = ct.match(/you have (?:at least )?(\w+)\s+life\s+more\s+than\s+your\s+starting\s+life\s+total/);
    if (!m) return null;
    const threshold = _wordThresh(m[1]);
    return () => { const gs = _gsGet(); return gs ? (gs.currentLife - gs.startingLife) >= threshold : true; };
  },
  // "your life total is [at least] N greater than your starting life total" (alternate phrasing).
  (ct) => {
    const m = ct.match(/your life total is (?:at least )?(\w+)\s+greater than your starting life total/);
    if (!m) return null;
    const threshold = _wordThresh(m[1]);
    return () => { const gs = _gsGet(); return gs ? (gs.currentLife - gs.startingLife) >= threshold : true; };
  },
  // "your life total is greater than your starting life total" (Elenda, Saint of Dusk).
  (ct) => /your life total is greater than your starting life total/.test(ct)
    ? () => { const gs = _gsGet(); return gs ? gs.currentLife > gs.startingLife : true; }
    : null,
  // "your life total is less than your starting life total".
  (ct) => /your life total is less than your starting life total/.test(ct)
    ? () => { const gs = _gsGet(); return gs ? gs.currentLife < gs.startingLife : true; }
    : null,

  // --- Graveyard / exile card-count conditions ---
  // "there are N or more [qualifier] cards in your/a/all/each graveyard(s)" (Undercover Skrull),
  // also "... in exile". "your" scopes to the source controller's zone; any other determiner
  // (a/all/each/their/every) counts across every player. Reuses _zoneCardMatchesQualifier
  // (engine-compute.js) so the qualifier ("creature", "Zombie creature", etc.) is honored.
  (ct) => {
    const m = ct.match(/there (?:are|is)\s+(\w+)\s+or\s+more\s+(.+?)\s+cards?\s+in\s+(your|a|an|all|each|their|every)?\s*(graveyards?|exile)\b/);
    if (!m) return null;
    const threshold = _wordThresh(m[1]);
    const qualifier = m[2].trim();
    const yoursOnly = (m[3] || '').toLowerCase() === 'your';
    const zone = /exile/.test(m[4]) ? 'exile' : 'graveyard';
    const matches = (card) => (typeof _zoneCardMatchesQualifier === 'function')
      ? _zoneCardMatchesQualifier(card, qualifier) : true;
    return (state) => {
      if (typeof Battlefield === 'undefined') return true;
      const ctrl = state && state.controller;
      let count = 0;
      if (zone === 'graveyard' && Array.isArray(Battlefield.players)) {
        for (const p of Battlefield.players) {
          if (yoursOnly && p.id !== ctrl) continue;
          for (const c of (p.graveyard || [])) if (matches(c)) count++;
        }
      } else if (zone === 'exile' && Array.isArray(Battlefield.exile)) {
        for (const e of Battlefield.exile) {
          if (yoursOnly && e.owner && e.owner !== ctrl) continue;
          if (matches(e.card || e)) count++;
        }
      }
      return count >= threshold;
    };
  },

  // --- Commander / command zone ---
  // Eminence: "this card is in the command zone or on the battlefield" — true when
  // source is a commander; pseudo-perms (source not on battlefield) also satisfy.
  (ct, srcId) => /\b(?:this card|it) is in the command zone or on the battlefield\b/.test(ct)
    ? (_state, allStates) => {
        if (allStates) { const s = allStates.get(srcId); if (s) return s.isCommander || false; }
        return true;
      }
    : null,
  // Lieutenant: "you control your commander" — must precede the generic "your commander" check.
  (ct) => /\byou control your commander\b/.test(ct)
    ? () => (typeof Battlefield !== 'undefined') ? Battlefield.commanders.some(c => c.linkedPermId !== null) : true
    : null,
  // "is your commander" / "enchanted creature is your commander".
  (ct) => /\b(?:is\s+)?your\s+commander\b/.test(ct)
    ? (s) => s.isCommander || false
    : null,

  // --- Generic "has [ability]" — must come AFTER counter checks so "has a +1/+1
  // counter" doesn't get treated as an ability match.
  (ct) => {
    const m = ct.match(/\bhas\s+(\w[\w\s]*\w|\w+)/);
    if (!m) return null;
    const abText = m[1].toLowerCase().trim();
    if (/counter|card/.test(abText)) return null;
    return (s) => s.abilities.some(a => a.toLowerCase().includes(abText));
  },

  // --- "you control X" variants (order: counter, count, color+type, planeswalker, catch-all) ---
  // "you control a permanent/creature with a [type] counter on it".
  (ct) => {
    const m = ct.match(/you control (?:a |an )?(\w+)\s+with\s+a\s+([\w+/]+)\s+counter/);
    if (!m) return null;
    const typeInfo = CARD_TYPE_WORDS[m[1].toLowerCase()];
    const counterType = m[2];
    return (state, allStates) => {
      if (!allStates) return true;
      for (const [, s] of allStates) {
        const typeOk = !typeInfo || typeInfo.check === 'any' || (typeInfo.check === 'type' && s.types.includes(typeInfo.value));
        const hasCounter = (s.counters && s.counters[counterType] && s.counters[counterType] > 0);
        if (typeOk && hasCounter) return true;
      }
      return false;
    };
  },
  // "you control N or more [type]" (Starfield of Nyx).
  (ct) => {
    const m = ct.match(/you control (\w+)\s+or\s+more\s+(\w+)/);
    if (!m) return null;
    const threshold = _wordThresh(m[1]);
    const typeInfo = normalizeTypeWord(m[2].toLowerCase());
    if (!typeInfo) return null;
    return (state, allStates) => {
      if (!allStates) return true;
      const myCtrl = state.controller;
      let count = 0;
      for (const [, s] of allStates) {
        if ((!myCtrl || s.controller === myCtrl) && (typeInfo.check === 'any' || (typeInfo.check === 'type' && s.types.includes(typeInfo.value)))) count++;
      }
      return count >= threshold;
    };
  },
  // "you control a [color] (or [color]) [type]" — color (+ optional type) on a permanent.
  (ct) => {
    const m = ct.match(/you control (?:a |an )?(\w+)(?:\s+or\s+(\w+))?(?:\s+(?:permanent|creature|artifact|enchantment|land|planeswalker))/);
    if (!m) return null;
    const colorNames = [m[1].toLowerCase()];
    if (m[2]) colorNames.push(m[2].toLowerCase());
    const colorCodes = colorNames.map(c => COLOR_NAMES[c]).filter(Boolean);
    if (colorCodes.length === 0) return null;
    const typeMatch = ct.match(/(?:white|blue|black|red|green)(?:\s+or\s+(?:white|blue|black|red|green))?\s+(\w+)$/);
    const typeRestriction = typeMatch ? CARD_TYPE_WORDS[typeMatch[1]] : null;
    return (state, allStates) => {
      if (!allStates) return true;
      const myCtrl = state.controller;
      for (const [, s] of allStates) {
        if (myCtrl && s.controller !== myCtrl) continue;
        if (!colorCodes.some(c => (s.colors || []).includes(c))) continue;
        if (!typeRestriction || typeRestriction.check === 'any' || (typeRestriction.check === 'type' && s.types.includes(typeRestriction.value))) return true;
      }
      return false;
    };
  },
  // "you control a [Name] planeswalker" — check for planeswalker with specific subtype.
  (ct) => {
    const m = ct.match(/you control (?:a |an )?(\w+)\s+planeswalker/);
    if (!m) return null;
    const pwSubtype = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return (state, allStates) => {
      if (!allStates) return true;
      const myCtrl = state.controller;
      for (const [, s] of allStates) {
        if (myCtrl && s.controller !== myCtrl) continue;
        if (s.types.includes('Planeswalker') && s.subtypes.includes(pwSubtype)) return true;
      }
      return false;
    };
  },
  // "you control a [legendary] [color] [type/subtype]" — final catch-all for the
  // "you control" pattern; handles single color, type, land subtype, creature
  // subtype, and a leading color adjective ("another black creature"). "another"/
  // "other" excludes the source itself by requiring a second qualifying permanent.
  (ct) => {
    const m = ct.match(/you control (?:a |an |another |other )?(?:legendary\s+)?(\w+)(?:\s+(\w+))?/);
    if (!m) return null;
    const word = m[1].toLowerCase();
    const word2 = m[2] ? m[2].toLowerCase() : null;
    const isLegendary = ct.includes('legendary');
    const isAnother = /\byou control (?:another|other)\b/.test(ct);

    // Build a per-state predicate from the captured word(s).
    let pred = null;
    if (COLOR_NAMES[word]) {
      const cCode = COLOR_NAMES[word];
      const t2 = word2 ? normalizeTypeWord(word2) : null;
      const reqType = (t2 && t2.check === 'type') ? t2.value : null;
      pred = (s) => (s.colors || []).includes(cCode) && (!reqType || s.types.includes(reqType));
    } else {
      const typeInfo = normalizeTypeWord(word);
      if (typeInfo && typeInfo.check === 'type') {
        pred = (s) => s.types.includes(typeInfo.value) && (!isLegendary || s.supertypes.includes('Legendary'));
      } else {
        const landSubtype = LAND_SUBTYPE_WORDS[word];
        if (landSubtype) {
          pred = (s) => s.subtypes.includes(landSubtype);
        } else {
          const subtype = singularizeCreatureType(word);
          pred = (s) => s.subtypes.includes(subtype);
        }
      }
    }

    return (state, allStates) => {
      if (!allStates) return true;
      const myCtrl = state.controller;
      let count = 0;
      for (const [, s] of allStates) {
        if ((!myCtrl || s.controller === myCtrl) && pred(s)) count++;
      }
      // "another" requires a qualifying permanent besides the source: if the
      // source itself matches, we need at least two; otherwise one is enough.
      const threshold = (isAnother && pred(state)) ? 2 : 1;
      return count >= threshold;
    };
  },
];

/* Rewrite "get +X/+X, where X is the number of [DESC]" → "get +1/+1 for each [DESC]".
   Called on oracle text before the main parsing loop to feed the existing for-each pipeline.
   Returns the transformed text and also a boolean indicating whether any trackable
   "where X is…" clause covered ALL remaining \bX\b occurrences (used to suppress the
   add-time X prompt in cards-battlefield.js). */
function _normalizeWhereXIs(text) {
  // "+X/+X[, until end of turn], where X is the number of [DESC]" → "+1/+1 for each [DESC]"
  text = text.replace(
    /\+X\/\+X(?:\s+until\s+[^,;]+)?,?\s+where\s+X\s+is\s+the\s+number\s+of\s+([^.;\n]+)/gi,
    (m, desc) => `+1/+1 for each ${desc.trim().replace(/\.$/, '')}`
  );
  return text;
}

/* Returns true if every \bX\b occurrence in oracleText is covered by a "where X is …"
   clause that _computeForEachCount can auto-resolve, OR by "where X is this creature's
   power/toughness/mana value".  Used to decide whether to skip the add-time X prompt. */
function _allXAreAutoComputable(oracleText) {
  if (!/\bX\b/.test(oracleText)) return false; // no X at all
  let text = _normalizeWhereXIs(oracleText);
  // Strip "+X/+X[/+0] [until …,] where X is [its|this creature's] power/toughness" boosts whose
  // magnitude is a P/T characteristic (Berserk: +X/+0, X = its power; Ashroot Animist: +X/+X).
  // Removes both the "+X" and the "where X is …" clause so no \bX\b survives the prompt check.
  text = text.replace(
    /[+-]X\/[+-](?:X|0)(?:\s+until\s+[^,.;\n]+)?,?\s+where\s+X\s+is\s+(?:its|this\s+(?:creature|permanent|card)['’]?s?)\s+(?:power|toughness)/gi, ''
  );
  // Strip "put X +N/+N counters on TARGET, where X is this creature's power/toughness/mana value"
  text = text.replace(
    /put\s+X\s+[^\n.;]+?where\s+X\s+is\s+(?:this\s+(?:creature|permanent|card)'?s?\s+)?(?:power|toughness|mana\s+value)[^\n.;]*/gi, ''
  );
  // Strip remaining "where X is this creature's power/toughness/mana value" phrases
  text = text.replace(
    /,?\s*where\s+X\s+is\s+(?:this\s+(?:creature|permanent|card)'?s?\s+)?(?:power|toughness|mana\s+value)/gi, ''
  );
  // Strip "where X is the exiled (creature) card's power/toughness/mana value, and Y is …" — Phyrexian Ingester pattern
  text = text.replace(
    /,?\s*where\s+X\s+is\s+the\s+(?:exiled|imprinted)\s+(?:creature\s+)?card['’]?s?\s+(?:power|toughness|mana\s+value)(?:[^.\n]*?\bY\s+is[^.\n]*)?/gi, ''
  );
  return !/\bX\b/.test(text) && !/\bY\b/.test(text);
}

function parseCardEffects(permanent, card, opts = {}) {
  const name = card.name.toLowerCase();
  const effects = [];
  // Detect if source is an Equipment - its targeted effects only apply to creatures
  const isEquipmentSource = permanent.printedSubtypes && permanent.printedSubtypes.includes('Equipment');

  // Track which oracle text lines were handled by KNOWN_ABILITY_EFFECTS so the
  // generic parser can skip them when assigning _conditionalAbilityIndices.
  const _knownHandledLines = new Set();

  // Check known ability database first (skip during re-parse after text change).
  // Instead of matching by card name, we normalize each ability line and check
  // if it matches a known ability pattern. This way any card that gains a known
  // ability (via copy, text exchange, etc.) automatically gets the correct effects.
  if (!opts.skipKnown) {
    const isTokenCard = permanent.isToken || false;
    const _knownNormalized = _replaceProperNounSelfRef(card.name, _stripReminderText(card.oracle_text || ''), isTokenCard);
    const _knownLines = _knownNormalized.split('\n').map(l => l.trim()).filter(Boolean);
    let _anyKnownMatch = false;
    const _handledLines = new Set();
    for (let li = 0; li < _knownLines.length; li++) {
      const lineKey = _knownLines[li].toLowerCase();
      if (!KNOWN_ABILITY_EFFECTS[lineKey]) continue;
      _anyKnownMatch = true;
      _handledLines.add(li);
      _knownHandledLines.add(li);
      for (const template of KNOWN_ABILITY_EFFECTS[lineKey]) {
        // Deep-clone params so each card instance has independent state (Fix 9)
        const clonedParams = JSON.parse(JSON.stringify(template.params || {}));
        // Restore non-serializable fields (functions) from the original
        if (template.params.restriction) clonedParams.restriction = template.params.restriction;
        if (template.params.compute) clonedParams.compute = template.params.compute;
        if (template.params.targetRestriction) clonedParams.targetRestriction = template.params.targetRestriction;
        const eff = {
          ...template,
          params: clonedParams,
          id: `${permanent.id}_eff_${effects.length}`,
          sourceId: permanent.id,
          sourceName: card.name,
          timestamp: permanent.timestamp,
          appliesTo: template.appliesTo || null,
        };
        // For CONTROL effects, set newController to the permanent's owner
        if (eff.type === EFFECT_TYPE.CONTROL && eff.params.newController === null) {
          eff.params.newController = permanent.owner || 'player_0';
        }
        effects.push(eff);
      }
    }
    if (_anyKnownMatch && _handledLines.size === _knownLines.length) {
      // All ability lines matched known patterns — return early (no generic parsing needed)
      // Also parse aura restriction from oracle text for known ability auras
      const oracleForAura = card.oracle_text || '';
      const enchantKnownMatch = oracleForAura.match(/^Enchant\s+(.+?)(?:\n|$)/im);
      if (enchantKnownMatch) {
        const enchantTarget = enchantKnownMatch[1].trim();
        const _isPlayerOnly = /\bplayer\b/i.test(enchantTarget) &&
          !/\b(creature|artifact|planeswalker|enchantment|land|permanent)\b/i.test(enchantTarget);
        if (_isPlayerOnly) permanent._isEnchantPlayer = true;
        const auraRestriction = buildAuraRestriction(enchantTarget);
        if (auraRestriction) {
          for (const eff of effects) {
            if (eff.scope === 'targeted' && !eff.selfTarget) eff.auraRestriction = auraRestriction;
          }
          permanent._auraRestriction = auraRestriction;
        }
        // "Enchant [type] an opponent controls" — restrict targeting to opponents' permanents
        if (/\bopponent(?:'?s?)?\s+controls?\b/i.test(enchantTarget)) {
          permanent._opponentControlRequired = true;
          for (const eff of effects) {
            if (eff.scope === 'targeted' && !eff.selfTarget) eff.opponentControlRequired = true;
          }
        }
        // "Enchant [type] you control" — restrict targeting to same-controller permanents
        if (/\byou\s+controls?\b/i.test(enchantTarget)) {
          permanent._youControlRequired = true;
          for (const eff of effects) {
            if (eff.scope === 'targeted' && !eff.selfTarget) eff.youControlRequired = true;
          }
        }
      }
      return _finalizeEffects(effects, isEquipmentSource, permanent, card.oracle_text);
    }
    // If some lines matched but not all, the matched effects are kept and
    // generic parsing will handle the remaining lines below.
  }

  // Generic oracle text parsing
  // Apply name replacement so self-references like "CardName has X" become "this card has X"
  const isTokenCard = permanent.isToken || false;
  let oracleRaw = _replaceProperNounSelfRef(card.name, _stripReminderText(card.oracle_text || ''), isTokenCard);

  // "Enchant player" cards: treat "enchanted player controls" as "you control"
  // since we assume the user is the enchanted player.
  if (/\benchant player\b/i.test(oracleRaw)) {
    if (permanent) permanent._isEnchantPlayer = true;
    oracleRaw = oracleRaw.replace(/\benchanted player(?:'s)?\s+controls?\b/gi, 'you control');
    oracleRaw = oracleRaw.replace(/\benchanted player\b/gi, 'you');
  }

  // Factory: build + push a parsed effect object with the common boilerplate.
  // ctx accepts either { isSelf, isTargeted, fn, selfAffect } (derives appliesTo/scope/selfTarget)
  // or pre-computed { appliesTo, scope, selfTarget, affectsSelf } (used by setType-section sites).
  // extra is merged last for sites that need _oraclePos, abilityGroupId, asLongAsCondition, etc.
  function pushEff(layer, type, params, ctx, desc, extra) {
    let appliesTo, scope, selfTarget, affectsSelf;
    if ('appliesTo' in ctx || 'scope' in ctx) {
      appliesTo = ctx.appliesTo; scope = ctx.scope;
      selfTarget = ctx.selfTarget; affectsSelf = ctx.affectsSelf;
    } else {
      const { isSelf, isTargeted, fn, selfAffect } = ctx;
      appliesTo = (isSelf || isTargeted) ? null : fn;
      scope = (isSelf || isTargeted) ? 'targeted' : 'global';
      selfTarget = !!isSelf; affectsSelf = selfAffect;
    }
    const eff = {
      id: `${permanent.id}_eff_${effects.length}`,
      layer, type, params,
      appliesTo, scope, selfTarget, affectsSelf,
      sourceId: permanent.id, sourceName: card.name,
      timestamp: permanent.timestamp,
      desc,
    };
    if (extra) Object.assign(eff, extra);
    effects.push(eff);
    return eff;
  }

  // Helper: token in a comma-list looks like a keyword? Used by leveler/spacecraft scanners.
  // Matches canonical keyword names, parameterized forms ("ward {2}", "toxic 1"), and
  // "protection from X" / "hexproof from X" sub-forms.
  function _isKeywordLikeToken(k) {
    return KEYWORD_SET.has(k)
      || /^\w+\s+\d+$/.test(k)
      || /^\w+\s+\{/.test(k)
      || /^protection from\s+/.test(k)
      || /^hexproof from\s+/.test(k);
  }

  // Helper: apply target/choose metadata to an effect object.
  // bResult is the return value of buildAppliesToFromText; fn is the filter function.
  function _applyTargetInfo(eff, bResult, restrictionFn) {
    if (bResult.isSpellTarget) {
      eff.scope = 'targeted';
      eff.targetRestriction = restrictionFn || null;
      if (bResult.maxTargets > 1) {
        eff.maxTargets = bResult.maxTargets;
        eff.targetIds = [];
      }
    }
    // "[type] target player controls" — scope this global effect to the chosen player
    // and flag the source permanent so the UI renders a player-picker dropdown.
    if (bResult.isTargetPlayerControl) {
      eff._targetPlayerScoped = true;
      if (permanent) permanent._targetsChosenPlayer = true;
    }
    return eff;
  }

  // --- "As long as" condition parsing ---
  // Instead of stripping conditions, parse them and attach to effects.
  // Store conditions found per line to attach to effects generated from that text.
  const _asLongAsConditions = []; // array of condition functions

  function _parseCondition(condText) {
    const ct = condText.toLowerCase().trim();
    // "an opponent controls a [type]" — multiplayer: any permanent controlled by a
    // different player matches the (optional) type filter. Kept inline above compound
    // preprocessing to preserve historical precedence: mixed text like "opponent
    // controls X and you Y" resolves to opponent-controls, not an AND-split.
    if (/\bopponent\s+controls?\b/.test(ct)) {
      const m = ct.match(/opponent\s+controls?\s+(?:a |an )?(.+)/);
      const typeInfo = m ? normalizeTypeWord(m[1].trim()) : null;
      if (typeInfo) {
        return (state, allStates) => {
          if (!allStates) return false;
          const myCtrl = state.controller;
          for (const [, s] of allStates) {
            if (s.controller === myCtrl) continue;
            if (typeInfo.check === 'type' && s.types.includes(typeInfo.value)) return true;
            if (typeInfo.check === 'subtype' && s.subtypes.includes(typeInfo.value)) return true;
          }
          return false;
        };
      }
      return (state, allStates) => {
        if (!allStates) return false;
        for (const [, s] of allStates) if (s.controller !== state.controller) return true;
        return false;
      };
    }
    // Compound "X and Y" — split when "and" is followed by another condition-like
    // phrase, recurse on each half, AND the resulting predicates.
    const andParts = ct.split(/\s+and\s+(?=(?:it(?:\s+is|'s)?\s|this\s|you\s|there|during|on\s|\w+\s+(?:is|has)\s))/i);
    if (andParts.length >= 2) {
      const subs = andParts.map(p => _parseCondition(p.trim())).filter(Boolean);
      if (subs.length >= 2) return (state, allStates) => subs.every(c => c(state, allStates));
    }
    // Comma-list compound: "this card is enchanted, equipped, and has a counter on it".
    if (ct.includes(',')) {
      const listParts = ct.split(/,\s*(?:and\s+)?/).map(s => s.trim()).filter(Boolean);
      if (listParts.length >= 2) {
        const subs = listParts.map(p => _parseCondition(p)).filter(Boolean);
        if (subs.length >= 2) return (state, allStates) => subs.every(c => c(state, allStates));
      }
    }
    // Sequential branch table (CONDITION_PARSERS at module top). First non-null wins.
    // Returns null when no entry matches — "always true" semantics applied by callers.
    const srcId = permanent.id;
    for (const parse of CONDITION_PARSERS) {
      const pred = parse(ct, srcId);
      if (pred) return pred;
    }
    return null;
  }

  // Normalize "as long as [condition]" patterns.
  // Pattern A: "As long as [condition], it [effect]" at start of line → transform "it" to self-ref
  // Pattern B: "[effect] as long as [condition]" trailing → strip condition text
  // In both cases, parse condition and store it.
  let oracle = oracleRaw;

  // Normalize "Player N controls" → "you control" so the parser handles player-name-substituted text
  oracle = oracle.replace(/\bPlayer \d+\s+controls\b/gi, 'you control')
                 .replace(/\bPlayer \d+'s\s+control\b/gi, 'your control');

  // Detect whether this card is an aura/equipment to know what "it" refers to
  const isAuraCard = (card.type_line || '').toLowerCase().includes('aura');
  const isEquipmentCard = (card.type_line || '').toLowerCase().includes('equipment');
  const enchantedRef = isEquipmentCard ? 'Equipped creature' : isAuraCard ? 'Enchanted creature' : 'this card';

  // Normalize curly apostrophes (U+2019) to straight — Scryfall uses curly in oracle text
  oracle = oracle.replace(/\u2019/g, "'");
  // Normalize smart/curly double quotes (U+201C, U+201D) to straight ASCII double quotes
  oracle = oracle.replace(/[\u201c\u201d]/g, '"');

  // Strip leading duration clauses (e.g. "Until end of turn, ") from the start of lines.
  // Without this, the setTypeRegex captures "Until end of turn, target X" as the filter,
  // and extractTargetInfo() fails to detect "target" (it only checks at the string start).
  oracle = oracle.replace(/^Until end of turn,\s*/gim, '');

  // Normalize "this [card-type]" to "this card" so self-reference detection works for all card types.
  // e.g. "this enchantment becomes..." (Daxos' Torment), "this artifact gains...", etc.
  // Skip "this creature" and "this permanent" — those are already handled as self-refs.
  oracle = oracle.replace(/\bthis\s+(enchantment|artifact|land|planeswalker|battle|vehicle|instant|sorcery)\b/gi, 'this card');

  // Normalize common contractions so regex patterns work uniformly
  oracle = oracle.replace(/\bit's\b/gi, 'it is');
  oracle = oracle.replace(/\bthat's\b/gi, 'that is');
  oracle = oracle.replace(/\bthey're\b/gi, 'they are');
  oracle = oracle.replace(/\bwhat's\b/gi, 'what is');
  oracle = oracle.replace(/\bhere's\b/gi, 'here is');
  oracle = oracle.replace(/\bthere's\b/gi, 'there is');

  // Normalize gendered pronouns to "this card" for cards that self-reference with he/she/him/her.
  // "he's a" → "this card is a", "she's a" → "this card is a"
  // "he is" → "this card is", "she is" → "this card is"
  // "he has" → "this card has", "she has" → "this card has"
  // "he loses" → "this card loses", "she loses" → "this card loses"
  // Only when not an Aura/Equipment (for those, "it" refers to the enchanted permanent)
  if (!isAuraCard && !isEquipmentCard) {
    oracle = oracle.replace(/\b[Hh]e's\b/g, 'this card is');
    oracle = oracle.replace(/\b[Ss]he's\b/g, 'this card is');
    oracle = oracle.replace(/\b[Hh]e\s+(is|has|gains?|loses?|gets?|becomes?|can't|doesn't|isn't)\b/g, 'this card $1');
    oracle = oracle.replace(/\b[Ss]he\s+(is|has|gains?|loses?|gets?|becomes?|can't|doesn't|isn't)\b/g, 'this card $1');
    // "on him" / "on her" → "on it" for counter references
    oracle = oracle.replace(/\bon him\b/gi, 'on it');
    oracle = oracle.replace(/\bon her\b/gi, 'on it');
  }

  // Rewrite "+X/+X, where X is the number of [DESC]" → "+1/+1 for each [DESC]" so the
  // existing for-each pipeline handles it (Jodah, the Unifier and similar cards).
  oracle = _normalizeWhereXIs(oracle);

  // ---- Layer 4 + 7b: "As long as [self] isn't on the battlefield, it's a [P/T] [type] creature
  // in addition to its other types." (Grist, the Hunger Tide). A static ability that functions
  // OUTSIDE the battlefield (CR 604.3), making the card a creature in the command zone / graveyard
  // / exile — which is what lets it serve as a commander. This must run BEFORE the "As long as …"
  // condition rewrite (Pattern A) and addTypeRegex: those would otherwise drop the unrecognized
  // "isn't on the battlefield" condition and emit an unconditional self-effect that wrongly turns
  // the ON-battlefield permanent into a 1/1. We emit our own zone-scoped effects
  // (appliesToNonBattlefieldZones + zoneCardsOnly so evaluateZoneCard picks them up but the
  // battlefield permanent never does) and strip the sentence so nothing downstream re-parses it.
  const offBfTypeRegex = /as long as (?:this card|this permanent|it)\s+(?:isn'?t|is not)\s+on the battlefield,?\s+it(?:'s| is)\s+(?:an?\s+)?(.+?)\s+in addition to its other types\.?/i;
  const offBfMatch = oracle.match(offBfTypeRegex);
  if (offBfMatch) {
    const offBfText = offBfMatch[1].trim();          // e.g. "1/1 Insect creature"
    const offParsed = parseBecomesType(offBfText);
    const offZoneFlags = { appliesToNonBattlefieldZones: true, zoneCardsOnly: true };
    const offCtx = { isSelf: true, isTargeted: false, fn: null, selfAffect: true };
    const offDesc = `It's a ${offBfText} while it isn't on the battlefield.`;
    const offPt = offBfText.match(/(\d+)\/(\d+)/);
    if (offParsed.types.length || offParsed.subtypes.length) {
      pushEff('4', EFFECT_TYPE.ADD_TYPE,
        { types: offParsed.types, subtypes: offParsed.subtypes }, offCtx, offDesc, offZoneFlags);
    }
    if (offPt) {
      pushEff('7b', EFFECT_TYPE.SET_PT,
        { power: parseInt(offPt[1]), toughness: parseInt(offPt[2]) }, offCtx, offDesc, offZoneFlags);
    }
    // Strip the consumed sentence so Pattern A / addTypeRegex don't re-emit it unflagged.
    oracle = oracle.replace(offBfTypeRegex, '').replace(/^\s*\n/gm, '');
  }

  // Saga chapter lore counter conditions: before stripping em-dash prefixes,
  // detect saga chapter lines and store their thresholds by line index.
  // After all condition parsing, these will be injected into _lineConditionMap.
  const _sagaLineThresholds = new Map(); // lineIndex → minLoreThreshold
  if (permanent._sagaChapterThresholds && permanent._sagaChapterThresholds.size > 0) {
    const chapterRegex = /^([IVXLC]+(?:\s*,\s*[IVXLC]+)*)\s*\u2014/;
    const oLines = oracle.split('\n');
    for (let li = 0; li < oLines.length; li++) {
      const cm = oLines[li].match(chapterRegex);
      if (cm) {
        const numerals = cm[1].split(',').map(s => s.trim());
        const values = numerals.map(n => ROMAN_MAP[n]).filter(v => v !== undefined);
        if (values.length > 0) {
          _sagaLineThresholds.set(li, Math.min(...values));
        }
      }
    }
  }

  // Class enchantment level conditions: detect "{cost}: Level N" lines by line index.
  // These will be injected into _lineConditionMap so effects are gated by class level.
  const _classLineThresholds = new Map(); // lineIndex → requiredLevel
  if (permanent._classLevelThresholds && permanent._classLevelThresholds.size > 0) {
    const levelLineRegex = /^[{][^}]*[}].*:\s*Level\s+(\d+)\s*$/i;
    const oLines = oracle.split('\n');
    let currentLevel = 1;
    for (let li = 0; li < oLines.length; li++) {
      const lm = oLines[li].match(levelLineRegex);
      if (lm) {
        currentLevel = parseInt(lm[1], 10);
        // The level-up line itself: mark with its level so it shows correctly
        _classLineThresholds.set(li, currentLevel);
      } else {
        // Regular ability line: belongs to currentLevel
        _classLineThresholds.set(li, currentLevel);
      }
    }
  }

  // Leveler (Level up) creature conditions: detect "LEVEL N-M" / "LEVEL N+" lines by line index.
  // Track which oracle lines are structural (LEVEL headers, P/T lines) vs ability lines.
  // Ability lines get conditions based on level counter being in the right bracket.
  // P/T lines get special handling to generate SET_PT effects.
  const _levelerLineData = new Map(); // lineIndex → { bracket, isStructural, isPT, power, toughness }
  const _levelerBrackets = []; // { min, max, ptLineIdx, power, toughness }
  let _isLeveler = false;
  if (permanent._levelerData) {
    _isLeveler = true;
    const oLines = oracle.split('\n');
    const levelLineRegex = /^LEVEL\s+(\d+)([+-])(\d*)$/i;
    const ptRegex = /^(\*|\d+)\/(\*|\d+)$/;
    let currentBracketIdx = -1; // -1 = base level (before first LEVEL line)
    let foundLevelUp = false;
    
    for (let li = 0; li < oLines.length; li++) {
      const line = oLines[li].trim();
      
      // Check for "Level up {cost}" line
      if (!foundLevelUp && /^Level up\s+\{/i.test(line)) {
        foundLevelUp = true;
        // This is the level up activation line — always active, bracket -1 (base)
        _levelerLineData.set(li, { bracket: -1, isStructural: false, isPT: false, isLevelUp: true });
        continue;
      }
      
      // Check for "LEVEL N-M" or "LEVEL N+" header
      const levelMatch = line.match(levelLineRegex);
      if (levelMatch) {
        const minLevel = parseInt(levelMatch[1], 10);
        const op = levelMatch[2];
        const maxLevel = op === '+' ? Infinity : parseInt(levelMatch[3], 10);
        currentBracketIdx = _levelerBrackets.length;
        _levelerBrackets.push({ min: minLevel, max: maxLevel, ptLineIdx: -1, power: null, toughness: null });
        _levelerLineData.set(li, { bracket: currentBracketIdx, isStructural: true, isPT: false });
        continue;
      }
      
      // Check for P/T line within a bracket
      if (currentBracketIdx >= 0) {
        const ptMatch = line.match(ptRegex);
        if (ptMatch && _levelerBrackets[currentBracketIdx].power === null) {
          const p = ptMatch[1] === '*' ? 0 : parseInt(ptMatch[1], 10);
          const t = ptMatch[2] === '*' ? 0 : parseInt(ptMatch[2], 10);
          _levelerBrackets[currentBracketIdx].power = p;
          _levelerBrackets[currentBracketIdx].toughness = t;
          _levelerBrackets[currentBracketIdx].ptLineIdx = li;
          _levelerLineData.set(li, { bracket: currentBracketIdx, isStructural: true, isPT: true, power: p, toughness: t });
          continue;
        }
      }
      
      // Regular ability line — if we're in a bracket, mark it
      if (currentBracketIdx >= 0 && line) {
        _levelerLineData.set(li, { bracket: currentBracketIdx, isStructural: false, isPT: false });
      }
    }
  }

  // Spacecraft station conditions: detect "N+ | ability" lines and "Station" keyword line.
  // Uses the parsed _spacecraftData to map oracle line indices to charge counter thresholds.
  // Cumulative: charge counters >= N means the ability is active.
  const _spacecraftLineData = new Map(); // lineIndex → { min, isKeyword }
  let _isSpacecraft = false;
  if (permanent._spacecraftData) {
    _isSpacecraft = true;
    const oLines = oracle.split('\n');
    const stationAbilityRegex = /^(\d+)\+\s*\|\s*(.+)$/;
    let foundStationKeyword = false;
    let currentStationMin = -1; // track current threshold for subsequent lines

    for (let li = 0; li < oLines.length; li++) {
      const line = oLines[li].trim();

      // Check for "Station" keyword line
      if (!foundStationKeyword && /^Station$/i.test(line)) {
        foundStationKeyword = true;
        _spacecraftLineData.set(li, { min: 0, isKeyword: true });
        continue;
      }

      // Only process lines after the Station keyword
      if (!foundStationKeyword) continue;

      // Check for "N+ | ability" line
      const m = line.match(stationAbilityRegex);
      if (m) {
        currentStationMin = parseInt(m[1], 10);
        _spacecraftLineData.set(li, { min: currentStationMin, isKeyword: false });
      } else if (currentStationMin >= 0 && line) {
        // Subsequent line after a N+ | line inherits the same threshold
        _spacecraftLineData.set(li, { min: currentStationMin, isKeyword: false });
      }
    }
  }

  // --- Inline comma-separated choice normalization ---
  // Detects patterns like "choose first strike, vigilance, or lifelink. [rest of effect]"
  // Rewrites into modal format: "Choose one —\n• [rest] with first strike\n• [rest] with vigilance\n• [rest] with lifelink"
  // This runs BEFORE the main modal detection so the bullet-based system picks it up.
  {
    const inlineChoiceRegex = /^(.*?\bchoose\s+)([\w\s]+(?:,\s*[\w\s]+)*,?\s+or\s+[\w\s]+?)(\.\s*)(.+)$/i;
    const oLines = oracle.split('\n');
    const rebuilt = [];
    let didRewrite = false;
    for (const line of oLines) {
      const m = line.trim().match(inlineChoiceRegex);
      if (m) {
        // m[1] = prefix ending with "choose "
        // m[2] = "first strike, vigilance, or lifelink"
        // m[3] = ". "
        // m[4] = rest of sentence (the actual effect)
        const choiceStr = m[2].trim();
        // Split on ", " and " or "
        const choices = choiceStr.split(/,\s*(?:or\s+)?|\s+or\s+/).map(s => s.trim()).filter(Boolean);
        if (choices.length >= 2) {
          // Build modal header + bullet modes
          rebuilt.push('Choose one —');
          const rest = m[4].trim();
          for (const choice of choices) {
            // Substitute the choice into the rest of the sentence
            // Look for patterns like "gain that ability" / "that ability" / "gain it" / "gains it"
            let modeLine = rest
              .replace(/\bthat ability\b/gi, choice)
              .replace(/\bgains?\s+it\b/gi, `gains ${choice}`)
              .replace(/\bget\s+it\b/gi, `get ${choice}`);
            // If none of the above matched, just append the choice
            if (modeLine === rest) {
              modeLine = rest + ' (' + choice + ')';
            }
            rebuilt.push('\u2022 ' + modeLine);
          }
          didRewrite = true;
          continue;
        }
      }
      rebuilt.push(line);
    }
    if (didRewrite) oracle = rebuilt.join('\n');
  }

  // --- Modal spell preprocessing ---
  // Detects modal spells (Choose one/two/three, Spree, Tiered, pawprint modes)
  // and strips header lines + mode prefixes so downstream parsers see clean effect text.
  // Must run BEFORE em-dash stripping since Spree/Tiered/pawprint prefixes contain {.
  // Tracks mode indices so effects can be tagged with modalModeIndex for ordering + toggling.
  let _isModalSpell = false;
  const _modalModeLineMap = new Map(); // cleaned line index → modal mode index (0-based)
  {
    const oLines = oracle.split('\n');
    // Detect modal header: "Choose one/two/three/N", "Choose one or both", "Spree", "Tiered", or pawprint "Choose up to N {P}"
    const isModalHeader = (l) => /^(?:choose\s+(?:one|two|three|four|five|six|any number|up to\b|one or (?:both|more)\b)|spree\b|tiered\b)/i.test(l.trim());
    const hasModalHeader = oLines.some(l => isModalHeader(l));
    // Also detect by bullet/mode prefix patterns even without explicit header
    const hasModePrefixes = oLines.some(l => /^\s*(?:\u2022|(?:\+\s*)?{[^}]*}\s*[\u2014—])/m.test(l));
    if (hasModalHeader || hasModePrefixes) {
      _isModalSpell = true;
      permanent.isModalSpell = true;
      // Determine modal type and max active modes from the header
      // Default: choose-one (1 mode active)
      let modalMaxActive = 1;
      let modalMinActive = 0; // minimum modes required (0 = no minimum enforced)
      const headerLine = oLines.find(l => isModalHeader(l)) || '';
      const hLower = headerLine.trim().toLowerCase();
      const chooseMatch = hLower.match(/^choose\s+(one|two|three|four|five|six)\b/);
      if (/^choose\s+one or both\b/.test(hLower)) {
        modalMaxActive = 2;
        modalMinActive = 1; // must choose at least one
      } else if (/^choose\s+one or more\b/.test(hLower)) {
        modalMaxActive = Infinity;
        modalMinActive = 1; // must choose at least one
      } else if (chooseMatch) {
        modalMaxActive = WORD_TO_NUM[chooseMatch[1]] || 1;
      } else if (/^choose\s+any number\b/.test(hLower)) {
        modalMaxActive = Infinity;
      } else if (/^spree\b/.test(hLower)) {
        modalMaxActive = Infinity; // Spree: one or more
      } else if (/^tiered\b/.test(hLower)) {
        modalMaxActive = 1; // Tiered: exactly one
      } else if (/^choose\s+up to\b/.test(hLower)) {
        modalMaxActive = Infinity; // Pawprint: flexible
      }
      // Check for "You may choose the same mode more than once" → repeatable
      const fullOracle = (card.oracle_text || '').toLowerCase();
      const modalRepeatable = /you may choose the same mode more than once/i.test(fullOracle);
      // Check for Entwine — allows all modes regardless
      if (/\bentwine\b/.test(fullOracle)) {
        modalMaxActive = Infinity;
      }
      permanent.modalMaxActive = modalMaxActive;
      permanent.modalMinActive = modalMinActive;
      permanent.modalRepeatable = modalRepeatable;
      const _modalModeTexts = []; // raw mode text for popup display
      const cleaned = [];
      let modeIdx = 0;
      for (const line of oLines) {
        const trimmed = line.trim();
        // Skip modal header lines entirely (no layer effects)
        if (isModalHeader(trimmed)) continue;
        let modeText = null;
        // Strip bullet "• " prefix (standard modal: "• Creatures you control get +2/+0...")
        if (trimmed.startsWith('\u2022')) {
          const afterBullet = trimmed.slice(1).trim();
          // Some bullets have named modes: "• Cure — {0} — effect"
          // For Tiered, strip the "ModeName — {cost} — " prefix
          const tieredPrefix = afterBullet.match(/^[A-Z]\w*(?:\+*)\s*[\u2014—]\s*(?:\{[^}]*\})+\s*[\u2014—]\s*/);
          modeText = tieredPrefix ? afterBullet.slice(tieredPrefix[0].length) : afterBullet;
        }
        // Strip Spree mode prefix: "+ {cost} — effect" or "+{cost} — effect"
        if (!modeText) {
          const spreeMatch = trimmed.match(/^\+\s*(\{[^}]*\}(?:\{[^}]*\})*)\s*[\u2014—]\s*(.*)/);
          if (spreeMatch) modeText = spreeMatch[2];
        }
        // Strip pawprint mode prefix: "{P}+ — effect" (one or more {P} then em-dash)
        if (!modeText) {
          const pawprintMatch = trimmed.match(/^(?:\{P\})+\s*[\u2014—]\s*(.*)/);
          if (pawprintMatch) modeText = pawprintMatch[1];
        }
        // Strip Tiered non-bullet format: "ModeName — {cost} — effect"
        if (!modeText && hasModalHeader) {
          const tieredMatch = trimmed.match(/^[A-Z]\w*(?:\+*)\s*[\u2014—]\s*(?:\{[^}]*\})+\s*[\u2014—]\s*(.*)/);
          if (tieredMatch) modeText = tieredMatch[1];
        }
        if (modeText !== null) {
          // This is a mode line — record its cleaned line index → mode index
          _modalModeLineMap.set(cleaned.length, modeIdx);
          _modalModeTexts.push(modeText);
          cleaned.push(modeText);
          modeIdx++;
        } else {
          // Keep other lines as-is (non-mode content)
          cleaned.push(trimmed);
        }
      }
      permanent.modalModeTexts = _modalModeTexts;
      oracle = cleaned.join('\n');
    }
  }

  // Note: "target player" is NOT normalized to "you control" — individual parsers
  // set _targetsChosenPlayer on the permanent when they produce a target-player effect,
  // and the UI shows a dropdown to select the beneficiary at that point.

  // Strip ability words (flavor words before em dashes at the start of lines).
  // E.g. "Jump — During your turn, this card has flying." → "During your turn, this card has flying."
  // Ability words have no rules meaning; the em dash separates them from the actual rules text.
  // Exclude lines with { before the em dash (those are activated ability costs, not ability words).
  // Exclude lines where the em dash appears inside a quoted string (e.g. "Ward—Pay 3 life,").
  // Loop to handle multiple prefixes: saga chapters + ability words, e.g.
  // "I, II, III, IV — Stampede! — Other creatures get +1/+0" → "Other creatures get +1/+0"
  { let prev; do { prev = oracle; oracle = oracle.replace(/^([^{\n.;"—\u2014]+)\s*[\u2014—]\s*/gm, ''); } while (oracle !== prev); }

  // Strip spacecraft station "N+ | " prefixes from oracle text so generic parsers see the ability text.
  // E.g. "2+ | Other creatures you control get +1/+1." → "Other creatures you control get +1/+1."
  // The conditions were already captured in _spacecraftLineData above.
  if (_isSpacecraft) {
    oracle = oracle.replace(/^\d+\+\s*\|\s*/gm, '');
  }


  // Normalize "During your turn, " prefix → "As long as it is your turn, " so existing
  // "As long as" patterns handle it uniformly. Scryfall uses "During your turn" for many cards
  // (e.g. Ahn-Crop Invader, Bilbo's Ring, Cloud). Handles compound forms like
  // "During your turn, as long as [X], [effect]" → "As long as it is your turn and [X], [effect]"
  oracle = oracle.replace(/^During your turn,\s*as long as\s+/gim, 'As long as it is your turn and ');
  oracle = oracle.replace(/^During your turn,\s*/gim, 'As long as it is your turn, ');
  oracle = oracle.replace(/^During turns other than yours,\s*/gim, 'As long as it is not your turn, ');
  // Normalize "While " at start of line → "As long as " so existing condition parsers handle it
  oracle = oracle.replace(/^While\b/gim, 'As long as');

  // Expansion: "<base sentence>. The same is true for <list>." — Odric / Death-Mask Duplicant.
  // Find a keyword ability mentioned in the base sentence, then emit N copies of the base
  // sentence with each list item substituted for that keyword (each on its own line so
  // per-sentence conditions can be registered in _lineConditionMap independently).
  //
  // SKIP expansion when the base sentence starts with a trigger word ("When/Whenever/At"):
  // for Odric's static parse the base sentence has the "At the beginning of each combat,"
  // prefix and we want one triggered ability that produces multiple effects on fire,
  // not 13 separate static triggered abilities. After the user fires Odric's trigger,
  // the pseudo-permanent's effectText (post-comma) no longer starts with a trigger word,
  // so expansion fires there and emits one ADD_ABILITY effect per keyword.
  {
    const _EXPANDABLE_KEYWORDS = [
      'first strike', 'double strike', 'flying', 'deathtouch', 'haste', 'hexproof',
      'indestructible', 'lifelink', 'menace', 'reach', 'trample', 'vigilance',
      'skulk', 'fear', 'shadow', 'protection', 'landwalk', 'shroud', 'flash',
      'defender', 'horsemanship', 'flanking', 'phasing', 'banding', 'wither',
      'infect', 'prowess', 'intimidate'
    ];
    const _expSorted = [..._EXPANDABLE_KEYWORDS].sort((a, b) => b.length - a.length);
    oracle = oracle.replace(
      /([^.\n]+?)\.\s*The same is true for\s+([^.\n]+?)\./gi,
      (match, baseSentence, listText) => {
        const trimmedBase = baseSentence.trim();
        // Skip expansion for static triggered abilities — they should expand at fire time instead.
        if (_isTriggeredSentence(trimmedBase)) return match;
        let items = listText
          .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
          .map(s => s.trim().replace(/\.+$/, ''))
          .filter(Boolean);
        if (items.length === 0) return match;
        // "Protection" can't be expanded into a normal substituted sentence — bare "protection"
        // isn't a valid keyword (it always needs "from X"), and the specific X values depend
        // on what's currently exiled-with / controlled. Handle it via a special engine-side
        // effect that derives the actual "Protection from X" clauses at apply time from the
        // imprinted exile entries. (Currently only supports the Duplicant-shape exiled-with
        // base sentence; "a creature you control has" cards don't list "protection" in their
        // expansion.)
        const hasProtectionItem = items.some(i => /^protection$/i.test(i));
        if (hasProtectionItem && /\ba card exiled with\b/i.test(trimmedBase)) {
          items = items.filter(i => !/^protection$/i.test(i));
          const srcId = permanent.id;
          pushEff('6', EFFECT_TYPE.ADD_ABILITY,
            { protectionFromImprinted: true },
            { isSelf: true, isTargeted: false, fn: null, selfAffect: true },
            `${card.name} has each "Protection from X" of a card exiled with it.`,
            { asLongAsCondition: () => {
              if (typeof _getImprintedExileEntries !== 'function') return false;
              const entries = _getImprintedExileEntries(srcId);
              for (const e of entries) {
                const txt = ((e.card && e.card.oracle_text) || '').toLowerCase();
                if (/\bprotection from\b/.test(txt)) return true;
              }
              return false;
            } });
        }
        if (items.length === 0) return match;
        let templateKw = null;
        for (const kw of _expSorted) {
          const re = new RegExp('\\b' + kw.replace(/ /g, '\\s+') + '\\b', 'i');
          if (re.test(trimmedBase)) { templateKw = kw; break; }
        }
        if (!templateKw) return match;
        const reTemplate = new RegExp('\\b' + templateKw.replace(/ /g, '\\s+') + '\\b', 'gi');
        const sentences = [trimmedBase + '.'];
        for (const item of items) {
          sentences.push(trimmedBase.replace(reTemplate, item) + '.');
        }
        return sentences.join('\n');
      }
    );
  }

  // Pattern A: "As long as [condition], it [effect]" at start of line
  oracle = oracle.replace(/^As long as\s+(?!your devotion\b)([^,]+),\s*it\s+/gim, (match, condText) => {
    const cond = _parseCondition(condText);
    if (cond) {
      const idx = _asLongAsConditions.length;
      _asLongAsConditions.push(cond);
      return `\x04${idx}\x04` + enchantedRef + ' ';
    }
    return enchantedRef + ' ';
  });

  // Pattern A2: "As long as [condition], enchanted/equipped [type] [effect]" — just strip the condition prefix
  oracle = oracle.replace(/^As long as\s+(?!your devotion\b)[^,]+,\s*(?=(enchanted|equipped)\s)/gim, (match, condRef) => {
    const condText = match.replace(/^As long as\s+/i, '').replace(/,\s*$/, '');
    const cond = _parseCondition(condText);
    if (cond) {
      const idx = _asLongAsConditions.length;
      _asLongAsConditions.push(cond);
      return `\x04${idx}\x04`;
    }
    return '';
  });

  // Pattern A3: "As long as [condition], this card/creature/permanent/token [effect]" — strip condition prefix
  oracle = oracle.replace(/^As long as\s+(?!your devotion\b)(.+),\s*(?=(?:this card|this creature|this permanent|this token)\s)/gim, (match, condText) => {
    const cond = _parseCondition(condText);
    if (cond) {
      const idx = _asLongAsConditions.length;
      _asLongAsConditions.push(cond);
      return `\x04${idx}\x04`;
    }
    return '';
  });

  // Pattern A4: "As long as [condition], each/all [filter] [effect]" — strip condition prefix
  // Handles cards like Bello: "As long as it's your turn, each non-Aura enchantment..."
  oracle = oracle.replace(/^As long as\s+(?!your devotion\b)([^,]+),\s*(?=(?:all|each)\s)/gim, (match, condText) => {
    const cond = _parseCondition(condText);
    if (cond) {
      const idx = _asLongAsConditions.length;
      _asLongAsConditions.push(cond);
      return `\x04${idx}\x04`;
    }
    return '';
  });

  // Pattern A5: "As long as [condition], [filter] [get/gain/have/are] [effect]"
  // Handles: "As long as X, creatures you control get +2/+2" (Leyline of Hope)
  // Uses a broad lookahead: any words followed by a verb keyword
  oracle = oracle.replace(/^As long as\s+(?!your devotion\b)([^,]+),\s*(?=.+?\b(?:get|gets|gain|gains|have|has|are|is|lose|loses)\s)/gim, (match, condText) => {
    const cond = _parseCondition(condText);
    if (cond) {
      const idx = _asLongAsConditions.length;
      _asLongAsConditions.push(cond);
      return `\x04${idx}\x04`;
    }
    return '';
  });

  // Pattern B: trailing "as long as [condition]" at end of sentence
  // Exception: preserve "as long as your devotion" (Theros gods)
  oracle = oracle.replace(/\s+as long as\s+(?!your devotion\b)([^.,;\n]+)(?=[.,;]|$)/gi, (match, condText) => {
    const cond = _parseCondition(condText);
    if (cond) {
      const idx = _asLongAsConditions.length;
      _asLongAsConditions.push(cond);
      // Insert the marker at this position (it's mid-sentence, attach to current line)
      return `\x04${idx}\x04`;
    }
    return '';
  });

  // Pattern C: "if [condition], [effect]" at start of line — intervening-if clauses
  // Handles eminence ("if this card is in the command zone or on the battlefield, ...")
  // and lieutenant ("if you control your commander, ...") triggered ability effects.
  oracle = oracle.replace(/^if\s+([^,]+),\s*/gim, (match, condText) => {
    const cond = _parseCondition(condText);
    if (cond) {
      const idx = _asLongAsConditions.length;
      _asLongAsConditions.push(cond);
      return `\x04${idx}\x04`;
    }
    return '';
  });

  // Pattern D: trailing "if [condition]" at end of sentence — intervening-if for triggered effects.
  // e.g. Odric (post-expansion): "creatures you control gain first strike until end of turn if a
  // creature you control has first strike." If _parseCondition can't parse the captured text,
  // the match is left in place so unrelated "if" clauses are not stripped.
  // Skip matches inside triggered-ability sentences (When/Whenever/At): the trigger always
  // exists on the card, and the if-clause gates only the *fired* effects — those get parsed
  // separately when the pseudo-permanent is created from effectText (no trigger prefix).
  // Registering the condition here would put the trigger line in _conditionalAbilityIndices
  // and the engine's base state would filter the triggered ability out entirely.
  oracle = oracle.replace(/\s+if\s+([^.,;\n]+)(?=[.,;\n]|$)/gi, (match, condText, offset, full) => {
    let sentStart = 0;
    for (let k = offset - 1; k >= 0; k--) {
      const ch = full[k];
      if (ch === '.' || ch === ';' || ch === '\n') { sentStart = k + 1; break; }
    }
    const sentencePrefix = full.substring(sentStart).replace(/^\s+/, '');
    if (_isTriggeredSentence(sentencePrefix)) return match;
    const cond = _parseCondition(condText);
    if (cond) {
      const idx = _asLongAsConditions.length;
      _asLongAsConditions.push(cond);
      return ` \x04${idx}\x04`;
    }
    return match;
  });

  // Clean condition markers from oracle text used by downstream parsers,
  // but track which lines have conditions for attaching to effects later.
  const _lineConditionMap = new Map(); // line text snippet → condition index
  const oracleLines = oracle.split('\n');
  for (let i = 0; i < oracleLines.length; i++) {
    const markerMatch = oracleLines[i].match(/\x04(\d+)\x04/);
    if (markerMatch) {
      _lineConditionMap.set(i, parseInt(markerMatch[1]));
      oracleLines[i] = oracleLines[i].replace(/\x04\d+\x04/g, '').trim();
    }
  }
  oracle = oracleLines.join('\n');

  // Inject saga chapter lore counter conditions into _lineConditionMap.
  // These lines were detected before em-dash stripping; now attach conditions
  // so effects parsed from these lines will be gated by lore counter thresholds.
  if (_sagaLineThresholds.size > 0) {
    const srcId = permanent.id;
    for (const [lineIdx, minThreshold] of _sagaLineThresholds) {
      if (!_lineConditionMap.has(lineIdx)) {
        const cond = (_permState, allStates) => {
          if (allStates) {
            const srcState = allStates.get(srcId);
            if (srcState) return ((srcState.counters && srcState.counters['lore']) || 0) >= minThreshold;
          }
          return false;
        };
        const idx = _asLongAsConditions.length;
        _asLongAsConditions.push(cond);
        _lineConditionMap.set(lineIdx, idx);
      }
    }
  }

  // Inject class level conditions into _lineConditionMap.
  // Effects from class abilities are gated by the permanent's classLevel.
  // If a line already has a condition (e.g. "as long as"), compose both (AND).
  if (_classLineThresholds.size > 0) {
    const srcId = permanent.id;
    for (const [lineIdx, requiredLevel] of _classLineThresholds) {
      const classCond = (_permState, allStates) => {
        const srcPerm = Battlefield.getPermById(srcId);
        if (srcPerm) return (srcPerm.classLevel || 1) >= requiredLevel;
        return false;
      };
      if (_lineConditionMap.has(lineIdx)) {
        // Compose with existing condition: both must be true
        const existingIdx = _lineConditionMap.get(lineIdx);
        const existingCond = _asLongAsConditions[existingIdx];
        const composed = (permState, allStates) => classCond(permState, allStates) && existingCond(permState, allStates);
        const idx = _asLongAsConditions.length;
        _asLongAsConditions.push(composed);
        _lineConditionMap.set(lineIdx, idx);
      } else {
        const idx = _asLongAsConditions.length;
        _asLongAsConditions.push(classCond);
        _lineConditionMap.set(lineIdx, idx);
      }
    }
  }

  // Inject leveler bracket conditions into _lineConditionMap.
  // Leveler abilities are active only when level counters are in the matching bracket range.
  // Unlike Class enchantments, leveler abilities are EXCLUSIVE — only the current bracket is active.
  // The "Level up {cost}" line is always active (no condition needed).
  // Structural lines (LEVEL headers, P/T lines) get conditions too so they display correctly.
  if (_isLeveler && _levelerLineData.size > 0) {
    const srcId = permanent.id;
    for (const [lineIdx, data] of _levelerLineData) {
      // Level up activation line is always active — no condition
      if (data.isLevelUp) continue;
      
      const bracketIdx = data.bracket;
      if (bracketIdx < 0) continue; // base level, no condition
      const bracket = _levelerBrackets[bracketIdx];
      if (!bracket) continue;
      
      const minLvl = bracket.min;
      const maxLvl = bracket.max;
      
      const levelerCond = (_permState, allStates) => {
        if (allStates) {
          const srcState = allStates.get(srcId);
          if (srcState) {
            const lvlCount = (srcState.counters && srcState.counters['level']) || 0;
            return lvlCount >= minLvl && lvlCount <= maxLvl;
          }
        }
        return false;
      };
      
      const idx = _asLongAsConditions.length;
      _asLongAsConditions.push(levelerCond);
      _lineConditionMap.set(lineIdx, idx);
    }
  }

  // Inject spacecraft station conditions into _lineConditionMap.
  // Station abilities are CUMULATIVE: charge counters >= N means active.
  // The "Station" keyword line is always active (no condition needed).
  if (_isSpacecraft && _spacecraftLineData.size > 0) {
    const srcId = permanent.id;
    for (const [lineIdx, data] of _spacecraftLineData) {
      if (data.isKeyword) continue;

      const minCharge = data.min;

      const spacecraftCond = (_permState, allStates) => {
        if (allStates) {
          const srcState = allStates.get(srcId);
          if (srcState) {
            const chargeCount = (srcState.counters && srcState.counters['charge']) || 0;
            return chargeCount >= minCharge;
          }
        }
        return false;
      };

      if (_lineConditionMap.has(lineIdx)) {
        const existingIdx = _lineConditionMap.get(lineIdx);
        const existingCond = _asLongAsConditions[existingIdx];
        const composed = (permState, allStates) => spacecraftCond(permState, allStates) && existingCond(permState, allStates);
        const idx = _asLongAsConditions.length;
        _asLongAsConditions.push(composed);
        _lineConditionMap.set(lineIdx, idx);
      } else {
        const idx = _asLongAsConditions.length;
        _asLongAsConditions.push(spacecraftCond);
        _lineConditionMap.set(lineIdx, idx);
      }
    }
  }

  // Helper: get "as long as" condition for a regex match position in oracle
  function _getConditionForPos(pos) {
    // Advance past any sentence-ending punctuation and whitespace to find the
    // actual content line. Regex anchors like (?:^|\.|;)\s* can match the "."
    // from the end of the PREVIOUS line, then consume a newline — the content
    // is on the next line, but pos points to the "." on the previous line.
    let adjustedPos = pos;
    while (adjustedPos < oracle.length && /[.\s;]/.test(oracle[adjustedPos])) {
      adjustedPos++;
    }
    const textBefore = oracle.substring(0, adjustedPos);
    const lineNum = textBefore.split('\n').length - 1;
    const condIdx = _lineConditionMap.has(lineNum) ? _lineConditionMap.get(lineNum) : -1;
    return condIdx >= 0 ? _asLongAsConditions[condIdx] : null;
  }

  const oracleLower = oracle.toLowerCase();

  // Returns true if `matchIndex` lies in the effect portion of an activated ability
  // ("{cost}: effect"). Used by the generic static parsers so they don't treat the
  // effect text of an activated ability as a static continuous effect.
  // Boundary is the start of the enclosing line (activated abilities are single-line).
  function _isInActivatedEffect(matchIndex) {
    const lineStart = oracle.lastIndexOf('\n', matchIndex - 1) + 1;
    const prefix = oracle.substring(lineStart, matchIndex);
    // Any ":" in the prefix (inside the same line) means we're past a cost:effect separator.
    if (/:/.test(prefix)) return true;
    // Edge case: when haveAbilityRegex matches via the ^ anchor at the very start of a line,
    // prefix is empty even if the line IS an activated ability (e.g. "{W}{U}{B}{R}{G}: Creatures
    // you control … Scions and Spawns … gain annihilator 1 until end of turn."). Check the
    // full line for a colon outside mana/tap symbols.
    if (prefix.length === 0) {
      const lineEnd = oracle.indexOf('\n', matchIndex);
      const fullLine = oracle.substring(matchIndex, lineEnd < 0 ? oracle.length : lineEnd);
      // Strip quoted granted abilities first: a colon inside a quoted ability
      // (e.g. 'This Saga gains "{T}: Add {C}."') is the granted ability's own
      // cost separator, not this line's. Only a colon OUTSIDE quotes (after the
      // mana cost) makes this line itself an activated ability.
      const lineOutsideQuotes = fullLine.replace(/"[^"]*"/g, '').replace(/\{[^}]+\}/g, '');
      if (/:/.test(lineOutsideQuotes)) return true;
    }
    return false;
  }

  function _isInTriggeredSentence(matchIndex) {
    // A triggered ability occupies its whole line ("When/Whenever/At …, <effects>").
    // Every clause on that line — including later sentences such as Princess Yue's
    // "She's a land named Moon. She gains …" — is part of the one-shot triggered
    // effect, never a static continuous effect. So if the enclosing LINE opens with
    // a trigger keyword, treat any match on it as inside the triggered ability.
    const lineStart = oracle.lastIndexOf('\n', matchIndex - 1) + 1;
    const lineEndIdx = oracle.indexOf('\n', matchIndex);
    const line = oracle.substring(lineStart, lineEndIdx < 0 ? oracle.length : lineEndIdx).trimStart();
    if (_isTriggeredSentence(line)) return true;
    // Otherwise fall back to the immediate sentence (handles mid-line phrasings).
    const prevDot = oracle.lastIndexOf('.', matchIndex);
    const prevLine = oracle.lastIndexOf('\n', matchIndex);
    const sentenceStart = Math.max(prevDot, prevLine) + 1;
    const nextDot = oracle.indexOf('.', matchIndex);
    const nextLine = oracle.indexOf('\n', matchIndex);
    const ends = [nextDot, nextLine].filter(i => i >= 0);
    const sentenceEnd = ends.length ? Math.min(...ends) : oracle.length;
    const sentence = oracle.substring(sentenceStart, sentenceEnd).trimStart();
    return _isTriggeredSentence(sentence);
  }

  // --- Generic Copy Effect Parsing (Layer 1) ---
  // Detects "enters the battlefield as a copy of" / "enter the battlefield as a copy of"
  // and "becomes a copy of" (used by triggered abilities like Mindlink Mech).
  // Also detects "except" clauses for copy modifications.
  // copyClauseSpans tracks the matched span(s) so other regex parsers (setTypeRegex,
  // haveAbilityRegex, etc.) don't refire on the same text.
  const copyClauseSpans = [];
  const copyRegex = /(enters?\s+(?:the battlefield\s+)?as|becomes?)\s+a\s+copy\s+of\s+(?:any\s+|a\s+|target\s+)?([^.]+?)(?:\s*,?\s*except\s+(.+?))?(?:\.|$)/i;
  const copyMatch = oracleLower.match(copyRegex);
  if (copyMatch && !_isInTriggeredSentence(copyMatch.index)) {
    const isBecomesCopy = /^becomes?$/i.test(copyMatch[1]);
    copyClauseSpans.push({ start: copyMatch.index, end: copyMatch.index + copyMatch[0].length });
    // Determine restriction from what can be copied (e.g. "any creature", "a creature or artifact")
    const targetDescRaw = copyMatch[2].trim();
    const exceptClause = copyMatch[3] ? copyMatch[3].trim() : null;
    // Detect "mana value less than or equal to the amount of mana spent to cast" restriction.
    // Strip it from targetDesc so the type-restriction logic below isn't confused by it.
    let maxManaValueParam = null;
    const mvSpentMatch = targetDescRaw.match(/\s+with\s+mana\s+value\s+less\s+than\s+or\s+equal\s+to\s+the\s+amount\s+of\s+mana\s+spent\s+to\s+cast\b[^,]*/i);
    const targetDesc = mvSpentMatch
      ? (targetDescRaw.slice(0, mvSpentMatch.index) + targetDescRaw.slice(mvSpentMatch.index + mvSpentMatch[0].length)).trim()
      : targetDescRaw;
    if (mvSpentMatch) maxManaValueParam = 'spentToCast';
    // Detect the zone the copy target is drawn from. By default the target is a
    // battlefield permanent, but cards like Shifting Woodland copy "target permanent
    // card in your graveyard" — the copy-target picker must look in that zone instead.
    let copyTargetZone = null, copyTargetZoneOwner = 'any';
    const _copyZoneMatch = targetDesc.match(/\b(?:in|from)\s+(your|a|an|all|each|target\s+player'?s?|(?:an?\s+)?opponent'?s?)?\s*(graveyards?|exile)\b/i);
    if (_copyZoneMatch) {
      copyTargetZone = /exile/i.test(_copyZoneMatch[2]) ? 'exile' : 'graveyard';
      copyTargetZoneOwner = /^your$/i.test((_copyZoneMatch[1] || '').trim()) ? 'you' : 'any';
    }
    const isNonlegendaryRestriction = /\bnonlegendary\b/.test(targetDesc);
    let restriction = null;
    if (/creature/.test(targetDesc) && /artifact/.test(targetDesc)) {
      restriction = (p) => p.types.includes('Creature') || p.types.includes('Artifact');
    } else if (/creature/.test(targetDesc) && /planeswalker/.test(targetDesc)) {
      restriction = (p) => p.types.includes('Creature') || p.types.includes('Planeswalker');
    } else if (/creature/.test(targetDesc) && /\bland\b/.test(targetDesc)) {
      restriction = (p) => p.types.includes('Creature') || p.types.includes('Land');
    } else if (/creature/.test(targetDesc)) {
      restriction = isNonlegendaryRestriction
        ? (p) => p.types.includes('Creature') && !p.supertypes.includes('Legendary')
        : (p) => p.types.includes('Creature');
    } else if (/artifact/.test(targetDesc)) {
      restriction = (p) => p.types.includes('Artifact');
    } else if (/enchantment/.test(targetDesc)) {
      restriction = (p) => p.types.includes('Enchantment');
    } else if (/nonland/.test(targetDesc)) {
      restriction = (p) => !p.types.includes('Land');
    } else if (/permanent/.test(targetDesc)) {
      // A "permanent card" in a graveyard/exile zone can sit beside instants/sorceries,
      // so restrict to actual permanent card types rather than matching everything.
      const PERMANENT_CARD_TYPES = ['Creature', 'Land', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle'];
      restriction = (p) => (p.types || []).some(t => PERMANENT_CARD_TYPES.includes(t));
    }
    // Parse "except" clause for copy modifications
    const copyParams = { copySource: null, restriction, maxManaValue: maxManaValueParam };
    if (copyTargetZone) { copyParams.copyTargetZone = copyTargetZone; copyParams.copyTargetZoneOwner = copyTargetZoneOwner; }
    // Imprint: "becomes a copy of the exiled card" — Dermotaxi.
    // The copy source is resolved at apply time from the most-recent imprinted exile entry.
    // Self-target the source perm so the result of the activated ability is visible in the
    // inspector once the user has imprinted a card (the user's intent in imprinting + selecting
    // the card is to see what the copy looks like).
    const _isExiledCardCopy = /^the\s+(?:exiled|imprinted)\s+cards?$/.test(targetDesc.trim());
    if (_isExiledCardCopy) {
      copyParams.copyFromExiledCard = true;
    }
    if (exceptClause) {
      // "except it's also an artifact" / "except it's an artifact in addition to its other types" -> addTypes/addSubtypes
      // Multi-word capture handles "vehicle artifact" (Mindlink Mech) — split words and bin
      // each into types vs subtypes.
      const CARD_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'];
      const alsoMatch = exceptClause.match(/it(?:'s| is) also an? ([\w\s]+?)(?:\.|,|$)/i)
        || exceptClause.match(/it(?:'s| is) an? ([\w\s]+?) in addition to/i);
      if (alsoMatch) {
        const words = alsoMatch[1].trim().split(/\s+/);
        for (const w of words) {
          const cap = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
          if (CARD_TYPES.includes(cap)) {
            (copyParams.addTypes ||= []).push(cap);
          } else {
            (copyParams.addSubtypes ||= []).push(cap);
          }
        }
      }
      // "except it's X/Y" or "except it is X/Y" -> setPT (Mindlink Mech: "it's 4/3")
      const itPTMatch = exceptClause.match(/it(?:'s| is)\s+(\d+)\/(\d+)\b/i);
      if (itPTMatch) {
        copyParams.setPT = { power: parseInt(itPTMatch[1]), toughness: parseInt(itPTMatch[2]) };
      }
      // "except its name is still [X]" -> keepName
      if (/its name is still/i.test(exceptClause) || /its name is/i.test(exceptClause)) {
        copyParams.keepName = true;
      }
      // "except it's [color]" -> setColors
      for (const [cName, cCode] of Object.entries(COLOR_NAMES)) {
        if (exceptClause.includes(cName) && /it(?:'s| is)\s/.test(exceptClause)) {
          if (!copyParams.setColors) copyParams.setColors = [];
          copyParams.setColors.push(cCode);
        }
      }
      // "except it has this card's other abilities" -> addAbilities from all other oracle lines
      if (/it (?:has|gains?)\s+this (?:card|token)'s other abilities/i.test(exceptClause)) {
        // Gather all other ability lines from the original card's oracle text,
        // excluding the copy line itself
        const allLines = _stripReminderText(card.oracle_text || '').split('\n').map(l => l.trim()).filter(Boolean);
        const copyLineRegex = /enters?\s+(?:the battlefield\s+)?as\s+a\s+copy\s+of/i;
        copyParams.addAbilities = allLines.filter(l => !copyLineRegex.test(l));
      }
      // "except it has [ability]" / "except it gains [ability]" / "and it has flying" -> addAbilities
      // Note: in triggered-ability text, "it" may have been converted to "target creature"
      // by _addAbilityPseudo, so accept either subject. Split on commas/and to capture
      // each ability separately (e.g. "..., and it has flying").
      else {
        const KEYWORD_RE = /\b(?:flying|trample|haste|vigilance|deathtouch|lifelink|reach|menace|first strike|double strike|hexproof|indestructible|defender|shroud|protection from \w+|prowess|skulk|fear|intimidate|flash|unblockable)\b/gi;
        const abilities = [];
        let kmatch;
        while ((kmatch = KEYWORD_RE.exec(exceptClause)) !== null) {
          abilities.push(kmatch[0].toLowerCase().replace(/\b\w/g, c => c.toUpperCase()));
        }
        if (abilities.length) copyParams.addAbilities = abilities;
      }
      // "except ... it has '<quoted ability>'" — Sakashima the Impostor grants the copy a full
      // quoted activated ability ("{2}{U}{U}: Return this card to its owner's hand ..."). copyRegex
      // truncates exceptClause at the first period (which lives inside the quotes), so scan the
      // original-case oracle to capture the ability verbatim (preserving mana symbols / casing).
      const quotedAbilityRe = /\b(?:it|this card|this creature|this permanent)\s+(?:has|gains?)\s+"([^"]+)"/gi;
      let qMatch;
      while ((qMatch = quotedAbilityRe.exec(oracle)) !== null) {
        const quotedAb = qMatch[1].trim();
        if (quotedAb) (copyParams.addAbilities ||= []).push(quotedAb);
      }
      // "except its power and toughness are X/Y" -> setPT
      const ptMatch = exceptClause.match(/power and toughness (?:are|is) (\d+)\/(\d+)/i);
      if (ptMatch) {
        copyParams.setPT = { power: parseInt(ptMatch[1]), toughness: parseInt(ptMatch[2]) };
      }
      // "except it's a [type]" -> setTypes (but not "if it's a X" conditional clauses)
      const typeMatch = exceptClause.match(/(?<!if )it(?:'s| is) (?:a |an )?(\w+)\b(?! also)/i);
      if (typeMatch && !alsoMatch) {
        const typeCap = typeMatch[1].charAt(0).toUpperCase() + typeMatch[1].slice(1);
        if (['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker'].includes(typeCap)) {
          copyParams.setTypes = [typeCap];
        }
      }
      // "except it's not legendary" / "except it isn't legendary" -> notLegendary
      // General form: "except it's not [type]" removes the specified type from the copy
      const NOT_TYPE_MAP = { legendary: 'Legendary', artifact: 'Artifact', creature: 'Creature',
        enchantment: 'Enchantment', land: 'Land', planeswalker: 'Planeswalker' };
      // "except it's still legendary" / "except it is still [type]" -> keepLegendary / addSupertypes
      const stillMatch = exceptClause.match(/it(?:'s| is)\s+still\s+(\w+)/i);
      if (stillMatch) {
        const kept = NOT_TYPE_MAP[stillMatch[1].toLowerCase()];
        if (kept === 'Legendary') copyParams.keepLegendary = true;
        else if (kept) { if (!copyParams.addSupertypes) copyParams.addSupertypes = []; copyParams.addSupertypes.push(kept); }
      }
      // "except it's legendary in addition to its other types" -> keepLegendary (Sakashima pattern)
      if (/it(?:'s| is)\s+legendary\s+in addition to/i.test(exceptClause)) {
        copyParams.keepLegendary = true;
      }
      const notTypeMatch = exceptClause.match(/it(?:'s| is)n?'?t?\s+(?:not\s+)?(\w+)/i);
      if (notTypeMatch && notTypeMatch[1].toLowerCase() !== 'still'
          && !/it(?:'s| is)\s+legendary\s+in addition/i.test(exceptClause)) {
        const removed = NOT_TYPE_MAP[notTypeMatch[1].toLowerCase()];
        if (removed === 'Legendary') copyParams.notLegendary = true;
        else if (removed) { if (!copyParams.removeTypes) copyParams.removeTypes = []; copyParams.removeTypes.push(removed); }
      }
    }
    // Also check full oracle for "that copy/it isn't legendary" (Spark Double pattern)
    if (!copyParams.notLegendary) {
      if (/(?:that copy|the copy|it(?:'s)?) (?:is not|isn'?t) legendary/i.test(oracle)) {
        copyParams.notLegendary = true;
      }
    }
    // For "enters as a copy" the source perm itself is what becomes the copy (selfTarget).
    // For "becomes a copy" used inside a triggered ability, the effect's target is the
    // underlying source perm (Vehicle), not the trigger pseudo-permanent — leave targetId
    // unset and let _pinAbilityEffectsToSource pin it to the actual source.
    //
    // Inside an activated ability's effect text (Dermotaxi), don't emit the COPY effect
    // statically — it will be re-parsed when the activated ability fires, and remapped to
    // target the original source via _addAbilityPseudo. copyClauseSpans is still populated
    // above so other regex parsers (addTypeRegex etc.) don't refire on the "except" clause.
    if (!_isInActivatedEffect(copyMatch.index)) {
      pushEff('1', EFFECT_TYPE.COPY, copyParams,
        { appliesTo: null, scope: 'targeted', selfTarget: !isBecomesCopy || _isExiledCardCopy },
        `${isBecomesCopy ? 'Becomes' : 'Enter as'} a copy of ${targetDesc}${exceptClause ? ', except ' + exceptClause : ''}.`);
    }
  }

  // --- Generic Supertype Changes (Layer 4) ---
  // Handles "are basic", "are legendary", "becomes snow", and "isn't snow".
  const SUPERTYPE_BY_WORD = { basic: 'Basic', legendary: 'Legendary', snow: 'Snow', world: 'World' };
  const addSupertypeRegex = /(?:^|[.;])\s*(.+?)\s+(?:you (?:control|own)\s+)?(?:are|is|becomes?)\s+(basic|legendary|snow|world)\b(?:\s+until\s+(?:end\s+of\s+turn|your\s+next\s+turn))?/gmi;
  let addSupertypeMatch;
  while ((addSupertypeMatch = addSupertypeRegex.exec(oracle)) !== null) {
    if (_isInActivatedEffect(addSupertypeMatch.index) || _isInTriggeredSentence(addSupertypeMatch.index)) continue;
    // Skip clauses already consumed by a copy "except …" (e.g. Sakashima "except it's
    // legendary in addition to its other types") — that's a Layer-1 copy modification,
    // not a separate Layer-4 supertype change.
    const _asStart = addSupertypeMatch.index, _asEnd = addSupertypeMatch.index + addSupertypeMatch[0].length;
    if (copyClauseSpans.some(r => _asStart < r.end && _asEnd > r.start)) continue;
    let filterText = addSupertypeMatch[1].trim();
    filterText = filterText.replace(/\s+and\s+land\s+cards?\s+in\s+your\s+library\b.*$/i, '').trim();
    if (!filterText || !filterReferencesPermanents(filterText)) continue;
    if (/\byou (?:control|own)\b/i.test(addSupertypeMatch[0]) && !/\byou (?:control|own)\b/i.test(filterText)) {
      filterText += ' you control';
    }
    const parsedSupertype = SUPERTYPE_BY_WORD[addSupertypeMatch[2].toLowerCase()];
    const bResult = buildAppliesToFromText(filterText);
    const { fn, desc, isSelf, isTargeted, needsTargetSelection, maxTargets } = bResult;
    const eff = pushEff('4', EFFECT_TYPE.ADD_TYPE,
      { supertypes: [parsedSupertype] },
      { isSelf, isTargeted, fn, selfAffect: isSelf ? true : detectSelfAffect(filterText) },
      `${filterText} are ${parsedSupertype}. ${desc}`,
      { _oraclePos: addSupertypeMatch.index });
    _applyTargetInfo(eff, { isSpellTarget: !!needsTargetSelection, maxTargets: maxTargets || 1 }, fn);
    copyClauseSpans.push({ start: addSupertypeMatch.index, end: addSupertypeMatch.index + addSupertypeMatch[0].length });
  }

  const removeSupertypeRegex = /(?:^|[.;])\s*(.+?)\s+(?:isn't|is not|aren't|are not)\s+(basic|legendary|snow|world)\b(?:\s+until\s+(?:end\s+of\s+turn|your\s+next\s+turn))?/gmi;
  let removeSupertypeMatch;
  while ((removeSupertypeMatch = removeSupertypeRegex.exec(oracle)) !== null) {
    if (_isInActivatedEffect(removeSupertypeMatch.index) || _isInTriggeredSentence(removeSupertypeMatch.index)) continue;
    // Skip clauses already consumed by a copy "except …" (e.g. Spark Double "and it
    // isn't legendary") — losing Legendary is part of the Layer-1 copy, not a separate
    // Layer-4 supertype change.
    const _rsStart = removeSupertypeMatch.index, _rsEnd = removeSupertypeMatch.index + removeSupertypeMatch[0].length;
    if (copyClauseSpans.some(r => _rsStart < r.end && _rsEnd > r.start)) continue;
    const filterText = removeSupertypeMatch[1].trim();
    if (!filterText || !filterReferencesPermanents(filterText)) continue;
    const parsedSupertype = SUPERTYPE_BY_WORD[removeSupertypeMatch[2].toLowerCase()];
    const bResult = buildAppliesToFromText(filterText);
    const { fn, desc, isSelf, isTargeted, needsTargetSelection, maxTargets } = bResult;
    const eff = pushEff('4', EFFECT_TYPE.REMOVE_TYPE,
      { supertypes: [parsedSupertype] },
      { isSelf, isTargeted, fn, selfAffect: isSelf ? true : detectSelfAffect(filterText) },
      `${filterText} isn't ${parsedSupertype}. ${desc}`,
      { _oraclePos: removeSupertypeMatch.index });
    _applyTargetInfo(eff, { isSpellTarget: !!needsTargetSelection, maxTargets: maxTargets || 1 }, fn);
    copyClauseSpans.push({ start: removeSupertypeMatch.index, end: removeSupertypeMatch.index + removeSupertypeMatch[0].length });
  }

  // --- Aura Target Restriction: parse "Enchant [permanent type(s)]" from oracle text ---
  // Auras have "Enchant [type]" as the first line; use it to restrict which permanents are valid targets.
  const enchantLineMatch = oracle.match(/^Enchant\s+(.+?)(?:\n|$)/im);
  if (enchantLineMatch) {
    const enchantTarget = enchantLineMatch[1].trim();
    const auraRestriction = buildAuraRestriction(enchantTarget);
    if (auraRestriction) {
      for (const eff of effects) {
        if (eff.scope === 'targeted' && !eff.selfTarget) eff.auraRestriction = auraRestriction;
      }
    }
    if (!permanent._auraRestriction) permanent._auraRestriction = auraRestriction;
    // "Enchant [type] an opponent controls" — restrict targeting to opponents' permanents
    if (/\bopponent(?:'?s?)?\s+controls?\b/i.test(enchantTarget)) {
      permanent._opponentControlRequired = true;
      for (const eff of effects) {
        if (eff.scope === 'targeted' && !eff.selfTarget) eff.opponentControlRequired = true;
      }
    }
    // "Enchant [type] you control" — restrict targeting to same-controller permanents
    if (/\byou\s+controls?\b/i.test(enchantTarget)) {
      permanent._youControlRequired = true;
      for (const eff of effects) {
        if (eff.scope === 'targeted' && !eff.selfTarget) eff.youControlRequired = true;
      }
    }
  }

  function detectSelfAffect(text) {
    const t = text.toLowerCase().trim();
    return !(t.startsWith('other ') || t.includes('each other') || /\bother\b/.test(t));
  }

  // Detect standalone "loses all creature types" (outside complex aura parser)
  // Helper: clause-start before `idx` (last . / ; / newline + 1).
  const _clauseStart = (idx) => {
    const before = oracle.substring(0, idx);
    return Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  };
  // Skip if matched text sits inside an activated-ability effect ("{cost}: …": colon
  // in same clause). The effect is handled via the pseudo-perm when the ability fires.
  const _losesAllCTMatch = /loses? all creature types/i.exec(oracle);
  const _isLosesInActivatedAbility = _losesAllCTMatch
    && oracle.substring(_clauseStart(_losesAllCTMatch.index), _losesAllCTMatch.index).includes(':');
  // Skip when "lose all creature types" is in the same clause as "have base P/T"
  // (handled by generalBasePTRegex with the correct filter).
  const _losesCTInBasePTClause = _losesAllCTMatch
    && /have\s+base\s+power\s+and\s+toughness/i.test(
        oracle.substring(_clauseStart(_losesAllCTMatch.index), _losesAllCTMatch.index + 30));
  // Self / targeted "[subject] gains/is/are/becomes all creature types".
  // - "Target creature gains all creature types until end of turn" (Amoeboid Changeling activated).
  // - "this creature gets +2/+2 and is all creature types" (Undercover Skrull) — the self subject
  //   may be separated from the verb by an earlier conjunct (handled by the [^.;:]*? span). Matching
  //   it here avoids the generic setTypeRegex capturing "this creature gets +2/+2 and" as the filter.
  const gainsAllCTMatch = /\b(?:target\s+([\w][\w\s]*?(?=\s+(?:gains?|is|are|becomes?)\s+all\s+creature\s+types))|(?:this\s+(?:creature|permanent|card|token)|it)\b[^.;:]*?)\s+(?:gains?|is|are|becomes?)\s+all\s+creature\s+types/i.exec(oracle);
  const _isGainsInActivatedAbility = gainsAllCTMatch
    && oracle.substring(_clauseStart(gainsAllCTMatch.index), gainsAllCTMatch.index).includes(':');
  if (gainsAllCTMatch && !_isGainsInActivatedAbility && !effects.some(e => e.params && e.params.gainsAllCreatureTypes && e.selfTarget && e.sourceId === permanent.id)) {
    const rawFilter = gainsAllCTMatch[1];
    const isSelf = !rawFilter;
    const { fn } = rawFilter ? buildAppliesToFromText(rawFilter.trim()) : { fn: null };
    const gainsAllCTCond = _getConditionForPos(gainsAllCTMatch.index);
    pushEff('4', EFFECT_TYPE.ADD_TYPE, { gainsAllCreatureTypes: true },
      { appliesTo: fn, scope: 'targeted', selfTarget: isSelf },
      'Gains all creature types.',
      { targetRestriction: fn, asLongAsCondition: gainsAllCTCond || undefined });
  }

  // Changeling keyword ability → Layer 4 self-effect granting all creature types.
  if (/\bchangeling\b/i.test(oracle) &&
      !effects.some(e => e.type === EFFECT_TYPE.ADD_TYPE && e.params.gainsAllCreatureTypes && e.selfTarget && e.sourceId === permanent.id)) {
    pushEff('4', EFFECT_TYPE.ADD_TYPE, { gainsAllCreatureTypes: true },
      { appliesTo: null, scope: 'targeted', selfTarget: true },
      'Changeling — this permanent is every creature type.',
      { id: `${permanent.id}_eff_changeling` });
  }

  if (/loses? all creature types/i.test(oracle) && !_isLosesInActivatedAbility && !_losesCTInBasePTClause && !effects.some(e => e.params.losesAllCreatureTypes || e.params.losesAllCreatureTypesOnly)) {
    // Determine scope: self, enchanted/equipped, or targeted ("target X")
    const isSelfLose = /\b(this creature|this permanent|this card|this token|it)\s+loses? all creature types/i.test(oracle);
    const isEnchanted = /(?:enchanted|equipped)\s+(?:(?:non\w+\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle))\s+loses? all creature types/i.test(oracle);
    const isTargetedLose = /\btarget\s+\w+(?:\s+\w+)?\s+loses? all creature types/i.test(oracle);
    let losesAllCTAppliesTo = null;
    if (isTargetedLose) {
      const m = /\btarget\s+([\w][\w\s]*?(?=\s+loses?))/i.exec(oracle);
      if (m) losesAllCTAppliesTo = buildAppliesToFromText(m[1].trim()).fn;
    }
    pushEff('4', EFFECT_TYPE.REMOVE_TYPE, { losesAllCreatureTypesOnly: true },
      {
        appliesTo: losesAllCTAppliesTo,
        scope: (isSelfLose || isEnchanted || isTargetedLose) ? 'targeted' : 'global',
        selfTarget: isSelfLose || false,
      },
      `Loses all creature types.`,
      { targetRestriction: losesAllCTAppliesTo });
  }

  // ---- Layer 4: Type changes ----
  const addTypeRegex = /(?:^|[.;])\s*(?:all\s+|each\s+)?(.+?)\s+(?:you (?:control|own)\s+)?(?:are|is|have|has|becomes?)\s+(.+?)\s+in addition to (?:its|their) other\b.*?types/gmi;
  // skip-ranges merged with copyClauseSpans so other regex parsers don't refire
  // on already-consumed copy/except text.
  const addTypeMatchRanges = copyClauseSpans.slice();
  let addTypeMatch;
  while ((addTypeMatch = addTypeRegex.exec(oracle)) !== null) {
    // Skip matches that overlap a copy clause already consumed by copyRegex
    // (e.g. Mindlink Mech: "becomes a copy of …, except it is a vehicle artifact in
    // addition to its other types" — the type is added via copyParams, not a separate effect).
    const _atStart = addTypeMatch.index;
    const _atEnd = _atStart + addTypeMatch[0].length;
    if (copyClauseSpans.some(r => _atStart < r.end && _atEnd > r.start)) continue;
    const filterText = addTypeMatch[1].trim();
    const becomesText = addTypeMatch[2].trim();
    // Skip triggered/activated ability text that matched the regex
    const _atFLower = filterText.toLowerCase();
    if (_atFLower.includes('whenever ') || _atFLower.includes('when ') ||
        _atFLower.includes('if ') || _atFLower.length > 100) continue;
    // Skip if filterText doesn't reference permanents (e.g. "hand size", "life total")
    if (!filterReferencesPermanents(filterText)) continue;
    // Skip compound enchantment clauses (handled by enchant transform parser Fix 17)
    if (/(?:enchanted|equipped)\s+\w+\s+has\s+base\s+power|loses\s+all/i.test(filterText)) continue;
    // Skip "have base power and toughness X/Y and are [type]" — handled by generalBasePTRegex
    if (/\bhave\s+base\s+power\s+and\s+toughness\b/i.test(filterText)) continue;
    // Multiplayer: restore "you control" stripped by optional regex group
    let addTypeFilterText = filterText;
    if (/\byou (?:control|own)\b/i.test(addTypeMatch[0]) && !/\byou (?:control|own)\b/i.test(addTypeFilterText)) {
      addTypeFilterText += ' you control';
    }
    const { fn, desc, isSelf, isTargeted } = buildAppliesToFromText(addTypeFilterText);
    const selfAffect = detectSelfAffect(addTypeFilterText);
    // Strip quoted ability text from becomesText before parsing types
    // e.g. 'lifelink and "Other commanders you control get +2/+2 and have lifelink," and is a Performer'
    // -> 'lifelink and  and is a Performer' -> parseBecomesType only sees type words
    const cleanedBecomesText = becomesText.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/\s{2,}/g, ' ').trim();
    const parsed = parseBecomesType(cleanedBecomesText);
    addTypeMatchRanges.push({ start: addTypeMatch.index, end: addTypeMatch.index + addTypeMatch[0].length });
    const addTypeCond = _getConditionForPos(addTypeMatch.index);
    const addTypeEffCountBefore = effects.length;

    // Determine whether "in addition to" covers colors, types, or both.
    // "in addition to its other colors and types" → both added
    // "in addition to their other creature types" → only types added, colors are SET
    const fullAdditionText = addTypeMatch[0];
    const inAdditionClause = fullAdditionText.match(/in addition to (?:its|their) other\b(.*?)types/i);
    const additionCoversColors = inAdditionClause && /colors?\b/i.test(inAdditionClause[1]);

    // Assign a shared abilityGroupId (CR 613: all parts of the same effect apply together)
    const _addAbilityGroupId = `${permanent.id}_addType_${effects.length}`;

    // Also extract P/T from becomesText (e.g. "6/6 blue Leviathan creatures")
    const ptMatch = becomesText.match(/(\d+)\/(\d+)/);
    const _ctx = { isSelf, isTargeted, fn, selfAffect };
    if (ptMatch) {
      pushEff('7b', EFFECT_TYPE.SET_PT,
        { power: parseInt(ptMatch[1]), toughness: parseInt(ptMatch[2]) },
        _ctx,
        `${filterText} have base P/T ${ptMatch[1]}/${ptMatch[2]}. ${desc}`);
    }
    // "with power and toughness each equal to its mana value" (Opalescence, Starfield of Nyx)
    const afterMatchText = oracle.substring(addTypeMatch.index + addTypeMatch[0].length, oracle.indexOf('.', addTypeMatch.index + addTypeMatch[0].length) + 1) || '';
    const combinedMVText = becomesText + ' ' + afterMatchText;
    if (!ptMatch && /(?:base\s+)?power\s+and\s+(?:base\s+)?toughness\s+(?:each\s+)?equal\s+to\s+(?:its|their)\s+(?:mana\s+value|converted\s+mana\s+cost)/i.test(combinedMVText)) {
      pushEff('7b', EFFECT_TYPE.SET_PT, { useMV: true }, _ctx,
        `${filterText} have P/T equal to mana value. ${desc}`);
    }

    // Also extract colors from becomesText
    const addedColors = [];
    for (const [colorName, colorCode] of Object.entries(COLOR_NAMES)) {
      if (becomesText.toLowerCase().includes(colorName)) addedColors.push(colorCode);
    }
    if (addedColors.length > 0) {
      // "in addition to" covers colors → ADD; covers only types → SET.
      const colorEffectType = additionCoversColors ? EFFECT_TYPE.ADD_COLOR : EFFECT_TYPE.SET_COLOR;
      pushEff('5', colorEffectType, { colors: addedColors }, _ctx,
        `${filterText} become ${addedColors.join(', ')}. ${desc}`);
    }

    if (parsed.gainsAllLandTypes) {
      pushEff('4', EFFECT_TYPE.ADD_TYPE, { gainsAllLandTypes: true }, _ctx,
        `${filterText} are every land type. ${desc}`);
    } else if (parsed.gainsAllCreatureTypes) {
      pushEff('4', EFFECT_TYPE.ADD_TYPE, { gainsAllCreatureTypes: true }, _ctx,
        `${filterText} are every creature type. ${desc}`);
    } else if (parsed.types.length > 0 || parsed.subtypes.length > 0 || (parsed.supertypes && parsed.supertypes.length > 0)) {
      pushEff('4', EFFECT_TYPE.ADD_TYPE,
        { types: parsed.types, subtypes: parsed.subtypes, supertypes: parsed.supertypes || [] }, _ctx,
        `${filterText} are also ${becomesText}. ${desc}`);
    }

    // Handle "with [abilities]" from parseBecomesType
    if (parsed.grantedAbilities && parsed.grantedAbilities.length > 0) {
      if (parsed.grantedAbilities.includes('__NO_ABILITIES__')) {
        pushEff('6', EFFECT_TYPE.REMOVE_ABILITIES, {}, _ctx,
          `${filterText} lose all abilities. ${desc}`);
      } else {
        for (const ability of parsed.grantedAbilities) {
          pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability }, _ctx,
            `${filterText} gain ${ability}. ${desc}`);
        }
      }
    }

    // Parse "and has [abilities]" text that follows "in addition to its other types"
    // E.g., Bello: "...in addition to its other types and has indestructible, haste, and "...""
    const matchEndPos = addTypeMatch.index + addTypeMatch[0].length;
    const afterMatch = oracle.substring(matchEndPos);
    const andHasMatch = afterMatch.match(/^\s+and\s+(?:has|have|gains?)\s+(.+)/i);
    if (andHasMatch) {
      // Extend the match range to include the "and has..." text for overlap detection
      addTypeMatchRanges[addTypeMatchRanges.length - 1].end = matchEndPos + andHasMatch[0].length;
      const abilityText = andHasMatch[1].trim().replace(/\.\s*$/, '');
      // Extract quoted abilities
      const quotedAbilities = [];
      let cleanText = abilityText.replace(/[""\u201c]((?:[^""\u201d]|'(?!(?:\s|$|,)))*)[""\u201d]/g, (m, inner) => {
        quotedAbilities.push(inner.trim());
        return '';
      });
      // Parse keyword abilities. Use the canonical KEYWORD_SET (module scope).
      const kwParts = cleanText.toLowerCase().trim()
        .replace(/^(?:,\s*)?(?:and\s+)?/, '')
        .split(/,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);
      const parsedKws = [];
      for (const part of kwParts) {
        if (KEYWORD_SET.has(part)) {
          parsedKws.push(part.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
        } else {
          // Parameterized: "ward {2}", "toxic 1"
          const pm = part.match(/^(\w+(?:\s+\w+)?)\s+(.+)$/);
          if (pm && KEYWORD_SET.has(pm[1])) {
            parsedKws.push(pm[1].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') + ' ' + pm[2]);
          }
        }
      }
      const allAbilities = [...parsedKws, ...quotedAbilities];
      for (const ability of allAbilities) {
        pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability }, _ctx,
          `${filterText} gain ${ability}. ${desc}`);
      }
    }

    // Attach "as long as" condition to all effects generated from this addType match
    if (addTypeCond) {
      for (let ei = addTypeEffCountBefore; ei < effects.length; ei++) {
        effects[ei].asLongAsCondition = addTypeCond;
      }
    }
    // CR 613: Tag all effects from this ability with a shared group ID
    for (let ei = addTypeEffCountBefore; ei < effects.length; ei++) {
      effects[ei].abilityGroupId = _addAbilityGroupId;
    }
  }

  const setTypeRegex = /(?:^|[.;])\s*(?:all\s+|each\s+)?(.+?)\s+(?:you (?:control|own)\s+)?(?:are|is|becomes?)\s+(.+?)(?:\.|$)/gmi;
  let setTypeMatch;
  while ((setTypeMatch = setTypeRegex.exec(oracle)) !== null) {
    const mStart = setTypeMatch.index;
    const mEnd = mStart + setTypeMatch[0].length;
    const overlaps = addTypeMatchRanges.some(r => mStart < r.end && mEnd > r.start);
    if (overlaps) continue;

    const filterText = setTypeMatch[1].trim();
    let becomesText = setTypeMatch[2].trim();
    if (becomesText.toLowerCase().includes('in addition to')) continue;

    // Fix: Extract trailing "and have base power and toughness X/Y" before skipWords check.
    // Cards like Kudo: "Other creatures you control are Bears and have base power and toughness 2/2."
    let trailingBasePT = null;
    const basePTSplit = becomesText.match(/^(.+?)\s+and\s+have\s+(?:base\s+)?power\s+and\s+toughness\s+(\d+)\/(\d+)/i);
    if (basePTSplit) {
      becomesText = basePTSplit[1].trim();
      trailingBasePT = { power: parseInt(basePTSplit[2]), toughness: parseInt(basePTSplit[3]) };
    }
    // Fix: Extract "with [base] power and toughness X/Y" (e.g., "a Bear with base power and toughness 4/2")
    if (!trailingBasePT) {
      const withPTSplit = becomesText.match(/^(.+?)\s+with\s+(?:base\s+)?power\s+and\s+toughness\s+(\d+)\/(\d+)/i);
      if (withPTSplit) {
        becomesText = withPTSplit[1].trim();
        trailingBasePT = { power: parseInt(withPTSplit[2]), toughness: parseInt(withPTSplit[3]) };
      }
    }
    // Fix: Extract "with power and toughness each equal to its mana value/converted mana cost"
    // (March of the Machines, Opalescence, Starfield of Nyx, etc.)
    let useManaValue = false;
    if (!trailingBasePT) {
      const mvPTSplit = becomesText.match(/^(.+?)\s+with\s+(?:base\s+)?power\s+and\s+(?:base\s+)?toughness\s+(?:each\s+)?equal\s+to\s+(?:its|their)\s+(?:mana\s+value|converted\s+mana\s+cost)/i);
      if (mvPTSplit) {
        becomesText = mvPTSplit[1].trim();
        useManaValue = true;
      }
    }
    // Also handle trailing "and have/has power and toughness each equal to its mana value"
    if (!trailingBasePT && !useManaValue) {
      const trailingMVSplit = becomesText.match(/^(.+?)\s+and\s+(?:have|has)\s+(?:base\s+)?power\s+and\s+(?:base\s+)?toughness\s+(?:each\s+)?equal\s+to\s+(?:its|their)\s+(?:mana\s+value|converted\s+mana\s+cost)/i);
      if (trailingMVSplit) {
        becomesText = trailingMVSplit[1].trim();
        useManaValue = true;
      }
    }

    // Strip "until end of turn" / "until your next turn" duration clauses from becomesText.
    // Without this, "creature until end of turn" adds "Until", "End", "Turn" as fake subtypes.
    becomesText = becomesText.replace(/\s+until\s+(?:end\s+of\s+(?:turn|combat|your\s+next\s+turn)|your\s+next\s+turn|the\s+end\s+of\s+(?:turn|combat)|beginning\s+of\s+(?:your|their)\s+next\s+\w+)/i, '').trim();

    // Strip trailing "and gets +X/+Y" (e.g. "becomes green and gets +1/+0") so the "get" skip-word
    // doesn't abort the whole match. The boost itself is handled separately by boostRegex.
    becomesText = becomesText.replace(/\s+and\s+gets?\s+[+-]\d+\/[+-]\d+/i, '').trim();

    // Extract "that's still a [type]" / "that is still a [type]" clauses (Gideon Blackblade pattern)
    // These indicate types to preserve (ADD_TYPE rather than losing them)
    const _stKeepTypes = [];
    const stillMatch = becomesText.match(/\s+that(?:'s| is)\s+still\s+(?:a\s+|an\s+)?(.+)$/i);
    if (stillMatch) {
      becomesText = becomesText.slice(0, becomesText.length - stillMatch[0].length).trim();
      const stillTypes = parseBecomesType(stillMatch[1]);
      _stKeepTypes.push(...stillTypes.types);
    }
    // Broad oracle-level scan for "still a/an [type]" — catches follow-up sentences with any
    // phrasing: "It's still a land.", "It is still a land.", "that's still a creature.", etc.
    // Handles contractions and sentence-boundary variations that inline regexes miss.
    if (_stKeepTypes.length === 0) {
      for (const m of oracle.matchAll(/\bstill\s+(?:a\s+|an\s+)?(\w+)/gi)) {
        const _sp = parseBecomesType(m[1]);
        _stKeepTypes.push(..._sp.types.filter(t => !_stKeepTypes.includes(t)));
      }
    }

    // Extract "with [keyword ability]" clauses from becomesText (e.g. "with indestructible", "with hexproof")
    // These are abilities to grant, not type-change text. Strip before skipWords check.
    const _stGrantAbilities = [];
    const KEYWORD_ABILITIES = ['deathtouch','defender','double strike','first strike','flash',
      'flying','haste','hexproof','indestructible','lifelink','menace','prowess',
      'reach','shroud','trample','vigilance','ward','fear','intimidate','shadow',
      'horsemanship','flanking','phasing','protection','banding','wither','infect',
      'undying','persist'];
    const withKWMatch = becomesText.match(/\s+with\s+(.+)$/i);
    if (withKWMatch) {
      const withText = withKWMatch[1].trim();
      // Check if the "with" clause contains keyword abilities (not "with power and toughness")
      const withWords = withText.toLowerCase().split(/\s+and\s+|\s*,\s*/);
      const foundKWs = withWords.filter(w => KEYWORD_ABILITIES.includes(w.trim()));
      if (foundKWs.length > 0) {
        becomesText = becomesText.slice(0, becomesText.length - withKWMatch[0].length).trim();
        _stGrantAbilities.push(...foundKWs.map(k => k.trim()));
      }
    }

    // Extract "and has/gains [ability]" or "and this card/creature has [ability]" trailing clauses
    const andHasMatch = becomesText.match(/\s+and\s+(?:(?:this\s+(?:card|creature|permanent|token)\s+)?(?:has|gains?|have))\s+(.+)$/i);
    if (andHasMatch && !andHasMatch[0].toLowerCase().includes('power and toughness')) {
      const abilText = andHasMatch[1].trim();
      const abilWords = abilText.toLowerCase().split(/\s+and\s+|\s*,\s*/);
      const foundAbils = abilWords.filter(w => KEYWORD_ABILITIES.includes(w.trim()));
      if (foundAbils.length > 0) {
        becomesText = becomesText.slice(0, becomesText.length - andHasMatch[0].length).trim();
        _stGrantAbilities.push(...foundAbils.map(k => k.trim()));
      }
    }

    // Extract "with equip {N}[ and "[ability]",][ where N is [source] mana value]"
    // This is the Bludgeon Brawl pattern: grants equip with cost = mana value,
    // plus an optional quoted ability (e.g. "Equipped creature gets +1/+0,").
    // Must be stripped before the skipWords check (blocks on "equipped"/"mana"/"cost"/etc.).
    let _stEquipManaValue = false;
    let _stEquipGrantedAbility = null; // the quoted ability text, with variable substituted
    const equipMVMatch = becomesText.match(
      /\s+with\s+equip\s+\{[^}]*\}(?:\s+and\s+([\u201c"][^\u201d"]*[\u201d"]))?[\s,]*(?:where\s+(\S+)\s+is\s+(?:its|that\s+[a-z]+(?:'s|s)?)\s+(?:mana\s+value|converted\s+mana\s+cost))?/i
    );
    if (equipMVMatch) {
      becomesText = becomesText.slice(0, becomesText.length - equipMVMatch[0].length).trim();
      _stEquipManaValue = true;
      // Capture the quoted ability (e.g. "Equipped creature gets +1/+0,") and replace
      // the numeric variable with "{mana value}" so it reads correctly regardless of cost.
      if (equipMVMatch[1]) {
        const varName = equipMVMatch[2] || '1'; // the variable token (e.g. "1" or "X")
        const varEscaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const raw = equipMVMatch[1].replace(/^[\u201c"]|[\u201d",]+$/g, '').trim();
        _stEquipGrantedAbility = raw.replace(new RegExp(`\\+${varEscaped}/`, 'g'), '+{mana value}/')
                                    .replace(new RegExp(`\\+${varEscaped}$`, 'g'), '+{mana value}');
      }
    }

    const skipWords = ['power', 'toughness', 'p/t', 'base', 'equal', 'unblockable',
      'indestructible', 'hexproof', 'lose', 'gain', 'get', 'put', 'draw',
      'counter', 'target', 'return', 'destroy', 'exile', 'sacrifice',
      'tap', 'untap', 'enters', 'leaves', 'dealt', 'damage', 'life',
      'mana', 'pay', 'cost', 'less', 'more', 'chosen', 'whenever',
      'enchanted', 'equipped', 'attached', 'control', 'own', 'cast',
      'each other', 'affected', 'able', 'unable', 'can\'t', 'don\'t',
      'may', 'must', 'would', 'could', 'should', 'if ', 'when ',
      'attacking', 'blocking', 'tapped', 'untapped', 'face',
      'increased', 'reduced', 'decreased', 'maximum', 'minimum',
      'number', 'total', 'amount', 'size', 'hand', 'library',
      'graveyard', 'revealed', 'discarded', 'prevent', 'instead'];
    const bLower = becomesText.toLowerCase();
    if (skipWords.some(w => bLower.includes(w))) continue;

    const fLower = filterText.toLowerCase();
    if (fLower.includes('if ') || fLower.includes('when ') || fLower.includes('whenever ') ||
        fLower.includes('that ') || (fLower.includes('with ') && !/\bwith\s+(?:a|an)?\s*[\w+/]+\s+counters?\s+on\b/i.test(fLower)) || fLower.includes('enchanted') ||
        fLower.includes('equipped') || fLower.includes('opponent') || fLower.includes('player') ||
        fLower.includes('hand') || fLower.includes('library') || fLower.includes('graveyard') ||
        fLower.includes('life') || fLower.includes('spell') || fLower.length > 80) continue;

    // Skip if filterText doesn't reference permanents (e.g. "hand size", "life total")
    if (!filterReferencesPermanents(filterText)) continue;

    // "It is still a [type]." is a continuation sentence for enchantTransformRegex aura/equip effects.
    // Parsing it here would generate a selfTarget SET_TYPE on the source aura itself (wrong).
    // enchantTransformRegex already merges "It is/has..." continuations and handles them correctly.
    if (/^it$/i.test(filterText) && /\bstill\b/i.test(becomesText)) continue;

    // Fix: Handle "X loses all abilities and is Y" pattern (e.g. Titania's Song).
    // The setTypeRegex lazily matches the first standalone "is", so filterText becomes
    // "noncreature artifact loses all abilities and" instead of "noncreature artifact".
    // Strip the "loses ... and" suffix to recover the actual subject filter.
    let _stSubjectText = filterText;
    const losesAbilitiesAndMatch = filterText.match(/^(.+?)\s+loses\s+all\s+(?:its\s+)?abilities\s+and\s*$/i);
    if (losesAbilitiesAndMatch) {
      _stSubjectText = losesAbilitiesAndMatch[1].trim();
    }

    // Strip leading "Until [duration], " so "until your next turn, up to one target X becomes"
    // correctly identifies the "target" keyword (e.g. Karn, the Great Creator +1 ability).
    _stSubjectText = _stSubjectText.replace(
      /^until\s+(?:end\s+of\s+(?:turn|combat)|your\s+next\s+turn|the\s+end\s+of\s+(?:turn|combat)|beginning\s+of\s+(?:your|their)\s+next\s+\w+)[,\s]+/i,
      ''
    ).trim();

    // Multiplayer: restore "you control" stripped by optional regex group
    if (/\byou (?:control|own)\b/i.test(setTypeMatch[0]) && !/\byou (?:control|own)\b/i.test(_stSubjectText)) {
      _stSubjectText += ' you control';
    }
    const { fn, desc, isSelf, isTargeted } = buildAppliesToFromText(_stSubjectText);
    const _stTargetRestriction = isTargeted ? fn : null;
    const selfAffect = isSelf ? true : detectSelfAffect(_stSubjectText);
    const _stScope = (isSelf || isTargeted) ? 'targeted' : 'global';
    const _stAppliesTo = (isSelf || isTargeted) ? null : fn;
    const _stSelfTarget = isSelf || false;

    // Assign a shared abilityGroupId so the engine knows all these effects are part of the
    // same ability. CR 613: once any part of a continuous effect applies to a permanent,
    // all other parts of that same effect also apply to that permanent.
    const _stAbilityGroupId = `${permanent.id}_setType_${effects.length}`;

    // "is not a creature" / "isn't a creature" → REMOVE_TYPE instead of SET_TYPE
    const notATypeMatch = becomesText.match(/^not\s+(?:a\s+)?(.+)$/i);
    if (notATypeMatch) {
      const notParsed = parseBecomesType(notATypeMatch[1]);
      if (notParsed.types.length > 0) {
        const setTypeCond = _getConditionForPos(setTypeMatch.index);
        const eff = pushEff('4', EFFECT_TYPE.REMOVE_TYPE,
          { types: notParsed.types },
          { appliesTo: _stAppliesTo, scope: _stScope, selfTarget: _stSelfTarget, affectsSelf: selfAffect },
          `${filterText} is not a ${notParsed.types.join(', ')}. ${desc}`);
        if (setTypeCond) eff.asLongAsCondition = setTypeCond;
        if (_stTargetRestriction) eff.targetRestriction = _stTargetRestriction;
        continue;
      }
    }

    const parsed = parseBecomesType(becomesText);
    const _hasColorOnly = /\b(white|blue|black|red|green|colorless)\b/i.test(becomesText);
    if (parsed.types.length === 0 && parsed.subtypes.length === 0 &&
        !parsed.gainsAllLandTypes && !parsed.gainsAllCreatureTypes && !_hasColorOnly) continue;
    const setTypeCond = _getConditionForPos(setTypeMatch.index);
    const setTypeEffCountBefore = effects.length;

    const filterClean = _stSubjectText.toLowerCase().replace(/^(?:all|each|other)\s+/, '').replace(/\s+you control$/, '');
    const filterTypeInfo = normalizeTypeWord(filterClean);

    // Pre-compute the card types required by the filter — used in multiple branches below.
    const filterWords = filterClean.replace(/^non-?\w+,?\s*/, '').split(/\s+/);
    const filterTypes = [];
    for (const fw of filterWords) {
      const fti = normalizeTypeWord(fw);
      if (fti && fti.check === 'type') filterTypes.push(fti.value);
    }

    const _stCtx = { appliesTo: _stAppliesTo, scope: _stScope, selfTarget: _stSelfTarget, affectsSelf: selfAffect };
    if (parsed.gainsAllLandTypes) {
      pushEff('4', EFFECT_TYPE.ADD_TYPE, { gainsAllLandTypes: true }, _stCtx,
        `${filterText} are every land type. ${desc}`);
    } else if (parsed.gainsAllCreatureTypes) {
      // The standalone self/targeted "all creature types" parser above already emits the
      // correctly-scoped effect for self subjects (e.g. Undercover Skrull's compound
      // "this creature gets +2/+2 and is all creature types"). Skip here to avoid a second
      // effect built from the lazily-captured (malformed) subject filter.
      if (effects.some(e => e.params && e.params.gainsAllCreatureTypes && e.sourceId === permanent.id)) continue;
      pushEff('4', EFFECT_TYPE.ADD_TYPE, { gainsAllCreatureTypes: true }, _stCtx,
        `${filterText} are every creature type. ${desc}`);
    } else if (filterTypeInfo && filterTypeInfo.check === 'type' && parsed.isLandSubtype) {
      const category = filterTypeInfo.value.toLowerCase();
      pushEff('4', EFFECT_TYPE.SET_TYPE,
        { subtypes: parsed.subtypes, replaceSubtypeCategory: category, keepSupertypes: true, keepTypes: true },
        _stCtx, `${filterText} are ${becomesText}. ${desc}`);
    } else if (parsed.isLandSubtype && !filterTypeInfo) {
      pushEff('4', EFFECT_TYPE.SET_TYPE,
        { subtypes: parsed.subtypes, replaceSubtypeCategory: 'land', keepSupertypes: true, keepTypes: true },
        _stCtx, `${filterText} are ${becomesText}. ${desc}`);
    } else if (parsed.types.length === 0 && parsed.subtypes.length > 0) {
      // Subtype-only: replace creature subtypes — unless filter restricts to a non-creature
      // card type, in which case ADD_TYPE (Bludgeon Brawl: add Equipment without wiping).
      const filterHasNonCreatureType = filterTypes.some(
        ft => ft !== 'Creature' && ['Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].includes(ft)
      );
      if (filterHasNonCreatureType || _stEquipManaValue) {
        pushEff('4', EFFECT_TYPE.ADD_TYPE, { subtypes: parsed.subtypes }, _stCtx,
          `${filterText} gain subtype ${parsed.subtypes.join(', ')}. ${desc}`,
          { abilityGroupId: _stAbilityGroupId });
      } else {
        pushEff('4', EFFECT_TYPE.SET_TYPE,
          { subtypes: parsed.subtypes, replaceSubtypeCategory: 'creature', keepSupertypes: true, keepTypes: true },
          _stCtx, `${filterText} are ${becomesText}. ${desc}`);
      }
    } else if (_stKeepTypes.length > 0) {
      // "still a [type]" — ADD_TYPE preserving existing types/subtypes.
      const allTypes = [...new Set([...parsed.types, ..._stKeepTypes])];
      _stKeepTypes.length = 0; // mark as merged so the legacy safety push below doesn't duplicate
      pushEff('4', EFFECT_TYPE.ADD_TYPE,
        { types: allTypes, subtypes: parsed.subtypes }, _stCtx,
        `${filterText} are ${becomesText}. ${desc}`);
    } else {
      // Filter "noncreature artifact" + becomes "artifact creature" → ADD_TYPE for new types only.
      const newTypes = parsed.types.filter(t => !filterTypes.includes(t));
      if (filterTypes.length > 0 && newTypes.length > 0 && filterTypes.every(ft => parsed.types.includes(ft))) {
        pushEff('4', EFFECT_TYPE.ADD_TYPE,
          { types: newTypes, subtypes: parsed.subtypes }, _stCtx,
          `${filterText} are ${becomesText}. ${desc}`);
      } else if (parsed.types.length > 0 || parsed.subtypes.length > 0) {
        // Skip emission when both arrays empty — color-only "becomes green" is handled by SET_COLOR below.
        pushEff('4', EFFECT_TYPE.SET_TYPE,
          { types: parsed.types, subtypes: parsed.subtypes, keepSupertypes: true }, _stCtx,
          `${filterText} are ${becomesText}. ${desc}`);
      }
    }

    // "loses all [its] abilities and is ..." → Layer 6 REMOVE_ABILITIES on the same subject.
    if (losesAbilitiesAndMatch) {
      pushEff('6', EFFECT_TYPE.REMOVE_ABILITIES, {}, _stCtx,
        `${_stSubjectText} loses all abilities. ${desc}`);
    }

    // P/T from "are X/Y ..." (set variant, no "in addition to")
    const setPtMatch = becomesText.match(/(\d+)\/(\d+)/);
    if (setPtMatch) {
      pushEff('7b', EFFECT_TYPE.SET_PT,
        { power: parseInt(setPtMatch[1]), toughness: parseInt(setPtMatch[2]) }, _stCtx,
        `${filterText} have base P/T ${setPtMatch[1]}/${setPtMatch[2]}. ${desc}`);
    }

    // Trailing "and have base power and toughness X/Y" (Kudo pattern)
    if (trailingBasePT) {
      pushEff('7b', EFFECT_TYPE.SET_PT,
        { power: trailingBasePT.power, toughness: trailingBasePT.toughness }, _stCtx,
        `${filterText} have base P/T ${trailingBasePT.power}/${trailingBasePT.toughness}. ${desc}`);
    }

    // "with/and power and toughness each equal to its mana value" (March of the Machines)
    if (useManaValue) {
      pushEff('7b', EFFECT_TYPE.SET_PT, { useMV: true }, _stCtx,
        `${filterText} have P/T equal to mana value. ${desc}`);
    }

    // Bludgeon Brawl: "is an Equipment with equip {X}[ and "ability"], where X is its mana value"
    if (_stEquipManaValue) {
      pushEff('6', EFFECT_TYPE.ADD_ABILITY,
        { ability: 'Equip {X}', xSource: 'target_mana_value' }, _stCtx,
        `${filterText} gain equip {mana value}. ${desc}`,
        { abilityGroupId: _stAbilityGroupId });
      if (_stEquipGrantedAbility) {
        pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability: _stEquipGrantedAbility }, _stCtx,
          `${filterText} gain "${_stEquipGrantedAbility}". ${desc}`,
          { abilityGroupId: _stAbilityGroupId });
      }
    }

    // Colors from "are ... [color] ..." — ADD if "still" preserves prior types, else SET.
    const setColors = [];
    for (const [colorName, colorCode] of Object.entries(COLOR_NAMES)) {
      if (becomesText.toLowerCase().includes(colorName)) setColors.push(colorCode);
    }
    if (setColors.length > 0) {
      const colorEffectType = _stKeepTypes.length > 0 ? EFFECT_TYPE.ADD_COLOR : EFFECT_TYPE.SET_COLOR;
      pushEff('5', colorEffectType, { colors: setColors }, _stCtx,
        `${filterText} become ${setColors.join(', ')}. ${desc}`);
    } else if (becomesText.toLowerCase().includes('colorless')) {
      pushEff('5', EFFECT_TYPE.SET_COLOR, { colors: [] }, _stCtx,
        `${filterText} become colorless. ${desc}`);
    }

    // "with [abilities]" from parseBecomesType
    if (parsed.grantedAbilities && parsed.grantedAbilities.length > 0) {
      if (parsed.grantedAbilities.includes('__NO_ABILITIES__')) {
        pushEff('6', EFFECT_TYPE.REMOVE_ABILITIES, {}, _stCtx,
          `${filterText} lose all abilities. ${desc}`);
      } else {
        for (const ability of parsed.grantedAbilities) {
          pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability }, _stCtx,
            `${filterText} gain ${ability}. ${desc}`);
        }
      }
    }

    // "that's still a [type]" → ADD_TYPE preserving the type (Gideon: "still a planeswalker")
    if (_stKeepTypes.length > 0) {
      pushEff('4', EFFECT_TYPE.ADD_TYPE,
        { types: _stKeepTypes, subtypes: [] }, _stCtx,
        `${filterText} is still a ${_stKeepTypes.join(', ')}. ${desc}`);
    }

    // "with [keyword]" / "and has [keyword]" → ADD_ABILITY
    if (_stGrantAbilities.length > 0) {
      for (const ability of _stGrantAbilities) {
        pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability }, _stCtx,
          `${filterText} gains ${ability}. ${desc}`);
      }
    }

    // Attach "as long as" condition to all effects generated from this setType match
    if (setTypeCond) {
      for (let ei = setTypeEffCountBefore; ei < effects.length; ei++) {
        effects[ei].asLongAsCondition = setTypeCond;
      }
    }
    // CR 613: Tag all effects from this ability with a shared group ID so the engine
    // knows they are part of the same continuous effect. Once any part applies to a
    // permanent in its first layer, all subsequent parts also apply to that permanent.
    for (let ei = setTypeEffCountBefore; ei < effects.length; ei++) {
      effects[ei].abilityGroupId = _stAbilityGroupId;
      if (_stTargetRestriction && effects[ei].scope === 'targeted' && !effects[ei].targetRestriction) {
        effects[ei].targetRestriction = _stTargetRestriction;
      }
    }
  }

  // ---- "[subject] isn't a [type/subtype]" → REMOVE_TYPE (layer 4) ----
  // Handles standalone "this creature isn't a Human" and compound activated-ability forms like
  // "this creature has base P/T 5/3, gains trample, and isn't a Human."
  {
    const isntTypeRegex = /(?:^|[.;])\s*(.+?)\s+isn't\s+(?:a\s+|an\s+)?(\w+)/gmi;
    let isntMatch;
    while ((isntMatch = isntTypeRegex.exec(oracle)) !== null) {
      if (_isInActivatedEffect(isntMatch.index)) continue;
      let isntFilter = isntMatch[1].trim();
      const isntWord = isntMatch[2];
      // Skip state-based words that are not card types/subtypes
      if (/^(?:monstrous|saddled|crewed|tapped|attacking|blocking|still|legendary|basic|snow|world)\b/i.test(isntWord)) continue;
      // Strip leading duration prefix
      isntFilter = stripDurationPrefix(isntFilter);
      // Strip "has base power and toughness X/Y[,]" clause (compound activated-ability pattern)
      isntFilter = isntFilter.replace(/\s+has\s+base\s+power\s+and\s+toughness\s+\d+\/\d+\s*,?\s*/i, ' ');
      // Strip ", gains [keywords], and" trailing clause
      isntFilter = isntFilter.replace(/\s+gains?\s+[^,]+,\s+and\s*$/i, '');
      isntFilter = isntFilter.replace(/\s+and\s*$/i, '').trim();
      if (!isntFilter || !filterReferencesPermanents(isntFilter)) continue;
      const isntParsed = parseBecomesType(isntWord);
      if (isntParsed.types.length === 0 && isntParsed.subtypes.length === 0) continue;
      const isntApplies = buildAppliesToFromText(isntFilter);
      const isntSelf = isntApplies.isSelf ? true : detectSelfAffect(isntFilter);
      const isntScope = (isntApplies.isSelf || isntApplies.isTargeted) ? 'targeted' : 'global';
      const isntAppliesTo = (isntApplies.isSelf || isntApplies.isTargeted) ? null : isntApplies.fn;
      const isntSelfTarget = isntApplies.isSelf || false;
      const isntCond = _getConditionForPos(isntMatch.index);
      const eff = pushEff('4', EFFECT_TYPE.REMOVE_TYPE,
        { types: isntParsed.types, subtypes: isntParsed.subtypes },
        { appliesTo: isntAppliesTo, scope: isntScope, selfTarget: isntSelfTarget, affectsSelf: isntSelf },
        `${isntFilter} isn't a ${isntWord}. ${isntApplies.desc}`);
      if (isntCond) eff.asLongAsCondition = isntCond;
    }
  }

  // ---- Theros Gods: "As long as your devotion to [color] is less than [N], ~ isn't a creature" ----
  // Single color: "devotion to [color] is less than [N]"
  // Dual color: "devotion to [color] and [color] is less than [N]"
  // Scryfall uses word-form numbers (five, seven, etc.) — uses module-scope WORD_TO_NUM.
  const devotionRegex = /as long as your devotion to (\w+)(?:\s+and\s+(\w+))?\s+is less than (\w+)/i;
  const devotionMatch = oracle.match(devotionRegex);
  if (devotionMatch) {
    const color1 = COLOR_NAMES[devotionMatch[1].toLowerCase()] || null;
    const color2 = devotionMatch[2] ? (COLOR_NAMES[devotionMatch[2].toLowerCase()] || null) : null;
    const thresholdRaw = devotionMatch[3].toLowerCase();
    const threshold = WORD_TO_NUM[thresholdRaw] !== undefined ? WORD_TO_NUM[thresholdRaw] : parseInt(thresholdRaw) || 5;
    if (color1) {
      pushEff('4', EFFECT_TYPE.REMOVE_TYPE,
        { types: ['Creature'], devotionCondition: { colors: color2 ? [color1, color2] : [color1], threshold } },
        { appliesTo: null, scope: 'targeted', selfTarget: true },
        `Not a creature unless devotion to ${devotionMatch[1]}${color2 ? ' and ' + devotionMatch[2] : ''} is ${threshold}+.`);
    }
  }

  // ---- Layer 7c: P/T modification ----
  // Standard: "[filter] get +X/+Y"
  // Anchor also matches after ", and " / " and " to catch compound sentences like
  // "red creatures get +2/+0 and white creatures get +0/+2" (e.g. Agrus Kos).
  const boostRegex = /(?:^|\.|,?\s+and\s+)\s*(.+?)\s+(?:you (?:control|own)\s+)?get[s]?\s+([+-]\d+)\/([+-]\d+)/gmi;
  let boostMatch;
  while ((boostMatch = boostRegex.exec(oracle)) !== null) {
    let filterText = boostMatch[1].trim();
    // Fix: If the regex matched across sentence boundaries (filter contains "."),
    // use only the last sentence segment as the actual filter text.
    if (filterText.includes('.')) {
      const segments = filterText.split(/\.\s*/);
      filterText = segments[segments.length - 1].trim();
      // "Untap target creature. It gets +3/+3" — resolve "It" pronoun to "target [type]"
      // from the prior sentence, mirroring the same resolution in haveAbilityRegex.
      if (/^it$/i.test(filterText) && segments.length >= 2) {
        const prevSeg = segments[segments.length - 2].trim();
        const tRef = prevSeg.match(/(?:^(?:choose\s+(?:a|an|one)|target)|\btarget)\s+([\w][\w\s]*?)(?:\s+you\s+(?:control|own))?$/i);
        if (tRef) filterText = 'target ' + tRef[1].trim();
      }
      if (!filterText) continue;
    }
    // Fix: Strip a leading ability-word prefix ("Animal May-Ham — Other Spiders … get +1/+1").
    // Ability words are title-case flavor phrases followed by an em/en-dash and have no rules
    // meaning (CR 207.2c); without stripping, "Animal May-Ham —" bleeds into the first subtype.
    // Guarded to title-case words only so it never strips saga chapters ("I — ") or "Choose one —".
    filterText = filterText.replace(/^[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*\s+[—–]\s+/, '').trim();
    // Fix: Strip trailing "gains [ability] and" artifact from "[filter] gains [ability] and gets [PT]" patterns.
    // The boostRegex captures everything before "gets", so "gains trample and" bleeds into the filter.
    filterText = filterText.replace(/\s+gains?\s+[\w\s]+?\s+and\s*$/i, '').trim();
    // Fix: Strip trailing "becomes [word(s)] and" from "[filter] becomes [color/type] and gets [PT]".
    // e.g. "Target creature becomes green and gets +1/+0" → filterText "Target creature becomes green and"
    // → strip → "Target creature". Without this, the filter requires a "Becomes" creature subtype.
    filterText = filterText.replace(/\s+becomes?\s+[\w\s]+?\s+and\s*$/i, '').trim();
    if (!filterText) continue;
    // Multiplayer: The optional "you control" group in boostRegex strips "you control" from group 1.
    // Re-append it so buildAppliesToFromText can apply the controller filter wrapper.
    if (/\byou (?:control|own)\b/i.test(boostMatch[0]) && !/\byou (?:control|own)\b/i.test(filterText)) {
      filterText += ' you control';
    }
    // Skip if filterText doesn't reference permanents
    if (!filterReferencesPermanents(filterText)) continue;
    // Skip if the filter contains a quote — it matched inside a quoted ability string
    // (e.g. a saga chapter: 'II — This Saga gains "{2}, {T}: Create…" token gets +1/+1').
    if (filterText.includes('"')) continue;
    // The regex prefix `(?:^|\.|,?\s+and\s+)` makes boostMatch.index point at the
    // delimiter that ENDS the previous sentence (e.g. the period closing a triggered
    // line above). Using that raw index for the line-based guards below would test the
    // wrong (often triggered) line — e.g. Mantle of the Ancients' static boost sitting
    // on its own line right after a "When this Aura enters, …" trigger. Recompute the
    // start of the sentence that actually contains the "+N/+N", from the match end.
    const _boostEnd = boostMatch.index + boostMatch[0].length;
    const _boostSentPos = Math.max(
      oracle.lastIndexOf('.', _boostEnd - 1),
      oracle.lastIndexOf('\n', _boostEnd - 1)
    ) + 1;
    // Skip if this match falls inside a triggered-ability sentence ("Whenever/When/At...").
    // e.g. "Whenever Agrus Kos attacks, attacking red creatures get +2/+0 and attacking
    // white creatures get +0/+2" — both "get" clauses are part of the trigger, not static
    // continuous effects. The trigger's pseudo-permanent parses them correctly on activation.
    if (_isInTriggeredSentence(_boostSentPos)) continue;
    // Skip matches inside the effect portion of an activated ability ("{cost}: ...")
    if (_isInActivatedEffect(_boostSentPos)) continue;
    const boostMatchCond = _getConditionForPos(_boostSentPos);
    const boostEffCountBefore = effects.length;
    const fullSentence = oracle.substring(boostMatch.index, oracle.indexOf('.', boostMatch.index + boostMatch[0].length) + 1) || boostMatch[0];
    const { fn, desc, isSelf, isTargeted, needsTargetSelection, maxTargets: _maxTgts, isTargetPlayerControl: _boostTPC } = buildAppliesToFromText(filterText);
    const _buildResult = { isSpellTarget: !!needsTargetSelection, maxTargets: _maxTgts || 1, isTargetPlayerControl: !!_boostTPC };
    const _needsTarget = isTargeted;
    const selfAffect = isSelf ? true : detectSelfAffect(filterText);

    // Recipients of this boost. Normally a single filter, but a bestow conjunction —
    // "This creature and enchanted creature each get +X/+X" (Nighthowler) — must be treated as a
    // pure SELF boost, not a combined OR filter. buildAppliesToFromText would OR "this creature"
    // (fn:()=>true) with "enchanted creature", producing a filter that matches EVERY permanent and
    // leaks the boost onto the whole board. A self boost is correct for both states: while a
    // creature on the battlefield it boosts only itself; once bestowed, engine-layer's bestow
    // redirect (CR 702.102) moves the self-target effect onto the enchanted creature automatically.
    let recipients = [{ isSelf, isTargeted: _needsTarget, fn, selfAffect, build: _buildResult, desc }];
    const _conjMatch = filterText.match(/^(.+?)\s+and\s+(.+?)$/i);
    if (_conjMatch) {
      const _pa = buildAppliesToFromText(_conjMatch[1].trim().replace(/\s+each$/i, ''));
      const _pb = buildAppliesToFromText(_conjMatch[2].trim().replace(/\s+each$/i, ''));
      const _selfPart = _pa.isSelf ? _pa : (_pb.isSelf ? _pb : null);
      const _enchPart = _pa.isTargeted ? _pa : (_pb.isTargeted ? _pb : null);
      if (_selfPart && _enchPart && _selfPart !== _enchPart) {
        recipients = [
          { isSelf: true, isTargeted: false, fn: _selfPart.fn, selfAffect: true,
            build: { isSpellTarget: false, maxTargets: 1 }, desc: _selfPart.desc },
        ];
      }
    }

    // Check for "for each [thing]" pattern — make it a CDA with auto-compute
    const forEachMatch = fullSentence.match(/for each\s+(.+?)(?:\.|$)/i);
    const _emitBoostFor = (rcpt) => {
      const _ctx = { isSelf: rcpt.isSelf, isTargeted: rcpt.isTargeted, fn: rcpt.fn, selfAffect: rcpt.selfAffect };
      if (forEachMatch) {
        let countTarget = forEachMatch[1].trim().replace(/\.$/, '');
        // Parse max cap: "to a maximum of N"
        let maxCount = undefined;
        const maxMatch = countTarget.match(/,?\s*to a maximum of (\d+)/i);
        if (maxMatch) {
          maxCount = parseInt(maxMatch[1]);
          countTarget = countTarget.replace(/,?\s*to a maximum of \d+/i, '').trim();
        }
        // Handle "for each X and each Y" or "for each X you control and each Y in your graveyard"
        const andEachParts = countTarget.split(/\s+and\s+(?:each|every)\s+/i);
        if (andEachParts.length > 1) {
          for (const part of andEachParts) {
            const cleanPart = part.trim().replace(/\s+in your graveyard$/i, '').replace(/\s+you control$/i, '');
            const isGraveyard = part.toLowerCase().includes('graveyard');
            const _eff = pushEff('7c', EFFECT_TYPE.MODIFY_PT, {
                power: parseInt(boostMatch[2]),
                toughness: parseInt(boostMatch[3]),
                userAdjustable: isGraveyard,
                isGraveyardCount: isGraveyard,
                basePower: parseInt(boostMatch[2]),
                baseToughness: parseInt(boostMatch[3]),
                forEachDesc: cleanPart,
                maxCount,
              }, _ctx,
              `Gets ${boostMatch[2]}/${boostMatch[3]} for each ${cleanPart}. ${rcpt.desc}`);
            _applyTargetInfo(_eff, rcpt.build, rcpt.fn);
          }
          return;
        }
        const cleanTarget = countTarget.replace(/\s+you control$/i, '').replace(/\s+in your graveyard$/i, '');
        const isGraveyard = countTarget.toLowerCase().includes('graveyard');
        const _effFe = pushEff('7c', EFFECT_TYPE.MODIFY_PT, {
            power: parseInt(boostMatch[2]),
            toughness: parseInt(boostMatch[3]),
            userAdjustable: isGraveyard,
            isGraveyardCount: isGraveyard,
            basePower: parseInt(boostMatch[2]),
            baseToughness: parseInt(boostMatch[3]),
            forEachDesc: cleanTarget,
            maxCount,
          }, _ctx,
          `Gets ${boostMatch[2]}/${boostMatch[3]} for each ${countTarget}. ${rcpt.desc}`);
        _applyTargetInfo(_effFe, rcpt.build, rcpt.fn);
        return;
      }

      const _effBoost = pushEff('7c', EFFECT_TYPE.MODIFY_PT,
        { power: parseInt(boostMatch[2]), toughness: parseInt(boostMatch[3]) },
        _ctx,
        `${filterText} get ${boostMatch[2]}/${boostMatch[3]}. ${rcpt.desc}`,
        { _oraclePos: boostMatch.index });
      _applyTargetInfo(_effBoost, rcpt.build, rcpt.fn);
    };
    for (const rcpt of recipients) _emitBoostFor(rcpt);
    // Apply "as long as" condition to newly generated effects
    if (boostMatchCond) {
      for (let ei = boostEffCountBefore; ei < effects.length; ei++) {
        effects[ei].asLongAsCondition = boostMatchCond;
      }
    }
  }

  // ---- Layer 7c: "double [the] power/toughness of [filter]" / "double [X]'s power/toughness" ----
  // Doubling a creature's power/toughness adds its current value as a +N/+N MODIFY_PT that is
  // computed at apply time (engine-apply reads state.power/state.toughness via doublePower/
  // doubleToughness flags). Two grammatical forms:
  //   of-form:    "double the power and toughness of each creature you control"  (Unnatural Growth)
  //   possessive: "double target creature's power" / "double this card's power" (Unleash Fury, Tifa)
  // Triggered/activated sentences are skipped here and re-parsed from the pseudo-perm at fire time.
  const _doubleForms = [
    { re: /\bdouble\s+(?:the\s+)?(power and toughness|power|toughness)\s+of\s+(.+?)(?=\s+until\b|[.,]|$)/gi, ptGroup: 1, filterGroup: 2 },
    { re: /\bdouble\s+(.+?)['’]s\s+(power and toughness|power|toughness)\b/gi, ptGroup: 2, filterGroup: 1 },
  ];
  for (const _df of _doubleForms) {
    let _dm;
    while ((_dm = _df.re.exec(oracle)) !== null) {
      if (_isInTriggeredSentence(_dm.index)) continue;
      if (_isInActivatedEffect(_dm.index)) continue;
      const _ptWhich = _dm[_df.ptGroup].toLowerCase();
      let _dFilter = _dm[_df.filterGroup].trim();
      // Possessive pronouns ("its", "their") refer to the source permanent itself.
      if (/^(its|their|his|her)$/i.test(_dFilter)) _dFilter = 'it';
      if (!filterReferencesPermanents(_dFilter)) continue;
      if (_dFilter.includes('"')) continue;
      const _dDoublePower = /power/.test(_ptWhich);
      const _dDoubleToughness = /toughness/.test(_ptWhich);
      const { fn: _dFn, desc: _dDesc, isSelf: _dIsSelf, isTargeted: _dIsTargeted,
              needsTargetSelection: _dNeedsTarget, maxTargets: _dMaxTgts } = buildAppliesToFromText(_dFilter);
      const _dBuildResult = { isSpellTarget: !!_dNeedsTarget, maxTargets: _dMaxTgts || 1 };
      const _dSelfAffect = _dIsSelf ? true : detectSelfAffect(_dFilter);
      const _dEff = pushEff('7c', EFFECT_TYPE.MODIFY_PT,
        { power: 0, toughness: 0, doublePower: _dDoublePower, doubleToughness: _dDoubleToughness },
        { isSelf: _dIsSelf, isTargeted: _dIsTargeted, fn: _dFn, selfAffect: _dSelfAffect },
        `Doubles ${_ptWhich}. ${_dDesc}`,
        { _oraclePos: _dm.index });
      _applyTargetInfo(_dEff, _dBuildResult, _dFn);
    }
  }

  // ---- Layer 7c: "[filter] gets +X/+Y[, where X is its / this creature's power/toughness] ----
  // Boosts whose magnitude is a P/T characteristic rather than a fixed number.
  //   "its power"         → the recipient's OWN characteristic (Berserk: +X/+0, X = its power)
  //   "this creature's …" → the SOURCE permanent's characteristic
  // The power dimension always gets +X; the toughness dimension gets +X only for "+X/+X".
  // Triggered/activated sentences are skipped — the trigger's fire-time path substitutes X
  // numerically (cards-battlefield.js) so the boost is re-parsed as a plain +N/+N later.
  const charBoostRegex = /(?:^|\.|,?\s+and\s+)\s*(.+?)\s+get[s]?\s+[+-]X\/[+-](X|0)(?:\s+until\s+[^,.;\n]+)?,?\s+where\s+X\s+is\s+(its|this\s+(?:creature|permanent|card)['’]?s?)\s+(power|toughness)\b/gmi;
  let charBoostMatch;
  while ((charBoostMatch = charBoostRegex.exec(oracle)) !== null) {
    // Recompute the start of the sentence containing the boost (the regex prefix points at
    // the delimiter that ENDS the previous sentence), then skip triggered/activated lines.
    const _cbEnd = charBoostMatch.index + charBoostMatch[0].length;
    const _cbSentPos = Math.max(
      oracle.lastIndexOf('.', _cbEnd - 1),
      oracle.lastIndexOf('\n', _cbEnd - 1)
    ) + 1;
    if (_isInTriggeredSentence(_cbSentPos)) continue;
    if (_isInActivatedEffect(_cbSentPos)) continue;
    let cbFilter = charBoostMatch[1].trim();
    if (cbFilter.includes('.')) {
      const segs = cbFilter.split(/\.\s*/);
      cbFilter = segs[segs.length - 1].trim();
    }
    // Strip trailing "gains [ability] and" / "becomes [word] and" artifacts (mirrors boostRegex).
    cbFilter = cbFilter.replace(/\s+gains?\s+[\w\s]+?\s+and\s*$/i, '').trim();
    cbFilter = cbFilter.replace(/\s+becomes?\s+[\w\s]+?\s+and\s*$/i, '').trim();
    if (!cbFilter || !filterReferencesPermanents(cbFilter) || cbFilter.includes('"')) continue;
    const cbToughDim = /^x$/i.test(charBoostMatch[2]);          // toughness dimension gets +X?
    const cbFrom = /^its$/i.test(charBoostMatch[3]) ? 'self' : 'source';
    const cbWhich = charBoostMatch[4].toLowerCase();            // 'power' | 'toughness'
    const { fn, desc, isSelf, isTargeted, needsTargetSelection, maxTargets } = buildAppliesToFromText(cbFilter);
    const cbBuild = { isSpellTarget: !!needsTargetSelection, maxTargets: maxTargets || 1 };
    const cbSelfAffect = isSelf ? true : detectSelfAffect(cbFilter);
    const cbSubj = cbFrom === 'self' ? 'its' : "this creature's";
    const _cbEff = pushEff('7c', EFFECT_TYPE.MODIFY_PT,
      { power: 0, toughness: 0, charBoost: true, charFrom: cbFrom, charWhich: cbWhich,
        charPowerDim: true, charToughDim: cbToughDim },
      { isSelf, isTargeted, fn, selfAffect: cbSelfAffect },
      `Gets +X/+${cbToughDim ? 'X' : '0'}, where X is ${cbSubj} ${cbWhich}. ${desc}`,
      { _oraclePos: charBoostMatch.index });
    _applyTargetInfo(_cbEff, cbBuild, fn);
  }

  // ---- Layer 5: "[filter] are [color]" → SET_COLOR (Shifting Sky) ----
  const colorSetRegex = /(?:^|\.)\s*(?:all\s+)?(.+?)\s+(?:you (?:control|own)\s+)?(?:are|is)\s+(white|blue|black|red|green|colorless)(?:\s|\.|\,|$)/gmi;
  let colorSetMatch;
  while ((colorSetMatch = colorSetRegex.exec(oracle)) !== null) {
    const csFilterText = colorSetMatch[1].trim();
    // Skip overlaps with "in addition to" (handled by addTypeRegex)
    const afterMatch = oracle.substring(colorSetMatch.index + colorSetMatch[0].length, colorSetMatch.index + colorSetMatch[0].length + 30);
    if (/in addition to/i.test(afterMatch)) continue;
    // Compound subject naming permanents together with spells and/or cards outside the
    // battlefield (Mycosynth Lattice: "All cards that aren't on the battlefield, spells,
    // and permanents are colorless"). The single-class branches below can't represent this:
    // filterReferencesPermanents bails the moment it sees "spells", and filterReferencesSpells
    // bails on the comma-separated list. Detect the combined scope explicitly and emit one
    // SET_COLOR that covers permanents, spells, and (flagged for the zone panels) cards in
    // exile / graveyard / the command zone.
    const csNamesPermanents = /\bpermanents?\b/i.test(csFilterText);
    const csNamesSpells = /\bspells?\b/i.test(csFilterText);
    const csNamesNonBfCards = /\bcards?\b[^.]*\b(?:aren'?t|are not|isn'?t|is not)\b[^.]*\bon the battlefield\b/i.test(csFilterText);
    if (csNamesPermanents && (csNamesSpells || csNamesNonBfCards)) {
      const csAllColor = colorSetMatch[2].toLowerCase();
      const csAllColors = csAllColor === 'colorless' ? [] : [COLOR_NAMES[csAllColor]];
      const csZoneNote = csNamesNonBfCards ? ', and cards outside the battlefield (exile, graveyard, command zone)' : '';
      pushEff('5', EFFECT_TYPE.SET_COLOR, { colors: csAllColors },
        { appliesTo: () => true, scope: 'global', selfTarget: false, affectsSelf: true },
        `${csFilterText} are ${csAllColor}. Applies to: all permanents${csNamesSpells ? ', spells' : ''}${csZoneNote}`,
        { appliesToSpells: csNamesSpells, appliesToPermanents: true,
          appliesToNonBattlefieldZones: csNamesNonBfCards, nonBattlefieldColors: csAllColors });
      continue;
    }
    // Spell path: "burn spells you cast are white"
    if (!filterReferencesPermanents(csFilterText) && filterReferencesSpells(csFilterText)) {
      let csSpellFilter = csFilterText;
      if (/\byou (?:cast|control)\b/i.test(colorSetMatch[0]) && !/\byou (?:cast|control)\b/i.test(csSpellFilter)) {
        csSpellFilter += ' you cast';
      }
      const csSpellApplies = buildSpellAppliesToFromText(csSpellFilter);
      const csSpellColor = colorSetMatch[2].toLowerCase();
      const csSpellColors = csSpellColor === 'colorless' ? [] : [COLOR_NAMES[csSpellColor]];
      pushEff('5', EFFECT_TYPE.SET_COLOR, { colors: csSpellColors },
        { appliesTo: csSpellApplies.fn, scope: 'global', selfTarget: false, affectsSelf: false },
        `${csSpellFilter} are ${csSpellColor}. ${csSpellApplies.desc}`,
        { appliesToSpells: true, appliesToPermanents: false });
      continue;
    }
    if (!filterReferencesPermanents(csFilterText)) continue;
    const csColor = colorSetMatch[2].toLowerCase();
    // Multiplayer: restore "you control" stripped by optional regex group
    let csSubjectText = csFilterText;
    if (/\byou (?:control|own)\b/i.test(colorSetMatch[0]) && !/\byou (?:control|own)\b/i.test(csSubjectText)) {
      csSubjectText += ' you control';
    }
    const { fn: csFn, desc: csDesc, isSelf: csIsSelf, isTargeted: csIsTargeted } = buildAppliesToFromText(csSubjectText);
    const csColors = csColor === 'colorless' ? [] : [COLOR_NAMES[csColor]];
    pushEff('5', EFFECT_TYPE.SET_COLOR, { colors: csColors },
      { isSelf: csIsSelf, isTargeted: csIsTargeted, fn: csFn, selfAffect: detectSelfAffect(csSubjectText) },
      `${csFilterText} are ${csColor}. ${csDesc}`);
  }

  // ---- Layer 5: "[filter] is/are all colors" → all 5 colors (Leyline of the Guildpact) ----
  const allColorsRegex = /(?:^|\.)\s*(?:all\s+|each\s+)?(.+?)\s+(?:you (?:control|own)\s+)?(?:are|is)\s+all\s+colors?(?:\s|\.|\,|$)/gmi;
  let allColorsMatch;
  while ((allColorsMatch = allColorsRegex.exec(oracle)) !== null) {
    const acFilterText = allColorsMatch[1].trim();
    if (/^\s*this\s+\w+\s*$/i.test(acFilterText)) continue; // "This [type] is all colors" — printed characteristic, Scryfall already has correct colors
    if (!filterReferencesPermanents(acFilterText)) continue;
    let acSubjectText = acFilterText;
    if (/\byou (?:control|own)\b/i.test(allColorsMatch[0]) && !/\byou (?:control|own)\b/i.test(acSubjectText)) {
      acSubjectText += ' you control';
    }
    const { fn: acFn, desc: acDesc, isSelf: acIsSelf, isTargeted: acIsTargeted } = buildAppliesToFromText(acSubjectText);
    pushEff('5', EFFECT_TYPE.SET_COLOR, { colors: ['W', 'U', 'B', 'R', 'G'] },
      { isSelf: acIsSelf, isTargeted: acIsTargeted, fn: acFn, selfAffect: detectSelfAffect(acSubjectText) },
      `${acSubjectText} are all colors. ${acDesc}`);
  }

  // ---- Layer 5: "[filter] are [color] in addition to their other colors" → ADD_COLOR ----
  // Firesong and Sunspeaker; covers permanents and stack spells.
  const addColorRegex = /(?:^|\.)\s*(?:all\s+|each\s+)?(.+?)\s+(?:you (?:cast|control|own)\s+)?(?:are|is)\s+(white|blue|black|red|green)\s+in addition to (?:their|its) other colors?/gmi;
  let addColorMatch;
  while ((addColorMatch = addColorRegex.exec(oracle)) !== null) {
    if (_isInActivatedEffect(addColorMatch.index)) continue;
    if (_isInTriggeredSentence(addColorMatch.index)) continue;
    const acAddFilterText = addColorMatch[1].trim();
    const acAddColor = addColorMatch[2].toLowerCase();
    const acAddColors = [COLOR_NAMES[acAddColor]];
    // Spell path
    if (!filterReferencesPermanents(acAddFilterText) && filterReferencesSpells(acAddFilterText)) {
      let acAddSpellFilter = acAddFilterText;
      if (/\byou (?:cast|control)\b/i.test(addColorMatch[0]) && !/\byou (?:cast|control)\b/i.test(acAddSpellFilter)) {
        acAddSpellFilter += ' you cast';
      }
      const acAddSpellApplies = buildSpellAppliesToFromText(acAddSpellFilter);
      pushEff('5', EFFECT_TYPE.ADD_COLOR, { colors: acAddColors },
        { appliesTo: acAddSpellApplies.fn, scope: 'global', selfTarget: false, affectsSelf: false },
        `${acAddSpellFilter} are ${acAddColor} in addition to their other colors. ${acAddSpellApplies.desc}`,
        { appliesToSpells: true, appliesToPermanents: false });
      continue;
    }
    if (!filterReferencesPermanents(acAddFilterText)) continue;
    // Permanent path
    let acAddSubjectText = acAddFilterText;
    if (/\byou (?:control|own)\b/i.test(addColorMatch[0]) && !/\byou (?:control|own)\b/i.test(acAddSubjectText)) {
      acAddSubjectText += ' you control';
    }
    const { fn: acAddFn, desc: acAddDesc, isSelf: acAddIsSelf, isTargeted: acAddIsTargeted } = buildAppliesToFromText(acAddSubjectText);
    pushEff('5', EFFECT_TYPE.ADD_COLOR, { colors: acAddColors },
      { isSelf: acAddIsSelf, isTargeted: acAddIsTargeted, fn: acAddFn, selfAffect: detectSelfAffect(acAddSubjectText) },
      `${acAddSubjectText} are ${acAddColor} in addition to their other colors. ${acAddDesc}`);
  }

  // ---- Layer 7b: Set P/T ----
  // Note: "enchanted/equipped creature gets +X/+Y" is handled by boostRegex above
  // (buildAppliesToFromText returns isTargeted:true for those filter phrases).
  // The old auraBoost parser was removed to prevent double-application.
  const auraSetPT = oracleLower.match(/(?:enchanted|equipped)\s+(?:(?:non\w+\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle))\s+(?:has\s+)?base\s+power\s+and\s+toughness\s+(\d+)\/(\d+)/);
  if (auraSetPT) {
    pushEff('7b', EFFECT_TYPE.SET_PT,
      { power: parseInt(auraSetPT[1]), toughness: parseInt(auraSetPT[2]) },
      { appliesTo: null, scope: 'targeted' },
      `Enchanted creature has base P/T ${auraSetPT[1]}/${auraSetPT[2]}.`);
  }

  // General "[filter] have/has base power and toughness X/Y [and are [type] [in addition to...]]" pattern
  const generalBasePTRegex = /(?:^|\.)\s*(.+?)\s+(?:you (?:control|own)\s+)?(?:have|has)\s+base\s+power\s+and\s+toughness\s+(\d+)\/(\d+)(?:\s+and\s+(?:are|is)\s+(\w+)((?:\s+in addition to\b)?))?/gmi;
  let generalBasePTMatch;
  while ((generalBasePTMatch = generalBasePTRegex.exec(oracle)) !== null) {
    const gbpFilterText = generalBasePTMatch[1].trim();
    const gbpFLower = gbpFilterText.toLowerCase();
    // Skip enchanted/equipped (handled above) and non-permanent references
    if (/enchanted|equipped/i.test(gbpFLower)) continue;
    // Skip triggered/activated ability text
    if (gbpFLower.includes('whenever ') || gbpFLower.includes('when ') || gbpFLower.length > 50) continue;
    if (!filterReferencesPermanents(gbpFilterText)) continue;
    // Skip if filterText ends with "and" or contains "are" — already handled by setTypeRegex
    if (/\band\s*$/i.test(gbpFLower)) continue;
    if (/\bare\s+\w/i.test(gbpFLower)) continue;
    // Multiplayer: restore "you control" stripped by optional regex group
    const gbpSubjectText = (/\byou (?:control|own)\b/i.test(generalBasePTMatch[0]) && !/\byou (?:control|own)\b/i.test(gbpFilterText))
      ? gbpFilterText + ' you control' : gbpFilterText;
    const gbpApplies = buildAppliesToFromText(gbpSubjectText);
    const gbpSelf = gbpApplies.isSelf ? true : detectSelfAffect(gbpFilterText);
    const gbpCond = _getConditionForPos(generalBasePTMatch.index);
    const _gbpCtx = {
      appliesTo: (gbpApplies.isSelf || gbpApplies.isTargeted) ? null : gbpApplies.fn,
      scope: (gbpApplies.isSelf || gbpApplies.isTargeted) ? 'targeted' : 'global',
      selfTarget: gbpApplies.isSelf || false,
      affectsSelf: gbpSelf,
    };
    pushEff('7b', EFFECT_TYPE.SET_PT,
      { power: parseInt(generalBasePTMatch[2]), toughness: parseInt(generalBasePTMatch[3]) },
      _gbpCtx,
      `${gbpFilterText} have base P/T ${generalBasePTMatch[2]}/${generalBasePTMatch[3]}. ${gbpApplies.desc}`,
      gbpCond ? { asLongAsCondition: gbpCond } : undefined);

    // Trailing "and are [type]" (Kudo/Graaz: "have base P/T X/Y and are Bears/Juggernauts")
    if (generalBasePTMatch[4]) {
      const trailingType = generalBasePTMatch[4];
      const isAddition = !!(generalBasePTMatch[5] && generalBasePTMatch[5].trim());
      const parsed = parseBecomesType(trailingType);
      if (parsed.subtypes.length > 0 || parsed.types.length > 0) {
        const effType = isAddition ? EFFECT_TYPE.ADD_TYPE : EFFECT_TYPE.SET_TYPE;
        const typeParams = isAddition
          ? { types: parsed.types, subtypes: parsed.subtypes }
          : (parsed.subtypes.length > 0 && parsed.types.length === 0
            ? { subtypes: parsed.subtypes, replaceSubtypeCategory: 'creature', keepSupertypes: true, keepTypes: true }
            : { types: parsed.types, subtypes: parsed.subtypes, keepSupertypes: true });
        pushEff('4', effType, typeParams, _gbpCtx,
          `${gbpFilterText} are ${trailingType}s${isAddition ? ' in addition to their other types' : ''}. ${gbpApplies.desc}`,
          gbpCond ? { asLongAsCondition: gbpCond } : undefined);
      }
    }
    // Trailing "and lose[s] all creature types" (Curse of Conformity): SET_TYPE layer 4 with
    // replaceSubtypeCategory:'creature' clears ONLY creature subtypes; the Creature type itself stays.
    const _gbpMatchEnd = generalBasePTMatch.index + generalBasePTMatch[0].length;
    if (/^\s*and\s+loses?\s+all\s+creature\s+types/i.test(oracle.substring(_gbpMatchEnd, _gbpMatchEnd + 50))) {
      pushEff('4', EFFECT_TYPE.SET_TYPE,
        { subtypes: [], replaceSubtypeCategory: 'creature', keepTypes: true, keepSupertypes: true },
        _gbpCtx,
        `${gbpFilterText} lose all creature types. ${gbpApplies.desc}`,
        gbpCond ? { asLongAsCondition: gbpCond } : undefined);
    }
  }

  // "[filter] have base power and toughness each equal to the number of [countOf]"
  // e.g. Porcelain Gallery: "Creatures you control have base power and toughness each equal
  //   to the number of creatures you control."
  const equalToCountRegex = /(?:^|\.)\s*(.+?)\s+(?:you (?:control|own)\s+)?have\s+base\s+power\s+and\s+toughness\s+each\s+equal\s+to\s+the\s+number\s+of\s+(.+?)\s*\./gmi;
  let equalToCountMatch;
  while ((equalToCountMatch = equalToCountRegex.exec(oracle)) !== null) {
    const etcFilterRaw = equalToCountMatch[1].trim();
    if (!filterReferencesPermanents(etcFilterRaw)) continue;
    if (/^when(?:ever)?|^at\b/i.test(etcFilterRaw)) continue;
    // Re-append "you control" if the optional regex group stripped it from the subject
    const etcSubjectText = (/\byou (?:control|own)\b/i.test(equalToCountMatch[0]) && !/\byou (?:control|own)\b/i.test(etcFilterRaw))
      ? etcFilterRaw + ' you control' : etcFilterRaw;
    const etcCountOf = equalToCountMatch[2].trim();
    const etcApplies = buildAppliesToFromText(etcSubjectText);
    const etcCond = _getConditionForPos(equalToCountMatch.index);
    pushEff('7b', EFFECT_TYPE.SET_PT, { useCountOf: etcCountOf },
      { isSelf: etcApplies.isSelf, isTargeted: etcApplies.isTargeted, fn: etcApplies.fn, selfAffect: etcApplies.isSelf || false },
      `${etcSubjectText} have base P/T equal to count of "${etcCountOf}". ${etcApplies.desc}`,
      etcCond ? { asLongAsCondition: etcCond } : undefined);
  }

  // ---- Layer 7d: P/T switch ----
  // Handles "Switch [filter]'s power and toughness" (Twisted Reflection, Inside Out, Mannichi, etc.)
  // Three syntactic forms:
  //   A. "Switch [filter]'s power and toughness [until end of turn]"
  //   B. "Switch the power and toughness of [filter] [until end of turn]"
  //   C. "[filter]'s power and toughness are switched"
  const switchPTRegex = /(?:switch(?:es)?\s+(.+?)'s\s+(?:base\s+)?(?:power\s+and\s+toughness|toughness\s+and\s+power)|switch\s+the\s+(?:base\s+)?(?:power\s+and\s+toughness|toughness\s+and\s+power)\s+of\s+(.+?)|(.+?)'s\s+(?:base\s+)?(?:power\s+and\s+toughness|toughness\s+and\s+power)\s+(?:are|is)\s+switched)(?:\s+until\s+end\s+of\s+turn)?(?:\s*\.|$)/gmi;
  let switchPTMatch;
  while ((switchPTMatch = switchPTRegex.exec(oracle)) !== null) {
    const rawFilter = (switchPTMatch[1] || switchPTMatch[2] || switchPTMatch[3] || '').trim();
    if (!rawFilter) continue;
    if (!filterReferencesPermanents(rawFilter)) continue;
    const switchCond = _getConditionForPos(switchPTMatch.index);
    const { fn: switchFn, desc: switchDesc, isSelf: switchIsSelf, isTargeted: switchIsTargeted,
            needsTargetSelection: switchNeedsTarget, maxTargets: switchMaxTgts } = buildAppliesToFromText(rawFilter);
    const switchSelfAffect = switchIsSelf ? true : detectSelfAffect(rawFilter);
    const _switchBuildResult = { isSpellTarget: !!switchNeedsTarget, maxTargets: switchMaxTgts || 1 };
    const switchEff = pushEff('7d', EFFECT_TYPE.SWITCH_PT, {},
      { isSelf: switchIsSelf, isTargeted: switchIsTargeted, fn: switchFn, selfAffect: switchSelfAffect },
      `Switch power/toughness of ${rawFilter}. ${switchDesc}`,
      { _oraclePos: switchPTMatch.index, ...(switchCond ? { asLongAsCondition: switchCond } : {}) });
    _applyTargetInfo(switchEff, _switchBuildResult, switchFn);
  }

  // ---- Layer 6: Ability granting (CDA P/T first) ----
  // "power and toughness equal to N plus the number of [thing]" (Tarmogoyf-likes).
  const _cdaSelfCtx = { appliesTo: null, scope: 'targeted', selfTarget: true };
  const cdaPlusRegex = /(?:power and toughness|power\/toughness)\s+(?:are|is)\s+(?:each\s+)?equal\s+to\s+(\w+)\s+plus\s+(?:the\s+)?(?:number|total number|amount)\s+of\s+(.+?)(?:\.|$)/gmi;
  let cdaPlusMatch;
  while ((cdaPlusMatch = cdaPlusRegex.exec(oracle)) !== null) {
    const baseRaw = cdaPlusMatch[1].toLowerCase();
    const baseVal = WORD_TO_NUM[baseRaw] !== undefined ? WORD_TO_NUM[baseRaw] : (parseInt(baseRaw) || 0);
    let countTarget = cdaPlusMatch[2].trim().replace(/\.$/, '');
    const isGraveyard = countTarget.toLowerCase().includes('graveyard') || countTarget.toLowerCase().includes('exile');
    const cleanTarget = countTarget.replace(/\s+you control$/i, '').replace(/\s+in your graveyard$/i, '').replace(/\s+in all graveyards$/i, '');
    pushEff('7a', EFFECT_TYPE.CDA_PT,
      { userAdjustable: isGraveyard, isGraveyardCount: isGraveyard, forEachDesc: cleanTarget, compute: null, cdaBaseValue: baseVal },
      _cdaSelfCtx,
      `P/T equal to ${baseVal} plus the number of ${countTarget}.`);
  }

  // Asymmetric CDA: "power is equal to N of X and its toughness is that plus M" (Tarmogoyf-like).
  const cdaAsymRegex = /(?:power)\s+(?:is|are)\s+(?:each\s+)?equal\s+to\s+(?:the\s+)?(?:number|total number|amount)\s+of\s+(.+?)\s+and\s+its\s+toughness\s+is\s+(?:equal\s+to\s+)?that\s+(?:number|amount)\s+plus\s+(\w+)/gmi;
  let cdaAsymMatch;
  while ((cdaAsymMatch = cdaAsymRegex.exec(oracle)) !== null) {
    let countTarget = cdaAsymMatch[1].trim().replace(/\.$/, '');
    const bonusRaw = cdaAsymMatch[2].toLowerCase();
    const bonusVal = WORD_TO_NUM[bonusRaw] !== undefined ? WORD_TO_NUM[bonusRaw] : (parseInt(bonusRaw) || 0);
    const _ctLower = countTarget.toLowerCase();
    const isExileCount = _ctLower.includes('exile');
    const isGraveyardCount = !isExileCount && _ctLower.includes('graveyard');
    const isGraveyard = isExileCount || isGraveyardCount;
    const cleanTarget = countTarget.replace(/\s+you control$/i, '').replace(/\s+in your graveyard$/i, '').replace(/\s+in all graveyards$/i, '');
    pushEff('7a', EFFECT_TYPE.CDA_PT,
      { userAdjustable: isGraveyard, isGraveyardCount, isExileCount, forEachDesc: cleanTarget, compute: null, toughBonus: bonusVal },
      _cdaSelfCtx,
      `Power equal to the number of ${countTarget}. Toughness is that plus ${bonusVal}.`);
  }

  // CDA "greatest mana value among [type] you control" (Karn, Legacy Reforged).
  const cdaGreatestMVRegex = /(?:power and toughness|power\/toughness)\s+(?:are|is)\s+(?:each\s+)?equal\s+to\s+the\s+greatest\s+mana\s+value\s+among\s+(.+?)(?:\s+you\s+control)?(?:\.|$)/gmi;
  let cdaGreatestMVMatch;
  while ((cdaGreatestMVMatch = cdaGreatestMVRegex.exec(oracle)) !== null) {
    const rawFilter = cdaGreatestMVMatch[1].trim().replace(/\.$/, '');
    const youControl = /\byou\s+control\b/i.test(cdaGreatestMVMatch[0]);
    pushEff('7a', EFFECT_TYPE.CDA_PT,
      { isGreatestMV: true, greatestMVFilter: rawFilter, greatestMVController: youControl, forEachDesc: rawFilter },
      _cdaSelfCtx,
      `P/T equal to the greatest mana value among ${rawFilter}${youControl ? ' you control' : ''}.`);
  }

  // CDA "power and toughness equal to the total mana value of [thing]" (Ancient Ooze).
  // Distinct from the "number of" forms below — this sums mana values rather than counting cards.
  const cdaManaValueRegex = /(?:power and toughness|power\/toughness)\s+(?:are|is)\s+(?:each\s+)?equal\s+to\s+the\s+total\s+mana\s+value\s+of\s+(?:the\s+)?(.+?)(?:\.|$)/gmi;
  let cdaMVMatch;
  while ((cdaMVMatch = cdaManaValueRegex.exec(oracle)) !== null) {
    const mvTarget = cdaMVMatch[1].trim().replace(/\.$/, '');
    pushEff('7a', EFFECT_TYPE.CDA_PT,
      { isManaValueSum: true, forEachDesc: mvTarget, compute: null },
      _cdaSelfCtx,
      `P/T equal to the total mana value of ${mvTarget}.`);
  }

  // CDA "power and toughness equal to the number of [thing]" (Nighthowler, etc).
  const cdaEqualRegex = /(?:power and toughness|power\/toughness)\s+(?:are|is)\s+(?:each\s+)?equal\s+to\s+(?:the\s+)?(?:number|total number|amount)\s+of\s+(.+?)(?:\.|$)/gmi;
  let cdaEqualMatch;
  while ((cdaEqualMatch = cdaEqualRegex.exec(oracle)) !== null) {
    // A CDA is a static ability of the card itself. A "power and toughness are each
    // equal to …" phrase that appears inside a triggered/activated ability (e.g.
    // Kalonian Twingrove's "create a … token with \"This token's power and toughness
    // are each equal to the number of Forests you control.\"") is a quoted ability
    // granted to a OTHER object, not a CDA on this card — skip it.
    if (_isInTriggeredSentence(cdaEqualMatch.index)) continue;
    if (_isInActivatedEffect(cdaEqualMatch.index)) continue;
    // Skip overlaps with the "N plus …" handler above.
    const beforeMatch = oracle.substring(0, cdaEqualMatch.index + cdaEqualMatch[0].indexOf('of'));
    if (/\bplus\s+(?:the\s+)?(?:number|total number|amount)\s*$/i.test(beforeMatch)) continue;
    let countTarget = cdaEqualMatch[1].trim().replace(/\.$/, '');
    const _ceCtLower = countTarget.toLowerCase();
    // Compound count: "[A] plus the number of [B]" (e.g. Soulless One —
    // "Zombies on the battlefield plus the number of Zombie cards in all graveyards").
    // Keep the full text and let _computeForEachCount sum both halves. Do NOT flag it as a
    // pure graveyard count — that branch discards the battlefield half and ignores the
    // subtype filter on the graveyard half (counting every card, not just the matching type).
    const _ceIsCompound = /\bplus\s+(?:the\s+)?(?:number|total number|amount)\s+of\b/i.test(countTarget);
    const _ceIsExile = !_ceIsCompound && _ceCtLower.includes('exile');
    const _ceIsGrave = !_ceIsCompound && !_ceIsExile && _ceCtLower.includes('graveyard');
    const isGraveyard = _ceIsExile || _ceIsGrave;
    // Keep "you control" in forEachDesc so _computeForEachCount filters by controller.
    // For compound counts, keep the whole string (incl. "in all graveyards") intact.
    const cleanTarget = _ceIsCompound ? countTarget
      : countTarget.replace(/\s+in your graveyard$/i, '').replace(/\s+in all graveyards$/i, '');
    pushEff('7a', EFFECT_TYPE.CDA_PT,
      { userAdjustable: isGraveyard, isGraveyardCount: _ceIsGrave, isExileCount: _ceIsExile, forEachDesc: cleanTarget, compute: null },
      _cdaSelfCtx,
      `P/T equal to the number of ${countTarget}.`);
  }

  // Single-characteristic CDA: "[self]'s power|toughness is equal to the number of [thing]" — sets only that
  // characteristic; the other stays at its printed value.
  // e.g. Namor the Sub-Mariner: "Namor's power is equal to the number of Merfolk you control."
  // The possessive subject ("this card's"/"its") distinguishes this from the symmetric power-and-toughness forms.
  const cdaSingleCharRegex = /(?:^|\.|\n)\s*(?:this card's|its)\s+(power|toughness)\s+(?:is|are)\s+equal\s+to\s+(?:the\s+)?(?:number|total number|amount)\s+of\s+([^.]+?)(?:\.|$)/gmi;
  let cdaSingleCharMatch;
  while ((cdaSingleCharMatch = cdaSingleCharRegex.exec(oracle)) !== null) {
    const whichChar = cdaSingleCharMatch[1].toLowerCase();
    let countTarget = cdaSingleCharMatch[2].trim().replace(/\.$/, '');
    // Skip the asymmetric Tarmogoyf forms ("...and its toughness/power is that plus N") handled above.
    if (/\band\s+its\s+(?:power|toughness)\b/i.test(countTarget)) continue;
    const _coLower = countTarget.toLowerCase();
    const _coIsExile = _coLower.includes('exile');
    const _coIsGrave = !_coIsExile && _coLower.includes('graveyard');
    const isGraveyard = _coIsExile || _coIsGrave;
    const _charParams = whichChar === 'toughness' ? { toughnessOnly: true } : { powerOnly: true };
    // Keep "you control" in forEachDesc so _computeForEachCount filters by controller.
    pushEff('7a', EFFECT_TYPE.CDA_PT,
      { ..._charParams, userAdjustable: isGraveyard, isGraveyardCount: _coIsGrave, isExileCount: _coIsExile, forEachDesc: countTarget, compute: null },
      _cdaSelfCtx,
      `${whichChar === 'toughness' ? 'Toughness' : 'Power'} equal to the number of ${countTarget}.`);
  }

  // Known keywords: standard + landwalk + protection variants.
  // Landwalk names follow the pattern "[land-type]walk".
  // KEYWORD_LIST, KEYWORD_SET, PARAMETERIZED_KEYWORDS hoisted to module scope at file top.
  const kwSet = KEYWORD_SET;
  const kwPattern = KEYWORD_LIST.join('|');

  // Helper: given a string like "flying, vigilance, and first strike", extract all keywords
  function parseKeywordList(text) {
    const raw = text.trim().replace(/^(?:,\s*)?(?:and\s+)?/i, '');
    if (!raw) return [];
    const keywords = [];

    // First, extract quoted abilities BEFORE lowercasing (preserve original case)
    let remaining = raw;
    const quotedAbilities = [];
    remaining = remaining.replace(/"((?:[^"\\]|\\.)*)"/g, (m, inner) => {
      // Clean trailing commas/periods from quoted abilities
      quotedAbilities.push(inner.trim().replace(/[,.]$/, '').trim());
      return '\x03'; // placeholder
    });

    // Now lowercase for keyword matching
    remaining = remaining.toLowerCase();

    // Extract protection phrases before splitting (they contain "from" which isn't a keyword)
    const protRegex = /protection from [^,]+(?:\s+and from [^,]+)*/gi;
    let protMatch;
    while ((protMatch = protRegex.exec(remaining)) !== null) {
      const splitProts = _splitProtectionAbilities(protMatch[0]);
      for (const prot of splitProts) keywords.push(prot);
      remaining = remaining.replace(protMatch[0], '\x02'); // placeholder
    }
    // Extract "hexproof from X" before splitting — "from" inside the phrase would otherwise
    // confuse the comma/and split (same reason as the protection extraction above).
    remaining = remaining.replace(
      /hexproof\s+from\s+((?:all|each)\s+\w+|\w+(?:\s+and\s+from\s+\w+)*)/gi,
      (m, qual) => { keywords.push(`Hexproof from ${qual.charAt(0).toUpperCase() + qual.slice(1)}`); return '\x02'; }
    );
    // Split on commas and "and"; consume trailing "and" after a comma so
    // "flying, haste, and indestructible" doesn't leave "and indestructible" unmatched.
    const parts = remaining.split(/,\s*(?:and\s+)?|\s+and\s+/).map(s => s.trim()).filter(s => s && s !== '\x02' && s !== '\x03');
    for (const part of parts) {
      if (kwSet.has(part)) {
        keywords.push(part.charAt(0).toUpperCase() + part.slice(1));
      } else {
        // Try two-word keywords like "first strike", "double strike", "totem armor"
        const twoWord = part.trim();
        if (kwSet.has(twoWord)) {
          keywords.push(twoWord.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
        } else {
          // Check for parameterized keyword: "ward {2}", "crew 3", "toxic 1"
          const paramMatch = part.match(/^(\w+(?:\s+\w+)?)\s+(.+)$/);
          if (paramMatch && (kwSet.has(paramMatch[1]) || PARAMETERIZED_KEYWORDS.has(paramMatch[1]))) {
            const kwBase = paramMatch[1].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            keywords.push(`${kwBase} ${paramMatch[2]}`);
          }
        }
      }
    }
    // Append extracted quoted abilities at the end (original case preserved)
    for (const qa of quotedAbilities) {
      keywords.push(qa);
    }
    return keywords;
  }

  // Keyword abilities: "Creatures you control have trample"
  // Also handles: "[filter] get +X/+Y and have [keyword]" by stripping the "and" prefix.
  // Also handles comma-separated keywords: "have flying, vigilance, and first strike"
  const haveAbilityRegex = new RegExp(
    `(?:^|\\.|;)\\s*(.+?)\\s+(?:you (?:control|own)\\s+)?(?:have|has|gain|gains)\\s+(${kwPattern})`,
    'gmi'
  );
  let haveMatch;
  const haveAbilityParsed = new Set(); // track to avoid duplicates
  while ((haveMatch = haveAbilityRegex.exec(oracle)) !== null) {
    // Cross-line anchor handling: the `(?:^|\.|;)\s*` anchor can match the "." at the end of
    // the previous line, with `\s*` consuming the newline so the actual ability content sits
    // on line N+1. _isInActivatedEffect / _isInTriggeredSentence on the anchor position would
    // describe the WRONG line — re-anchor those checks to the content line.
    const _lastNl = haveMatch[0].lastIndexOf('\n');
    const _checkPos = _lastNl >= 0 ? haveMatch.index + _lastNl + 1 : haveMatch.index;
    if (_isInActivatedEffect(_checkPos)) continue;
    if (_isInTriggeredSentence(_checkPos)) continue;
    let filterText = haveMatch[1].trim();
    const firstAbility = haveMatch[2].charAt(0).toUpperCase() + haveMatch[2].slice(1);
    // "... as though it didn't have defender" / "... doesn't have flying" — a negated "have"
    // is a combat/rules permission, NOT an ability grant. The captured filter ends with the
    // negation word (e.g. "...as though it didn't"), so skip it. (Pride of Hull Clade.)
    if (/(?:n['’]t|\bnot)$/i.test(filterText)) continue;
    // Fix: If the regex matched across sentence boundaries (filter contains "."),
    // use only the last sentence segment as the actual filter text.
    // e.g. "Put a +1/+1 counter on target creature you control. It" → "It"
    if (filterText.includes('.')) {
      const segments = filterText.split(/\.\s*/);
      filterText = segments[segments.length - 1].trim();
      // "Choose a [type] [restriction]. It gains [keyword]" — when the match spans
      // "Choose a creature you control. It gains indestructible", the .split leaves
      // "It" as the last segment. Resolve "It" to a targeted effect on the chosen type.
      if (/^it$/i.test(filterText) && segments.length >= 2) {
        const prevSentence = segments[segments.length - 2].trim();
        const chooseItMatch = prevSentence.match(/^(?:choose\s+(?:a|an|one)|target)\s+([\w][\w\s]*?)(?:\s+you\s+(?:control|own))?$/i);
        if (chooseItMatch) filterText = 'target ' + chooseItMatch[1].trim();
      }
      if (!filterText) continue;
    }
    // Skip if this match overlaps with an addType match (already handled with "and has" parsing)
    const haveStart = haveMatch.index;
    const haveEnd = haveStart + haveMatch[0].length;
    if (addTypeMatchRanges.some(r => haveStart < r.end && haveEnd > r.start)) continue;
    // Skip only singular targeted enchanted/equipped patterns (e.g., "enchanted creature"),
    // NOT plural/global ones (e.g., "Equipped creatures you control", "Enchanted creatures")
    if (/^(?:enchanted|equipped)\s+(?:non\w+\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle)$/i.test(filterText.trim())) continue;
    // Skip compound enchantment clauses (handled by enchant transform parser Fix 17)
    if (/(?:enchanted|equipped)\s+\w+\s+has\s+base\s+power|loses\s+all/i.test(filterText)) continue;
    // Skip "It has [keyword]" continuation of enchanted/equipped sentences
    // (e.g. "Enchanted creature is a Citizen... It has defender" — handled by enchant-transform)
    if (/^it$/i.test(filterText.trim())) {
      const textBefore = oracle.substring(0, haveMatch.index);
      if (/(?:enchanted|equipped)\s+(?:non\w+\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle)\b/i.test(textBefore)) continue;
      // "Choose a [type] [restriction]. It gains [keyword]" — resolve "It" to the chosen type.
      // Handles Spree / modal-spell modes like "Choose a creature you control. It gains indestructible."
      const lastSentence = textBefore.split(/[.\n]/).map(s => s.trim()).filter(Boolean).pop() || '';
      const chooseItMatch = lastSentence.match(/^(?:choose\s+(?:a|an|one)|target)\s+([\w][\w\s]*?)(?:\s+you\s+(?:control|own))?$/i);
      if (chooseItMatch) filterText = 'target ' + chooseItMatch[1].trim();
    }
    // Strip "... and" suffix from filter (e.g. "Other Merfolk get +1/+1 and" — "Other Merfolk")
    // Fix: Compound "A gets +X/+Y and B have/has [keyword]" — extract B as the real filter.
    // E.g. "this card gets +2/+2 and creatures" → "creatures" (Angelic Field Marshal)
    // Strip leading "Until end of turn, " duration prefix that bleeds in from compound activated-ability
    // text like "Until end of turn, this creature has base P/T 5/3, gains trample"
    filterText = stripDurationPrefix(filterText);
    // Strip trailing "has base power and toughness X/Y[,]" clause
    filterText = filterText.replace(/\s+has\s+base\s+power\s+and\s+toughness\s+\d+\/\d+\s*,?\s*$/i, '');
    // Strip trailing "gains [keyword(s)], and" remainder after the P/T clause
    filterText = filterText.replace(/\s+gains?\s+[^,]+,\s+and\s*$/i, '');
    const _ptAndFilter = filterText.match(/^.+?\s+get[s]?\s+[+-]?\d+\/[+-]?\d+\s+and\s+(.+)$/i);
    if (_ptAndFilter) {
      filterText = _ptAndFilter[1].trim();
    }
    filterText = filterText.replace(/\s+and\s*$/i, '').replace(/\s+get[s]?\s+[+-]?\d+\/[+-]?\d+.*$/i, '').trim();
    if (!filterText) continue;
    // Spell path: "instant/sorcery/spell[s] you cast have [keyword]" → spell-targeting effect
    if (!filterReferencesPermanents(filterText) && filterReferencesSpells(filterText)) {
      // "you cast" is often consumed by the regex group; restore it for the appliesTo builder
      let spellFilterText = filterText;
      if (/\byou (?:cast|control)\b/i.test(haveMatch[0]) && !/\byou (?:cast|control)\b/i.test(spellFilterText)) {
        spellFilterText += ' you cast';
      }
      const spellApplies = buildSpellAppliesToFromText(spellFilterText);
      const matchEnd2 = haveMatch.index + haveMatch[0].length;
      const restOfSentence2 = oracle.substring(matchEnd2);
      let sentenceEnd2 = restOfSentence2.search(/[.\n;]/);
      const remainingText2 = restOfSentence2.substring(0, sentenceEnd2 === -1 ? undefined : sentenceEnd2);
      const allKeywords2 = [firstAbility, ...parseKeywordList(remainingText2.replace(/^\s*,?\s*/, ''))]
        .filter((v, i, a) => a.findIndex(x => x.toLowerCase() === v.toLowerCase()) === i);
      for (const ability of allKeywords2) {
        if (haveAbilityParsed.has(`spell|${spellFilterText}|${ability}`.toLowerCase())) continue;
        haveAbilityParsed.add(`spell|${spellFilterText}|${ability}`.toLowerCase());
        pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability },
          { appliesTo: spellApplies.fn, scope: 'global', selfTarget: false, affectsSelf: false },
          `${spellFilterText} have ${ability}. ${spellApplies.desc}`,
          { appliesToSpells: true, appliesToPermanents: false, _oraclePos: haveMatch.index });
      }
      continue;
    }
    // Skip if filterText doesn't reference permanents (and not spells — handled above)
    if (!filterReferencesPermanents(filterText)) continue;
    // Multiplayer: restore "you control" stripped by optional regex group
    if (/\byou (?:control|own)\b/i.test(haveMatch[0]) && !/\byou (?:control|own)\b/i.test(filterText)) {
      filterText += ' you control';
    }
    const { fn, desc, isSelf, isTargeted, needsTargetSelection: _haveNTS, maxTargets: _haveMaxT, isTargetPlayerControl: _haveTPC } = buildAppliesToFromText(filterText);
    const _haveBuildResult = { isSpellTarget: !!_haveNTS, maxTargets: _haveMaxT || 1, isTargetPlayerControl: !!_haveTPC };
    const _haveNeedsTarget = isTargeted;
    const selfAffect = isSelf ? true : detectSelfAffect(filterText);

    // Collect ALL keywords from this sentence (including comma-separated ones)
    // Look at text after the "have/has/gain/gains" up to end of sentence
    const matchEnd = haveMatch.index + haveMatch[0].length;
    const restOfSentence = oracle.substring(matchEnd);
    // Find sentence end outside quoted strings (skip .;\ inside "..." to preserve quoted abilities)
    let sentenceEnd = -1;
    { let inQ = false;
      for (let _i = 0; _i < restOfSentence.length; _i++) {
        const ch = restOfSentence[_i];
        if (ch === '"') { inQ = !inQ; continue; }
        if (!inQ && (ch === '.' || ch === ';' || ch === '\n')) { sentenceEnd = _i; break; }
      }
    }
    const remainingText = restOfSentence.substring(0, sentenceEnd === -1 ? undefined : sentenceEnd);
    // Strip duration clauses before parsing keywords — "until end of turn" / "until your next turn"
    // would otherwise get attached to the last keyword and prevent matching.
    const _haveEOTSuffix = /\s+until\s+(?:end of turn|your next turn|the end of your next turn)$/i.test(remainingText) ? ' until end of turn' : '';
    const remainingForKw = remainingText.replace(/\s+until\s+(?:end of turn|your next turn|the end of your next turn)$/i, '');
    
    // Check if first ability is a parameterized keyword (e.g. "ward {2}", "toxic 1")
    let firstAbilityFull = firstAbility;
    if (PARAMETERIZED_KEYWORDS.has(haveMatch[2].toLowerCase())) {
      const paramCostMatch = remainingText.match(/^\s*(\{[^}]+\}|\d+)/);
      if (paramCostMatch) {
        firstAbilityFull = `${firstAbility} ${paramCostMatch[1]}`;
      }
    }
    // "hexproof from [qualifier]" — extend the keyword to include the color/quality qualifier.
    // e.g. "gains hexproof from blue" → "Hexproof from blue" (not just "Hexproof").
    if (/^hexproof$/i.test(haveMatch[2])) {
      const hexFromQual = remainingText.match(/^\s+from\s+((?:all|each)\s+\w+|\w+(?:\s+and\s+from\s+\w+)*)/i);
      if (hexFromQual) firstAbilityFull = `Hexproof from ${hexFromQual[1].trim()}`;
    }

    // Parse all keywords: first ability + any comma-separated ones after it
    const allKeywords = [firstAbilityFull];
    if (remainingForKw.trim()) {
      const extraKws = parseKeywordList(remainingForKw);
      for (const kw of extraKws) {
        if (!allKeywords.some(k => k.toLowerCase() === kw.toLowerCase())) {
          allKeywords.push(kw);
        }
      }
    }

    for (const ability of allKeywords) {
      // For modal spells, include the match line position in the dedup key
      // so identical modes (e.g. Cure and Cura both granting hexproof) each produce effects.
      const linePos = _isModalSpell ? `@${haveMatch.index}` : '';
      const key = `${filterText}|${ability}${linePos}`.toLowerCase();
      if (haveAbilityParsed.has(key)) continue;
      haveAbilityParsed.add(key);
      const haveCond = _getConditionForPos(haveMatch.index);
      const _haveTargeted = isSelf || _haveNeedsTarget;
      const eff = pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability },
        { appliesTo: _haveTargeted ? null : fn,
          scope: _haveTargeted ? 'targeted' : 'global',
          selfTarget: !!isSelf, affectsSelf: selfAffect },
        `${filterText.charAt(0).toUpperCase() + filterText.slice(1)} ${/^each\b/i.test(filterText) ? 'has' : 'have'} ${ability}. ${desc}`,
        { _oraclePos: haveMatch.index });
      if (haveCond) eff.asLongAsCondition = haveCond;
      _applyTargetInfo(eff, _haveBuildResult, fn);
    }
  }

  // "This Saga/card/enchantment gains '[quoted ability]'" — used by Urza's Saga and similar cards.
  // Chapters that grant the card itself a static activated ability generate a layer-6 ADD_ABILITY
  // effect gated by the lore counter condition for that chapter.
  const sagaGainsQuotedRegex = /\bthis\s+(?:saga|card|enchantment|permanent)\s+gains?\s+"([^"]+)"/gmi;
  let sagaGainsMatch;
  while ((sagaGainsMatch = sagaGainsQuotedRegex.exec(oracle)) !== null) {
    if (_isInActivatedEffect(sagaGainsMatch.index)) continue;
    // Don't treat a quoted ability granted inside a triggered ability's resolution
    // (e.g. Princess Yue's "When she dies, … She gains \"{T}: Add {C}.\"") as a static
    // Layer-6 grant — it only happens when the trigger resolves.
    if (_isInTriggeredSentence(sagaGainsMatch.index)) continue;
    const quotedAbility = sagaGainsMatch[1].trim();
    const sagaGainsCond = _getConditionForPos(sagaGainsMatch.index);
    const isSagaSubtype = permanent.printedSubtypes && permanent.printedSubtypes.includes('Saga');
    const sagaGainsEff = pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability: quotedAbility },
      { appliesTo: null, scope: 'targeted', selfTarget: true, affectsSelf: true },
      `This ${isSagaSubtype ? 'Saga' : 'card'} gains "${quotedAbility}".`);
    if (sagaGainsCond) sagaGainsEff.asLongAsCondition = sagaGainsCond;
  }

  // Catch-all for "[X]walk" abilities not in the keyword list (handles text-changed landwalk).
  const walkAbilityRegex = /(?:^|\.|;)\s*(.+?)\s+(?:you (?:control|own)\s+)?(?:have|has|gain|gains)\s+(\w+walk)\b/gmi;
  let walkMatch;
  while ((walkMatch = walkAbilityRegex.exec(oracle)) !== null) {
    let filterText = walkMatch[1].trim();
    const ability = walkMatch[2].charAt(0).toUpperCase() + walkMatch[2].slice(1);
    // Fix: cross-sentence filter cleanup
    if (filterText.includes('.')) {
      const segments = filterText.split(/\.\s*/);
      filterText = segments[segments.length - 1].trim();
      if (!filterText) continue;
    }
    if (/^(?:enchanted|equipped)\s+(?:non\w+\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle)$/i.test(filterText.trim())) continue;
    filterText = filterText.replace(/\s+and\s*$/i, '').replace(/\s+get[s]?\s+[+-]?\d+\/[+-]?\d+.*$/i, '').trim();
    if (!filterText) continue;
    if (effects.some(e => e.layer === '6' && e.params.ability === ability && e.sourceId === permanent.id)) continue;
    // Skip if filterText doesn't reference permanents
    if (!filterReferencesPermanents(filterText)) continue;
    const { fn, desc, isSelf, isTargeted } = buildAppliesToFromText(filterText);
    const selfAffect = isSelf ? true : detectSelfAffect(filterText);
    const walkCond = _getConditionForPos(walkMatch.index);
    const walkEff = pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability },
      { isSelf, isTargeted, fn, selfAffect },
      `${filterText} have ${ability}. ${desc}`);
    if (walkCond) walkEff.asLongAsCondition = walkCond;
  }

  // Full-text abilities: 'Creatures you control have "Whenever this creature..."'
  // Use a smarter regex that handles apostrophes inside quoted abilities
  // Matches opening " then content (including apostrophes/single-quotes) until closing "
  const fullTextAbilityRegex = /(?:^|[.;])\s*(.+?)\s+(?:you (?:control|own)\s+)?(?:have|has|gain|gains)\s+"((?:[^"\\]|\\.)*)"/gmi;

  // Protection granting: "[filter] get/gets/gain/gains/has/have protection from [X]"
  // Also handles comma phrases: "[filter] get +1/+1, have protection from [X]"
  // Splits compound protection: "protection from black and from red" -> two separate abilities
  function _splitProtectionAbilities(protText) {
    // "protection from black and from red" -> ["Protection from black", "Protection from red"]
    // "protection from red, from blue, and from green" -> 3 separate
    // "protection from all colors" -> ["Protection from all colors"] (no split)
    // "protection from each color" -> ["Protection from each color"]
    const lower = protText.toLowerCase();
    // Split on ", from " and " and from "
    const parts = lower.replace(/^protection from\s+/i, '').split(/,?\s+and\s+from\s+|,\s+from\s+/);
    if (parts.length > 1) {
      return parts.map(p => 'Protection from ' + p.trim());
    }
    // Also handle "protection from black, blue, and red" (comma-separated colors)
    const colorNames = ['white', 'blue', 'black', 'red', 'green'];
    const colorList = lower.replace(/^protection from\s+/i, '');
    const colorParts = colorList.split(/,\s*(?:and\s+)?|\s+and\s+/).map(s => s.trim()).filter(Boolean);
    if (colorParts.length > 1 && colorParts.every(p => colorNames.includes(p))) {
      return colorParts.map(c => 'Protection from ' + c);
    }
    return [protText.charAt(0).toUpperCase() + protText.slice(1)];
  }

  const protectionRegex = /(?:^|[.;,])\s*(.+?)\s+(?:you (?:control|own)\s+)?(?:get[s]?|gain[s]?|ha(?:s|ve))\s+(protection from [^.,;]+(?:\s+and from [^.,;]+)*)/gmi;
  let protMatch;
  const protParsed = new Set();
  while ((protMatch = protectionRegex.exec(oracle)) !== null) {
    let filterText = protMatch[1].trim();
    const rawAbility = protMatch[2].trim();
    // Imprint: "protection from each of the exiled card's card types" is handled separately
    // by the IMPRINT_PROTECTION_FROM_TYPES branch below — skip here so we don't emit a
    // non-functional literal-string ADD_ABILITY.
    if (/each\s+of\s+the\s+(?:exiled|imprinted)\s+card['’]?s?\s+card\s+types?/i.test(rawAbility)) continue;
    if (filterText.toLowerCase().includes('enchanted')) continue;
    // Fix: Compound "A gets +X/+Y and B have/has protection" — extract B as the real filter.
    const _protPtAndFilter = filterText.match(/^.+?\s+get[s]?\s+[+-]?\d+\/[+-]?\d+\s+and\s+(.+)$/i);
    if (_protPtAndFilter) {
      filterText = _protPtAndFilter[1].trim();
    }
    // Clean filter of preceding clauses
    filterText = filterText.replace(/\s+and\s*$/i, '').replace(/\s+get[s]?\s+[+-]?\d+\/[+-]?\d+.*$/i, '').trim();
    if (!filterText) continue;
    // "You and creatures you control" → "creatures you control" (player protection isn't modeled)
    if (/^you\s+and\s+/i.test(filterText) && /\byou (?:control|own)\b/i.test(protMatch[0])) {
      filterText = filterText.replace(/^you\s+and\s+/i, '') + ' you control';
    }
    if (!filterReferencesPermanents(filterText)) continue;
    const splitAbilities = _splitProtectionAbilities(rawAbility);
    const { fn, desc, isSelf, isTargeted } = buildAppliesToFromText(filterText);
    const selfAffect = isSelf ? true : detectSelfAffect(filterText);
    const protCond = _getConditionForPos(protMatch.index);
    for (const abilityCapitalized of splitAbilities) {
      const key = `${filterText}|${abilityCapitalized}`.toLowerCase();
      if (protParsed.has(key)) continue;
      protParsed.add(key);
      const protEff = pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability: abilityCapitalized },
        { isSelf, isTargeted, fn, selfAffect },
        `${filterText} have ${abilityCapitalized}. ${desc}`);
      // For "target X" wording, attach a target restriction so the UI picker filters
      // by type and so _pinAbilityEffectsToSource doesn't silently auto-target the source.
      if (isTargeted && !isSelf) protEff.targetRestriction = fn;
      // "you control" → restrict picker to permanents controlled by the source's controller.
      if (isTargeted && /\byou\s+control\b/i.test(filterText)) protEff.youControlRequired = true;
      if (protCond) protEff.asLongAsCondition = protCond;
    }
  }

  // Enchanted/equipped creature protection: "enchanted creature has/gains protection from [X]"
  const enchantProtRegex = /(?:enchanted|equipped)\s+(?:(?:non\w+\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle))\s+(?:has|gains?)\s+(protection from [^.,;]+(?:\s+and from [^.,;]+)*)/gmi;
  let enchantProtMatch;
  while ((enchantProtMatch = enchantProtRegex.exec(oracle)) !== null) {
    const rawAbility = enchantProtMatch[1].trim();
    const splitAbilities = _splitProtectionAbilities(rawAbility);
    const enchantProtCond = _getConditionForPos(enchantProtMatch.index);
    for (const abilityCapitalized of splitAbilities) {
      if (effects.some(e => e.layer === '6' && e.params.ability === abilityCapitalized && e.sourceId === permanent.id)) continue;
      const epEff = pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability: abilityCapitalized },
        { appliesTo: null, scope: 'targeted' },
        `Enchanted/equipped creature has ${abilityCapitalized}.`);
      if (enchantProtCond) epEff.asLongAsCondition = enchantProtCond;
    }
  }
  let ftMatch;
  while ((ftMatch = fullTextAbilityRegex.exec(oracle)) !== null) {
    // Skip if this match overlaps with an addType "and has/have" range already consumed
    const _ftStart = ftMatch.index;
    const _ftEnd = _ftStart + ftMatch[0].length;
    if (addTypeMatchRanges.some(r => _ftStart < r.end && _ftEnd > r.start)) continue;
    let filterText = ftMatch[1].trim();
    const abilityText = ftMatch[2].trim().replace(/,$/, '').trim();
    if (filterText.toLowerCase().includes('enchanted')) continue;
    // Skip triggered/activated ability text that matched the regex
    const _ftFLower = filterText.toLowerCase();
    if (_ftFLower.includes('whenever ') || _ftFLower.includes('when ') ||
        _ftFLower.length > 80) continue;
    // Fix: Compound "A gets +X/+Y and B has '[ability]'" — extract B as the real filter.
    // E.g. "this card gets +2/+2 and" → "this card" (Demon of Wailing Agonies)
    const _ftPtAndFilter = filterText.match(/^.+?\s+get[s]?\s+[+-]?\d+\/[+-]?\d+\s+and\s+(.+)$/i);
    if (_ftPtAndFilter) {
      filterText = _ftPtAndFilter[1].trim();
    }
    filterText = filterText.replace(/\s+and\s*$/i, '').replace(/\s+get[s]?\s+[+-]?\d+\/[+-]?\d+.*$/i, '').trim();
    // Strip leading "Until end of turn, " that bleeds in from activated-ability grant text
    // like "Until end of turn, target creature you control gains \"…\"" (Pride of Hull Clade).
    filterText = stripDurationPrefix(filterText);
    if (!filterText) continue;
    // Dedup against the saga/self quoted-ability grant (sagaGainsQuotedRegex), which already
    // handled "This Saga/card/enchantment gains \"…\"" earlier in this pass.
    if (effects.some(e => e.layer === '6' && e.params && e.params.ability === abilityText && e.sourceId === permanent.id)) continue;
    const { fn, desc, isSelf, isTargeted } = buildAppliesToFromText(filterText);
    const selfAffect = isSelf ? true : detectSelfAffect(filterText);
    const ftMatchCond = _getConditionForPos(ftMatch.index);
    const ftMatchEffectStart = effects.length; // track effects added in this match
    const ftEff = pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability: abilityText },
      { isSelf, isTargeted, fn, selfAffect },
      `${filterText} have "${abilityText}". ${desc}`);
    if (ftMatchCond) ftEff.asLongAsCondition = ftMatchCond;
    // Fix #7: Check for "and" continuation quoted abilities after this match
    // Pattern: ... has "ability1" and "ability2" and "ability3" ...
    let restOfText = oracle.substring(ftMatch.index + ftMatch[0].length);
    const andQuoteRegex = /^\s+and\s+"((?:[^"\\]|\\.)*)"/gi;
    let andMatch;
    while ((andMatch = andQuoteRegex.exec(restOfText)) !== null) {
      const contAbility = andMatch[1].trim();
      const andEff = pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability: contAbility },
        { isSelf, isTargeted, fn, selfAffect },
        `${filterText} have "${contAbility}". ${desc}`);
      if (ftMatchCond) andEff.asLongAsCondition = ftMatchCond;
      // Advance the main regex past this and-continuation
      fullTextAbilityRegex.lastIndex = ftMatch.index + ftMatch[0].length + andMatch.index + andMatch[0].length;
      restOfText = restOfText.substring(andMatch.index + andMatch[0].length);
    }
    // Check for "and lose all other abilities" / "and lose all abilities" continuation
    const andLoseMatch = restOfText.match(/^\s+and\s+loses?\s+all(?:\s+other)?\s+abilities/i);
    if (andLoseMatch) {
      // Collect all quoted abilities added by this match (from ftMatchEffectStart onward)
      // and convert from ADD_ABILITY to REMOVE_ABILITIES with replaceWith
      const abilitiesToKeep = [];
      // Remove only effects added in this fullTextAbility match iteration
      for (let ei = effects.length - 1; ei >= ftMatchEffectStart; ei--) {
        const e = effects[ei];
        if (e.layer === '6' && e.type === EFFECT_TYPE.ADD_ABILITY) {
          abilitiesToKeep.unshift(e.params.ability);
          effects.splice(ei, 1);
        }
      }
      const laEff = pushEff('6', EFFECT_TYPE.REMOVE_ABILITIES,
        { replaceWith: abilitiesToKeep.length > 0 ? abilitiesToKeep : undefined },
        { isSelf, isTargeted, fn, selfAffect },
        `${filterText} lose all abilities${abilitiesToKeep.length ? ' and gain: ' + abilitiesToKeep.join(', ') : ''}. ${desc}`);
      if (ftMatchCond) laEff.asLongAsCondition = ftMatchCond;
      // restOfText starts at: ftMatch.index + ftMatch[0].length (plus any and-quoted offsets)
      // andLoseMatch[0].length is the length consumed from restOfText
      fullTextAbilityRegex.lastIndex = oracle.length - restOfText.length + andLoseMatch[0].length;
    }
  }

  // Enchanted creature keyword abilities (includes landwalk + catch-all walk)
  // Handle comma-separated keywords: "enchanted creature has flying, vigilance, first strike"
  // Also handles parameterized keywords: "enchanted creature has ward {2}"
  const enchantAbilityRegex = new RegExp(
    `(?:enchanted|equipped)\\s+(?:(?:non\\w+\\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle))\\s+(?:has|gains?)\\s+((?:${kwPattern}|\\w+walk)(?:\\s+(?:\\{[^}]+\\}|\\d+))?(?:\\s*,\\s*(?:and\\s+)?(?:${kwPattern}|\\w+walk)(?:\\s+(?:\\{[^}]+\\}|\\d+))?)*)(?:\\s*,?\\s*and\\s+(?:${kwPattern}|\\w+walk)(?:\\s+(?:\\{[^}]+\\}|\\d+))?)?`,
    'gmi'
  );
  let enchantAbMatch;
  while ((enchantAbMatch = enchantAbilityRegex.exec(oracleLower)) !== null) {
    if (_isInActivatedEffect(enchantAbMatch.index)) continue;
    const matchCond = _getConditionForPos(enchantAbMatch.index);
    const fullAbilityText = enchantAbMatch[0].replace(/^(?:enchanted|equipped)\s+(?:(?:non\w+\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle))\s+(?:has|gains?)\s+/i, '');
    const allKws = parseKeywordList(fullAbilityText);
    // Fallback: if parseKeywordList didn't find anything, try the original single match
    if (allKws.length === 0) {
      const singleKw = enchantAbMatch[1].trim();
      if (singleKw) allKws.push(singleKw.charAt(0).toUpperCase() + singleKw.slice(1));
    }
    for (const ability of allKws) {
      if (effects.some(e => e.layer === '6' && e.params.ability === ability && e.sourceId === permanent.id && e.scope === 'targeted')) continue;
      const eff = pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability },
        { appliesTo: null, scope: 'targeted' },
        `Enchanted creature gains ${ability}.`);
      if (matchCond) eff.asLongAsCondition = matchCond;
    }
  }

  // ---- "loses the type [X]" / "loses the subtype [Y]" patterns ----
  // E.g. Kaito: "this card loses the type planeswalker and the subtype Kaito"
  const losesTypeRegex = /(?:^|[.;])\s*(.+?)\s+loses?\s+(the\s+(?:type|subtype)\s+.+?)(?:\.|$)/gmi;
  let losesTypeMatch;
  while ((losesTypeMatch = losesTypeRegex.exec(oracle)) !== null) {
    const filterText = losesTypeMatch[1].trim();
    const lostDesc = losesTypeMatch[2].trim();
    if (!filterReferencesPermanents(filterText)) continue;
    const { fn, desc, isSelf, isTargeted } = buildAppliesToFromText(filterText);
    const selfAffect = isSelf ? true : detectSelfAffect(filterText);
    const ltCond = _getConditionForPos(losesTypeMatch.index);
    // Parse "the type X and the subtype Y" / "the type X" / "the subtype Y"
    const typeMatches = lostDesc.match(/the\s+type\s+(\w+)/gi);
    const subtypeMatches = lostDesc.match(/the\s+subtype\s+(\w+)/gi);
    const lostTypes = (typeMatches || []).map(m => {
      const w = m.replace(/^the\s+type\s+/i, '').trim();
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
    const lostSubtypes = (subtypeMatches || []).map(m => {
      const w = m.replace(/^the\s+subtype\s+/i, '').trim();
      return w.charAt(0).toUpperCase() + w.slice(1);
    });
    if (lostTypes.length > 0 || lostSubtypes.length > 0) {
      const eff = pushEff('4', EFFECT_TYPE.REMOVE_TYPE,
        { types: lostTypes, subtypes: lostSubtypes },
        { isSelf, isTargeted, fn, selfAffect },
        `${filterText} loses ${lostDesc}. ${desc}`);
      if (ltCond) eff.asLongAsCondition = ltCond;
    }
  }

  // ---- Fix: Specific ability removal: "loses flying", "loses deathtouch, vigilance, and first strike" ----
  // Also handles: "[filter] lose/loses [abilities]" and "enchanted creature loses [abilities]"
  const losesSpecificRegex = /(?:^|[.;])\s*(.+?)\s+(?:you (?:control|own)\s+)?(?:loses?)\s+(?!all\b)(.+?)(?:\.|$)/gmi;
  let losesSpecificMatch;
  while ((losesSpecificMatch = losesSpecificRegex.exec(oracle)) !== null) {
    const filterText = losesSpecificMatch[1].trim();
    const lostText = losesSpecificMatch[2].trim().toLowerCase()
      .replace(/\s+(?:until end of turn|until your next turn|for as long as[^.]*)\s*$/, '');
    // Skip if this looks like "loses all abilities" or "loses all creature types"
    if (lostText.includes('all ')) continue;
    // Skip "loses the type [X]" / "loses the subtype [X]" — handled by losesTypeRegex above
    if (/^the\s+(?:type|subtype)\b/.test(lostText)) continue;
    // Skip non-permanent filters
    if (!filterReferencesPermanents(filterText)) continue;
    // Parse the abilities list: "flying, deathtouch, and vigilance" -> ["Flying", "Deathtouch", "Vigilance"]
    const parts = lostText.split(/\s*,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);
    const abilities = [];
    for (const part of parts) {
      if (kwSet.has(part) || KEYWORD_LIST.some(k => part === k)) {
        abilities.push(part.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
      } else if (part.length > 1) {
        abilities.push(part.charAt(0).toUpperCase() + part.slice(1));
      }
    }
    if (abilities.length > 0) {
      const _lsBResult = buildAppliesToFromText(filterText);
      const { fn, desc, isSelf, isTargeted } = _lsBResult;
      const selfAffect = isSelf ? true : detectSelfAffect(filterText);
      const matchCond = _getConditionForPos(losesSpecificMatch.index);
      const eff = pushEff('6', EFFECT_TYPE.REMOVE_ABILITIES, { specificAbilities: abilities },
        { isSelf, isTargeted, fn, selfAffect },
        `${filterText} loses ${abilities.join(', ')}. ${desc}`);
      if (matchCond) eff.asLongAsCondition = matchCond;
      _applyTargetInfo(eff, _lsBResult, fn);
    }
  }

  // ---- General "lose all abilities" / "lose all other abilities" parser ----
  // Handles: "[filter] lose all abilities", "[filter] lose all other abilities",
  //          "[filter] lose all abilities except mana abilities"
  // Does NOT handle enchanted/equipped (those are handled by the enchant transform parser below).
  // Does NOT handle "have [ability] and lose all" (handled by fullTextAbilityRegex continuation above).
  // The subject is captured with [^.;] (not .) so it cannot cross a sentence boundary —
  // e.g. The Wondrous Wasp's fired effect "tap up to one target creature. target creature
  // loses all abilities …" must capture "target creature", not the whole preceding sentence.
  const loseAllAbilitiesRegex = /(?:^|[.;])\s*([^.;]+?)\s+(?:you (?:control|own)\s+)?loses?\s+all(?:\s+other)?\s+abilities(?:\s+except\s+mana\s+abilities)?/gmi;
  let loseAllMatch;
  while ((loseAllMatch = loseAllAbilitiesRegex.exec(oracle)) !== null) {
    const filterSubject = loseAllMatch[1].trim();
    // Skip enchanted/equipped — handled below
    if (/enchanted|equipped/i.test(filterSubject)) continue;
    // "Cards in [zone] lose all abilities" (e.g. Yixlid Jailer, "Cards in graveyards lose all abilities.")
    // These scope to non-battlefield zone cards only — filtered via zoneCardsOnly in effectAppliesToPerm.
    const _zoneOnlyMatch = filterSubject.match(/^cards?\s+in\s+(graveyards?|exile|(?:the\s+)?command\s+zones?)/i);
    if (_zoneOnlyMatch) {
      if (_isInTriggeredSentence(loseAllMatch.index)) continue;
      const _zoneTag = /graveyard/i.test(_zoneOnlyMatch[1]) ? 'graveyard'
        : /exile/i.test(_zoneOnlyMatch[1]) ? 'exile' : 'commander';
      pushEff('6', EFFECT_TYPE.REMOVE_ABILITIES, {},
        { appliesTo: () => true, scope: 'global', selfTarget: false, affectsSelf: false },
        `Cards in ${_zoneTag}s lose all abilities.`,
        { appliesToNonBattlefieldZones: true, nonBattlefieldZones: [_zoneTag], zoneCardsOnly: true,
          _oraclePos: loseAllMatch.index });
      continue;
    }
    if (!filterReferencesPermanents(filterSubject)) continue;
    // Skip if this match falls inside a triggered-ability sentence
    // ("When/Whenever/At ..."). Those effects apply only when the trigger
    // resolves (via the pseudo-permanent created by fireTriggeredAbility),
    // not as static continuous effects on the source permanent.
    if (_isInTriggeredSentence(loseAllMatch.index)) continue;
    // Skip if filterSubject contains a quoted ability (continuation case handled by fullTextAbilityRegex)
    if (/[""\u201c\u201d]/.test(filterSubject)) continue;
    // Skip if a REMOVE_ABILITIES effect for the same scope already exists from the fullTextAbility continuation
    const exceptMana = /except\s+mana\s+abilities/i.test(loseAllMatch[0]);
    const _laBResult = buildAppliesToFromText(filterSubject);
    const { fn, desc, isSelf, isTargeted } = _laBResult;
    const selfAffect = isSelf ? true : detectSelfAffect(filterSubject);
    // Check for duplicate (skip for modal spells — each mode is independent)
    if (!_isModalSpell) {
      const dupCheck = effects.some(e => e.type === EFFECT_TYPE.REMOVE_ABILITIES && e.sourceId === permanent.id
        && e.layer === '6' && !e.params.specificAbilities);
      if (dupCheck) continue;
    }
    const laCond = _getConditionForPos(loseAllMatch.index);
    const laParams = exceptMana ? { exceptManaAbilities: true } : {};
    const _laCtx = { isSelf, isTargeted, fn, selfAffect };
    const _loseAllEffsStart = effects.length;
    const laEff = pushEff('6', EFFECT_TYPE.REMOVE_ABILITIES, laParams, _laCtx,
      `${filterSubject} lose all${exceptMana ? ' non-mana' : ''} abilities. ${desc}`,
      { _oraclePos: loseAllMatch.index });
    if (laCond) laEff.asLongAsCondition = laCond;
    // Apply target restriction so _pinAbilityEffectsToSource doesn't auto-pin
    // "target creature loses all abilities" effects to the source permanent.
    _applyTargetInfo(laEff, _laBResult, fn);

    // Compound continuation: additional clauses chained after "loses all abilities".
    // Handles:
    //   "and have/has base power and toughness X/Y" (Humility)
    //   ", becomes a X in addition to its other types[, and has base power and toughness X/Y]" (Curious Colossus)
    const _pushCompoundBasePT = (p, t) => {
      const e = pushEff('7b', EFFECT_TYPE.SET_PT, { power: parseInt(p), toughness: parseInt(t) },
        _laCtx, `${filterSubject} have base P/T ${p}/${t}. ${desc}`);
      if (laCond) e.asLongAsCondition = laCond;
      _applyTargetInfo(e, _laBResult, fn);
    };
    const restAfterLose = oracle.substring(loseAllMatch.index + loseAllMatch[0].length);
    let _compoundAdvance = 0;

    // Case A: direct "and have/has base power and toughness X/Y" (Humility-style)
    const compoundBasePT = restAfterLose.match(/^\s+and\s+(?:have|has)\s+base\s+power\s+and\s+toughness\s+(\d+)\/(\d+)/i);
    if (compoundBasePT) {
      _pushCompoundBasePT(compoundBasePT[1], compoundBasePT[2]);
      _compoundAdvance = compoundBasePT[0].length;
    }

    // Case B: ", becomes a X in addition to its other types" optionally followed by
    //         ", and has/have base power and toughness X/Y" (Curious Colossus-style)
    if (!_compoundAdvance) {
      const compoundBecomes = restAfterLose.match(/^,\s+becomes?\s+an?\s+(.+?)\s+in addition to (?:its|their) other\b.*?types/i);
      if (compoundBecomes) {
        const parsedBT = parseBecomesType(compoundBecomes[1].trim());
        if (parsedBT.types.length > 0 || parsedBT.subtypes.length > 0) {
          const btEff = pushEff('4', EFFECT_TYPE.ADD_TYPE,
            { types: parsedBT.types, subtypes: parsedBT.subtypes }, _laCtx,
            `${filterSubject} also become ${compoundBecomes[1].trim()}. ${desc}`);
          if (laCond) btEff.asLongAsCondition = laCond;
          _applyTargetInfo(btEff, _laBResult, fn);
        }
        _compoundAdvance = compoundBecomes[0].length;
        // Also look for ", and has/have base power and toughness X/Y" following the becomes clause
        const restAfterBecomes = restAfterLose.substring(compoundBecomes[0].length);
        const compoundBTPT = restAfterBecomes.match(/^,\s+and\s+(?:have|has)\s+base\s+power\s+and\s+toughness\s+(\d+)\/(\d+)/i);
        if (compoundBTPT) {
          _pushCompoundBasePT(compoundBTPT[1], compoundBTPT[2]);
          _compoundAdvance += compoundBTPT[0].length;
        }
      }
    }

    // CR 613: tag all effects from this match with a shared group ID so the engine
    // knows they are one continuous ability and applies them to the same permanents.
    if (effects.length > _loseAllEffsStart + 1) {
      const _loseAllGroupId = `${permanent.id}_loseAll_${loseAllMatch.index}`;
      for (let _ei = _loseAllEffsStart; _ei < effects.length; _ei++) {
        effects[_ei].abilityGroupId = _loseAllGroupId;
      }
    }

    if (_compoundAdvance > 0) {
      loseAllAbilitiesRegex.lastIndex = loseAllMatch.index + loseAllMatch[0].length + _compoundAdvance;
    }
  }

  // ---- Unified enchantment transformation parser ----
  // Handles "Enchanted [permanent type] is a [color] [subtype] [type] with [P/T]" framework.
  // Uses "is" = REPLACE characteristics. "in addition to" = ADD characteristics.
  // Missing brackets (no color, no P/T, etc.) = no change in those areas.
  // Also handles compound clauses: loses all abilities, has [keyword], etc.
  const enchantTransformRegex = /(?:enchanted|equipped)\s+(?:(?:non\w+\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle))\s+(.+)/gi;
  let enchantTransformMatch;
  while ((enchantTransformMatch = enchantTransformRegex.exec(oracle)) !== null) {
    // Extract the enchant target type (creature, permanent, land, etc.)
    // Used to determine whether the effect scopes to creature-only characteristics.
    const _enchantTargetTypeMatch = enchantTransformMatch[0].match(/(?:enchanted|equipped)\s+((?:non\w+\s+)?(?:creature|permanent|land|artifact|enchantment|planeswalker|battle|vehicle))/i);
    const enchantTargetIsCreatureOnly = _enchantTargetTypeMatch && _enchantTargetTypeMatch[1].toLowerCase().trim() === 'creature';

    // Determine if this match's line has an "as long as" condition
    const matchPos = enchantTransformMatch.index;
    const textBefore = oracle.substring(0, matchPos);
    // Skip matches that fall inside a quoted ability string (e.g. "Equipped creature gets +2/+0")
    if ((textBefore.match(/["“”]/g) || []).length % 2 !== 0) continue;
    const lineNum = textBefore.split('\n').length - 1;
    const _matchConditionIdx = _lineConditionMap.has(lineNum) ? _lineConditionMap.get(lineNum) : -1;
    const _matchCondition = _matchConditionIdx >= 0 ? _asLongAsConditions[_matchConditionIdx] : null;
    const effectCountBefore = effects.length; // track to apply condition to new effects

    // Merge multi-sentence continuations: "is a Citizen. It has defender and ..."
    // Sentences starting with "It " that continue the enchant effect are merged.
    let fullClauseText = enchantTransformMatch[1].replace(/\.\s*$/, '').trim();
    // Merge "It has/loses/is/gains" continuation sentences
    // Also handles ." It (quote then period before It)
    fullClauseText = fullClauseText.replace(/[.""\u201d]*\.\s+It\s+(has|loses|is|gains|gets|doesn't|can't|has\s+base)/gi,
      (m, verb) => ', ' + verb);
    // Also handle: '." It loses' where the period is inside or right after a quote
    fullClauseText = fullClauseText.replace(/[""\u201d]\s+It\s+(has|loses|is|gains|gets|doesn't|can't|has\s+base)/gi,
      (m, verb) => '", ' + verb);

    // Split into clauses on commas and "and" (but preserve compound phrases)
    // First, extract and protect quoted abilities from splitting
    const _quotedPlaceholders = [];
    let _fullClauseForSplit = fullClauseText.replace(/[""\u201c]([^""\u201d]*(?:'[^""\u201d]*)*)[""\u201d]/g, (m, inner) => {
      const idx = _quotedPlaceholders.length;
      _quotedPlaceholders.push(inner.trim());
      return `\x03QUOTE${idx}\x03`;
    });
    // Protect compound phrases from splitting
    let protectedText = _fullClauseForSplit
      .replace(/power and toughness/gi, 'power\x00and\x00toughness')
      .replace(/in addition to/gi, 'in\x00addition\x00to')
      .replace(/card types/gi, 'card\x00types')
      .replace(/creature types/gi, 'creature\x00types')
      .replace(/colors and types/gi, 'colors\x00and\x00types')
      .replace(/protection from/gi, 'protection\x00from')
      // Protect "and from" in compound protection: "protection from black and from red"
      .replace(/\band\s+from\b/gi, '\x00and\x00from')
      // Protect color pairs: "green and white", "red and black", etc.
      .replace(/\b(white|blue|black|red|green)\s+and\s+(white|blue|black|red|green)\b/gi,
        (m, a, b) => `${a}\x00and\x00${b}`);
    // Protect "with [abilities]" inside "is" clauses from being split.
    // "is a 1/1 Bird with flying, haste, and vigilance" must keep the "with" part intact.
    // Use \x01 as sentinel for commas within "with" clause (restored to comma after split).
    protectedText = protectedText.replace(
      /(\bwith\s+)((?:(?!\band\s+(?:it\s+)?(?:loses|is\b|has\b|gains?\b)).)*)/gi,
      (m, withWord, rest) => withWord + rest.replace(/,/g, '\x01').replace(/\band\b/gi, '\x00and\x00')
    );
    const rawClauses = protectedText.split(/,\s+(?:and\s+)?|,\s+|\s+and\s+/)
      .map(c => {
        let restored = c.replace(/\x00/g, ' ').replace(/\x01/g, ',').trim();
        // Restore quoted placeholders
        restored = restored.replace(/\x03QUOTE(\d+)\x03/g, (m, idx) => '"' + _quotedPlaceholders[parseInt(idx)] + '"');
        return restored;
      }).filter(Boolean);

    // Parsed components
    const COLOR_NAMES = { 'white': 'W', 'blue': 'U', 'black': 'B', 'red': 'R', 'green': 'G' };
    let extractedColors = [];
    let extractedTypes = [];
    let extractedSubtypes = [];
    let extractedPT = null;
    let hasLoseAbilities = false;
    let hasLoseAllCreatureTypes = false;
    let hasLoseCardTypes = false;
    let hasLoseSubtypes = false;
    let abilitiesToGrant = [];
    let quotedAbilities = [];
    let isTypeAddition = false;  // "in addition to ... types" = ADD types
    let isColorAddition = false; // "in addition to ... colors" = ADD colors
    let isColorless = false;
    let hasIsClause = false; // whether an "is a..." clause was found
    let isLandSubtype = false;
    let typeWasExplicit = false; // true if a permanent type word (Creature, Artifact, etc.) was explicitly stated
    let subtypeOnlyReplace = false; // true when "is a [subtype]" with no explicit type word
    let extractedUseMV = false; // true when "power and toughness each equal to its mana value"
    let extractedName = null; // "named X" from "is a [type] named X"
    let specificAbilityRemovals = []; // keywords removed by "loses [specific ability]" clauses

    for (const clause of rawClauses) {
      const cl = clause.toLowerCase();

      // Skip clauses already handled by earlier parsers
      if (cl.match(/^gets?\s+[+-]\d+\/[+-]\d+/)) continue; // auraBoost

      // "loses all creature types"
      if (cl.includes('loses all') && cl.includes('creature types')) {
        hasLoseAllCreatureTypes = true; continue;
      }
      // "loses all other abilities" / "loses all abilities"
      if (cl.includes('loses all') && (cl.includes('abilities') || cl.includes('ability'))) {
        hasLoseAbilities = true; continue;
      }
      // Standalone "all abilities" / "all creature types" from clause splitting on "and"
      // (e.g. "loses all other card types and all abilities" splits into "loses all other card types" + "all abilities")
      if (/^all\s+(?:other\s+)?(?:abilities|ability)[.\s]*$/.test(cl)) {
        hasLoseAbilities = true; continue;
      }
      if (/^all\s+(?:other\s+)?creature\s+types[.\s]*$/.test(cl)) {
        hasLoseAllCreatureTypes = true; continue;
      }
      // Bare "abilities" from splitting "loses all other card types and abilities"
      // The "loses all other" context is already captured by hasLoseCardTypes
      if (/^(?:other\s+)?(?:abilities|ability)[.\s]*$/.test(cl)) {
        hasLoseAbilities = true; continue;
      }
      // "loses ... card types, and subtypes" (Imprisoned in the Moon)
      if (cl.includes('card types')) { hasLoseCardTypes = true; continue; }
      if (cl === 'subtypes') { hasLoseSubtypes = true; continue; }

      // "loses [specific ability/abilities]" e.g. "loses flying", "loses flying and reach"
      const losesSpecificClause = cl.match(/^loses\s+(?!all\b)(.+?)(?:\s+until\s+\w.*)?$/);
      if (losesSpecificClause) {
        const lostAbilText = losesSpecificClause[1].trim();
        const parts = lostAbilText.split(/\s*,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);
        for (const part of parts) {
          if (kwSet.has(part.toLowerCase()) || KEYWORD_LIST.some(k => part.toLowerCase() === k)) {
            const cap = part.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            if (!specificAbilityRemovals.includes(cap)) specificAbilityRemovals.push(cap);
          }
        }
        continue;
      }

      // "has base power and toughness X/Y" (standalone only; skip if inside an "is" clause)
      const basePTMatch = !cl.startsWith('is ') && cl.match(/(?:has\s+)?base\s+power\s+and\s+toughness\s+(\d+)\/(\d+)/);
      if (basePTMatch) {
        extractedPT = { power: parseInt(basePTMatch[1]), toughness: parseInt(basePTMatch[2]) };
        continue;
      }
      // "has power and toughness each equal to its mana value" (standalone clause)
      if (!cl.startsWith('is ') && /(?:has\s+)?(?:base\s+)?power\s+and\s+(?:base\s+)?toughness\s+(?:each\s+)?equal\s+to\s+(?:its|their)\s+(?:mana\s+value|converted\s+mana\s+cost)/.test(cl)) {
        extractedUseMV = true;
        continue;
      }

      // "is a [color] [subtype] [type] [with P/T]" — the main "is" clause
      // "becomes" is semantically equivalent to "is" for continuous type-setting effects (Layer 4)
      const isMatch = cl.match(/^(?:is|becomes?)\s+(?:a\s+|an\s+)?(.+)/);
      if (isMatch) {
        hasIsClause = true;
        // Use original-case clause for text extraction (preserves {T}, {C} etc. in quoted abilities)
        const isMatchOriginal = clause.match(/^is\s+(?:a\s+|an\s+)?(.+)/i);
        let isText = isMatchOriginal ? isMatchOriginal[1] : isMatch[1];

        // Check "in addition to" — determine whether it covers colors, types, or both
        const addMatch = isText.match(/^(.+?)\s+in addition to\s+(?:its|their)\s+other\s+(.*)/i);
        if (addMatch) {
          const additionScope = (addMatch[2] || '').toLowerCase();
          isTypeAddition = /types?\b/.test(additionScope);
          isColorAddition = /colors?\b/.test(additionScope);
          // If neither matched (fallback), treat both as addition
          if (!isTypeAddition && !isColorAddition) {
            isTypeAddition = true;
            isColorAddition = true;
          }
          isText = addMatch[1];
        }

        // Check "that's still a [type]" — "still" means preserve existing types/subtypes,
        // functionally equivalent to "in addition to its other types".
        // E.g. Living Terrain: "is a 5/6 green Treefolk creature that's still a land."
        // Don't strip the "still" type — the word parser will pick it up as a type to add.
        // "still" itself is already in the exclusion list (skipped as a subtype).
        if (/\bstill\s+(?:a\s+|an\s+)?(?:creature|land|artifact|enchantment|planeswalker)\b/i.test(isText)) {
          isTypeAddition = true;
          isColorAddition = true;
        }

        // Extract inline P/T: "X/Y [subtype] [type]" or "[subtype] [type] with base power and toughness X/Y"
        // IMPORTANT: Check "with base power and toughness X/Y" FIRST so the greedy
        // inline P/T regex doesn't strip the digits and leave "with base power and toughness" mangled.
        const withPT = isText.match(/with\s+(?:base\s+)?power\s+and\s+toughness\s+(\d+)\/(\d+)/i);
        if (withPT) {
          extractedPT = { power: parseInt(withPT[1]), toughness: parseInt(withPT[2]) };
          isText = isText.replace(/with\s+(?:base\s+)?power\s+and\s+toughness\s+\d+\/\d+/i, '').trim();
        }
        if (!extractedPT) {
          const inlinePT = isText.match(/(\d+)\/(\d+)/);
          if (inlinePT) {
            extractedPT = { power: parseInt(inlinePT[1]), toughness: parseInt(inlinePT[2]) };
            isText = isText.replace(/\d+\/\d+/, '').trim();
          }
        }
        // "with power and toughness each equal to its mana value" (Animate Artifact, etc.)
        const withMVPT = isText.match(/with\s+(?:base\s+)?power\s+and\s+(?:base\s+)?toughness\s+(?:each\s+)?equal\s+to\s+(?:its|their)\s+(?:mana\s+value|converted\s+mana\s+cost)/i);
        if (withMVPT) {
          extractedUseMV = true;
          isText = isText.replace(/\s*with\s+(?:base\s+)?power\s+and\s+(?:base\s+)?toughness\s+(?:each\s+)?equal\s+to\s+(?:its|their)\s+(?:mana\s+value|converted\s+mana\s+cost)/i, '').trim();
        }

        // Extract "with [abilities]" — quoted or keyword
        const withAbMatch = isText.match(/with\s+(.+)/i);
        if (withAbMatch) {
          const withText = withAbMatch[1];
          // "with no abilities" = remove abilities
          if (/^no\s+abilit/i.test(withText)) {
            hasLoseAbilities = true;
          } else {
            // Quoted abilities: "with '{T}: Add {C}'" or "with "{T}, Sacrifice a creature: You gain life equal to the sacrificed creature's toughness.""
            // Use double-quote matching that allows apostrophes inside
            const quotedMatch = withText.match(/[""\u201c]((?:[^""\u201d]|'(?!(?:\s|$|,)))*)[""\u201d]/g);
            if (quotedMatch) {
              for (const q of quotedMatch) {
                quotedAbilities.push(q.replace(/^[""\u201c]|[""\u201d]$/g, '').trim().replace(/\.$/, ''));
              }
            }
            // Keyword abilities: "with indestructible"
            const kwText = withText.replace(/[""\u201c](?:[^""\u201d]|'(?!(?:\s|$|,)))*[""\u201d]/g, '').trim();
            if (kwText) {
              const kws = parseKeywordList(kwText);
              for (const kw of kws) abilitiesToGrant.push(kw);
            }
          }
          isText = isText.replace(/\s+with\s+.*/i, '').trim();
        }

        // Now parse remaining isText for colors, types, subtypes
        // First, extract "named [Name]" — everything after "named" is the new name
        const namedMatch = isText.match(/\bnamed\s+(.+)/i);
        if (namedMatch) {
          extractedName = namedMatch[1].replace(/[.,;]+$/, '').trim();
          isText = isText.replace(/\s+named\s+.*/i, '').trim();
        }
        const words = isText.split(/\s+/);
        for (const word of words) {
          const wl = word.toLowerCase().replace(/[.,;]/g, '');
          if (['a', 'an', 'the', 'that', 'are', 'is', 'it', 'they', 'and', 'or', 'named'].includes(wl)) continue;
          if (/^\d+$/.test(wl)) continue;
          // "colorless" = set empty colors
          if (wl === 'colorless') { isColorless = true; continue; }
          // Color
          if (COLOR_NAMES[wl]) { extractedColors.push(COLOR_NAMES[wl]); continue; }
          // Card type
          const ct = CARD_TYPE_WORDS[wl];
          if (ct && ct.check === 'type') { extractedTypes.push(ct.value); typeWasExplicit = true; continue; }
          // Land subtype
          const ls = LAND_SUBTYPE_WORDS[wl];
          if (ls) { extractedSubtypes.push(ls); isLandSubtype = true; continue; }
          // Keyword that appeared before "with" (like "Indestructible 0/1")
          if (KEYWORD_LIST.some(k => wl === k)) {
            abilitiesToGrant.push(wl.charAt(0).toUpperCase() + wl.slice(1));
            continue;
          }
          // Subtype (capitalized word not in skip list)
          const cap = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase().replace(/[.,;]/g, '');
          if (cap.length > 1 && !['In', 'To', 'Of', 'Their', 'Its', 'Other', 'Still', 'Also',
              'Addition', 'Types', 'Type', 'All', 'Each', 'Every', 'Basic', 'Nonbasic',
              'Non', 'Control', 'You', 'Your', 'Colors', 'Color', 'Mana', 'Any',
              'Has', 'Have', 'Gains', 'Gain', 'Gets', 'Get', 'Loses', 'Lose',
              'Abilities', 'Ability', 'Plus', 'Except', 'But', 'Not', 'No',
              'They', 'Them', 'These', 'Those', 'This', 'That', 'Same',
              'Named', 'Called', 'Chosen', 'Target', 'Base', 'Power', 'Toughness'].includes(cap)) {
            const singular = singularizeCreatureType(cap);
            if (!extractedSubtypes.includes(singular)) extractedSubtypes.push(singular);
          }
        }
        continue;
      }

      // "has [keyword]" / "gains [keyword]" (standalone clause)
      const hasKw = cl.match(/^(?:has|gains?)\s+(.+)$/);
      if (hasKw) {
        const kwText = hasKw[1].trim();
        // Check for quoted ability (use original-case clause for proper display)
        const origHasKw = clause.match(/^(?:has|gains?)\s+(.+)$/i);
        const origKwText = origHasKw ? origHasKw[1].trim() : kwText;
        const quotedMatch = origKwText.match(/[""\u201c]((?:[^""\u201d]|'(?!(?:\s|$|,)))*)[""\u201d]/);
        if (quotedMatch) {
          quotedAbilities.push(quotedMatch[1].trim().replace(/\.$/, ''));
          continue;
        }
        // Check for protection (may be compound: "protection from black and from red")
        if (kwText.startsWith('protection from')) {
          const splitProts = _splitProtectionAbilities(kwText);
          for (const prot of splitProts) abilitiesToGrant.push(prot);
          continue;
        }
        const kws = parseKeywordList(kwText);
        if (kws.length > 0) {
          for (const kw of kws) abilitiesToGrant.push(kw);
          continue;
        }
        // Single keyword fallback
        if (KEYWORD_LIST.some(k => kwText.toLowerCase() === k) || /^\w+$/.test(kwText)) {
          abilitiesToGrant.push(kwText.charAt(0).toUpperCase() + kwText.slice(1));
          continue;
        }
      }

      // Standalone keyword without "has" prefix (e.g. "lifelink" as orphaned clause from "has trample and lifelink")
      if (kwSet.has(cl) || KEYWORD_LIST.some(k => cl === k)) {
        abilitiesToGrant.push(cl.charAt(0).toUpperCase() + cl.slice(1));
        continue;
      }
      // Parameterized keyword without "has" prefix (e.g. "ward {2}", "toxic 1")
      const paramKwMatch = cl.match(/^(\w+(?:\s+\w+)?)\s+(.+)$/);
      if (paramKwMatch && (kwSet.has(paramKwMatch[1]) || PARAMETERIZED_KEYWORDS.has(paramKwMatch[1]))) {
        const kwBase = paramKwMatch[1].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        abilitiesToGrant.push(`${kwBase} ${paramKwMatch[2]}`);
        continue;
      }
      // Two-word keyword without "has" (e.g. "first strike")
      if (kwSet.has(cl.toLowerCase())) {
        abilitiesToGrant.push(cl.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
        continue;
      }
      // Fix #7: Bare quoted ability without "has" prefix (e.g. from 'has "ability1" and "ability2"')
      // After splitting on "and", the second clause may just be a quoted ability
      const bareQuotedMatch = clause.match(/^[""\u201c]((?:[^""\u201d]|'(?!(?:\s|$|,)))*)[""\u201d]$/);
      if (bareQuotedMatch) {
        quotedAbilities.push(bareQuotedMatch[1].trim().replace(/\.$/, ''));
        continue;
      }
    }

    // Validate extracted subtypes against Scryfall's TypeCatalog:
    // filter out words that aren't real MTG subtypes (parser noise).
    if (typeof TypeCatalog !== 'undefined' && TypeCatalog.loaded) {
      extractedSubtypes = extractedSubtypes.filter(s => TypeCatalog.classifySubtype(s) !== 'unknown');
    }

    // Infer: if land subtypes found but no Land type, add Land
    if (isLandSubtype && !extractedTypes.includes('Land')) extractedTypes.push('Land');
    // Infer: if creature subtypes found but no Creature type (and no Land/Artifact-only type), add Creature
    // This handles "is a Citizen" — "is a Creature — Citizen", "is a Frog" — "is a Creature — Frog"
    if (extractedSubtypes.length > 0 && !isLandSubtype && extractedTypes.length === 0) {
      extractedTypes.push('Creature');
    }
    // If creature subtypes present alongside other types (like Artifact), also add Creature
    // if the subtypes look like creature types (not artifact subtypes like Treasure, Equipment, etc.)
    if (extractedSubtypes.length > 0 && extractedTypes.length > 0 && !extractedTypes.includes('Creature')) {
      const ARTIFACT_SUBTYPES = ['Treasure', 'Equipment', 'Vehicle', 'Food', 'Clue', 'Blood', 'Gold', 'Map', 'Powerstone', 'Incubator'];
      const hasCreatureSubtype = extractedSubtypes.some(s => !ARTIFACT_SUBTYPES.includes(s) && !Object.values(LAND_SUBTYPE_WORDS).includes(s));
      if (hasCreatureSubtype) extractedTypes.push('Creature');
    }


    // General rule: unless the card explicitly states a new permanent type (e.g. "is a Creature"),
    // assume the enchanted permanent retains its existing types — only add the new subtypes.
    // typeWasExplicit is false when Creature was inferred from creature subtypes only.
    if (hasIsClause && !typeWasExplicit && !isLandSubtype && !isTypeAddition) {
      subtypeOnlyReplace = true; // replace subtypes only, keep existing permanent types
    }
    // --- Generate effects, deduplicating against earlier parsers ---
    const sid = permanent.id;
    const hasTargetedEffect = (type, layer) =>
      effects.some(e => e.type === type && (!layer || e.layer === layer) && e.sourceId === sid && e.scope === 'targeted');

    const _enchCtx = { appliesTo: null, scope: 'targeted' };

    // Layer 3: Name change (e.g. "named Legitimate Businessperson")
    if (extractedName) {
      pushEff('3', EFFECT_TYPE.SET_NAME, { name: extractedName }, _enchCtx,
        `Enchanted permanent is named "${extractedName}".`);
    }

    // Layer 4: Type change (only if "is" clause found with types/subtypes)
    if (hasIsClause && (extractedTypes.length > 0 || extractedSubtypes.length > 0)) {
      if (isTypeAddition) {
        // "in addition to" = ADD_TYPE
        if (!hasTargetedEffect(EFFECT_TYPE.ADD_TYPE, '4')) {
          pushEff('4', EFFECT_TYPE.ADD_TYPE,
            { types: extractedTypes, subtypes: extractedSubtypes }, _enchCtx,
            `Enchanted permanent is also ${[...extractedTypes, ...extractedSubtypes].join(' ')}.`);
        }
      } else if (subtypeOnlyReplace) {
        // "is a [subtype]" with no explicit type word: REPLACE creature subtypes,
        // KEEP existing types and supertypes.
        if (!hasTargetedEffect(EFFECT_TYPE.SET_TYPE, '4')) {
          pushEff('4', EFFECT_TYPE.SET_TYPE,
            { subtypes: extractedSubtypes, replaceSubtypeCategory: 'creature', keepSupertypes: true, keepTypes: true },
            _enchCtx,
            `Enchanted permanent's subtypes become ${extractedSubtypes.join(' ')}.`);
        }
      } else {
        // "is a [Type]" with explicit type = SET_TYPE (full replacement, supertypes preserved).
        if (!hasTargetedEffect(EFFECT_TYPE.SET_TYPE, '4')) {
          // "Enchant creature" + only Creature type → scope to creature characteristics only
          // (Kenrith's Transformation preserves Ashaya's Land type/Forest subtype). "Enchant
          // permanent" + "loses all card types" replaces the full type line (Song of the Dryads).
          const useCreatureOnlySemantics = enchantTargetIsCreatureOnly && !hasLoseCardTypes
            && !isLandSubtype && extractedTypes.every(t => t === 'Creature');
          const params = useCreatureOnlySemantics
            ? { subtypes: extractedSubtypes, replaceSubtypeCategory: 'creature', keepSupertypes: true, keepTypes: true }
            : { types: extractedTypes, subtypes: extractedSubtypes, keepSupertypes: true };
          pushEff('4', EFFECT_TYPE.SET_TYPE, params, _enchCtx,
            `Enchanted permanent becomes ${[...extractedTypes, ...extractedSubtypes].join(' ')}.`);
        }
      }
    }

    // Layer 5: Color change (only if colors explicitly mentioned or "colorless")
    if (extractedColors.length > 0 || isColorless) {
      if (isColorAddition) {
        if (!hasTargetedEffect(EFFECT_TYPE.ADD_COLOR, '5') && extractedColors.length > 0) {
          pushEff('5', EFFECT_TYPE.ADD_COLOR, { colors: extractedColors }, _enchCtx,
            `Enchanted permanent gains color${extractedColors.length > 1 ? 's' : ''}: ${extractedColors.join(', ')}.`);
        }
      } else if (!hasTargetedEffect(EFFECT_TYPE.SET_COLOR, '5')) {
        pushEff('5', EFFECT_TYPE.SET_COLOR, { colors: extractedColors }, _enchCtx,
          `Enchanted permanent is ${extractedColors.length ? extractedColors.join(', ') : 'colorless'}.`);
      }
    }

    // Layer 6: Ability removal / granting
    const allReplaceWith = [...abilitiesToGrant, ...quotedAbilities];
    if (hasLoseAbilities || hasLoseAllCreatureTypes) {
      if (!hasTargetedEffect(EFFECT_TYPE.REMOVE_ABILITIES, '6')) {
        pushEff('6', EFFECT_TYPE.REMOVE_ABILITIES,
          { replaceWith: allReplaceWith.length > 0 ? allReplaceWith : undefined,
            losesAllCreatureTypes: hasLoseAllCreatureTypes || undefined },
          _enchCtx,
          `Enchanted permanent${hasLoseAbilities ? ' loses all abilities' : ''}${hasLoseAllCreatureTypes ? ' loses all creature types' : ''}${allReplaceWith.length ? ` and gains: ${allReplaceWith.join(', ')}` : ''}.`);
      }
    } else {
      for (const ab of allReplaceWith) {
        if (!effects.some(e => e.layer === '6' && e.params.ability === ab && e.sourceId === sid && e.scope === 'targeted')) {
          pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability: ab }, _enchCtx,
            `Enchanted permanent gains ${ab}.`);
        }
      }
    }

    // Layer 6: Specific ability removal from "loses [keyword]" clauses
    if (specificAbilityRemovals.length > 0) {
      pushEff('6', EFFECT_TYPE.REMOVE_ABILITIES,
        { specificAbilities: specificAbilityRemovals }, _enchCtx,
        `Enchanted/Equipped permanent loses ${specificAbilityRemovals.join(', ')}.`);
    }

    // Layer 7b: Set P/T (only if P/T was found)
    if (extractedPT && !hasTargetedEffect(EFFECT_TYPE.SET_PT, '7b')) {
      pushEff('7b', EFFECT_TYPE.SET_PT,
        { power: extractedPT.power, toughness: extractedPT.toughness }, _enchCtx,
        `Enchanted permanent has base P/T ${extractedPT.power}/${extractedPT.toughness}.`);
    }
    // Layer 7b: Set P/T equal to mana value (Animate Artifact, etc.)
    if (extractedUseMV && !extractedPT && !hasTargetedEffect(EFFECT_TYPE.SET_PT, '7b')) {
      pushEff('7b', EFFECT_TYPE.SET_PT, { useMV: true }, _enchCtx,
        `Enchanted permanent has P/T equal to its mana value.`);
    }

    // Attach "as long as" condition to all effects generated from this match
    if (_matchCondition) {
      for (let ei = effectCountBefore; ei < effects.length; ei++) {
        effects[ei].asLongAsCondition = _matchCondition;
      }
    }
    // CR 613: Tag all effects from this enchant-transform ability with a shared group ID
    // so the engine knows they are all part of the same continuous effect.
    if (effects.length > effectCountBefore + 1) {
      const _enchGroupId = `${sid}_enchTransform_${effectCountBefore}`;
      for (let ei = effectCountBefore; ei < effects.length; ei++) {
        effects[ei].abilityGroupId = _enchGroupId;
      }
    }
  }

  // Store conditional ability indices on the permanent so the engine can exclude them
  // from the base state, while keeping them visible in the UI for display.
  // Saga chapter lines are NOT conditional abilities — they have separate saga threshold display.
  // Class level lines are NOT conditional abilities — they have separate class level display.
  // Leveler lines are NOT conditional abilities — they have separate leveler display.
  // Store as Map<abilityIndex, conditionFunction> so UI can evaluate condition state.
  if (_lineConditionMap.size > 0 && permanent.printedAbilities) {
    const condMap = new Map();
    for (const [li, condIdx] of _lineConditionMap) {
      // Exclude saga, class, and leveler lines
      if (_sagaLineThresholds.has(li)) continue;
      if (_classLineThresholds.has(li)) continue;
      if (_levelerLineData.has(li)) continue;
      if (_spacecraftLineData.has(li)) continue;
      // Exclude lines already handled by KNOWN_ABILITY_EFFECTS — those effects
      // have their own condition logic (e.g. asLongAsCondition) and should not
      // also be treated as conditional abilities by the generic display path.
      if (_knownHandledLines.has(li)) continue;
      condMap.set(li, _asLongAsConditions[condIdx]);
    }
    if (condMap.size > 0) {
      permanent._conditionalAbilityIndices = new Set(condMap.keys());
      permanent._conditionalAbilityConditions = condMap;
    }
  }

  // Generate SET_PT effects for leveler P/T brackets.
  // Each bracket's P/T override is conditional on level counters being in range.
  if (_isLeveler && _levelerBrackets.length > 0) {
    const srcId = permanent.id;
    for (const bracket of _levelerBrackets) {
      if (bracket.power === null || bracket.toughness === null) continue;
      const minLvl = bracket.min;
      const maxLvl = bracket.max;
      const levelerPTCond = (_permState, allStates) => {
        if (allStates) {
          const srcState = allStates.get(srcId);
          if (srcState) {
            const lvlCount = (srcState.counters && srcState.counters['level']) || 0;
            return lvlCount >= minLvl && lvlCount <= maxLvl;
          }
        }
        return false;
      };
      pushEff('7b', EFFECT_TYPE.SET_PT,
        { power: bracket.power, toughness: bracket.toughness },
        { appliesTo: null, scope: 'targeted', selfTarget: true, affectsSelf: true },
        `LEVEL ${minLvl}${maxLvl === Infinity ? '+' : '-' + maxLvl}: Set base P/T to ${bracket.power}/${bracket.toughness}.`,
        { asLongAsCondition: levelerPTCond });
    }
  }

  // Generate ADD_ABILITY effects for leveler bracket abilities.
  // Each ability line within a bracket is conditional on level counters being in range.
  // These replace the base state abilities that were filtered out.
  if (_isLeveler && _levelerBrackets.length > 0) {
    const srcId = permanent.id;
    for (let bIdx = 0; bIdx < _levelerBrackets.length; bIdx++) {
      const bracket = _levelerBrackets[bIdx];
      const minLvl = bracket.min;
      const maxLvl = bracket.max;
      
      // Find ability lines for this bracket from the leveler data
      for (const [lineIdx, data] of _levelerLineData) {
        if (data.bracket !== bIdx || data.isStructural || data.isPT || data.isLevelUp) continue;
        // This is an ability line in this bracket
        const abilityText = permanent.printedAbilities[lineIdx];
        if (!abilityText) continue;
        
        const levelerAbilCond = (_permState, allStates) => {
          if (allStates) {
            const srcState = allStates.get(srcId);
            if (srcState) {
              const lvlCount = (srcState.counters && srcState.counters['level']) || 0;
              return lvlCount >= minLvl && lvlCount <= maxLvl;
            }
          }
          return false;
        };
        
        // Pure-keyword-line check (e.g. "Flying, first strike") vs full ability text.
        // Handles parameterized keywords: "protection from X", "ward {N}", "hexproof from X".
        const kwText = abilityText.trim();
        const kwCandidates = kwText.toLowerCase().split(/\s*,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);
        const allKeywords = kwCandidates.every(_isKeywordLikeToken);
        
        const _selfCondCtx = { appliesTo: null, scope: 'targeted', selfTarget: true, affectsSelf: true };
        if (allKeywords && kwCandidates.length > 0) {
          // Pure keyword line — add each keyword separately
          for (const kw of kwCandidates) {
            pushEff('6', EFFECT_TYPE.ADD_ABILITY,
              { ability: kw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') },
              _selfCondCtx,
              `LEVEL ${minLvl}${maxLvl === Infinity ? '+' : '-' + maxLvl}: Gain ${kw}.`,
              { asLongAsCondition: levelerAbilCond });
          }
        } else {
          // Complex ability (activated/triggered) — add full text
          pushEff('6', EFFECT_TYPE.ADD_ABILITY, { ability: kwText }, _selfCondCtx,
            `LEVEL ${minLvl}${maxLvl === Infinity ? '+' : '-' + maxLvl}: Gain ability.`,
            { asLongAsCondition: levelerAbilCond });
        }
      }
    }
  }

  // Parse quoted ability text that itself grants global effects (e.g. Dancer's Chakram:

  // Generate effects for spacecraft station abilities.
  // For creature transformation: ADD_TYPE Creature + SET_PT at creatureThreshold.
  // For each N+ | ability line: parse the ability text part for keywords, boosts, etc.
  if (_isSpacecraft && permanent._spacecraftData) {
    const srcId = permanent.id;
    const sData = permanent._spacecraftData;

    // Creature transformation at creatureThreshold
    if (sData.creatureThreshold !== null) {
      const minCharge = sData.creatureThreshold;
      const ctCond = (_permState, allStates) => {
        if (allStates) {
          const srcState = allStates.get(srcId);
          if (srcState) return ((srcState.counters && srcState.counters['charge']) || 0) >= minCharge;
        }
        return false;
      };
      const _selfCondCtxSC = { appliesTo: null, scope: 'targeted', selfTarget: true, affectsSelf: true };
      pushEff('4', EFFECT_TYPE.ADD_TYPE, { types: ['Creature'] }, _selfCondCtxSC,
        `Station ${minCharge}+: Becomes an artifact creature.`,
        { asLongAsCondition: ctCond });
      // SET_PT uses the card's printed P/T
      if (permanent.printedPower !== null && permanent.printedToughness !== null) {
        pushEff('7b', EFFECT_TYPE.SET_PT,
          { power: permanent.printedPower, toughness: permanent.printedToughness },
          _selfCondCtxSC,
          `Station ${minCharge}+: Base P/T ${permanent.printedPower}/${permanent.printedToughness}.`,
          { asLongAsCondition: ctCond });
      }
    }

    // For each N+ | ability line, generate ADD_ABILITY effects for keywords.
    // The ability text after the pipe is what matters.
    for (const [lineIdx, info] of sData.thresholds) {
      const minCharge = info.min;
      const abilityText = info.abilityText;
      if (!abilityText) continue;

      const spacecraftAbilCond = (_permState, allStates) => {
        if (allStates) {
          const srcState = allStates.get(srcId);
          if (srcState) return ((srcState.counters && srcState.counters['charge']) || 0) >= minCharge;
        }
        return false;
      };

      const kwCandidates = abilityText.toLowerCase().split(/\s*,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);
      const allKeywords = kwCandidates.every(_isKeywordLikeToken);

      if (allKeywords && kwCandidates.length > 0) {
        const _selfCondCtxSC2 = { appliesTo: null, scope: 'targeted', selfTarget: true, affectsSelf: true };
        for (const kw of kwCandidates) {
          pushEff('6', EFFECT_TYPE.ADD_ABILITY,
            { ability: kw.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') },
            _selfCondCtxSC2,
            `Station ${minCharge}+: Gain ${kw}.`,
            { asLongAsCondition: spacecraftAbilCond });
        }
      }
      // Non-keyword abilities (like "Other creatures you control get +1/+1") are handled
      // by the generic parser since the "N+ | " prefix gets stripped by em-dash stripping.
      // We don't need to generate ADD_ABILITY for those — they create their own effects.
    }
  }

  // --- Trait parsing: goaded, suspected, and similar status traits ---
  // Matches patterns like: "goads target creature", "suspect it", "becomes goaded",
  // "is goaded", "[filter] are goaded", "[filter] becomes suspected"
  const TRAIT_KEYWORDS = {
    'goaded': 'Goaded', 'goad': 'Goaded', 'goads': 'Goaded',
    'suspected': 'Suspected', 'suspect': 'Suspected', 'suspects': 'Suspected',
  };
  // Pattern: "[filter] is/are/becomes goaded/suspected"
  const traitStateRegex = /\b(.+?)\s+(?:is|are|becomes?)\s+(goaded|suspected)\b/gi;
  let traitStateMatch;
  while ((traitStateMatch = traitStateRegex.exec(oracle)) !== null) {
    const filterText = traitStateMatch[1].trim();
    const traitName = TRAIT_KEYWORDS[traitStateMatch[2].toLowerCase()];
    if (!traitName) continue;
    const { fn, desc: filterDesc } = buildAppliesToFromText(filterText);
    pushEff('6', EFFECT_TYPE.ADD_ABILITY,
      { ability: traitName, isTrait: true },
      { appliesTo: fn, scope: fn ? 'global' : 'targeted', selfTarget: !fn },
      `${filterText} ${traitStateMatch[0].includes('are') ? 'are' : 'is'} ${traitName.toLowerCase()}. ${filterDesc}`,
      { _oraclePos: traitStateMatch.index });
  }
  // Pattern: "goad/goads/suspect/suspects [target/filter]"
  const traitVerbRegex = /\b(goads?|suspects?)\s+(.+?)(?:\.|,|$)/gi;
  let traitVerbMatch;
  while ((traitVerbMatch = traitVerbRegex.exec(oracle)) !== null) {
    const verb = traitVerbMatch[1].toLowerCase();
    const traitName = TRAIT_KEYWORDS[verb];
    if (!traitName) continue;
    const targetText = traitVerbMatch[2].trim();
    const { fn, desc: filterDesc, isSpellTarget } = buildAppliesToFromText(targetText);
    const eff = pushEff('6', EFFECT_TYPE.ADD_ABILITY,
      { ability: traitName, isTrait: true },
      { appliesTo: fn, scope: fn ? 'global' : 'targeted', selfTarget: false },
      `${verb} ${targetText}. ${filterDesc}`,
      { _oraclePos: traitVerbMatch.index });
    if (isSpellTarget) {
      eff.scope = 'targeted';
      eff.targetRestriction = fn || null;
    }
  }

  // Parse quoted ability text
  // equipped creature has "Other commanders you control get +2/+2 and have lifelink").
  // When such an ADD_ABILITY effect is targeted (scope:'targeted'), the quoted text may
  // contain boost or keyword-grant patterns that should generate real global effects,
  // conditioned on the source being equipped/attached (targetId being set).
  _parseGrantedGlobalAbilities(permanent, effects);

  // --- "target player gains control of target [types] you control" → Layer 2 CONTROL
  // effect where the new controller is a user-chosen player (dropdown). Pattern: Bazaar Trader.
  // Guard against activated abilities on the static permanent: only emit when this is a
  // fired/manual-effect pseudo-permanent (the `{T}:` prefix is stripped by extractActivatedAbilities).
  {
    const tpgcRegex = /\btarget player gains control of target (.+?) you control\b/i;
    const tpgcMatch = oracle.match(tpgcRegex);
    const isActivatedCost = /^[^\n]*\{[^}]+\}[^:\n]*:/m.test(oracle);
    if (tpgcMatch && !isActivatedCost && !effects.some(e => e.type === EFFECT_TYPE.CONTROL)) {
      permanent._targetsChosenPlayer = true;
      permanent._youControlRequired = true;
      const chosenPlayer = permanent._targetPlayerId || null;
      const typeText = tpgcMatch[1].trim();
      // Build a target-filter function from the captured type text so the UI can
      // render a permanent-picker dropdown filtered to e.g. "artifact, creature, or land".
      // Handle disjunctive type lists ("X, Y, or Z") by splitting and OR-ing, since
      // buildAppliesToFromText alone collapses comma-separated types into an AND.
      let targetRestriction = null;
      const parts = typeText.split(/\s*,\s*|\s+or\s+/i).map(s => s.trim()).filter(Boolean);
      const subFns = [];
      for (const part of parts) {
        const br = buildAppliesToFromText(part);
        if (br && br.fn) subFns.push(br.fn);
      }
      if (subFns.length) {
        targetRestriction = (st) => subFns.some(fn => fn(st));
      }
      pushEff('2', EFFECT_TYPE.CONTROL,
        { newController: chosenPlayer },
        { appliesTo: null, scope: 'targeted', selfTarget: false },
        `Target player gains control of target ${typeText} you control.`,
        { _targetPlayerControl: true, youControlRequired: true, targetRestriction });
    }
  }

  // --- "gain control of [target/enchanted] [type]" → Layer 2 CONTROL effect ---
  // Skip if KNOWN_ABILITY_EFFECTS already handled this card
  if (!effects.some(e => e.type === EFFECT_TYPE.CONTROL)) {
    const gainControlRegex = /\bgain control of (target |enchanted )?(.+?)(?:\s+until end of turn)?\.?(?:\s|$)/gi;
    let gcMatch;
    let emittedControl = false;
    while ((gcMatch = gainControlRegex.exec(oracle)) !== null) {
      // Skip if inside a triggered ability sentence (When/Whenever/At)
      const lineStart = oracle.lastIndexOf('\n', gcMatch.index);
      const lineText = oracle.substring(lineStart + 1, gcMatch.index + gcMatch[0].length);
      if (_isTriggeredSentence(lineText.trim())) continue;
      // Skip if inside an activated ability (cost:effect format, e.g. "{T}: ...")
      const fullLine = oracle.substring(lineStart + 1, oracle.indexOf('\n', gcMatch.index) === -1 ? oracle.length : oracle.indexOf('\n', gcMatch.index));
      if (/^[^:]*\{[^}]+\}[^:]*:/.test(fullLine)) continue;
      // Skip "target player gains control of ..." — handled above with dropdown
      if (/\btarget player gains control of\b/i.test(lineText)) continue;

      const qualifier = (gcMatch[1] || '').trim(); // 'target' or 'enchanted' or ''
      const targetType = gcMatch[2].trim();
      const isTargeted = qualifier === 'target' || qualifier === 'enchanted';

      // The non-greedy (.+?) stops at the first space, so gcMatch[0] only contains
      // "gain control of target creature " — "an opponent controls" and "until end of turn"
      // are left unmatched. Use the full oracle sentence (to the next period) for these checks.
      const sentenceStart = oracle.lastIndexOf('\n', gcMatch.index) + 1;
      const dotIdx = oracle.indexOf('.', gcMatch.index);
      const sentenceEnd = dotIdx === -1 ? oracle.length : dotIdx + 1;
      const fullSentence = oracle.slice(sentenceStart, sentenceEnd);

      // Skip a conditional duration restatement: "..., gain control of that creature
      // until the end of your next turn instead." — the "instead" replaces the duration
      // of a control we already emitted (e.g. Evil's Thrall: "Gain control of target
      // creature until end of turn. If you control a Villain ..., gain control of that
      // creature ... instead."). It refers back to the same target via a "that <noun>"/
      // "it"/"them" pronoun, so it is not a separate control of additional permanents.
      const refersBackToPriorTarget = /^(?:that\b|it$|them$)/i.test(targetType);
      if (emittedControl && refersBackToPriorTarget && /\binstead\b/i.test(fullSentence)) continue;

      const isUntilEOT = /until end of turn/i.test(fullSentence);
      const opponentCtrlRequired = /\bopponent(?:'?s?)?\s+controls?\b/i.test(fullSentence);

      // For spells (isManualEffect): if "target" appears anywhere in the sentence
      // (e.g. "Untap target permanent and gain control of it"), the "it" pronoun
      // refers to the spell's target. Treat as 'targeted' so the engine requires
      // a targetId before applying — prevents contaminating all permanents' states.
      const sentenceHasTarget = /\btarget\b/i.test(fullSentence);
      const effectScope = (isTargeted || (permanent.isManualEffect && sentenceHasTarget))
        ? 'targeted' : 'global';

      // For global scope, extract the full target type from fullSentence (the non-greedy regex
      // only captures the first word of the type, e.g. "all" from "gain control of all creatures").
      // Also resolves pronouns: "gain control of them" where "them" refers to "all [type]"
      // earlier in the same sentence (e.g. Insurrection: "Untap all creatures and gain control
      // of them until end of turn.").
      // Build an appliesTo filter so e.g. Insurrection only affects creatures, not all permanents.
      let appliesToFn = null;
      if (effectScope === 'global') {
        const gcPhraseIdx = fullSentence.toLowerCase().indexOf('gain control of ');
        if (gcPhraseIdx !== -1) {
          let fullTypeText = fullSentence.slice(gcPhraseIdx + 'gain control of '.length);
          // Remove leading qualifier (target/enchanted)
          fullTypeText = fullTypeText.replace(/^(target|enchanted)\s+/i, '');
          // Remove "all/each/every" prefix
          fullTypeText = fullTypeText.replace(/^(?:all|each|every)\s+/i, '');
          // Remove " until end of turn" and everything after
          fullTypeText = fullTypeText.replace(/\s+until end of turn[\s\S]*$/i, '');
          // Remove controller qualifiers
          fullTypeText = fullTypeText.replace(/\s+(?:an?\s+)?(?:opponent(?:'?s?)?\s+controls?|you\s+control)$/i, '');
          // Remove trailing punctuation/whitespace
          fullTypeText = fullTypeText.replace(/[.,;]\s*$/, '').trim();
          // Resolve pronoun "them"/"it" by finding "all/each/every [type]" earlier in the sentence
          if (fullTypeText === 'it' || fullTypeText === 'them') {
            const pronounRef = fullSentence.slice(0, gcPhraseIdx)
              .match(/\b(?:all|each|every)\s+(\w+)/i);
            if (pronounRef) fullTypeText = pronounRef[1];
          }
          if (fullTypeText && fullTypeText !== 'it' && fullTypeText !== 'them') {
            const btResult = buildAppliesToFromText(fullTypeText);
            if (btResult && btResult.fn && !btResult.isSelf && !btResult.isTargeted) {
              appliesToFn = btResult.fn;
            }
          }
        }
      }

      pushEff('2', EFFECT_TYPE.CONTROL,
        { newController: permanent.owner || 'player_0', untilEndOfTurn: isUntilEOT },
        { appliesTo: appliesToFn, scope: effectScope, selfTarget: false },
        `Gain control of ${qualifier ? qualifier + ' ' : ''}${targetType}${isUntilEOT ? ' until end of turn' : ''}.`,
        { opponentControlRequired: opponentCtrlRequired });
      emittedControl = true;
    }

    // "you control enchanted [type]" on auras → Layer 2 CONTROL for the enchanted permanent
    const youControlEnchanted = oracle.match(/\byou control enchanted (creature|permanent|artifact|enchantment|land|planeswalker)\b/i);
    if (youControlEnchanted && !effects.some(e => e.type === EFFECT_TYPE.CONTROL)) {
      pushEff('2', EFFECT_TYPE.CONTROL,
        { newController: permanent.owner || 'player_0', useSourceController: true },
        { appliesTo: null, scope: 'targeted', selfTarget: false },
        `You control enchanted ${youControlEnchanted[1]}.`);
    }
  }

  // --- "exchange control of ..." → Layer 2 CONTROL exchange effect ---
  if (!effects.some(e => e.type === EFFECT_TYPE.CONTROL && e.params.exchangeControl)) {
    const exchangeControlRegex = /\bexchange control of\s+(.+?)(?:\.\s*|$)/gi;
    let exchMatch;
    while ((exchMatch = exchangeControlRegex.exec(oracle)) !== null) {
      // Skip if inside a triggered ability sentence (When/Whenever/At)
      const lineStart = oracle.lastIndexOf('\n', exchMatch.index);
      const lineText = oracle.substring(lineStart + 1, exchMatch.index + exchMatch[0].length);
      if (_isTriggeredSentence(lineText.trim())) continue;

      const captured = exchMatch[1].trim();
      const capLower = captured.toLowerCase();

      // Classify the pattern
      let exchangeMode = 'two_targets';
      let exchangeSelfId = null;
      let shareTypeRequired = false;
      let differentPlayersRequired = false;
      let opponentCtrlRequired = false;
      let neitherOwnNorControlRequired = false;
      let targetTypeText = '';
      let maxTargets = 2;

      if (/^this\s+(?:creature|artifact|enchantment|permanent|card)\s+and\s+/i.test(captured)) {
        // Pattern A: "this [type] and [target type]"
        exchangeMode = 'self_and_target';
        exchangeSelfId = permanent.id;
        maxTargets = 1;
        targetTypeText = captured.replace(/^this\s+\S+\s+and\s+/i, '').trim();
      } else if (/^two\s+target\s+/i.test(captured)) {
        // Pattern B: "two target [type]"
        targetTypeText = captured.replace(/^two\s+target\s+/i, '').trim();
      } else if (/^target\s+.+?\s+and\s+target\s+/i.test(captured)) {
        // Pattern B variant: "target X and target Y" (Trade the Helm)
        targetTypeText = captured;
      } else if (/^those\s+/i.test(captured)) {
        // Pattern D: "those permanents/creatures" (Confusion in the Ranks pronoun)
        targetTypeText = captured.replace(/^those\s+/i, '').trim();
      } else {
        // Generic fallback
        targetTypeText = captured;
      }

      // Parse constraints from full sentence
      const sentenceStart = oracle.lastIndexOf('\n', exchMatch.index) + 1;
      const dotIdx = oracle.indexOf('.', exchMatch.index);
      const sentenceEnd = dotIdx === -1 ? oracle.length : dotIdx + 1;
      const fullSentence = oracle.slice(sentenceStart, sentenceEnd);
      if (/\bshare\s+a\s+(?:permanent|card)\s+type\b/i.test(fullSentence)) shareTypeRequired = true;
      if (/\bcontrolled\s+by\s+different\s+players\b/i.test(fullSentence)) differentPlayersRequired = true;
      if (/\bopponent(?:'?s?)?\s+controls?\b/i.test(fullSentence)) opponentCtrlRequired = true;
      if (/\byou\s+don'?t\s+control\b/i.test(fullSentence)) opponentCtrlRequired = true;
      if (/\byou\s+neither\s+own\s+nor\s+control\b/i.test(fullSentence)) { opponentCtrlRequired = true; neitherOwnNorControlRequired = true; }

      // Build target restriction function from the type text
      let targetRestriction = null;
      let cleanTypeText = targetTypeText
        .replace(/\s+(?:an?\s+)?(?:opponent(?:'?s?)?\s+controls?|you\s+(?:control|don'?t\s+control)).*$/i, '')
        .replace(/\s+you\s+neither\s+(?:own|control)\b.*$/i, '') // e.g. "target permanent you neither own nor control"
        .replace(/\s+controlled\s+by\s+different\s+players.*$/i, '')
        .replace(/\s+that\s+share\s+a\s+(?:permanent|card)\s+type.*$/i, '')
        .replace(/\s+(?:its|their)\s+controller\s+controls\b.*$/i, '') // e.g. "target permanent its controller controls"
        .replace(/^(?:up\s+to\s+\w+\s+)?(?:target\s+)?/i, '')
        .replace(/[.,;]\s*$/, '')
        .trim();
      // For "target X and target Y" split, use first type for restriction
      const splitTargets = cleanTypeText.match(/^(.+?)\s+and\s+target\s+(.+)$/i);
      if (splitTargets) {
        cleanTypeText = splitTargets[1].trim();
        // Could use splitTargets[2] for second target type — for now treat uniformly
      }
      if (cleanTypeText) {
        const btResult = buildAppliesToFromText(cleanTypeText);
        if (btResult && btResult.fn) {
          targetRestriction = (st) => btResult.fn(st);
        }
      }

      pushEff('2', EFFECT_TYPE.CONTROL, {
          exchangeControl: true,
          exchangeMode,
          exchangeTargetA: exchangeSelfId,
          exchangeTargetB: null,
          snapshotControllerA: null,
          snapshotControllerB: null,
          exchangeSelfId,
          shareTypeRequired,
          differentPlayersRequired,
        },
        { scope: 'targeted', selfTarget: false },
        `Exchange control of ${captured}.`,
        {
          opponentControlRequired: opponentCtrlRequired,
          neitherOwnNorControl: neitherOwnNorControlRequired,
          targetRestriction,
          maxTargets,
        });
    }
  }

  // Post-process: for instant/sorcery spell effects that have scope:'targeted' from
  // "target [type]" parsing, attach targetRestriction and maxTargets so the UI can
  // show appropriate target dropdowns with type filtering.
  if (permanent.isManualEffect) {
    // Tag all effects from spells so the engine can enforce timestamp-order targeting:
    // spell effects only affect permanents that existed before the spell was cast.
    for (const eff of effects) { eff.isSpellEffect = true; }
    // For spells, "It"/"that creature" pronouns refer to the spell's target, not
    // the spell card itself. Convert selfTarget effects to targeted effects with
    // a dropdown so the user can select which creature the spell targets.
    for (const eff of effects) {
      if (eff.selfTarget === true && eff.scope === 'targeted') {
        eff.selfTarget = false;
        eff.appliesTo = null;
      }
    }
    for (const eff of effects) {
      if (eff.scope === 'targeted' && !eff.selfTarget && !eff.targetRestriction) {
        // Re-extract target info from the effect's desc to get restriction + maxTargets
        const descLower = (eff.desc || '').toLowerCase();
        // Try to find the original filter text from the desc (before "get"/"have"/"gains" etc.)
        // The restriction fn is already set as appliesTo for global effects, but for targeted
        // effects appliesTo is null. We need to rebuild it from the desc or store it.
        // Since buildAppliesToFromText now returns the info, store it during creation.
        // For effects that didn't go through _applyTargetInfo, build from oracle text.
      }
    }
    // Also scan for maxTargets from any effect that has it and propagate to all from same source
    const maxT = effects.find(e => e.maxTargets)?.maxTargets;
    if (maxT) {
      for (const eff of effects) {
        if (eff.scope === 'targeted' && !eff.selfTarget) {
          eff.maxTargets = maxT;
          if (!eff.targetIds) eff.targetIds = [];
        }
      }
    }
  }

  // --- Tag and sort modal spell effects by mode order ---
  // For modal spells, tag each effect with its modalModeIndex based on which oracle
  // line it was parsed from. Uses _oraclePos (regex match position) when available,
  // falling back to desc-based specificity matching.
  if (_isModalSpell && _modalModeLineMap.size > 0) {
    // Helper: map oracle char position → modal mode index
    function _getModalModeForPos(pos) {
      let adj = pos;
      while (adj < oracle.length && /[.\s;]/.test(oracle[adj])) adj++;
      const lineNum = oracle.substring(0, adj).split('\n').length - 1;
      return _modalModeLineMap.has(lineNum) ? _modalModeLineMap.get(lineNum) : -1;
    }
    const oLines = oracle.split('\n');
    const sortedModes = [..._modalModeLineMap.entries()].sort((a, b) => a[0] - b[0]);
    for (const eff of effects) {
      // Primary: use _oraclePos if available (set by boost/haveAbility/loseAll parsers)
      if (eff._oraclePos !== undefined) {
        const mode = _getModalModeForPos(eff._oraclePos);
        if (mode >= 0) { eff.modalModeIndex = mode; continue; }
      }
      // Fallback: desc-based specificity matching (penalize unmatched line words)
      const effDesc = (eff.desc || '').toLowerCase();
      let bestMode = 0, bestSpec = -Infinity;
      for (const [lineIdx, modeIdx] of sortedModes) {
        const lineText = (oLines[lineIdx] || '').toLowerCase();
        if (!lineText) continue;
        const words = lineText.replace(/[^a-z0-9+\-/ ]/g, '').trim().split(/\s+/).filter(w => w.length > 2);
        const hits = words.filter(w => effDesc.includes(w)).length;
        const misses = words.filter(w => !effDesc.includes(w)).length;
        const spec = hits * 10 - misses;
        if (spec > bestSpec) { bestSpec = spec; bestMode = modeIdx; }
      }
      eff.modalModeIndex = bestMode;
    }
    // Sort effects by modalModeIndex to ensure card text order
    effects.sort((a, b) => (a.modalModeIndex ?? 999) - (b.modalModeIndex ?? 999));
    if (!permanent.modalRepeatable) {
      const allModeIndices = [...new Set([..._modalModeLineMap.values()])].sort((a, b) => a - b);
      const maxActive = permanent.modalMaxActive ?? 1;
      const initiallyActive = new Set(maxActive === Infinity ? allModeIndices : allModeIndices.slice(0, maxActive));
      for (const eff of effects) {
        if (eff.modalModeIndex !== undefined) eff.disabled = !initiallyActive.has(eff.modalModeIndex);
      }
    }
  }

  // --- "exiled with" / "in exile with" ability-granting effects (Layer 6) ---
  // Generic parser for:
  //   "[subject] (has|have) all activated abilities of [all] cards [you own] (in exile with | exiled with) <ref>."
  // Covers Mairsil the Pretender ("...all cards you own in exile with cage counters on them")
  // and Agatha's Soul Cauldron ("creatures you control with +1/+1 counters ... exiled with this card").
  // oracleRaw is already self-ref-normalized (card name → "this card").
  if (!effects.some(e => e.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_EXILE)) {
    // The optional word before "cards" is captured so a "creature cards exiled with…" scope
    // (Agatha's Soul Cauldron) can be honored — the engine then only gains from cards that are
    // creatures in exile, using their COMPUTED zone state (so Grist, the Hunger Tide qualifies).
    const exiledWithRegex = /^(.+?)\s+(?:has|have)\s+all\s+activated(\s+and\s+triggered)?\s+abilities\s+of\s+(?:all\s+|each\s+)?(\w+\s+)?cards?\s+(you\s+own\s+)?(?:in\s+exile\s+with|exiled\s+with)\s+([^.\n]+)/im;
    const exiledWithMatch = exiledWithRegex.exec(oracleRaw);
    if (exiledWithMatch) {
      const subjectRaw = exiledWithMatch[1].trim().toLowerCase();
      const includeTriggered = !!exiledWithMatch[2];
      const _typeWord3 = (exiledWithMatch[3] || '').trim().toLowerCase();
      const requireCreature = _typeWord3 === 'creature';
      // Any other type qualifier ("land cards exiled with…" — Steward of the Harvest) gates the
      // engine on the exiled card's printed type line. Creature keeps its computed-zone path below.
      const _typeInfo3 = (_typeWord3 && !requireCreature) ? normalizeTypeWord(_typeWord3) : null;
      const requireCardType = _typeInfo3 ? _typeInfo3.value : null;
      const requireOwnerMatch = !!(exiledWithMatch[4] && /you\s+own/i.test(exiledWithMatch[4]));
      const refRaw = exiledWithMatch[5].trim().toLowerCase();

      // Parse params from the reference clause
      let filterCounter = null;
      let filterTagToSource = false;
      // "cage counters on them" / "cage counter on them" → filterCounter='cage'
      const counterOnThemMatch = refRaw.match(/^([\w+\-/]+(?:\s+[\w+\-/]+)?)\s+counters?\s+on\s+them$/);
      if (counterOnThemMatch) {
        filterCounter = counterOnThemMatch[1].replace(/\s+counters?$/, '').trim();
        filterTagToSource = false;
      } else if (/^(?:it|this card|this creature|this permanent|this artifact)$/.test(refRaw)) {
        filterTagToSource = true;
      } else {
        // Unrecognized reference — skip
      }

      if (filterCounter !== null || filterTagToSource) {
        // Parse the subject into scope/appliesTo
        let selfTarget = false;
        let scope = 'global';
        let appliesToFn = null;

        if (subjectRaw === 'this card' || subjectRaw === 'this creature' || subjectRaw === 'this permanent') {
          selfTarget = true;
          scope = 'targeted';
        } else {
          // Normalize for buildAppliesToFromText: "creatures you control with +1/+1 counters"
          // → "creatures you control with a +1/+1 counter on them" so existing filter matches
          let normalizedSubject = subjectRaw
            .replace(/\bwith\s+\+1\/\+1\s+counters(?:\s+on\s+(?:it|them))?\b/, 'with a +1/+1 counter on them')
            .replace(/\bwith\s+([\w+\-/]+)\s+counters(?:\s+on\s+(?:it|them))?\b/, 'with a $1 counter on them');
          const bResult = buildAppliesToFromText(normalizedSubject);
          appliesToFn = bResult ? bResult.fn : null;
        }

        // Build desc
        const descSubject = selfTarget ? 'This card' : subjectRaw.charAt(0).toUpperCase() + subjectRaw.slice(1);
        const descCardWord = requireCreature ? 'creature cards' : (requireCardType ? `${requireCardType.toLowerCase()} cards` : 'cards');
        const descRef = filterCounter ? `${descCardWord} exiled with ${filterCounter} counters on them` : `${descCardWord} exiled with this card`;
        const descAbilities = includeTriggered ? 'activated and triggered abilities' : 'activated abilities';
        const desc = `${descSubject} has all ${descAbilities} of ${descRef}.`;

        // A global subject like "Creatures you control" includes the source itself unless it says
        // "other" — so the granting permanent also gains the abilities when it matches the filter.
        const affectsSelf = selfTarget ? true : detectSelfAffect(subjectRaw);
        pushEff('6', EFFECT_TYPE.GAIN_ACTIVATED_FROM_EXILE,
          { filterCounter, filterTagToSource, requireOwnerMatch, includeTriggered, requireCreature, requireCardType },
          { appliesTo: appliesToFn || null, scope, selfTarget: selfTarget || undefined, affectsSelf },
          desc);
      }
    }
  }

  // --- "<subject> has all activated [and triggered] abilities of all <type> on the battlefield" (Layer 6) ---
  // Covers Manascape Refractor ("This artifact has all activated abilities of all lands on the battlefield.").
  // Emits GAIN_ACTIVATED_FROM_OTHERS with a type filter; the engine scans every permanent's current
  // abilities. Unlike Marvin (same controller, different name), this gains from ALL matching permanents.
  if (!effects.some(e => e.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS)) {
    const fromBattlefieldRegex = /^(.+?)\s+(?:has|have)\s+all\s+activated(\s+and\s+triggered)?\s+abilities\s+of\s+(?:all\s+|each\s+|every\s+)?([a-z]+)\s+on\s+the\s+battlefield\b/im;
    const bfMatch = fromBattlefieldRegex.exec(oracleRaw);
    if (bfMatch) {
      const subjectRaw = bfMatch[1].trim().toLowerCase();
      const includeTriggered = !!bfMatch[2];
      const typeWord = bfMatch[3].trim().toLowerCase();
      const typeInfo = normalizeTypeWord(typeWord);
      const requireType = typeInfo ? typeInfo.value : null; // null = "permanents" (any type)
      // Only proceed when the qualifier is a recognized card-type word (land/creature/artifact/…).
      if (typeInfo) {
        let selfTarget = false, scope = 'global', appliesToFn = null;
        if (/^this\s+(?:card|creature|permanent|artifact|enchantment|land|planeswalker)$/.test(subjectRaw)) {
          selfTarget = true;
          scope = 'targeted';
        } else {
          const bResult = buildAppliesToFromText(subjectRaw);
          appliesToFn = bResult ? bResult.fn : null;
        }
        const descSubject = selfTarget ? 'This permanent' : subjectRaw.charAt(0).toUpperCase() + subjectRaw.slice(1);
        const descAbilities = includeTriggered ? 'activated and triggered abilities' : 'activated abilities';
        pushEff('6', EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS,
          { requireType, includeTriggered, sameController: false, differentName: false },
          { appliesTo: appliesToFn || null, scope, selfTarget: selfTarget || undefined, affectsSelf: selfTarget || false },
          `${descSubject} has all ${descAbilities} of all ${typeWord} on the battlefield.`);
      }
    }
  }

  // --- "<subject> has all activated [and triggered] abilities of [each other] <type> with a +1/+1 counter on it" (Layer 6) ---
  // Covers Experiment Kraj ("Experiment Kraj has all activated abilities of each other creature with a +1/+1 counter on it.").
  // Like the "on the battlefield" form above, but restricted to permanents that currently have a +1/+1
  // counter. "Other" is handled by the engine's self-skip; the counter restriction rides on requireCounter.
  if (!effects.some(e => e.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS)) {
    const counterQualRegex = /^(.+?)\s+(?:has|have)\s+all\s+activated(\s+and\s+triggered)?\s+abilities\s+of\s+(?:all\s+|each\s+|every\s+)?(?:other\s+)?([a-z]+)\s+with\s+a\s+\+1\/\+1\s+counter\s+on\s+(?:it|them)\b/im;
    const cqMatch = counterQualRegex.exec(oracleRaw);
    if (cqMatch) {
      const subjectRaw = cqMatch[1].trim().toLowerCase();
      const includeTriggered = !!cqMatch[2];
      const typeWord = cqMatch[3].trim().toLowerCase();
      const typeInfo = normalizeTypeWord(typeWord);
      const requireType = typeInfo ? typeInfo.value : null; // null = any type
      if (typeInfo) {
        let selfTarget = false, scope = 'global', appliesToFn = null;
        if (/^this\s+(?:card|creature|permanent|artifact|enchantment|land|planeswalker)$/.test(subjectRaw)) {
          selfTarget = true;
          scope = 'targeted';
        } else {
          const bResult = buildAppliesToFromText(subjectRaw);
          appliesToFn = bResult ? bResult.fn : null;
        }
        const descSubject = selfTarget ? 'This permanent' : subjectRaw.charAt(0).toUpperCase() + subjectRaw.slice(1);
        const descAbilities = includeTriggered ? 'activated and triggered abilities' : 'activated abilities';
        pushEff('6', EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS,
          { requireType, requireCounter: '+1/+1', includeTriggered, sameController: false, differentName: false },
          { appliesTo: appliesToFn || null, scope, selfTarget: selfTarget || undefined, affectsSelf: selfTarget || false },
          `${descSubject} has all ${descAbilities} of each other ${typeWord} with a +1/+1 counter on it.`);
      }
    }
  }

  // --- Imprint-style "<subject> has all activated [and triggered] abilities of the exiled card" ---
  // Covers Idris, Soul of the TARDIS ("Idris has all activated and triggered abilities of the exiled card...").
  // Distinct from exiledWithRegex above because the reference is the singular "the exiled card",
  // not "cards exiled with <ref>". Always filters to exile entries tagged with this source.
  if (!effects.some(e => e.type === EFFECT_TYPE.GAIN_ACTIVATED_FROM_EXILE)) {
    const imprintAbilitiesRegex = /^(.+?)\s+(?:has|have)\s+all\s+activated(\s+and\s+triggered)?\s+abilities\s+of\s+the\s+exiled\s+cards?\b/im;
    const imprintMatch = imprintAbilitiesRegex.exec(oracleRaw);
    if (imprintMatch) {
      const subjectRaw = imprintMatch[1].trim().toLowerCase();
      const includeTriggered = !!imprintMatch[2];
      let selfTarget = false;
      let scope = 'global';
      let appliesToFn = null;
      if (subjectRaw === 'this card' || subjectRaw === 'this creature' || subjectRaw === 'this permanent') {
        selfTarget = true;
        scope = 'targeted';
      } else {
        const bResult = buildAppliesToFromText(subjectRaw);
        appliesToFn = bResult ? bResult.fn : null;
      }
      const descSubject = selfTarget ? 'This card' : subjectRaw.charAt(0).toUpperCase() + subjectRaw.slice(1);
      const descAbilities = includeTriggered ? 'activated and triggered abilities' : 'activated abilities';
      pushEff('6', EFFECT_TYPE.GAIN_ACTIVATED_FROM_EXILE,
        { filterCounter: null, filterTagToSource: true, requireOwnerMatch: false, includeTriggered },
        { appliesTo: appliesToFn || null, scope, selfTarget: selfTarget || undefined, affectsSelf: selfTarget || false },
        `${descSubject} has all ${descAbilities} of the exiled card.`);
    }
  }

  // --- Imprint "<subject> has the power, toughness, and creature types of the last creature card exiled with it" ---
  // Covers Duplicant. P/T (Layer 7b) and creature subtypes (Layer 4) are resolved at apply time
  // from the most-recent imprinted exile entry that is itself a creature card.
  {
    const duplicantRegex = /^(.+?)\s+has\s+the\s+power,?\s+toughness,?\s+and\s+creature\s+types\s+of\s+(?:the\s+(?:last|imprinted|exiled)\s+)?creature\s+card(?:\s+exiled\s+with\s+it)?/im;
    const duplicantMatch = duplicantRegex.exec(oracleRaw);
    if (duplicantMatch) {
      const subjectRaw = duplicantMatch[1].trim().toLowerCase();
      const isSelf = /\b(?:this\s+(?:card|creature|permanent))\b/.test(subjectRaw);
      const _impCtx = { appliesTo: null, scope: 'targeted', selfTarget: isSelf || undefined, affectsSelf: isSelf || false };
      pushEff('4', EFFECT_TYPE.ADD_TYPE,
        { subtypes: [], fromImprintedCardCreatureTypes: true, requireCreature: true },
        _impCtx,
        `Gains creature types of the last creature card exiled with it.`);
      pushEff('7b', EFFECT_TYPE.SET_PT,
        { power: 0, toughness: 0, fromImprintedCardPT: true, requireCreature: true },
        _impCtx,
        `Sets P/T to the last creature card exiled with it.`);
    }
  }

  // --- Imprint "<subject> has protection from each of the exiled card's card types" ---
  // Covers Mirror Golem. The granted abilities are determined at apply time from the imprinted card.
  {
    const protTypesRegex = /^(.+?)\s+(?:has|have)\s+protection\s+from\s+each\s+of\s+(?:that|the)\s+(?:exiled|imprinted)?\s*card['’]?s?\s+card\s+types?/im;
    const protTypesMatch = protTypesRegex.exec(oracleRaw);
    if (protTypesMatch) {
      const subjectRaw = protTypesMatch[1].trim().toLowerCase();
      const isSelf = subjectRaw === 'this card' || subjectRaw === 'this creature' || subjectRaw === 'this permanent';
      pushEff('6', EFFECT_TYPE.IMPRINT_PROTECTION_FROM_TYPES, {},
        { appliesTo: null, scope: 'targeted', selfTarget: isSelf || undefined, affectsSelf: isSelf || false },
        `${isSelf ? 'This card' : protTypesMatch[1].trim()} has protection from each of the exiled card's card types.`);
    }
  }

  // --- Imprint "<subject> gets +X/+Y, where X is the exiled card's power and Y is its toughness" ---
  // Covers Phyrexian Ingester. X and Y vary independently — we cannot reuse "for each"
  // (which multiplies a single count by both base values). Emits MODIFY_PT with a
  // fromExiledCardPT flag that the engine resolves at apply time.
  {
    const exiledPTRegex = /^(.+?)\s+gets\s+\+X\/\+Y,?\s+where\s+X\s+is\s+the\s+(?:exiled|imprinted)\s+(?:creature\s+)?card['’]?s?\s+power\s+and\s+Y\s+is\s+its\s+toughness/im;
    const exiledPTMatch = exiledPTRegex.exec(oracleRaw);
    if (exiledPTMatch) {
      const subjectRaw = exiledPTMatch[1].trim().toLowerCase();
      const isSelf = subjectRaw === 'this card' || subjectRaw === 'this creature' || subjectRaw === 'this permanent';
      pushEff('7c', EFFECT_TYPE.MODIFY_PT,
        { power: 0, toughness: 0, fromExiledCardPT: true },
        { appliesTo: null, scope: 'targeted', selfTarget: isSelf || undefined, affectsSelf: isSelf || false },
        `Gets +X/+Y, where X is the exiled card's power and Y is its toughness.`);
    }
  }

  return _finalizeEffects(effects, isEquipmentSource, permanent, card.oracle_text);
}
/* [END: PARSE] */
