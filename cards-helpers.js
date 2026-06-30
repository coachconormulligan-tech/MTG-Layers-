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
