#!/usr/bin/env python3
"""Whole-card-pool parser sweep for the Layer Inspector.

    python3 tests/sweep.py                 # parse every card, then write the report
    python3 tests/sweep.py --report        # rebuild the report from the last run's raw results
    python3 tests/sweep.py --only "Name"   # sweep just the named cards and print what was found
    python3 tests/sweep.py --limit 2000    # sweep the first N cards (quick trial)

Runs the parser over every card in the cached Scryfall bulk file (see tests/run.py) and writes
tests/sweep/report.md and tests/sweep/singletons.md. No network. Two kinds of result:

  1. Crashes and nonsense - exceptions, NaN power/toughness, effects with no layer.
  2. Sentences that read like continuous effects ("gets", "has", "becomes", "loses",
     "gain control") but produced no effect, clustered by template: numbers, types,
     keywords and colors are swapped for placeholders so cards that share a wording
     land in one cluster.

  3. Parts of a sentence the parser did not read, although the sentence as a whole produced
     an effect ('It's goaded ... and it gains "..."' with the quoted ability dropped). Every
     number of a +N/+N or N/N, keyword of a granted list, quoted ability, type word and colour
     word is swapped for another of its kind, and every "and ..." clause with its own verb is
     removed; a swap or removal that leaves the effects unchanged is listed in
     tests/sweep/partial.md, most-played cards first (EDHREC rank).

  4. Sentences that reach the wrong permanents. On a two-player board holding the same 16
     blank witnesses on each side, a sentence whose subject is a group ("Other Elves you
     control get ...") is judged by which witnesses change. "You control" must reach nothing
     of the opponent's, and every word of the subject (the controller phrase, "other", colour,
     card type, subtype, token, legendary, "with <keyword>", "power N or less") is swapped for
     another of its kind: a word no swap of which changes who is affected was not read.
     Listed in tests/sweep/subject.md, most-played cards first; cards legal in no format are
     left out. A check on a sentence that reaches no witness says nothing ("inert").

A cluster shared by many cards is a generic parser gap; one that appears on a single card is
a special-case candidate. tests/sweep.js does the parsing; this file filters and clusters.
"""
import argparse
import collections
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.expanduser('~/Library/Caches/layer-inspector')
CARD_CACHE = os.path.join(CACHE_DIR, 'oracle-cards.jsonl.gz')
RAW = os.path.join(CACHE_DIR, 'sweep-raw.jsonl.gz')
OUT_DIR = os.path.join(ROOT, 'tests', 'sweep')
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc'

CHUNK = 400
CHUNK_TIMEOUT = 300      # seconds for a chunk of CHUNK cards
CARD_TIMEOUT = 30        # seconds for one card when hunting down a hang

SKIP_LAYOUTS = {'art_series', 'emblem', 'scheme', 'planar', 'vanguard'}
SKIP_SET_TYPES = {'funny', 'memorabilia', 'minigame', 'alchemy'}
CARD_FIELDS = ('name', 'layout', 'type_line', 'oracle_text', 'mana_cost', 'cmc', 'power', 'toughness',
               'loyalty', 'defense', 'colors', 'color_identity', 'color_indicator', 'keywords',
               'produced_mana', 'oracle_id')


# ───────────────────────────── running the sweep ─────────────────────────────

def engine_cmd():
    node = shutil.which('node')
    if node:
        return [node, 'tests/sweep.js']
    if os.path.exists(JSC):
        return [JSC, 'tests/sweep.js', '--']
    sys.exit('No JavaScript engine found (need Node, or macOS jsc at %s).' % JSC)


def app_scripts():
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    srcs = re.findall(r'<script src="([^"?]+)', html)
    return [s for s in srcs if not s.startswith('ui-')] + ['ui-helpers.js']


def slim(card, fields=CARD_FIELDS):
    c = {k: card[k] for k in fields if k in card}
    if card.get('card_faces'):
        c['card_faces'] = [{k: f[k] for k in fields if k in f} for f in card['card_faces']]
    return c


