"""The automatic update of every subtype list, from Scryfall's data.

`python3 tests/run.py --catalog` (the step after a card refresh) calls update():
  1. reads the card file and Scryfall's type catalogs (the saved copy in tests/cards/ when
     Scryfall cannot be reached)
  2. works out the official subtypes of every card type with the site's own cards-types.js
  3. rewrites the RULES-LISTS block in data.js, and saves what it found, with the card that
     shows each type to be real, in tests/rules/scryfall-types.json

Nothing is written when a result looks wrong: a type would be dropped (pass
--allow-removals once Scryfall's own change has been looked at), the card file is older
than the lists, or a word is not shaped like a type.

Between refreshes the site adds new types itself (updateTypesFromScryfall in cards-types.js).
"""
import gzip
import json
import os
import re
import subprocess
import tempfile
import time

import rules

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data.js')
FOUND = os.path.join(ROOT, 'tests', 'rules', 'scryfall-types.json')
CATALOGS = os.path.join(ROOT, 'tests', 'cards', 'type-catalogs.json')
RULE = {'artifact': 'g', 'enchantment': 'h', 'land': 'i', 'planeswalker': 'j', 'spell': 'k',
        'planar': 'n', 'dungeon': 'p', 'battle': 'q'}
CARD_FIELDS = ('name', 'layout', 'type_line', 'oracle_text', 'set_type', 'border_color', 'security_stamp',
               'released_at', 'digital')
# These are written into code that runs on the site, and into its HTML.
OFFICIAL_SHAPE = re.compile(r"^(?=\S)[^\W\d_](?:[^\W\d_]|['\- ]){0,47}$")
UNOFFICIAL_SHAPE = re.compile(r"^[^\W\d_][\w .,?!'\-]{0,79}$")


def _read_cards(path):
    """The card file, less what deriveSubtypes does not look at."""
    cards = []
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            c = json.loads(line)
            d = {k: c[k] for k in CARD_FIELDS if c.get(k)}
            d['legalities'] = {k: v for k, v in (c.get('legalities') or {}).items()
                               if k in ('vintage', 'legacy', 'commander') and v != 'not_legal'}
            if 'playtest' in (c.get('promo_types') or []):
                d['promo_types'] = ['playtest']
            tokens = [{'component': 'token', 'type_line': p.get('type_line')}
                      for p in c.get('all_parts') or [] if p.get('component') == 'token']
            if tokens:
                d['all_parts'] = tokens
            if c.get('card_faces'):
                d['card_faces'] = [{k: face.get(k) for k in ('name', 'type_line', 'oracle_text')} for face in c['card_faces']]
            cards.append(d)
    return cards


def _catalogs():
    """Scryfall's type catalogs now, else those saved with the last update."""
    try:
        got = {}
        for kind in rules.SCRYFALL:
            got[kind] = sorted(json.loads(rules._curl('https://api.scryfall.com/catalog/%s-types' % kind))['data'])
            if not got[kind]:
                raise ValueError('the %s catalog is empty' % kind)
            time.sleep(0.1)
        return got, None, True
    except (IOError, ValueError, KeyError) as e:
        if not os.path.exists(CATALOGS):
            raise RuntimeError("Scryfall's type catalogs cannot be reached and none are saved: %s" % e)
        with open(CATALOGS, encoding='utf-8') as f:
            saved = json.load(f)
        return saved['catalogs'], "Scryfall's type catalogs were not reached; used those saved on %s" % saved['fetched'], False


def derive(engine, cards, catalogs, known, today):
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    scripts = [s for s in re.findall(r'<script src="([^"?]+)', html)
               if not s.startswith('http') and (not s.startswith('ui-') or s == 'ui-helpers.js')]
    names = []
    try:
        for content in (scripts, {'cards': cards, 'catalogs': catalogs, 'known': known, 'today': today}):
            with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
                json.dump(content, f)
                names.append(f.name)
        r = subprocess.run([engine, 'tests/subtypes.js', '--'] + names, cwd=ROOT, capture_output=True, text=True, timeout=180)
    finally:
        for n in names:
            os.unlink(n)
    for line in r.stdout.split('\n'):
        if line.startswith('@@SUBTYPES '):
            return json.loads(line[11:])
    raise RuntimeError('tests/subtypes.js printed nothing:\n%s\n%s' % (r.stdout[-1500:], r.stderr[-1500:]))


def _unofficial(official, seen, before):
    """Every other subtype: those listed before and those on Scryfall's cards and catalogs."""
    out = {}
    for kind in official:
        had = set(before.get(kind, []))
        # A type of several words is kept whole; the card lines show it as separate words.
        in_phrase = {w for t in had if ' ' in t for w in t.split()}
        others = set(official[kind])
        if kind != 'planar':
            for other in official:
                if other != kind and other != 'planar':
                    others |= set(official[other])
        out[kind] = sorted((had | (set(seen[kind]) - in_phrase)) - others)
    return out


