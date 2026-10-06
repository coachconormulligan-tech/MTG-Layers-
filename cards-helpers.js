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