def load_cards(only=None, limit=None, fields=CARD_FIELDS):
    if not os.path.exists(CARD_CACHE):
        sys.exit('No card file at %s (see "Regression Tests" in CLAUDE.md).' % CARD_CACHE)
    cards, skipped = [], collections.Counter()
    with gzip.open(CARD_CACHE, 'rt', encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            c = json.loads(line)
            if only is not None:
                if c['name'] in only or c['name'].split(' // ')[0] in only:
                    cards.append(slim(c, fields))
                continue
            if c.get('layout') in SKIP_LAYOUTS:
                skipped['layout ' + c['layout']] += 1
            elif c.get('set_type') in SKIP_SET_TYPES:
                skipped['set type ' + c['set_type']] += 1
            elif c['name'].startswith('A-'):
                skipped['alchemy rebalance'] += 1
            else:
                cards.append(slim(c, fields))
    cards.sort(key=lambda c: c['name'])
    if limit:
        cards = cards[:limit]
    return cards, skipped


def run_engine(cards, workdir, tag, timeout):
    """Returns (records, keywords, finished_cleanly)."""
    path = os.path.join(workdir, 'cards-%s.json' % tag)
    with open(path, 'w') as f:
        json.dump(cards, f)
    try:
        proc = subprocess.run(engine_cmd() + [os.path.join(workdir, 'scripts.json'), path], cwd=ROOT,
                              capture_output=True, text=True, timeout=timeout)
        out, ok = proc.stdout, proc.returncode == 0
    except subprocess.TimeoutExpired as e:
        out, ok = (e.stdout or b''), False
        if isinstance(out, bytes):
            out = out.decode('utf-8', 'replace')
    records, keywords = [], None
    for line in out.splitlines():
        if line.startswith('@@SWEEP '):
            try:
                records.append(json.loads(line[8:]))
            except ValueError:
                ok = False
        elif line.startswith('@@KEYWORDS '):
            keywords = json.loads(line[11:])
    return records, keywords, ok


def run_chunk(args):
    cards, workdir, tag = args
    records, keywords, ok = run_engine(cards, workdir, tag, CHUNK_TIMEOUT)
    if ok:
        return records, keywords
    # The engine died or hung somewhere in this chunk. Redo it one card at a time so the
    # culprit is named and every other card still gets a result.
    records = []
    for i, c in enumerate(cards):
        recs, kw, ok1 = run_engine([c], workdir, '%s-%d' % (tag, i), CARD_TIMEOUT)
        keywords = keywords or kw
        if ok1:
            records.extend(recs)
        else:
            records.append({'name': c['name'], 'face': 0, 'layout': c.get('layout'), 'typeLine': c.get('type_line', ''),
                            'nEffects': 0, 'nonsense': [], 'sentences': [],
                            'errors': [{'stage': 'whole card', 'where': '',
                                        'msg': 'Engine hung (over %ds) or died while parsing this card' % CARD_TIMEOUT}]})
    return records, keywords


def run_sweep(cards):
    workdir = tempfile.mkdtemp(prefix='layers-sweep-')
    try:
        with open(os.path.join(workdir, 'scripts.json'), 'w') as f:
            json.dump(app_scripts(), f)
        jobs = [(cards[i:i + CHUNK], workdir, str(i // CHUNK)) for i in range(0, len(cards), CHUNK)]
        records, keywords, done, t0 = [], None, 0, time.time()
        with ThreadPoolExecutor(max_workers=max(1, (os.cpu_count() or 4) - 1)) as pool:
            for recs, kw in pool.map(run_chunk, jobs):
                records.extend(recs)
                keywords = keywords or kw
                done += 1
                sys.stderr.write('\r  %d/%d chunks, %d faces, %.0fs' % (done, len(jobs), len(records), time.time() - t0))
                sys.stderr.flush()
        sys.stderr.write('\n')
        return records, keywords or []
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def save_raw(records, keywords, meta):
    with gzip.open(RAW, 'wt', encoding='utf-8') as f:
        f.write(json.dumps({'keywords': keywords, 'meta': meta}) + '\n')
        for r in records:
            f.write(json.dumps(r) + '\n')


def load_raw():
    if not os.path.exists(RAW):
        sys.exit('No previous run at %s - run without --report first.' % RAW)
    with gzip.open(RAW, 'rt', encoding='utf-8') as f:
        head = json.loads(f.readline())
        return [json.loads(l) for l in f if l.strip()], head['keywords'], head.get('meta', {})


# ───────────────────────────── flagging sentences ─────────────────────────────

NUM_WORDS = r'(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|twenty)'
COLOR_WORDS = r'(?:white|blue|black|red|green|colorless)'
CARD_TYPES = r'(?:artifacts?|creatures?|enchantments?|lands?|planeswalkers?|battles?|instants?|sorcer(?:y|ies)|kindred)'
PLAYER_SUBJECT = (r"\b(?:you|players?|opponents?|controllers?|owners?|teammates?|team|who|he or she)"
                  r"(?:\s+each|\s+also|\s+may|\s+can't|\s+both)?\s+(?:has|have|had|gains?|loses?|lost|gets?|becomes?)\b")
# "becomes X" where X is a game state or event rather than a characteristic.
BECOMES_NOT_LAYER = (r'tapped|untapped|blocked|unblocked|the target|a target|targeted|the monarch|attached|unattached|'
                     r'renowned|monstrous|day\b|night\b|saddled|crewed|suspected|goaded|plotted|prepared|solved|'
                     r'unlocked|locked|exerted|the active|your commander|unsuspected|tapped or untapped|'
                     r'the ring-bearer|your ring-bearer|ring-bearer|plotted|foretold|phased|harnessed|a host|bored|'
                     r'the starting|the initiative|city\'s blessing|max speed|the result|part of|brilliant|'
                     r'the last|that player\'s|unprepared|no longer|or remain')


def quote_mask(text):
    """Swap every double-quoted run for the bare word QUOTED."""
    return re.sub(r'["\u201c][^"\u201d]*["\u201d]', 'QUOTED', text)


def effect_part(text):
    """The sentence with any cost or trigger condition cut off the front."""
    t = re.sub(r'^•\s*', '', text.strip())
    t = re.sub(r'^[IVX]+(?:,\s*[IVX]+)*\s*—\s*', '', t)                 # saga chapter numbers
    t = re.sub(r'^[^{\n.;:"—]{1,40}—\s*', '', t)                         # ability word / flavor word
    q = quote_mask(t)
    m = re.match(r'^(?:when(?:ever)?|at)\b[^,]*,\s*', q, re.I)
    if m:
        return q[m.end():]
    m = re.match(r'^[^.]*?:\s+', q)
    if m and 'QUOTED' not in m.group(0):
        return q[m.end():]
    return q


NEW_OBJECT = r'\bcreates?\b|\bonto the battlefield\b|\bto the battlefield\b|\breturn\b|\bmills?\b|\bexiles?\b|\bsearch\b'


def refers_to_new_objects(text, line):
    """'Create two tokens. They gain haste.' - "they" are objects the ability just made or
    moved, which the site has no permanent for, so the sentence cannot produce an effect."""
    # ("If you won, that token gains haste" - Rebellion of the Flamekin: a condition comes first.
    # Only for tokens: "If you win, those creatures gain deathtouch" - Gilt-Leaf Ambush - is read.)
    plural = re.match(r'(?:until [^,.]+, )?(?:they|those tokens|that token|those creatures|those cards)\b'
                      r'|if [^,.]+, (?:those tokens|that token)\b', text, re.I)
    # "Create a token. It has ..." - the token's own card already carries that text. A card
    # put onto the battlefield is different: it is a permanent the user can point the effect at.
    made = re.match(r"(?:(?:until [^,.]+|if you do|when you do), )?(?:it|it's|the tokens?|the copy)\b", text, re.I)
    if not plural and not made:
        return False
    before = line[:line.find(text)] if text in line else ''
    for prev in reversed([p for p in re.split(r'(?<=\.)\s+', before) if p.strip()]):
        if not plural:
            return bool(re.search(r'\bcreates?\b[^.]*\btokens?\b|\bcopy target\b', prev, re.I))
        if re.search(NEW_OBJECT, prev, re.I):
            return True
        if re.search(r'\b(?:all|each|target)\b', prev, re.I):
            return False
    return False


# Sentences the judge flags although a recipe shows the card behaves correctly: removing the
# sentence leaves an identically-shaped effect from another line. Card name -> sentence start.
VERIFIED_BY_RECIPE = {
    'Rune of Flight': 'As long as enchanted permanent is a creature',
    'Rune of Might': 'As long as enchanted permanent is a creature',
    'Rune of Mortality': 'As long as enchanted permanent is a creature',
    'Rune of Speed': 'As long as enchanted permanent is a creature',
    'Rune of Sustenance': 'As long as enchanted permanent is a creature',
    # A delayed trigger with the same effect as the enters trigger: firing that again is each death.
    'Massacre Girl': 'Whenever a creature dies this turn',
    # Offered as two options of a trigger-like choice, each a sentence written for it.
    'Aquamorph Entity': 'As this creature enters or is turned face up',
}

# Sentences about something the site has no object or step for. Card name -> words of the sentence.
OUT_OF_SCOPE = {
    # A spell, or a copy of one, gaining an ability while it is on the stack.
    'Mizzix, Replica Rider': 'If the copy is a permanent spell',
    'Nalfeshnee': 'the copy gains haste',
    'Spider-Verse': 'If the copy is a permanent spell',
    'Galea, Kindler of Hope': 'When you cast an Equipment spell this way',
    'Summon: Brynhildr': 'When you next cast a creature spell this turn',
    'The Fourteenth Doctor': 'If you do, it gains haste',
    # A reflexive trigger on casting a card out of a graveyard.
    'Havengul Lich': 'When you cast it this turn',
    # A name, a player and a counter the engine has no characteristic for.
    'Omnipresent Impostor': 'has all card names',
    "Teferi's Reproach": 'they gain protection from everything',
    'Two by Four': 'base power 4 counter',
    # Not legal in any format (an Astral card from the 1997 computer game).
    'Power Struggle': 'exchanges control of random target',
    # Not legal in any format (a Secret Lair card about toys the players own).
    'Applejack': 'If the toy has wings',
    # Two land types chosen in order by one spell.
    'Vision Charm': 'Each land of the first chosen type',
}


def classify(text, kw_re):
    """Which kind of continuous effect does this sentence read like? None if it doesn't."""
    t = effect_part(text).lower()
    # Rules about mana in a pool, and the old instant-speed Aura cleanup rule, change no permanent.
    if re.search(r'\b(?:unspent|this|that) mana\b|\bthe permanent it becomes\b', t):
        return None
    # Things the site has no model for: Alchemy's "perpetually", spells and cards outside the
    # battlefield as the subject, a life total or the value of X "becoming" a number, the Ring emblem.
    if re.search(r"\bperpetually\b|\bspell becomes\b|\bspells you control and\b|\btop card of your library has\b|"
                 r"\blife total\b[^.]*\bit becomes\b|\bvalue of x\b|\bemblem gains\b|\bonce it gains an ability\b|"
                 r"\bmodal double-faced\b", t):
        return None
    # A spell gaining an ability as it is cast ("When you cast an Equipment spell this way, it
    # gains …" - Galea; "… or cast a permanent spell from your graveyard. If you do, it gains
    # "When this permanent …"" - Serra Paragon): the site has no step for casting a spell.
    if re.search(r'\bcast (?:an? )?[a-z ]*\bspell\b[^.]*, it gains\b', t) or \
            re.match(r'if you do, it gains "(?:when|if) this permanent\b', text.strip().lower()):
        return None
    # "Those lands become the land types chosen this way" (Lydari Druid) acts on the lands on the
    # battlefield when the trigger is fired; the sweep's board has none. A recipe covers it.
    if re.search(r'\bbecome the land types chosen this way\b', t):
        return None
    # "If this spell's madness cost was paid, instead gain control of that creature if its
    # toughness is X or less" (Welcome to the Fold) changes the threshold inside the condition of
    # the control effect the sentence before it makes; effect signatures do not show conditions.
    # Recipes cover it.
    if re.search(r"\bcost was paid, instead gain control of that \w+ if its (?:power|toughness) is\b", t):
        return None
    # "Gain control of target creature until end of turn. If …, gain control of that creature
    # until the end of your next turn instead." (Evil's Thrall) restates how long the control
    # effect of the sentence before it lasts. The site has no model of durations: an effect
    # stays until its spell is removed. A recipe covers the single control effect.
    if re.search(r"\bgains? control of (?:that \w+|it|them) until [^.]*\binstead\b", t):
        return None
    # "Black and/or red permanents and spells are colorless sources of damage" (Ghostly Flame)
    # changes what a source of damage counts as, not the colour of any permanent.
    if re.search(r"\b(?:is|are) (?:a )?(?:white|blue|black|red|green|colorless) sources? of damage\b", t):
        return None
    t = re.sub(r'\bcreates?\b.*', '', t)                                 # token descriptions are not effects
    if re.search(r'\bgains? control of\b|\bexchanges? control\b', t):
        return 'control'
    t = re.sub(PLAYER_SUBJECT, ' ', t)
    # Conditions and counts talk about characteristics without changing them.
    t = re.sub(r'\b(?:as long as|if|unless|while|for each|where x is|equal to|except|instead of|rather than)\b[^,.]*', ' ', t)
    t = re.sub(r'\b(?:that|which|who)\s+(?:has|have|had|is|are|was|were|isn\'t|aren\'t|shares?|became|becomes?)\b[^,.]*', ' ', t)
    t = re.sub(r"\b(?:has|have|had)\s+(?:been|dealt|attacked|blocked|no\b|\w+ed\b|\w+ or more|the greatest|the highest|the least|less|more|fewer)[^,.]*", ' ', t)
    t = re.sub(r"\b(?:doesn't|don't|does not|do not) have\b[^,.]*", ' ', t)   # "that doesn't have the same name"
    t = re.sub(r'\bwith\b[^,.]*', ' ', t)                                # "creature with flying"
    t = re.sub(r"\bas though\b[^,.]*|\blife totals? becomes?\b[^,.]*", ' ', t)
    if re.search(r'\bgets? [+\-−](?:\d+|x)/[+\-−](?:\d+|x)', t):
        return 'gets'
    if re.search(r'\bloses? (?!(?:\d|x\b|n\b|that much|twice that much|half|life|the game|\w+ life|unspent|all unspent|priority|the flip))', t):
        return 'loses'
    if re.search(r'\bbecomes? (?!(?:%s))' % BECOMES_NOT_LAYER, t):
        return 'becomes'
    if re.search(r'\b(?:has|have|gains?) (?:(?:both |either |all of )?(?:%s)\b|quoted|base |all |protection|that ability|'
                 r'those abilities|the same|the chosen|each |every |an additional ability)' % kw_re, t):
        return 'has'
    if re.search(r'base power|power and toughness (?:are|is) each|\bswitch [^.]*power|\bdoubles? [^.]*power', t):
        return 'p/t'
    if re.search(r"in addition to (?:its|their) other(?! costs)|\b(?:is|are) (?:also |still |now )?(?:%s\b|all colors|every |all creature types|"
                 r"an? [a-z, \-]*%s\b|[a-z\-]*s? %s\b)" % (COLOR_WORDS, CARD_TYPES, CARD_TYPES), t):
        return 'is'
    return None


# ───────────────────────────── templating ─────────────────────────────

class Templater:
    def __init__(self, keywords):
        cat = json.load(open(os.path.join(ROOT, 'tests', 'type-catalog.json'), encoding='utf-8'))
        subtypes = set()
        for k, v in cat.items():
            if 'supertype' in k.lower() or k.lower() in ('cardtypes', 'card-types', 'types'):
                continue
            subtypes.update(v)
        # Structural subtypes stay readable; everything else collapses to SUBTYPE.
        keep = {'Aura', 'Equipment', 'Vehicle', 'Saga', 'Fortification', 'Room', 'Class', 'Case'}
        words = sorted((s for s in subtypes if s and s not in keep and s[0].isupper()), key=len, reverse=True)
        plural = r'(?:s|es|ren)?'
        self.subtype_re = re.compile(r"(?<![\w'])(?:%s)%s(?![\w])|\b(?:Elves|Dwarves|Wolves|Werewolves|Mice|Geese|Oxen|"
                                     r"Fungi|Sphinxes|Zombies|Pegasi|Octopi|Mercenaries|Allies|Faeries|Harpies|Efreets)\b"
                                     % ('|'.join(re.escape(w) for w in words), plural))
        kws = sorted((k for k in keywords if k), key=len, reverse=True)
        self.kw_re = '|'.join(re.escape(k.lower()) for k in kws)
        self.kw_full = re.compile(
            r"\b(?:protection from [^,.]*?(?=,| and (?:%s)\b| until|\.|$)|hexproof from [^,.]*?(?=,| until|\.|$)|"
            r"(?:ward|equip|cycling|kicker|flashback|bestow|morph|disguise|ninjutsu|crew|toxic|annihilator|afflict|"
            r"bushido|rampage|absorb|fading|vanishing|modular|renown|soulshift|fabricate|afterlife|frenzy|"
            r"poisonous|bloodthirst|graft|dredge|ripple|tribute|devour|amplify|echo|madness|escape|unearth|"
            r"evoke|suspend|buyback|entwine|replicate|prowl|outlast|scavenge|embalm|eternalize|encore|"
            r"cumulative upkeep|level up|multikicker|reinforce|transmute|mobilize|saddle|backup|bands with other|"
            r"landwalk|firebending|exhaust|warp|harmonize|station|offspring|impending|squad|blitz|casualty|"
            r"prototype|reconfigure|foretell|boast|mutate|companion|escalate|emerge|surge|awaken|dash|megamorph|"
            r"overload|miracle|undying|persist|champion an?|hideaway|recover|splice onto|forecast|haunt|"
            r"transfigure|aura swap|fortify|partner with|freerunning|plot|craft|spree|gift an?|"
            r"enchant|affinity for|[a-z]+walk|[a-z]+cycling)(?:\s*—\s*[^,.]+|\s+(?:\{cost\}|n\b|x\b)|\s+[a-z]+(?=\b))?|(?:%s))\b"
            % (self.kw_re, self.kw_re))

    def template(self, text):
        t = effect_part(text)
        t = re.sub(r'\bnamed [A-Z][^,.]*', 'named NAME', t)
        t = self.subtype_re.sub('SUBTYPE', t)
        t = t.lower().replace('−', '-')
        t = t.replace('quoted', 'QUOTED').replace('subtype', 'SUBTYPE').replace('named name', 'named NAME')
        t = re.sub(r'(?:\{[^}]+\})+', '{cost}', t)
        t = re.sub(r'\bthis (?:creature|card|permanent|artifact|enchantment|land|aura|equipment|vehicle|token|saga|'
                   r'planeswalker|battle|spell|class|case|room|spacecraft|siege)\b', 'THIS', t)
        t = re.sub(r'([+\-])(?:\d+)/([+\-])(?:\d+)\b', r'\1N/\2N', t)
        t = re.sub(r'([+\-])x/([+\-])x\b', r'\1X/\2X', t)
        t = re.sub(r'([+\-])(?:\d+|x)/([+\-])(?:\d+|x)\b', r'\1N/\2X', t)
        t = re.sub(r'[+\-]N/[+\-][NX] counters?', 'COUNTERS', t)
        t = re.sub(r'\b\d+/\d+\b', 'N/N', t)
        t = re.sub(r'\b(?:\d+|%s)\b' % NUM_WORDS, 'N', t)
        t = re.sub(r'\b(?!(?:a|an|the|more|those|that|each|of|additional|n|no|any|its|their|have|with|and|or|put|remove|'
                   r'all|many|different|other|another|kinds?)\b)[a-z\-]+ counters?\b', 'COUNTERS', t)
        t = re.sub(r'\b(?:a|an|n|x|another|additional|that many)\s+COUNTERS\b', 'COUNTERS', t)
        t = self.kw_full.sub('KEYWORD', t)
        t = re.sub(r'\b%s\b' % COLOR_WORDS, 'COLOR', t)
        t = re.sub(r'\b(?:legendary|basic|snow|world)\b', 'SUPERTYPE', t)
        t = re.sub(r'\b%s\b' % CARD_TYPES, 'TYPE', t)
        # Lists and adjacent runs of one placeholder collapse, so one keyword and three read alike.
        for ph in ('KEYWORD', 'COLOR', 'SUBTYPE', 'TYPE', 'SUPERTYPE', 'COUNTERS'):
            t = re.sub(r'%s(?:(?:,\s*(?:and\s+|or\s+|and/or\s+)?|\s+and\s+|\s+or\s+|\s+and/or\s+|\s+)%s)+' % (ph, ph), ph, t)
        t = re.sub(r'\bnon-?(TYPE|SUBTYPE|COLOR|SUPERTYPE)\b', r'non\1', t)
        t = re.sub(r'\b(?:SUPERTYPE\s+)?(?:TYPE|SUBTYPE)(?:\s+(?:TYPE|SUBTYPE))+', 'TYPE', t)
        t = re.sub(r'\ban (TYPE|SUBTYPE|COLOR|N)\b', r'a \1', t)
        t = re.sub(r'\s+', ' ', t).strip().rstrip('.')
        return t


# ───────────────────────────── report ─────────────────────────────

CTX_LABEL = {'static': 'static', 'spell': 'spell', 'trigger': 'triggered', 'activated': 'activated', 'ability': 'ability'}
KIND_LABEL = {'gets': 'gets +N/+N', 'control': 'gain control', 'loses': 'loses', 'becomes': 'becomes',
              'has': 'has / gains', 'p/t': 'power / toughness', 'is': 'is / are'}


PART_LABEL = {'clause': 'Clause', 'quoted ability': 'Quoted ability', 'keyword': 'Keyword', 'power': 'Power of +N/+N',
              'toughness': 'Toughness of +N/+N', 'base power': 'Power of N/N', 'base toughness': 'Toughness of N/N',
              'card type': 'Card type', 'subtype': 'Subtype', 'color': 'Colour'}


def load_ranks(legal=None):
    """Card name (and each face's name) -> EDHREC rank; unranked cards are absent.
    legal, when given, is filled with the names of cards legal in at least one format."""
    ranks = {}
    if not os.path.exists(CARD_CACHE):
        return ranks
    with gzip.open(CARD_CACHE, 'rt', encoding='utf-8') as f:
        for line in f:
            if legal is None and '"edhrec_rank"' not in line:
                continue
            c = json.loads(line)
            names = [c['name']] + c['name'].split(' // ')
            if legal is not None and any(v in ('legal', 'restricted') for v in (c.get('legalities') or {}).values()):
                legal.update(names)
            if c.get('edhrec_rank') is not None:
                for n in names:
                    ranks[n] = min(c['edhrec_rank'], ranks.get(n, 10 ** 9))
    return ranks


def md(s):
    return s.replace('|', '\\|').replace('\n', ' / ')


def normalize_nonsense(msg):
    msg = re.sub(r'\[\d+\]', '[i]', msg)
    msg = re.sub(r'contains ".*', 'contains the text "undefined" or "NaN"', msg)
    return msg


def analyse(records, keywords):
    tp = Templater(keywords)
    crashes = collections.defaultdict(list)       # (where, msg, stage) -> [card]
    nonsense = collections.defaultdict(list)      # message -> [card]
    clusters = {}                                 # (kind, template) -> {...}
    partial = {}                                  # (part kind, template) -> {'cards': {name: (sentence, part)}}
    totals = collections.Counter()
    for r in records:
        totals['faces'] += 1
        totals['effects'] += r.get('nEffects', 0)
        for e in r['errors']:
            crashes[(e.get('where', ''), re.sub(r'\b(?:c|trig|act|spell|perm)_\w+', '<id>', e.get('msg', '')))].append((r['name'], e.get('stage', '')))
        for n in r['nonsense']:
            nonsense[normalize_nonsense(n)].append(r['name'])
        if r['errors']:
            # A face that crashed is reported under Crashes; its sentences can't be judged.
            totals['faces_with_errors'] += 1
            continue
        for s in r['sentences']:
            totals['sentences'] += 1
            kind = classify(s['text'], tp.kw_re)
            if not kind:
                continue
            if refers_to_new_objects(s['text'], s.get('line', '')):
                totals['new_objects'] += 1
                continue
            if s['text'].startswith(VERIFIED_BY_RECIPE.get(r['name'], '\0')):
                continue
            if OUT_OF_SCOPE.get(r['name'], '\0') in s['text']:
                totals['out_of_scope'] += 1
                continue
            totals['candidates'] += 1
            if s['covered']:
                totals['candidates_covered'] += 1
                totals['probes'] += s.get('probes', 0)
                for d in s.get('dead', ()):
                    # A removed clause only counts when the clause itself reads like an effect.
                    if d['k'] == 'clause' and not classify(d['what'], tp.kw_re):
                        continue
                    totals['dead_parts'] += 1
                    key = (d['k'], tp.template(d['what'] if d['k'] == 'clause' else s['text']))
                    p = partial.setdefault(key, {'kind': key[0], 'template': key[1], 'cards': {}})
                    p['cards'].setdefault(r['name'], (s['text'], d['what']))
                continue
            key = (kind, tp.template(s['text']))
            c = clusters.setdefault(key, {'kind': kind, 'template': key[1], 'cards': {}, 'ctx': collections.Counter()})
            if r['name'] not in c['cards']:
                c['cards'][r['name']] = s['text']
                c['ctx'][s['ctx']] += 1
    return (totals, crashes, nonsense, sorted(clusters.values(), key=lambda c: (-len(c['cards']), c['template'])),
            list(partial.values()))


def write_report(records, keywords, meta):
    totals, crashes, nonsense, clusters, partial = analyse(records, keywords)
    os.makedirs(OUT_DIR, exist_ok=True)
    write_partial(partial)
    totals['subject_checks'], subject = write_subject(records)
    totals['subject_findings'] = len(subject)
    totals['subject_cards'] = len({f['card'] for f in subject})
    shared = [c for c in clusters if len(c['cards']) >= 2]
    single = [c for c in clusters if len(c['cards']) == 1]
    flagged_cards = len({n for c in clusters for n in c['cards']})
    L = []
    L.append('# Parser sweep report\n')
    L.append('Generated by `python3 tests/sweep.py` from the Scryfall oracle-cards file dated %s.\n' % meta.get('cards_updated', 'unknown'))
    L.append('| | |\n|---|---|')
    L.append('| Cards parsed | %d (%d faces) |' % (meta.get('cards', 0), totals['faces']))
    L.append('| Effects produced | %d |' % totals['effects'])
    L.append('| Sentences of rules text | %d |' % totals['sentences'])
    L.append('| Sentences that read like a continuous effect | %d |' % totals['candidates'])
    L.append('| ...of which produced an effect | %d (%.1f%%) |' % (totals['candidates_covered'], 100.0 * totals['candidates_covered'] / max(1, totals['candidates'])))
    L.append('| ...of which produced nothing | %d, on %d cards |' % (totals['candidates'] - totals['candidates_covered'], flagged_cards))
    L.append('| Not counted: "they" / "those tokens" / "it" meaning objects the ability just made | %d |' % totals['new_objects'])
    L.append('| Not counted: listed as out of scope (spells on the stack, players, names) | %d |' % totals['out_of_scope'])
    L.append('| Parts and clauses probed inside sentences that produced an effect | %d |' % totals['probes'])
    L.append('| ...of which the parser did not read | %d, on %d cards (listed in [partial.md](partial.md)) |'
             % (totals['dead_parts'], len({n for p in partial for n in p['cards']})))
    L.append('| Clusters shared by 2 or more cards | %d |' % len(shared))
    L.append('| Checks of who a sentence reaches | %d, with %d findings on %d cards (listed in [subject.md](subject.md)) |'
             % (totals['subject_checks'], totals['subject_findings'], totals['subject_cards']))
    L.append('| Single-card clusters | %d (listed in [singletons.md](singletons.md)) |' % len(single))
    L.append('| Distinct crashes | %d, on %d card faces |' % (len(crashes), totals['faces_with_errors']))
    L.append('| Distinct kinds of nonsense output | %d |' % len(nonsense))
    L.append('')
    L.append('How a sentence is judged: the card is parsed, then parsed again with that one sentence removed. '
             'If the effects are identical both times, the sentence produced nothing. Sentences inside triggered '
             'and activated abilities are judged by firing the ability the way the site\'s ability popup does.\n')

    L.append('## 1. Crashes\n')
    if not crashes:
        L.append('None.\n')
    else:
        L.append('| Cards | Where | Error | While | Examples |\n|---:|---|---|---|---|')
        for (where, msg), hits in sorted(crashes.items(), key=lambda kv: -len({n for n, _ in kv[1]})):
            u = sorted({n for n, _ in hits})
            stages = ', '.join(k for k, _ in collections.Counter(st for _, st in hits).most_common(3))
            L.append('| %d | `%s` | %s | %s | %s |' % (len(u), where or '?', md(msg), stages, md(', '.join(u[:5]))))
        L.append('')

    L.append('## 2. Nonsense output\n')
    if not nonsense:
        L.append('None.\n')
    else:
        L.append('| Cards | Problem | Examples |\n|---:|---|---|')
        for msg, names in sorted(nonsense.items(), key=lambda kv: -len(set(kv[1]))):
            u = sorted(set(names))
            L.append('| %d | %s | %s |' % (len(u), md(msg), md(', '.join(u[:6]))))
        L.append('')

    L.append('## 3. Sentences that produced no effect, by template\n')
    L.append('Ranked by how many cards share the wording. Placeholders: `N` number, `KEYWORD`, `TYPE` card type, '
             '`SUBTYPE`, `SUPERTYPE`, `COLOR`, `COUNTERS`, `THIS` the card itself, `QUOTED` a quoted ability, '
             '`{cost}` mana symbols. Costs and trigger conditions are cut off the front.\n')
    L.append('| # | Cards | Reads like | Template | Where | Examples |\n|---:|---:|---|---|---|---|')
    for i, c in enumerate(shared, 1):
        ctx = ', '.join('%s %d' % (CTX_LABEL.get(k, k), v) for k, v in c['ctx'].most_common())
        names = sorted(c['cards'])
        L.append('| %d | %d | %s | `%s` | %s | %s |' % (i, len(names), KIND_LABEL[c['kind']], md(c['template']), ctx, md(', '.join(names[:4]))))
    L.append('')
    with open(os.path.join(OUT_DIR, 'report.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(L))

    S = ['# Parser sweep: single-card templates\n',
         'Sentences that read like a continuous effect, produced no effect, and whose wording no other card shares. '
         'See [report.md](report.md) for the shared clusters.\n',
         '| Card | Reads like | Where | Sentence |\n|---|---|---|---|']
    for c in sorted(single, key=lambda c: (c['kind'], sorted(c['cards'])[0])):
        name, text = next(iter(c['cards'].items()))
        S.append('| %s | %s | %s | %s |' % (md(name), KIND_LABEL[c['kind']], CTX_LABEL.get(next(iter(c['ctx'])), ''), md(text)))
    with open(os.path.join(OUT_DIR, 'singletons.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(S) + '\n')

    # Full membership of every cluster, for digging into one.
    with open(os.path.join(OUT_DIR, 'clusters.json'), 'w', encoding='utf-8') as f:
        json.dump([{'cards': len(c['cards']), 'kind': c['kind'], 'template': c['template'],
                    'members': c['cards']} for c in clusters], f, indent=1, ensure_ascii=False)
    return totals, crashes, nonsense, clusters, partial


def write_partial(partial):
    """tests/sweep/partial.md: parts of effect-producing sentences that the parser did not read."""
    ranks = load_ranks()
    rank = lambda n: ranks.get(n, 10 ** 9)
    for p in partial:
        p['names'] = sorted(p['cards'], key=lambda n: (rank(n), n))
    partial.sort(key=lambda p: (-len(p['names']), rank(p['names'][0]), p['template']))
    shared = [p for p in partial if len(p['names']) >= 2]
    single = sorted((p for p in partial if len(p['names']) == 1), key=lambda p: (rank(p['names'][0]), p['names'][0]))
    P = ['# Parser sweep: parts of a sentence the parser did not read\n',
         'Generated by `python3 tests/sweep.py`. Each sentence here produced an effect, so [report.md](report.md) does '
         'not list it, but one part of it made no difference: swapping that part for another of its kind (a number, '
         'a keyword, a quoted ability, a type, a colour), or removing that clause, left the parsed effects exactly the '
         'same. Either the parser dropped the part, or it reads it somewhere the effect signature does not show '
         '(a condition, a filter, a choice the site asks for) - check the card before fixing.\n',
         '## Shared by 2 or more cards\n',
         'Ranked by number of cards; examples are the most-played cards first (EDHREC rank).\n',
         '| # | Cards | Part | Template | Most-played examples (the part not read) |\n|---:|---:|---|---|---|']
    for i, p in enumerate(shared, 1):
        ex = '; '.join('%s (%s)' % (n, p['cards'][n][1]) for n in p['names'][:4])
        P.append('| %d | %d | %s | `%s` | %s |' % (i, len(p['names']), PART_LABEL[p['kind']], md(p['template']), md(ex)))
    P.append('\n## Single cards\n')
    P.append('Most-played first.\n')
    P.append('| EDHREC rank | Card | Part not read | Sentence |\n|---:|---|---|---|')
    for p in single:
        n = p['names'][0]
        text, what = p['cards'][n]
        P.append('| %s | %s | %s: %s | %s |' % (ranks.get(n, ''), md(n), PART_LABEL[p['kind']], md(what), md(text)))
    with open(os.path.join(OUT_DIR, 'partial.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(P) + '\n')
    with open(os.path.join(OUT_DIR, 'partial-clusters.json'), 'w', encoding='utf-8') as f:
        json.dump([{'cards': len(p['names']), 'part': p['kind'], 'template': p['template'],
                    'members': {n: {'sentence': p['cards'][n][0], 'part': p['cards'][n][1], 'rank': ranks.get(n)}
                                for n in p['names']}} for p in partial], f, indent=1, ensure_ascii=False)


SUBJECT_VERDICTS = ('ok', 'unread', 'wrong side', 'inert', 'error')
SUBJECT_FOUND = ('unread', 'wrong side', 'error')
SUBJECT_LABEL = {'controller': 'Controller', 'other': '"Other"', 'color': 'Colour', 'card type': 'Card type',
                 'subtype': 'Subtype', 'token': 'Token', 'legendary': 'Legendary', 'has keyword': 'With keyword',
                 'size': 'Power / toughness N', 'error': 'Error'}


def subject_label(k):
    return 'Whose permanents' if k.startswith('side') else SUBJECT_LABEL.get(k, k)


def write_subject(records):
    """tests/sweep/subject.md: sentences that reach the wrong permanents on the witness board."""
    legal = set()
    ranks = load_ranks(legal)
    tally, cards, findings, not_legal = collections.Counter(), set(), [], set()
    for r in records:
        for s in r.get('subject', ()):
            cards.add(r['name'])
            for row in s['rows']:
                k = 'side' if row['k'].startswith('side') else row['k']
                tally[(k, row['verdict'])] += 1
                if row['verdict'] not in SUBJECT_FOUND:
                    continue
                if legal and r['name'] not in legal:
                    not_legal.add(r['name'])
                    continue
                findings.append({'card': r['name'], 'rank': ranks.get(r['name']), 'where': s['ctx'], 'sentence': s['text'],
                                 'check': row['k'], 'word': row.get('what', ''), 'verdict': row['verdict'],
                                 'reaches': row.get('hit'), 'tried': row.get('tried'), 'reaches_after': row.get('hitAfter'),
                                 'error': row.get('msg')})
    findings.sort(key=lambda f: (f['rank'] is None, f['rank'] or 0, f['card'], f['sentence']))
    kinds = sorted({k for k, _ in tally}, key=lambda k: (k != 'side', k))
    total = sum(tally.values())
    S = ['# Parser sweep: who a sentence reaches\n',
         'Generated by `python3 tests/sweep.py`. Each card is added last to a two-player board holding the same 16 '
         'blank witnesses on each side (ten creatures of different types and colours, a creature token, an Equipment, '
         'a Treasure token, a Shrine, a Forest and a nonbasic land). A sentence whose subject is a group of permanents '
         'is judged by which witnesses change, against the same text with that sentence (or that subject\'s clause) '
         'taken out. "You control" must reach nothing of the opponent\'s, "your opponents control" nothing of yours, '
         'and a subject that names no controller must reach both sides alike. Then each word of the subject is swapped '
         'for another of its kind: a word is **unread** when no swap of it changes who is affected. A check is '
         '**inert** when the sentence reaches no witness (the board has no counters, attackers, chosen types or '
         'unpicked modes), or when the card itself is not one of the group "other" leaves it out of; an inert check '
         'says nothing either way. A finding means "check this card".\n',
         '%d checks on %d cards; %d findings on %d cards.%s\n' % (
             total, len(cards), len(findings), len({f['card'] for f in findings}),
             ' Left out: %d cards legal in no format.' % len(not_legal) if not_legal else ''),
         '| Check | ' + ' | '.join(v.capitalize() for v in SUBJECT_VERDICTS) + ' |',
         '|---|' + '---:|' * len(SUBJECT_VERDICTS)]
    for k in kinds:
        S.append('| %s | %s |' % (subject_label(k), ' | '.join(str(tally[(k, v)]) for v in SUBJECT_VERDICTS)))
    S.append('| **All** | %s |' % ' | '.join(str(sum(tally[(k, v)] for k in kinds)) for v in SUBJECT_VERDICTS))
    S.append('\n## Findings\n')
    if not findings:
        S.append('None.')
    else:
        S.append('Most-played first.\n')
        S.append('| EDHREC rank | Card | Finding | Sentence | Reaches | Swap that changed nothing |\n|---:|---|---|---|---|---|')
        for f in findings:
            what = ('Error: %s' % f['error']) if f['verdict'] == 'error' else \
                '%s, %s: %s' % (f['verdict'].capitalize(), subject_label(f['check']).lower(), f['word'])
            S.append('| %s | %s | %s | %s | %s | %s |' % (f['rank'] or '', md(f['card']), md(what), md(f['sentence']),
                                                    md(f['reaches'] or ''), md(f['tried'] or '')))
    with open(os.path.join(OUT_DIR, 'subject.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(S) + '\n')
    with open(os.path.join(OUT_DIR, 'subject-findings.json'), 'w', encoding='utf-8') as f:
        json.dump(findings, f, indent=1, ensure_ascii=False)
    return total, findings


def cmd_diff(before_path):
    """Which cards parse differently now than in a saved copy of an earlier run?"""
    def index(path):
        with gzip.open(path, 'rt', encoding='utf-8') as f:
            f.readline()
            return {(r['name'], r['face']): r for r in map(json.loads, f)}
    old, new = index(before_path), index(RAW)
    changed = 0
    for key in sorted(new):
        a, b = old.get(key), new[key]
        if a is None or a.get('fx') is None or b.get('fx') is None:
            continue
        fa, fb = collections.Counter(a['fx']), collections.Counter(b['fx'])
        if fa == fb and bool(a['errors']) == bool(b['errors']):
            continue
        changed += 1
        print('%s%s' % (key[0], '  (crash state changed)' if bool(a['errors']) != bool(b['errors']) else ''))
        for l in sorted((fa - fb).elements()):
            print('    - ' + l[:230])
        for l in sorted((fb - fa).elements()):
            print('    + ' + l[:230])
    print('%d card faces parse differently' % changed)
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--report', action='store_true', help='Rebuild the report from the last run without re-parsing')
    ap.add_argument('--only', nargs='+', metavar='NAME', help='Sweep only these cards and print the result')
    ap.add_argument('--limit', type=int, help='Sweep only the first N cards')
    ap.add_argument('--diff', metavar='RAW', help='List cards whose parsed effects differ from a saved copy of an '
                    'earlier run (copy %s aside before changing the parser)' % RAW)
    args = ap.parse_args()

    if args.diff:
        return cmd_diff(args.diff)

    if args.only:
        cards, _ = load_cards(only=set(args.only))
        records, keywords = run_sweep(cards)
        tp = Templater(keywords)
        for r in records:
            print('%s  [%s]  %d effects' % (r['name'], r['typeLine'], r['nEffects']))
            for e in r['errors']:
                print('   CRASH   %s: %s (%s)' % (e['stage'], e['msg'], e['where']))
            for n in r['nonsense']:
                print('   NONSENSE %s' % n)
            for s in r['sentences']:
                kind = classify(s['text'], tp.kw_re)
                mark = 'ok     ' if s['covered'] else ('FLAGGED' if kind else 'nothing')
                print('   %s %-9s %s' % (mark, s['ctx'], s['text']))
                if kind and not s['covered']:
                    print('           template: %s' % tp.template(s['text']))
                for d in s.get('dead', ()):
                    if kind and (d['k'] != 'clause' or classify(d['what'], tp.kw_re)):
                        print('           NOT READ  %s: %s' % (PART_LABEL[d['k']].lower(), d['what']))
                        print('                     same effects from: %s' % d.get('tried', ''))
            for s in r.get('subject', ()):
                print('   WHO     %-9s %s' % (s['ctx'], s['text']))
                for row in s['rows']:
                    found = row['verdict'] in SUBJECT_FOUND
                    print('           %-10s %s: %s' % (row['verdict'].upper() if found else row['verdict'],
                                                      subject_label(row['k']).lower(), row.get('what', '')))
                    print('                      reaches: %s' % row.get('hit', row.get('msg', '')))
                    if row.get('tried'):
                        print('                      swapped: %s' % row['tried'])
                        print('                      reaches: %s' % row.get('hitAfter', ''))
        return 0

    if args.report:
        records, keywords, meta = load_raw()
    else:
        cards, skipped = load_cards(limit=args.limit)
        print('Sweeping %d cards (skipped: %s)' % (len(cards), ', '.join('%d %s' % (v, k) for k, v in skipped.most_common()) or 'none'))
        records, keywords = run_sweep(cards)
        meta = {'cards': len(cards)}
        try:
            meta['cards_updated'] = json.load(open(os.path.join(CACHE_DIR, 'bulk-meta.json')))['updated_at'][:10]
        except (OSError, KeyError, ValueError):
            pass
        save_raw(records, keywords, meta)
    totals, crashes, nonsense, clusters, partial = write_report(records, keywords, meta)
    print('%d faces, %d candidate sentences, %d produced nothing' % (totals['faces'], totals['candidates'], totals['candidates'] - totals['candidates_covered']))
    print('%d crashes, %d kinds of nonsense, %d clusters (%d shared by 2+ cards)' % (
        len(crashes), len(nonsense), len(clusters), sum(1 for c in clusters if len(c['cards']) >= 2)))
    print('%d parts probed inside effect-producing sentences, %d not read (%d clusters)' % (
        totals['probes'], totals['dead_parts'], len(partial)))
    print('%d checks of who a sentence reaches, %d findings on %d cards' % (
        totals['subject_checks'], totals['subject_findings'], totals['subject_cards']))
    print('Wrote tests/sweep/report.md, singletons.md, clusters.json, partial.md, partial-clusters.json, subject.md, '
          'subject-findings.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
