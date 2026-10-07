/* cards-helpers.js — small misc helpers used across the cards modules. */

function _parseWordNumber(word) {
  const map = { once: 1, twice: 2, thrice: 3, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const n = map[word.toLowerCase()];
  if (n) return n;
  const parsed = parseInt(word, 10);
  return isNaN(parsed) ? 1 : parsed;
}

/* For triggered/activated abilities, "this creature"/"it" parsed as selfTarget
   gets converted to an untargeted targeted effect by the spell post-processor.
   Pin those effects back to the source permanent so they auto-apply without a dropdown. */
function _pinAbilityEffectsToSource(effects, sourcePermId) {
  for (const eff of effects) {
    if (eff.scope === 'targeted' && !eff.selfTarget && !eff.targetId && (!eff.targetIds || eff.targetIds.length === 0)) {
      // Don't auto-pin effects that have a target restriction (e.g. "target Cat you control",
      // "target creature") — these need the user to pick a target via the dropdown.
      if (eff.targetRestriction) continue;
      eff.targetId = sourcePermId;
      eff._autoTargetSource = true; // suppress target dropdown in UI
    }
  }
}

/* In a fired ability's effect text, "it gains/gets/…" means the source when the effect has
   already named the source and nothing else it could stand for:
     "untap this creature. It gains protection from the color of your choice …" (Pristine Skywise)
     "put a +1/+1 counter on this creature and it gains trample until end of turn"
   The pronoun is rewritten to that "this creature" phrase so the effect parses as the source's
   own and _pinAbilityEffectsToSource pins it. Left alone when the text before the pronoun
   names anything else "it" could be: a target (The Wondrous Wasp: "tap up to one target
   creature. It loses all abilities"), a token or card the effect made or moved, or any other
   object. A pronoun whose antecedent is only in the trigger condition ("Whenever another Cat
   you control attacks, it gains trample") has no "this creature" before it and is untouched. */
const _ABILITY_SELF_PHRASE_RE = /\bthis\s+(?:creature|permanent|card|token|land|artifact|enchantment|planeswalker|vehicle|equipment|aura|spacecraft|battle|saga)\b/gi;
const _ABILITY_IT_RIVAL_RE = /\b(?:target|creates?|tokens?|cards?|cop(?:y|ies)|creatures?|permanents?|artifacts?|lands?|enchantments?|planeswalkers?|spells?|auras?|equipment|vehicles?|them)\b/i;
// Case-sensitive on purpose: a capitalised word after an article is a subtype ("a Goblin").
const _ABILITY_IT_SUBTYPE_RIVAL_RE = /\b(?:[Aa]n?|[Aa]nother|[Ee]ach|[Tt]hat|[Tt]hose|[Tt]he|[Oo]ther)\s+[A-Z][a-z]+/;
function _resolveItToAbilitySource(text) {
  if (!/\bit\b/i.test(text) || !/\bthis\b/i.test(text)) return text;
  return text.replace(/\bit\s+(?=(?:gets?|gains?|has|have|is|becomes?|loses?)\b)/gi, (whole, offset) => {
    const before = text.slice(0, offset);
    if ((before.match(/"/g) || []).length % 2) return whole; // inside a quoted ability
    const selves = before.match(_ABILITY_SELF_PHRASE_RE);
    if (!selves) return whole;
    const others = before.replace(_ABILITY_SELF_PHRASE_RE, ' ');
    if (_ABILITY_IT_RIVAL_RE.test(others) || _ABILITY_IT_SUBTYPE_RIVAL_RE.test(others)) return whole;
    const phrase = selves[selves.length - 1];
    return (whole[0] === 'I' ? 'T' : 't') + phrase.slice(1) + ' ';
  });
}

/* The target a pronoun in a fired ability's effect text stands for: the nearest "target …"
   phrase before it that names a permanent — "up to one target creature you control", "target
   artifact, creature, or non-Aura enchantment card with mana value 3 or less" (Excava, the Risen
   Past), "target Elf" (Tyvar Kell), "target attacking Vampire that isn't a Demon". Returned as
   "target <what>", loose on purpose: the count ("up to one", "another"), "card", whose it is
   unless yours ("an opponent controls", "you don't control") and trailing conditions are
   dropped, so the phrase can admit too much but never turns the real target away. A targeted player ("target opponent draws a card. Put a +1/+1 counter on target
   creature. It gains flying" — Ms. Bumbleflower) is skipped. Null when the nearest target is
   something else (a spell, an ability, a card named …), when a word in it is not a known type,
   when a token was made in between ("Create a token that's a copy of that card …. It gains
   haste" is about the token), or when the pronoun is in a copy's exception ("this creature
   becomes a copy of another target creature you control, except it has this ability" — Aurora
   Shifter — is about the copier). */
const _TARGET_PHRASE_WORD = String.raw`non-?[\w-]+|attacking|blocking|tapped|untapped|legendary|nonlegendary|basic|snow|white|blue|black|red|green|colorless|multicolored`;
const _TARGET_PHRASE_NOUN = String.raw`creature|land|artifact|enchantment|planeswalker|permanent|battle|token`;
// Case-sensitive on purpose: a capitalised word is a subtype ("target Mount or Vehicle").
const _TARGET_PHRASE_RE = new RegExp(
  String.raw`^target\s+((?:(?:${_TARGET_PHRASE_WORD}|${_TARGET_PHRASE_NOUN}|or|[A-Z][\w'-]*),?\s+)*(?:${_TARGET_PHRASE_NOUN}|[A-Z][\w'-]*)\b)(\s+you (?:control|own)\b)?`);
function _isKnownSubtypeWord(word) {
  if (typeof TypeCatalog === 'undefined') return false;
  return ['creatureTypes', 'landTypes', 'artifactTypes', 'enchantmentTypes', 'planeswalkerTypes', 'battleTypes']
    .some(k => TypeCatalog[k] && TypeCatalog[k].has(word));
}
function _abilityTargetBefore(text, offset) {
  const before = text.slice(0, offset);
  const starts = [];
  const re = /\btarget\b/gi;
  for (let m; (m = re.exec(before)) !== null;) starts.push(m.index);
  for (let i = starts.length - 1; i >= 0; i--) {
    const rest = 't' + before.slice(starts[i] + 1);
    if (/^target\s+(?:players?|opponents?)\b/i.test(rest) || /\bany\s+$/i.test(before.slice(0, starts[i]))) continue;
    const m = rest.match(_TARGET_PHRASE_RE);
    if (!m) return null;
    if ((m[1].match(/\b[A-Z][\w'-]*/g) || []).some(w => !_isKnownSubtypeWord(w))) return null;
    const since = before.slice(starts[i]);
    if (/\bcreates?\b/i.test(since) || /\bexcept\b[^.]*$/i.test(since)) return null;
    return m[0];
  }
  return null;
}

/* A rider on the object a fired ability just named — "Target creature can't be blocked this
   turn. If it's a Vampire, it also gains lifelink …" (Wedding Invitation), "put a flood counter
   on another target creature or land. If it's a land, it becomes an Island …" (The Flood of
   Mars). Runs after _resolveItToAbilitySource, so a rider about the source already reads "this
   creature"; here a rider whose "it" is the ability's target gets that target as its subject,
   which keeps the generic "it → target <trigger subject>" rewrite (a non-targeting pick of the
   wrong kind of object) off it. A rider with neither antecedent is left for that rewrite. */
function _resolveRiderSubjectToTarget(text) {
  if (!/\b(?:if|as long as) it\b/i.test(text)) return text;
  const sentences = _splitSentencesOutsideQuotes(text);
  for (let i = 1; i < sentences.length; i++) {
    const m = sentences[i].match(_BRANCH_RIDER_RE);
    const pron = m && m[3].match(/^(?:it's(?=\s+an?\s)|it\b|that (?:creature|permanent)\b)/i);
    if (!pron || /\bturn\b/i.test(m[2])) continue;
    const ante = _branchAntecedent(sentences, i);
    if (!ante || !/\btarget\b/i.test(ante)) continue;
    const isContraction = /'s$/i.test(pron[0]);
    sentences[i] = `${m[1]} ${m[2]}, ${ante.charAt(0).toLowerCase() + ante.slice(1)}${isContraction ? ' is' : ''}${m[3].slice(pron[0].length)}`;
  }
  return sentences.join(' ');
}

/* Returns the total mana spent to cast a permanent, accounting for X.
   For cards with {X} in their mana cost, xValue (the chosen X) is added to manaValue
   (which treats X as 0). For all other cards, equals manaValue. */
function getSpentToCast(perm) {
  const hasManaX = /\{[XYZ]\}/.test(perm.manaCost || '');
  return (perm.manaValue || 0) + (hasManaX ? (perm.xValue ?? 0) : 0);
}

/* Effective display base-name for a permanent, as shown in dropdowns / pickers.
   A permanent that is copying another card (Clone-style) shows the copied card's
   name followed by "(copy)" instead of its own printed name. */
function _permEffectiveBaseName(p) {
  if (!p) return '';
  if (typeof Battlefield !== 'undefined' && typeof EFFECT_TYPE !== 'undefined' && Array.isArray(Battlefield.effects)) {
    const copyEff = Battlefield.effects.find(e =>
      e.sourceId === p.id && e.type === EFFECT_TYPE.COPY && e.params && e.params.copySource && e.params.copySource.name);
    if (copyEff) return copyEff.params.copySource.name + ' (copy)';
  }
  return p.name;
}

/* Full display name for a permanent: effective base-name plus the
   duplicate-disambiguation letter label (A/B/C…) when one is assigned. */
function permDisplayName(p) {
  if (!p) return '';
  const base = _permEffectiveBaseName(p);
  return p.label ? base + ' ' + p.label : base;
}

/* Generate an Excel-style label string from a 0-based index within a duplicate-name group.
   0→A, 1→B, …, 25→Z, 26→AA, 27→AB, …, 701→ZZ, 702→AAA, … */
function _permLabelString(n) {
  let s = '';
  let v = n + 1; // make 1-based
  while (v > 0) {
    v--;
    s = String.fromCharCode(65 + (v % 26)) + s;
    v = Math.floor(v / 26);
  }
  return s;
}

// A modal trigger's first line: "Whenever this card becomes blocked, choose one —" (Bill Ferny,
// Bree Swindler). The modes follow as separate "• …" lines. Returns the line without its
// closing dash, or null. The dash is not an ability word's, so the ability-word strip must
// not see it.
function _modalTriggerHeader(text) {
  const t = String(text || '').trim();
  if (!/[\u2014—]$/.test(t)) return null;
  const head = t.replace(/\s*[\u2014—]$/, '');
  return /(?:^|[\u2014—]\s*)(?:when(?:ever)?|at)\b[^\n]*,\s*(?:you may\s+)?choose\s[^\n]*$/i.test(head) ? head : null;
}

/* Index of the comma that ends a trigger condition ("Whenever X, <effect>"), or -1.
   Usually the first comma, but a condition can hold a comma list of its own:
     "Whenever you cast an instant, sorcery, or Wizard spell, this creature gets +2/+0 …"
     "Whenever a Mutant, Ninja, or Turtle you control enters, investigate."
   A comma is part of such a list when a single item ("an instant") sits right before it and
   only more one- or two-word items lead up to the closing "or" / "and". */
function _triggerConditionCommaIndex(text) {
  let idx = text.indexOf(',');
  if (idx < 0) return -1;
  const before = text.slice(0, idx);
  const after = text.slice(idx + 1);
  if (!/\b(?:an?|another|each|one or more|two or more)\s+(?:non-?\w+\s+)?[\w'-]+$/i.test(before)) return idx;
  const list = after.match(/^\s+(?:[\w'-]+(?:\s[\w'-]+)?,\s+)*(?:or|and|and\/or)\s+\S/i);
  if (!list) return idx;
  // The list's own commas are behind us; the next one closes the condition.
  const end = text.indexOf(',', idx + 1 + list[0].length - 1);
  return end < 0 ? idx : end;
}

// "…base power becomes equal to that creature's power" / "… of target creature": the number
// comes from another object, which the user picks after the ability is fired. The sentence is
// rewritten to a plain "has base power 0" for the parser, and the returned spec says which of
// the picked object's stats fills each number (_addAbilityPseudo puts it on the SET_PT effect
// as params.ptFromRef; the engine reads the stats from the fire-time snapshot).
//   Belligerent Yearling, Eldrazi Mimic, Shape Stealer — "that creature" of the trigger condition
//   Riptide Mangler, Halfdane, Sworn Defender          — a target
// Returns { text, ptFromRef: { power, toughness }, pick: { filter, isTarget, excludeSource, youControl } } or null.
function _basePTFromOtherObject(text, fullText) {
  const SELF = "this (?:card|creature|permanent)";
  const DUR = "(\\s+until end of turn)?(?:\\s+until [^.,;\\n]+)?";
  const OBJ = "(that creature|target creature)";
  let m, ptFromRef = null, obj = null, dur = '', other = false;
  const whole = (re) => (m = text.match(new RegExp("(?:you may have )?" + re, 'i')));
  if (whole(`(${SELF})'s base power and toughness becomes? equal to (?:${OBJ}'s power and toughness|the power and toughness of ${OBJ}( other than ${SELF})?)${DUR}`)) {
    ptFromRef = { power: { stat: 'power', add: 0 }, toughness: { stat: 'toughness', add: 0 } };
    obj = m[2] || m[3]; other = !!m[4]; dur = m[5] || '';
  } else if (whole(`(${SELF})'s base (power|toughness) becomes? equal to ${OBJ}'s (power|toughness)${DUR}`)) {
    ptFromRef = { power: null, toughness: null };
    ptFromRef[m[2].toLowerCase()] = { stat: m[4].toLowerCase(), add: 0 };
    obj = m[3]; dur = m[5] || '';
  } else if (whole(`(${SELF})'s power becomes the toughness of target creature[^,.]*? minus (\\d+) until end of turn, and its toughness becomes (\\d+) plus the power of that creature until end of turn`)) {
    ptFromRef = { power: { stat: 'toughness', add: -parseInt(m[2], 10) }, toughness: { stat: 'power', add: parseInt(m[3], 10) } };
    obj = 'target creature'; other = true; dur = ' until end of turn';
  }
  if (!ptFromRef) return null;
  const both = ptFromRef.power && ptFromRef.toughness;
  const subj = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const plain = both ? `${subj} has base power and toughness 0/0${dur}`
    : `${subj} has base ${ptFromRef.power ? 'power' : 'toughness'} 0${dur}`;
  const isTarget = /^target/i.test(obj);
  const pick = { filter: 'creature', isTarget, excludeSource: other, youControl: false };
  if (!isTarget) {
    // "that creature" is the one the trigger condition names.
    const cond = String(fullText || '').split('\n')[0];
    const named = cond.match(/\b(another|an?)\s+([^,]+?)\s+(you control\s+)?(?:enters|attacks|dies|blocks)\b/i);
    if (named) {
      pick.filter = named[2].trim();
      pick.excludeSource = /^another$/i.test(named[1]);
      pick.youControl = !!named[3];
    } else {
      pick.excludeSource = true; // "blocks or becomes blocked by a creature" (Shape Stealer)
    }
  }
  return { text: text.replace(m[0], plain), plain, original: m[0], ptFromRef, pick };
}

// Fire-time values for "base power/toughness becomes equal to …" abilities. The effect locks in
// a number as the ability resolves (CR 608.2h), so the text is rewritten with that number from
// the snapshot the ability was fired against and then parsed as a plain "has base power N".
//   "…base power and toughness of other creatures you control become equal to this card's
//    power and toughness" (Tanazir Quandrix)           → "… become 4/4"
//   "this creature's base power becomes equal to the number of Towns you control" (PuPu UFO)
//   "this creature's base toughness becomes equal to 1 plus the number of creature cards in
//    your graveyard" (Wall of Tombstones)
//   "this card's base power become 1 plus the greatest power among other creatures you
//    control" (Arni Brokenbrow)
function _lockFireTimeBasePT(text, states, sourceId) {
  const src = states && states.get(sourceId);
  if (!src || !/\bbase (?:power|toughness)\b/i.test(text)) return text;
  const p = src.power || 0, t = src.toughness || 0;
  const SELF = "this (?:card|creature|permanent)'s";
  text = text
    .replace(new RegExp("\\b(base power and toughness\\b[^.\\n]*?\\bbecomes?) equal to " + SELF + " power and toughness\\b", 'gi'), `$1 ${p}/${t}`)
    .replace(new RegExp("\\b(base power and toughness\\b[^.\\n]*?\\bbecomes?) equal to " + SELF + " power\\b", 'gi'), `$1 ${p}/${p}`)
    .replace(/\bIts (base power and toughness) becomes? (\d+\/\d+)/g, 'It has $1 $2')
    .replace(/\bits (base power and toughness) becomes? (\d+\/\d+)/g, 'it has $1 $2');
  const single = new RegExp("\\b(?:you may have )?(this (?:card|creature|permanent))'s base (power|toughness) becomes? (?:equal to )?(?:(\\d+) plus )?the (number of|greatest power among) ([^.;\\n]+?)(?=\\s+until\\b|[.;\\n]|$)", 'gi');
  return text.replace(single, (whole, subj, stat, plus, kind, desc) => {
    let n = null;
    if (/^number/i.test(kind)) {
      n = _computeForEachCount(desc.trim(), states, src, null);
      const own = desc.trim().match(/^(\w+) cards in your graveyard$/i);
      if (n == null && own) {
        const me = (Battlefield.players || []).find(pl => pl.id === (src.controller || 'player_0'));
        n = ((me && me.graveyard) || []).filter(c => _zoneCardMatchesQualifier(c, own[1])).length;
      } else if (n == null && /^\w+ (?:you control|on the battlefield)$/i.test(desc.trim())) {
        n = _computeCountClause(desc, states, src);
      }
    } else if (/^other creatures you control$/i.test(desc.trim())) {
      n = 0;
      for (const [id, st] of states) {
        if (id === sourceId || !st.types || !st.types.includes('Creature') || st.controller !== src.controller) continue;
        n = Math.max(n, st.power || 0);
      }
    }
    if (n === null || n === undefined) return whole;
    return `${subj} has base ${stat.toLowerCase()} ${n + (plus ? parseInt(plus, 10) : 0)}`;
  });
}
