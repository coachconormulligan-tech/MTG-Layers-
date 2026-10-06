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


def slim(card):
    c = {k: card[k] for k in CARD_FIELDS if k in card}
    if card.get('card_faces'):
        c['card_faces'] = [{k: f[k] for k in CARD_FIELDS if k in f} for f in card['card_faces']]
    return c


def load_cards(only=None, limit=None):
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
                    cards.append(slim(c))
                continue
            if c.get('layout') in SKIP_LAYOUTS:
                skipped['layout ' + c['layout']] += 1
            elif c.get('set_type') in SKIP_SET_TYPES:
                skipped['set type ' + c['set_type']] += 1
            elif c['name'].startswith('A-'):
                skipped['alchemy rebalance'] += 1
            else:
                cards.append(slim(c))
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
                     r'the last|that player\'s')


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
    plural = re.match(r'(?:until [^,.]+, )?(?:they|those tokens|that token|those creatures|those cards)\b', text, re.I)
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


def classify(text, kw_re):
    """Which kind of continuous effect does this sentence read like? None if it doesn't."""
    t = effect_part(text).lower()
    # Rules about mana in a pool, and the old instant-speed Aura cleanup rule, change no permanent.
    if re.search(r'\b(?:unspent|this|that) mana\b|\bthe permanent it becomes\b', t):
        return None
    t = re.sub(r'\bcreates?\b.*', '', t)                                 # token descriptions are not effects
    if re.search(r'\bgains? control of\b|\bexchanges? control\b', t):
        return 'control'
    t = re.sub(PLAYER_SUBJECT, ' ', t)
    # Conditions and counts talk about characteristics without changing them.
    t = re.sub(r'\b(?:as long as|if|unless|while|for each|where x is|equal to|except|instead of|rather than)\b[^,.]*', ' ', t)
    t = re.sub(r'\b(?:that|which|who)\s+(?:has|have|had|is|are|was|were|isn\'t|aren\'t|shares?|became|becomes?)\b[^,.]*', ' ', t)
    t = re.sub(r"\b(?:has|have|had)\s+(?:been|dealt|attacked|blocked|no\b|\w+ed\b|\w+ or more|the greatest|the highest|the least|less|more|fewer)[^,.]*", ' ', t)
    t = re.sub(r'\bwith\b[^,.]*', ' ', t)                                # "creature with flying"
    t = re.sub(r"\bas though\b[^,.]*|\blife totals? becomes?\b[^,.]*", ' ', t)
    if re.search(r'\bgets? [+\-−](?:\d+|x)/[+\-−](?:\d+|x)', t):
        return 'gets'
    if re.search(r'\bloses? (?!(?:\d|x\b|n\b|that much|half|life|the game|\w+ life|unspent|all unspent|priority|the flip))', t):
        return 'loses'
    if re.search(r'\bbecomes? (?!(?:%s))' % BECOMES_NOT_LAYER, t):
        return 'becomes'
    if re.search(r'\b(?:has|have|gains?) (?:(?:both |either |all of )?(?:%s)\b|quoted|base |all |protection|that ability|'
                 r'those abilities|the same|the chosen|each |every |an additional ability)' % kw_re, t):
        return 'has'
    if re.search(r'base power|power and toughness (?:are|is) each|\bswitch [^.]*power|\bdoubles? [^.]*power', t):
        return 'p/t'
    if re.search(r"in addition to (?:its|their) other|\b(?:is|are) (?:also |still |now )?(?:%s\b|all colors|every |all creature types|"
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
            totals['candidates'] += 1
            if s['covered']:
                totals['candidates_covered'] += 1
                continue
            key = (kind, tp.template(s['text']))
            c = clusters.setdefault(key, {'kind': kind, 'template': key[1], 'cards': {}, 'ctx': collections.Counter()})
            if r['name'] not in c['cards']:
                c['cards'][r['name']] = s['text']
                c['ctx'][s['ctx']] += 1
    return totals, crashes, nonsense, sorted(clusters.values(), key=lambda c: (-len(c['cards']), c['template']))


def write_report(records, keywords, meta):
    totals, crashes, nonsense, clusters = analyse(records, keywords)
    os.makedirs(OUT_DIR, exist_ok=True)
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
    L.append('| Clusters shared by 2 or more cards | %d |' % len(shared))
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
    return totals, crashes, nonsense, clusters


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
    totals, crashes, nonsense, clusters = write_report(records, keywords, meta)
    print('%d faces, %d candidate sentences, %d produced nothing' % (totals['faces'], totals['candidates'], totals['candidates'] - totals['candidates_covered']))
    print('%d crashes, %d kinds of nonsense, %d clusters (%d shared by 2+ cards)' % (
        len(crashes), len(nonsense), len(clusters), sum(1 for c in clusters if len(c['cards']) >= 2)))
    print('Wrote tests/sweep/report.md, tests/sweep/singletons.md, tests/sweep/clusters.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
