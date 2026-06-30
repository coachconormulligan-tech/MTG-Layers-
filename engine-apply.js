/* engine-apply.js — applyEffect: per-effect-type state mutation. */

/* [KEY: LAND-MANA]  —  Rule 305.7: basic land subtypes grant intrinsic mana abilities */
const BASIC_LAND_MANA = {
  'Plains':   '{T}: Add {W}.',
  'Island':   '{T}: Add {U}.',
  'Swamp':    '{T}: Add {B}.',
  'Mountain': '{T}: Add {R}.',
  'Forest':   '{T}: Add {G}.',
};
/* [END: LAND-MANA] */

/* [KEY: APPLY-EFFECT]  —  Apply a single effect to a mutable state. Returns description of what changed. */
function applyEffect(state, effect, context) {
  const changes = [];
  switch (effect.type) {
    case EFFECT_TYPE.ADD_TYPE:
      if (effect.params.gainsAllLandTypes) {
        if (!state.isAllLandTypes) {
          state.isAllLandTypes = true;
          changes.push('Gained all land types');
        }
        if (typeof TypeCatalog !== 'undefined' && TypeCatalog.landTypes && TypeCatalog.landTypes.size > 0) {
          let added = 0;
          for (const lt of TypeCatalog.landTypes) {
            if (!state.subtypes.includes(lt)) {
              state.subtypes.push(lt);
              added++;
            }
            if (BASIC_LAND_MANA[lt] && !state.abilities.includes(BASIC_LAND_MANA[lt])) {
              state.abilities.push(BASIC_LAND_MANA[lt]);
              changes.push(`Gained intrinsic mana ability: ${BASIC_LAND_MANA[lt]}`);
            }
          }
          if (added) changes.push(`Materialized ${added} land subtypes`);
        }
        break;
      }
      if (effect.params.gainsAllCreatureTypes) {
        if (!state.isAllCreatureTypes) {
          state.isAllCreatureTypes = true;
          changes.push('Gained all creature types');
        }
        // Materialize every creature type into state.subtypes so REMOVE_TYPE can
        // strip individual creature types (e.g. Werewolf Pack Leader's "isn't a Human").
        // Filter sites then become plain `subtypes.includes(s)` — no special-casing the flag.
        if (typeof TypeCatalog !== 'undefined' && TypeCatalog.creatureTypes && TypeCatalog.creatureTypes.size > 0) {
          let added = 0;
          for (const ct of TypeCatalog.creatureTypes) {
            if (!state.subtypes.includes(ct)) { state.subtypes.push(ct); added++; }
          }
          if (added) changes.push(`Materialized ${added} creature subtypes`);
        }
        break;
      }
      // Imprint: pull creature subtypes from the most-recent imprinted exile entry — Duplicant.
      // Silent no-op when no imprinted card / wrong type so the inspector doesn't show a layer row.
      if (effect.params.fromImprintedCardCreatureTypes && typeof _getImprintedExileEntries === 'function') {
        const entries = _getImprintedExileEntries(effect.sourceId);
        const last = entries.length ? entries[entries.length - 1] : null;
        if (!last || !last.card) break;
        const tl = last.card.type_line || '';
        const parsed = typeof parseTypeLine === 'function'
          ? parseTypeLine(tl) : { types: [], subtypes: [] };
        if (effect.params.requireCreature && !parsed.types.includes('Creature')) break;
        let added = 0;
        for (const st of (parsed.subtypes || [])) {
          const isCreatureSub = typeof TypeCatalog !== 'undefined' &&
            TypeCatalog.creatureTypes && TypeCatalog.creatureTypes.has(st);
          if (!isCreatureSub) continue;
          if (!state.subtypes.includes(st)) {
            state.subtypes.push(st);
            added++;
          }
        }
        if (added) changes.push(`Added ${added} creature subtype(s) from imprinted "${last.card.name}": ${parsed.subtypes.join(', ')}.`);
        break;
      }
      for (const sup of (effect.params.supertypes || [])) {
        if (!state.supertypes.includes(sup)) {
          state.supertypes.push(sup);
          changes.push(`Added supertype "${sup}"`);
        }
      }
      for (const t of (effect.params.types || [])) {
        if (!state.types.includes(t)) {
          state.types.push(t);
          changes.push(`Added type "${t}"`);
        }
      }
      for (const st of (effect.params.subtypes || [])) {
        // CR 205.3b: creature subtypes can only be held by Creatures and Kindred permanents.
        // If a targeted effect's target is no longer a creature/kindred (e.g. lost its type
        // in an earlier layer), the subtype gain doesn't apply — but other parts of the same
        // ability can still apply (e.g. "loses all abilities" in a later layer).
        const isCreatureSub = typeof TypeCatalog !== 'undefined' &&
          TypeCatalog.creatureTypes && TypeCatalog.creatureTypes.has(st);
        if (isCreatureSub &&
            !state.types.includes('Creature') && !state.types.includes('Kindred')) {
          continue;
        }
        if (!state.subtypes.includes(st)) {
          state.subtypes.push(st);
          changes.push(`Added subtype "${st}"`);
          // CR 305.6: basic land subtypes grant intrinsic mana abilities
          if (BASIC_LAND_MANA[st] && !state.abilities.includes(BASIC_LAND_MANA[st])) {
            state.abilities.push(BASIC_LAND_MANA[st]);
            changes.push(`Gained intrinsic mana ability: ${BASIC_LAND_MANA[st]}`);
          }
        }
      }
      break;

    case EFFECT_TYPE.REMOVE_TYPE:
      // "loses all creature types" — strip every creature subtype (Layer 4, not Layer 6)
      if (effect.params.losesAllCreatureTypesOnly) {
        state.isAllCreatureTypes = false;
        const _ctSet = typeof TypeCatalog !== 'undefined' ? TypeCatalog.getSubtypeCategory('creature') : new Set();
        if (_ctSet.size > 0) {
          state.subtypes = state.subtypes.filter(s => !_ctSet.has(s));
        } else {
          state.subtypes = [];
        }
        changes.push('Lost all creature types');
        break;
      }
      // Devotion condition: skip removal if devotion meets threshold.
      // Primary gate is in effectAppliesToPerm; this is a safety fallback.
      if (effect.params.devotionCondition && effect._allStates) {
        const sourceState = effect._allStates.get(effect.sourceId);
        const sourceController = sourceState ? sourceState.controller : null;
        const dev = _computeDevotionCounts(effect._allStates, sourceController);
        const { colors, threshold } = effect.params.devotionCondition;
        const total = colors.reduce((sum, c) => sum + (dev[c] || 0), 0);
        if (total >= threshold) break;
        changes.push(`Devotion ${total} < ${threshold}: not a creature.`);
      }
      for (const t of (effect.params.types || [])) {
        const i = state.types.indexOf(t);
        if (i >= 0) {
          state.types.splice(i, 1);
          changes.push(`Removed type "${t}"`);
          // CR 205.1a: When a card loses a type, it also loses all subtypes
          // associated with that type. Look up the subtype set from TypeCatalog.
          if (typeof TypeCatalog !== 'undefined' && TypeCatalog.getSubtypesForCardType) {
            const associatedSubs = TypeCatalog.getSubtypesForCardType(t);
            if (associatedSubs.size) {
              state.subtypes = state.subtypes.filter(s => {
                if (associatedSubs.has(s)) {
                  changes.push(`Removed subtype "${s}" (associated with lost type "${t}")`);
                  return false;
                }
                return true;
              });
            }
          }
          if (t === 'Creature' && state.isAllCreatureTypes &&
              !state.types.includes('Kindred') && !state.types.includes('Tribal')) {
            state.isAllCreatureTypes = false;
            changes.push('Lost all creature types (no longer a Creature or Kindred)');
          }
        }
      }
      for (const sup of (effect.params.supertypes || [])) {
        const i = state.supertypes.indexOf(sup);
        if (i >= 0) {
          state.supertypes.splice(i, 1);
          changes.push(`Removed supertype "${sup}"`);
        }
      }
      // Also remove subtypes if explicitly specified
      for (const s of (effect.params.subtypes || [])) {
        const i = state.subtypes.indexOf(s);
        if (i >= 0) { state.subtypes.splice(i, 1); changes.push(`Removed subtype "${s}"`); }
      }
      break;

    case EFFECT_TYPE.SET_TYPE: {
      const oldTypes = [...state.types];
      const oldSub = [...state.subtypes];
      let landSubtypesWereReplaced = false;

      if (effect.params.replaceSubtypeCategory) {
        const cat = effect.params.replaceSubtypeCategory;
        const catSet = TypeCatalog.getSubtypeCategory(cat);
        const kept = state.subtypes.filter(s => !catSet.has(s));
        const newSubs = effect.params.subtypes || [];
        state.subtypes = [...new Set([...kept, ...newSubs])];
        if (!effect.params.keepTypes) {
          state.types = [...new Set(effect.params.types || [])];
        }
        changes.push(`Replaced ${cat} subtypes: [${oldSub.join(', ')}] → [${state.subtypes.join(', ')}]`);
        if (cat === 'land') landSubtypesWereReplaced = true;
      } else {
        // Only overwrite types if explicitly provided; undefined means keep existing types
        if (effect.params.types !== undefined) {
          state.types = [...new Set(effect.params.types)];
          changes.push(`Set types to [${state.types.join(', ')}] (was [${oldTypes.join(', ')}])`);
        }
        state.subtypes = [...new Set(effect.params.subtypes || [])];
        if (!effect.params.types) {
          changes.push(`Set subtypes to [${state.subtypes.join(', ')}] (was [${oldSub.join(', ')}])`);
        } else {
          if (state.subtypes.length) changes.push(`Set subtypes to [${state.subtypes.join(', ')}]`);
          // CR 205.1a: note any subtypes lost because their associated card type was removed
          if (typeof TypeCatalog !== 'undefined' && TypeCatalog.getSubtypesForCardType) {
            const lostTypes = oldTypes.filter(t => !state.types.includes(t));
            const newSubSet = new Set(state.subtypes);
            for (const t of lostTypes) {
              const assoc = TypeCatalog.getSubtypesForCardType(t);
              if (assoc && assoc.size) {
                for (const s of oldSub) {
                  if (assoc.has(s) && !newSubSet.has(s)) {
                    changes.push(`Removed subtype "${s}" (associated with lost type "${t}")`);
                  }
                }
              }
            }
          }
        }
        if (state.types.includes('Land') && state.subtypes.some(s => BASIC_LAND_MANA[s])) {
          landSubtypesWereReplaced = true;
        }
      }

      if (effect.params.keepSupertypes) {
        /* keep existing supertypes */
      } else if (effect.params.supertypes !== undefined) {
        state.supertypes = [...new Set(effect.params.supertypes)];
      }

      // CR 205.1b: creature subtypes only apply to creatures (and Kindred/Tribal);
      // if Creature type was removed by this SET_TYPE, clear the "all creature types" trait.
      if (!state.types.includes('Creature') && !state.types.includes('Kindred') &&
          !state.types.includes('Tribal') && state.isAllCreatureTypes) {
        state.isAllCreatureTypes = false;
        changes.push('Lost all creature types (no longer a Creature or Kindred)');
      }

      /* Rule 305.7: setting land subtypes removes all rules-text abilities
         and grants the intrinsic mana ability for each new basic land subtype. */
      if (landSubtypesWereReplaced && state.types.includes('Land')) {
        if (state.abilities.length > 0) {
          changes.push(`Rule 305.7: Removed abilities: [${state.abilities.join('; ')}]`);
        }
        state.abilities = [];
        state.hasChangeling = false;
        state.abilitiesRemovedBy305_7 = true;
        const manaAbilities = state.subtypes
          .filter(s => BASIC_LAND_MANA[s])
          .map(s => BASIC_LAND_MANA[s]);
        if (manaAbilities.length > 0) {
          state.abilities = [...manaAbilities];
          changes.push(`Rule 305.7: Granted mana abilities: [${manaAbilities.join('; ')}]`);
        }
      }
      break;
    }

    case EFFECT_TYPE.ADD_ABILITY: {
      // Synthetic param: derive "Protection from X" abilities at apply time from imprinted
      // exile entries. Used by Death-Mask Duplicant's "The same is true for ... protection ..."
      // expansion, where the specific protection clauses can't be known until something is
      // actually imprinted. Splits compound clauses ("protection from red and from white")
      // into individual ability strings to match the rest of the protection infrastructure.
      if (effect.params.protectionFromImprinted) {
        if (typeof _getImprintedExileEntries === 'function') {
          const entries = _getImprintedExileEntries(effect.sourceId);
          const seenLower = new Set(state.abilities.map(a => a.toLowerCase()));
          const reProt = /protection from [^.,;\n)]+(?:\s+and from [^.,;\n)]+)*/gi;
          for (const e of entries) {
            const txt = (e.card && e.card.oracle_text) || '';
            let pm;
            while ((pm = reProt.exec(txt)) !== null) {
              const raw = pm[0].toLowerCase().replace(/^protection from\s+/, '');
              const parts = raw.split(/,?\s+and\s+from\s+|,\s+from\s+/);
              for (const p of parts) {
                const clause = ('Protection from ' + p.trim()).replace(/\s+$/, '');
                if (!seenLower.has(clause.toLowerCase())) {
                  state.abilities.push(clause);
                  changes.push(`Added ability "${clause}"`);
                  seenLower.add(clause.toLowerCase());
                }
              }
            }
          }
        }
        break;
      }
      let ab = effect.params.ability;
      // Resolve xSource: replace {X} in ability text with a dynamic value.
      if (ab && effect.params.xSource) {
        if (effect.params.xSource === 'target_mana_value') {
          // Bludgeon Brawl: equip cost = affected permanent's own mana value
          ab = ab.replace('{X}', `{${state.manaValue || 0}}`);
        } else if (effect.params.xSource === 'source_power' && effect._allStates) {
          const srcSt = effect._allStates.get(effect.sourceId);
          const pow = srcSt ? (srcSt.power || 0) : 0;
          ab = ab.replace('{X}', `{${pow}}`);
        }
      }
      // Resolve {mana value} placeholder (Bludgeon Brawl granted ability "Equipped creature gets +N/+0").
      // Substitute the affected permanent's actual mana value so the stored text is human-readable
      // and the MODIFY_PT boost scanner (which also accepts \d+) can parse it directly.
      if (ab && /\{mana value\}/i.test(ab)) {
        ab = ab.replace(/\{mana value\}/gi, String(state.manaValue || 0));
      }
      if (ab) {
        // Most abilities stack meaningfully when granted multiple times (activated abilities,
        // triggered abilities, ward, etc.). Only static keyword abilities that have no
        // incremental effect are prevented from appearing multiple times.
        const abLower = ab.toLowerCase().trimStart();
        const preventDuplicate = /^(?:flying|lifelink|double strike|first strike|trample|vigilance|deathtouch|hexproof|shroud|indestructible|defender|menace|reach|haste|flash|changeling|fear|intimidate|skulk|shadow|horsemanship|plainswalk|islandwalk|swampwalk|mountainwalk|forestwalk|flanking|phasing|undying|persist|infect|wither|battle cry|exalted|affinity|convoke|cascade|rebuke|partner)(?:\s*$|\s*\()/i.test(abLower);
        if (!preventDuplicate || !state.abilities.includes(ab)) {
          state.abilities.push(ab);
          changes.push(`Added ability "${ab}"`);
          if (/\bchangeling\b/i.test(ab)) state.hasChangeling = true;
        }
      }
      // If the ability is a trait (e.g. "Has all card names"), also add to traits array
      if (effect.params.isTrait && ab && !state.traits.includes(ab)) {
        state.traits.push(ab);
      }
      break;
    }

    case EFFECT_TYPE.REMOVE_ABILITIES:
      // Type-only removal: "loses all creature types" without touching abilities.
      if (effect.params.losesAllCreatureTypesOnly) {
        state.isAllCreatureTypes = false;
        const _ctSet = typeof TypeCatalog !== 'undefined' ? TypeCatalog.getSubtypeCategory('creature') : new Set();
        if (_ctSet.size > 0) {
          state.subtypes = state.subtypes.filter(s => !_ctSet.has(s));
        } else {
          state.subtypes = [];
        }
        changes.push('Lost all creature types');
        break;
      }
      // Specific ability removal: "loses flying", "loses deathtouch", etc.
      // Only removes standalone keyword abilities, NOT keywords embedded in sentences.
      // A standalone keyword: "Flying", "Ward {2}", "Lifelink", "Protection from red"
      // A sentence: "Equipped creature has lifelink." — should NOT be removed.
      if (effect.params.specificAbilities && effect.params.specificAbilities.length > 0) {
        const toRemove = effect.params.specificAbilities.map(a => a.toLowerCase());
        function isStandaloneKeyword(abilityText, keyword) {
          const a = abilityText.toLowerCase().trim();
          const k = keyword.toLowerCase().trim();
          // Exact match
          if (a === k) return true;
          // Keyword followed by parameter: "Ward {2}", "Toxic 1"
          if (a.startsWith(k + ' ') && /^[\s{(\d]/.test(a.slice(k.length))) {
            // Check it's not a full sentence (no verbs/articles after keyword param)
            const afterKw = a.slice(k.length).trim();
            // If it's just a cost/number/reminder text, it's standalone
            if (/^(?:\{[^}]+\}|\d+|—|\()/.test(afterKw)) return true;
            // If it has no period/verb pattern, likely standalone
            if (afterKw.length < 30 && !/\b(?:has|gets|is|are|gains|loses|can|may|does|when|whenever|at|if|you)\b/.test(afterKw)) return true;
          }
          // Keyword with reminder text: "Flying (This creature can't...)"
          if (a.startsWith(k) && /^\s*\(/.test(a.slice(k.length))) return true;
          // Protection variants: exact match of "protection from [color/type]"
          if (k.startsWith('protection from') && a.startsWith(k)) return true;
          return false;
        }
        const removed = state.abilities.filter(a => toRemove.some(r => isStandaloneKeyword(a, r)));
        state.abilities = state.abilities.filter(a => !toRemove.some(r => isStandaloneKeyword(a, r)));
        if (removed.length > 0) {
          changes.push(`Removed specific abilities: [${removed.join(', ')}]`);
        }
        break;
      }
      // exceptManaAbilities: keep abilities that add mana (contain "add " but don't target)
      if (effect.params.exceptManaAbilities) {
        const kept = state.abilities.filter(a => /\badd\s/i.test(a) && !/\btarget\b/i.test(a));
        const removed = state.abilities.filter(a => !kept.includes(a));
        if (removed.length > 0) {
          changes.push(`Removed non-mana abilities: [${removed.join(', ')}]`);
        }
        if (kept.length > 0) {
          changes.push(`Kept mana abilities: [${kept.join(', ')}]`);
        }
        state.abilities = kept;
        state.hasChangeling = false;
        state.allAbilitiesRemoved = true;
        break;
      }
      if (state.abilities.length > 0) {
        changes.push(`Removed abilities: [${state.abilities.join(', ')}]`);
      }
      state.abilities = [];
      state.hasChangeling = false;
      // Mark that all abilities were removed from this permanent.
      // Effects sourced from this permanent that come from its rules text are now dead.
      state.allAbilitiesRemoved = true;
      // NOTE: isAllCreatureTypes is NOT reset here. Per MTG rules, changeling
      // sets all creature types in Layer 4. If changeling is removed in Layer 6,
      // the creature still has all creature types from Layer 4.
      // HOWEVER: if the effect explicitly says "loses all creature types",
      // then isAllCreatureTypes IS reset.
      if (effect.params.losesAllCreatureTypes) {
        state.isAllCreatureTypes = false;
        const catSet = typeof TypeCatalog !== 'undefined' ? TypeCatalog.getSubtypeCategory('creature') : new Set();
        if (catSet.size > 0) {
          state.subtypes = state.subtypes.filter(s => !catSet.has(s));
        } else {
          state.subtypes = [];
        }
        changes.push('Lost all creature types');
      }
      if (effect.params.replaceWith) {
        state.abilities = [...effect.params.replaceWith];
        state.hasChangeling = state.abilities.some(a => /\bchangeling\b/i.test(a));
        changes.push(`Granted: [${effect.params.replaceWith.join(', ')}]`);
      }
      break;

    case EFFECT_TYPE.SET_PT:
      if (state.types.includes('Creature')) {
        const oldP = state.power, oldT = state.toughness;
        // Imprint: P/T from most-recent imprinted creature card — Duplicant.
        if (effect.params.fromImprintedCardPT && typeof _getImprintedExileEntries === 'function') {
          const entries = _getImprintedExileEntries(effect.sourceId);
          const last = entries.length ? entries[entries.length - 1] : null;
          // Silent no-op when no imprinted card / wrong type so the inspector doesn't show a layer row.
          if (!last || !last.card) break;
          if (effect.params.requireCreature) {
            const parsed = typeof parseTypeLine === 'function'
              ? parseTypeLine(last.card.type_line || '') : { types: [] };
            if (!parsed.types.includes('Creature')) break;
          }
          const cardPow = parseInt(last.card.power, 10);
          const cardTou = parseInt(last.card.toughness, 10);
          state.power = isNaN(cardPow) ? 0 : cardPow;
          state.toughness = isNaN(cardTou) ? 0 : cardTou;
          changes.push(`Set P/T to ${state.power}/${state.toughness} from imprinted "${last.card.name}" (was ${oldP}/${oldT})`);
          break;
        }
        if (effect.params.useMV) {
          state.power = state.manaValue;
          state.toughness = state.manaValue;
        } else if (effect.params.useCountOf !== undefined) {
          let val = 0;
          if (effect._allStates) {
            const raw = _computeForEachCount(effect.params.useCountOf, effect._allStates, state, effect);
            val = (raw !== null && raw !== undefined) ? raw : (state.cdaUserValue ?? 0);
          } else {
            val = state.cdaUserValue ?? 0;
          }
          state.power = val;
          state.toughness = val;
        } else {
          state.power = effect.params.power;
          state.toughness = effect.params.toughness;
        }
        changes.push(`Set P/T to ${state.power}/${state.toughness} (was ${oldP}/${oldT})`);
      }
      break;

    case EFFECT_TYPE.MODIFY_PT:
      if (state.types.includes('Creature')) {
        let modPow = effect.params.power;
        let modTou = effect.params.toughness;
        // "Double [its] power / toughness" — add the creature's current P/T as a +N/+N boost,
        // computed at apply time from the value as it currently exists (CR 107.16 doubling).
        // Capture both before any mutation so "double power and toughness" reads originals.
        if (effect.params.doublePower || effect.params.doubleToughness) {
          if (effect.params.doublePower) modPow = state.power;
          if (effect.params.doubleToughness) modTou = state.toughness;
        }
        // "+X/+X where X is [its | this creature's] power/toughness" — magnitude is a P/T
        // characteristic. charFrom 'self' reads the recipient's own value (Berserk: +X/+0,
        // X = its power); 'source' reads the source permanent's value. charWhich picks which
        // characteristic supplies X; charPowerDim/charToughDim pick which dimensions receive it.
        if (effect.params.charBoost) {
          let xVal = 0;
          if (effect.params.charFrom === 'source') {
            const src = effect._allStates && effect._allStates.get(effect.sourceId);
            if (src) xVal = (effect.params.charWhich === 'toughness') ? (src.toughness || 0) : (src.power || 0);
          } else {
            xVal = (effect.params.charWhich === 'toughness') ? (state.toughness || 0) : (state.power || 0);
          }
          if (effect.params.charPowerDim) modPow = xVal;
          if (effect.params.charToughDim) modTou = xVal;
        }
        // Runtime-gained Equipment: read actual boost from source's computed abilities
        // (e.g. Armed with Proof grants "Equipped creature gets +2/+0" to a Clue/Equipment;
        // the synthetic tracking effect starts with +0/+0 and is overridden here).
        if (effect._isEquipTargetEff && effect._allStates) {
          // The synthetic tracker only contributes a boost for RUNTIME-gained equipment
          // (e.g. Armed with Proof grants "Equipped creature gets +2/+0" to a Clue/Equipment).
          // For statically-parsed equipment (Bonesplitter, Strata Scythe, etc.), a parsed
          // MODIFY_PT effect from the same source already applies the boost — the tracker would
          // double-count. Detect via Battlefield.effects: if any other MODIFY_PT effect from the
          // same source exists, this tracker is attachment-tracking only (modPow/modTou stay 0).
          const hasParsedBoost = typeof Battlefield !== 'undefined' && Battlefield.effects &&
            Battlefield.effects.some(e =>
              e.sourceId === effect.sourceId &&
              e.type === EFFECT_TYPE.MODIFY_PT &&
              !e._isEquipTargetEff);
          if (!hasParsedBoost) {
            const srcState = effect._allStates.get(effect.sourceId);
            if (srcState && srcState.abilities) {
              let totalPow = 0, totalTou = 0;
              const srcMV = srcState.manaValue || 0;
              // Match numeric boosts and "{mana value}" (Bludgeon Brawl pattern)
              const boostRe = /equipped creature gets ([+\-](?:\{mana value\}|\d+))\/([+\-](?:\{mana value\}|\d+))/gi;
              const parsePTVal = (v) => v.includes('{mana value}') ? (v.startsWith('-') ? -srcMV : srcMV) : parseInt(v, 10);
              for (const ab of srcState.abilities) {
                // Skip triggered abilities — their boost is conditional, not a continuous effect.
                if (/^(?:Landfall\s*[—\-]|When(?:ever)?\s|At\s)/i.test(ab.trim())) continue;
                boostRe.lastIndex = 0;
                let m;
                while ((m = boostRe.exec(ab)) !== null) {
                  totalPow += parsePTVal(m[1]);
                  totalTou += parsePTVal(m[2]);
                }
              }
              modPow = totalPow;
              modTou = totalTou;
            }
          }
        }
        // Imprint "from exiled card's P/T" — Phyrexian Ingester: power/toughness come from
        // the most-recent exile entry tagged with this source. Power and toughness independently.
        if (effect.params.fromExiledCardPT && typeof _getImprintedExileEntries === 'function') {
          const entries = _getImprintedExileEntries(effect.sourceId);
          const last = entries.length ? entries[entries.length - 1] : null;
          if (last && last.card) {
            const cardPow = parseInt(last.card.power, 10);
            const cardTou = parseInt(last.card.toughness, 10);
            modPow = isNaN(cardPow) ? 0 : cardPow;
            modTou = isNaN(cardTou) ? 0 : cardTou;
          } else {
            modPow = 0;
            modTou = 0;
          }
        }
        // "for each" variable boost: multiply base by count
        let forEachCount = null;
        if (effect.params.forEachDesc !== undefined) {
          let val = null;
          if (effect._allStates) {
            val = _computeForEachCount(effect.params.forEachDesc, effect._allStates, state, effect);
          }
          if (val === null || val === undefined) {
            val = state.cdaUserValue ?? 0;
          }
          if (effect.params.userAdjustable && state.cdaUserValue !== null && state.cdaUserValue !== undefined) {
            val = state.cdaUserValue;
          }
          if (effect.params.maxCount !== undefined && val > effect.params.maxCount) {
            val = effect.params.maxCount;
          }
          forEachCount = val;
          modPow = (effect.params.basePower || effect.params.power) * val;
          modTou = (effect.params.baseToughness || effect.params.toughness) * val;
        }
        state.power += modPow;
        state.toughness += modTou;
        // Silent no-op for inert boosts so the inspector doesn't show a layer row:
        //   - "for each" count of 0 (Strata Scythe with no matching lands)
        //   - Equipment attachment tracker whose source's only boost is a for-each one
        //     (we've already stripped those above, leaving modPow/modTou at 0/0)
        if ((forEachCount === 0 || effect._isEquipTargetEff) && modPow === 0 && modTou === 0) break;
        const sign = (n) => n >= 0 ? `+${n}` : `${n}`;
        changes.push(`Modified P/T by ${sign(modPow)}/${sign(modTou)} \u2192 now ${state.power}/${state.toughness}`);
      }
      break;

    case EFFECT_TYPE.ADD_COUNTERS: {
      const counterType = effect.params.counterType || '+1/+1';
      const count = effect.params.count || 0;
      // Support arbitrary P/T counter types: +N/+M, -N/-M, etc.
      const ptMatch = counterType.match(/^([+-]\d+)\/([+-]\d+)$/);
      if (ptMatch) {
        if (state.types.includes('Creature')) {
          const powMod = (effect.params.powerMod !== undefined ? effect.params.powerMod : parseInt(ptMatch[1])) * count;
          const touMod = (effect.params.toughnessMod !== undefined ? effect.params.toughnessMod : parseInt(ptMatch[2])) * count;
          state.power += powMod;
          state.toughness += touMod;
          changes.push(`${counterType} counters (x${count}): P/T now ${state.power}/${state.toughness}`);
        } else {
          changes.push(`${counterType} counters (x${count}) present but no P/T effect (not a creature)`);
        }
      }
      break;
    }

    case EFFECT_TYPE.SET_COLOR: {
      const oldColors = state.colors.join(', ') || 'none';
      state.colors = [...(effect.params.colors || [])];
      const newColors = state.colors.length ? state.colors.join(', ') : 'colorless';
      changes.push(`Set color to ${newColors} (was ${oldColors})`);
      break;
    }

    case EFFECT_TYPE.ADD_COLOR: {
      for (const c of (effect.params.colors || [])) {
        if (!state.colors.includes(c)) {
          state.colors.push(c);
          changes.push(`Added color "${c}"`);
        }
      }
      break;
    }

    case EFFECT_TYPE.COPY: {
      // Layer 1: Replace this permanent's state with copy source characteristics.
      // The copy source card data is stored in effect.params.copySource.
      // For Imprint copies (Dermotaxi), the source comes from the most-recent imprinted exile entry.
      let src = effect.params.copySource;
      if (!src && effect.params.copyFromExiledCard && typeof _getImprintedExileEntries === 'function') {
        const entries = _getImprintedExileEntries(effect.sourceId);
        const last = entries.length ? entries[entries.length - 1] : null;
        if (last && last.card) src = last.card;
      }
      // CR 707.2 (copy-of-a-copy): the copiable values of the permanent we're copying
      // are its characteristics at the END of Layer 1 — i.e. as modified by its own copy
      // effect — not its printed card. When the source permanent is itself a copy, read its
      // LIVE Layer-1 state (already copy-applied this layer because copies apply in timestamp
      // order and a copied permanent always entered before its copier). This keeps the chain
      // correct and dynamic no matter what order the copies were assigned, instead of relying
      // on the frozen snapshot captured when the copy was first set up.
      const _liveSrcId = effect.params._copyTargetPermId;
      if (_liveSrcId && effect._allStates) {
        const liveSrc = effect._allStates.get(_liveSrcId);
        if (liveSrc && liveSrc.copySource) {
          const _subs = (liveSrc.subtypes && liveSrc.subtypes.length)
            ? ' — ' + liveSrc.subtypes.join(' ') : '';
          src = {
            name: liveSrc.name,
            type_line: [...(liveSrc.supertypes || []), ...(liveSrc.types || [])].join(' ') + _subs,
            oracle_text: liveSrc.oracleText || (liveSrc.abilities || []).join('\n'),
            colors: [...(liveSrc.colors || [])],
            power: liveSrc.power != null ? String(liveSrc.power) : undefined,
            toughness: liveSrc.toughness != null ? String(liveSrc.toughness) : undefined,
            cmc: liveSrc.manaValue || 0,
            mana_cost: liveSrc.manaCost || '',
          };
        }
      }
      if (!src) { break; } // No copy source selected — effect is inactive
      const srcTypes = parseTypeLine ? parseTypeLine(src.type_line || '') : { supertypes: [], types: [], subtypes: [] };
      const oldName = state.name;
      state.types      = srcTypes.types;
      state.supertypes = srcTypes.supertypes;
      state.subtypes   = srcTypes.subtypes;
      if (!effect.params.keepName) state.name = src.name;
      state.power      = src.power !== undefined ? (parseInt(src.power) || 0) : null;
      state.toughness  = src.toughness !== undefined ? (parseInt(src.toughness) || 0) : null;
      state.colors     = src.colors || [];
      state.manaValue  = src.cmc || 0;
      state.manaCost   = src.mana_cost || '';
      // Replace the copy source's card name with "this card" in the oracle text
      // so self-references resolve correctly for the copy.
      let copyOracleText = src.oracle_text || '';
      if (src.name && copyOracleText) {
        const srcName = (src.name || '').replace(/\u2019/g, "'");
        const escaped = srcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Also try the part before a comma (e.g. "Deadpool, Trading Card" -> "Deadpool")
        const commaIdx = srcName.indexOf(',');
        const candidates = [escaped];
        if (commaIdx > 0) {
          const shortName = srcName.slice(0, commaIdx).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          candidates.push(shortName);
        }
        copyOracleText = copyOracleText.replace(/\u2019/g, "'");
        for (const cand of candidates) {
          const nameRe = new RegExp('\\b' + cand + '\\b', 'g');
          if (nameRe.test(copyOracleText)) {
            copyOracleText = copyOracleText.replace(nameRe, 'this card');
            break;
          }
        }
      }
      // A "enter ... as a copy of ..." ability (Spark Double, Sakashima, Clone, etc.)
      // is a replacement effect that only functions as the permanent enters. Once the
      // copy is established it is defunct, so a copy must not carry it forward as a live
      // ability — drop it from the copied characteristics (and from oracleText so the
      // post-copy re-parse doesn't re-create a COPY effect from it).
      const _isCopyEnablingAbility = (line) => /\benters?\b[^\n]*\bas a copy of\b/i.test(line);
      state.abilities  = copyOracleText.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !_isCopyEnablingAbility(l));
      state.oracleText = state.abilities.join('\n');
      state.hasChangeling = state.abilities.some(a => /\bchangeling\b/i.test(a));
      state.copySource = src;
      state.oracleTextModified = true; // signals re-parse needed
      // Add extra types if the copy says so (e.g. Phyrexian Metamorph adds Artifact)
      if (effect.params.addTypes) {
        for (const t of effect.params.addTypes) {
          if (!state.types.includes(t)) state.types.push(t);
        }
      }
      // Add extra subtypes (e.g. Sakashima's Student adds Ninja)
      if (effect.params.addSubtypes) {
        for (const st of effect.params.addSubtypes) {
          if (!state.subtypes.includes(st)) {
            state.subtypes.push(st);
            changes.push(`Added subtype "${st}" (copy exception)`);
          }
        }
      }
      // "except" clause modifications from generic copy parsing
      if (effect.params.setTypes) {
        state.types = [...effect.params.setTypes];
      }
      if (effect.params.setColors) {
        state.colors = [...effect.params.setColors];
      }
      if (effect.params.setPT) {
        state.power = effect.params.setPT.power;
        state.toughness = effect.params.setPT.toughness;
      }
      if (effect.params.addAbilities) {
        for (const ab of effect.params.addAbilities) {
          state.abilities.push(ab);
        }
        state.oracleText = state.abilities.join('\n');
      }
      // "is not legendary" / "is not [type]" — remove supertypes/types from copy
      if (effect.params.notLegendary) {
        const idx = state.supertypes.indexOf('Legendary');
        if (idx >= 0) { state.supertypes.splice(idx, 1); changes.push('Removed Legendary (copy exception)'); }
      }
      // "is still legendary" — ensure Legendary supertype is preserved on the copy
      if (effect.params.keepLegendary) {
        if (!state.supertypes.includes('Legendary')) {
          state.supertypes.push('Legendary');
          changes.push('Kept Legendary (copy exception: "still legendary")');
        }
      }
      // Add extra supertypes from "except it's still [type]"
      if (effect.params.addSupertypes) {
        for (const st of effect.params.addSupertypes) {
          if (!state.supertypes.includes(st)) {
            state.supertypes.push(st);
            changes.push(`Added supertype "${st}" (copy exception)`);
          }
        }
      }
      if (effect.params.removeTypes) {
        for (const rt of effect.params.removeTypes) {
          let ri = state.supertypes.indexOf(rt);
          if (ri >= 0) { state.supertypes.splice(ri, 1); changes.push(`Removed supertype "${rt}" (copy exception)`); }
          ri = state.types.indexOf(rt);
          if (ri >= 0) { state.types.splice(ri, 1); changes.push(`Removed type "${rt}" (copy exception)`); }
        }
      }
      // The copy replaces ALL of this object's characteristics, so its "printed"
      // ability set for display becomes the copied abilities. Sync allPrintedAbilities
      // and drop the conditional/saga/class/leveler metadata that indexed into the
      // ORIGINAL card's printed abilities — otherwise the inspector keeps rendering a
      // stale entry (e.g. the copying card's own "enter as a copy of …" ability, which
      // is flagged conditional and would otherwise show regardless of state.abilities).
      state.allPrintedAbilities = [...state.abilities];
      state.conditionalAbilityIndices = null;
      state.conditionalAbilitiesMet = null;
      state.sagaChapterThresholds = null;
      state.classLevelThresholds = null;
      state.levelerData = null;
      state.spacecraftData = null;
      changes.push(`Copied "${src.name}" (was "${oldName}")`);
      break;
    }

    case EFFECT_TYPE.TEXT_CHANGE: {
      // Layer 3: Text-changing effects. Multiple sub-types handled here.
      const changeType = effect.params.changeType || 'color_or_land';

      // --- Volrath's Shapeshifter: replace entire state from graveyard card ---
      if (changeType === 'volrath_text') {
        // Look up the top card of the controlling player's actual graveyard.
        // Fall back to the legacy effect.params.graveyardCard for compatibility.
        const controllerPlayerId = state.controller || 'player_0';
        const gCard = (typeof Battlefield !== 'undefined' && Battlefield.getGraveyardTop)
          ? Battlefield.getGraveyardTop(controllerPlayerId)
          : (effect.params.graveyardCard || null);
        if (!gCard) { break; } // No top graveyard card — effect is inactive
        // "Creature card?" uses the card's COMPUTED zone characteristics, so a card that's a
        // creature only outside the battlefield (Grist, the Hunger Tide — a 1/1 Insect creature
        // in the graveyard via its own Layer 4 ability) satisfies the condition and Volrath copies.
        const gIsCreature = (typeof _isCreatureCardInZone === 'function')
          ? _isCreatureCardInZone(gCard, 'graveyard')
          : ((parseTypeLine ? parseTypeLine(gCard.type_line || '').types : []).includes('Creature'));
        if (!gIsCreature) {
          changes.push('Top card of graveyard is not a creature; Volrath keeps its printed characteristics.');
          break;
        }
        // The COPY itself uses only the graveyard card's COPIABLE (printed) characteristics
        // (CR 707.2: type-changing and P/T-setting continuous effects are NOT copied). So Volrath
        // gains Grist's printed "Legendary Planeswalker — Grist" types plus Grist's abilities —
        // including the "as long as ~ isn't on the battlefield, it's a 1/1 Insect creature"
        // ability. That ability is a Layer 4 type change that functions only off the battlefield,
        // so it stays inactive for Volrath (which is on the battlefield): Volrath copies the
        // creature CARD but does NOT itself become a creature.
        const gTypes = parseTypeLine ? parseTypeLine(gCard.type_line || '') : { supertypes: [], types: [], subtypes: [] };
        const oldName = state.name;
        // Replace name, mana cost, types, subtypes, supertypes, abilities, P/T, colors
        // (CR 706.2: a copy has all characteristics of the original, including mana cost)
        state.name = gCard.name;
        state.manaCost = gCard.mana_cost || '';
        state.manaValue = gCard.cmc ?? state.manaValue;
        state.supertypes = gTypes.supertypes;
        state.types = gTypes.types;
        state.subtypes = gTypes.subtypes;
        state.power = gCard.power !== undefined ? (parseInt(gCard.power) || 0) : state.power;
        state.toughness = gCard.toughness !== undefined ? (parseInt(gCard.toughness) || 0) : state.toughness;
        state.colors = gCard.colors || [];
        // Replace the full text box with the graveyard card's abilities.
        // Volrath's own "As long as…" ability does NOT carry over — it is the replaced
        // ability itself, so it is absent from the resulting text box.
        // Only "{2}: Discard a card." is retained (it is separately added by Volrath's rules text).
        // Replace self-referential proper nouns in the graveyard card's text so references
        // like "CardName gains trample" become "this card gains trample".
        const gReplacedText = typeof _replaceProperNounSelfRef === 'function'
          ? _replaceProperNounSelfRef(gCard.name, gCard.oracle_text || '')
          : (gCard.oracle_text || '');
        const gAbilities = gReplacedText.split('\n').map(l => l.trim()).filter(Boolean);
        const volrathOwnAbility = '{2}: Discard a card.';
        state.abilities = [...gAbilities];
        if (!state.abilities.includes(volrathOwnAbility)) {
          state.abilities.push(volrathOwnAbility);
        }
        state.oracleText = state.abilities.join('\n');
        // Sync allPrintedAbilities so the inspector never shows the stale Volrath ability
        // in any layer after this replacement.
        state.allPrintedAbilities = [...state.abilities];
        state.hasChangeling = state.abilities.some(a => /\bchangeling\b/i.test(a));
        state.oracleTextModified = true;
        changes.push(`Volrath becomes "${gCard.name}" (was "${oldName}"): gained name, mana cost, types, abilities, P/T, color.`);
        break;
      }

      // --- Exchange of Words / Deadpool: swap oracle text between two permanents ---
      // Only apply the swap once (not per-perm); subsequent matching perms get a log entry.
      // Use context.exchangeApplied Set (if provided) to track which effects have fired.
      // This avoids mutating the effect object, which leaked across dependency detection.
      if (changeType === 'exchange_text') {
        const exchangeKey = effect.id || effect.sourceId;
        if (context && context.exchangeApplied && context.exchangeApplied.has(exchangeKey)) {
          // Already swapped; just report that this perm was affected
          changes.push('Text box exchanged (swap applied).');
          break;
        }
        if (context && context.exchangeApplied) {
          context.exchangeApplied.add(exchangeKey);
        }
        const allSt = effect._allStates;
        if (!allSt) { changes.push('(Exchange requires global state.)'); break; }

        let idA, idB;
        if (effect.params.exchangeTargetA && effect.params.exchangeTargetB) {
          idA = effect.params.exchangeTargetA;
          idB = effect.params.exchangeTargetB;
        } else if (effect.params.exchangeTargetId) {
          idA = effect.sourceId;
          idB = effect.params.exchangeTargetId;
        } else {
          break; // No exchange targets selected — effect is inactive
        }

        const stA = allSt.get(idA);
        const stB = allSt.get(idB);
        if (!stA || !stB) { changes.push('(One or both exchange targets not found.)'); break; }

        // Use frozen snapshots if available (taken at trigger/ETB resolution time).
        // The snapshot captures the text boxes as they appeared at the end of Layer 3
        // BEFORE the exchange effect applied. Changes after resolution don't affect
        // what gets written — the exchange always writes those same frozen texts.
        let textForA, textForB, abilitiesForA, abilitiesForB;
        if (effect.params.snapshotTextA !== undefined && effect.params.snapshotTextB !== undefined) {
          // Snapshot mode: snapshotA = original text of target A, snapshotB = original text of target B
          // Exchange gives A the text of B and B the text of A
          textForA = effect.params.snapshotTextB;
          textForB = effect.params.snapshotTextA;
          abilitiesForA = effect.params.snapshotAbilitiesB || textForA.split('\n').map(l => l.trim()).filter(Boolean);
          abilitiesForB = effect.params.snapshotAbilitiesA || textForB.split('\n').map(l => l.trim()).filter(Boolean);
        } else {
          // No snapshots (legacy/fallback): read live text and swap
          textForA = stB.oracleText;
          textForB = stA.oracleText;
          abilitiesForA = [...stB.abilities];
          abilitiesForB = [...stA.abilities];
        }

        stA.oracleText = textForA;
        stA.abilities = [...abilitiesForA];
        stA.hasChangeling = abilitiesForA.some(a => /\bchangeling\b/i.test(a));
        stA.oracleTextModified = true;
        // Record where A's original text (and abilities) went, so effects with sourceId=idA
        // display idB as their effective source in the layer inspector.
        stA.textExchangedTo = idB;

        stB.oracleText = textForB;
        stB.abilities = [...abilitiesForB];
        stB.hasChangeling = abilitiesForB.some(a => /\bchangeling\b/i.test(a));
        stB.oracleTextModified = true;
        stB.textExchangedTo = idA;

        // If either exchange target is in a mutate stack, all other stack members must also
        // be stamped with textExchangedTo — they contribute abilities to the same permanent
        // and Exchange of Words exchanges the whole permanent's text box, not just one card.
        if (typeof Battlefield !== 'undefined' && Battlefield.getStack) {
          const stackA = Battlefield.getStack(idA);
          if (stackA) {
            for (const memberId of stackA) {
              if (memberId === idA) continue;
              const memberState = allSt.get(memberId);
              if (memberState) memberState.textExchangedTo = idB;
            }
          }
          const stackB = Battlefield.getStack(idB);
          if (stackB) {
            for (const memberId of stackB) {
              if (memberId === idB) continue;
              const memberState = allSt.get(memberId);
              if (memberState) memberState.textExchangedTo = idA;
            }
          }
        }

        changes.push('Exchanged text boxes between permanents (using snapshot).');
        break;
      }

      // --- Swirl the Mists (color_global): handled as normal replacements, applied globally ---
      // --- Standard replacements (color_or_land, color_only, land_only, creature_type) ---
      let reps = effect.params.replacements || [];
      if (reps.length === 0) { changes.push('(No text replacements specified.)'); break; }
      // Auto-expand replacements to include plural forms.
      // For creature_type: {from:"Wyvern", to:"Elf"} also adds {from:"Wyverns", to:"Elves"}.
      // For land types: {from:"Plains", to:"Swamp"} also adds {from:"Plains", to:"Swamps"} for plural contexts.
      if (changeType === 'creature_type' && typeof buildCreatureTypeReplacementPairs === 'function') {
        const expanded = [];
        const seen = new Set();
        for (const { from, to } of reps) {
          const pairs = buildCreatureTypeReplacementPairs(from, to);
          for (const p of pairs) {
            const key = p.from.toLowerCase();
            if (!seen.has(key)) { seen.add(key); expanded.push(p); }
          }
        }
        reps = expanded;
        // Sort longest-first so "Wyverns" is replaced before "Wyvern" could match inside it
        reps.sort((a, b) => b.from.length - a.from.length);
      }
      if ((changeType === 'color_or_land' || changeType === 'land_only') &&
          typeof buildLandTypeReplacementPairs === 'function') {
        const expanded = [];
        const seen = new Set();
        for (const { from, to } of reps) {
          const pairs = buildLandTypeReplacementPairs(from, to);
          for (const p of pairs) {
            const key = p.from.toLowerCase();
            if (!seen.has(key)) { seen.add(key); expanded.push(p); }
          }
        }
        reps = expanded;
        reps.sort((a, b) => b.from.length - a.from.length);
      }
      let text = state.oracleText;
      for (const { from, to, pluralTo } of reps) {
        if (!from || !to) continue;
        const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // For land types where singular=plural (e.g. "Plains"), use context to detect plural
        // "Plains are" = plural → use pluralTo; "Plains is" / other = singular → use to
        if (pluralTo && pluralTo !== to) {
          const ctxRegex = new RegExp(escaped + '(?=\\s+are\\b)', 'gi');
          text = text.replace(ctxRegex, (match) => {
            if (match[0] === match[0].toUpperCase()) return pluralTo.charAt(0).toUpperCase() + pluralTo.slice(1);
            return pluralTo.toLowerCase();
          });
        }
        const regex = new RegExp(escaped, 'gi');
        text = text.replace(regex, (match) => {
          if (match[0] === match[0].toUpperCase()) return to.charAt(0).toUpperCase() + to.slice(1);
          return to.toLowerCase();
        });
        changes.push(`Text: "${from}" \u2192 "${to}"`);
        // For creature type changes, also replace matching subtypes in the type line
        if (changeType === 'creature_type') {
          const fromCap = from.charAt(0).toUpperCase() + from.slice(1);
          const toCap = to.charAt(0).toUpperCase() + to.slice(1);
          const idx = state.subtypes.indexOf(fromCap);
          if (idx >= 0) {
            state.subtypes[idx] = toCap;
            changes.push(`Subtype: "${fromCap}" \u2192 "${toCap}"`);
          }
        }
        // For land type changes, also replace matching subtypes in the type line (CR 305.6)
        if (changeType === 'color_or_land' || changeType === 'land_only') {
          const fromCap = from.charAt(0).toUpperCase() + from.slice(1);
          const toCap = to.charAt(0).toUpperCase() + to.slice(1);
          const idx = state.subtypes.indexOf(fromCap);
          if (idx >= 0) {
            state.subtypes[idx] = toCap;
            changes.push(`Subtype: "${fromCap}" \u2192 "${toCap}"`);
          }
        }
      }
      // Fix article agreement after word replacements (a/an)
      text = text.replace(/\ba\s+([aeiouAEIOU])/g, (m, vowel) => 'an ' + vowel);
      text = text.replace(/\ban\s+([^aeiouAEIOU\s])/g, (m, consonant) => 'a ' + consonant);
      state.oracleText = text;
      // Re-derive abilities from updated oracle text, then re-add intrinsic mana abilities for
      // any basic land subtypes (CR 305.6) \u2014 these live in the type line, not in the oracle text.
      const tcAbilities = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (typeof BASIC_LAND_MANA !== 'undefined') {
        for (const subtype of state.subtypes) {
          const manaAbility = BASIC_LAND_MANA[subtype];
          if (manaAbility && !tcAbilities.includes(manaAbility)) {
            tcAbilities.push(manaAbility);
          }
        }
      }
      state.abilities = tcAbilities;
      state.oracleTextModified = true;
      break;
    }

    case EFFECT_TYPE.CDA_PT: {
      // Layer 7a: characteristic-defining ability sets P/T.
      if (!state.types.includes('Creature')) break;
      let val = null;
      if (effect.params.compute && effect._allStates) {
        val = effect.params.compute(effect._allStates);
      }
      // Auto-compute "for each" counts from battlefield state
      if (val === null && effect.params.forEachDesc && effect._allStates) {
        val = _computeForEachCount(effect.params.forEachDesc, effect._allStates, state, effect);
      }
      if (val === null || val === undefined) {
        val = state.cdaUserValue ?? 0;
      }
      // Apply user adjustment if any (override auto-compute)
      if (effect.params.userAdjustable && state.cdaUserValue !== null && state.cdaUserValue !== undefined) {
        val = state.cdaUserValue;
      }
      // Apply max cap if specified
      if (effect.params.maxCount !== undefined && val > effect.params.maxCount) {
        val = effect.params.maxCount;
      }
      const oldP = state.power, oldT = state.toughness;
      // "for each" pattern: multiply base boost by count and ADD to current P/T
      if (effect.params.basePower !== undefined) {
        state.power += effect.params.basePower * val;
        state.toughness += effect.params.baseToughness * val;
        changes.push(`${effect.params.forEachDesc || 'CDA'}: ${effect.params.basePower >= 0 ? '+' : ''}${effect.params.basePower * val}/${effect.params.baseToughness >= 0 ? '+' : ''}${effect.params.baseToughness * val} (count: ${val}) → now ${state.power}/${state.toughness}`);
      } else {
        // "N plus the number of" pattern: add base value to count
        const base = effect.params.cdaBaseValue || 0;
        if (effect.params.toughnessOnly) {
          // Toughness-only CDA: power stays at its printed/current value.
          state.toughness = val + base;
          changes.push(`CDA set toughness to ${state.toughness} (count: ${val}${base ? ', base: ' + base : ''}, was ${oldT})`);
        } else if (effect.params.powerOnly) {
          // Power-only CDA (e.g. Namor the Sub-Mariner): toughness stays at its printed/current value.
          state.power = val + base;
          changes.push(`CDA set power to ${state.power} (count: ${val}${base ? ', base: ' + base : ''}, was ${oldP})`);
        } else {
          state.power = val + base;
          state.toughness = val + base + (effect.params.toughBonus || 0);
          changes.push(`CDA set P/T to ${state.power}/${state.toughness} (count: ${val}${base ? ', base: ' + base : ''}, was ${oldP}/${oldT})`);
        }
      }
      break;
    }

    case EFFECT_TYPE.KEYWORD_COUNTER: {
      // Layer 6: keyword counters grant abilities
      const keyword = effect.params.keyword;
      if (keyword && !state.abilities.includes(keyword)) {
        state.abilities.push(keyword);
        changes.push(`Keyword counter grants "${keyword}"`);
        if (/\bchangeling\b/i.test(keyword)) state.hasChangeling = true;
      }
      break;
    }

    case EFFECT_TYPE.SWITCH_PT: {
      // Layer 7d: swap power and toughness.
      if (!state.types.includes('Creature')) break;
      const oldP = state.power, oldT = state.toughness;
      state.power = oldT;
      state.toughness = oldP;
      changes.push(`Switched P/T: ${oldP}/${oldT} → ${state.power}/${state.toughness}`);
      break;
    }

    case EFFECT_TYPE.SET_NAME: {
      const oldName = state.name;
      state.name = effect.params.name;
      changes.push(`Renamed "${oldName}" \u2192 "${state.name}"`);
      break;
    }

    case EFFECT_TYPE.GAIN_ACTIVATED_FROM_OTHERS: {
      // Gain activated (and optionally triggered) abilities from other permanents on the battlefield.
      // Param-driven so it covers both Marvin, Murderous Mimic (creatures you control, different name)
      // and Manascape Refractor (all lands on the battlefield, any controller, same name allowed).
      const selfName = state.name;
      const selfController = state.controller;
      const _reqType = effect.params.requireType || null;       // e.g. 'Land' / 'Creature'; null = any
      const _sameController = !!effect.params.sameController;     // restrict to source's controller
      const _differentName = !!effect.params.differentName;      // skip permanents sharing the source's name
      const _includeTriggered = !!effect.params.includeTriggered;
      const _requireCounter = effect.params.requireCounter || null; // e.g. '+1/+1'; require this counter on the other perm
      if (!effect._allStates) break;
      for (const [pid, otherState] of effect._allStates) {
        if (pid === effect.sourceId) continue; // skip self
        if (_differentName && otherState.name === selfName) continue;
        if (_reqType && !otherState.types.includes(_reqType)) continue;
        if (_sameController && otherState.controller !== selfController) continue;
        if (_requireCounter && !(otherState.counters && otherState.counters[_requireCounter] > 0)) continue;
        // Skip under-mutate cards — their abilities are already merged into the top card's state
        if (typeof Battlefield !== 'undefined' && Battlefield.getStack) {
          const _stack = Battlefield.getStack(pid);
          if (_stack && _stack[0] !== pid) continue;
        }
        // Extract abilities from this permanent's current abilities
        for (const ab of otherState.abilities) {
          if (/^enchant\s/i.test(ab.trim())) continue; // skip "enchant [type]" lines
          const isTriggered = /^(?:when(?:ever)?|at)\b/i.test(ab.trim());
          const colonIdx = ab.indexOf(':');
          const isActivated = colonIdx >= 0 && !isTriggered;
          if (!isActivated && !(_includeTriggered && isTriggered)) continue;
          if (isActivated && !ab.substring(colonIdx + 1).trim()) continue;
          // Add it (duplicates are fine for activated abilities)
          state.abilities.push(ab);
          const kind = isActivated ? 'activated' : 'triggered';
          changes.push(`Gained ${kind} ability from "${otherState.name}": "${ab}"`);
        }
      }
      break;
    }

    case EFFECT_TYPE.GAIN_ACTIVATED_FROM_GRAVEYARDS: {
      // Necrotic Ooze: gain all activated abilities of creature cards in all graveyards
      if (typeof Battlefield === 'undefined' || !Battlefield.players) break;
      // If a continuous effect strips all abilities from cards in graveyards (Yixlid Jailer:
      // "Cards in graveyards lose all abilities."), those cards have no activated abilities to
      // grant, so this effect produces nothing. The grant therefore depends on that removal
      // (CR 613.8) — see the matching dependency rule in engine-deps.js. The source must still
      // be on the battlefield for its zone effect to be live.
      if (Array.isArray(Battlefield.effects) && Battlefield.effects.some(e =>
            e.type === EFFECT_TYPE.REMOVE_ABILITIES &&
            e.appliesToNonBattlefieldZones &&
            Array.isArray(e.nonBattlefieldZones) && e.nonBattlefieldZones.includes('graveyard') &&
            e.sourceId && (typeof Battlefield.getPermById !== 'function' || Battlefield.getPermById(e.sourceId)))) {
        break;
      }
      for (const player of Battlefield.players) {
        if (!player.graveyard || !player.graveyard.length) continue;
        for (const card of player.graveyard) {
          // Only process creature cards. Uses the COMPUTED zone state so a card that's a creature
          // only outside the battlefield (Grist, the Hunger Tide — a 1/1 Insect creature in the
          // graveyard via its own Layer 4 ability) qualifies. _isCreatureCardInZone short-circuits
          // on the printed type line and guards against re-entrant zone evaluation.
          const isCreatureCard = (typeof _isCreatureCardInZone === 'function')
            ? _isCreatureCardInZone(card, 'graveyard')
            : ((card.type_line || card.typeLine || '').toLowerCase().includes('creature'));
          if (!isCreatureCard) continue;
          // Extract abilities from oracle text. Substitute the card's own name — including short
          // proper-noun forms like "Grist" for "Grist, the Hunger Tide" — with "this card" so the
          // gained ability reads correctly on the Ooze (e.g. "put a loyalty counter on this card").
          let oracle = card.oracle_text || card.oracleText || '';
          if (!oracle) continue;
          if (typeof _replaceProperNounSelfRef === 'function') oracle = _replaceProperNounSelfRef(card.name, oracle);
          const strippedOracle = oracle.replace(/\s*\([^)]*\)/g, '').replace(/  +/g, ' ').trim();
          const abilityLines = strippedOracle.split('\n').map(l => l.trim()).filter(Boolean);
          for (const ab of abilityLines) {
            // Must be an activated ability (contains ":")
            const colonIdx = ab.indexOf(':');
            if (colonIdx < 0) continue;
            // Skip triggered abilities
            if (/^(?:when(?:ever)?|at)\b/i.test(ab)) continue;
            // Skip enchant lines
            if (/^enchant\s/i.test(ab)) continue;
            const effectText = ab.substring(colonIdx + 1).trim();
            if (!effectText) continue;
            // Catch any remaining full-name reference the proper-noun pass didn't cover.
            const normalizedAb = ab.replace(new RegExp('\\b' + card.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), 'this card');
            state.abilities.push(normalizedAb);
            changes.push(`Gained activated ability from "${card.name}" (graveyard): "${normalizedAb}"`);
          }
        }
      }
      break;
    }

    case EFFECT_TYPE.GAIN_ACTIVATED_FROM_EXILE: {
      // Mairsil / Agatha's Soul Cauldron / Idris (Soul of the TARDIS):
      // gain activated (and optionally triggered) abilities from cards in exile.
      if (typeof Battlefield === 'undefined' || !Battlefield.exile) break;
      // If a continuous effect strips all abilities from cards in exile (a Yixlid-style
      // "Cards in exile lose all abilities."), those cards have no abilities to grant, so this
      // effect produces nothing. The grant therefore depends on that removal (CR 613.8) — see
      // the matching dependency rule in engine-deps.js. The source must still be on the
      // battlefield for its zone effect to be live.
      if (Array.isArray(Battlefield.effects) && Battlefield.effects.some(e =>
            e.type === EFFECT_TYPE.REMOVE_ABILITIES &&
            e.appliesToNonBattlefieldZones &&
            Array.isArray(e.nonBattlefieldZones) && e.nonBattlefieldZones.includes('exile') &&
            e.sourceId && (typeof Battlefield.getPermById !== 'function' || Battlefield.getPermById(e.sourceId)))) {
        break;
      }
      const _exSourceId = effect.sourceId;
      const _exFilterCounter = effect.params.filterCounter || null;
      const _exFilterTag = !!effect.params.filterTagToSource;
      const _exRequireOwner = !!effect.params.requireOwnerMatch;
      const _exIncludeTriggered = !!effect.params.includeTriggered;
      const _exRequireCreature = !!effect.params.requireCreature;
      const _exRequireCardType = effect.params.requireCardType || null;
      const _exController = state.controller || 'player_0';
      for (const entry of Battlefield.exile) {
        if (_exFilterTag && entry.exiledWithId !== _exSourceId) continue;
        if (_exFilterCounter && !(entry.counters && entry.counters[_exFilterCounter] > 0)) continue;
        if (_exRequireOwner && entry.owner !== _exController) continue;
        if (entry.isFaceDown) continue;
        const card = entry.card;
        // "creature cards exiled with…" (Agatha's Soul Cauldron) uses the COMPUTED zone state so a
        // card that's a creature only outside the battlefield (Grist, the Hunger Tide) qualifies.
        if (_exRequireCreature) {
          const exIsCreature = (typeof _isCreatureCardInZone === 'function')
            ? _isCreatureCardInZone(card, 'exile')
            : ((card.type_line || card.typeLine || '').toLowerCase().includes('creature'));
          if (!exIsCreature) continue;
        }
        // "land cards exiled with…" (Steward of the Harvest) etc. — gate on the printed type line.
        if (_exRequireCardType) {
          const _tl = (card.type_line || card.typeLine || '').toLowerCase();
          if (!_tl.includes(_exRequireCardType.toLowerCase())) continue;
        }
        let oracle = card.oracle_text || card.oracleText || '';
        if (!oracle) continue;
        // Substitute the card's own name (incl. short proper-noun forms like "Grist") with
        // "this card" so the gained ability reads correctly on the source.
        if (typeof _replaceProperNounSelfRef === 'function') oracle = _replaceProperNounSelfRef(card.name, oracle);
        const strippedOracle = oracle.replace(/\s*\([^)]*\)/g, '').replace(/  +/g, ' ').trim();
        const abilityLines = strippedOracle.split('\n').map(l => l.trim()).filter(Boolean);
        for (const ab of abilityLines) {
          if (/^enchant\s/i.test(ab)) continue;
          const isTriggered = /^(?:when(?:ever)?|at)\b/i.test(ab);
          const colonIdx = ab.indexOf(':');
          const isActivated = colonIdx >= 0 && !isTriggered;
          if (!isActivated && !(_exIncludeTriggered && isTriggered)) continue;
          if (isActivated) {
            const effectText = ab.substring(colonIdx + 1).trim();
            if (!effectText) continue;
          }
          const normalizedAb = ab.replace(new RegExp('\\b' + card.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), 'this card');
          state.abilities.push(normalizedAb);
          const why = _exFilterCounter ? `with ${_exFilterCounter} counter` : 'tagged with this card';
          const kind = isActivated ? 'activated' : 'triggered';
          changes.push(`Gained ${kind} ability from "${card.name}" (exile, ${why}): "${normalizedAb}"`);
        }
      }
      break;
    }

    case EFFECT_TYPE.IMPRINT_PROTECTION_FROM_TYPES: {
      // Mirror Golem: gain "Protection from <type>" for each card type of the imprinted card.
      if (typeof _getImprintedExileEntries !== 'function') break;
      const entries = _getImprintedExileEntries(effect.sourceId);
      const last = entries.length ? entries[entries.length - 1] : null;
      if (!last || !last.card) break;
      const tl = last.card.type_line || '';
      // Strip the subtype tail "Foo — Bar Baz" → "Foo"
      const mainSegment = tl.split('—')[0].trim() || tl.trim();
      const words = mainSegment.split(/\s+/).filter(Boolean);
      // Card types (master types) — distinguished from supertypes by TypeCatalog.
      const cardTypes = [];
      for (const w of words) {
        if (typeof TypeCatalog !== 'undefined' && TypeCatalog.isCardType && TypeCatalog.isCardType(w)) {
          if (!cardTypes.includes(w)) cardTypes.push(w);
        }
      }
      if (!cardTypes.length) {
        changes.push(`(Exiled card "${last.card.name}" has no recognized card types.)`);
        break;
      }
      for (const t of cardTypes) {
        const ability = `Protection from ${t}`;
        if (!state.abilities.includes(ability)) {
          state.abilities.push(ability);
          changes.push(`Gained "${ability}" (from imprinted "${last.card.name}").`);
        }
      }
      break;
    }

    case EFFECT_TYPE.CONTROL: {
      // Layer 2: control-changing effects (CR 613.1b)
      if (effect.params.exchangeControl) {
        // Exchange control: swap controllers of two permanents simultaneously
        const exchKey = effect.id || effect.sourceId;
        if (context && context.exchangeApplied && context.exchangeApplied.has(exchKey)) {
          // Already applied the swap — just report for the second permanent
          changes.push('Control exchanged (swap applied).');
          break;
        }
        if (context && context.exchangeApplied) context.exchangeApplied.add(exchKey);
        const allSt = effect._allStates;
        if (!allSt) { changes.push('(Exchange requires global state.)'); break; }
        const idA = effect.params.exchangeTargetA;
        const idB = effect.params.exchangeTargetB;
        const stA = allSt.get(idA);
        const stB = allSt.get(idB);
        if (!stA || !stB) { changes.push('(Exchange targets not found.)'); break; }
        const ctrlA = effect.params.snapshotControllerA != null ? effect.params.snapshotControllerA : stA.controller;
        const ctrlB = effect.params.snapshotControllerB != null ? effect.params.snapshotControllerB : stB.controller;
        stA.controller = ctrlB;
        stB.controller = ctrlA;
        // If either target is in a mutate stack, all other stack members move with it.
        if (typeof Battlefield !== 'undefined' && Battlefield.getStack) {
          const stackA = Battlefield.getStack(idA);
          if (stackA) {
            for (const memberId of stackA) {
              if (memberId === idA) continue;
              const memberState = allSt.get(memberId);
              if (memberState) memberState.controller = ctrlB;
            }
          }
          const stackB = Battlefield.getStack(idB);
          if (stackB) {
            for (const memberId of stackB) {
              if (memberId === idB) continue;
              const memberState = allSt.get(memberId);
              if (memberState) memberState.controller = ctrlA;
            }
          }
        }
        const _getName = (id) => {
          if (typeof Battlefield !== 'undefined') {
            const p = Battlefield.getPermById(id);
            if (p) return p.name + (p.label ? ` ${p.label}` : '');
          }
          return id;
        };
        const nameA = _getName(idA);
        const nameB = _getName(idB);
        const playerA = (typeof Battlefield !== 'undefined' && Battlefield.getPlayerName)
          ? Battlefield.getPlayerName(ctrlB) : ctrlB;
        const playerB = (typeof Battlefield !== 'undefined' && Battlefield.getPlayerName)
          ? Battlefield.getPlayerName(ctrlA) : ctrlA;
        changes.push(`Control exchanged: ${nameA} → ${playerA}, ${nameB} → ${playerB}`);
        break;
      }
      // For "you control enchanted/equipped" effects, resolve "you" as the current controller
      // of the source permanent in allStates (which may have been updated by earlier Layer 2
      // effects like Lay Claim). Fall back to newController if source not found.
      const newCtrl = (effect.params.useSourceController && effect._allStates)
        ? getEffectControllerId(effect, effect._allStates)
        : effect.params.newController;
      if (newCtrl && state.controller !== newCtrl) {
        state.controller = newCtrl;
        const playerName = (typeof Battlefield !== 'undefined' && Battlefield.getPlayerName)
          ? Battlefield.getPlayerName(newCtrl) : newCtrl;
        changes.push(`Controller changed to ${playerName}`);
      }
      break;
    }

    default:
      changes.push(`(Unhandled effect type: ${effect.type})`);
  }
  return changes;
}
/* [END: APPLY-EFFECT] */
