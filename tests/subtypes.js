/* Runs cards-types.js's deriveSubtypes over the card file for tests/subtypes.py: the site's
   own code, so the card refresh and the site's update at startup cannot come to differ.

   Usage:  <engine> tests/subtypes.js -- <scripts.json> <input.json>
   input:  { cards, catalogs, known: { kind: [types] }, today } */
var _args;
if (typeof load === 'function' && typeof readFile === 'function') {
  _args = Array.prototype.slice.call(arguments);
} else {
  const fs = require('fs'), vm = require('vm');
  globalThis.readFile = (p) => fs.readFileSync(p, 'utf8');
  globalThis.load = (p) => vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
  globalThis.print = (...a) => console.log(...a);
  _args = process.argv.slice(2).filter(a => a !== '--');
}
for (const f of JSON.parse(readFile(_args[0]))) load(f);
const input = JSON.parse(readFile(_args[1]));
const out = deriveSubtypes(input.cards, input.catalogs, input.known, input.today);

// A new card type needs code (which subtypes are its own), so it is reported, not guessed at.
const unknown = {};
for (const card of input.cards) {
  if (!_isSanctionedCard(card)) continue;
  for (const line of _typeLinesOf(card)) {
    for (const w of line.split(' — ')[0].split(/\s+/)) {
      if (!TypeCatalog.isCardType(w) && !TypeCatalog.isSupertype(w) && w !== 'Token' && !unknown[w]) unknown[w] = card.name;
    }
  }
}
out.unknownTypeWords = unknown;
print('@@SUBTYPES ' + JSON.stringify(out));
