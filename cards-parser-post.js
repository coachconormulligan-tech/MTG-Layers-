/* cards-parser-post.js — post-processing helpers for parseCardEffects:
   _parseGrantedGlobalAbilities, _parseSimpleKeywordList, _finalizeEffects.
   These run on the effect list AFTER the main regex loop. Pure functions of
   their arguments + module-level globals (Battlefield, EFFECT_TYPE, etc.). */

/* Condition: the source is currently equipped/attached to `state`. Used by
   _parseGrantedGlobalAbilities to gate granted global effects (boost or keyword)
   so they only fire while the carrier creature is the attachment target. */
function _equippedToCarrier(state) {
  return !!(Battlefield.effects.find(e =>
    e.scope === 'targeted' && !e.selfTarget && e.requiresCreatureTarget && e.targetId === state.id));
}

/* True if some permanent attached to `state` (Aura/Equipment target link, including the
   synthetic tracker applyEquipAttachment adds for runtime Equipment) currently has
   `abilityText` among its abilities. Ties a granted "Equipped creature gets ..." ability to
   the creature its own carrier is attached to, rather than to every creature. */
function _attachedSourceHasAbility(state, allStates, abilityText) {
  if (!allStates) return false;
  return Battlefield.effects.some(e => {
    if (e.targetId !== state.id || e.selfTarget) return false;
    const src = allStates.get(e.sourceId);
    return !!(src && (src.abilities || []).includes(abilityText));
  });
}

/* Helper: detect ADD_ABILITY effects whose ability text itself contains global effect
   patterns (boost or keyword grant), and generate real global effects from them.
   These are conditioned on the source having a targetId (i.e. being equipped/attached).
   Example: Dancer's Chakrams grants "Other commanders you control get +2/+2 and have lifelink"
   as an ability to the equipped creature. This generates a global MODIFY_PT + ADD_ABILITY. */
