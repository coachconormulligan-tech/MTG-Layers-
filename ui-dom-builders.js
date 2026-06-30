/* ui-dom-builders.js — small shared helpers for building option lists and other
   repeated DOM fragments. Keeps modal / target-picker code free of hand-rolled
   <option value="${id}" selected>…</option> template strings. */

/* Build a list of <option> elements for a set of players, with one optional pre-selected
   id. Used by the three near-identical "target opponent / target player / enchanted player"
   dropdowns in ui-targeting.js. */
function buildPlayerSelectOptions(players, currentId) {
  return (players || []).map(pl =>
    `<option value="${escapeAttr(pl.id)}" ${pl.id === currentId ? 'selected' : ''}>${escapeHtml(pl.name)}</option>`
  ).join('');
}
