"""Every subtype list on the site, checked.

tests/run.py calls check() on every run (no network):
  - every list in data.js is what the last update worked out from Scryfall's data
    (tests/rules/scryfall-types.json, written by tests/subtypes.py), and that agrees with
    the rules last saved (tests/rules/cr-205.json): a difference is allowed only for a
    type newer than those rules
  - the engine, the parser and the choice boxes really use those lists, whatever Scryfall's
    catalogs say and when Scryfall cannot be reached (asked of the scripts by tests/rules.js)
  - tests/type-catalog.json, the tests' stand-in for the site's lists, agrees with them
  - no other file keeps a copy of a subtype list of its own
  - a subtype nobody has heard of, of any card type and any shape, works from its card alone
    with no refresh of the data (tests/newtypes.js)

The lists are updated from Scryfall alone (`python3 tests/run.py --catalog`, and the site
itself at startup). `python3 tests/run.py --rules` is an optional second opinion: it saves
the current Comprehensive Rules' lists and compares. It changes no list on the site.
`--rules FILE` reads a rules .txt saved by hand.

When a check fails, run --catalog or correct the code: never a saved snapshot, and never by
excusing a word without seeing on Scryfall's cards why it is there.
"""
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPSHOT = os.path.join(ROOT, 'tests', 'rules', 'cr-205.json')
FOUND = os.path.join(ROOT, 'tests', 'rules', 'scryfall-types.json')
CATALOG = os.path.join(ROOT, 'tests', 'type-catalog.json')
RULES_PAGE = 'https://magic.wizards.com/en/rules'
RULES_FILE = re.compile(r'https://media\.wizards\.com/\d{4}/downloads/MagicCompRules[^"<>\\]*?(\d{8})\.txt')
SCRYFALL = ('creature', 'artifact', 'enchantment', 'land', 'planeswalker', 'spell', 'battle')
RULES_LEAD_DAYS = 10     # the rules come out about a week before a set is legal


# ---- reading the rules ----

def _items(text):
    """'A (see rule 1), B, and C.' -> ['A', 'B', 'C']"""
    text = re.sub(r'\s*\([^)]*\)', '', text).strip().rstrip('.')
    if ',' not in text:     # a list of one or two: "A and B"
        return [part.strip() for part in text.split(' and ') if part.strip()]
    return [re.sub(r'^and ', '', part.strip()) for part in text.split(',') if part.strip()]


def _title(words):
    return [w[:1].upper() + w[1:] for w in words]


def extract(text):
    """The lists of CR 205 from the rules' text. Rules are found by their words rather than
    their letters, which move. Raises ValueError for anything it does not understand: a
    subtype rule it cannot read is a new kind of subtype, and must not be passed over."""
    text = text.replace('﻿', '').replace('’', "'").replace('\r', '')

    def one(pattern, what):
        m = re.search(pattern, text, re.M)
        if not m:
            raise ValueError('Cannot find %s in the rules text' % what)
        return m

    date = one(r'^These rules are effective as of (\w+ \d{1,2}, \d{4})', 'the effective date').group(1)
    out = {
        'effective': time.strftime('%Y-%m-%d', time.strptime(date, '%B %d, %Y')),
        'cardTypes': _title(_items(one(r'^205\.2a The card types are (.+?)\. ', 'the card types').group(1))),
        'supertypes': _title(_items(one(r'^205\.4a .*The supertypes are (.+?)\.\s*$', 'the supertypes').group(1))),
        'basicLandTypes': _items(one(r'^305\.\d+\.? The basic land types are (.+?)\. ', 'the basic land types').group(1)),
        'outlaws': _items(re.sub(r',? and/or ', ', ', one(
            r'^700\.\d+\.? The term outlaw refers to an object that has the (.+?) creature types', 'outlaws').group(1))),
    }
    subtypes, without = {}, None
    for line in re.findall(r'^205\.3[a-z] .+$', text, re.M):
        line = line.strip()
        none = re.search(r'^205\.3[a-z] (.+) cards have no subtypes\.$', line)
        if none:
            without = _title([re.sub(r' cards$', '', x) for x in _items(none.group(1) + ' cards')])
            continue
        called = re.search(r'\bcalled (?:an? )?(\w+) types?\.', line)
        if not called:
            continue
        kind = called.group(1)
        rest = line[called.end():]
        single = re.search(r'That %s type is ([^.]+)\.' % kind, rest)
        split = re.search(r'One %s type is two words long: ([^.]+)\. All other %s types are one word long: (.+)' % (kind, kind), rest)
        many = re.search(r'The %s types are (.+?)\.(?=\s+[A-Z]|\s*$)' % kind, rest)
        if single:
            found = [single.group(1)]
        elif split:
            found = _items(split.group(2)) + [split.group(1)]
        elif many:
            found = _items(many.group(1))
        else:
            raise ValueError('Cannot read the %s types: %s' % (kind, line[:120]))
        for t in found:
            # CR 205.3b: one word each, but for planes and the creature type named as two.
            if ' ' in t and kind != 'planar' and not (split and t == split.group(1)):
                raise ValueError('"%s" read as one %s type: the rule\'s wording has changed' % (t, kind))
        subtypes[kind] = sorted(found)
    if without is None:
        raise ValueError('Cannot find the card types that have no subtypes')
    missing = {'artifact', 'enchantment', 'land', 'planeswalker', 'spell', 'creature', 'planar', 'dungeon', 'battle'} - set(subtypes)
    if missing:
        raise ValueError('Cannot find a subtype rule for: %s' % ', '.join(sorted(missing)))
    out['noSubtypes'] = without
    out['subtypes'] = subtypes
    return out