function _parseGrantedGlobalAbilities(permanent, effects) {
  const sid = permanent.id;
  const ts = permanent.timestamp;
  const cardName = permanent.name;
  const toAdd = [];
  for (const eff of effects) {
    if (eff.type !== EFFECT_TYPE.ADD_ABILITY) continue;
    const abilityText = (eff.params && eff.params.ability) || '';
    if (!abilityText || abilityText.length < 10 || !/\b(?:get[s]?|have|has|gain[s]?)\b/i.test(abilityText)) continue;
    if (/^\{/.test(abilityText)) continue;
    const boostInAbility = /^(.+?)\s+(?:you (?:control|own)\s+)?get[s]?\s+([+-]\d+)\/([+-]\d+)/i.exec(abilityText);
    if (boostInAbility) {
      const filterText = boostInAbility[1].trim();
      if (!filterReferencesPermanents(filterText)) continue;
      const built = buildAppliesToFromText(filterText);
      const desc = built.desc;
      let fn = built.fn;
      // "Equipped creature" / "Enchanted creature" filters skip _equippedToCarrier: that
      // condition would incorrectly reject cases where the Equipment subtype was gained
      // dynamically (not printed). But the singular filter's fn is `() => true` (it is built
      // for a targeted effect on the attachment itself), so gate it here instead: the state
      // must be attached-to by a permanent that currently has this granted ability.
      const _filterGatesAttachment = /\bequipped\b|\benchanted\b/i.test(filterText);
      if (_filterGatesAttachment) {
        const innerFn = fn;
        fn = (p, allStates, effectCtrl) => innerFn(p, allStates, effectCtrl) &&
          _attachedSourceHasAbility(p, allStates, abilityText);
      }
      toAdd.push({
        id: `${sid}_eff_granted_${toAdd.length}a`,
        layer: '7c', type: EFFECT_TYPE.MODIFY_PT,
        params: { power: parseInt(boostInAbility[2]), toughness: parseInt(boostInAbility[3]) },
        appliesTo: fn, scope: 'global', affectsSelf: false,
        sourceId: sid, sourceName: cardName, timestamp: ts,
        desc: `${filterText} get ${boostInAbility[2]}/${boostInAbility[3]} (from granted ability). ${desc}`,
        asLongAsCondition: _filterGatesAttachment ? undefined : _equippedToCarrier,
      });
      const afterBoost = abilityText.substring(boostInAbility[0].length);
      const andHaveMatch = /\s+and\s+(?:have|has|gain|gains)\s+(.+)/i.exec(afterBoost);
      if (andHaveMatch) {
        const kwText = andHaveMatch[1].replace(/[,.]$/, '').trim();
        for (const kw of _parseSimpleKeywordList(kwText)) {
          toAdd.push({
            id: `${sid}_eff_granted_${toAdd.length}b`,
            layer: '6', type: EFFECT_TYPE.ADD_ABILITY,
            params: { ability: kw }, appliesTo: fn, scope: 'global', affectsSelf: false,
            sourceId: sid, sourceName: cardName, timestamp: ts,
            desc: `${filterText} have ${kw} (from granted ability). ${desc}`,
            asLongAsCondition: _filterGatesAttachment ? undefined : _equippedToCarrier,
          });
        }
      }
      continue;
    }
    const haveInAbility = /^(.+?)\s+(?:you (?:control|own)\s+)?(?:have|has|gain|gains)\s+(.+)/i.exec(abilityText);
    if (haveInAbility) {
      const filterText = haveInAbility[1].trim();
      if (!filterReferencesPermanents(filterText)) continue;
      const { fn, desc } = buildAppliesToFromText(filterText);
      const kwText = haveInAbility[2].replace(/[,.]$/, '').trim();
      const grantedKws = _parseSimpleKeywordList(kwText);
      if (grantedKws.length === 0) continue;
      for (const kw of grantedKws) {
        toAdd.push({
          id: `${sid}_eff_granted_${toAdd.length}c`,
          layer: '6', type: EFFECT_TYPE.ADD_ABILITY,
          params: { ability: kw }, appliesTo: fn, scope: 'global', affectsSelf: false,
          sourceId: sid, sourceName: cardName, timestamp: ts,
          desc: `${filterText} have ${kw} (from granted ability). ${desc}`,
          asLongAsCondition: _equippedToCarrier,
        });
      }
    }
  }
  for (const e of toAdd) effects.push(e);
}

/* Simple keyword list parser for _parseGrantedGlobalAbilities. */
function _parseSimpleKeywordList(text) {
  const SIMPLE_KWS = new Set([
    'flying','deathtouch','lifelink','trample','vigilance','hexproof','indestructible',
    'menace','reach','first strike','double strike','haste','flash','ward',
    'toxic','wither','infect','undying','persist','changeling','devoid','shadow',
    'fear','intimidate','skulk','prowess',
  ]);
  const results = [];
  let rem = text.trim();
  rem = rem.replace(/"([^"]+)"/g, (_, inner) => { results.push(inner.trim()); return ''; });
  rem = rem.toLowerCase();
  // Extract "hexproof from X" before splitting so "and" inside the qualifier isn't treated as a list separator.
  rem = rem.replace(
    /hexproof\s+from\s+((?:all|each)\s+\w+|\w+(?:\s+and\s+from\s+\w+)*)/gi,
    (m, qual) => { results.push(`Hexproof from ${qual.charAt(0).toUpperCase() + qual.slice(1)}`); return ''; }
  );
  const parts = rem.split(/,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (SIMPLE_KWS.has(part)) {
      results.push(part.charAt(0).toUpperCase() + part.slice(1));
    } else {
      const pm = part.match(/^(\w+(?:\s+\w+)?)\s+(.+)$/);
      if (pm && SIMPLE_KWS.has(pm[1])) {
        const base = pm[1].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        results.push(`${base} ${pm[2]}`);
      }
    }
  }
  return results;
}

/* Helper: mark equipment effects with requiresCreatureTarget flag,
   and propagate auraRestriction to all targeted effects */