def _wrap(items, indent):
    lines, line = [], ''
    for t in items:
        piece = json.dumps(t, ensure_ascii=False) + ', '
        if line and len(indent + line + piece) > 100:
            lines.append(indent + line.rstrip())
            line = ''
        line += piece
    if line:
        lines.append(indent + line.rstrip(', '))
    return '\n'.join(lines)


def data_with_lists(src, as_of, official, unofficial):
    """data.js's text with its generated lists replaced."""
    def put(begin, end, body):
        nonlocal src
        a = src.index(begin) + len(begin)
        b = src.index(end, a)
        src = src[:a] + body + src[b:]

    put("  typesAsOf: '", "',", as_of)
    put('  officialSubtypes: {\n', '\n  },', '\n'.join(
        '    // CR 205.3%s\n    %s: new Set([\n%s\n    ]),' % (RULE[k], k, _wrap(sorted(official[k]), '      ')) for k in RULE))

    def short(kind):
        items = unofficial[kind]
        if len(items) > 6:
            return '    %s: new Set([\n%s\n    ]),' % (kind, _wrap(items, '      '))
        return '    %s: new Set([%s]),' % (kind, ', '.join(json.dumps(t, ensure_ascii=False) for t in items))

    put('  unofficialSubtypes: {\n', '\n  },', '\n'.join(short(k) for k in RULE))
    put('  officialCreatureTypes: new Set([\n', '\n  ]),', _wrap(sorted(official['creature']), '    '))
    put('  silverCreatureTypes: new Set([\n', '\n  ]),', _wrap(unofficial['creature'], '    '))
    return src


def update(engine, card_file, meta_file, allow_removals=False):
    """Returns (problems, notes, the types added or removed). data.js is rewritten only when
    there is no problem."""
    problems, notes, changed = [], [], set()
    try:
        with open(meta_file, encoding='utf-8') as f:
            as_of = json.load(f)['updated_at'][:10]
        src = open(DATA, encoding='utf-8').read()
        was_as_of = re.search(r"^  typesAsOf: '([^']*)',", src, re.M).group(1)
        if as_of < was_as_of:
            return ['The card file (%s) is older than the lists (%s): the lists were left as they are' % (as_of, was_as_of)], notes, changed
        catalogs, said, live = _catalogs()
        if said:
            notes.append(said)
        now = rules.site(engine)
        cards = _read_cards(card_file)
        found = derive(engine, cards, catalogs, now['official'], as_of)
    except (IOError, ValueError, KeyError, AttributeError, RuntimeError) as e:
        return ['The update from Scryfall could not run: %s: %s' % (type(e).__name__, e)], notes, changed

    official = found['official']
    unofficial = _unofficial(official, found['seen'], now['unofficial'])
    for kind in sorted(official):
        gone = set(now['official'].get(kind, [])) - set(official[kind])
        if gone and not allow_removals:
            problems.append("Scryfall's data no longer shows these %s types to be official: %s. If that is right, run again"
                            ' with --allow-removals' % (kind, ', '.join(sorted(gone))))
        elif gone:
            notes.append('Removed %s types: %s' % (kind, ', '.join(sorted(gone))))
        changed |= gone | (set(official[kind]) - set(now['official'].get(kind, [])))
        for t in sorted(set(official[kind]) - set(now['official'].get(kind, []))):
            why = official[kind][t]
            notes.append('New %s type from Scryfall: %s (%s, %s, %s)' % (kind, t, why['how'], why['name'], why['date']))
        for t in official[kind]:
            if not OFFICIAL_SHAPE.match(t) or not t[0].isupper():
                problems.append('Not shaped like a %s type: %r' % (kind, t))
        for t in unofficial[kind]:
            if not UNOFFICIAL_SHAPE.match(t) or '*/' in t:
                problems.append('Not shaped like an unofficial %s type: %r' % (kind, t))
    for word, name in sorted(found['unknownTypeWords'].items()):
        problems.append('"%s" on %s is no card type or supertype the site knows (a new one needs code in data.js)' % (word, name))
    # A changeling also has these, with the Silver border switch on.
    changed |= set(unofficial['creature']) ^ set(now['unofficial']['creature'])
    if problems:
        return problems + ['Nothing was written: the lists are as they were'], notes, set()

    with open(DATA, 'w', encoding='utf-8') as f:
        f.write(data_with_lists(src, as_of, official, unofficial))
    with open(FOUND, 'w', encoding='utf-8') as f:
        json.dump({'asOf': as_of, 'subtypes': official}, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write('\n')
    if live:
        with open(CATALOGS, 'w', encoding='utf-8') as f:
            json.dump({'fetched': time.strftime('%Y-%m-%d'), 'catalogs': catalogs}, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.write('\n')
    print("Subtype lists from Scryfall's data of %s: %s" % (
        as_of, ', '.join('%d %s' % (len(v), k) for k, v in sorted(official.items()))))
    return problems, notes, changed