def _curl(url):
    r = subprocess.run(['curl', '-sSfL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '30',
                        '-A', 'LayerInspector/1.0', '-H', 'Accept: */*', url], capture_output=True)
    if r.returncode:
        raise IOError(r.stderr.decode('utf-8', 'replace').strip() or 'curl failed')
    return r.stdout.decode('utf-8', 'replace')


def _download():
    links = {m.group(1): m.group(0) for m in RULES_FILE.finditer(_curl(RULES_PAGE))}
    if not links:
        raise IOError('No rules .txt link on %s' % RULES_PAGE)
    url = urllib.parse.quote(links[max(links)], safe=':/')
    return _curl(url), url


def snapshot():
    with open(SNAPSHOT, encoding='utf-8') as f:
        return json.load(f)


# ---- what the site uses ----

def site(engine):
    return _ask(engine, 'tests/rules.js', '@@RULES ')


def new_types(engine):
    """What is not figured out about a subtype nobody has heard of (tests/newtypes.js)."""
    return _ask(engine, 'tests/newtypes.js', '@@NEWTYPES ')


def _ask(engine, script, mark):
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    scripts = re.findall(r'<script src="([^"?]+)', html)
    # As tests/harness.js: every non-UI script, and ui-helpers.js.
    scripts = [s for s in scripts if not s.startswith('http') and (not s.startswith('ui-') or s == 'ui-helpers.js')]
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as tf:
        json.dump(scripts, tf)
    try:
        r = subprocess.run([engine, script, '--', tf.name], cwd=ROOT, capture_output=True, text=True, timeout=60)
    finally:
        os.unlink(tf.name)
    for line in r.stdout.split('\n'):
        if line.startswith(mark):
            out = json.loads(line[len(mark):])
            if isinstance(out, dict) and 'error' in out:
                raise RuntimeError(out['error'])
            return out
    raise RuntimeError('%s printed nothing:\n%s\n%s' % (script, r.stdout[-1500:], r.stderr[-1500:]))


def _compare(problems, label, got, want):
    got_set, want_set = set(got), set(want)
    if got_set - want_set:
        problems.append('%s: not in the rules: %s' % (label, ', '.join(sorted(got_set - want_set))))
    if want_set - got_set:
        problems.append('%s: missing: %s' % (label, ', '.join(sorted(want_set - got_set))))
    if len(got) != len(got_set):
        problems.append('%s: a type is listed twice' % label)


def against_rules(cr, found):
    """(problems, notes): what Scryfall's data gave against the rules last saved. Scryfall may
    be ahead of them (a type first shown by a card newer than those rules), and a few days
    behind (the rules come out before a set is legal); anything else is a mistake."""
    p, notes = [], []
    rules_ahead = time.mktime(time.strptime(found['asOf'], '%Y-%m-%d')) - time.mktime(
        time.strptime(cr['effective'], '%Y-%m-%d')) < RULES_LEAD_DAYS * 86400
    for kind in sorted(set(cr['subtypes']) | set(found['subtypes'])):
        got, want = found['subtypes'].get(kind, {}), set(cr['subtypes'].get(kind, []))
        for t in sorted(set(got) - want):
            if got[t]['date'] > cr['effective']:
                notes.append('The %s type %s is newer than the saved rules of %s (%s, %s)'
                             % (kind, t, cr['effective'], got[t]['name'], got[t]['date']))
            else:
                p.append('%s types: Scryfall\'s data gave %s (%s), which the rules of %s do not list'
                         % (kind.capitalize(), t, got[t]['name'], cr['effective']))
        behind = sorted(want - set(got))
        if behind and rules_ahead:
            notes.append("The rules of %s list %s types not yet legal in Scryfall's data of %s: %s"
                         % (cr['effective'], kind, found['asOf'], ', '.join(behind)))
        elif behind:
            p.append("%s types: the rules of %s list %s, which Scryfall's data did not give"
                     % (kind.capitalize(), cr['effective'], ', '.join(behind)))
    return p, notes


