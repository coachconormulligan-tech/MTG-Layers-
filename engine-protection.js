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
     _parseHexproofEntries(abilities) → entry[]   (CR 702.11 "hexproof" / "hexproof from X")
     _hexproofFromSource(targetAbilities, targetState, sourceState, sourcePerm, allStates) → entry|null
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
/* Words that mean the text before "protection from" is a sentence, not a keyword list:
   an activated cost, a quoted ability, a trigger, or a grant to some object. */
const _PROTECTION_NON_KEYWORD_PREFIX = /[:"]|\b(?:gains?|ha(?:s|ve)|gets?|whenever|when|as long as)\b|^\s*(?:at|if)\b/;
/* Only a protection KEYWORD yields entries: "Protection from black", or an item of a
   keyword list ("Flying, trample, protection from white and from blue"). Abilities that
   merely grant protection ("{W}: Target creature gains protection from red until end of
   turn", "When ... gains protection from ...", "Equipped creature has protection from
   ...") yield nothing — the grant itself reaches state.abilities as a bare
   "Protection from X" line via ADD_ABILITY. */
function _parseProtectionAbility(abilityLine) {
  const out = [];
  if (!abilityLine) return out;
  const text = abilityLine.toLowerCase();
  const re = /(^|[,;\n]\s*)protection from\s+([^.,;\n]+?(?:\s+and from\s+[^.,;\n]+?)*)(?=[.,;\n]|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lineStart = text.lastIndexOf('\n', m.index + m[1].length - 1) + 1;
    if (_PROTECTION_NON_KEYWORD_PREFIX.test(text.slice(lineStart, m.index))) continue;
    const body = m[2].trim();
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

/* CR 113.7: the source of a fired triggered or activated ability (a pseudo-permanent) is the
   permanent that has the ability, read from allStates when given (inside evaluation), else
   from the final states. { perm, state }. */
function _protectionRealSource(sourceState, sourcePerm, allStates) {
  let realSourcePerm = sourcePerm;
  let realSourceState = sourceState;
  if (sourcePerm && sourcePerm.abilitySourceId &&
      (sourcePerm.isTriggeredAbility || sourcePerm.isActivatedAbility) &&
      typeof Battlefield !== 'undefined') {
    const orig = Battlefield.getPermById(sourcePerm.abilitySourceId);
    if (orig) {
      realSourcePerm = orig;
      // Use the real source's state: the in-progress one during evaluation, otherwise
      // its final state via Battlefield.
      const fs = allStates || (typeof Battlefield.getAllFinalStates === 'function'
        ? Battlefield.getAllFinalStates() : null);
      const rs = fs && fs.get && fs.get(orig.id);
      if (rs) realSourceState = rs;
    }
  }
  return { perm: realSourcePerm, state: realSourceState };
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
   Mother of Runes' activated ability counts as a Creature source.

   `allStates` is the in-progress state map when called from inside evaluation
   (effectAppliesToPerm). It MUST be passed there: falling back to
   Battlefield.getAllFinalStates() mid-evaluation re-enters the pipeline before the
   cache is populated and recurses until the stack overflows. UI callers, which run
   outside evaluation, may omit it. */
function _isProtectedFromSource(targetState, sourceState, sourcePerm, targetPerm, allStates) {
  const prots = _getStateProtection(targetState);
  if (!prots.length) return null;
  const { perm: realSourcePerm, state: realSourceState } = _protectionRealSource(sourceState, sourcePerm, allStates);
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
  return activeProts.find(p => _sourceHasQuality(p, realSourcePerm, realSourceState)) || null;
}

/* Is the source (the permanent whose spell or ability it is, as _protectionRealSource gives
   it) of the quality a protection or hexproof entry names? */
function _sourceHasQuality(p, realSourcePerm, realSourceState) {
  const sColors = (realSourceState && realSourceState.colors) || (realSourcePerm && realSourcePerm.printedColors) || [];
  const sTypes = (realSourceState && realSourceState.types) || (realSourcePerm && realSourcePerm.printedTypes) || [];
  const sSubs = (realSourceState && realSourceState.subtypes) || (realSourcePerm && realSourcePerm.printedSubtypes) || [];
  const sName = (realSourceState && realSourceState.name) || (realSourcePerm && realSourcePerm.name) || '';
  const sIsAllCreatureTypes = !!(realSourceState && realSourceState.isAllCreatureTypes);
  switch (p.kind) {
    case 'everything': return true;
    case 'colorless': return sColors.length === 0;
    case 'all_colors': return sColors.length > 0;
    case 'monocolored': return sColors.length === 1;
    case 'multicolored': return sColors.length >= 2;
    case 'color': return sColors.includes(p.value);
    case 'cardType': return sTypes.includes(p.value);
    case 'subtype':
      if (sSubs.includes(p.value)) return true;
      // Changeling / "is every creature type"
      return sIsAllCreatureTypes && typeof TypeCatalog !== 'undefined' &&
        !!TypeCatalog.creatureTypes && TypeCatalog.creatureTypes.has(p.value);
    case 'name': return sName === p.value;
  }
  return false;
}

/* CR 702.11: "hexproof" and "hexproof from [quality]". Returns the entries of the hexproof
   keywords among a state's abilities: { kind: 'all' } for plain hexproof, a quality as
   _parseOneProtectionClause reads it ("hexproof from black", "from monocolored", "from
   artifacts, creatures, and enchantments", "from each color"), { kind: 'abilityKind', value:
   ['activated', 'triggered'] } (Volatile Stormdrake), { kind: 'its_colors' } ("from each of its
   colors", Tam), and { kind: 'all' } as well for a quality not read ("from that color" left
   unresolved), so it is refused as before. Each entry carries words, the keyword as written.
   A keyword is a line of its own or an item of a keyword list, as _hasKeywordAbility has it;
   "hexproof from" always ends its list. */
const _HEXPROOF_QUALITY_KINDS = new Set(['everything', 'all_colors', 'monocolored', 'multicolored', 'colorless', 'color', 'cardType']);
function _parseHexproofEntries(abilities) {
  const out = [];
  for (const a of abilities || []) {
    const line = String(a).trim().replace(/\s*\(.*$/, '');
    if (/[:"\u201c]/.test(line) || /^(?:when|whenever|at|as long as|if)\b/i.test(line)) continue;
    const m = line.match(/(?:^|,\s*)(hexproof)\b(?!\s*[:\u2014])(?:\s+from\s+(.+?))?\s*\.?$/i)
      || line.match(/(?:^|,\s*)(hexproof)\b(?!\s*[:\u2014])(?=\s*(?:,|$))/i);
    if (!m) continue;
    const body = (m[2] || '').replace(/\s+(?:until\s+(?:end\s+of\s+turn|your\s+next\s+turn)|this\s+turn)\s*$/i, '').trim();
    if (!body) { out.push({ kind: 'all', words: 'hexproof' }); continue; }
    const words = 'hexproof from ' + body.toLowerCase();
    const kinds = body.toLowerCase().match(/^(activated|triggered)(?:\s+and\s+(activated|triggered))?\s+abilities$/);
    if (kinds) { out.push({ kind: 'abilityKind', value: [kinds[1], kinds[2]].filter(Boolean), words }); continue; }
    if (/^each of its colors$/i.test(body)) { out.push({ kind: 'its_colors', words }); continue; }
    const parts = body.split(/\s*,\s*(?:and\s+|or\s+)?(?:from\s+)?|\s+(?:and|or)\s+(?:from\s+)?/i).filter(Boolean);
    const parsed = parts.map(_parseOneProtectionClause);
    if (!parsed.length || parsed.some(q => !q || !_HEXPROOF_QUALITY_KINDS.has(q.kind))) {
      out.push({ kind: 'all', words });
      continue;
    }
    for (const q of parsed) out.push({ ...q, words });
  }
  return out;
}

/* The hexproof entry that keeps the target from being targeted by this source, or null.
   Hexproof only stops an opponent's spells and abilities (the caller checks controllers);
   "hexproof from [quality]" only those of that quality, an ability's quality being its
   source's (CR 702.11d, as for protection, CR 113.7). Only abilities are of the
   'abilityKind' kinds: a fired triggered or activated ability (a pseudo-permanent flagged
   isTriggeredAbility / isActivatedAbility). allStates as for _isProtectedFromSource. */
function _hexproofFromSource(targetAbilities, targetState, sourceState, sourcePerm, allStates) {
  const entries = _parseHexproofEntries(targetAbilities);
  if (!entries.length) return null;
  let src = null;
  const source = () => src || (src = _protectionRealSource(sourceState, sourcePerm, allStates));
  for (const h of entries) {
    if (h.kind === 'all') return h;
    if (h.kind === 'abilityKind') {
      if ((sourcePerm && sourcePerm.isTriggeredAbility && h.value.includes('triggered')) ||
          (sourcePerm && sourcePerm.isActivatedAbility && h.value.includes('activated'))) return h;
      continue;
    }
    const s = source();
    if (h.kind === 'its_colors') {
      const own = (targetState && targetState.colors) || [];
      const sColors = (s.state && s.state.colors) || (s.perm && s.perm.printedColors) || [];
      if (own.some(c => sColors.includes(c))) return h;
      continue;
    }
    if (_sourceHasQuality(h, s.perm, s.state)) return h;
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
