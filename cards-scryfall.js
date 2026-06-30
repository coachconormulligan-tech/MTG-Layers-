/* cards-scryfall.js — Scryfall API search + card fetch. */

/* [KEY: SCRYFALL] */
let _scryfallNextPage = null;
let _scryfallLastResults = [];

async function searchScryfall(query, opts = {}) {
  const { loadMore = false, searchTokens = false } = opts;
  let url;
  if (loadMore && _scryfallNextPage) {
    url = _scryfallNextPage;
  } else {
    let q = query;
    if (searchTokens) q = `is:token ${q}`;
    url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=name&unique=cards`;
    _scryfallLastResults = [];
  }
  try {
    const res = await fetch(url);
    if (!res.ok) return _scryfallLastResults;
    const data = await res.json();
    const newCards = data.data || [];
    _scryfallNextPage = data.has_more ? data.next_page : null;
    _scryfallLastResults = loadMore ? [..._scryfallLastResults, ...newCards] : newCards;
    return _scryfallLastResults;
  } catch (e) {
    console.error('Scryfall search failed:', e);
    return _scryfallLastResults;
  }
}

function hasMoreScryfallResults() {
  return !!_scryfallNextPage;
}

async function fetchCardByName(name) {
  const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('Scryfall fetch failed:', e);
    return null;
  }
}

async function fetchTokenByName(name) {
  const results = await searchScryfall(`!"${name}"`, { searchTokens: true });
  // Prefer a single-faced token whose name matches exactly
  const exact = results.find(c => c.name === name);
  if (exact) return exact;
  // For DFC tokens (e.g. "Illusion // Saproling"), hoist the matching face's image_uris
  for (const c of results) {
    if (!c.card_faces) continue;
    const face = c.card_faces.find(f => f.name === name);
    if (face && face.image_uris) return { ...c, name: face.name, image_uris: face.image_uris };
  }
  return results[0] || null;
}