def compare_lists(cr, s):
    """data.js's lists against the rules."""
    p, kinds = [], cr['subtypes']
    _compare(p, 'Card types (205.2a)', s['cardTypes'], cr['cardTypes'])
    _compare(p, 'Supertypes (205.4a)', s['supertypes'], cr['supertypes'])
    _compare(p, 'Card types without subtypes (205.3)', s['noSubtypes'], cr['noSubtypes'])
    _compare(p, 'Basic land types with a mana ability (305.6)', s['basicLandMana'], cr['basicLandTypes'])
    _compare(p, 'Outlaws (700.12)', s['outlaws'], cr['outlaws'])
    _compare(p, 'Kinds of subtype', list(s['official']), list(kinds))
    for kind, want in sorted(kinds.items()):
        _compare(p, '%s types' % kind.capitalize(), s['official'].get(kind, []), want)
    shared = {'Kindred': 'creature', 'Instant': 'spell', 'Sorcery': 'spell', 'Plane': 'planar'}
    for t in cr['cardTypes']:
        want = None if t in cr['noSubtypes'] else shared.get(t, t.lower())
        got = s['typeToCategory'].get(t)
        if got != want:
            p.append('Card type %s: its subtypes are the %s types, the site says %s' % (t, want, got))
        if want and want not in kinds:
            p.append('Card type %s: the rules list no subtypes for it (a new card type?)' % t)
    # An unofficial word that is official would be withheld from "every type"; one that is
    # official for another card type would be stripped along with this one's.
    for kind, words in sorted(s['unofficial'].items()):
        for other, official in sorted(kinds.items()):
            both = set(words) & set(official)
            if both and (other == kind or 'planar' not in (kind, other)):
                p.append('Unofficial %s types that are official %s types: %s' % (kind, other, ', '.join(sorted(both))))
    return p


def compare_use(cr, s):
    """What the engine, parser and choice boxes use against the rules."""
    p, kinds = list(s['misread']), cr['subtypes']
    _compare(p, 'Land words of the parser', s['landWords'], kinds['land'])
    for key, when in (('offline', 'before Scryfall answers'), ('wrongCatalog', 'with a wrong Scryfall catalog'),
                      ('failedFetch', 'with Scryfall unreachable')):
        u = s[key]
        _compare(p, '"All creature types" %s' % when, u['everyCreatureType'], kinds['creature'])
        _compare(p, '"Every land type" %s' % when, u['everyLandType'], kinds['land'])
        _compare(p, '"Choose a creature type" %s' % when, u['creatureChoices'], kinds['creature'])
        _compare(p, '"Choose a land type" %s' % when, u['landChoices'], kinds['land'])
        _compare(p, '"Choose a nonbasic land type" %s' % when, u['nonbasicLandChoices'],
                 set(kinds['land']) - set(cr['basicLandTypes']))
        for kind, words in sorted(u['vocabulary'].items()):
            if kind != 'creature':   # Scryfall's silver-bordered creature types are read too
                junk = set(words) & set(s['unofficial'].get(kind, []))
                if junk:
                    p.append('The parser reads unofficial %s types %s: %s' % (kind, when, ', '.join(sorted(junk))))
            lost = set(kinds[kind]) - set(words)
            if lost:
                p.append('The parser does not know official %s types %s: %s' % (kind, when, ', '.join(sorted(lost))))
        for kind, words in sorted(u['category'].items()):
            lost = (set(kinds[kind]) | set(s['unofficial'].get(kind, []))) - set(words)
            if lost:
                p.append('Losing or replacing %s types %s leaves behind: %s' % (kind, when, ', '.join(sorted(lost))))
    return p