function _finalizeEffects(effects, isEquipmentSource, permanent, oracleText) {
  const _oracle = (oracleText || '').toLowerCase();
  if (/\btarget\s+opponent\b/.test(_oracle) && permanent) {
    const chosen = permanent._targetOpponentPlayerId || null;
    let tagged = false;
    for (const eff of effects) {
      if (eff.scope === 'global') {
        eff._targetsOpponentPlayer = true;
        if (chosen) eff._targetOpponentPlayerId = chosen;
        tagged = true;
      }
    }
    if (tagged) permanent._targetsOpponentPlayer = true;
  }
  if (permanent?._isEnchantPlayer) {
    const chosenPlayer = permanent._enchantedPlayerId || null;
    for (const eff of effects) {
      if (eff.scope === 'global') {
        eff._enchantedPlayerScoped = true;
        if (chosenPlayer) eff._enchantedPlayerId = chosenPlayer;
      }
    }
  }
  if (isEquipmentSource) {
    for (const eff of effects) {
      if (eff.scope === 'targeted' && !eff.selfTarget) {
        eff.requiresCreatureTarget = true;
      }
    }
  }
  // An Aura with no continuous effect on its target (Pacifism: "Enchanted creature can't
  // attack or block") parses to nothing targeted, so it would get no target dropdown and
  // could never be attached — which also hides it from "enchanted"/"modified" checks on
  // other cards. Give it an inert tracker so it attaches like any other Aura.
  if (permanent && permanent._auraRestriction && !permanent._isEnchantPlayer &&
      (permanent.printedSubtypes || []).includes('Aura') &&
      !effects.some(e => e.scope === 'targeted' && !e.selfTarget)) {
    effects.push({
      id: `${permanent.id}_attach_tracker`,
      layer: '7c', type: EFFECT_TYPE.MODIFY_PT,
      params: { power: 0, toughness: 0 },
      scope: 'targeted', selfTarget: false,
      _isAttachTracker: true,
      targetId: null,
      sourceId: permanent.id, sourceName: permanent.name,
      timestamp: permanent.timestamp,
      desc: 'Aura attachment tracker',
    });
  }
  // Propagate auraRestriction: prefer an effect that already has it, then fall back to the
  // permanent-level flag (set during enchant-line parsing, before the main effects loop, so
  // effects added afterward — e.g. enchantTransformRegex — don't inherit it inline).
  const auraR = effects.find(e => e.auraRestriction)?.auraRestriction
    || permanent?._auraRestriction;
  if (auraR) {
    for (const eff of effects) {
      if (eff.scope === 'targeted' && !eff.selfTarget && !eff.auraRestriction) {
        eff.auraRestriction = auraR;
      }
    }
  }
  for (const flag of ['opponentControlRequired', 'youControlRequired']) {
    if (permanent?.[`_${flag}`] || effects.some(e => e[flag])) {
      for (const eff of effects) {
        if (eff.scope === 'targeted' && !eff.selfTarget) eff[flag] = true;
      }
    }
  }
  if (permanent) {
    const ownerId = permanent.owner || 'player_0';
    for (const eff of effects) {
      if (!eff.ownerId) eff.ownerId = ownerId;
    }
  }
  // Multi-target-slot detection: if this spell has multiple targeted effects originating
  // from distinct oracle positions, each position is its own independently selectable target.
  // Example: Seeds of Strength — "Target creature gets +1/+1." repeated 3 times.
  const _slottable = effects.filter(e =>
    e.scope === 'targeted' && !e.selfTarget && e.modalModeIndex === undefined && e._oraclePos !== undefined
  );
  // An Aura or Equipment has exactly one attached object, however many of its lines refer
  // to it (Edge of the Divinity: two "it gets" lines), so it never gets separate slots.
  const _isAttachment = isEquipmentSource || !!permanent?._auraRestriction
    || (permanent?.printedSubtypes || []).some(t => t === 'Aura' || t === 'Equipment');
  if (_slottable.length > 1 && !_isAttachment) {
    // _slotPos: a branch line ("If this spell was kicked, …") shares its base sentence's slot.
    const _slotPosOf = (e) => e._slotPos !== undefined ? e._slotPos : e._oraclePos;
    const _distinctPos = [...new Set(_slottable.map(_slotPosOf))].sort((a, b) => a - b);
    if (_distinctPos.length > 1) {
      for (const eff of _slottable) {
        eff._targetSlot = _distinctPos.indexOf(_slotPosOf(eff));
      }
    }
  }
  return effects;
}
