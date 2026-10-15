#!/usr/bin/env python3
"""Behavioural audit of the Layer Inspector's target pickers.

    python3 tests/audit.py --pilot               # the 300 best-ranked relevant cards, then write the report
    python3 tests/audit.py                       # every card in the cached bulk file (slow)
    python3 tests/audit.py --limit 2000          # the first N cards by name (quick trial)
    python3 tests/audit.py --only "Name" ...     # audit just these cards and print every unit
    python3 tests/audit.py --report              # rebuild the report from the last run's raw results
    python3 tests/audit.py --diff OLD_RAW        # list units whose findings differ from a saved copy of a
                                                 # run (copy ~/Library/Caches/layer-inspector/audit-raw.jsonl.gz first)

tests/sweep.py asks "did this sentence produce an effect?". This asks what the site does with a
spell or ability once a user fires it and picks its target. Every card is added last to the fixed
two-player board in tests/audit-board.json and each thing a user fires and then targets is a unit:
a spell, a triggered ability, an activated ability, each "or" option of one. Abilities are fired with
exactly the arguments the site passes (ui-abilities.js).

A unit whose own text names one permanent target ("singular") is checked twice:

  Check 2  The site shows a single-target picker (not nothing, not a multi-target one), and the
           permanents in it are the ones the text allows. The text is read by a small closed-vocabulary
           interpreter in tests/audit.js that never calls the parser. Findings: no-picker,
           picker-kind-<kind>, empty-list, list-mismatch.
  Check 1  Choosing no target changes no permanent, and choosing each listed permanent changes exactly
           that permanent. Findings: changes-with-no-target, target-changes-others,
           target-changes-nothing. (no-op-on-some, mixed-subject: information, not findings.)
           Before target-changes-nothing is reported, the board is adjusted in the one way the text
           asks for and the targets are tried again: a listed permanent is handed to the opponent
           ("gain control of"), given the keyword being removed ("loses first strike"), the source
           is tapped ("for as long as this creature remains tapped"), the source is given the
           counters its text asks for ("if it has four or more quest counters on it"), the chosen
           land type becomes Island, or the spell's Kicked / Bargained toggle is switched on. A unit that then changes
           its target is information (shown-on-adjusted-board). board-cannot-show, also
           information: every listed permanent already has the keywords given or is already yours,
           or the only continuous effect sits in a sentence with its own "if".

Also reported: crash (an exception anywhere) and no-targeted-effect (the text names a target but the
parse produced no targeted effect, so there is no picker to audit - the sweep already covers
"sentence produced nothing"; it is its own low-priority cluster here). Units that are skipped always
carry a reason code, and the report counts them; a phrase the interpreter does not know is listed
under "Phrases not understood" so the vocabulary can be grown on purpose.

Results: tests/audit/report.md, tests/audit/clusters.json; raw results are cached in
~/Library/Caches/layer-inspector/audit-raw.jsonl.gz. Clusters are sorted by the best (lowest) EDHREC
rank among their cards, then by size. No network. tests/audit.js does the work; this file selects
cards, runs it in chunks and clusters what comes back.
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sweep  # noqa: E402  (load_cards, app_scripts, Templater, paths)

ROOT = sweep.ROOT
CACHE_DIR = sweep.CACHE_DIR
RAW = os.path.join(CACHE_DIR, 'audit-raw.jsonl.gz')
OUT_DIR = os.path.join(ROOT, 'tests', 'audit')
JSC = sweep.JSC

CHUNK = 40
CHUNK_TIMEOUT = 300      # seconds for a chunk of CHUNK cards
CARD_TIMEOUT = 60        # seconds for one card when hunting down a hang
PILOT_SIZE = 300
PILOT_ALWAYS = ('Armored Guardian',)
# Read for choosing and ranking cards only. They are not passed to the engine: a card object that ends up
# inside a parsed effect (a copy source) would carry them into the results.
EXTRA_FIELDS = ('legalities', 'edhrec_rank', 'released_at')

# "target ... creature|permanent|... ... gets|gains|..." within one sentence.
PILOT_RE = re.compile(r'\btarget\b[^.\n]*?\b(?:creature|permanent|artifact|enchantment|land|planeswalker)\b'
                      r'[^.\n]*?\b(?:gets|gains|gain|has|have|becomes|become|loses|lose)\b', re.I)

# Display order and one-line meaning of each finding code.
CODES = [
    ('crash', 'An exception while firing, listing targets or choosing a target.'),
    ('no-picker', 'The text names one permanent target and the parse has a targeted effect, but the site offers no target list at all.'),
    ('picker-kind-multi', 'The site shows a multi-target ("up to N") picker for a one-target text.'),
    ('picker-kind-slotted', 'The site shows one picker per slot for a one-target text.'),
    ('picker-kind-modal', 'The site shows per-mode pickers for a one-target text.'),
    ('empty-list', 'The target list is empty although the text allows permanents on the board.'),
    ('list-mismatch', 'The target list differs from the permanents the text allows.'),
    ('changes-with-no-target', 'With no target chosen, some permanent changes.'),
    ('target-changes-others', 'With a target chosen, a permanent other than the target changes.'),
    ('target-changes-nothing', 'Choosing any listed target changes nothing.'),
    ('no-targeted-effect', 'The text names one permanent target but the parse produced no targeted effect.'),
]
CODE_ORDER = {c: i for i, (c, _) in enumerate(CODES)}
CHECK2_CODES = {'empty-list', 'list-mismatch', 'no-picker'}


# ───────────────────────────── selecting cards ─────────────────────────────

def card_text(c):
    if c.get('oracle_text'):
        return c['oracle_text']
    return '\n'.join(f.get('oracle_text', '') for f in c.get('card_faces') or [])


def is_legal_somewhere(c):
    """Legal in some format, or not released yet (sweep.legal_or_unreleased)."""
    if not c.get('legalities'):
        return True          # field not available: do not exclude
    return sweep.legal_or_unreleased(c)


def rank_key(c):
    r = c.get('edhrec_rank')
    return (r is None, r if r is not None else 0, c['name'])


def pilot_cards(cards):
    picked = [c for c in cards if PILOT_RE.search(card_text(c)) and is_legal_somewhere(c)]
    picked.sort(key=rank_key)
    picked = picked[:PILOT_SIZE]
    names = {c['name'] for c in picked}
    for c in cards:
        if c['name'] in PILOT_ALWAYS and c['name'] not in names:
            picked.append(c)
    return picked


def strip_extra(c):
    """The engine gets the same card fields the sweep gives it."""
    c = dict(c)
    for k in EXTRA_FIELDS:
        c.pop(k, None)
    return c


# ───────────────────────────── running the engine ─────────────────────────────

def engine_cmd():
    node = shutil.which('node')
    if node:
        return [node, 'tests/audit.js']
    if os.path.exists(JSC):
        return [JSC, 'tests/audit.js', '--']
    sys.exit('No JavaScript engine found (need Node, or macOS jsc at %s).' % JSC)


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
        if line.startswith('@@AUDIT '):
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
    # The engine died or hung somewhere in this chunk. Redo it one card at a time so the culprit
    # is named and every other card still gets a result.
    records = []
    for i, c in enumerate(cards):
        recs, kw, ok1 = run_engine([c], workdir, '%s-%d' % (tag, i), CARD_TIMEOUT)
        keywords = keywords or kw
        if ok1:
            records.extend(recs)
        else:
            records.append({'name': c['name'], 'face': 0, 'layout': c.get('layout'), 'typeLine': c.get('type_line', ''),
                            'units': [], 'skipped': [],
                            'errors': [{'stage': 'whole card', 'where': '',
                                        'msg': 'Engine hung (over %ds) or died while auditing this card' % CARD_TIMEOUT}]})
    return records, keywords


def run_audit(cards):
    workdir = tempfile.mkdtemp(prefix='layers-audit-')
    try:
        with open(os.path.join(workdir, 'scripts.json'), 'w') as f:
            json.dump(sweep.app_scripts(), f)
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


def add_ranks(records, cards):
    ranks = {}
    for c in cards:
        r = c.get('edhrec_rank')
        ranks[c['name']] = r
        ranks[c['name'].split(' // ')[0]] = r
        for f in c.get('card_faces') or []:
            ranks.setdefault(f.get('name'), r)
    for rec in records:
        rec['edhrec'] = ranks.get(rec['name'])
    return records


def save_raw(records, keywords, meta):
    with gzip.open(RAW, 'wt', encoding='utf-8') as f:
        f.write(json.dumps({'keywords': keywords, 'meta': meta}) + '\n')
        for r in records:
            f.write(json.dumps(r) + '\n')


def load_raw(path=RAW):
    if not os.path.exists(path):
        sys.exit('No previous run at %s - run without --report first.' % path)
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        head = json.loads(f.readline())
        return [json.loads(l) for l in f if l.strip()], head['keywords'], head.get('meta', {})


# ───────────────────────────── clustering ─────────────────────────────

def md(s):
    return str(s).replace('|', '\\|').replace('\n', ' / ')


def unit_label(u):
    s = u['kind']
    if u.get('index') is not None:
        s += ' %d' % u['index']
    if u.get('label'):
        s += ' (%s)' % u['label']
    return s


def rank_text(r):
    return 'rank %d' % r if r is not None else 'unranked'


def roles_key(roles):
    return ', '.join(sorted(set(roles))) or 'none'


def finding_detail(f):
    """One line describing a finding."""
    c = f['code']
    if c in ('empty-list', 'list-mismatch'):
        return 'missing: %s; extra: %s' % (roles_key(f.get('missing', [])), roles_key(f.get('extra', [])))
    if c == 'changes-with-no-target':
        return '; '.join('%s: %s' % (x['role'], x['what']) for x in f.get('changed', [])[:4])
    if c == 'target-changes-others':
        return '; '.join('with %s chosen, %s' % (e['target'], ', '.join('%s (%s)' % (o['role'], o['what']) for o in e['others'][:3]))
                         for e in f.get('examples', [])[:2])
    if c == 'target-changes-nothing':
        return 'tried %d' % f.get('tried', 0)
    if c == 'crash':
        e = f.get('error', {})
        return '%s: %s (%s)' % (e.get('stage', ''), e.get('msg', ''), e.get('where', ''))
    return ''


def cluster_key(tp, f, u):
    c = f['code']
    if c == 'crash':
        e = f.get('error', {})
        return '%s / %s' % (e.get('where', ''), re.sub(r'\b(?:c|trig|act|spell|perm)_\w+', '<id>', e.get('msg', '')))
    if c in ('empty-list', 'list-mismatch') or c.startswith('picker-kind'):
        base = tp.template('target ' + (u.get('phrase') or ''))
        if c in ('empty-list', 'list-mismatch'):
            base += ' / missing: %s / extra: %s' % (roles_key(f.get('missing', [])), roles_key(f.get('extra', [])))
        return base
    base = tp.template(u.get('text') or '')
    if c == 'changes-with-no-target':
        base += ' / changed: ' + roles_key(x['role'] for x in f.get('changed', []))
    elif c == 'target-changes-others':
        base += ' / others: ' + roles_key(o['role'] for e in f.get('examples', []) for o in e['others'])
    return base


def analyse(records, keywords):
    tp = sweep.Templater(keywords)
    totals = collections.Counter()
    skipped = collections.Counter()
    infos = collections.Counter()
    unknown_phrases = collections.defaultdict(list)       # phrase -> [(rank, card)]
    clusters = {}                                         # (code, key) -> {...}
    cards = set()
    for r in records:
        cards.add(r['name'])
        totals['faces'] += 1
        for e in r.get('errors', []):
            f = {'code': 'crash', 'error': e}
            u = {'kind': 'whole card', 'text': '', 'phrase': ''}
            key = ('crash', cluster_key(tp, f, u))
            c = clusters.setdefault(key, {'code': 'crash', 'key': key[1], 'members': []})
            c['members'].append({'card': r['name'], 'rank': r.get('edhrec'), 'unit': 'whole card', 'text': '', 'detail': finding_detail(f)})
            totals['findings'] += 1
        for s in r.get('skipped', []):
            skipped[s['reason']] += 1
            totals['skipped'] += 1
        for u in r.get('units', []):
            totals['units'] += 1
            if u.get('phraseUnknown'):
                unknown_phrases[u['phrase']].append((r.get('edhrec'), r['name']))
                totals['phrase_unknown'] += 1
            if u.get('mixed') and (u['mixed'].get('source') or u['mixed'].get('group')):
                infos['mixed-subject'] += 1
            for i in u.get('infos', []):
                infos[i['code']] += 1
            for f in u.get('findings', []):
                totals['findings'] += 1
                key = (f['code'], cluster_key(tp, f, u))
                c = clusters.setdefault(key, {'code': f['code'], 'key': key[1], 'members': []})
                c['members'].append({'card': r['name'], 'rank': r.get('edhrec'), 'unit': unit_label(u), 'text': u.get('text', ''),
                                     'detail': finding_detail(f)})
    out = []
    for c in clusters.values():
        ranks = [m['rank'] for m in c['members'] if m['rank'] is not None]
        c['best_rank'] = min(ranks) if ranks else None
        c['members'].sort(key=lambda m: (m['rank'] is None, m['rank'] if m['rank'] is not None else 0, m['card']))
        out.append(c)
    out.sort(key=lambda c: (c['best_rank'] is None, c['best_rank'] if c['best_rank'] is not None else 0, -len(c['members']), c['key']))
    return {'totals': totals, 'skipped': skipped, 'infos': infos, 'unknown': unknown_phrases, 'clusters': out, 'cards': len(cards)}


# ───────────────────────────── report ─────────────────────────────

def write_report(records, keywords, meta, scope):
    a = analyse(records, keywords)
    os.makedirs(OUT_DIR, exist_ok=True)
    by_code = collections.defaultdict(list)
    for c in a['clusters']:
        by_code[c['code']].append(c)
    per_code = {code: sum(len(c['members']) for c in cs) for code, cs in by_code.items()}
    L = ['# Behavioural audit report\n',
         'Generated by `python3 tests/audit.py` (%s) from the Scryfall oracle-cards file dated %s, against the board in '
         '`tests/audit-board.json`. See the docstring of `tests/audit.py` for how a unit is judged.\n' % (scope, meta.get('cards_updated', 'unknown')),
         '| | |\n|---|---|',
         '| Cards audited | %d (%d faces) |' % (a['cards'], a['totals']['faces']),
         '| Units audited (text names one permanent target) | %d |' % a['totals']['units'],
         '| Units skipped | %d |' % a['totals']['skipped'],
         '| Audited units whose phrase the interpreter did not understand (list check not run) | %d |' % a['totals']['phrase_unknown'],
         '| Findings | %d in %d clusters |' % (a['totals']['findings'], len(a['clusters'])),
         '| Information only | %s |' % (', '.join('%s %d' % (k, v) for k, v in sorted(a['infos'].items())) or 'none'),
         '']
    L.append('## Findings per code\n')
    L.append('| Code | Findings | Clusters | Meaning |\n|---|---:|---:|---|')
    for code, meaning in CODES:
        if code in per_code:
            L.append('| `%s` | %d | %d | %s |' % (code, per_code[code], len(by_code[code]), meaning))
    for code in sorted(per_code):
        if code not in CODE_ORDER:
            L.append('| `%s` | %d | %d | |' % (code, per_code[code], len(by_code[code])))
    L.append('')
    L.append('## Units skipped, by reason\n')
    L.append('| Reason | Units |\n|---|---:|')
    for reason, n in a['skipped'].most_common():
        L.append('| `%s` | %d |' % (reason, n))
    L.append('')

    n = 0
    for code in [c for c, _ in CODES] + sorted(k for k in by_code if k not in CODE_ORDER):
        cs = by_code.get(code)
        if not cs:
            continue
        n += 1
        meaning = dict(CODES).get(code, '')
        L.append('## %d. `%s`\n' % (n, code))
        if meaning:
            L.append(meaning + '\n')
        for c in cs:
            ms = c['members']
            L.append('### %s - %d unit%s, best %s\n' % ('`%s`' % md(c['key'])[:200], len(ms), '' if len(ms) == 1 else 's', rank_text(c['best_rank'])))
            for m in ms[:8]:
                line = '- %s (%s) - %s' % (m['card'], rank_text(m['rank']), m['unit'])
                if m['text']:
                    line += ' - "%s"' % m['text'][:220]
                if m['detail']:
                    line += ' - %s' % m['detail'][:300]
                L.append(line)
            if len(ms) > 8:
                L.append('- and %d more' % (len(ms) - 8))
            L.append('')

    L.append('## Phrases not understood\n')
    if not a['unknown']:
        L.append('None.\n')
    else:
        L.append('The interpreter\'s vocabulary is closed on purpose; grow it deliberately.\n')
        L.append('| Cards | Phrase (after "target") | Examples |\n|---:|---|---|')
        for phrase, hits in sorted(a['unknown'].items(), key=lambda kv: (-len(kv[1]), kv[0])):
            ex = ', '.join(n for _, n in sorted(hits, key=lambda h: (h[0] is None, h[0] or 0))[:3])
            L.append('| %d | `%s` | %s |' % (len(hits), md(phrase), md(ex)))
        L.append('')
    with open(os.path.join(OUT_DIR, 'report.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(L))
    with open(os.path.join(OUT_DIR, 'clusters.json'), 'w', encoding='utf-8') as f:
        json.dump([{'code': c['code'], 'key': c['key'], 'units': len(c['members']), 'best_rank': c['best_rank'],
                    'members': c['members']} for c in a['clusters']], f, indent=1, ensure_ascii=False)
    return a, per_code


# ───────────────────────────── --only and --diff ─────────────────────────────

def print_record(r):
    print('%s  [%s]  edhrec %s' % (r['name'], r['typeLine'], rank_text(r.get('edhrec'))))
    for e in r.get('errors', []):
        print('   CRASH   %s: %s (%s)' % (e['stage'], e['msg'], e['where']))
    for s in r.get('skipped', []):
        print('   skipped %-28s %s  [%s]' % (s['reason'], s['unit'], s['text'][:90]))
    for u in r.get('units', []):
        print('   UNIT    %s' % unit_label(u))
        print('       text:      %s' % u.get('text', ''))
        print('       phrase:    "%s"%s' % (u.get('phrase', ''), ' (another/other)' if u.get('excludeSource') else ''))
        print('       picker:    %s' % u.get('pickerKind', 'not reached'))
        if u.get('phraseUnknown'):
            print('       expected:  phrase not understood (%s)' % ', '.join(u['phraseUnknown']))
        else:
            print('       expected:  %s' % (', '.join(u['expected']) if u.get('expected') else 'nothing' if u.get('expected') is not None else 'n/a'))
        if u.get('blocked'):
            print('       actual:    blocked - %s' % u['blocked'])
        else:
            print('       actual:    %s' % (', '.join(u['actual']) if u.get('actual') else 'nothing' if u.get('actual') is not None else 'n/a'))
        m = u.get('mixed') or {}
        c1 = u.get('check1')
        if c1:
            print('       check 1:   no target -> %s%s' % (', '.join('%s (%s)' % (x['role'], x['what']) for x in c1['noTarget']) or 'nothing changed',
                  '   [mixed subject: %s - no-target half not judged]' % ('source' if m.get('source') else 'group') if (m.get('source') or m.get('group')) else ''))
            print('                  targets tried from the %s' % c1.get('via', '?'))
            for t in c1['perTarget']:
                print('                  %-26s -> %s' % (t['target'], ', '.join('%s (%s)' % (x['role'], x['what']) for x in t['changed']) or 'nothing changed'))
        for i in u.get('infos', []):
            print('       info:      %s %s' % (i['code'], i.get('what') or ', '.join(i.get('roles', []))))
        for f in u.get('findings', []):
            print('       FINDING    %s  %s' % (f['code'], finding_detail(f)))
    print()


def unit_signatures(records):
    sig = {}
    for r in records:
        for e in r.get('errors', []):
            sig[(r['name'], r['face'], 'whole card')] = (r.get('edhrec'), ['crash: ' + e.get('msg', '')])
        for u in r.get('units', []):
            fs = sorted('%s: %s' % (f['code'], finding_detail(f)) for f in u.get('findings', []))
            sig[(r['name'], r['face'], unit_label(u) + ' | ' + u.get('text', '')[:60])] = (r.get('edhrec'), fs)
    return sig


def cmd_diff(before_path):
    old, _, _ = load_raw(before_path)
    new, _, _ = load_raw(RAW)
    a, b = unit_signatures(old), unit_signatures(new)
    rows = []
    for k in set(a) | set(b):
        sa, sb = a.get(k), b.get(k)
        if sa and sb and sa[1] == sb[1]:
            continue
        rank = (sb or sa)[0]
        if sa is None:
            kind = 'new unit' if sb[1] else 'new unit, no findings'
            if not sb[1]:
                continue
        elif sb is None:
            kind = 'unit gone'
        elif not sa[1]:
            kind = 'new findings'
        elif not sb[1]:
            kind = 'resolved'
        else:
            kind = 'different'
        rows.append((rank is None, rank or 0, k, kind, sa, sb))
    rows.sort(key=lambda x: x[:3])
    for _, _, k, kind, sa, sb in rows:
        print('%s (%s) - %s: %s' % (k[0], rank_text((sb or sa)[0]), k[2], kind))
        for l in (sa[1] if sa else []):
            if not sb or l not in sb[1]:
                print('    - ' + l[:230])
        for l in (sb[1] if sb else []):
            if not sa or l not in sa[1]:
                print('    + ' + l[:230])
    print('%d units differ' % len(rows))
    return 0


# ───────────────────────────── main ─────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pilot', action='store_true', help='Audit only the %d best-ranked relevant cards (plus %s)' % (PILOT_SIZE, ', '.join(PILOT_ALWAYS)))
    ap.add_argument('--report', action='store_true', help='Rebuild the report from the last run without re-auditing')
    ap.add_argument('--only', nargs='+', metavar='NAME', help='Audit only these cards and print every unit')
    ap.add_argument('--limit', type=int, help='Audit only the first N cards (by name)')
    ap.add_argument('--diff', metavar='RAW', help='List units whose findings differ from a saved copy of an earlier run')
    args = ap.parse_args()

    if args.diff:
        return cmd_diff(args.diff)

    fields = sweep.CARD_FIELDS + EXTRA_FIELDS
    if args.only:
        cards, _ = sweep.load_cards(only=set(args.only), fields=fields)
        records, keywords = run_audit([strip_extra(c) for c in cards])
        add_ranks(records, cards)
        for r in records:
            print_record(r)
        return 0

    scope = 'pilot' if args.pilot else ('first %d cards by name' % args.limit if args.limit else 'whole pool')
    if args.report:
        records, keywords, meta = load_raw()
        scope = meta.get('scope', scope)
    else:
        cards, skipped = sweep.load_cards(limit=None if args.pilot else args.limit, fields=fields)
        if args.pilot:
            cards = pilot_cards(cards)
        print('Auditing %d cards (%s)' % (len(cards), scope))
        records, keywords = run_audit([strip_extra(c) for c in cards])
        add_ranks(records, cards)
        meta = {'cards': len(cards), 'scope': scope}
        try:
            meta['cards_updated'] = json.load(open(os.path.join(CACHE_DIR, 'bulk-meta.json')))['updated_at'][:10]
        except (OSError, KeyError, ValueError):
            pass
        save_raw(records, keywords, meta)
    a, per_code = write_report(records, keywords, meta, scope)
    print('%d faces, %d units audited, %d skipped, %d findings in %d clusters' % (
        a['totals']['faces'], a['totals']['units'], a['totals']['skipped'], a['totals']['findings'], len(a['clusters'])))
    print('Findings: %s' % (', '.join('%s %d' % (c, per_code[c]) for c, _ in CODES if c in per_code) or 'none'))
    print('Wrote tests/audit/report.md, tests/audit/clusters.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