def compare_test_catalog(cr, s):
    p = []
    with open(CATALOG, encoding='utf-8') as f:
        cat = json.load(f)
    for kind in SCRYFALL:
        got, want = cat.get(kind + 'Types', []), cr['subtypes'][kind]
        label = 'tests/type-catalog.json, %s types (rebuild with --catalog)' % kind
        if kind == 'creature':
            # The parser's vocabulary: every official type, and silver ones Scryfall lists too.
            _compare(p, label, sorted(set(got) - set(s['unofficial']['creature'])), want)
        else:
            _compare(p, label, got, want)
    return p


# ---- copies of a list elsewhere in the code ----

# Lines that name several subtypes and are no copy of a subtype list: (file, words on the
# line, why). A full basic-land or outlaw list needs no entry: those are compared by value.
SELECTIONS = [
    ('cards-text-utils.js', 'const IRREGULAR_PLURALS', 'irregular plurals'),
    ('engine-compute.js', 'const IRREGULAR_PLURAL_MAP_LOCAL', 'irregular plurals'),
    ('ui-battlefield.js', 'const COUNTER_ICON_SET', 'names of counters, some spelled as subtypes are'),
    ('cards-text-utils.js', "'octopi':", 'irregular plurals'),
    ('cards-text-utils.js', "'efreet':", 'irregular plurals'),
    ('cards-text-utils.js', "'merfolk': 'Merfolk'", 'irregular plurals'),
    ('cards-text-utils.js', "'allies':", 'irregular plurals'),
    ('cards-text-utils.js', 'const sameForm', 'plurals that equal the singular'),
    ('engine-compute.js', "'elves': 'Elf'", 'irregular plurals'),
    ('engine-compute.js', "'allies':", 'irregular plurals'),
    ('engine-compute.js', "'valkyries':", 'irregular plurals'),
    ('cards-types.js', 'const SELF_WORD_SUBTYPES', 'the subtypes with rules of their own, whose word the parser keeps'),
    ('cards-battlefield.js', 'const _isAttachmentSource', 'the subtypes that attach (CR 301.5, 301.6, 303.4)'),
    ('ui-battlefield.js', "t === 'Saga' || t === 'Class'", 'the subtypes with a card frame of their own'),
]


def find_copies(cr, read=None):
    """Literals and alternations in the site's scripts that name three or more subtypes.
    `read` replaces reading a file (used to test this)."""
    read = read or (lambda f: open(os.path.join(ROOT, f), encoding='utf-8').read())
    known = {t.lower() for kind, types in cr['subtypes'].items() if kind not in ('planar', 'dungeon') for t in types}
    basic = {t.lower() for t in cr['basicLandTypes']}
    exact = (basic, {t.lower() for t in cr['outlaws']})

    def subtype_of(word):
        w = word.lower()
        return w if w in known else w[:-1] if w.endswith('s') and w[:-1] in known else None

    p = []
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    for f in re.findall(r'<script src="([^"?]+)', html):
        if f.startswith('http'):
            continue
        src = read(f)
        if f == 'data.js':
            src = re.sub(r'/\* \[KEY: RULES-LISTS\].*?\[END: RULES-LISTS\] \*/', lambda m: '\n' * m.group(0).count('\n'), src, flags=re.S)
        lines, in_comment = [], False
        for line in src.split('\n'):
            start = line.lstrip()
            if in_comment or start.startswith('/*'):
                end = line.find('*/')
                in_comment = end < 0
                line = '' if in_comment else line[end + 2:]
            lines.append(re.sub(r'(^|\s)//.*$', '', line))
        code = '\n'.join(lines)
        groups = []     # (line number, words)
        for n, line in enumerate(lines, 1):
            words = re.findall(r"'([A-Za-z][A-Za-z\-]*)'", line) + re.findall(r'"([A-Za-z][A-Za-z\-]*)"', line)
            for m in re.finditer(r"[A-Za-z][A-Za-z'\-?]*(?:\|[A-Za-z][A-Za-z'\-?]*){2,}", line):
                words += m.group(0).replace('?', '').split('|')
            groups.append((n, words))
        for m in re.finditer(r'\[[^\[\]]{12,30000}?\]|\{[^{}]{12,30000}?\}', code, re.S):
            body = m.group(0)
            groups.append((code.count('\n', 0, m.start()) + 1,
                           re.findall(r"'([A-Za-z][A-Za-z\-]*)'", body) + re.findall(r'"([A-Za-z][A-Za-z\-]*)"', body)))
        told = set()
        for n, words in groups:
            distinct = {w.lower() for w in words}
            matched = [w for w in distinct if subtype_of(w)]
            hit = {subtype_of(w) for w in matched}
            if len(hit) < 3 or (len(matched) * 2 < len(distinct) and len(hit) < 8):
                continue
            # A whole basic-land or outlaw list is compared by value; plural tables leave out Plains.
            if hit in exact or hit == basic - {'plains'}:
                continue
            if any(f == sf and words_on_line in lines[n - 1] for sf, words_on_line, _ in SELECTIONS):
                continue
            if n not in told:
                told.add(n)
                p.append('%s:%d keeps its own list of subtypes (use TypeCatalog, or add it to SELECTIONS with the reason): %s'
                         % (f, n, ', '.join(sorted(hit))[:160]))
    return p


