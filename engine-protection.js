/* engine-protection.js — CR 702.16 "protection from X" parsing and matching.
   Extracted from engine-helpers.js for clarity. Loaded immediately after
   engine-helpers.js in index.html (cross-file globals are resolved at call-time,
   so load order only matters for the few top-level constants below).

   Public functions:
     _parseOneProtectionClause(clauseRaw) → entry|null
     _parseProtectionAbility(abilityLine) → entry[]
     _getStateProtection(state) → entry[]   (cached on state._protectionFrom)
     _protectionGrantTimestamp(targetPerm, protEntry) → timestamp
     _isProtectedFromSource(targetState, sourceState, sourcePerm, targetPerm) → entry|null
     _formatProtectionEntry(p) → string
*/

const _COLOR_NAME_TO_CODE = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const _CARD_TYPES_FOR_PROTECTION = new Set([
  'Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Land', 'Battle',
  'Instant', 'Sorcery', 'Tribal'
]);
function _parseOneProtectionClause(clauseRaw) {
  let x = clauseRaw.trim().toLowerCase().replace(/\.$/, '').trim();
  if (!x) return null;
  // Strip trailing duration suffixes ("until end of turn", "this turn", etc.)
  x = x.replace(/\s+(?:until\s+(?:end\s+of\s+turn|your\s+next\s+turn|the\s+end\s+of\s+(?:turn|your\s+next\s+turn))|this\s+turn)\s*$/i, '').trim();
  if (!x) return null;
  // Multi-word phrases first
  if (x === 'everything') return { kind: 'everything', value: null, raw: clauseRaw };
  if (x === 'all colors' || x === 'each color')
    return { kind: 'all_colors', value: null, raw: clauseRaw };
  if (x === 'monocolored') return { kind: 'monocolored', value: null, raw: clauseRaw };
  if (x === 'multicolored') return { kind: 'multicolored', value: null, raw: clauseRaw };
  if (x === 'colorless') return { kind: 'colorless', value: null, raw: clauseRaw };
  // First-word match wins for single-word kinds (color, equipment, aura, type, subtype).
  // This makes the parser tolerant of trailing modifiers we didn't strip.
  const firstWord = x.split(/\s+/)[0];
  if (_COLOR_NAME_TO_CODE[firstWord]) return { kind: 'color', value: _COLOR_NAME_TO_CODE[firstWord], raw: clauseRaw };
  if (firstWord === 'equipment') return { kind: 'subtype', value: 'Equipment', raw: clauseRaw };
  if (firstWord === 'aura' || firstWord === 'auras') return { kind: 'subtype', value: 'Aura', raw: clauseRaw };
  // Card type / subtype: try the full phrase first, then first word
  const sing = (typeof singularizeCreatureType === 'function')
    ? singularizeCreatureType(x)
    : (x.endsWith('s') ? x.charAt(0).toUpperCase() + x.slice(1, -1) : x.charAt(0).toUpperCase() + x.slice(1));
  if (_CARD_TYPES_FOR_PROTECTION.has(sing)) return { kind: 'cardType', value: sing, raw: clauseRaw };
  const singFirst = (typeof singularizeCreatureType === 'function')
    ? singularizeCreatureType(firstWord)
    : firstWord.charAt(0).toUpperCase() + firstWord.slice(1).replace(/s$/, '');
  if (_CARD_TYPES_FOR_PROTECTION.has(singFirst)) return { kind: 'cardType', value: singFirst, raw: clauseRaw };
  // Otherwise treat as subtype (Goblin, Cleric, Zombie, etc.) — use first word
  return { kind: 'subtype', value: singFirst, raw: clauseRaw };
}
function _parseProtectionAbility(abilityLine) {
  const out = [];
  if (!abilityLine) return out;
  const text = abilityLine.toLowerCase();
  const re = /protection from\s+([^.,;\n]+?(?:\s+and from\s+[^.,;\n]+?)*)(?=[.,;]|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    // Split compound: "black and from white" → ["black", "white"]
    const parts = body.split(/\s+and from\s+/i).map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      const parsed = _parseOneProtectionClause(part);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/* Re-derive structured protection from a state's abilities[] (after Layer 6).
   Cached on state._protectionFrom for the duration of evaluation. */
function _getStateProtection(state) {
  if (!state || !state.abilities) return [];
  if (state._protectionFrom) return state._protectionFrom;
  const all = [];
  for (const ab of state.abilities) {
    const parsed = _parseProtectionAbility(ab);
    for (const p of parsed) all.push(p);
  }
  state._protectionFrom = all;
  return all;
}

/* Find the timestamp at which a permanent acquired a particular protection entry.
   For PRINTED protection, returns targetPerm.timestamp (the perm's own timestamp).
   For GRANTED protection, returns the earliest timestamp of any ADD_ABILITY effect
   whose params.ability parses to a matching protection clause and which targets
   this perm. Used to gate one-time effects: a spell with timestamp earlier than the
   protection grant resolves "before" protection existed and ignores it. */
function _protectionGrantTimestamp(targetPerm, protEntry) {
  // Default to printed: the protection was on the perm from the start.
  let printedTs = (targetPerm && targetPerm.timestamp) || 0;
  // Check whether this entry came from the perm's PRINTED abilities (it was always there).
  const printed = (targetPerm && targetPerm.printedAbilities) || [];
  const matchesEntry = (parsedList) => parsedList.some(q =>
    q.kind === protEntry.kind && q.value === protEntry.value);
  for (const ab of printed) {
    if (matchesEntry(_parseProtectionAbility(ab))) return printedTs;
  }
  // Otherwise look for the granting effect on the battlefield.
  if (typeof Battlefield === 'undefined' || !Battlefield.effects) return printedTs;
  let earliest = Infinity;
  for (const eff of Battlefield.effects) {
    if (eff.type !== EFFECT_TYPE.ADD_ABILITY) continue;
    if (!eff.params || !eff.params.ability) continue;
    if (!matchesEntry(_parseProtectionAbility(eff.params.ability))) continue;
    // Check whether this effect actually targets/applies to targetPerm.
    if (eff.scope === 'targeted') {
      if (eff.targetId === targetPerm.id) {
        if (eff.timestamp != null && eff.timestamp < earliest) earliest = eff.timestamp;
      } else if (Array.isArray(eff.targetIds) && eff.targetIds.includes(targetPerm.id)) {
        if (eff.timestamp != null && eff.timestamp < earliest) earliest = eff.timestamp;
      }
    } else if (eff.scope === 'global' && typeof eff.appliesTo === 'function') {
      // Approximate: if the effect's filter would match this perm by name (we
      // can't easily run appliesTo here without state), be permissive — assume
      // the grant exists at the effect's timestamp.
      if (eff.timestamp != null && eff.timestamp < earliest) earliest = eff.timestamp;
    }
  }
  if (earliest !== Infinity) return earliest;
  return printedTs;
}

/* CR 702.16: returns a protection entry that matches `sourceState`/`sourcePerm`,
   or null if the target isn't protected from the source.
   Manual-effect spells (instants/sorceries fired as pseudo-perms) aren't tracked
   in allStates, so fall back to `sourcePerm.printed*` for colors/types/subtypes.
   `targetPerm` is optional but enables timestamp-aware bypass for one-time effects:
   a spell or activated ability whose timestamp predates the protection grant
   ignores that protection entry (the spell would have resolved before protection
   was acquired).

   CR 113.7: For triggered/activated ability pseudo-perms, the SOURCE for protection
   purposes is the original permanent that has the ability — not the pseudo-perm
   (whose printedTypes is ['Instant']). Re-resolve via `abilitySourceId` so e.g.
   Mother of Runes' activated ability counts as a Creature source. */
function _isProtectedFromSource(targetState, sourceState, sourcePerm, targetPerm) {
  const prots = _getStateProtection(targetState);
  if (!prots.length) return null;
  // Resolve the real ability-source perm for triggered/activated pseudo-perms.
  let realSourcePerm = sourcePerm;
  let realSourceState = sourceState;
  if (sourcePerm && sourcePerm.abilitySourceId &&
      (sourcePerm.isTriggeredAbility || sourcePerm.isActivatedAbility) &&
      typeof Battlefield !== 'undefined') {
    const orig = Battlefield.getPermById(sourcePerm.abilitySourceId);
    if (orig) {
      realSourcePerm = orig;
      // Attempt to use the real source's final state if accessible via Battlefield
      if (typeof Battlefield.getAllFinalStates === 'function') {
        const fs = Battlefield.getAllFinalStates();
        const rs = fs && fs.get && fs.get(orig.id);
        if (rs) realSourceState = rs;
      }
    }
  }
  // One-time-effect bypass: filter out protection entries acquired AFTER this source's timestamp.
  // Use the pseudo-perm's timestamp for the bypass (that's when the ability was activated/triggered),
  // not the real-source perm's timestamp.
  const isOneTimeSource = sourcePerm && sourcePerm.isManualEffect;
  const sourceTs = sourcePerm && sourcePerm.timestamp;
  let activeProts = prots;
  if (isOneTimeSource && targetPerm && sourceTs != null) {
    activeProts = prots.filter(p => {
      const grantTs = _protectionGrantTimestamp(targetPerm, p);
      return grantTs <= sourceTs;
    });
  }
  if (!activeProts.length) return null;
  const sColors = (realSourceState && realSourceState.colors) || (realSourcePerm && realSourcePerm.printedColors) || [];
  const sTypes = (realSourceState && realSourceState.types) || (realSourcePerm && realSourcePerm.printedTypes) || [];
  const sSubs = (realSourceState && realSourceState.subtypes) || (realSourcePerm && realSourcePerm.printedSubtypes) || [];
  const sName = (realSourceState && realSourceState.name) || (realSourcePerm && realSourcePerm.name) || '';
  const sIsAllCreatureTypes = !!(realSourceState && realSourceState.isAllCreatureTypes);
  for (const p of activeProts) {
    switch (p.kind) {
      case 'everything': return p;
      case 'colorless':
        if (sColors.length === 0) return p;
        break;
      case 'all_colors':
        if (sColors.length > 0) return p;
        break;
      case 'monocolored':
        if (sColors.length === 1) return p;
        break;
      case 'multicolored':
        if (sColors.length >= 2) return p;
        break;
      case 'color':
        if (sColors.includes(p.value)) return p;
        break;
      case 'cardType':
        if (sTypes.includes(p.value)) return p;
        break;
      case 'subtype':
        if (sSubs.includes(p.value)) return p;
        // Changeling / "is every creature type"
        if (sIsAllCreatureTypes && typeof TypeCatalog !== 'undefined' &&
            TypeCatalog.creatureTypes && TypeCatalog.creatureTypes.has(p.value)) return p;
        break;
      case 'name':
        if (sName === p.value) return p;
        break;
    }
  }
  return null;
}

function _formatProtectionEntry(p) {
  switch (p.kind) {
    case 'color': {
      const m = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
      return `protection from ${m[p.value] || p.value}`;
    }
    case 'all_colors': return 'protection from all colors';
    case 'monocolored': return 'protection from monocolored';
    case 'multicolored': return 'protection from multicolored';
    case 'colorless': return 'protection from colorless';
    case 'everything': return 'protection from everything';
    default: return `protection from ${p.value}`;
  }
}
