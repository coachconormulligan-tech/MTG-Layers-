#!/usr/bin/env python3
"""Regression runner for the Layer Inspector.

    python3 tests/run.py                    Check every fixture in tests/fixtures/
    python3 tests/run.py NAME [NAME ...]    Check only fixtures whose filename contains NAME
    python3 tests/run.py --update [NAME]    Re-record expected results (after an intended change)
    python3 tests/run.py --add BOARD.json [--name "Title"] [--notes "Why this matters"]
                                            Turn a board downloaded from the site into a fixture
    python3 tests/run.py --build RECIPE.json [RECIPE.json ...]
                                            Build fixtures from recipes (card names + setup steps)

A recipe is { name, notes, steps, asserts }. Steps are documented in tests/harness.js.
Asserts are the hand-written facts the fixture exists to protect, checked on every run:
    { "perm": "Grizzly Bears", "final": { "power": 3, "toughness": 3 } }
    { "effect": { "source": "Glorious Anthem", "layer": "7c", "type": "modify_pt" } }
    { "order": { "4": ["Conversion", "Blood Moon"] } }
A recipe may carry "knownFailure": "reason" to mark an open bug whose asserts do not hold
yet; it is reported but does not fail the run, and is flagged once it starts passing.
Matching is partial: only the keys given are compared. Use { "$includes": [...] } or
{ "$excludes": [...] } in place of a list to test membership.

Card data comes from Scryfall's oracle-cards bulk file, cached outside the repo at
~/Library/Caches/layer-inspector/oracle-cards.jsonl.gz, falling back to cards already
embedded in existing fixtures.

Exit code is 0 when everything passes, 1 otherwise.

The engine and parser run headlessly through tests/harness.js, using Node if it is
installed and macOS's built-in JavaScriptCore shell otherwise.
"""
import argparse
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, 'tests', 'fixtures')
JSC = '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc'


def engine_cmd():
    node = shutil.which('node')
    if node:
        return [node, 'tests/harness.js']
    if os.path.exists(JSC):
        return [JSC, 'tests/harness.js', '--']
    sys.exit('No JavaScript engine found (need Node, or macOS jsc at %s).' % JSC)


def app_scripts():
    """Every non-UI script from index.html, in load order, plus ui-helpers.js
    (cards-permanent.js uses its _stripReminderText)."""
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    srcs = re.findall(r'<script src="([^"?]+)', html)
    scripts = [s for s in srcs if not s.startswith('ui-')]
    return scripts + ['ui-helpers.js']


def run_harness(paths, build=False):
    """Returns {path: {'actual': ...} | {'error': ...}}."""
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(app_scripts(), f)
        scripts_file = f.name
    try:
        proc = subprocess.run(engine_cmd() + [scripts_file] + (['--build'] if build else []) + paths, cwd=ROOT,
                              capture_output=True, text=True)
    finally:
        os.unlink(scripts_file)
    results = {}
    for line in proc.stdout.splitlines():
        if line.startswith('@@RESULT '):
            r = json.loads(line[len('@@RESULT '):])
            results[r['path']] = r
    for p in paths:
        if p not in results:
            # The engine died before reaching this fixture (e.g. a syntax error in an app file).
            tail = (proc.stderr or proc.stdout or '').strip().splitlines()[-8:]
            results[p] = {'path': p, 'error': 'Harness crashed:\n' + '\n'.join(tail)}
    return results


def diff(expected, actual, path=''):
    """List of human-readable differences between two JSON values."""
    if type(expected) is not type(actual):
        return ['%s: expected %s, got %s' % (path or '(root)', short(expected), short(actual))]
    if isinstance(expected, dict):
        out = []
        for k in sorted(set(expected) | set(actual)):
            sub = '%s.%s' % (path, k) if path else str(k)
            if k not in actual:
                out.append('%s: missing (expected %s)' % (sub, short(expected[k])))
            elif k not in expected:
                out.append('%s: unexpected %s' % (sub, short(actual[k])))
            else:
                out += diff(expected[k], actual[k], sub)
        return out
    if isinstance(expected, list):
        # Label list entries by their name where they have one, so a diff reads
        # "permanents[Grizzly Bears].final.power" rather than "permanents[3]...".
        out = []
        if len(expected) != len(actual):
            out.append('%s: expected %d entries, got %d' % (path, len(expected), len(actual)))
        for i, (e, a) in enumerate(zip(expected, actual)):
            label = e.get('perm') or e.get('source') if isinstance(e, dict) else None
            out += diff(e, a, '%s[%s]' % (path, label if label else i))
        return out
    if expected != actual:
        return ['%s: expected %s, got %s' % (path, short(expected), short(actual))]
    return []