# ---- the two entry points ----

def check(engine):
    """(problems, notes) without the network: what tests/run.py checks on every run."""
    try:
        cr = snapshot()
        with open(FOUND, encoding='utf-8') as f:
            found = json.load(f)
        s = site(engine)
        problems, notes = against_rules(cr, found)
        # The card types and the rest of 205 come from the saved rules; the subtypes from Scryfall.
        want = dict(cr, subtypes={k: sorted(v) for k, v in found['subtypes'].items()})
        problems += new_types(engine)
        problems += compare_lists(want, s) + compare_use(want, s) + compare_test_catalog(want, s) + find_copies(want)
        if s['typesAsOf'] != found['asOf']:
            problems.append('data.js says its lists are from %s, the last update was %s: run python3 tests/run.py --catalog'
                            % (s['typesAsOf'], found['asOf']))
    except (IOError, ValueError, KeyError, RuntimeError) as e:
        return ['The subtype check could not run: %s: %s' % (type(e).__name__, e)], []
    try:
        meta = os.path.join(ROOT, 'tests', 'cards', 'bulk-meta.json')
        with open(meta, encoding='utf-8') as f:
            cards = json.load(f)['updated_at'][:10]
        if cards > found['asOf']:
            notes.append('The card file (%s) is newer than the subtype lists (%s): run python3 tests/run.py --catalog'
                         % (cards, found['asOf']))
    except (IOError, ValueError, KeyError):
        pass
    # (Old lists are no fault: the site adds what is newer itself, cards-types.js.)
    return list(dict.fromkeys(problems)), notes


def refresh(rules_path=None):
    """The optional second opinion: save the current rules' lists and say what changed in
    them. Returns (problems, notes, reached the rules)."""
    old = snapshot() if os.path.exists(SNAPSHOT) else None
    problems, notes, reached = [], [], False
    try:
        if rules_path:
            with open(rules_path, encoding='utf-8-sig') as f:
                text, source = f.read(), os.path.basename(rules_path)
        else:
            text, source = _download()
        reached = True
        new = extract(text)
        if old and new['effective'] < old['effective']:
            raise ValueError('These rules (%s) are older than the ones saved (%s)' % (new['effective'], old['effective']))
        if old:
            for kind, was in old['subtypes'].items():
                if len(new['subtypes'].get(kind, [])) < 0.8 * len(was):
                    raise ValueError('The %s types fell from %d to %d: not saved, read the rule by hand'
                                     % (kind, len(was), len(new['subtypes'].get(kind, []))))
            was = dict(old['subtypes'], cardTypes=old['cardTypes'], supertypes=old['supertypes'])
            now = dict(new['subtypes'], cardTypes=new['cardTypes'], supertypes=new['supertypes'])
            for kind in sorted(set(was) | set(now)):
                added, gone = set(now.get(kind, [])) - set(was.get(kind, [])), set(was.get(kind, [])) - set(now.get(kind, []))
                if added:
                    notes.append('The rules added %s: %s' % (kind, ', '.join(sorted(added))))
                if gone:
                    notes.append('The rules dropped %s: %s' % (kind, ', '.join(sorted(gone))))
        new['source'], new['checked'] = source, time.strftime('%Y-%m-%d')
        os.makedirs(os.path.dirname(SNAPSHOT), exist_ok=True)
        with open(SNAPSHOT, 'w', encoding='utf-8') as f:
            json.dump(new, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.write('\n')
        print('Rules effective %s: %s' % (new['effective'], ', '.join(
            '%d %s' % (len(v), k) for k, v in sorted(new['subtypes'].items()))))
    except IOError as e:
        notes.append('The current rules were NOT checked (%s). Save the .txt from %s and run'
                     ' python3 tests/run.py --rules FILE' % (e, RULES_PAGE))
    except ValueError as e:
        problems.append('The current rules were not saved: %s' % e)
    return problems, notes, reached
