/* cards-battlefield.js — Battlefield: global state singleton. */

/* Canonical default per-player gameState. Used by the share-link recipe to strip keys
   left at their default (isYourTurn defaults to false here — only the active player
   carries an explicit `true`) and by restore() to backfill any stripped key. The player
   constructor below hardcodes the same values for the initial seats. */
const DEFAULT_GAME_STATE = {
  handSize: 7,
  drawsThisTurn: 0,
  graveyardCount: 0,
  startingLife: 20,
  currentLife: 20,
  isYourTurn: false,
  isMonarch: false,
  hasInitiative: false,
  poisonCounters: 0,
  experienceCounters: 0,
  customCounters: {},
};

/* [KEY: BATTLEFIELD]  —  Global state */
const Battlefield = {
  permanents: [],
  effects: [],
  nextTimestamp: 1,
  inspectedId: null,
  explanationMode: 'teaching', // 'teaching' | 'rules'

  // Multiplayer: array of player objects. Default single player is 'player_0'.
  players: [
    {
      id: 'player_0',
      name: 'Player 1',
      gameState: {
        handSize: 7,
        drawsThisTurn: 0,
        graveyardCount: 0,
        startingLife: 20,
        currentLife: 20,
        isYourTurn: true,
        isMonarch: false,
        hasInitiative: false,
        poisonCounters: 0,
        experienceCounters: 0,
        customCounters: {},
      },
      commanders: [],
      graveyard: [],
      emblems: [],
    },
  ],
  activePlayerId: 'player_0',
  nextPlayerId: 1,

  // Evaluation cache — bump _cacheVersion whenever board state changes;
  // getAllFinalStates / evaluate return cached results when version matches.
  _cacheVersion: 0,
  _cachedFinalStates: null,
  _cachedFinalStatesVersion: -1,
  // Per-perm inspector cache: Map<permId → evaluatePermanent result>.
  // Precomputed for all perms during getAllFinalStates() so card clicks are free.
  _inspectorCache: new Map(),
  _inspectorCacheVersion: -1,

  _invalidate() { this._cacheVersion++; },

  // O(1) permanent lookup by id. Rebuilt lazily when _cacheVersion changes.
  _permById: null,
  _permByIdVersion: -1,
  getPermById(id) {
    if (this._permByIdVersion !== this._cacheVersion || this._permById === null) {
      const map = new Map();
      for (const p of this.permanents) map.set(p.id, p);
      this._permById = map;
      this._permByIdVersion = this._cacheVersion;
    }
    return this._permById.get(id);
  },

  // Game state: getter/setter routes to active player's gameState
  get gameState() { return this.getActivePlayer().gameState; },
  set gameState(val) { this.getActivePlayer().gameState = val; },

  // Player management
  getPlayer(id) { return this.players.find(p => p.id === id); },
  getActivePlayer() { return this.getPlayer(this.activePlayerId) || this.players[0]; },

  addPlayer(name) {
    const id = 'player_' + (this.nextPlayerId++);
    const player = {
      id,
      name: name || 'Player ' + this.nextPlayerId,
      gameState: {
        handSize: 7,
        drawsThisTurn: 0,
        graveyardCount: 0,
        startingLife: 20,
        currentLife: 20,
        isYourTurn: false,
        isMonarch: false,
        hasInitiative: false,
        poisonCounters: 0,
        experienceCounters: 0,
        customCounters: {},
      },
      commanders: [],
      graveyard: [],
      emblems: [],
    };
    this.players.push(player);
    return player;
  },

  removePlayer(id) {
    if (id === 'player_0') return; // cannot remove default player
    this.players = this.players.filter(p => p.id !== id);
    // Remove all permanents and effects owned by this player
    this.effects = this.effects.filter(e => e.ownerId !== id);
    this.permanents = this.permanents.filter(p => p.owner !== id);
    // Switch to player_0 if active player was removed
    if (this.activePlayerId === id) {
      this.activePlayerId = 'player_0';
      this.inspectedId = null;
    }
    this.updateLabels();
  },

  setActivePlayer(id) {
    if (!this.getPlayer(id)) return;
    this.activePlayerId = id;
    // Clear inspectedId if it's not on the new player's board
    if (this.inspectedId) {
      const perm = this.getPermById(this.inspectedId);
      if (perm && perm.controller !== id) this.inspectedId = null;
    }
  },

  getPlayerName(id) {
    const p = this.getPlayer(id);
    return p ? p.name : id;
  },

  // Triggered/activated ability tracking
  // triggerCounts: Map<permId, Map<abilityIndex, countThisTurn>>
  triggerCounts: new Map(),
  activateCounts: new Map(),

  /* Reset trigger and activate counts (call when starting a new turn). */
  resetTriggerCounts() { this.triggerCounts.clear(); this.activateCounts.clear(); },

  /* Get how many times a triggered ability has fired this turn. */
  getTriggerCount(permId, abilityIdx) {
    const m = this.triggerCounts.get(permId);
    return m ? (m.get(abilityIdx) || 0) : 0;
  },

  /* Get how many times an activated ability has been activated this turn. */
  getActivateCount(permId, abilityIdx) {
    const m = this.activateCounts.get(permId);
    return m ? (m.get(abilityIdx) || 0) : 0;
  },

  /* Extract triggered abilities from a computed ability list.
     Returns array of { index, fullText, effectText, triggerLimit }
     where effectText is the parseable part (after the first comma).
     triggerLimit is null (unlimited) or a number. */
  extractTriggeredAbilities(abilities) {
    const result = [];
    for (let i = 0; i < abilities.length; i++) {
      const ab = abilities[i];
      // Strip ability word prefix (e.g. "Eminence — ") ALWAYS before any parsing.
      // All words before an em dash are flavor/ability words with no rules meaning.
      const stripped = ab.trim().replace(/^[^{\n.;"—\u2014]+[\u2014—]\s*/g, '');
      // Triggered abilities start with "when", "whenever", or "at" (CR 603.1)
      if (!/^(?:when(?:ever)?|at)\b/i.test(stripped)) continue;
      // Extract effect text from the STRIPPED version (after first comma)
      const commaIdx = stripped.indexOf(',');
      if (commaIdx < 0) continue; // no effect portion found
      const effectText = stripped.substring(commaIdx + 1).trim();
      if (!effectText) continue;
      // Detect trigger limit: "This ability triggers only once/twice each turn."
      let triggerLimit = null;
      const trigLimitMatch = stripped.match(/this ability triggers only (\w+)(?: times)? each turn/i);
      if (trigLimitMatch) {
        triggerLimit = _parseWordNumber(trigLimitMatch[1]);
      }
      result.push({ index: i, fullText: ab, effectText, triggerLimit });
    }
    return result;
  },

  /* Extract activated abilities from a computed ability list.
     Returns array of { index, fullText, effectText, costText }
     Activated abilities contain ":" separating cost from effect (CR 602.1).
     Mana abilities and loyalty abilities are included. */
  extractActivatedAbilities(abilities) {
    const result = [];
    for (let i = 0; i < abilities.length; i++) {
      const ab = abilities[i];
      // Strip ability word prefix (e.g. "Eminence — ") ALWAYS before any parsing.
      const stripped = ab.trim().replace(/^[^{\n.;"—\u2014]+[\u2014—]\s*/g, '');
      // Detect Crew N keyword (reminder text stripped: "Crew 3" with no colon)
      const crewMatch = stripped.match(/^Crew\s+(\d+)\s*$/i);
      if (crewMatch) {
        result.push({ index: i, fullText: ab, effectText: stripped, costText: '',
                      activateLimit: null, isMonstrosity: false, monstrosityN: 0,
                      isCrew: true, crewN: parseInt(crewMatch[1], 10), options: null });
        continue;
      }
      // Detect Saddle N keyword
      const saddleMatch = stripped.match(/^Saddle\s+(\d+)\s*$/i);
      if (saddleMatch) {
        result.push({ index: i, fullText: ab, effectText: stripped, costText: '',
                      activateLimit: null, isMonstrosity: false, monstrosityN: 0,
                      isSaddle: true, saddleN: parseInt(saddleMatch[1], 10), options: null });
        continue;
      }
      // Detect Equip {cost} keyword (no colon in keyword shorthand)
      // Use ((?:\{[^}]+\})+|\d+) to handle multi-symbol costs like {1}{W}
      const equipMatch = stripped.match(/^Equip(?:\s+—\s+[^{]+)?\s*((?:\{[^}]+\})+|\d+)\.?\s*$/i);
      if (equipMatch) {
        result.push({ index: i, fullText: ab, effectText: stripped, costText: equipMatch[1],
                      activateLimit: null, isMonstrosity: false, monstrosityN: 0,
                      isEquip: true, equipCost: equipMatch[1], options: null });
        continue;
      }
      // Detect Reconfigure {cost} keyword
      const reconfigureMatch = stripped.match(/^Reconfigure\s+((?:\{[^}]+\})+|\d+)\.?\s*$/i);
      if (reconfigureMatch) {
        result.push({ index: i, fullText: ab, effectText: stripped, costText: reconfigureMatch[1],
                      activateLimit: null, isMonstrosity: false, monstrosityN: 0,
                      isReconfigure: true, reconfigureCost: reconfigureMatch[1], options: null });
        continue;
      }
      // Detect Fortify {cost} keyword (like Equip but for Fortifications attaching to lands)
      const fortifyMatch = stripped.match(/^Fortify\s+((?:\{[^}]+\})+|\d+)\.?\s*$/i);
      if (fortifyMatch) {
        result.push({ index: i, fullText: ab, effectText: stripped, costText: fortifyMatch[1],
                      activateLimit: null, isMonstrosity: false, monstrosityN: 0,
                      isFortify: true, fortifyCost: fortifyMatch[1], options: null });
        continue;
      }
      const colonIdx = stripped.indexOf(':');
      if (colonIdx < 0) continue;
      // Skip triggered abilities (they may contain colons in their effect text)
      if (/^(?:when(?:ever)?|at)\b/i.test(stripped)) continue;
      // Skip "enchant [type]" lines
      if (/^enchant\s/i.test(stripped)) continue;
      // Skip "gains quoted ability" lines (e.g. saga chapters: 'This Saga gains "{T}: Add {C}."')
      // The colon is inside the quoted string, not a cost separator.
      if (stripped.substring(0, colonIdx).includes('"')) continue;
      const costText = stripped.substring(0, colonIdx).trim();
      const effectText = stripped.substring(colonIdx + 1).trim();
      if (!effectText) continue;
      // Detect activation limit: "Activate only once/twice each turn." / "Activate this ability only once/twice each turn."
      let activateLimit = null;
      const actLimitMatch = stripped.match(/activate(?:\s+this\s+ability)?\s+only\s+(\w+)(?: times)?\s+each\s+turn/i);
      if (actLimitMatch) {
        activateLimit = _parseWordNumber(actLimitMatch[1]);
      }
      // Detect Monstrosity N — an activated ability that can only fire if the
      // creature isn't already monstrous (CR 701.28). When it fires, N +1/+1
      // counters are placed on the creature and it gains the Monstrous trait.
      let isMonstrosity = false;
      let monstrosityN = 0;
      const monMatch = effectText.match(/^monstrosity\s+(\d+)\s*\.?\s*$/i);
      if (monMatch) {
        isMonstrosity = true;
        monstrosityN = parseInt(monMatch[1], 10);
      }
      // Detect "or"-style option splits (e.g. "gets +1/-1 or -1/+1", "gains flying or first strike").
      // Find a leading subject phrase + verb, then split the predicate on top-level " or ".
      // Skip "your choice of ..." (N-way comma list — too risky to auto-split).
      // Strip "Activate only …" condition tail first so "three or more" inside the condition
      // doesn't look like a predicate-level " or " choice.
      const effectForSplit = effectText.replace(/\s*\.\s*Activate(?:\s+this\s+ability)?\s+only\s+[^.]+\.?\s*$/i, '');
      let options = null;
      if (!isMonstrosity && !/your choice of/i.test(effectForSplit)) {
        const verbRe = /^(.+?\s+)(gets?|gains?|has|have|deals?|becomes?|loses?)\s+(.+)$/i;
        const vm = effectForSplit.match(verbRe);
        if (vm) {
          const subj = vm[1], verb = vm[2], pred = vm[3];
          // Only split on a single top-level " or ". Require a trailing clause or period so we don't
          // catch an " or " that's part of an adverbial tail ("... until end of turn. or ..." won't occur,
          // but we also skip if there are multiple " or " at top level).
          // Strip a trailing shared-modifier (e.g. "until end of turn", "this turn") and re-apply
          // to both options so "+1/-1 or -1/+1 until end of turn" → both options get "until end of turn".
          let core = pred, tail = '';
          const tailMatch = pred.match(/\s+(until\s+(?:end\s+of\s+turn|your\s+next\s+turn|end\s+of\s+combat)|this\s+turn)\s*\.?\s*$/i);
          if (tailMatch) {
            core = pred.substring(0, tailMatch.index);
            tail = ' ' + tailMatch[1].trim();
          }
          const parts = core.split(/\s+or\s+/i);
          if (parts.length === 2) {
            const opt1 = `${subj}${verb} ${parts[0].trim()}${tail}`.replace(/\s+/g, ' ').trim();
            const opt2Raw = parts[1].trim();
            const opt2 = /^(gets?|gains?|has|have|deals?|becomes?|loses?|target|enchanted|equipped|this|each|all)\b/i.test(opt2Raw)
              ? `${opt2Raw}${tail}`
              : `${subj}${verb} ${opt2Raw}${tail}`.replace(/\s+/g, ' ').trim();
            options = [opt1, opt2];
          }
        }
      }
      result.push({ index: i, fullText: ab, effectText, costText, activateLimit, isMonstrosity, monstrosityN, options });
    }
    return result;
  },

  /* Capture a lightweight snapshot of every permanent currently on the battlefield, so the
     "board snapshot" popup can render even after some of those cards have been removed.
     Returns plain objects holding only the display fields renderSnapshotBoard reads. */
  _snapshotPermsForCamera() {
    const fields = ['id','name','imageUri','owner','controller','isToken','isFaceDown',
      'faceDownMode','isManualEffect','isSpell','isTriggeredAbility','isActivatedAbility',
      'isEmblem','label','tapped','attacking','blocking','targetId','traits','counters',
      'abilitySourceId','printedTypes','printedSupertypes','printedSubtypes','printedPower',
      'printedToughness','isTransformable','isChooseableFace','isToken','isRoom','roomFaces',
      'roomLocked','isSideways','_isCrewEffect','_isSaddleEffect','_isEnchantPlayer',
      '_enchantedPlayerId','timestamp','hasBestow','classLevel'];
    const perms = this.permanents.map(p => {
      const copy = {};
      for (const f of fields) copy[f] = p[f];
      // Deep-copy mutable bits so later edits don't mutate the snapshot
      copy.traits = Array.isArray(p.traits) ? p.traits.slice() : [];
      copy.counters = p.counters ? { ...p.counters } : {};
      return copy;
    });
    const mutateStacks = (this.mutateStacks || []).map(s => s.slice());
    const bestowTargets = {};
    if (this.bestowTargets) {
      if (this.bestowTargets instanceof Map) {
        for (const [k, v] of this.bestowTargets) bestowTargets[k] = v;
      } else {
        Object.assign(bestowTargets, this.bestowTargets);
      }
    }
    return { perms, mutateStacks, bestowTargets };
  },

  /* Build the full snapshot object stamped onto every spell/ability pseudo-perm. */
  _buildFiredAtSnapshot(firedAtStates) {
    const states = firedAtStates || this.getAllFinalStates();
    const captured = this._snapshotPermsForCamera();
    return {
      states,
      perms: captured.perms,
      mutateStacks: captured.mutateStacks,
      bestowTargets: captured.bestowTargets,
      activePlayerId: this.activePlayerId,
      players: (this.players || []).map(pl => ({ id: pl.id, name: pl.name })),
    };
  },

  /* Shared: create a pseudo-permanent for a triggered/activated ability and parse its effects. */
  _addAbilityPseudo(sourcePermId, abilityIdx, effectText, fullText, kind, firedAtStates) {
    const sourcePerm = this.getPermById(sourcePermId);
    if (!sourcePerm) return null;
    const countMap = kind === 'trigger' ? this.triggerCounts : this.activateCounts;
    if (!countMap.has(sourcePermId)) countMap.set(sourcePermId, new Map());
    const counts = countMap.get(sourcePermId);
    counts.set(abilityIdx, (counts.get(abilityIdx) || 0) + 1);
    const ts = this.nextTimestamp++;
    const prefix = kind === 'trigger' ? 'trig' : 'act';
    const label = kind === 'trigger' ? 'trigger' : 'activated';
    const sourceBaseName = sourcePerm.label ? `${sourcePerm.name} ${sourcePerm.label}` : sourcePerm.name;
    const pseudoPerm = {
      id: prefix + '_' + sourcePermId + '_' + abilityIdx + '_' + ts,
      name: sourceBaseName + ' (' + label + ')',
      timestamp: ts,
      owner: sourcePerm.owner || 'player_0',
      controller: sourcePerm.controller || sourcePerm.owner || 'player_0',
      printedTypes: [], printedSupertypes: [], printedSubtypes: [],
      printedPower: null, printedToughness: null,
      printedAbilities: [], printedColors: [],
      manaValue: 0, manaCost: '', oracleText: effectText,
      imageUri: sourcePerm.imageUri, isManualEffect: true,
      [kind === 'trigger' ? 'isTriggeredAbility' : 'isActivatedAbility']: true,
      abilitySourceId: sourcePermId, abilityIndex: abilityIdx,
      abilityFullText: fullText, isToken: false,
      scryfallData: sourcePerm.scryfallData, counters: {},
    };
    if (firedAtStates) pseudoPerm._firedAtStates = firedAtStates;
    pseudoPerm._firedAtSnapshot = this._buildFiredAtSnapshot(firedAtStates);
    this.permanents.push(pseudoPerm);
    // For triggered/activated abilities, convert "it" / "that creature" subject pronouns
    // to "target [type]" so effects like "Whenever a Cat attacks, it gains trample" become
    // targeted and require user selection.
    // IMPORTANT: This conversion is a UI convenience only — the original ability does NOT
    // actually target, so it bypasses shroud/hexproof. We flag this with _nonTargetingSelection.
    let parsedEffectText = effectText;

    // "where X is this creature's power/toughness/mana value" — substitute X at fire time
    // using the source permanent's live final state (e.g. Ouroboroid).
    if (/\bX\b/.test(parsedEffectText) && firedAtStates && sourcePermId) {
      const sourceFinalState = firedAtStates.get(sourcePermId);
      if (sourceFinalState) {
        const powerMatch = parsedEffectText.match(/,?\s*where\s+X\s+is\s+this\s+creature'?s?\s+power\b/i);
        const toughMatch = parsedEffectText.match(/,?\s*where\s+X\s+is\s+this\s+creature'?s?\s+toughness\b/i);
        const mvMatch    = parsedEffectText.match(/,?\s*where\s+X\s+is\s+(?:this\s+(?:card|permanent|creature)'?s?\s+)?mana\s+value\b/i);
        if (powerMatch) {
          const xVal = sourceFinalState.power || 0;
          parsedEffectText = parsedEffectText
            .replace(powerMatch[0], '')
            .replace(/\bX\b/g, String(xVal));
        } else if (toughMatch) {
          const xVal = sourceFinalState.toughness || 0;
          parsedEffectText = parsedEffectText
            .replace(toughMatch[0], '')
            .replace(/\bX\b/g, String(xVal));
        } else if (mvMatch) {
          const xVal = sourceFinalState.manaValue || 0;
          parsedEffectText = parsedEffectText
            .replace(mvMatch[0], '')
            .replace(/\bX\b/g, String(xVal));
        }
      }
    }

    // "where X is the number of [gameState desc]" — snapshot count at fire time so the
    // displayed effect text and the P/T boost are both frozen to the board state at resolution,
    // not recalculated every time the inspector re-renders.
    if (/\bX\b/.test(parsedEffectText) && firedAtStates) {
      const _whereXMatch = /,?\s*where\s+X\s+is\s+the\s+number\s+of\s+([^.;\n]+)/i.exec(parsedEffectText);
      if (_whereXMatch) {
        const _descRaw = _whereXMatch[1].trim().replace(/\.$/, '');
        const _srcState = sourcePermId ? firedAtStates.get(sourcePermId) : null;
        const _snapVal = _computeForEachCount(_descRaw, firedAtStates, _srcState, null);
        if (_snapVal !== null && _snapVal !== undefined) {
          parsedEffectText = parsedEffectText
            .replace(_whereXMatch[0], _whereXMatch[0].replace(/where\s+X\s+is/i, `where ${_snapVal} is`))
            .replace(/\bX\b/g, String(_snapVal));
        }
      }
    }

    // Strip leading "if [condition], " — this is a resolution condition, not a filter or target.
    // e.g. Eminence: "if this card is in the command zone or on the battlefield, another target Cat..."
    parsedEffectText = parsedEffectText.replace(/^if\s+[^,]+,\s*/i, '');
    // Strip "Activate only if/when/as …" restriction — already enforced at fire time, should not
    // become a continuous layer condition on the pseudo-perm's effects.
    parsedEffectText = parsedEffectText.replace(/\s*\.\s*Activate(?:\s+this\s+ability)?\s+only\s+[^.]+\.?\s*$/i, '');
    // Handle "you may pay {cost}. If you do, [effect]" pattern.
    // This arises in triggered abilities where an optional mana cost gates the effect.
    // For this tool, assume the cost is always paid and parse only the actual effect.
    // Pattern: "you may pay <anything>. If you do, <effect>" (case-insensitive, across sentences)
    parsedEffectText = parsedEffectText.replace(
      /you may pay [^.]+\.\s*If you do,?\s*/gi,
      ''
    );

    // Infer the subject type from the trigger condition (the part before the first comma).
    // This lets us convert "it" → "target Cat" instead of "target creature" for e.g.
    // "Whenever another Cat you control attacks, …it gains trample…"
    let triggerSubject = 'creature'; // safe default
    let triggerHasAnother = false;
    let triggerIsSelf = false; // true when condition starts with "this creature/this permanent/this card"
    if (fullText && kind === 'trigger') {
      const stripped = fullText.trim().replace(/^[^{\n.;"—\u2014]+[\u2014—]\s*/g, '');
      const commaIdx = stripped.indexOf(',');
      const condText = commaIdx >= 0 ? stripped.substring(0, commaIdx) : stripped;
      // Detect self-referential trigger: "this creature/permanent/card/token [action]"
      // In this case "it" in the effect refers back to the source itself.
      // Strip leading trigger keyword ("Whenever/When/At") before testing.
      const condCore = condText.replace(/^(?:when(?:ever)?|at)\s+/i, '');
      if (/^this\s+(?:creature|permanent|card|token)\b/i.test(condCore)) {
        triggerIsSelf = true;
      }
      // "another [subtype/type]" — also marks that the source itself is excluded
      const anotherMatch = condText.match(/\banother\s+([A-Za-z]\w*)/i);
      if (anotherMatch) {
        triggerHasAnother = true;
        triggerSubject = anotherMatch[1];
      } else {
        // "a/an [subtype/type] [action]" — e.g. "a creature attacks you"
        const aMatch = condText.match(/\ban?\s+([A-Za-z]\w*)\s+(?:you\s+(?:control|own)\s+)?(?:attacks?|dies|enters|leaves|is\s+dealt|gains?|loses?)/i);
        if (aMatch) triggerSubject = aMatch[1];
      }
    }
    // "another" or "other [thing]" in the effectText also excludes the source
    // (e.g. "another target creature", "each other creature you control").
    if (/\banother\s+(?:target\s+)?[A-Za-z]/i.test(parsedEffectText) || /\bother\s+[A-Za-z]/i.test(parsedEffectText)) triggerHasAnother = true;
    if (triggerHasAnother) pseudoPerm._excludeAbilitySource = true;

    // Whether the effect already names an explicit "target" (independent of any "it"
    // conversion below). When it does, a pronoun like "It loses all abilities" refers to
    // that chosen target — not the source — so a self-referential trigger must NOT auto-pin
    // the targeted effect to the source (e.g. The Wondrous Wasp: "When [self] enters, tap up
    // to one target creature. It loses all abilities …").
    const _effectTextHadExplicitTarget = /\btarget\b/i.test(parsedEffectText);

    let didItConversion = false;
    if (/\bit\b/i.test(parsedEffectText)) {
      const before = parsedEffectText;
      // Replace "it gets/gains/has/is/becomes/loses" → "target [subject] gets/gains/..."
      parsedEffectText = parsedEffectText.replace(/\bit\s+(get[s]?|gain[s]?|ha[s]|have|is|becomes?|loses?)\b/gi, `target ${triggerSubject} $1`);
      // Replace "its power" / "its toughness" → "that creature's power"
      parsedEffectText = parsedEffectText.replace(/\bits\s+(power|toughness)\b/gi, "that creature's $1");
      if (parsedEffectText !== before) didItConversion = true;
    }
    // Also convert "that creature/permanent" pronouns (e.g. Gahiji: "that creature gets +2/+0")
    {
      const thatBefore = parsedEffectText;
      parsedEffectText = parsedEffectText.replace(
        /\bthat\s+(?:creature|permanent)\s+(get[s]?|gain[s]?|ha[s]|have|is|becomes?|loses?)\b/gi,
        `target ${triggerSubject} $1`
      );
      if (parsedEffectText !== thatBefore) didItConversion = true;
    }
    if (didItConversion) pseudoPerm._nonTargetingSelection = true;
    // Sync oracleText with the fully-processed parsedEffectText (X substituted, "if" stripped, etc.)
    pseudoPerm.oracleText = parsedEffectText;
    const fakeCard = { name: sourcePerm.name, oracle_text: parsedEffectText, type_line: 'Instant', colors: sourcePerm.printedColors, cmc: 0 };
    // Detect "basic land type of your choice" in the ability text so the land-type
    // dropdown appears on the activated-ability pseudo-permanent (not on the source card).
    if (/\bbasic land type of your choice\b/i.test(parsedEffectText)) {
      pseudoPerm.needsChosenLandType = true;
      pseudoPerm.chosenLandType = null;
      pseudoPerm.originalOracleText = parsedEffectText;
      pseudoPerm.originalCard = fakeCard;
    }
    // Pass pseudoPerm directly (not a spread) so choice flags persist on the stored object.
    pseudoPerm.printedTypes = ['Instant'];
    const newEffects = parseCardEffects(pseudoPerm, fakeCard);
    // Determine the ability's overall target restriction from the earliest targeted effect
    // that specifies one. This is stamped on ALL effects so that the snapshot gate in
    // effectAppliesToPerm can uniformly block the ability when the target didn't qualify
    // at fire time — even for effects like REMOVE_ABILITIES that lack their own targetRestriction.
    let abilityTargetRestriction = null;
    if (firedAtStates) {
      for (const eff of newEffects) {
        if (eff.scope === 'targeted' && !eff.selfTarget && eff.targetRestriction) {
          abilityTargetRestriction = eff.targetRestriction;
          break;
        }
      }
    }
    for (const eff of newEffects) {
      eff.isSpellEffect = true;
      eff.sourceId = pseudoPerm.id;
      eff.sourceName = pseudoPerm.name;
      eff.timestamp = ts;
      if (didItConversion) eff._nonTargetingSelection = true;
      if (firedAtStates) eff._firedAtStates = firedAtStates;
      // "each other creature you control" (etc.): exclude the original ability source from
      // global effects. The pseudo-perm's sourceId is the pseudo-perm itself, so the engine's
      // affectsSelf gate (which compares against effect.sourceId) can't see the real source.
      // Stamp the origin id so effectAppliesToPerm can exclude it directly.
      if (pseudoPerm._excludeAbilitySource && eff.scope === 'global' && eff.affectsSelf === false) {
        eff._excludeSourceId = sourcePermId;
      }
      if (abilityTargetRestriction) eff._abilityTargetRestriction = abilityTargetRestriction;
      // Imprint copy from an activated ability (Dermotaxi): the imprinted exile entries are
      // tagged with the original source perm, not the pseudo-perm. Remap so the engine's
      // imprint lookup + selfTarget both resolve to the actual source.
      if (eff.type === EFFECT_TYPE.COPY && eff.params && eff.params.copyFromExiledCard) {
        eff.sourceId = sourcePermId;
        eff.sourceName = sourcePerm.name;
      }
    }
    _pinAbilityEffectsToSource(newEffects, sourcePermId);
    // For self-referential triggers ("this creature attacks → it gains X"), force-pin
    // any remaining unset targeted effects to the source — no dropdown needed.
    // Exception: when the effect explicitly excludes the source ("another/other target
    // creature you control" — Ashroot Animist), pinning to the source would target the very
    // thing it excludes. Leave those unpinned so the UI shows a target dropdown (the source
    // is already filtered out via pseudoPerm._excludeAbilitySource).
    if (triggerIsSelf && !triggerHasAnother && !_effectTextHadExplicitTarget) {
      for (const eff of newEffects) {
        if (eff.scope === 'targeted' && !eff.selfTarget && !eff.targetId) {
          eff.targetId = sourcePermId;
          eff._autoTargetSource = true;
        }
      }
    }
    // If the source is an aura/equipment/fortification that's attached to something, redirect
    // effects that refer to "Enchanted/Equipped/Fortified <perm>" (which _pinAbilityEffectsToSource
    // just auto-pinned to the source itself) to the actual attached permanent.
    // Note: setTarget() stamps targetId on effects, not on the permanent object, so we look
    // it up from existing effects (including the _isEquipTargetEff synthetic tracker for
    // equipment that has no static targeted effects of its own, like Adventuring Gear).
    const _sourceAttachments = sourcePerm.printedSubtypes || [];
    const _isAttachmentSource = _sourceAttachments.includes('Aura') || _sourceAttachments.includes('Equipment') || _sourceAttachments.includes('Fortification');
    if (_isAttachmentSource) {
      const _attachedTargetId = this.effects.find(e =>
        e.sourceId === sourcePermId && e.scope === 'targeted' && e.targetId
      )?.targetId;
      if (_attachedTargetId) {
        const _attachmentWordRe = /\b(enchanted|equipped|fortified)\s+\w+/i;
        for (const eff of newEffects) {
          if (eff._autoTargetSource && eff.targetId === sourcePermId && _attachmentWordRe.test(parsedEffectText)) {
            eff.targetId = _attachedTargetId;
          }
        }
      }
    }
    this.effects.push(...newEffects);
    this.updateLabels();
    return pseudoPerm;
  },

  addTriggeredAbility(sourcePermId, abilityIdx, effectText, fullText, firedAtStates) {
    return this._addAbilityPseudo(sourcePermId, abilityIdx, effectText, fullText, 'trigger', firedAtStates);
  },

  addActivatedAbility(sourcePermId, abilityIdx, effectText, fullText, firedAtStates) {
    return this._addAbilityPseudo(sourcePermId, abilityIdx, effectText, fullText, 'activated', firedAtStates);
  },

  /* ── Shared pseudo-perm decorations ──
     These build the crew / saddle / equip pseudo-perms (and their hand-built
     effects) the same way the live UI does, so board restore can recreate them
     by calling the identical code path. */

  /* Crew (CR 702.122): mark the vehicle Crewed and add an artifact-creature ADD_TYPE. */
  applyCrew(permId, abilityIdx, fullText) {
    const perm = this.getPermById(permId);
    if (!perm) return null;
    if (!perm.traits) perm.traits = [];
    if (!perm.traits.includes('Crewed')) perm.traits.push('Crewed');
    const pseudo = this.addActivatedAbility(permId, abilityIdx, '', fullText);
    if (!pseudo) return null;
    pseudo.name = (perm.label ? `${perm.name} ${perm.label}` : perm.name) + ' (crewed)';
    pseudo._isCrewEffect = true;
    // The ADD_TYPE effect is sourced from the pseudo-perm (not the vehicle) so it survives
    // anything that strips the vehicle's abilities. Manual pseudo-perms are not in allStates,
    // so isSourceViable returns true unconditionally for this effect.
    this.effects.push({
      id: `${pseudo.id}_add_creature`,
      sourceId: pseudo.id,
      sourceName: pseudo.name,
      type: EFFECT_TYPE.ADD_TYPE,
      layer: '4',
      params: { types: ['Artifact', 'Creature'] },
      scope: 'targeted',
      selfTarget: false,
      targetId: permId,
      timestamp: pseudo.timestamp,
      ownerId: pseudo.owner || pseudo.controller || 'player_0',
      desc: 'Crew: This Vehicle becomes an artifact creature until end of turn.',
      _isCrewEffect: true,
      _autoTargetSource: true,
      isSpellEffect: true,
    });
    return pseudo;
  },

  /* Saddle (CR 702.166): mark the mount Saddled (no layer effect of its own). */
  applySaddle(permId, abilityIdx, fullText) {
    const perm = this.getPermById(permId);
    if (!perm) return null;
    if (!perm.traits) perm.traits = [];
    if (!perm.traits.includes('Saddled')) perm.traits.push('Saddled');
    const pseudo = this.addActivatedAbility(permId, abilityIdx, '', fullText);
    if (!pseudo) return null;
    pseudo.name = (perm.label ? `${perm.name} ${perm.label}` : perm.name) + ' (saddled)';
    pseudo._isSaddleEffect = true;
    return pseudo;
  },

  /* Equip / Reconfigure / Fortify attachment: point the equipment's own effects at
     the target, maintain the synthetic Equipped-trait tracker, and (build/update) the
     equip pseudo-perm shown in the timeline. Mirrors applyEquipModal(). */
  applyEquipAttachment(permId, abilityIdx, targetId) {
    const perm = this.getPermById(permId);
    if (!perm || !targetId) return null;
    this.setTarget(permId, targetId);
    if (abilityIdx === null || abilityIdx === undefined) return null;
    // Synthetic tracking effect — drives the 'Equipped' trait on runtime Equipment.
    let synthEff = this.effects.find(e => e.sourceId === permId && e._isEquipTargetEff);
    if (!synthEff) {
      synthEff = {
        id: permId + '_equip_synth',
        layer: '7c', type: EFFECT_TYPE.MODIFY_PT,
        params: { power: 0, toughness: 0 },
        scope: 'targeted', selfTarget: false,
        requiresCreatureTarget: true,
        _isEquipTargetEff: true,
        targetId: null,
        sourceId: permId, sourceName: perm.name,
        timestamp: perm.timestamp,
        desc: 'Equipment attachment tracker',
      };
      this.effects.push(synthEff);
    }
    synthEff.targetId = targetId;
    const permDisplayName = perm.label ? perm.name + ' ' + perm.label : perm.name;
    const targetPerm = this.getPermById(targetId);
    const targetDisplayName = targetPerm
      ? (targetPerm.label ? targetPerm.name + ' ' + targetPerm.label : targetPerm.name)
      : targetId;
    let pseudo = this.permanents.find(p => p._isEquipEffect && p._equipSourceId === permId);
    if (pseudo) {
      pseudo.name = permDisplayName + ' (equipping ' + targetDisplayName + ')';
      pseudo._equipTargetId = targetId;
    } else {
      const fState = this.getAllFinalStates().get(permId);
      const activated = this.extractActivatedAbilities(fState ? (fState.abilities || []) : []);
      const abilityEntry = activated.find(ac => ac.index === abilityIdx);
      const fullText = abilityEntry ? abilityEntry.fullText : '';
      pseudo = this.addActivatedAbility(permId, abilityIdx, '', fullText);
      if (pseudo) {
        pseudo.name = permDisplayName + ' (equipping ' + targetDisplayName + ')';
        pseudo._isEquipEffect = true;
        pseudo._equipSourceId = permId;
        pseudo._equipTargetId = targetId;
      }
    }
    return pseudo;
  },

  /* Exchange triggered abilities (Exchange of Words text-swap, Gilded Drake-style
     control-swap). parseCardEffects does not always emit these for the pronoun
     phrasings, so the live trigger handler injects them onto the pseudo-perm; this
     shared method lets restore re-inject identically. No-op unless the effect text
     matches an exchange phrasing. */
  injectTriggeredExchange(pseudo, sourcePermId, effectText) {
    if (!pseudo || !effectText) return;
    if (/exchange the text boxes/i.test(effectText)) {
      pseudo._exchangeSourcePermId = sourcePermId;
      const hasExch = this.effects.some(e => e.sourceId === pseudo.id &&
        e.type === EFFECT_TYPE.TEXT_CHANGE && e.params && e.params.changeType === 'exchange_text');
      if (!hasExch) {
        this.effects.push({
          id: pseudo.id + '_exchange',
          sourceId: pseudo.id,
          sourceName: pseudo.name,
          type: EFFECT_TYPE.TEXT_CHANGE,
          layer: '3',
          params: { changeType: 'exchange_text', exchangeTargetA: null, exchangeTargetB: null },
          scope: 'targeted',
          timestamp: pseudo.timestamp,
          _exchangeSourcePermId: sourcePermId,
        });
      }
    }
    if (/\bexchange control of\b/i.test(effectText)) {
      const hasExchCtrl = this.effects.some(e =>
        e.sourceId === pseudo.id && e.type === EFFECT_TYPE.CONTROL && e.params.exchangeControl);
      const isSelfExch = /\bthis\s+(?:creature|artifact|enchantment|permanent|card)\s+and\b/i.test(effectText);
      if (!hasExchCtrl) {
        this.effects.push({
          id: pseudo.id + '_exchctrl',
          sourceId: pseudo.id,
          sourceName: pseudo.name,
          type: EFFECT_TYPE.CONTROL,
          layer: '2',
          params: {
            exchangeControl: true,
            exchangeMode: isSelfExch ? 'self_and_target' : 'two_targets',
            exchangeTargetA: isSelfExch ? sourcePermId : null,
            exchangeTargetB: null,
            snapshotControllerA: null,
            snapshotControllerB: null,
            exchangeSelfId: isSelfExch ? sourcePermId : null,
            shareTypeRequired: /\bshare[s]?\s+a\s+(?:permanent|card)\s+type\b/i.test(effectText),
            differentPlayersRequired: false,
          },
          scope: 'targeted',
          timestamp: pseudo.timestamp,
          opponentControlRequired: /\bopponent(?:'?s?)?\s+controls?\b/i.test(effectText) || /\byou\s+neither\s+own\s+nor\s+control\b/i.test(effectText),
          neitherOwnNorControl: /\byou\s+neither\s+own\s+nor\s+control\b/i.test(effectText),
        });
      } else if (isSelfExch) {
        this.effects.forEach(e => {
          if (e.sourceId === pseudo.id && e.type === EFFECT_TYPE.CONTROL && e.params.exchangeControl
              && e.params.exchangeMode === 'self_and_target') {
            e.params.exchangeSelfId = sourcePermId;
            e.params.exchangeTargetA = sourcePermId;
          }
        });
      }
    }
  },

  /* "Becomes a land named X" transform triggers (Princess Yue: when she dies she
     returns as a land named Moon that gains "{T}: Add {C}."). parseCardEffects can
     model none of this — the imperative parts (lose all targeting, take a new
     timestamp) aren't continuous effects, and the rename/type-change/ability-grant
     belong to the trigger's resolution, not a static layered effect. So the trigger
     handler injects them onto the trigger pseudo-perm here, mirroring
     injectTriggeredExchange. No-op unless the effect text matches the phrasing.

     opts.imperative (default true): when false (board restore), only the layered
     effects are re-injected — the source's saved timestamp and cleared targets are
     already encoded in the restored board, so we don't re-run the board mutations. */
  injectTriggeredBecomesLand(pseudo, sourcePermId, effectText, opts) {
    if (!pseudo || !effectText) return;
    // "She's / it's / this card is a land named NAME"
    const landNameMatch = effectText.match(
      /\b(?:she|he|they|it|this card)\s*(?:'s|'re| is| are)?\s+a\s+land\s+named\s+([A-Z][\w'’-]*)/i);
    if (!landNameMatch) return;
    const imperative = !opts || opts.imperative !== false;
    const newName = landNameMatch[1];
    // Optional granted ability inside quotes, e.g. gains "{T}: Add {C}."
    const grantMatch = effectText.match(/\bgains?\s+"([^"]+)"/i);
    const grantedAbility = grantMatch ? grantMatch[1].replace(/\s*\.\s*$/, '') : null;

    pseudo._isBecomesLandTransform = true;

    if (imperative) {
      // Deselect from all targets: the permanent returns as a new object, so any
      // effect that targeted it (auras/equipment/targeted spells) and any target it
      // had chosen itself are cleared.
      for (const e of this.effects) {
        if (e.sourceId === pseudo.id) continue; // leave the freshly-injected effects below
        if (e.targetId === sourcePermId) e.targetId = null;
        if (e.sourceId === sourcePermId && e.targetId) e.targetId = null;
      }
      // Move its timestamp to last (newest).
      const sourcePerm = this.getPermById(sourcePermId);
      if (sourcePerm) {
        const newTs = this.nextTimestamp++;
        this.effects.forEach(e => { if (e.sourceId === sourcePermId) e.timestamp = newTs; });
        sourcePerm.timestamp = newTs;
      }
    }

    const baseEff = (extra) => Object.assign({
      sourceId: pseudo.id,
      sourceName: pseudo.name,
      scope: 'targeted',
      selfTarget: false,
      targetId: sourcePermId,
      timestamp: pseudo.timestamp,
      ownerId: pseudo.owner || pseudo.controller || 'player_0',
      _autoTargetSource: true,
      isSpellEffect: true,
      _isBecomesLandTransform: true,
    }, extra);

    // Layer 3 — rename.
    if (!this.effects.some(e => e.sourceId === pseudo.id && e.type === EFFECT_TYPE.SET_NAME)) {
      this.effects.push(baseEff({
        id: pseudo.id + '_setname',
        type: EFFECT_TYPE.SET_NAME, layer: '3',
        params: { name: newName },
        desc: `This permanent's name becomes ${newName}.`,
      }));
    }
    // Layer 4 — becomes a land (no longer a creature; supertypes like Legendary kept).
    if (!this.effects.some(e => e.sourceId === pseudo.id && e.type === EFFECT_TYPE.SET_TYPE)) {
      this.effects.push(baseEff({
        id: pseudo.id + '_setland',
        type: EFFECT_TYPE.SET_TYPE, layer: '4',
        params: { types: ['Land'] },
        desc: 'This permanent becomes a land (it\'s no longer a creature).',
      }));
    }
    // Layer 6 — gains the quoted ability.
    if (grantedAbility &&
        !this.effects.some(e => e.sourceId === pseudo.id && e.type === EFFECT_TYPE.ADD_ABILITY)) {
      this.effects.push(baseEff({
        id: pseudo.id + '_addability',
        type: EFFECT_TYPE.ADD_ABILITY, layer: '6',
        params: { ability: grantedAbility },
        desc: `This permanent gains "${grantedAbility}."`,
      }));
    }
    this.updateLabels();
  },

  /* Fire an eminence triggered/activated ability from a commander in the command zone.
     Unlike _addAbilityPseudo, this works from the commander card data directly
     since the commander has no permanent on the battlefield. */
  addCommandZoneAbility(commanderIdx, abilityIdx, effectText, fullText, kind, firedAtStates) {
    const commander = this.commanders[commanderIdx];
    if (!commander) return null;
    const face = _resolveCardFace(commander.card, 0);
    const sourceId = 'cmdzone_' + commanderIdx;
    const countMap = kind === 'trigger' ? this.triggerCounts : this.activateCounts;
    if (!countMap.has(sourceId)) countMap.set(sourceId, new Map());
    const counts = countMap.get(sourceId);
    counts.set(abilityIdx, (counts.get(abilityIdx) || 0) + 1);
    const ts = this.nextTimestamp++;
    const prefix = kind === 'trigger' ? 'trig' : 'act';
    const label = kind === 'trigger' ? 'trigger' : 'activated';
    const colors = face.colors || commander.card.colors || [];
    const pseudoPerm = {
      id: prefix + '_' + sourceId + '_' + abilityIdx + '_' + ts,
      name: commander.name + ' (' + label + ', command zone)',
      timestamp: ts,
      owner: this.activePlayerId,
      controller: this.activePlayerId,
      printedTypes: [], printedSupertypes: [], printedSubtypes: [],
      printedPower: null, printedToughness: null,
      printedAbilities: [], printedColors: colors,
      manaValue: 0, manaCost: '', oracleText: effectText,
      imageUri: commander.imageUri, isManualEffect: true,
      [kind === 'trigger' ? 'isTriggeredAbility' : 'isActivatedAbility']: true,
      abilitySourceId: sourceId, abilityIndex: abilityIdx,
      abilityFullText: fullText, isToken: false,
      scryfallData: commander.card, counters: {},
    };
    if (firedAtStates) pseudoPerm._firedAtStates = firedAtStates;
    pseudoPerm._firedAtSnapshot = this._buildFiredAtSnapshot(firedAtStates);
    this.permanents.push(pseudoPerm);
    // Convert "it" subject pronouns to "target creature" for individual creature targeting.
    // This is a UI convenience — the ability does NOT actually target, so it bypasses shroud/hexproof.
    let parsedCmdEffectText = effectText;
    let didCmdItConversion = false;
    if (/\bit\b/i.test(parsedCmdEffectText)) {
      const before = parsedCmdEffectText;
      parsedCmdEffectText = parsedCmdEffectText.replace(/\bit\s+(get[s]?|gain[s]?|ha[s]|have|is|becomes?|loses?)\b/gi, 'target creature $1');
      parsedCmdEffectText = parsedCmdEffectText.replace(/\bits\s+(power|toughness)\b/gi, "that creature's $1");
      if (parsedCmdEffectText !== before) didCmdItConversion = true;
    }
    if (didCmdItConversion) pseudoPerm._nonTargetingSelection = true;
    const fakeCard = { name: commander.name, oracle_text: parsedCmdEffectText, type_line: 'Instant', colors, cmc: 0 };
    const newEffects = parseCardEffects({ ...pseudoPerm, printedTypes: ['Instant'] }, fakeCard);
    let cmdAbilityTargetRestriction = null;
    if (firedAtStates) {
      for (const eff of newEffects) {
        if (eff.scope === 'targeted' && !eff.selfTarget && eff.targetRestriction) {
          cmdAbilityTargetRestriction = eff.targetRestriction;
          break;
        }
      }
    }
    for (const eff of newEffects) {
      eff.isSpellEffect = true;
      eff.sourceId = pseudoPerm.id;
      eff.sourceName = pseudoPerm.name;
      eff.timestamp = ts;
      if (didCmdItConversion) eff._nonTargetingSelection = true;
      if (firedAtStates) eff._firedAtStates = firedAtStates;
      if (cmdAbilityTargetRestriction) eff._abilityTargetRestriction = cmdAbilityTargetRestriction;
    }
    this.effects.push(...newEffects);
    this.updateLabels();
    return pseudoPerm;
  },

  // Commander tracking — routes to active player's commanders
  get commanders() { return this.getActivePlayer().commanders; },
  set commanders(val) { this.getActivePlayer().commanders = val; },

  // Emblem tracking — routes to active player's emblems
  get emblems() { return this.getActivePlayer().emblems || (this.getActivePlayer().emblems = []); },
  set emblems(val) { this.getActivePlayer().emblems = val; },

  // Mutate tracking: array of stacks. Each stack is an ordered array of permIds [top, ..., bottom].
  // The top card's name/types/P&T are authoritative; all cards in the stack share abilities.
  mutateStacks: [],

  /* Find which stack a permId is in. Returns { stackIdx, posIdx } or null. */
  _findInStack(permId) {
    for (let i = 0; i < this.mutateStacks.length; i++) {
      const pos = this.mutateStacks[i].indexOf(permId);
      if (pos !== -1) return { stackIdx: i, posIdx: pos };
    }
    return null;
  },

  /* Get the stack array for a permId, or null. */
  getStack(permId) {
    const loc = this._findInStack(permId);
    return loc ? this.mutateStacks[loc.stackIdx] : null;
  },

  /* Mutate mutaterId onto targetId.
     position: 'top' means mutaterId goes above targetId in the stack.
               'under' means mutaterId goes below targetId (but still in the same stack).
     targetId may itself be part of an existing stack — we merge into it.
     mutaterId is removed from any existing stack first. */
  applyMutate(mutaterId, targetId, position) {
    this._invalidate();
    // Remove mutaterId from any existing stack
    this._removeFromStack(mutaterId);

    // Find or create the target's stack
    const targetLoc = this._findInStack(targetId);
    if (targetLoc) {
      const stack = this.mutateStacks[targetLoc.stackIdx];
      if (position === 'top') {
        // Insert mutaterId at the very top of the stack
        stack.unshift(mutaterId);
      } else {
        // Insert mutaterId at the very bottom of the stack
        stack.push(mutaterId);
      }
    } else {
      // targetId not in any stack — create a new stack
      if (position === 'top') {
        this.mutateStacks.push([mutaterId, targetId]);
      } else {
        this.mutateStacks.push([targetId, mutaterId]);
      }
    }

    // Bug fix: redirect external targeted effects (aura/equipment/etc.) pointing to any
    // non-top stack member to instead point to the top card. This keeps Battlefield.effects
    // consistent so the target dropdown always shows a valid selection and the Enchanted/
    // Equipped status is correctly preserved on the top card.
    // TEXT_CHANGE effects are excluded — per CR rules they remain targeting the original
    // permanent (and the evaluation engine applies them to the whole stack via oracleText).
    this._redirectEffectsToStackTop();
  },

  /* After any mutate stack change, update targeted effects so non-top members' targets
     are redirected to the top card. TEXT_CHANGE effects are left unchanged. */
  _redirectEffectsToStackTop() {
    for (const stack of this.mutateStacks) {
      if (stack.length < 2) continue;
      const topId = stack[0];
      for (let i = 1; i < stack.length; i++) {
        const nonTopId = stack[i];
        this.effects.forEach(e => {
          if (e.scope === 'targeted' && !e.selfTarget &&
              e.targetId === nonTopId &&
              e.type !== EFFECT_TYPE.TEXT_CHANGE) {
            e.targetId = topId;
          }
        });
      }
    }
  },

  /* Remove permId from whatever stack it's in. Cleans up empty/single-element stacks. */
  _removeFromStack(permId) {
    for (let i = this.mutateStacks.length - 1; i >= 0; i--) {
      const stack = this.mutateStacks[i];
      const pos = stack.indexOf(permId);
      if (pos !== -1) {
        stack.splice(pos, 1);
        if (stack.length <= 1) this.mutateStacks.splice(i, 1);
        return;
      }
    }
  },

  removeMutate(permId) {
    this._invalidate();
    this._removeFromStack(permId);
  },

  // Bestow tracking: Map from bestow permId -> target permId.
  // When set, the bestow creature becomes an Aura enchanting the target (loses Creature type).
  bestowTargets: new Map(),

  /* Set a bestow creature to enchant a target creature. */
  applyBestow(bestowPermId, targetPermId) {
    this._invalidate();
    this.bestowTargets.set(bestowPermId, targetPermId);
  },

  /* Remove bestow enchantment (card reverts to creature). */
  removeBestow(bestowPermId) {
    this._invalidate();
    this.bestowTargets.delete(bestowPermId);
  },

  /* Get the target permId for a bestow creature, or null. */
  getBestowTarget(bestowPermId) {
    return this.bestowTargets.get(bestowPermId) || null;
  },

  updateGameState(key, value) {
    this._invalidate();
    if (key in this.gameState) {
      this.gameState[key] = value;
    }
    this.evaluate();
    if (typeof renderAll === 'function') renderAll();
  },

  setCustomCounter(name, value) {
    if (value <= 0 && name in this.gameState.customCounters) {
      delete this.gameState.customCounters[name];
    } else if (value > 0) {
      this.gameState.customCounters[name] = value;
    }
    this.evaluate();
    if (typeof renderAll === 'function') renderAll();
  },

  addPermanent(card, opts = {}) {
    // Fix 7/10: If card has X in mana cost or oracle text references X, prompt user —
    // unless ALL X occurrences are covered by auto-computable "where X is …" clauses.
    let processedCard = card;
    // For multi-face cards, get the oracle text from the active face
    const resolvedForCheck = _resolveCardFace(card, opts.faceIndex || 0);
    const manaCost = resolvedForCheck.mana_cost || '';
    const oracleText = resolvedForCheck.oracle_text || '';
    let xValue = null;
    const hasManaX = manaCost.includes('{X}');
    // Check if X in oracle is fully covered by auto-computable "where X is" clauses
    const hasAutoX = typeof _allXAreAutoComputable === 'function' && _allXAreAutoComputable(oracleText);
    const hasX = hasManaX || (/\bX\b/.test(oracleText) && !hasAutoX);
    if (hasX) {
      // During restore (suppressPrompt) use the saved value instead of prompting.
      const xVal = opts.suppressPrompt
        ? (opts.xValue != null ? String(opts.xValue) : 'X')
        : prompt('This card has a variable X value. Enter the value of X (number, or "X" to leave as variable):', '0');
      const xNum = parseInt(xVal);
      if (!isNaN(xNum) && xNum >= 0) {
        xValue = xNum;
        // Replace X in the resolved oracle text for multi-face cards
        const resolvedOracle = resolvedForCheck.oracle_text || '';
        processedCard = { ...card, oracle_text: resolvedOracle.replace(/\bX\b/g, String(xNum)) };
        if (card.card_faces) {
          // Also update card_faces so createPermanent gets the right text
          processedCard.card_faces = card.card_faces.map((f, i) => {
            if (i === (opts.faceIndex || 0)) {
              return { ...f, oracle_text: (f.oracle_text || '').replace(/\bX\b/g, String(xNum)) };
            }
            return f;
          });
        }
      }
    }
    // Token clone detection: if a token has "clone" in its name or subtypes,
    // or if it has "copy" in its oracle text, mark it as needing a clone prompt
    const isToken = opts.isToken || card.layout === 'token' || card.layout === 'double_faced_token' || false;
    const isCloneToken = isToken && (
      /\bclone\b/i.test(card.name) ||
      /\bcopy\b/i.test(card.oracle_text || '') ||
      (card.type_line || '').toLowerCase().includes('shapeshifter')
    );
    const perm = createPermanent(processedCard, this.nextTimestamp++, opts);
    // Store X value info for later adjustment
    if (hasX) {
      perm.hasXValue = true;
      perm.xValue = xValue;  // null means "X letter" (display as X, treat as 0 in math)
      perm.originalOracleText = card.oracle_text || '';
      perm.originalCard = card;
    }
    // Detect "choose a creature type" / "choose a color" patterns
    const resolvedOracleForChoice = (processedCard.oracle_text || resolvedForCheck.oracle_text || '').toLowerCase();
    if (/\bchoose a creature type\b/i.test(resolvedOracleForChoice) ||
        /\bchoose a creature card name and a creature type\b/i.test(resolvedOracleForChoice)) {
      perm.needsChosenCreatureType = true;
      perm.chosenCreatureType = null;
      perm.originalOracleText = perm.originalOracleText || card.oracle_text || '';
      perm.originalCard = perm.originalCard || card;
    }
    if (/\bchoose a creature card name\b/i.test(resolvedOracleForChoice)) {
      perm.needsChosenCardName = true;
      perm.chosenCardName = null;
      perm.originalOracleText = perm.originalOracleText || card.oracle_text || '';
      perm.originalCard = perm.originalCard || card;
    }
    {
      // Only set needsChosenColor when "choose a color" appears outside an activated ability.
      // Activated abilities handle the color choice at fire time via openColorChoicePopup.
      const _oracleLines = (resolvedOracleForChoice || '').split('\n');
      const _hasStaticChooseColor = _oracleLines.some(line => {
        if (!/\bchoose a color(?!\s+word)\b/i.test(line)) return false;
        const _stripped = line.trim().replace(/^[^{;\n"—]+—\s*/, '');
        return !/^(?:\{[^}]+\})+\s*:/.test(_stripped);
      });
      if (_hasStaticChooseColor) {
        perm.needsChosenColor = true;
        perm.chosenColor = null;
        perm.originalOracleText = perm.originalOracleText || card.oracle_text || '';
        perm.originalCard = perm.originalCard || card;
      }
    }
    if (/\bchoose a basic land type\b/i.test(resolvedOracleForChoice)) {
      perm.needsChosenLandType = true;
      perm.chosenLandType = null;
      perm.originalOracleText = perm.originalOracleText || card.oracle_text || '';
      perm.originalCard = perm.originalCard || card;
    }
    if (/\bchoose a card type\b/i.test(resolvedOracleForChoice)) {
      perm.needsChosenCardType = true;
      perm.chosenCardType = null;
      perm.originalOracleText = perm.originalOracleText || card.oracle_text || '';
      perm.originalCard = perm.originalCard || card;
    }
    // Mark clone tokens for custom editing
    if (isCloneToken) {
      perm.isCloneToken = true;
    }
    this.permanents.push(perm);
    // For parseCardEffects, use the resolved face data so it gets the right oracle text
    const resolvedForParse = _resolveCardFace(processedCard, opts.faceIndex || 0);
    const newEffects = parseCardEffects(perm, resolvedForParse);
    // For clone tokens, add a COPY effect so the copy modal appears
    if (isCloneToken && !newEffects.some(e => e.type === EFFECT_TYPE.COPY)) {
      newEffects.push({
        id: `${perm.id}_eff_${newEffects.length}`,
        layer: '1', type: EFFECT_TYPE.COPY,
        params: { copySource: null, restriction: null },
        appliesTo: null, scope: 'targeted', selfTarget: true,
        sourceId: perm.id, sourceName: card.name,
        timestamp: perm.timestamp,
        ownerId: perm.owner || 'player_0',
        desc: 'Token clone: select a card to copy.',
      });
    }
    this.effects.push(...newEffects);
    this.updateLabels();
    return perm;
  },

  /* Update X value and re-parse effects */
  setXValue(permId, newX) {
    this._invalidate();
    const perm = this.getPermById(permId);
    if (!perm || !perm.hasXValue) return;
    perm.xValue = newX;
    // null means "X letter" — keep X as-is in oracle text; otherwise substitute the number
    const oracleBase = perm.originalOracleText || '';
    const newOracleText = newX !== null
      ? _stripReminderText(oracleBase.replace(/\bX\b/g, String(newX)))
      : _stripReminderText(oracleBase);
    const processedCard = { ...perm.originalCard, oracle_text: newOracleText };
    perm.oracleText = newOracleText;
    // Re-parse effects from the modified text
    this.effects = this.effects.filter(e => e.sourceId !== permId);
    const fakeCard = { ...processedCard, name: perm.name };
    const newPerm = { ...perm, oracleText: newOracleText };
    const newEffects = parseCardEffects(newPerm, fakeCard);
    this.effects.push(...newEffects);
  },

  /* Set chosen creature type for a permanent and re-parse effects */
  _setChoice(permId, needsKey, valueKey, value) {
    const perm = this.getPermById(permId);
    if (!perm || !perm[needsKey]) return;
    perm[valueKey] = value || null;
    this._reparseWithChoices(perm);
  },
  setChosenCreatureType(permId, type) { this._setChoice(permId, 'needsChosenCreatureType', 'chosenCreatureType', type); },
  setChosenLandType(permId, type) { this._setChoice(permId, 'needsChosenLandType', 'chosenLandType', type); },
  setChosenColor(permId, color) { this._setChoice(permId, 'needsChosenColor', 'chosenColor', color); },
  setChosenCardName(permId, name) { this._setChoice(permId, 'needsChosenCardName', 'chosenCardName', name); },
  setChosenCardType(permId, type) { this._setChoice(permId, 'needsChosenCardType', 'chosenCardType', type); },

  /* Re-parse effects after chosen type/color/X change */
  _reparseWithChoices(perm) {
    this._invalidate();
    let oracleText = perm.originalOracleText || perm.oracleText || '';
    // Apply X substitution if present
    if (perm.hasXValue && perm.xValue !== null) {
      oracleText = oracleText.replace(/\bX\b/g, String(perm.xValue));
    }
    // Apply chosen creature type substitution
    if (perm.chosenCreatureType) {
      const ct = perm.chosenCreatureType;
      const ctPlural = ct.endsWith('s') ? ct : ct + 's';
      // "Creatures you control of the chosen type" → "[Type] creatures you control"
      // Pattern: [things] [you control] of the chosen [creature] type
      oracleText = oracleText.replace(
        /\b(creatures?\b[^.]*?\byou control)\s+of the chosen (?:creature )?type\b/gi,
        `${ct} $1`
      );
      // "of the chosen type" in other contexts → just the type name
      oracleText = oracleText.replace(/\bof the chosen (?:creature )?type\b/gi, ct);
      // "the chosen type" or "the last chosen ... creature type" standalone → type name
      oracleText = oracleText.replace(/\bthe (?:last )?chosen (?:creature )?type\b/gi, ct);
      // "are [chosen type] in addition to" → "are [type]s in addition to"
      oracleText = oracleText.replace(new RegExp('\\bare\\s+' + _escapeRegex(ct) + '\\b', 'gi'), `are ${ctPlural}`);
      // Strip the "choose a creature type" sentence
      oracleText = oracleText.replace(/(?:as [^.]*)?choose a creature type\.\s*/gi, '');
    }
    // Apply combined card name + creature type substitution (Psychic Paper pattern)
    // Must be done before individual substitutions to avoid partial matches
    if (perm.chosenCardName && perm.chosenCreatureType) {
      const cn = perm.chosenCardName;
      const ct = perm.chosenCreatureType;
      // "the last chosen name and creature type" → "[Name] and [Type]"
      oracleText = oracleText.replace(/\bthe (?:last )?chosen name and (?:creature )?type\b/gi, `${cn} and ${ct}`);
    }
    // Apply chosen card name substitution
    if (perm.chosenCardName) {
      const cn = perm.chosenCardName;
      oracleText = oracleText.replace(/\bthe (?:last )?chosen name\b/gi, cn);
      // Strip the "choose a creature card name" sentence
      oracleText = oracleText.replace(/(?:as [^.]*)?choose a creature card name(?:\s+and a creature type)?\.\s*/gi, '');
    }
    // Apply chosen basic land type substitution
    if (perm.chosenLandType) {
      const lt = perm.chosenLandType;
      oracleText = oracleText.replace(/\bthe chosen (?:basic land )?type\b/gi, `a ${lt}`);
      oracleText = oracleText.replace(/\bthe basic land type of your choice\b/gi, `a ${lt}`);
      oracleText = oracleText.replace(/(?:as [^.]*)?choose a basic land type\.\s*/gi, '');
    }
    // Apply chosen color substitution
    if (perm.chosenColor) {
      const cc = perm.chosenColor;
      oracleText = oracleText.replace(/\bthe chosen color\b/gi, cc);
      oracleText = oracleText.replace(/\bof the chosen color\b/gi, cc);
      oracleText = oracleText.replace(/(?:as [^.]*)?choose a color\.\s*/gi, '');
    }
    // Apply chosen card type substitution
    if (perm.chosenCardType) {
      const cct = perm.chosenCardType;
      oracleText = oracleText.replace(/\bthe chosen card type\b/gi, cct);
      oracleText = oracleText.replace(/(?:as [^.]*)?choose a card type\.\s*/gi, '');
    }
    oracleText = _stripReminderText(oracleText);
    const processedCard = { ...(perm.originalCard || {}), oracle_text: oracleText };
    perm.oracleText = oracleText;
    // Re-parse effects
    this.effects = this.effects.filter(e => e.sourceId !== perm.id);
    const fakeCard = { ...processedCard, name: perm.name };
    const newPerm = { ...perm, oracleText };
    const newEffects = parseCardEffects(newPerm, fakeCard);
    // Inject SET_NAME / SET_TYPE effects for equipment that sets name and creature type
    // (e.g. Psychic Paper: "its name and creature type are [chosen name] and [chosen type]")
    if (perm.chosenCardName && /\bname\b.*\bare\b/i.test(perm.originalOracleText || '')) {
      newEffects.push({
        id: `${perm.id}_eff_setname`,
        layer: '3', type: EFFECT_TYPE.SET_NAME,
        params: { name: perm.chosenCardName },
        appliesTo: null, scope: 'targeted',
        sourceId: perm.id, sourceName: perm.name, timestamp: perm.timestamp,
        ownerId: perm.owner || 'player_0',
        desc: `Name becomes "${perm.chosenCardName}".`,
      });
    }
    if (perm.chosenCreatureType && perm.chosenCardName && /\bcreature type\b.*\bare\b/i.test(perm.originalOracleText || '')) {
      newEffects.push({
        id: `${perm.id}_eff_settype`,
        layer: '4', type: EFFECT_TYPE.SET_TYPE,
        params: { subtypes: [perm.chosenCreatureType], replaceSubtypeCategory: 'creature', keepTypes: true },
        appliesTo: null, scope: 'targeted',
        sourceId: perm.id, sourceName: perm.name, timestamp: perm.timestamp,
        ownerId: perm.owner || 'player_0',
        desc: `Creature type becomes ${perm.chosenCreatureType}.`,
      });
    }
    this.effects.push(...newEffects);
  },

  removePermanent(id) {
    // If removing a crew/saddle effect pseudo-perm, strip the trait from the source.
    const removingPerm = this.getPermById(id);
    if (removingPerm?._isCrewEffect && removingPerm.abilitySourceId) {
      const src = this.getPermById(removingPerm.abilitySourceId);
      if (src?.traits) src.traits = src.traits.filter(t => t !== 'Crewed');
    }
    if (removingPerm?._isSaddleEffect && removingPerm.abilitySourceId) {
      const src = this.getPermById(removingPerm.abilitySourceId);
      if (src?.traits) src.traits = src.traits.filter(t => t !== 'Saddled');
    }
    // Cascade: if removing Exchange of Words (or any source that spawned exchange
    // pseudo-permanents), remove those pseudo-perms and their effects too.
    const linkedPseudoIds = this.permanents
      .filter(p => p._exchangeSourcePermId === id)
      .map(p => p.id);
    for (const pid of linkedPseudoIds) {
      this.permanents = this.permanents.filter(p => p.id !== pid);
      this.effects = this.effects.filter(e => e.sourceId !== pid);
    }
    this.permanents = this.permanents.filter(p => p.id !== id);
    this.effects = this.effects.filter(e => e.sourceId !== id);
    // Clear targetId on effects from other permanents that were targeting the removed one
    // (e.g. a reconfigure card attached to a creature that leaves the battlefield)
    for (const e of this.effects) {
      if (e.targetId === id) e.targetId = null;
    }
    this._removeFromStack(id);
    // Clean up bestow: remove if this was a bestow creature or a bestow target
    this.bestowTargets.delete(id);
    for (const [bestowId, targetId] of this.bestowTargets) {
      if (targetId === id) this.bestowTargets.delete(bestowId);
    }
    if (this.inspectedId === id) this.inspectedId = null;
    // Unlink commander if this permanent was the linked instance
    for (const cmd of this.commanders) {
      if (cmd.linkedPermId === id) cmd.linkedPermId = null;
    }
    // Clear exile tags pointing at the removed permanent
    if (this.exile) {
      for (const entry of this.exile) {
        if (entry.exiledWithId === id) entry.exiledWithId = null;
      }
    }
    this.updateLabels();
  },

  toggleTapped(id) {
    this._invalidate();
    const perm = this.getPermById(id);
    if (perm) {
      perm.tapped = !perm.tapped;
      // Add/remove 'Tapped' trait
      if (!perm.traits) perm.traits = [];
      if (perm.tapped) {
        if (!perm.traits.includes('Tapped')) perm.traits.push('Tapped');
      } else {
        perm.traits = perm.traits.filter(t => t !== 'Tapped');
      }
    }
  },

  /* Toggle the 'Attacking' trait on a creature. Mutually exclusive with 'Blocking'. */
  toggleAttacking(id) {
    this._invalidate();
    const perm = this.getPermById(id);
    if (perm) {
      if (!perm.traits) perm.traits = [];
      const isAttacking = perm.traits.includes('Attacking');
      if (isAttacking) {
        perm.traits = perm.traits.filter(t => t !== 'Attacking');
      } else {
        // Mutually exclusive with Blocking
        perm.traits = perm.traits.filter(t => t !== 'Blocking');
        perm.traits.push('Attacking');
      }
    }
  },

  /* Toggle the 'Blocking' trait on a creature. Mutually exclusive with 'Attacking'. */
  toggleBlocking(id) {
    this._invalidate();
    const perm = this.getPermById(id);
    if (perm) {
      if (!perm.traits) perm.traits = [];
      const isBlocking = perm.traits.includes('Blocking');
      if (isBlocking) {
        perm.traits = perm.traits.filter(t => t !== 'Blocking');
      } else {
        // Mutually exclusive with Attacking
        perm.traits = perm.traits.filter(t => t !== 'Attacking');
        perm.traits.push('Blocking');
      }
    }
  },

  /* Turn a card face down as a 2/2 creature.
     mode: 'morph' | 'cloak' | 'manifest'
     - morph: face down 2/2 creature with no abilities
     - cloak: face down 2/2 creature with Ward 2
     - manifest: face down 2/2 creature with no abilities */
  setFaceDown(id, mode) {
    const perm = this.getPermById(id);
    if (!perm) return;
    if (perm.isFaceDown) {
      // Turn face up: restore original card data
      perm.isFaceDown = false;
      perm.faceDownMode = null;
      perm.printedTypes = [...(perm._originalTypes || perm.printedTypes)];
      perm.printedSupertypes = [...(perm._originalSupertypes || perm.printedSupertypes)];
      perm.printedSubtypes = [...(perm._originalSubtypes || perm.printedSubtypes)];
      perm.printedPower = perm._originalPower !== undefined ? perm._originalPower : perm.printedPower;
      perm.printedToughness = perm._originalToughness !== undefined ? perm._originalToughness : perm.printedToughness;
      perm.printedAbilities = [...(perm._originalAbilities || perm.printedAbilities)];
      perm.printedColors = [...(perm._originalColors || perm.printedColors)];
      perm.oracleText = perm._originalOracleText || perm.oracleText;
      // Turning face up gives a new timestamp (CR 613.7d)
      perm.timestamp = this.nextTimestamp++;
      // Re-parse effects with the new timestamp
      this.effects = this.effects.filter(e => e.sourceId !== id);
      const card = perm.scryfallData || { name: perm.name, oracle_text: perm.oracleText, type_line: '', colors: perm.printedColors };
      const newEffects = parseCardEffects(perm, card);
      this.effects.push(...newEffects);
    } else {
      // Save original state
      perm._originalTypes = [...perm.printedTypes];
      perm._originalSupertypes = [...(perm.printedSupertypes || [])];
      perm._originalSubtypes = [...(perm.printedSubtypes || [])];
      perm._originalPower = perm.printedPower;
      perm._originalToughness = perm.printedToughness;
      perm._originalAbilities = [...(perm.printedAbilities || [])];
      perm._originalColors = [...(perm.printedColors || [])];
      perm._originalOracleText = perm.oracleText;
      // Set face down state: 2/2 colorless creature with no name visible
      perm.isFaceDown = true;
      perm.faceDownMode = mode;
      perm.printedTypes = ['Creature'];
      perm.printedSupertypes = [];
      perm.printedSubtypes = [];
      perm.printedPower = 2;
      perm.printedToughness = 2;
      perm.printedColors = [];
      if (mode === 'cloak') {
        perm.printedAbilities = ['Ward {2}'];
        perm.oracleText = 'Ward {2}';
      } else {
        perm.printedAbilities = [];
        perm.oracleText = '';
      }
      // Remove existing effects and re-parse (minimal for face-down)
      this.effects = this.effects.filter(e => e.sourceId !== id);
      const fakeCard = { name: perm.name, oracle_text: perm.oracleText, type_line: 'Creature', colors: [], cmc: 0 };
      const newEffects = parseCardEffects(perm, fakeCard);
      this.effects.push(...newEffects);
    }
    this._invalidate();
    this.evaluate();
  },

  reorderTimestamps(orderedIds) {
    for (let i = 0; i < orderedIds.length; i++) {
      const perm = this.getPermById(orderedIds[i]);
      if (perm) {
        const newTs = i + 1;
        this.effects.forEach(e => {
          if (e.sourceId === perm.id) e.timestamp = newTs;
        });
        perm.timestamp = newTs;
      }
    }
    this.updateLabels();
  },

  /* Assign unique letter labels (A, B, …, Z, AA, AB, …) to permanents that share a name.
     Permanents with a unique name get label = null.
     Called after any add/remove/reorder operation — AFTER parsing, so labels never
     influence the parser. Labels are display-only identifiers. */
  updateLabels() {
    this._invalidate();
    // Group by controller + name so different players' same-named permanents
    // don't get labeled unnecessarily
    const nameGroups = new Map();
    for (const p of this.permanents) {
      const key = (p.controller || p.owner || 'player_0') + '::' + _permEffectiveBaseName(p);
      if (!nameGroups.has(key)) nameGroups.set(key, []);
      nameGroups.get(key).push(p);
    }
    for (const [, group] of nameGroups) {
      if (group.length <= 1) {
        group[0].label = null;
      } else {
        const sorted = [...group].sort((a, b) => a.timestamp - b.timestamp);
        for (let i = 0; i < sorted.length; i++) {
          sorted[i].label = _permLabelString(i);
        }
      }
    }
  },

  setTarget(effectSourceId, targetPermId) {
    this._invalidate();
    // Validate attachment restriction before setting target
    if (targetPermId) {
      const auraR = this.effects.find(e => e.sourceId === effectSourceId && e.auraRestriction)?.auraRestriction
        || this.getPermById(effectSourceId)?._auraRestriction;
      const isEquipment = this.effects.some(e => e.sourceId === effectSourceId && e.requiresCreatureTarget);

      // CR 704.5p: Equipment that is currently a creature cannot equip unless it has reconfigure.
      if (isEquipment) {
        const finalStates = this.getAllFinalStates();
        const sourcePerm = this.getPermById(effectSourceId);
        const sourceFs = finalStates.get(effectSourceId);
        const sourceTypes = sourceFs ? (sourceFs.types || []) : (sourcePerm?.printedTypes || []);
        if (sourceTypes.includes('Creature')) {
          const sourceAbilities = sourceFs ? (sourceFs.abilities || []) : [];
          const hasReconfigure = sourceAbilities.some(a => /\breconfigure\b/i.test(a));
          if (!hasReconfigure) {
            if (typeof _showSBAToast === 'function') {
              _showSBAToast('This Equipment is currently a creature and cannot equip another creature. (Rule 704.5p: If a creature is attached to an object or player, it becomes unattached and remains on the battlefield.)');
            }
            return; // block equip
          }
        }
      }

      // For dual Aura+Equipment: accept the target if it satisfies either restriction.
      // For pure Aura or pure Equipment: normal single check.
      const finalStates = this.getAllFinalStates();
      const target = this.getPermById(targetPermId);
      if (target) {
        const fs = finalStates.get(targetPermId);
        const tState = fs
          ? { types: fs.types || [], supertypes: fs.supertypes || [], subtypes: fs.subtypes || [], colors: fs.colors || [], isAllCreatureTypes: fs.isAllCreatureTypes }
          : { types: target.printedTypes || [], supertypes: target.printedSupertypes || [], subtypes: target.printedSubtypes || [] };
        const validAsAura = !auraR || auraR(tState);
        const validAsEquip = !isEquipment || tState.types.includes('Creature');
        if (auraR && isEquipment) {
          // Dual: accept if valid for either attachment type
          if (!validAsAura && !validAsEquip) return;
        } else {
          if (!validAsAura || !validAsEquip) return;
        }
      }
    }
    const newTs = this.nextTimestamp++;
    const hasModalTargets = this.effects.some(e => e.sourceId === effectSourceId && e.modalModeIndex !== undefined);
    this.effects.forEach(e => {
      if (e.sourceId === effectSourceId && e.scope === 'targeted') {
        if (hasModalTargets && e.modalModeIndex !== undefined && e.disabled) return;
        if (e._targetSlot !== undefined) return; // slotted effects use setSlottedTarget
        e.targetId = targetPermId;
        e.timestamp = newTs;
      }
    });
    // The validation above called getAllFinalStates() which re-cached state with the old
    // targetId. Re-invalidate now so callers get a fresh evaluation after the mutation.
    this._invalidate();
  },

  /* Set the chosen opponent for a "target opponent" source (e.g. Curious Colossus).
     The selected player is recorded on the permanent and stamped onto every effect
     tagged with _targetsOpponentPlayer so the engine can restrict application to
     that player's permanents only. */
  setTargetOpponent(effectSourceId, playerId) {
    this._invalidate();
    const perm = this.getPermById(effectSourceId);
    if (perm) perm._targetOpponentPlayerId = playerId || null;
    this.effects.forEach(e => {
      if (e.sourceId === effectSourceId && e._targetsOpponentPlayer) {
        e._targetOpponentPlayerId = playerId || null;
      }
    });
  },

  /* Set the chosen player for a "target player" source (any player, including self).
     Used by cards like Bazaar Trader ("target player gains control of target ... you control"). */
  setTargetPlayer(effectSourceId, playerId) {
    this._invalidate();
    const perm = this.getPermById(effectSourceId);
    if (perm) perm._targetPlayerId = playerId || null;
    this.effects.forEach(e => {
      if (e.sourceId === effectSourceId && e._targetPlayerControl) {
        e.params.newController = playerId || null;
      }
      // "[type] target player controls" boosts/grants scope to the chosen player.
      if (e.sourceId === effectSourceId && e._targetPlayerScoped) {
        e._targetPlayerId = playerId || null;
      }
    });
  },

  /* Set the chosen enchanted player for an "enchant player" aura (e.g. Curse of Conformity).
     Scopes that aura's global effects to only the chosen player's permanents. */
  setEnchantedPlayer(permId, playerId) {
    this._invalidate();
    const perm = this.getPermById(permId);
    if (perm) perm._enchantedPlayerId = playerId || null;
    this.effects.forEach(e => {
      if (e.sourceId === permId && e._enchantedPlayerScoped) {
        e._enchantedPlayerId = playerId || null;
      }
    });
  },

  /* Set targetId for one independently-addressed slot on a multi-sentence spell
     (e.g. Seeds of Strength where each "Target creature" line is its own slot). */
  setSlottedTarget(sourceId, slot, targetPermId) {
    this._invalidate();
    const newTs = this.nextTimestamp++;
    this.effects.forEach(e => {
      if (e.sourceId === sourceId && e.scope === 'targeted' && e._targetSlot === slot) {
        e.targetId = targetPermId || null;
        e.timestamp = newTs;
      }
    });
    this._invalidate();
  },

  /* Set a specific target slot for multi-target effects (e.g. "up to two target creatures") */
  setMultiTarget(effectSourceId, slotIndex, targetPermId) {
    this._invalidate();
    this.effects.forEach(e => {
      if (e.sourceId === effectSourceId && e.scope === 'targeted' && !e.selfTarget && e.targetIds) {
        // Update the specific slot
        while (e.targetIds.length <= slotIndex) e.targetIds.push(null);
        e.targetIds[slotIndex] = targetPermId;
        // Clean trailing nulls
        while (e.targetIds.length > 0 && !e.targetIds[e.targetIds.length - 1]) e.targetIds.pop();
      }
    });
    this.evaluate();
  },

  /* Set targetId for effects from a specific modal mode (modeIndex).
     Used when a modal spell has multiple targeted modes (e.g. Twisted Reflection with Entwine)
     so each mode can target a different permanent independently. */
  setModalModeTarget(effectSourceId, modeIndex, targetPermId) {
    this._invalidate();
    this.effects.forEach(e => {
      if (e.sourceId === effectSourceId && e.scope === 'targeted' &&
          !e.selfTarget && e.modalModeIndex === modeIndex) {
        e.targetId = targetPermId || null;
      }
    });
  },

  /* Select a specific modal mode by effect ID. For choose-one cards, this always
     selects the clicked mode and deselects all others. For choose-N/spree, this
     toggles the mode on/off while enforcing the max active count.
     Does NOT call evaluate — caller is responsible. */
  toggleEffect(effectId) {
    this._invalidate();
    const eff = this.effects.find(e => e.id === effectId);
    if (!eff) return;
    const perm = this.getPermById(eff.sourceId);
    const maxActive = perm ? (perm.modalMaxActive ?? Infinity) : Infinity;
    const siblingEffs = this.effects.filter(e => e.sourceId === eff.sourceId && e.modalModeIndex !== undefined);

    if (maxActive === 1) {
      // Radio behavior: always select this mode, deselect all others
      for (const e of siblingEffs) {
        e.disabled = (e.modalModeIndex !== eff.modalModeIndex);
      }
    } else {
      // Toggle behavior
      const wasDisabled = eff.disabled;
      if (wasDisabled) {
        // Enabling — check capacity
        if (maxActive < Infinity) {
          const activeIndices = new Set();
          for (const e of siblingEffs) {
            if (!e.disabled) activeIndices.add(e.modalModeIndex);
          }
          if (activeIndices.size >= maxActive) {
            // At max: disable the oldest active mode to make room
            const oldestActive = [...activeIndices][0];
            for (const e of siblingEffs) {
              if (e.modalModeIndex === oldestActive) e.disabled = true;
            }
          }
        }
        // Enable all effects in this mode
        for (const e of siblingEffs) {
          if (e.modalModeIndex === eff.modalModeIndex) e.disabled = false;
        }
      } else {
        // Disabling this mode
        for (const e of siblingEffs) {
          if (e.modalModeIndex === eff.modalModeIndex) e.disabled = true;
        }
      }
    }
  },

  /* Set modal mode counts for repeatable modal spells.
     counts: object mapping modeIndex → count (e.g. {0: 2, 1: 0, 2: 1}).
     For repeatable modes, effects are disabled/enabled based on count > 0.
     The engine duplicates effects per count. */
  setModalModeCounts(permId, counts) {
    this._invalidate();
    const perm = this.getPermById(permId);
    if (!perm) return;
    perm.modalModeCounts = counts;
    // Enable/disable effects based on count
    const effs = this.effects.filter(e => e.sourceId === permId && e.modalModeIndex !== undefined);
    for (const e of effs) {
      e.disabled = (counts[e.modalModeIndex] ?? 0) === 0;
    }
  },

  /* Set modal mode selections for non-repeatable modal spells.
     activeIndices: Set of active mode indices.
     Disables modes not in the set, enables those in the set. */
  setModalModeSelections(permId, activeIndices) {
    this._invalidate();
    const effs = this.effects.filter(e => e.sourceId === permId && e.modalModeIndex !== undefined);
    for (const e of effs) {
      e.disabled = !activeIndices.has(e.modalModeIndex);
    }
  },

  /* Set copy source for a COPY effect */
  setCopySource(effectSourceId, copySourceCard) {
    this._invalidate();
    this.effects.forEach(e => {
      if (e.sourceId === effectSourceId && e.type === EFFECT_TYPE.COPY) {
        e.params.copySource = copySourceCard;
      }
    });
    // Copy source affects the displayed name, so duplicate-name labels may change.
    this.updateLabels();
  },

  /* Set/update text-change replacements and target.
     Also propagates targetId to other targeted effects from same source
     (e.g. Balduvian Shaman's Layer 6 ADD_ABILITY). */
  setTextChangeConfig(effectSourceId, targetId, replacements) {
    this._invalidate();
    this.effects.forEach(e => {
      if (e.sourceId === effectSourceId && e.type === EFFECT_TYPE.TEXT_CHANGE) {
        if (targetId !== undefined) e.targetId = targetId;
        if (replacements !== undefined) e.params.replacements = replacements;
      }
    });
    // Propagate target to all other targeted effects from same source
    if (targetId !== undefined) {
      this.effects.forEach(e => {
        if (e.sourceId === effectSourceId && e.scope === 'targeted' && !e.selfTarget) {
          e.targetId = targetId;
        }
      });
    }
  },

  /* Set Swirl the Mists chosen color + auto-build replacements for all permanents */
  setSwirlColor(effectSourceId, chosenColor) {
    this._invalidate();
    this.effects.forEach(e => {
      if (e.sourceId === effectSourceId && e.type === EFFECT_TYPE.TEXT_CHANGE &&
          e.params.changeType === 'color_global') {
        e.params.chosenColor = chosenColor;
        // Build replacements: every OTHER color word -> chosen color
        const allColors = ['white', 'blue', 'black', 'red', 'green'];
        e.params.replacements = allColors
          .filter(c => c !== chosenColor.toLowerCase())
          .map(c => ({ from: c, to: chosenColor.toLowerCase() }));
      }
    });
  },

  /* Update params on text-change effects matching a specific changeType */
  _setTextChangeParams(effectSourceId, changeType, params) {
    this._invalidate();
    this.effects.forEach(e => {
      if (e.sourceId === effectSourceId && e.type === EFFECT_TYPE.TEXT_CHANGE &&
          e.params.changeType === changeType) {
        Object.assign(e.params, params);
      }
    });
  },
  setExchangeTargets(effectSourceId, targetA, targetB) {
    // Temporarily clear targets/snapshots so getAllFinalStates() evaluates WITHOUT the
    // exchange effect (handles both first-time and re-targeting correctly).
    this._setTextChangeParams(effectSourceId, 'exchange_text', {
      exchangeTargetA: null, exchangeTargetB: null,
      snapshotTextA: undefined, snapshotTextB: undefined,
      snapshotAbilitiesA: undefined, snapshotAbilitiesB: undefined,
    });
    // Take text snapshots: the exchange effect is now inactive, so getAllFinalStates()
    // returns state without the exchange applied — the Layer 3 text "immediately
    // before the exchange would begin applying".
    const finalStates = this.getAllFinalStates();
    const stA = finalStates.get(targetA);
    const stB = finalStates.get(targetB);
    const snapshotTextA = stA ? stA.oracleText : '';
    const snapshotTextB = stB ? stB.oracleText : '';
    this._setTextChangeParams(effectSourceId, 'exchange_text', {
      exchangeTargetA: targetA, exchangeTargetB: targetB,
      snapshotTextA, snapshotTextB,
      snapshotAbilitiesA: snapshotTextA.split('\n').map(l => l.trim()).filter(Boolean),
      snapshotAbilitiesB: snapshotTextB.split('\n').map(l => l.trim()).filter(Boolean),
    });
  },
  setDeadpoolTarget(effectSourceId, targetId) {
    // Temporarily clear target/snapshots so getAllFinalStates() evaluates without exchange.
    this._setTextChangeParams(effectSourceId, 'exchange_text', {
      exchangeTargetId: null,
      snapshotTextA: undefined, snapshotTextB: undefined,
      snapshotAbilitiesA: undefined, snapshotAbilitiesB: undefined,
    });
    // Take text snapshots before setting the target (same logic as Exchange of Words).
    const finalStates = this.getAllFinalStates();
    const stSource = finalStates.get(effectSourceId);
    const stTarget = finalStates.get(targetId);
    const snapshotTextA = stSource ? stSource.oracleText : '';
    const snapshotTextB = stTarget ? stTarget.oracleText : '';
    this._setTextChangeParams(effectSourceId, 'exchange_text', {
      exchangeTargetId: targetId,
      snapshotTextA, snapshotTextB,
      snapshotAbilitiesA: snapshotTextA.split('\n').map(l => l.trim()).filter(Boolean),
      snapshotAbilitiesB: snapshotTextB.split('\n').map(l => l.trim()).filter(Boolean),
    });
  },
  /* Exchange control: set targets and snapshot their current controllers */
  setExchangeControlTargets(effectSourceId, targetA, targetB) {
    const finalStates = this.getAllFinalStates();
    const stA = finalStates.get(targetA);
    const stB = finalStates.get(targetB);
    const ctrlA = stA ? stA.controller : null;
    const ctrlB = stB ? stB.controller : null;
    this._invalidate();
    this.effects.forEach(e => {
      if (e.sourceId === effectSourceId && e.type === EFFECT_TYPE.CONTROL && e.params.exchangeControl) {
        e.params.exchangeTargetA = targetA;
        e.params.exchangeTargetB = targetB;
        e.params.snapshotControllerA = ctrlA;
        e.params.snapshotControllerB = ctrlB;
      }
    });
    this.evaluate();
  },

  setVolrathGraveyardCard(effectSourceId, card) {
    this._invalidate();
    this._setTextChangeParams(effectSourceId, 'volrath_text', { graveyardCard: card });
  },

  /* Graveyard management */
  addToGraveyard(playerId, card) {
    this._invalidate();
    const player = this.getPlayer(playerId);
    if (!player) return;
    if (!player.graveyard) player.graveyard = [];
    player.graveyard.push(card);
    player.gameState.graveyardCount = player.graveyard.length;
    this.evaluate();
  },

  removeFromGraveyard(playerId, index) {
    this._invalidate();
    const player = this.getPlayer(playerId);
    if (!player || !player.graveyard) return;
    player.graveyard.splice(index, 1);
    player.gameState.graveyardCount = player.graveyard.length;
    this.evaluate();
  },

  getGraveyardTop(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || !player.graveyard || player.graveyard.length === 0) return null;
    return player.graveyard[player.graveyard.length - 1];
  },

  getGraveyardCount(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || !player.graveyard) return 0;
    return player.graveyard.length;
  },

  /* ─── Exile zone — */
  /* [KEY: EXILE] */
  exile: [],
  nextExileId: 1,

  addToExile(card, { owner = null, exiledWithId = null, isFaceDown = false } = {}) {
    this._invalidate();
    const id = 'exile_' + (this.nextExileId++);
    const entry = {
      id,
      card,
      owner: owner || this.activePlayerId,
      exiledWithId,
      counters: {},
      isFaceDown,
      timestamp: this.nextTimestamp++,
    };
    this.exile.push(entry);
    this.evaluate();
    return id;
  },

  removeFromExile(entryId) {
    this._invalidate();
    this.exile = this.exile.filter(e => e.id !== entryId);
    this.evaluate();
  },

  setExileTag(entryId, permanentId) {
    this._invalidate();
    const entry = this.exile.find(e => e.id === entryId);
    if (!entry) return;
    entry.exiledWithId = permanentId || null;
    this.evaluate();
  },

  setExileOwner(entryId, playerId) {
    this._invalidate();
    const entry = this.exile.find(e => e.id === entryId);
    if (!entry) return;
    entry.owner = playerId;
    this.evaluate();
  },

  setExileFaceDown(entryId, isFaceDown) {
    this._invalidate();
    const entry = this.exile.find(e => e.id === entryId);
    if (!entry) return;
    entry.isFaceDown = !!isFaceDown;
    this.evaluate();
  },

  addExileCounter(entryId, counterType, count = 1) {
    this._invalidate();
    const entry = this.exile.find(e => e.id === entryId);
    if (!entry) return;
    if (!entry.counters) entry.counters = {};
    entry.counters[counterType] = (entry.counters[counterType] || 0) + count;
    // CR 122.3: +1/+1 and -1/-1 annihilate
    if (counterType === '+1/+1' || counterType === '-1/-1') {
      const opposite = counterType === '+1/+1' ? '-1/-1' : '+1/+1';
      const a = entry.counters[counterType] || 0;
      const b = entry.counters[opposite] || 0;
      if (a > 0 && b > 0) {
        const cancel = Math.min(a, b);
        entry.counters[counterType] -= cancel;
        entry.counters[opposite] -= cancel;
        if (entry.counters[counterType] === 0) delete entry.counters[counterType];
        if (entry.counters[opposite] === 0) delete entry.counters[opposite];
      }
    }
    this.evaluate();
  },

  removeExileCounter(entryId, counterType, count = 1) {
    this._invalidate();
    const entry = this.exile.find(e => e.id === entryId);
    if (!entry || !entry.counters) return;
    entry.counters[counterType] = Math.max(0, (entry.counters[counterType] || 0) - count);
    if (entry.counters[counterType] === 0) delete entry.counters[counterType];
    this.evaluate();
  },

  getExileEntriesTaggedWith(permanentId) {
    return this.exile.filter(e => e.exiledWithId === permanentId);
  },

  getExileCount(playerId = null) {
    if (playerId) return this.exile.filter(e => e.owner === playerId).length;
    return this.exile.length;
  },
  /* [END: EXILE] */

  /* Set CDA user value for a permanent */
  setCDAValue(permId, value) {
    this._invalidate();
    const perm = this.getPermById(permId);
    if (perm) perm.cdaUserValue = value;
  },

  /* Class enchantment level management */
  setClassLevel(permId, level) {
    this._invalidate();
    const perm = this.getPermById(permId);
    if (!perm || !perm._classLevelThresholds) return;
    const maxLevel = Math.max(...perm._classLevelThresholds.values());
    perm.classLevel = Math.max(1, Math.min(level, maxLevel));
    this.evaluate();
    if (typeof renderAll === 'function') renderAll();
  },

  /* Counter management */
  addCounter(permId, counterType, count = 1) {
    this._invalidate();
    const perm = this.getPermById(permId);
    if (!perm) return;
    if (!perm.counters) perm.counters = {};
    if (!perm.counterTimestamps) perm.counterTimestamps = {};
    perm.counters[counterType] = (perm.counters[counterType] || 0) + count;
    perm.counterTimestamps[counterType] = this.nextTimestamp++;
    // CR 122.3: +1/+1 and -1/-1 counters annihilate each other
    if (counterType === '+1/+1' || counterType === '-1/-1') {
      const opposite = counterType === '+1/+1' ? '-1/-1' : '+1/+1';
      const a = perm.counters[counterType] || 0;
      const b = perm.counters[opposite] || 0;
      if (a > 0 && b > 0) {
        const cancel = Math.min(a, b);
        perm.counters[counterType] -= cancel;
        perm.counters[opposite] -= cancel;
        if (perm.counters[counterType] === 0) {
          delete perm.counters[counterType];
          if (perm.counterTimestamps) delete perm.counterTimestamps[counterType];
        }
        if (perm.counters[opposite] === 0) {
          delete perm.counters[opposite];
          if (perm.counterTimestamps) delete perm.counterTimestamps[opposite];
        }
      }
    }
    this._syncCounterEffects(permId);
  },

  removeCounter(permId, counterType, count = 1) {
    this._invalidate();
    const perm = this.getPermById(permId);
    if (!perm || !perm.counters) return;
    perm.counters[counterType] = Math.max(0, (perm.counters[counterType] || 0) - count);
    if (perm.counters[counterType] === 0) {
      delete perm.counters[counterType];
      if (perm.counterTimestamps) delete perm.counterTimestamps[counterType];
    }
    this._syncCounterEffects(permId);
  },

  _syncCounterEffects(permId) {
    const perm = this.getPermById(permId);
    if (!perm) return;
    this.effects = this.effects.filter(e => !(e.sourceId === permId && e._isCounterEffect));

    const KW_COUNTERS = [
      'flying','first strike','double strike','deathtouch','haste',
      'hexproof','indestructible','lifelink','menace','reach',
      'trample','vigilance','defender','fear','intimidate',
      'shroud','wither','infect','prowess','ward','shield',
    ];

    for (const [type, count] of Object.entries(perm.counters || {})) {
      if (count <= 0) continue;
      // Match any P/T counter pattern: +N/+N, -N/-N, +N/-N, +N/+0, etc.
      const ptMatch = type.match(/^([+-]\d+)\/([+-]\d+)$/);
      if (ptMatch) {
        this.effects.push({
          id: `${permId}_counter_${type}`, layer: '7c', type: EFFECT_TYPE.ADD_COUNTERS,
          params: { counterType: type, count, powerMod: parseInt(ptMatch[1]), toughnessMod: parseInt(ptMatch[2]) },
          appliesTo: null, scope: 'targeted', selfTarget: true,
          sourceId: permId, sourceName: perm.name, timestamp: (perm.counterTimestamps && perm.counterTimestamps[type]) || perm.timestamp,
          ownerId: perm.owner || 'player_0',
          desc: `${count}x ${type} counter${count !== 1 ? 's' : ''}`, _isCounterEffect: true,
        });
      } else if (KW_COUNTERS.includes(type.toLowerCase())) {
        const keyword = type.charAt(0).toUpperCase() + type.slice(1);
        this.effects.push({
          id: `${permId}_counter_${type}`, layer: '6', type: EFFECT_TYPE.KEYWORD_COUNTER,
          params: { keyword },
          appliesTo: null, scope: 'targeted', selfTarget: true,
          sourceId: permId, sourceName: perm.name, timestamp: (perm.counterTimestamps && perm.counterTimestamps[type]) || perm.timestamp,
          ownerId: perm.owner || 'player_0',
          desc: `${keyword} counter`, _isCounterEffect: true,
        });
      }
    }
  },

  /* Flip a transformable card to its other face. Re-creates permanent properties from the new face. */
  flipCard(permId) {
    const perm = this.getPermById(permId);
    if (!perm || !perm.isTransformable || !perm.scryfallData?.card_faces) return;
    const newFaceIndex = perm.activeFaceIndex === 0 ? 1 : 0;
    const card = perm.scryfallData;
    const resolvedCard = _resolveCardFace(card, newFaceIndex);
    
    // Update permanent with new face data
    const types = parseTypeLine(resolvedCard.type_line || '');
    let oracleText = resolvedCard.oracle_text || '';
    oracleText = _stripReminderText(oracleText);
    oracleText = _replaceProperNounSelfRef(resolvedCard.name, oracleText, perm.isToken);
    if (card.name !== resolvedCard.name) {
      oracleText = _replaceProperNounSelfRef(card.name, oracleText, perm.isToken);
    }
    
    perm.name = resolvedCard.name;
    perm.printedTypes = types.types;
    perm.printedSupertypes = types.supertypes;
    perm.printedSubtypes = types.subtypes;
    perm.printedPower = resolvedCard.power !== undefined ? parseInt(resolvedCard.power) || 0 : null;
    perm.printedToughness = resolvedCard.toughness !== undefined ? parseInt(resolvedCard.toughness) || 0 : null;
    perm.printedAbilities = extractAbilities(oracleText);
    _addIntrinsicLandMana(perm.printedAbilities, types.subtypes);
    perm.printedColors = resolvedCard.colors || [];
    perm.manaCost = resolvedCard.mana_cost || '';
    perm.oracleText = oracleText;
    perm.imageUri = resolvedCard.image_uris?.small || resolvedCard.image_uris?.normal || null;
    perm.activeFaceIndex = newFaceIndex;
    perm.oracleCounterTypes = _extractOracleCounterTypes(resolvedCard.oracle_text || '', types.subtypes, types.types);
    perm.isManualEffect = types.types.includes('Instant') || types.types.includes('Sorcery');
    
    // Re-parse effects for the new face
    this.effects = this.effects.filter(e => !(e.sourceId === permId && !e._isCounterEffect));
    const newEffects = parseCardEffects(perm, resolvedCard);
    this.effects.push(...newEffects);
    
    // Re-sync counter effects since types may have changed
    this._syncCounterEffects(permId);
    this._invalidate();
  },

  /* Switch a chooseable-face (split/aftermath) card to a specific face. */
  switchSplitFace(permId, faceIndex) {
    const perm = this.getPermById(permId);
    if (!perm || !perm.isChooseableFace || !perm.scryfallData?.card_faces) return;
    this._invalidate();
    const card = perm.scryfallData;
    const newFaceIndex = faceIndex !== undefined ? faceIndex : ((perm.activeFaceIndex + 1) % card.card_faces.length);
    const resolvedCard = _resolveCardFace(card, newFaceIndex);

    const types = parseTypeLine(resolvedCard.type_line || '');
    let oracleText = resolvedCard.oracle_text || '';
    oracleText = _stripReminderText(oracleText);
    oracleText = _replaceProperNounSelfRef(resolvedCard.name, oracleText, perm.isToken);
    if (card.name !== resolvedCard.name) {
      oracleText = _replaceProperNounSelfRef(card.name, oracleText, perm.isToken);
    }

    perm.name = resolvedCard.name;
    perm.activeFaceIndex = newFaceIndex;
    perm.printedTypes = types.types;
    perm.printedSupertypes = types.supertypes;
    perm.printedSubtypes = types.subtypes;
    perm.printedPower = resolvedCard.power !== undefined ? parseInt(resolvedCard.power) || 0 : null;
    perm.printedToughness = resolvedCard.toughness !== undefined ? parseInt(resolvedCard.toughness) || 0 : null;
    perm.printedAbilities = extractAbilities(oracleText);
    _addIntrinsicLandMana(perm.printedAbilities, types.subtypes);
    perm.printedColors = resolvedCard.colors || [];
    perm.manaCost = resolvedCard.mana_cost || '';
    perm.manaValue = _cmcFromManaCost(resolvedCard.mana_cost) || resolvedCard.cmc || card.cmc || 0;
    perm.isManualEffect = types.types.includes('Instant') || types.types.includes('Sorcery');
    // When switching to a non-spell face, clear the isSpell flag that addSpell() may have set.
    // Without this, an adventure perm switched to its creature face still shows the Spell inspector.
    if (!perm.isManualEffect) perm.isSpell = false;
    perm.oracleText = oracleText;
    perm.oracleCounterTypes = _extractOracleCounterTypes(resolvedCard.oracle_text || '', types.subtypes, types.types);

    this.effects = this.effects.filter(e => !(e.sourceId === permId && !e._isCounterEffect));
    const newEffects = parseCardEffects(perm, resolvedCard);
    this.effects.push(...newEffects);
    this._syncCounterEffects(permId);
    this.updateLabels();
  },

  /* Toggle the locked/unlocked state of one room on a Room permanent. */
  toggleRoomLock(permId, faceIndex) {
    this._invalidate();
    const perm = this.getPermById(permId);
    if (!perm?.isRoom || !perm.roomFaces) return;
    perm.roomLocked[faceIndex] = !perm.roomLocked[faceIndex];

    // Rebuild oracle text from only the unlocked rooms
    const activeOracle = perm.roomFaces
      .filter((_, i) => !perm.roomLocked[i])
      .map(f => f.oracle_text || '')
      .filter(Boolean)
      .join('\n');

    let oracleText = _stripReminderText(activeOracle);
    const cardName = perm.scryfallData?.name || perm.name;
    oracleText = _replaceProperNounSelfRef(perm.name, oracleText, perm.isToken);
    if (cardName !== perm.name) oracleText = _replaceProperNounSelfRef(cardName, oracleText, perm.isToken);
    perm.oracleText = oracleText;
    perm.printedAbilities = extractAbilities(oracleText);
    _addIntrinsicLandMana(perm.printedAbilities, perm.printedSubtypes);

    this.effects = this.effects.filter(e => !(e.sourceId === permId && !e._isCounterEffect));
    // Use the active (filtered) oracle text so only unlocked room effects are parsed.
    const newEffects = parseCardEffects(perm, { name: cardName, oracle_text: oracleText });
    this.effects.push(...newEffects);
    this._syncCounterEffects(permId);
  },

  evaluate() {
    if (!this.inspectedId) return null;
    const perm = this.getPermById(this.inspectedId);
    if (!perm) return null;
    // isManualEffect perms (Instant/Sorcery faces not added via addSpell) are excluded
    // from allStates in evaluatePermanent — calling it would crash at snapshotState(undefined).
    // renderInspector handles these via its spell-details branch; skip evaluation here.
    if (perm.isManualEffect) return null;
    // Return cached trace if available (precomputed during getAllFinalStates).
    if (this._inspectorCacheVersion === this._cacheVersion) {
      const cached = this._inspectorCache.get(this.inspectedId);
      if (cached) return cached;
    }
    // Cache miss — compute and store.
    const result = evaluatePermanent(perm, this.permanents, this.effects, this.inspectedId);
    if (this._inspectorCacheVersion !== this._cacheVersion) {
      this._inspectorCache.clear();
      this._inspectorCacheVersion = this._cacheVersion;
    }
    this._inspectorCache.set(this.inspectedId, result);
    // Also populate the finalStates cache from this run (avoids a second pipeline run).
    if (result && result.finalStates && this._cachedFinalStatesVersion !== this._cacheVersion) {
      const realPerms = this.permanents.filter(p => !p.isManualEffect);
      const _fallback = (p) => ({ name: p.name, types: p.printedTypes, supertypes: p.printedSupertypes,
        subtypes: p.printedSubtypes || [], power: p.printedPower, toughness: p.printedToughness,
        colors: p.printedColors || [], abilities: p.printedAbilities || [], oracleText: p.oracleText || '',
        owner: p.owner || 'player_0', controller: p.owner || 'player_0' });
      const map = new Map();
      for (const p of realPerms) map.set(p.id, result.finalStates.get(p.id) || _fallback(p));
      this._cachedFinalStates = map;
      this._cachedFinalStatesVersion = this._cacheVersion;
    }
    return result;
  },

  /* Return Map<permId, finalState> for ALL real permanents.
     Calls evaluatePermanent exactly once (it already runs the full global pipeline),
     then reads finalStates from the result. Previously called it once per permanent. */
  getAllFinalStates() {
    if (this._cachedFinalStatesVersion === this._cacheVersion && this._cachedFinalStates !== null) {
      return this._cachedFinalStates;
    }
    const realPerms = this.permanents.filter(p => !p.isManualEffect);
    const _fallback = (p) => ({ name: p.name, types: p.printedTypes, supertypes: p.printedSupertypes,
      subtypes: p.printedSubtypes || [], power: p.printedPower, toughness: p.printedToughness,
      colors: p.printedColors || [], abilities: p.printedAbilities || [], oracleText: p.oracleText || '',
      owner: p.owner || 'player_0', controller: p.owner || 'player_0' });
    const hasTraits = realPerms.some(rp => rp.traits && rp.traits.length > 0);
    if (realPerms.length === 0) { this._cachedFinalStates = new Map(); this._cachedFinalStatesVersion = this._cacheVersion; return this._cachedFinalStates; }
    if (this.effects.length === 0 && !hasTraits) {
      const map = new Map();
      for (const p of realPerms) map.set(p.id, _fallback(p));
      this._cachedFinalStates = map;
      this._cachedFinalStatesVersion = this._cacheVersion;
      return this._cachedFinalStates;
    }
    // Single evaluation pass — use the inspected (or first) perm as anchor so the pipeline runs once.
    const anchorId = (this.inspectedId && realPerms.some(p => p.id === this.inspectedId))
      ? this.inspectedId : realPerms[0].id;
    const r = evaluatePermanent(realPerms.find(p => p.id === anchorId), realPerms, this.effects, anchorId);
    if (!r || !r.finalStates) {
      const map = new Map();
      for (const p of realPerms) map.set(p.id, _fallback(p));
      this._cachedFinalStates = map;
      this._cachedFinalStatesVersion = this._cacheVersion;
      return this._cachedFinalStates;
    }
    const map = new Map();
    for (const p of realPerms) map.set(p.id, r.finalStates.get(p.id) || _fallback(p));
    this._cachedFinalStates = map;
    this._cachedFinalStatesVersion = this._cacheVersion;
    // Precompute inspector traces for ALL perms so card clicks require no dependency work.
    this._inspectorCache.clear();
    this._inspectorCacheVersion = this._cacheVersion;
    this._inspectorCache.set(anchorId, r);
    for (const p of realPerms) {
      if (p.id === anchorId) continue;
      const tr = evaluatePermanent(p, realPerms, this.effects, p.id);
      this._inspectorCache.set(p.id, tr);
    }
    return this._cachedFinalStates;
  },

  /* Get post-Layer-1 state for a permanent (copiable values).
     Returns the state after Layer 1 effects are applied, which is what a copy sees. */
  getPostLayer1State(permId) {
    const realPerms = this.permanents.filter(p => !p.isManualEffect);
    const perm = realPerms.find(p => p.id === permId);
    if (!perm) return null;
    if (this.effects.length === 0) return null;
    const r = evaluatePermanent(perm, realPerms, this.effects, permId);
    if (!r || !r.layers || r.layers.length === 0) return null;
    // Layer 1 is the first layer (id '1')
    const layer1 = r.layers.find(l => l.id === '1');
    return layer1 ? layer1.stateAfter : null;
  },

  /* ---- Spell tracking (instants/sorceries being cast) ---- */

  /* Add a spell as a pseudo-permanent so continuous effects (Firesong, Swirl, etc.)
     can be evaluated against it via the normal layer engine.
     Spells do not produce their own static effects — they are targets only. */
  addSpell(card, opts = {}) {
    // Snapshot the board BEFORE adding the spell so the camera popup shows what the
    // spell is being cast into (matches semantics of trigger/activated fire-time snapshots).
    const firedAtSnapshot = this._buildFiredAtSnapshot(opts.firedAtStates);
    const perm = createPermanent(card, this.nextTimestamp++, opts);
    perm.isSpell = true;
    perm.isManualEffect = false; // createPermanent auto-sets this for Instants/Sorceries; clear it so spell perms join evaluation
    if (!perm.controller) perm.controller = opts.controller || this.activePlayerId;
    if (!perm.owner) perm.owner = opts.owner || this.activePlayerId;
    perm._firedAtSnapshot = firedAtSnapshot;
    this.permanents.push(perm);
    // Parse spell effects so the inspector can show a target picker (e.g. Viridescent Wisps, Oracle's Restoration)
    const resolvedForParse = _resolveCardFace(card, opts.faceIndex || 0);
    const newEffects = parseCardEffects(perm, resolvedForParse);
    for (const eff of newEffects) eff.isSpellEffect = true;
    this.effects.push(...newEffects);
    this.updateLabels();
    this._invalidate();
    return perm;
  },

  /* Compute counts of each type, subtype, and supertype across all permanents.
     Also tracks combo trait counts and devotion.
     Uses final evaluated states when available, otherwise printed values.
     Returns { types: Map, subtypes: Map, supertypes: Map, combos: Map,
               devotion: {W,U,B,R,G}, nonbasicLands: number, basicLands: number } */
  getBattlefieldTypeCounts() {
    const counts = { types: new Map(), subtypes: new Map(), supertypes: new Map(),
                     combos: new Map(), devotion: { W: 0, U: 0, B: 0, R: 0, G: 0 },
                     basicLands: 0, nonbasicLands: 0, creatureTypeCount: new Map(),
                     counters: new Map(), totalCounters: 0, countersByPerm: new Map() };
    const realPerms = this.permanents.filter(p => !p.isManualEffect && !p.isSpell);
    if (realPerms.length === 0) return counts;
    const finalStates = this.getAllFinalStates();

    for (const p of realPerms) {
      const state = finalStates.get(p.id);
      const types = state ? state.types : p.printedTypes;
      const subtypes = state ? state.subtypes : (p.printedSubtypes || []);
      const supertypes = state ? state.supertypes : (p.printedSupertypes || []);
      const manaCost = state ? (state.manaCost || '') : (p.manaCost || '');

      for (const t of types) {
        counts.types.set(t, (counts.types.get(t) || 0) + 1);
      }
      for (const st of subtypes) {
        counts.subtypes.set(st, (counts.subtypes.get(st) || 0) + 1);
      }
      for (const sup of supertypes) {
        counts.supertypes.set(sup, (counts.supertypes.get(sup) || 0) + 1);
      }

      // Track basic vs non-basic lands
      if (types.includes('Land')) {
        if (supertypes.includes('Basic')) {
          counts.basicLands++;
        } else {
          counts.nonbasicLands++;
        }
      }

      // Compute devotion from mana costs
      for (const ch of manaCost) {
        if (counts.devotion[ch] !== undefined) counts.devotion[ch]++;
      }

      const allTraits = [...supertypes, ...types, ...subtypes];
      const n = allTraits.length;
      for (let i = 0; i < n; i++) {
        const a = allTraits[i];
        for (let j = i + 1; j < n; j++) {
          const key2 = a + ' ' + allTraits[j];
          counts.combos.set(key2, (counts.combos.get(key2) || 0) + 1);
          for (let k = j + 1; k < n; k++) {
            const key3 = key2 + ' ' + allTraits[k];
            counts.combos.set(key3, (counts.combos.get(key3) || 0) + 1);
            for (let l = k + 1; l < n; l++) {
              const key4 = key3 + ' ' + allTraits[l];
              counts.combos.set(key4, (counts.combos.get(key4) || 0) + 1);
            }
          }
        }
      }

      // Track creature type count per permanent
      {
        const ctCount = subtypes.filter(s =>
          typeof TypeCatalog !== 'undefined' && TypeCatalog.creatureTypes.size > 0
            ? TypeCatalog.creatureTypes.has(s) : true
        ).length;
        counts.creatureTypeCount.set(p.id, ctCount);
      }

      // Track counters per permanent and across the board
      const permCounters = state ? (state.counters || {}) : (p.counters || {});
      let permCounterTotal = 0;
      for (const [cType, cCount] of Object.entries(permCounters)) {
        if (cCount > 0) {
          counts.counters.set(cType, (counts.counters.get(cType) || 0) + cCount);
          permCounterTotal += cCount;
        }
      }
      counts.totalCounters += permCounterTotal;
      counts.countersByPerm.set(p.id, { total: permCounterTotal, types: { ...permCounters } });
    }
    return counts;
  },

  /* Shared: compute state after Layer 1 + Layer 3 effects applied before a given source. */
  _computeLayer3State(permId, beforeSourceId) {
    const allPerms = this.permanents.filter(p => !p.isManualEffect);
    const allStates = new Map();
    for (const p of allPerms) allStates.set(p.id, createBaseState(p));
    // Apply Layer 1 (COPY) effects first
    for (const eff of this.effects.filter(e => e.layer === '1').sort((a, b) => a.timestamp - b.timestamp)) {
      for (const p of allPerms) {
        const st = allStates.get(p.id);
        if (st && effectAppliesToPerm(eff, st, p, p.id, allStates)) applyEffect(st, eff);
      }
    }
    // Apply Layer 3 effects (exchange/volrath first for dependency priority)
    const layer3Effects = this.effects
      .filter(e => e.layer === '3' && e.sourceId !== beforeSourceId)
      .sort((a, b) => a.timestamp - b.timestamp);
    const isExchangeOrVolrath = (e) => e.params.changeType === 'exchange_text' || e.params.changeType === 'volrath_text';
    const sorted = [...layer3Effects.filter(isExchangeOrVolrath), ...layer3Effects.filter(e => !isExchangeOrVolrath(e))];
    const ctx = { exchangeApplied: new Set() };
    for (const eff of sorted) {
      for (const p of allPerms) {
        const st = allStates.get(p.id);
        if (!st || !effectAppliesToPerm(eff, st, p, p.id, allStates)) continue;
        if (eff.type === EFFECT_TYPE.TEXT_CHANGE && isExchangeOrVolrath(eff)) eff._allStates = allStates;
        applyEffect(st, eff, ctx);
      }
    }
    return allStates.get(permId);
  },

  getLayer3Text(permId, beforeSourceId) {
    const perm = this.getPermById(permId);
    if (!perm) return '';
    const state = this._computeLayer3State(permId, beforeSourceId);
    return state ? state.oracleText : perm.oracleText;
  },

  getLayer3Subtypes(permId, beforeSourceId) {
    const perm = this.getPermById(permId);
    if (!perm) return [];
    const state = this._computeLayer3State(permId, beforeSourceId);
    return state ? [...state.subtypes] : [...perm.printedSubtypes];
  },

  // Full characteristics (name, types, subtypes, …) as the card appears at the end of
  // Layer 3 — i.e. after copy + text-changing effects but BEFORE Layer 4 type changes.
  // Used by the text-change modal so the displayed card matches the layer it edits.
  getLayer3State(permId, beforeSourceId) {
    return this._computeLayer3State(permId, beforeSourceId) || null;
  },

  addCommander(card) {
    const face = _resolveCardFace(card, 0);
    const imageUri = face.image_uris?.normal || card.image_uris?.normal || '';
    this.commanders.push({ card, name: face.name || card.name, imageUri, castCount: 0, linkedPermId: null });
  },

  removeCommander(index) {
    this.commanders.splice(index, 1);
  },

  addEmblem(card) {
    this._invalidate();
    const face = card.card_faces ? card.card_faces[0] : card;
    const imageUri = face.image_uris?.normal || card.image_uris?.normal || '';
    const name = card.name || face.name || '';
    const ts = this.nextTimestamp++;
    const emblemId = 'emblem_' + this.activePlayerId + '_' + ts;
    const oracleText = face.oracle_text || card.oracle_text || '';
    const colors = face.colors || card.colors || [];
    const pseudoPerm = {
      id: emblemId,
      name,
      timestamp: ts,
      owner: this.activePlayerId,
      controller: this.activePlayerId,
      printedTypes: ['Emblem'],
      printedSupertypes: [],
      printedSubtypes: [],
      printedPower: null,
      printedToughness: null,
      printedAbilities: [],
      printedColors: colors,
      manaValue: 0,
      manaCost: '',
      oracleText,
      imageUri,
      isManualEffect: false,
      isEmblem: true,
      isToken: false,
      counters: {},
      scryfallData: card,
    };
    this.permanents.push(pseudoPerm);
    const fakeCard = {
      name,
      oracle_text: oracleText,
      type_line: card.type_line || 'Emblem',
      colors,
      cmc: 0,
    };
    const newEffects = parseCardEffects(pseudoPerm, fakeCard);
    this.effects.push(...newEffects);
    this.emblems.push({ card, name, imageUri, permId: emblemId });
    this.updateLabels();
    return pseudoPerm;
  },

  removeEmblem(index) {
    this._invalidate();
    const emblem = this.emblems[index];
    if (emblem) {
      this.permanents = this.permanents.filter(p => p.id !== emblem.permId);
      this.effects = this.effects.filter(e => e.sourceId !== emblem.permId);
    }
    this.emblems.splice(index, 1);
    this.updateLabels();
  },

  isCommander(permId) {
    // First check: exact ID match (when commander was put onto battlefield via the zone)
    if (this.commanders.some(c => c.linkedPermId === permId)) return true;
    // Fallback: name match, but only for commanders not yet linked to any specific permanent
    const perm = this.getPermById(permId);
    if (!perm) return false;
    return this.commanders.some(c => c.linkedPermId === null && c.name === perm.name);
  },

  getCommanderNames() {
    return this.commanders.map(c => c.name);
  },

  /* ─── Board persistence (serialize / restore) ───
     Battlefield.effects carry live appliesTo functions and are NOT JSON-serializable.
     Instead we capture a "recipe" (the Scryfall card + the user's choices/state for each
     permanent) and replay the existing add pipeline on restore. */
  serialize() {
    const isRealPerm = (p) =>
      p.scryfallData && !p.abilitySourceId && !p.isEmblem &&
      !p._exchangeSourcePermId && !p._isCrewEffect && !p._isSaddleEffect;

    // Capture target intents from a given source's effects (shared by real
    // permanents and fired ability pseudo-perms).
    const captureTargets = (srcId) => {
      let primaryTarget = null, multiTarget = null, copySource = null, targetTs = null, copyTargetPermId = null;
      const slotTargets = {}, modalTargets = {}, slotTs = {};
      for (const e of this.effects) {
        if (e.sourceId !== srcId) continue;
        if (e.type === EFFECT_TYPE.COPY && e.params && e.params.copySource) copySource = e.params.copySource;
        if (e.type === EFFECT_TYPE.COPY && e.params && e.params._copyTargetPermId) copyTargetPermId = e.params._copyTargetPermId;
        if (e.scope !== 'targeted' || e.selfTarget) continue;
        if (e.targetIds && e.targetIds.length) multiTarget = e.targetIds.slice();
        if (e._targetSlot !== undefined) { if (e.targetId) { slotTargets[e._targetSlot] = e.targetId; slotTs[e._targetSlot] = e.timestamp; } }
        else if (e.modalModeIndex !== undefined) { if (e.targetId) modalTargets[e.modalModeIndex] = e.targetId; }
        else if (e.targetId && primaryTarget === null) { primaryTarget = e.targetId; targetTs = e.timestamp; }
      }
      // targetTs / slotTs preserve the ACTUAL layer-ordering timestamp of targeted
      // effects (auras/equipment), which setTarget/setSlottedTarget bump independently of
      // the perm's own timestamp. Without these, restore would reconstruct the order from
      // array iteration and silently flip last-timestamp-wins effects (CR 613.7).
      return { primaryTarget, multiTarget, slotTargets, modalTargets, copySource, targetTs, slotTs, copyTargetPermId };
    };

    // Capture per-effect user choices that re-parse alone won't reproduce: exchange
    // text/control targets, swirl color, standard text-change replacements, deadpool
    // target, Volrath graveyard card, and modal-mode enable/disable. Returns null when
    // there's nothing to restore. Target ids are translated through idMap on restore.
    const captureChoices = (srcId) => {
      const c = {};
      for (const e of this.effects) {
        if (e.sourceId !== srcId) continue;
        const p = e.params || {};
        if (e.type === EFFECT_TYPE.TEXT_CHANGE) {
          if (p.changeType === 'exchange_text') {
            if (p.exchangeTargetA && p.exchangeTargetB) c.exchangeText = { a: p.exchangeTargetA, b: p.exchangeTargetB };
            if (p.exchangeTargetId) c.deadpool = p.exchangeTargetId;
          } else if (p.changeType === 'color_global') {
            if (p.chosenColor) c.swirlColor = p.chosenColor;
          } else if (p.changeType === 'volrath_text') {
            if (p.graveyardCard) c.volrathCard = p.graveyardCard;
          } else if (p.replacements && p.replacements.length) {
            c.textChange = { targetId: e.targetId || null, replacements: p.replacements };
          }
        } else if (e.type === EFFECT_TYPE.CONTROL && p.exchangeControl) {
          if (p.exchangeTargetA && p.exchangeTargetB) c.exchangeControl = { a: p.exchangeTargetA, b: p.exchangeTargetB };
        }
      }
      const modalEffs = this.effects.filter(e => e.sourceId === srcId && e.modalModeIndex !== undefined);
      if (modalEffs.length && modalEffs.some(e => e.disabled)) {
        c.modalDisabled = {};
        for (const e of modalEffs) c.modalDisabled[e.modalModeIndex] = !!e.disabled;
      }
      return Object.keys(c).length ? c : null;
    };

    const perms = this.permanents.filter(isRealPerm).map(p => {
      const { primaryTarget, multiTarget, slotTargets, modalTargets, copySource, targetTs, slotTs, copyTargetPermId } = captureTargets(p.id);
      return {
        id: p.id,
        scryfallData: p.scryfallData,
        isSpell: !!p.isSpell,
        faceIndex: p.activeFaceIndex ?? 0,
        isToken: !!p.isToken,
        owner: p.owner || 'player_0',
        controller: p.controller || p.owner || 'player_0',
        timestamp: p.timestamp,
        tapped: !!p.tapped,
        traits: Array.isArray(p.traits) ? p.traits.slice() : [],
        counters: { ...(p.counters || {}) },
        counterTimestamps: { ...(p.counterTimestamps || {}) },
        isFaceDown: !!p.isFaceDown,
        faceDownMode: p.faceDownMode || null,
        roomLocked: p.roomLocked ? p.roomLocked.slice() : null,
        cdaUserValue: p.cdaUserValue ?? null,
        classLevel: p.classLevel ?? null,
        hasXValue: !!p.hasXValue,
        xValue: p.xValue ?? null,
        chosenCreatureType: p.chosenCreatureType || null,
        chosenColor: p.chosenColor || null,
        chosenCardName: p.chosenCardName || null,
        chosenLandType: p.chosenLandType || null,
        chosenCardType: p.chosenCardType || null,
        targetOpponentPlayerId: p._targetOpponentPlayerId || null,
        targetPlayerId: p._targetPlayerId || null,
        enchantedPlayerId: p._enchantedPlayerId || null,
        modalModeCounts: p.modalModeCounts || null,
        primaryTarget, multiTarget, slotTargets, modalTargets, copySource, targetTs, slotTs, copyTargetPermId,
        choices: captureChoices(p.id),
        // Camera/board-snapshot popup for a SPELL (instant/sorcery on the stack): the
        // cast-time board picture. Like fired abilities, addSpell rebuilds it from the
        // CURRENT board on restore, so persist it. Spells have no separate _firedAtStates,
        // so .states is captured here too. Restored verbatim (self-contained, cast-time ids).
        firedAtSnapshot: p._firedAtSnapshot ? {
          states: p._firedAtSnapshot.states instanceof Map
            ? [...p._firedAtSnapshot.states.entries()]
            : Object.entries(p._firedAtSnapshot.states || {}),
          perms: p._firedAtSnapshot.perms,
          mutateStacks: p._firedAtSnapshot.mutateStacks,
          bestowTargets: p._firedAtSnapshot.bestowTargets,
          activePlayerId: p._firedAtSnapshot.activePlayerId,
          players: p._firedAtSnapshot.players,
        } : null,
      };
    });

    // Fired abilities are pseudo-perms in the timeline (generic triggered/activated,
    // command-zone, crew, saddle, equip, exchange). They carry their own targets and
    // their timestamp fixes their order relative to everything else, so they must be
    // replayed on restore for a faithful board.
    const isFiredAbility = (p) =>
      p.abilitySourceId && (p.isTriggeredAbility || p.isActivatedAbility);

    const firedAbilities = this.permanents.filter(isFiredAbility).map(p => {
      const isCommandZone = String(p.abilitySourceId).startsWith('cmdzone_');
      let pseudoKind = 'ability';
      if (p._isCrewEffect) pseudoKind = 'crew';
      else if (p._isSaddleEffect) pseudoKind = 'saddle';
      else if (p._isEquipEffect) pseudoKind = 'equip';
      return {
        id: p.id,
        kind: p.isTriggeredAbility ? 'trigger' : 'activated',
        pseudoKind,
        sourceId: p.abilitySourceId,
        isCommandZone,
        commanderIdx: isCommandZone ? Number(String(p.abilitySourceId).slice('cmdzone_'.length)) : null,
        abilityIndex: p.abilityIndex,
        timestamp: p.timestamp,
        effectText: p.oracleText || '',
        fullText: p.abilityFullText || '',
        owner: p.owner || 'player_0',
        controller: p.controller || p.owner || 'player_0',
        equipTargetId: p._equipTargetId || null,
        // Player-level targets (chosen opponent / chosen player / enchanted player) live
        // on the pseudo-perm just like on real perms, so capture them too — a triggered
        // ability that targets an opponent would otherwise lose its choice on restore.
        targetOpponentPlayerId: p._targetOpponentPlayerId || null,
        targetPlayerId: p._targetPlayerId || null,
        enchantedPlayerId: p._enchantedPlayerId || null,
        // Fire-time board snapshot (CR 611.2c): a triggered/activated ability's continuous
        // effect locks in WHICH permanents it affects when it resolves. The engine evaluates
        // membership against this frozen snapshot, not live state. It MUST be persisted —
        // replaying the ability on restore recomputes it from the current board, which can
        // differ from fire time if cards were added/removed afterward (e.g. the source's
        // own combat-trick lord left play), silently changing the locked set. Keys are perm
        // ids, translated through idMap on restore; entries for since-removed perms drop out.
        firedAtStates: p._firedAtStates ? [...p._firedAtStates.entries()] : null,
        // Camera/board-snapshot popup: the rest of the fire-time board picture (perms,
        // mutate stacks, bestow links, players). Recomputed-from-current-board on replay
        // like firedAtStates, so persist it. .states is omitted here — it is the same data
        // as firedAtStates above and is rebuilt from it (verbatim, fire-time ids) on restore.
        firedAtSnapshot: p._firedAtSnapshot ? {
          perms: p._firedAtSnapshot.perms,
          mutateStacks: p._firedAtSnapshot.mutateStacks,
          bestowTargets: p._firedAtSnapshot.bestowTargets,
          activePlayerId: p._firedAtSnapshot.activePlayerId,
          players: p._firedAtSnapshot.players,
        } : null,
        ...captureTargets(p.id),
        choices: captureChoices(p.id),
      };
    });

    const players = this.players.map(pl => ({
      id: pl.id,
      name: pl.name,
      gameState: JSON.parse(JSON.stringify(pl.gameState || {})),
      commanders: (pl.commanders || []).map(c => ({ card: c.card, castCount: c.castCount || 0 })),
      graveyard: (pl.graveyard || []).slice(),
      emblems: (pl.emblems || []).map(em => ({ card: em.card })),
    }));

    const mutateStacks = this.mutateStacks.map(s => s.slice());
    const bestowTargets = [];
    for (const [k, v] of this.bestowTargets) bestowTargets.push([k, v]);

    const exile = (this.exile || []).map(e => ({
      card: e.card, owner: e.owner, exiledWithId: e.exiledWithId || null,
      counters: { ...(e.counters || {}) }, isFaceDown: !!e.isFaceDown,
    }));

    return {
      version: 1,
      perms, firedAbilities, players, exile, mutateStacks, bestowTargets,
      activePlayerId: this.activePlayerId,
      nextPlayerId: this.nextPlayerId,
      explanationMode: this.explanationMode,
      inspectedId: this.inspectedId,
    };
  },

  restore(data) {
    if (!data || data.version !== 1) return false;
    this.clear();
    this.exile = [];
    this.nextExileId = 1;
    this.bestowTargets = new Map();
    this.mutateStacks = [];
    this.resetTriggerCounts();   // stale per-permId fire counts from the prior board

    // Rebuild players from saved data (clear() left a single default player).
    this.players = (data.players || []).map(pl => {
      const cmds = (pl.commanders || []).map(c => {
        const face = _resolveCardFace(c.card, 0);
        return {
          card: c.card,
          name: face.name || c.card.name,
          imageUri: face.image_uris?.normal || c.card.image_uris?.normal || '',
          castCount: c.castCount || 0,
          linkedPermId: null,
        };
      });
      return {
        id: pl.id,
        name: pl.name,
        // Merge saved state over a fresh default clone so share-link-stripped keys (left
        // at their default) come back correctly; full (file/autosave) state passes through.
        gameState: Object.assign(JSON.parse(JSON.stringify(DEFAULT_GAME_STATE)), JSON.parse(JSON.stringify(pl.gameState || {}))),
        commanders: cmds,
        graveyard: (pl.graveyard || []).slice(),
        emblems: [],   // re-added via addEmblem below
      };
    });
    if (!this.players.length) { this.clear(); return false; }
    this.nextPlayerId = data.nextPlayerId || this.players.length;
    this.explanationMode = data.explanationMode || 'teaching';

    const savedActive = data.activePlayerId || this.players[0].id;
    const idMap = {};

    // Re-add permanents in timestamp order so labels/ordering match the original board.
    const sortedPerms = (data.perms || []).slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    for (const r of sortedPerms) {
      this.activePlayerId = r.owner;   // createPermanent reads activePlayerId for owner/controller
      let np;
      if (r.isSpell) {
        np = this.addSpell(r.scryfallData, { faceIndex: r.faceIndex, controller: r.owner, owner: r.owner });
      } else {
        np = this.addPermanent(r.scryfallData, {
          faceIndex: r.faceIndex, isToken: r.isToken,
          suppressPrompt: true, xValue: r.xValue,
        });
      }
      if (!np) continue;
      idMap[r.id] = np.id;

      np.timestamp = r.timestamp;
      // Apply chosen values (each re-parses effects from the original oracle text).
      if (r.chosenCreatureType) this.setChosenCreatureType(np.id, r.chosenCreatureType);
      if (r.chosenColor) this.setChosenColor(np.id, r.chosenColor);
      if (r.chosenCardName) this.setChosenCardName(np.id, r.chosenCardName);
      if (r.chosenLandType) this.setChosenLandType(np.id, r.chosenLandType);
      if (r.chosenCardType) this.setChosenCardType(np.id, r.chosenCardType);
      // Mutable runtime/display state.
      np.controller = r.controller || r.owner;
      np.tapped = !!r.tapped;
      np.traits = Array.isArray(r.traits) ? r.traits.slice() : [];
      np.counters = { ...(r.counters || {}) };
      np.counterTimestamps = { ...(r.counterTimestamps || {}) };
      // Counters drive P/T and keyword grants through synthetic effects — rebuild them.
      this._syncCounterEffects(np.id);
      if (r.cdaUserValue != null) np.cdaUserValue = r.cdaUserValue;
      if (r.classLevel != null) np.classLevel = r.classLevel;
      if (r.roomLocked) np.roomLocked = r.roomLocked.slice();
      if (r.modalModeCounts) this.setModalModeCounts(np.id, r.modalModeCounts);
      if (r.targetOpponentPlayerId) this.setTargetOpponent(np.id, r.targetOpponentPlayerId);
      if (r.targetPlayerId) this.setTargetPlayer(np.id, r.targetPlayerId);
      if (r.enchantedPlayerId) this.setEnchantedPlayer(np.id, r.enchantedPlayerId);
      // Face-down last (re-parses to a 2/2 with no oracle text).
      if (r.isFaceDown && !np.isFaceDown) this.setFaceDown(np.id, r.faceDownMode || 'morph');
      // Re-stamp effects to the restored timestamp. Counter effects are excluded: they
      // carry their own per-counter timestamps (from counterTimestamps) so a counter added
      // after a same-sublayer effect (e.g. a power-doubling trigger) keeps its later order.
      for (const e of this.effects) { if (e.sourceId === np.id && !e._isCounterEffect) e.timestamp = r.timestamp; }
    }

    // Replay fired abilities in timestamp order. Sources now exist (real perms above,
    // commanders in the player rebuild), so each pseudo-perm is recreated through the
    // same code path the live UI uses, then slotted back to its saved timestamp.
    // Targets and per-effect choices are re-applied in the final pass below.
    const sortedFired = (data.firedAbilities || []).slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    for (const f of sortedFired) {
      this.activePlayerId = f.owner;   // command-zone fire reads activePlayerId for its commander list + owner
      const states = this.getAllFinalStates();
      const srcId = f.isCommandZone ? f.sourceId : idMap[f.sourceId];
      let pseudo;
      if (f.pseudoKind === 'crew') {
        if (!srcId) continue;
        pseudo = this.applyCrew(srcId, f.abilityIndex, f.fullText);
      } else if (f.pseudoKind === 'saddle') {
        if (!srcId) continue;
        pseudo = this.applySaddle(srcId, f.abilityIndex, f.fullText);
      } else if (f.pseudoKind === 'equip') {
        if (!srcId || !f.equipTargetId || !idMap[f.equipTargetId]) continue;
        pseudo = this.applyEquipAttachment(srcId, f.abilityIndex, idMap[f.equipTargetId]);
      } else if (f.isCommandZone) {
        if (f.commanderIdx == null || !this.commanders[f.commanderIdx]) continue;
        pseudo = this.addCommandZoneAbility(f.commanderIdx, f.abilityIndex, f.effectText, f.fullText, f.kind, states);
      } else {
        if (!srcId) continue;
        pseudo = this._addAbilityPseudo(srcId, f.abilityIndex, f.effectText, f.fullText, f.kind, states);
        // Re-inject exchange-text / exchange-control effects (no-op for other text).
        if (pseudo) this.injectTriggeredExchange(pseudo, srcId, f.effectText);
        // Re-inject Princess Yue-style becomes-a-land transform effects. The board's
        // saved timestamps/targets already reflect the imperative parts, so skip those.
        if (pseudo) this.injectTriggeredBecomesLand(pseudo, srcId, f.effectText, { imperative: false });
      }
      if (!pseudo) continue;
      idMap[f.id] = pseudo.id;
      pseudo.timestamp = f.timestamp;
      // Re-stamp the ability's effects to its saved timestamp so layer ordering matches.
      for (const e of this.effects) { if (e.sourceId === pseudo.id) e.timestamp = f.timestamp; }
    }

    // Re-add emblems (addEmblem pushes a pseudo-perm + a player.emblems entry).
    for (const pl of data.players || []) {
      this.activePlayerId = pl.id;
      for (const em of pl.emblems || []) this.addEmblem(em.card);
    }

    // Restore exile (global zone). exiledWithId references a permanent — translate it.
    this.exile = (data.exile || []).map(e => ({
      id: 'exile_' + (this.nextExileId++),
      card: e.card, owner: e.owner,
      exiledWithId: e.exiledWithId ? (idMap[e.exiledWithId] || null) : null,
      counters: { ...(e.counters || {}) }, isFaceDown: !!e.isFaceDown,
      timestamp: this.nextTimestamp++,
    }));

    // Rebuild mutate stacks (translate ids; drop any that no longer resolve).
    this.mutateStacks = (data.mutateStacks || [])
      .map(stack => stack.map(id => idMap[id]).filter(Boolean))
      .filter(stack => stack.length >= 2);
    if (this.mutateStacks.length) this._redirectEffectsToStackTop();

    // Re-apply bestow relationships.
    for (const [bId, tId] of data.bestowTargets || []) {
      const nb = idMap[bId], nt = idMap[tId];
      if (nb && nt) this.applyBestow(nb, nt);
    }

    // Re-apply effect targets now that all sources/targets (incl. fired abilities) exist.
    const reapplyTargets = (r) => {
      const nsId = idMap[r.id];
      if (!nsId) return;
      // Set the copy source FIRST: a copy of an Aura injects its targeted attachment
      // effect (via _injectKnownCardEffectsForCopy) that the following setTarget() needs
      // to exist before it can stamp the enchant target.
      if (r.copySource) {
        this.setCopySource(nsId, r.copySource);
        // Restore the live copy-of-copy link (CR 707.2) so the engine re-derives copiable
        // values from the source's Layer-1 state instead of the frozen snapshot. Translate
        // the stored source perm id through idMap.
        if (r.copyTargetPermId && idMap[r.copyTargetPermId]) {
          const copyEff = this.effects.find(e => e.sourceId === nsId && e.type === EFFECT_TYPE.COPY);
          if (copyEff) copyEff.params._copyTargetPermId = idMap[r.copyTargetPermId];
        }
        if (typeof _injectKnownCardEffectsForCopy === 'function') {
          _injectKnownCardEffectsForCopy(nsId, r.copySource);
        }
      }
      if (r.primaryTarget && idMap[r.primaryTarget]) this.setTarget(nsId, idMap[r.primaryTarget]);
      if (r.multiTarget) r.multiTarget.forEach((tid, i) => { if (idMap[tid]) this.setMultiTarget(nsId, i, idMap[tid]); });
      for (const [slot, tid] of Object.entries(r.slotTargets || {})) { if (idMap[tid]) this.setSlottedTarget(nsId, Number(slot), idMap[tid]); }
      for (const [mi, tid] of Object.entries(r.modalTargets || {})) { if (idMap[tid]) this.setModalModeTarget(nsId, Number(mi), idMap[tid]); }
      // Player-level targets (these reference player ids, not perm ids — no idMap needed).
      // Idempotent for real perms (already applied during the creation loop above); this
      // is the only place fired-ability pseudo-perms get their opponent/player choice back.
      if (r.targetOpponentPlayerId) this.setTargetOpponent(nsId, r.targetOpponentPlayerId);
      if (r.targetPlayerId) this.setTargetPlayer(nsId, r.targetPlayerId);
      if (r.enchantedPlayerId) this.setEnchantedPlayer(nsId, r.enchantedPlayerId);
    };
    // Re-apply per-effect user choices (exchange / swirl / text-change / deadpool /
    // Volrath / modal selections), translating any perm-id params through idMap.
    const reapplyChoices = (r) => {
      const nsId = idMap[r.id];
      const c = r.choices;
      if (!nsId || !c) return;
      const tr = (id) => id ? (idMap[id] || null) : null;
      if (c.exchangeText) { const a = tr(c.exchangeText.a), b = tr(c.exchangeText.b); if (a && b) this.setExchangeTargets(nsId, a, b); }
      if (c.deadpool) { const t = tr(c.deadpool); if (t) this.setDeadpoolTarget(nsId, t); }
      if (c.exchangeControl) { const a = tr(c.exchangeControl.a), b = tr(c.exchangeControl.b); if (a && b) this.setExchangeControlTargets(nsId, a, b); }
      if (c.swirlColor) this.setSwirlColor(nsId, c.swirlColor);
      if (c.textChange) this.setTextChangeConfig(nsId, c.textChange.targetId ? tr(c.textChange.targetId) : undefined, c.textChange.replacements);
      if (c.volrathCard) this.setVolrathGraveyardCard(nsId, c.volrathCard);
      if (c.modalDisabled) {
        const active = new Set();
        for (const [mi, dis] of Object.entries(c.modalDisabled)) if (!dis) active.add(Number(mi));
        this.setModalModeSelections(nsId, active);
      }
    };
    for (const r of data.perms || []) { reapplyTargets(r); reapplyChoices(r); }
    for (const f of data.firedAbilities || []) { reapplyTargets(f); reapplyChoices(f); }

    // setTarget / setSlottedTarget above assigned FRESH timestamps to targeted effects
    // (in array-iteration order), which scrambles last-timestamp-wins layer ordering for
    // auras/equipment. Now that every target is wired up, stamp those effects back to the
    // exact timestamps captured at save time so the rebuilt board's CR 613.7 order is
    // identical. Runs for both real perms and fired-ability pseudo-perms.
    const restoreEffTimestamps = (r) => {
      const nsId = idMap[r.id];
      if (!nsId) return;
      if (r.targetTs != null) {
        this.effects.forEach(e => {
          if (e.sourceId === nsId && e.scope === 'targeted' && !e.selfTarget &&
              e._targetSlot === undefined && e.modalModeIndex === undefined) {
            e.timestamp = r.targetTs;
          }
        });
      }
      for (const [slot, ts] of Object.entries(r.slotTs || {})) {
        this.effects.forEach(e => {
          if (e.sourceId === nsId && e._targetSlot === Number(slot)) e.timestamp = ts;
        });
      }
    };
    for (const r of data.perms || []) restoreEffTimestamps(r);
    for (const f of data.firedAbilities || []) restoreEffTimestamps(f);

    // Restore each fired ability's fire-time snapshot (CR 611.2c locked set). Replaying the
    // ability above recomputed _firedAtStates from the CURRENT board, which is wrong whenever
    // the board changed after the ability fired (cards added/removed). Overwrite it with the
    // saved snapshot, translating perm-id keys through idMap and dropping entries for perms
    // that no longer exist. idMap is fully populated now (all perms + fired abilities exist).
    for (const f of data.firedAbilities || []) {
      const nsId = idMap[f.id];
      if (!nsId || !f.firedAtStates) continue;
      const snap = new Map();
      for (const [oldId, st] of f.firedAtStates) {
        const newId = idMap[oldId];
        if (newId) snap.set(newId, st);
      }
      const pseudo = this.getPermById(nsId);
      if (pseudo) pseudo._firedAtStates = snap;
      this.effects.forEach(e => { if (e.sourceId === nsId && e._firedAtStates) e._firedAtStates = snap; });

      // Camera/board-snapshot popup: restore the verbatim fire-time picture of the whole
      // board. Replaying the ability rebuilt _firedAtSnapshot from the CURRENT board (wrong
      // when cards changed after the fire). Unlike the engine's _firedAtStates above, this is
      // a SELF-CONTAINED historical view whose .perms and .states correlate by fire-time ids,
      // so it is restored UNtranslated (its .states reuses the same saved firedAtStates data).
      if (pseudo && f.firedAtSnapshot) {
        pseudo._firedAtSnapshot = {
          states: new Map(f.firedAtStates),
          perms: f.firedAtSnapshot.perms || [],
          mutateStacks: f.firedAtSnapshot.mutateStacks || [],
          bestowTargets: f.firedAtSnapshot.bestowTargets || {},
          activePlayerId: f.firedAtSnapshot.activePlayerId,
          players: f.firedAtSnapshot.players || [],
        };
      }
    }

    // Same for SPELLS (instants/sorceries on the stack): addSpell rebuilt _firedAtSnapshot
    // from the CURRENT board during the perm loop. Restore the verbatim cast-time picture.
    // Spells carry no separate _firedAtStates, so .states comes from the snapshot's own saved
    // entries. Self-contained + cast-time ids; the target picker still falls back to live
    // finalStates for current candidates exactly as it does today after a restore.
    for (const r of data.perms || []) {
      if (!r.firedAtSnapshot) continue;
      const nsId = idMap[r.id];
      const pseudo = nsId && this.getPermById(nsId);
      if (!pseudo) continue;
      pseudo._firedAtSnapshot = {
        states: new Map(r.firedAtSnapshot.states || []),
        perms: r.firedAtSnapshot.perms || [],
        mutateStacks: r.firedAtSnapshot.mutateStacks || [],
        bestowTargets: r.firedAtSnapshot.bestowTargets || {},
        activePlayerId: r.firedAtSnapshot.activePlayerId,
        players: r.firedAtSnapshot.players || [],
      };
    }

    this.activePlayerId = this.getPlayer(savedActive) ? savedActive : this.players[0].id;
    this.inspectedId = (data.inspectedId && idMap[data.inspectedId]) ? idMap[data.inspectedId] : null;
    // Recompute nextTimestamp above all restored timestamps. Include effect timestamps:
    // a re-targeted aura's effect can carry a higher timestamp than any permanent.
    let maxTs = 0;
    for (const p of this.permanents) if ((p.timestamp || 0) > maxTs) maxTs = p.timestamp;
    for (const e of this.effects) if ((e.timestamp || 0) > maxTs) maxTs = e.timestamp;
    for (const e of this.exile) if ((e.timestamp || 0) > maxTs) maxTs = e.timestamp;
    this.nextTimestamp = maxTs + 1;
    this.updateLabels();
    this._invalidate();
    this.evaluate();
    return true;
  },

  clear() {
    this.permanents = [];
    this.effects = [];
    this.nextTimestamp = 1;
    this.inspectedId = null;
    this.mutateStacks = [];
    this._cacheVersion = 0;
    this._cachedFinalStates = null;
    this._cachedFinalStatesVersion = -1;
    this._inspectorCache = new Map();
    this._inspectorCacheVersion = -1;
    this._permById = null;
    this._permByIdVersion = -1;
    // Reset to single player
    this.players = [{
      id: 'player_0',
      name: 'Player 1',
      gameState: {
        handSize: 7, drawsThisTurn: 0, graveyardCount: 0,
        startingLife: 20, currentLife: 20, isYourTurn: true,
        isMonarch: false, hasInitiative: false,
        poisonCounters: 0, experienceCounters: 0,
        customCounters: {},
      },
      commanders: [],
      graveyard: [],
      emblems: [],
    }];
    this.activePlayerId = 'player_0';
    this.nextPlayerId = 1;
  },
};
/* [END: BATTLEFIELD] */