def short(v, limit=160):
    s = json.dumps(v, ensure_ascii=False)
    return s if len(s) <= limit else s[:limit] + '...'


def slugify(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def fixture_paths(filters):
    if not os.path.isdir(FIXTURES):
        return []
    names = sorted(n for n in os.listdir(FIXTURES) if n.endswith('.json'))
    if filters:
        names = [n for n in names if any(f.lower() in n.lower() for f in filters)]
    return [os.path.join('tests', 'fixtures', n) for n in names]


def write_fixture(path, fx):
    with open(os.path.join(ROOT, path), 'w', encoding='utf-8') as f:
        json.dump(fx, f, ensure_ascii=False, indent=1)
        f.write('\n')


CARD_CACHE = os.path.expanduser('~/Library/Caches/layer-inspector/oracle-cards.jsonl.gz')
_card_index = None


def card_index():
    """name -> Scryfall card object. Bulk file wins; fixture-embedded cards fill gaps."""
    global _card_index
    if _card_index is not None:
        return _card_index
    idx = {}

    def walk(v):
        if isinstance(v, dict):
            if 'oracle_id' in v and 'name' in v and 'type_line' in v:
                idx.setdefault(v['name'], v)
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    for p in fixture_paths([]):
        walk(json.load(open(os.path.join(ROOT, p), encoding='utf-8')).get('board'))
    if os.path.exists(CARD_CACHE):
        # One Scryfall card object per line. Tokens share names with real cards
        # (and with each other), so real cards win and tokens only fill gaps.
        with gzip.open(CARD_CACHE, 'rt', encoding='utf-8') as f:
            cards = [json.loads(line) for line in f if line.strip()]
        cards.sort(key=lambda c: c.get('layout') in ('token', 'double_faced_token', 'emblem', 'art_series'))
        seen = set()
        for c in cards:
            names = [c['name']]
            # Let "Front Name" find "Front Name // Back Name".
            if ' // ' in c['name']:
                names.append(c['name'].split(' // ')[0])
            for n in names:
                if n not in seen:
                    seen.add(n)
                    idx[n] = c
    _card_index = idx
    return idx


CATALOG_FILE = os.path.join(ROOT, 'tests', 'type-catalog.json')
_CATEGORY = {'Land': 'landTypes', 'Creature': 'creatureTypes', 'Artifact': 'artifactTypes',
             'Enchantment': 'enchantmentTypes', 'Planeswalker': 'planeswalkerTypes',
             'Instant': 'spellTypes', 'Sorcery': 'spellTypes', 'Battle': 'battleTypes'}


def cmd_catalog():
    """Rebuild tests/type-catalog.json from the bulk card file.

    The site fills TypeCatalog from Scryfall's catalog endpoints at startup and the parser
    behaves differently until it has. The harness loads this file instead. Subtypes are
    taken first from type lines that name exactly one subtype-bearing card type, so each
    lands in an unambiguous category; what is left on mixed creature lines is a creature type."""
    if not os.path.exists(CARD_CACHE):
        sys.exit('No card data at %s' % CARD_CACHE)
    cat = {v: set() for v in _CATEGORY.values()}
    mixed = []   # subtype words from type lines naming several card types ("Artifact Creature — Golem")
    with gzip.open(CARD_CACHE, 'rt', encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            c = json.loads(line)
            if c.get('set_type') in ('funny', 'memorabilia') or c.get('layout') == 'art_series':
                continue
            for face in (c.get('type_line') or '').split(' // '):
                if ' — ' not in face:
                    continue
                left, right = face.split(' — ', 1)
                words = left.split()
                if 'Kindred' in words or 'Tribal' in words:
                    continue
                cats = {_CATEGORY[w] for w in words if w in _CATEGORY}
                if len(cats) == 1:
                    cat[cats.pop()].update(right.split())
                elif 'creatureTypes' in cats:
                    mixed.append(right.split())
    # A subtype that only ever appears beside Creature plus another type (Golem, Thopter,
    # Dalek) is a creature type unless a single-type line already placed it elsewhere.
    placed = set().union(*cat.values())
    for words in mixed:
        cat['creatureTypes'].update(w for w in words if w not in placed)
    with open(CATALOG_FILE, 'w', encoding='utf-8') as f:
        json.dump({k: sorted(v) for k, v in sorted(cat.items())}, f, ensure_ascii=False, indent=0)
        f.write('\n')
    print('Wrote tests/type-catalog.json: ' + ', '.join('%d %s' % (len(v), k) for k, v in sorted(cat.items())))


def cmd_card(names):
    """Print the oracle text of each named card (for writing recipes without a browser)."""
    idx = card_index()
    for n in names:
        c = idx.get(n)
        if not c:
            close = [k for k in idx if n.lower() in k.lower()][:8]
            print('%s: not found%s' % (n, ' (did you mean: %s)' % '; '.join(close) if close else ''))
            continue
        for face in c.get('card_faces') or [c]:
            pt = ' %s/%s' % (face['power'], face['toughness']) if 'power' in face else ''
            print('%s %s | %s%s | colors %s\n    %s' % (face['name'], face.get('mana_cost', ''), face.get('type_line', ''), pt,
                  ''.join(face.get('colors', c.get('colors', []))) or '-', (face.get('oracle_text') or '').replace('\n', '\n    ')))


def recipe_card_names(recipe):
    names = []
    for step in recipe.get('steps', []):
        if 'add' in step:
            names.append(step['add'])
        for a in step.get('call', []):
            if isinstance(a, str) and a.startswith('card:'):
                names.append(a[5:])
    return names


def matches(spec, value):
    """Partial match: dict specs compare only their own keys."""
    if isinstance(spec, dict):
        if '$includes' in spec or '$excludes' in spec:
            if not isinstance(value, list):
                return False
            return (all(x in value for x in spec.get('$includes', []))
                    and not any(x in value for x in spec.get('$excludes', [])))
        return isinstance(value, dict) and all(k in value and matches(v, value[k]) for k, v in spec.items())
    return spec == value


def check_asserts(asserts, actual):
    """List of failure messages for a fixture's hand-written asserts."""
    out = []
    for a in asserts or []:
        if 'perm' in a:
            found = [p for p in actual['permanents'] if p['perm'] == a['perm']]
            if not found:
                out.append('assert: no permanent named %s' % a['perm'])
                continue
            spec = {k: v for k, v in a.items() if k != 'perm'}
            if not matches(spec, found[0]):
                got = {k: found[0].get(k) for k in spec}
                if 'final' in spec and isinstance(found[0].get('final'), dict):
                    got['final'] = {k: found[0]['final'].get(k) for k in spec['final']}
                out.append('assert on %s: expected %s, got %s' % (a['perm'], short(spec), short(got)))
        elif 'effect' in a:
            if not any(matches(a['effect'], e) for e in actual['effects']):
                out.append('assert: no parsed effect matching %s' % short(a['effect']))
        elif 'noEffect' in a:
            if any(matches(a['noEffect'], e) for e in actual['effects']):
                out.append('assert: found an effect that should not exist: %s' % short(a['noEffect']))
        elif 'order' in a:
            if not matches(a['order'], actual['order']):
                got = {k: actual['order'].get(k) for k in a['order']}
                out.append('assert on order: expected %s, got %s' % (short(a['order']), short(got)))
        else:
            out.append('assert: unrecognised form %s' % short(a))
    return out


def cmd_build(recipe_paths):
    os.makedirs(FIXTURES, exist_ok=True)
    idx = card_index()
    failed = 0
    for rp in recipe_paths:
        recipe = json.load(open(rp, encoding='utf-8'))
        name = recipe['name']
        missing = [n for n in recipe_card_names(recipe) if n not in idx]
        if missing:
            failed += 1
            print('SKIP   %s: no card data for %s' % (name, ', '.join(sorted(set(missing)))))
            continue
        rel = os.path.join('tests', 'fixtures', slugify(name) + '.json')
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump({'recipe': recipe, 'cards': {n: idx[n] for n in recipe_card_names(recipe)}}, f)
            tmp = f.name
        try:
            r = run_harness([tmp], build=True)[tmp]
        finally:
            os.unlink(tmp)
        if 'error' in r:
            failed += 1
            print('ERROR  %s\n       %s' % (name, r['error'].replace('\n', '\n       ')))
            continue
        problems = check_asserts(recipe.get('asserts'), r['actual'])
        fx = {'name': name, 'notes': recipe.get('notes', ''), 'recipe': {'steps': recipe.get('steps', [])},
              'asserts': recipe.get('asserts', []), 'board': r['board'], 'expected': r['actual']}
        if recipe.get('knownFailure'):
            fx['knownFailure'] = recipe['knownFailure']
        write_fixture(rel, fx)
        if problems and recipe.get('knownFailure'):
            print('BUILT, KNOWN FAILURE  %s  (%s)' % (name, rel))
        elif problems:
            failed += 1
            print('BUILT, ASSERTS FAIL  %s  (%s)' % (name, rel))
            for d in problems:
                print('       ' + d)
        else:
            print('BUILT  %s  (%s, %d asserts hold)' % (name, rel, len(recipe.get('asserts', []))))
    sys.exit(1 if failed else 0)


def cmd_add(board_path, name, notes):
    board = json.load(open(board_path, encoding='utf-8'))
    board = board.get('board', board)
    name = name or os.path.splitext(os.path.basename(board_path))[0]
    os.makedirs(FIXTURES, exist_ok=True)
    rel = os.path.join('tests', 'fixtures', slugify(name) + '.json')
    if os.path.exists(os.path.join(ROOT, rel)):
        sys.exit('Fixture already exists: %s' % rel)
    write_fixture(rel, {'name': name, 'notes': notes or '', 'board': board, 'expected': None})
    r = run_harness([rel])[rel]
    if 'error' in r:
        os.unlink(os.path.join(ROOT, rel))
        sys.exit('Could not evaluate that board:\n' + r['error'])
    write_fixture(rel, {'name': name, 'notes': notes or '', 'board': board, 'expected': r['actual']})
    print('Added %s (%d permanents, %d effects).' % (rel, len(r['actual']['permanents']), len(r['actual']['effects'])))
    print('Recorded what the engine produces today. Check it is correct before relying on it.')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('filters', nargs='*')
    ap.add_argument('--update', action='store_true')
    ap.add_argument('--add', metavar='BOARD.json')
    ap.add_argument('--build', action='store_true')
    ap.add_argument('--card', action='store_true', help='Print oracle text for the named cards')
    ap.add_argument('--catalog', action='store_true', help='Rebuild tests/type-catalog.json from the bulk card file')
    ap.add_argument('--name')
    ap.add_argument('--notes')
    args = ap.parse_args()

    if args.add:
        return cmd_add(args.add, args.name, args.notes)
    if args.catalog:
        return cmd_catalog()
    if args.card:
        return cmd_card(args.filters)
    if args.build:
        return cmd_build(args.filters)

    paths = fixture_paths(args.filters)
    if not paths:
        sys.exit('No fixtures matched.')
    results = run_harness(paths)

    passed = failed = updated = known = 0
    for p in paths:
        fx = json.load(open(os.path.join(ROOT, p), encoding='utf-8'))
        r = results[p]
        label = fx.get('name') or os.path.basename(p)
        if 'error' in r:
            failed += 1
            print('ERROR  %s\n       %s' % (label, r['error'].replace('\n', '\n       ')))
            continue
        problems = check_asserts(fx.get('asserts'), r['actual'])
        if fx.get('knownFailure'):
            # An open bug with its fixture already written. Reported, but does not fail the
            # run, so the suite stays usable as a gate while the bug is waiting to be fixed.
            if problems:
                known += 1
                print('KNOWN  %s\n       %s' % (label, fx['knownFailure']))
            else:
                failed += 1
                print('FIXED? %s  (%s)\n       Asserts now hold. Remove "knownFailure" from the recipe and rebuild.' % (label, p))
            continue
        if problems:
            # Asserts are hand-written facts; --update never papers over them.
            failed += 1
            print('FAIL   %s  (%s)' % (label, p))
            for d in problems:
                print('       ' + d)
            continue
        diffs = diff(fx.get('expected'), r['actual'])
        if not diffs:
            passed += 1
            continue
        if args.update:
            fx['expected'] = r['actual']
            write_fixture(p, fx)
            updated += 1
            print('UPDATED %s (%d differences)' % (label, len(diffs)))
            continue
        failed += 1
        print('FAIL   %s  (%s)' % (label, p))
        for d in diffs[:25]:
            print('       ' + d)
        if len(diffs) > 25:
            print('       ... and %d more' % (len(diffs) - 25))

    summary = '%d passed, %d failed' % (passed, failed)
    if known:
        summary += ', %d known failures' % known
    if updated:
        summary += ', %d updated' % updated
    print(summary)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
