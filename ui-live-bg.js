/* [KEY: LIVE-BG]
   Live text on the card's own image: the printed words are erased, and nothing
   else is touched.

   renderLivePatches (ui-battlefield.js) places its patches by the usual frame
   geometry and blurs the print beneath them. That is only a first guess, shown
   until the card's image has been read here. Then, for each box that gets new
   text (text box, type bar, power/toughness plate):

     1. the ground of the box is estimated without its ink (a rank filter: ink
        is darker than the ground, so the 80th-percentile colour of a window
        wider than a stroke is the ground);
     2. every pixel clearly darker than that ground is ink, and so are the few
        pixels around it (anti-aliasing and JPEG ringing);
     3. each ink pixel is refilled from the pixels around it that are not ink.

   The patch is transparent everywhere else, so every pixel that was not ink is
   still the card's own pixel: there is no edge to see. The text box's sides are
   found from its border line in the image (an edge that runs straight along the
   whole side), and the patch stays a few pixels inside it.

   Any part that cannot be read keeps the blurred first guess. Display only.
   ========================================================================= */

const _liveBg = new Map();      // key -> { done, result }
const _liveBgQueue = [];
let _liveBgBusy = false;

function _lbLum(d, i) { return (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; }

/* Rank filter of the rectangle [x0,x1) x [y0,y1): for each pixel and channel,
   the value at quantile q (0.5 = median) of a window of 2r+1 by 2ry+1 pixels
   (Huang's sliding histogram). The window reads the whole image. */
function _lbRank(d, W, H, x0, y0, x1, y1, r, ry, q) {
  const w = x1 - x0, h = y1 - y0;
  const out = new Uint8ClampedArray(w * h * 4);
  const hist = new Int32Array(768);
  const med = [0, 0, 0], lt = [0, 0, 0];
  for (let y = y0; y < y1; y++) {
    hist.fill(0);
    med[0] = med[1] = med[2] = 0; lt[0] = lt[1] = lt[2] = 0;
    let n = 0;
    const ya = Math.max(0, y - ry), yb = Math.min(H - 1, y + ry);
    const col = (x, sign) => {
      if (x < 0 || x >= W) return;
      for (let yy = ya; yy <= yb; yy++) {
        const i = (yy * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const v = d[i + c];
          hist[c * 256 + v] += sign;
          if (v < med[c]) lt[c] += sign;
        }
        n += sign;
      }
    };
    for (let x = x0 - r; x <= x0 + r; x++) col(x, 1);
    for (let x = x0; x < x1; x++) {
      if (x > x0) { col(x - r - 1, -1); col(x + r, 1); }
      const th = Math.min(n - 1, Math.floor(n * q)), o = ((y - y0) * w + (x - x0)) * 4;
      for (let c = 0; c < 3; c++) {
        const hc = c * 256;
        let m = med[c], l = lt[c];
        while (l > th) { m--; l -= hist[hc + m]; }
        while (l + hist[hc + m] <= th) { l += hist[hc + m]; m++; }
        med[c] = m; lt[c] = l; out[o + c] = m;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/* Erase the ink in the rectangle [x0,x1) x [y0,y1) of the image. Returns a PNG
   data URL of that rectangle, transparent except where ink was, which holds the
   ground refilled from the non-ink pixels around it.
   r, ry: half-size of the window the ground is estimated over;
   grow: how far the ink mask is widened; keep: an [x, y] corner from which
   nothing is erased (the P/T box in the text box's corner); sidesOnly: frame
   is looked for along the left and right edges only (true), or along the
   sides named ('rb'), or as on a type bar ('bar', see _lbErasePixels); light: the print is white on a dark ground (a Room's
   type bar), so the image is read as its negative, or 'both': white print
   with a dark shadow. */
function _lbErase(d, W, H, x0, y0, x1, y1, r, ry, grow, keep, sidesOnly, light) {
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  let im;
  if (light === 'both') {
    // White print with a dark shadow (the 1997 frame's type line): the white
    // is erased first, then the shadow from what is left.
    im = _lbErasePixels(d, W, H, x0, y0, x1, y1, r, ry, grow, keep, sidesOnly, true);
    const d2 = new Uint8ClampedArray(d);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4, i = ((y0 + y) * W + x0 + x) * 4;
        if (im.data[o + 3]) { d2[i] = im.data[o]; d2[i + 1] = im.data[o + 1]; d2[i + 2] = im.data[o + 2]; }
      }
    }
    const under = _lbErasePixels(d2, W, H, x0, y0, x1, y1, r, ry, grow, keep, sidesOnly, false, 26);
    for (let o = 0; o < im.data.length; o += 4) {
      if (under.data[o + 3]) { im.data[o] = under.data[o]; im.data[o + 1] = under.data[o + 1]; im.data[o + 2] = under.data[o + 2]; im.data[o + 3] = 255; }
    }
  } else {
    im = _lbErasePixels(d, W, H, x0, y0, x1, y1, r, ry, grow, keep, sidesOnly, light);
  }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(im, 0, 0);
  return cv.toDataURL('image/png');
}

/* The pixels of _lbErase: an ImageData of the rectangle, opaque where ink was.
   clear: how much darker than the ground a pixel must be to count as print. */
function _lbErasePixels(d, W, H, x0, y0, x1, y1, r, ry, grow, keep, sidesOnly, light, clear) {
  const w = x1 - x0, h = y1 - y0;
  const adapt = !light && !clear;
  const overArt = light === 'adapt';     // white print on a see-through box: the art shows under it
  clear = clear || 40;
  if (light) {
    const neg = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i++) neg[i] = 255 - d[i];
    d = neg;
  }
  const ground = _lbRank(d, W, H, x0, y0, x1, y1, r, ry, 0.8);
  const kept = (x, y) => keep && x0 + x >= keep[0] && y0 + y >= keep[1];
  // Darker than the ground: clearly (ink, or the frame) or only a little (a
  // soft edge, a shadow, the grain of the box).
  const dark = new Uint8Array(w * h);            // 1 = a little darker, 2 = clearly darker
  const gaps = new Int16Array(w * h), hist = new Int32Array(256);
  let counted = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (kept(x, y)) continue;
      const gap = Math.max(0, _lbLum(ground, (y * w + x) * 4) - _lbLum(d, ((y0 + y) * W + x0 + x) * 4));
      gaps[y * w + x] = gap; hist[gap]++; counted++;
    }
  }
  // A mottled box (the parchment of the 1993 frames) is itself darker than
  // its ground in half its pixels: the median gap is its grain, since print
  // covers far less than half a box. On such a box print has to be darker.
  let faint = 14;
  if (overArt) {
    // The art under a see-through box is lighter than its ground too, in
    // shapes that reach the box's sides. The print is far lighter still: what
    // counts as print is set by the print itself (the top 2% of the box).
    let hi = 255;
    for (let n = 0; hi > 0 && n + hist[hi] <= counted * 0.02; hi--) n += hist[hi];
    clear = Math.max(clear, Math.round(hi * 0.5)); faint = Math.max(faint, Math.round(hi * 0.25));
  }
  if (adapt) {
    let grain = 0;
    for (let n = 0; grain < 255 && n + hist[grain] <= counted / 2; grain++) n += hist[grain];
    const extra = Math.min(8, Math.max(0, grain - 9));
    faint += 2 * extra; clear += 4 * extra;
  }
  for (let k = 0; k < gaps.length; k++) if (gaps[k] > faint) dark[k] = gaps[k] > clear ? 2 : 1;
  const near = (k, fn) => {
    const x = k % w, y = (k - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((dx || dy) && xx >= 0 && xx < w && yy >= 0 && yy < h) fn(yy * w + xx);
      }
    }
  };
  // Printed words are islands inside their box. Clearly dark pixels joined to
  // the patch's own edge (or to the kept corner) are the frame coming in: a
  // border line, the plate's rim, the holofoil stamp. They stay, and so does
  // everything within a few pixels of them (their soft edge and shadow).
  const frame = new Uint8Array(w * h);           // 1 = frame, 2 = beside it
  let front = [];
  const seed = (x, y) => { const k = y * w + x; if (dark[k] === 2 && !frame[k]) { frame[k] = 1; front.push(k); } };
  // (The P/T digits stand as tall as the flat of their plate, so there only
  // what comes in from the left or right is frame.)
  // ('bar': a type bar. A letter's tail (p, g, y) can reach the patch's last
  // row, and a first letter or the shadow of the bar's end its first column;
  // each was taken for frame with every letter joined to it ("Shapeshifter"
  // kept its "ap", an 8th Edition "Enchantment" its "En"). There only the set
  // symbol's side, the right, is followed as usual. Along the other three
  // sides only a long run of dark is frame, a border line; and nothing is
  // followed out of the two rows or columns at those sides into the patch, so
  // a line there keeps no letter that touches it.)
  // (A side named in capitals is such a side, 'bar' is 'rTBL'. The page of a
  // prepare card ends its lines at the book's spine: 'R'.)
  const from = sidesOnly === true ? 'lr' : sidesOnly === 'bar' ? 'rTBL' : (sidesOnly || 'lrtb');
  const strict = /[TBLR]/.test(from);
  const inEdge = (k) => {
    const x = k % w, y = (k - x) / w;
    return (y < 2 && from.includes('T')) || (y >= h - 2 && from.includes('B')) || (x < 2 && from.includes('L')) || (x >= w - 2 && from.includes('R'));
  };
  for (let x = 0; x < w; x++) { if (from.includes('t')) seed(x, 0); if (from.includes('b')) seed(x, h - 1); }
  for (let y = 0; y < h; y++) { if (from.includes('l')) seed(0, y); if (from.includes('r')) seed(w - 1, y); }
  if (keep) {
    const kx = keep[0] - x0, ky = keep[1] - y0;
    // (Only what goes on into the corner: the last word of a line that ends
    // right above the P/T box touches the corner too, and is print.)
    // (dx, dy: the way into the corner. A glyph's soft underside is a pixel deep; the frame goes on.)
    const darkAt = (x, y, k) => x < w && y < h && _lbLum(ground, k * 4) - _lbLum(d, ((y0 + y) * W + x0 + x) * 4) > clear;
    const goesOn = (x, y, k, dx, dy) => darkAt(x, y, k) && darkAt(x + 2 * dx, y + 2 * dy, k);
    if (kx > 0 && kx < w) for (let y = Math.max(0, ky); y < h; y++) if (goesOn(kx, y, y * w + kx - 1, 1, 0)) seed(kx - 1, y);
    if (ky > 0 && ky < h) for (let x = Math.max(0, kx); x < w; x++) if (goesOn(x, ky, (ky - 1) * w + x, 0, 1)) seed(x, ky - 1);
    if (kx > 0 && kx < w && ky > 0 && ky < h && goesOn(kx, ky, (ky - 1) * w + kx - 1, 1, 1)) seed(kx - 1, ky - 1);
  }
  const all = [];
  while (front.length) {
    const k = front.pop();
    all.push(k);
    near(k, (j) => { if (dark[j] === 2 && !frame[j] && !(strict && inEdge(k) && !inEdge(j))) { frame[j] = 1; front.push(j); } });
  }
  if (strict) {
    // (along: the run's length in pixels along a side; at: the pixel n along it)
    const runs = (n, least, at) => {
      for (let i = 0, start = -1; i <= n; i++) {
        const on = i < n && dark[at(i)] === 2;
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          if (i - start >= least) for (let q = start; q < i; q++) { const k = at(q); if (!frame[k]) { frame[k] = 1; front.push(k); } }
          start = -1;
        }
      }
    };
    const least = Math.max(8, Math.round(0.035 * W));
    if (from.includes('T')) runs(w, least, (i) => i);
    if (from.includes('B')) runs(w, least, (i) => (h - 1) * w + i);
    if (from.includes('L')) runs(h, Math.round(h * 0.6), (i) => i * w);
    if (from.includes('R')) runs(h, Math.round(h * 0.6), (i) => i * w + w - 1);
    while (front.length) {
      const k = front.pop();
      all.push(k);
      near(k, (j) => { if (dark[j] === 2 && !frame[j] && inEdge(j)) { frame[j] = 1; front.push(j); } });
    }
  }
  front = all;
  for (let pass = 0; pass < 4 && front.length; pass++) {
    const next = [];
    for (const k of front) near(k, (j) => { if (!frame[j]) { frame[j] = 2; next.push(j); } });
    front = next;
  }
  // Ink: the clearly dark pixels that are not frame, and the slightly dark
  // ones that hang on to them (a glyph's soft edge, a symbol's disc), followed
  // for a few pixels only, so the grain of the box is left alone.
  let mask = new Uint8Array(w * h);
  front = [];
  for (let k = 0; k < dark.length; k++) if (dark[k] === 2 && !frame[k]) { mask[k] = 1; front.push(k); }
  for (let pass = 0; pass < 4 && front.length; pass++) {
    const next = [];
    for (const k of front) near(k, (j) => { if (dark[j] && !frame[j] && !mask[j]) { mask[j] = 1; next.push(j); } });
    front = next;
  }
  // Widen the mask: a glyph's soft edge and the ringing around it are ink too
  for (let pass = 0; pass < grow; pass++) {
    const next = new Uint8Array(mask);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] || frame[y * w + x] || kept(x, y)) continue;
        if ((x > 0 && mask[y * w + x - 1]) || (x < w - 1 && mask[y * w + x + 1])
          || (y > 0 && mask[(y - 1) * w + x]) || (y < h - 1 && mask[(y + 1) * w + x])) next[y * w + x] = 1;
      }
    }
    mask = next;
  }
  // Summed-area tables of the non-ink pixels: their colour and their count
  const sw = w + 1, sat = [0, 1, 2, 3].map(() => new Float64Array(sw * (h + 1)));
  for (let y = 0; y < h; y++) {
    const row = [0, 0, 0, 0];
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x] && !kept(x, y)) {
        const i = ((y0 + y) * W + x0 + x) * 4;
        row[0] += d[i]; row[1] += d[i + 1]; row[2] += d[i + 2]; row[3] += 1;
      }
      const o = (y + 1) * sw + x + 1;
      for (let c = 0; c < 4; c++) sat[c][o] = sat[c][o - sw] + row[c];
    }
  }
  const box = (c, xa, ya, xb, yb) => sat[c][yb * sw + xb] - sat[c][ya * sw + xb] - sat[c][yb * sw + xa] + sat[c][ya * sw + xa];
  // The mean of the non-ink pixels within R of (x, y), or null when there are too few
  const meanAt = (x, y, R, least, out) => {
    const xa = Math.max(0, x - R), ya = Math.max(0, y - R), xb = Math.min(w, x + R + 1), yb = Math.min(h, y + R + 1);
    const n = box(3, xa, ya, xb, yb);
    if (n < least) return false;
    for (let c = 0; c < 3; c++) out[c] = box(c, xa, ya, xb, yb) / n;
    return true;
  };
  // First guess for each ink pixel: the mean of the non-ink pixels around it
  const val = new Float32Array(w * h * 3), list = [], m3 = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (mask[k]) {
        list.push(k);
        if (!(meanAt(x, y, 3, 8, m3) || meanAt(x, y, 6, 8, m3) || meanAt(x, y, 12, 8, m3))) for (let c = 0; c < 3; c++) m3[c] = ground[k * 4 + c];
      } else if (kept(x, y) || !meanAt(x, y, 1, 1, m3)) {
        continue;
      }
      // (A non-ink pixel stands for itself and its neighbours: one speck does not streak.)
      for (let c = 0; c < 3; c++) val[k * 3 + c] = m3[c];
    }
  }
  // Then the ground is carried across each gap from all its sides (each ink
  // pixel settles at the mean of its four neighbours), so a gap in a mottled
  // box shades from one side to the other and is no flat square.
  const usable = (x, y) => x >= 0 && x < w && y >= 0 && y < h && (mask[y * w + x] || !kept(x, y));
  for (let pass = 0; pass < 60; pass++) {
    for (let q = 0; q < list.length; q++) {
      const k = list[pass & 1 ? list.length - 1 - q : q], x = k % w, y = (k - x) / w;
      let n = 0, a = 0, b = 0, c = 0;
      if (usable(x - 1, y)) { const j = (k - 1) * 3; a += val[j]; b += val[j + 1]; c += val[j + 2]; n++; }
      if (usable(x + 1, y)) { const j = (k + 1) * 3; a += val[j]; b += val[j + 1]; c += val[j + 2]; n++; }
      if (usable(x, y - 1)) { const j = (k - w) * 3; a += val[j]; b += val[j + 1]; c += val[j + 2]; n++; }
      if (usable(x, y + 1)) { const j = (k + w) * 3; a += val[j]; b += val[j + 1]; c += val[j + 2]; n++; }
      if (n) { val[k * 3] = a / n; val[k * 3 + 1] = b / n; val[k * 3 + 2] = c / n; }
    }
  }
  // And the box's grain is put back: what a non-ink pixel nearby differs by
  // from the pixels around it (never more than faint print would).
  const im = new ImageData(w, h);
  for (const k of list) {
    const x = k % w, y = (k - x) / w, o = k * 4;
    let g0 = 0, g1 = 0, g2 = 0;
    for (let t = 0; t < 8; t++) {
      const hash = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(t + 1, 83492791)) >>> 0;
      const sx = x + (hash % 41) - 20, sy = y + ((hash >>> 8) % 41) - 20;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h || mask[sy * w + sx] || frame[sy * w + sx] || kept(sx, sy)) continue;
      if (!meanAt(sx, sy, 2, 6, m3)) continue;
      const i = ((y0 + sy) * W + x0 + sx) * 4, lim = faint;
      g0 = Math.max(-lim, Math.min(lim, d[i] - m3[0])); g1 = Math.max(-lim, Math.min(lim, d[i + 1] - m3[1])); g2 = Math.max(-lim, Math.min(lim, d[i + 2] - m3[2]));
      break;
    }
    const v = [val[k * 3] + g0, val[k * 3 + 1] + g1, val[k * 3 + 2] + g2];
    for (let c = 0; c < 3; c++) im.data[o + c] = light ? 255 - v[c] : v[c];
    im.data[o + 3] = 255;
  }
  return im;
}

/* A box's border line: the position within `range` pixels of `guess` where the
   image steps most strongly from dark to light going into the box, averaged
   along the whole side (text never lines up along a side, a border does).
   side: 'l' | 'r' | 't' | 'b'; a, b: the span along the side to average over.
   Returns the first pixel inside the box, or null when no line stands out. */
function _lbEdge(d, W, H, side, guess, range, a, b, any) {
  const horiz = side === 'l' || side === 'r';
  const inward = (side === 'l' || side === 't') ? 1 : -1;
  const lim = horiz ? W : H;
  let best = null, bestScore = 0;
  for (let p = Math.max(3, guess - range); p <= Math.min(lim - 4, guess + range); p++) {
    let sum = 0, n = 0;
    for (let q = a; q < b; q += 2) {
      const at = (k) => horiz ? _lbLum(d, (q * W + p + k * inward) * 4) : _lbLum(d, ((p + k * inward) * W + q) * 4);
      sum += (at(0) + at(1) + at(2)) - (at(-1) + at(-2) + at(-3));
      n++;
    }
    // (any: a step either way, for a dark box inside a pale line)
    const score = any ? Math.abs(sum / (3 * n)) : sum / (3 * n);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 5 ? best : null;
}

/* Where each frame prints its boxes, as fractions of the image (measured on
   Scryfall's images): text = the text box, plate = the flat inside of the P/T
   box, cut = the corner of the text box the P/T box covers, type = the part of
   the type bar that holds the words (it stops before the set symbol), name =
   the title bar up to its right end (the mana cost is found in it). The 1993
   and 1997 frames ('old') print the type line and P/T in white straight on
   the frame, in the same places on both. */
const LB_FRAME = {
  '2015': { text: [0.076, 0.631, 0.924, 0.922], plate: [0.791, 0.903, 0.930, 0.937], cut: [0.766, 0.889], type: [0.072, 0.569, 0.862, 0.611], name: [0.074, 0.053, 0.940, 0.097] },
  '2003': { text: [0.084, 0.628, 0.910, 0.899], plate: [0.752, 0.900, 0.908, 0.935], cut: [0.726, 0.886], type: [0.086, 0.571, 0.861, 0.609], name: [0.082, 0.057, 0.930, 0.101] },      // (to row 413 of 680: a letter's tail ends there, the bar's line is at 415 or 416)
  // White words with a dark shadow, straight on the frame (light: 'both');
  // the type line stops before the set symbol, which may come in from the right.
  'old':  { text: [0.107, 0.600, 0.893, 0.884], plate: [0.803, 0.899, 0.934, 0.941], type: [0.082, 0.559, 0.877, 0.594], light: 'both', typeSeeds: 'r', name: [0.090, 0.046, 0.925, 0.087] },
  // The "future" frame (Future Sight, and later printings in its style): the
  // text box has bowed sides and a rounded foot, and the P/T box sits under
  // it, not in its corner. A coloured card prints its type line and P/T in
  // white on a dark bar and plate, a pale card in black: each is read off the
  // image (fixed: the places are used as measured, no border line is looked for).
  // (A full line of text ends 7 px from the box's side at mid height: the
  // patch runs to the side there, and where the side bows in it is frame.)
  // The bar's left end casts a soft shadow that reaches the first letter: only
  // the set symbol, on the right, is frame there.
  'future': { text: [0.090, 0.631, 0.918, 0.884], plate: [0.781, 0.896, 0.920, 0.946], type: [0.119, 0.568, 0.862, 0.616], fixed: true, typeSeeds: 'r' },
};

/* The type bar, found in the image: the pale band about a type line high, with
   a dark line above and below it across the card and words on it. Tokens,
   Sagas, Classes and tall planeswalkers print it at different heights. Returns
   [first row inside, last row inside] or null. bold: the band's evenness is
   judged by each row's ground and not its mean (see below); from, to: where
   the bar's top is looked for, as fractions of the height. */
function _lbFindBar(d, W, H, bold, from, to) {
  const a = Math.round(W * 0.12), b = Math.round(W * 0.80);
  const row = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let sum = 0, n = 0;
    for (let x = a; x < b; x += 2) { sum += _lbLum(d, (y * W + x) * 4); n++; }
    row[y] = sum / n;
  }
  // A row's ground, even under print: its upper quartile. (A long bold type
  // line, "Token Artifact Creature — Construct", inks half of a row: by the
  // rows' means the band is not even, and half of it or the gap under it was
  // taken for the bar. Used for the vanilla tokens Scryfall calls full-art.)
  const hiOf = new Map(), samples = new Uint8Array(Math.ceil((b - a) / 2));
  const hi = (y) => {
    if (hiOf.has(y)) return hiOf.get(y);
    let n = 0;
    for (let x = a; x < b; x += 2) samples[n++] = _lbLum(d, (y * W + x) * 4);
    const v = samples.subarray(0, n).slice().sort()[Math.floor(n * 0.75)];
    hiOf.set(y, v);
    return v;
  };
  const into = (y, dir) => (row[y] + row[y + dir] + row[y + 2 * dir]) / 3 - Math.min(row[y - dir], row[y - 2 * dir]);
  let best = null, bestScore = 0;
  for (let y1 = Math.round(H * (from || 0.45)); y1 < Math.round(H * (to || 0.90)); y1++) {
    const top = into(y1, 1);
    if (top < 25) continue;
    for (let hgt = Math.round(H * 0.034); hgt <= Math.round(H * 0.058); hgt++) {
      const y2 = y1 + hgt;
      if (y2 + 3 >= H) break;
      const score = Math.min(top, into(y2, -1));
      if (score <= bestScore) continue;
      // The band itself is pale and even, and it has words on it at the left
      let lo = 255;
      for (let y = y1 + 3; y <= y2 - 3; y++) lo = Math.min(lo, bold ? hi(y) : row[y]);
      const ground = Math.min(row[y1 + 1], row[y2 - 1]);
      if (lo < ground - 45) continue;
      let ink = 0;
      for (let y = y1 + 3; y <= y2 - 3; y++) {
        for (let x = Math.round(W * 0.08); x < Math.round(W * 0.5); x++) if (_lbLum(d, (y * W + x) * 4) < ground - 70) ink++;
      }
      if (ink < 40) continue;
      bestScore = score; best = [y1, y2];
    }
  }
  return best;
}

/* Frames whose type bar is found in the image. text: the text column of a
   Saga (left) or a Class (right), as fractions of the image. */
const LB_BAR_FRAME = {
  'pw':    {},
  // A planeswalker on the 2003 frame: its bar's top is at 58% of the height,
  // or at 50% on the tall frame of one with four abilities. (Looked for over
  // the whole card, a pale band between two abilities was taken for it:
  // Liliana of the Dark Realms m14, Sarkhan Vol mma.)
  // (bold: the type line's ink darkens the band's rows on a dim scan. Sarkhan Vol mma.)
  'pw03':  { from: 0.47, to: 0.61, bold: true },
  // under: a token's text box, when it prints one, sits under its type bar
  // (left, gap below the bar, right, bottom); bar: where the bar's words are.
  'token': { plate: [0.791, 0.903, 0.930, 0.937], cut: [0.766, 0.889], under: [0.076, 0.014, 0.924, 0.922] },
  'token03': { plate: [0.752, 0.900, 0.912, 0.944], under: [0.090, 0.018, 0.914, 0.888], bar: [0.085, 0.80] },
  'saga':  { text: [0.058, 0.112, 0.497, 0.836], tight: true },
  'class': { text: [0.498, 0.112, 0.925, 0.836], tight: true },
};

function _liveBgAnalyzeBar(d, W, H, frame, hasPt, hasText, found) {
  const fr = LB_BAR_FRAME[frame];
  const px = (f, dim) => Math.round(f * dim);
  const res = { aspect: H / W };
  const bar = found || _lbFindBar(d, W, H, !!fr.bold, fr.from, fr.to);
  if (bar) {
    res.barTop = bar[0] / H;
    const a = px((fr.bar || [0.075])[0], W), c = px((fr.bar || [0, 0.86])[1], W), b = bar[0] + 2, e = bar[1] - 1;
    res.type = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.05, W), 3, 2, null, true));
  }
  const range = px(0.022, W);
  const side = (s, guess, a, b) => {
    const edge = _lbEdge(d, W, H, s, guess, range, a, b);
    const inward = (s === 'l' || s === 't') ? 1 : -1;
    // A column's words start right at its edge; what is frame there is kept anyway
    return edge === null ? guess + inward * (fr.tight ? 3 : 8) : edge + inward * (fr.tight ? 1 : 4);
  };
  let t = fr.text;
  if (fr.under && bar && hasText && bar[1] < H * 0.80) t = [fr.under[0], bar[1] / H + fr.under[1], fr.under[2], fr.under[3]];
  if (t) {
    const my0 = px(t[1] + (t[3] - t[1]) * 0.2, H), my1 = px(t[1] + (t[3] - t[1]) * 0.8, H);
    const mx0 = px(t[0] + (t[2] - t[0]) * 0.2, W), mx1 = px(t[0] + (t[2] - t[0]) * 0.8, W);
    const x0 = side('l', px(t[0], W), my0, my1), x1 = side('r', px(t[2], W), my0, my1) + 1;
    const y0 = side('t', px(t[1], H), mx0, mx1), y1 = side('b', px(t[3], H), mx0, px(t[0] + (t[2] - t[0]) * 0.42, W)) + 1;
    const keep = (hasPt && fr.cut) ? [px(fr.cut[0], W), px(fr.cut[1], H)] : null;
    // A Case's "To solve" and "Solved" start right at the column's left line:
    // where that line was found, what is dark along it is print. (A Class's
    // level bars reach the right side too; a Saga's badges come in from the left.)
    const leftIsPrint = frame === 'class' && _lbEdge(d, W, H, 'l', px(t[0], W), range, my0, my1) !== null;
    res.text = _lbRect(x0, y0, x1, y1, W, H, _lbErase(d, W, H, x0, y0, x1, y1, px(0.02, W), px(0.02, W), 3, keep, leftIsPrint ? 'rtb' : false));
  }
  if (fr.plate && hasPt) {
    const f = fr.plate, a = px(f[0], W), b = px(f[1], H), c = px(f[2], W), e = px(f[3], H);
    res.pt = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.03, W), 2, 2, null, true));
  }
  return res;
}

/* Frames read from measured places. Cards printed on their side are read
   turned upright (fractions of the turned image, 680 by 488); upright: the
   card is printed upright. type: the words of the type bar; light: they are
   white on a dark bar (true), or white with a dark shadow ('both');
   typeSeeds: the sides of that patch frame may come in from; texts: the text
   boxes, a Room's two doors left to right; plate: the printed power and
   toughness; range: how far a text box's side is looked for from its place;
   half: the image is read turned around. */
const LB_SIDE_FRAME = {
  // Every Room prints "Enchantment — Room": only that stretch of the bar is
  // cleaned (the bar is marbled, and its pale veins would pass for print).
  'room': { type: [0.094, 0.549, 0.36, 0.590], light: true, typeSeeds: 'r', texts: [[0.097, 0.705, 0.484, 0.949], [0.556, 0.705, 0.941, 0.949]] },
  // cut: the corner of the text box that holds the back face's power and
  // toughness and the defense shield.
  'battle': { type: [0.118, 0.586, 0.86, 0.648], texts: [[0.122, 0.672, 0.929, 0.955]], cut: [0.865, 0.80] },
  // The promo tokens of 2001 to 2003 (mpr, pr2, p03): the lower part of the
  // 1997 card frame. Type line and power/toughness are white with a shadow,
  // straight on the coloured panel; the small text box differs by colour.
  'token97': { upright: true, type: [0.148, 0.666, 0.79, 0.699], light: 'both', typeSeeds: 'r', texts: [[0.160, 0.706, 0.830, 0.862]], plate: [0.762, 0.878, 0.881, 0.922], range: 0.025 },
  // A flip card on the 2003 frame (Kamigawa): each half has a low text box,
  // and under it a type bar that ends in the power/toughness box. A flipped
  // card ('...b') is read turned around (half: true), as the battlefield
  // shows it: its half sits 19 px lower, under the artist's line. A text
  // box's foot is the top line of the type bar, and the name bar's lines are
  // a few pixels above its top: the box is used as measured (fixed: its
  // inside, no border line is looked for; a long dark run along a side is
  // frame, a letter that touches a side is print).
  'flip03':  { upright: true, fixed: true, type: [0.074, 0.253, 0.795, 0.299], typeSeeds: 'bar', texts: [[0.074, 0.1265, 0.910, 0.2426]], plate: [0.807, 0.257, 0.918, 0.301] },
  'flip03b': { upright: true, fixed: true, half: true, type: [0.078, 0.281, 0.795, 0.325], typeSeeds: 'bar', texts: [[0.088, 0.150, 0.924, 0.2647]], plate: [0.807, 0.287, 0.918, 0.329] },
  // The same on the 2015 frame (Nezumi Graverobber cm2, Budoka Gardener c18):
  // the first half's type bar holds the set symbol before the P/T box.
  'flip15':  { upright: true, fixed: true, type: [0.078, 0.2353, 0.738, 0.2838], typeSeeds: 'bar', texts: [[0.076, 0.0956, 0.926, 0.225]], plate: [0.822, 0.2426, 0.926, 0.2838] },
  'flip15b': { upright: true, fixed: true, half: true, type: [0.078, 0.3132, 0.803, 0.3618], typeSeeds: 'bar', texts: [[0.074, 0.1735, 0.926, 0.3029]], plate: [0.822, 0.3206, 0.926, 0.3618] },
};

function _liveBgAnalyzeSide(d, W, H, frame, hasPt) {
  const fr = LB_SIDE_FRAME[frame];
  const px = (f, dim) => Math.round(f * dim);
  const res = { aspect: H / W, texts: [] };
  if (fr.type) {
    const f = fr.type, a = px(f[0], W), b = px(f[1], H), c = px(f[2], W), e = px(f[3], H);
    res.type = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.04, W), 3, 2, null, fr.typeSeeds || false, fr.light));
  }
  if (fr.plate && hasPt) {
    const f = fr.plate, a = px(f[0], W), b = px(f[1], H), c = px(f[2], W), e = px(f[3], H);
    res.pt = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.03, W), 3, 2, null, 'none', fr.light));
  }
  const range = px(fr.range || 0.016, W);
  for (const t of fr.texts || []) {
    const my0 = px(t[1] + (t[3] - t[1]) * 0.2, H), my1 = px(t[1] + (t[3] - t[1]) * 0.8, H);
    const mx0 = px(t[0] + (t[2] - t[0]) * 0.2, W), mx1 = px(t[0] + (t[2] - t[0]) * 0.8, W);
    // Each side from its border line; where none stands out, well inside the
    // measured place, and what is dark along that side is taken for frame.
    let seeds = '';
    const side = (s, guess, a, b) => {
      const edge = _lbEdge(d, W, H, s, guess, range, a, b);
      const inward = (s === 'l' || s === 't') ? 1 : -1;
      if (edge === null) { seeds += s; return guess + inward * 6; }
      return edge + inward * 2;
    };
    const x0 = fr.fixed ? px(t[0], W) : side('l', px(t[0], W), my0, my1), x1 = fr.fixed ? px(t[2], W) : side('r', px(t[2], W), my0, my1) + 1;
    const y0 = fr.fixed ? px(t[1], H) : side('t', px(t[1], H), mx0, mx1), y1 = fr.fixed ? px(t[3], H) : side('b', px(t[3], H), mx0, mx1) + 1;
    if (fr.fixed) seeds = 'LRTB';
    const keep = fr.cut ? [px(fr.cut[0], W), px(fr.cut[1], H)] : null;
    res.texts.push(_lbRect(x0, y0, x1, y1, W, H, _lbErase(d, W, H, x0, y0, x1, y1, px(0.015, W), px(0.015, W), 3, keep, seeds || 'none')));
  }
  return res;
}

/* The title bar: where the name ends and the mana cost begins. The cost's
   right edge is the rightmost column with print (a frame line, print in nearly
   every row, is not); its symbols are each about 2.65% of the card wide, so
   all but part of the first are passed over, and the cost starts after the
   first gap of 1.2% of the card. cost: how many mana symbols it prints.
   Returns the patch's right end, or null. */
function _lbNameEnd(d, W, H, x0, y0, x1, y1, cost) {
  if (!cost) return x1;
  const h = y1 - y0, hist = new Uint32Array(256);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[_lbLum(d, (y * W + x) * 4)]++;
  let acc = 0, med = 0;
  for (let i = 0, n = (y1 - y0) * (x1 - x0); i < 256; i++) { acc += hist[i]; if (acc >= n / 2) { med = i; break; } }
  const ink = (x) => { let c = 0; for (let y = y0; y < y1; y++) if (Math.abs(_lbLum(d, (y * W + x) * 4) - med) > 55) c++; return c; };
  let x = x1 - 1;
  while (x > x0 && (ink(x) === 0 || ink(x) > h * 0.85)) x--;
  x -= Math.round(cost * 0.0265 * W * 0.8);
  const gap = Math.max(4, Math.round(0.012 * W));
  let run = 0;
  for (; x > x0; x--) {
    if (ink(x) === 0) { if (++run >= gap) break; } else run = 0;
  }
  return x > x0 ? x + run - 2 : null;
}

function _lbRect(x0, y0, x1, y1, W, H, url) {
  return url ? { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H, url } : null;
}

/* A showcase or borderless printing ('show'): is a region of the image a box
   with print on it? Returns { plain: the share of its pixels near its median
   brightness, light: the print is lighter than the ground }. */
function _lbRegion(d, W, H, f) {
  const x0 = Math.round(f[0] * W), y0 = Math.round(f[1] * H), x1 = Math.round(f[2] * W), y1 = Math.round(f[3] * H);
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { hist[_lbLum(d, (y * W + x) * 4)]++; n++; }
  let acc = 0, med = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n / 2) { med = i; break; } }
  let near = 0, above = 0, below = 0;
  for (let i = 0; i < 256; i++) {
    if (Math.abs(i - med) <= 22) near += hist[i];
    else if (i > med + 50) above += hist[i];
    else if (i < med - 50) below += hist[i];
  }
  // Over dark art (black hair under a see-through box) more pixels are far
  // below the median than the thin white print is above it. Print is thin:
  // pixels 40 lighter than both pixels four to their left and right against
  // pixels 40 darker than both say which it is, when they say it clearly.
  let thinLight = 0, thinDark = 0;
  for (let y = y0; y < y1; y++) for (let x = x0 + 4; x < x1 - 4; x++) {
    const l = _lbLum(d, (y * W + x) * 4), a = _lbLum(d, (y * W + x - 4) * 4), c = _lbLum(d, (y * W + x + 4) * 4);
    if (l - Math.max(a, c) > 40) thinLight++; else if (Math.min(a, c) - l > 40) thinDark++;
  }
  let light = above > below;
  if (thinLight + thinDark >= 40) {
    if (thinLight >= thinDark * 1.25) light = true; else if (thinDark >= thinLight * 1.25) light = false;
  }
  return { plain: near / n, light, med, thin: thinLight + thinDark };
}

/* A showcase or borderless printing ('show'): how many pixels lower (or, if
   negative, higher) than the usual place its type line is printed. The rows of
   the words' small letters hold print in a quarter to three quarters of their
   pixels (a frame line holds it in nearly all), 9 to 16 rows of 680 together; on the
   usual frame their middle is 55% down the measured place. Returns null when
   no such rows are found: no type line is printed there. */
function _lbTypeShift(d, W, H, f, light) {
  const x0 = Math.round(f[0] * W) + 4, x1 = Math.round((f[0] + (f[2] - f[0]) * 0.6) * W);
  // (As much as 5% of the card higher: the dragon frames of 2025 have a band
  // of ornament between the type bar and the text box.)
  const yA = Math.round((f[1] - 0.06) * H), yB = Math.round((f[3] + 0.025) * H);
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = Math.round(f[1] * H); y < Math.round(f[3] * H); y++) for (let x = x0; x < x1; x++) { hist[_lbLum(d, (y * W + x) * 4)]++; n++; }
  let acc = 0, med = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n / 2) { med = i; break; } }
  const usual = (f[1] + (f[3] - f[1]) * 0.55) * H;
  const share = [];
  for (let y = yA; y < yB; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) { const l = _lbLum(d, (y * W + x) * 4); if (light ? l > med + 50 : l < med - 50) c++; }
    share.push(c / (x1 - x0));
  }
  // (A short line, "Creature" alone, fills far less of a row than a long one.)
  for (const least of [0.25, 0.12, 0.06]) {
    let best = null, start = -1;
    for (let i = 0; i <= share.length; i++) {
      const words = i < share.length && share[i] >= least && share[i] <= 0.75;
      if (words && start < 0) start = i;
      if (!words && start >= 0) {
        const len = i - start, mid = yA + (start + i - 1) / 2;
        if (len >= 0.013 * H && len <= 0.024 * H && (best === null || Math.abs(mid - usual) < Math.abs(best - usual))) best = mid;
        start = -1;
      }
    }
    if (best !== null) {
      const dy = Math.round(best - usual);
      return Math.abs(dy) >= 3 ? dy : 0;
    }
  }
  return null;
}

function _liveBgAnalyze(img, frame, hasPt, hasText, ind, page, cost) {
  const show = frame === 'show';
  let fr = LB_FRAME[show ? '2015' : frame];
  // An Adventure, an Omen or a prepare card: the text box is an open book, and
  // the card's own rules are on one page of it (page 'r': the right one, from
  // the spine at 50.2% of the width; 'l': the left one, up to 49.2%). The other
  // page holds the spell and stays as printed. A prepare card's P/T box is in
  // the spell's page.
  if (fr && page === 'r') fr = { ...fr, text: [0.502, fr.text[1], fr.text[2], 0.917] };
  if (fr && page === 'l') fr = { ...fr, text: [fr.text[0], fr.text[1], 0.492, fr.text[3]], cut: null };
  const measured = LB_SIDE_FRAME[frame];
  const turned = !!measured && !measured.upright;
  if (!fr && !LB_BAR_FRAME[frame] && !measured && frame !== 'showsaga' && frame !== 'showtoken' && frame !== 'showbare') return null;
  // A card printed on its side is read turned upright, as the battlefield shows it
  const W = turned ? img.naturalHeight : img.naturalWidth, H = turned ? img.naturalWidth : img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (turned) { g.translate(W, 0); g.rotate(Math.PI / 2); }
  else if (measured && measured.half) { g.translate(W, H); g.rotate(Math.PI); }      // a flipped flip card
  g.drawImage(img, 0, 0);
  if (turned || (measured && measured.half)) g.setTransform(1, 0, 0, 1, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;       // throws if the image is not readable
  if (measured) return _liveBgAnalyzeSide(d, W, H, frame, hasPt);
  // A showcase or borderless Saga ('showsaga') is read as a Saga when it has
  // the Saga frame: the type bar at its height and a plain, pale text column.
  if (frame === 'showsaga') {
    const bar = _lbFindBar(d, W, H), col = _lbRegion(d, W, H, [0.08, 0.14, 0.47, 0.80]);
    if (!bar || Math.abs(bar[0] / H - 0.848) > 0.02 || col.plain < 0.5 || col.light) return null;
    return _liveBgAnalyzeBar(d, W, H, 'saga', hasPt, hasText);
  }
  // A token Scryfall calls full-art, textless or borderless ('showtoken') is
  // read as a token when it has the token frame: a pale type bar with dark
  // words, and its power and toughness on a plate in the usual corner.
  if (frame === 'showtoken') {
    const bar = _lbFindBar(d, W, H, true);
    if (!bar) return null;
    const rb = _lbRegion(d, W, H, [0.075, (bar[0] + 2) / H, 0.86, (bar[1] - 1) / H]);
    if (rb.plain < 0.5 || rb.light) return null;
    if (hasPt) {
      const rp = _lbRegion(d, W, H, LB_BAR_FRAME.token.plate);
      if (rp.plain < 0.5 || rp.thin < 30 || rp.light) return null;
    }
    // (A text box under the bar has a line down each side: without them the
    // words are set elsewhere. Icingdeath sld 1018.)
    const u = LB_BAR_FRAME.token.under;
    if (hasText && bar[1] < H * 0.80) {
      const ya = Math.round(bar[1] + (u[3] * H - bar[1]) * 0.2), yb = Math.round(bar[1] + (u[3] * H - bar[1]) * 0.8), rg = Math.round(0.022 * W);
      if (_lbEdge(d, W, H, 'l', Math.round(u[0] * W), rg, ya, yb) === null || _lbEdge(d, W, H, 'r', Math.round(u[2] * W), rg, ya, yb) === null) return null;
    }
    return _liveBgAnalyzeBar(d, W, H, 'token', hasPt, hasText, bar);
  }
  // A textless printing ('showbare') has no text box. Most creatures print
  // their power and toughness on the usual plate, and some printings a type
  // line near the foot, white on a dark bar: each is rewritten in place where
  // it is found, and drawn where it is not.
  if (frame === 'showbare') {
    const f15 = LB_FRAME['2015'], px = (v, dim) => Math.round(v * dim);
    const res = { aspect: H / W, light: {}, dim: {} };
    if (hasPt) {
      // (The digits fill the plate: fewer strokes than a "1/1" has, or a
      // quarter of them in its top rows, is a plate printed higher. Traveling
      // Chocobo fin 551f.)
      const f = f15.plate, rp = _lbRegion(d, W, H, f);
      const top = _lbRegion(d, W, H, [f[0], f[1], f[2], f[1] + (f[3] - f[1]) * 0.13]);
      if (rp.plain >= 0.5 && rp.thin >= 160 && top.thin <= rp.thin * 0.25) {
        const a = px(f[0], W), b = px(f[1], H), c = px(f[2], W), e = px(f[3], H);
        res.pt = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.03, W), 2, 2, null, true, rp.light ? 'adapt' : false));
        res.light.pt = rp.light; res.dim.pt = !rp.light && rp.med < 115;
      }
    }
    // The dark bar is the pale bar of the image's negative. Its top is looked
    // for between 80% and 88% of the height only: lower down the collector
    // line's black band has "words" on it too, and higher up is art.
    const neg = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i++) neg[i] = (i & 3) === 3 ? 255 : 255 - d[i];
    // (ind: the card is a land. The textless shock lands of trk print their
    // type line lower, under a striped band that was taken for the bar: a
    // land's type bar stays a drawn one.)
    const bar = ind ? null : _lbFindBar(neg, W, H, true, 0.80, 0.88);
    if (bar) {
      const g = [0.075, (bar[0] + 2) / H, 0.86, (bar[1] - 1) / H], ry = _lbRegion(d, W, H, g);
      if (ry.plain >= 0.5 && ry.light && ry.med <= 70) {
        const a = px(g[0], W), b = bar[0] + 2, c = px(g[2], W), e = bar[1] - 1;
        res.type = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.05, W), 3, 2, null, true, 'adapt'));
        res.light.type = true;
      }
    }
    return res.pt || res.type ? res : null;
  }
  if (!fr) return _liveBgAnalyzeBar(d, W, H, frame, hasPt, hasText);
  const px = (f, dim) => Math.round(f * dim);
  const res = { aspect: H / W };
  // A showcase or borderless printing is only read as the usual frame when it
  // has a text box there: a line along its top, and a ground that is plain
  // (or, for a see-through box over the art, plain enough with a line on
  // every side and a type bar and P/T box where they should be). The print
  // may be white on a dark box: each region says which.
  let lightText = false, lightType = fr.light, lightPt = fr.light;
  let typeDy = null;
  if (show) {
    const t = fr.text, rg = px(0.022, W);
    const edge = (s, g, a, b) => _lbEdge(d, W, H, s, g, rg, a, b) !== null;
    const top = edge('t', px(t[1], H), px(0.25, W), px(0.75, W));
    const all = top && edge('l', px(t[0], W), px(0.69, H), px(0.86, H)) && edge('r', px(t[2], W), px(0.69, H), px(0.86, H)) && edge('b', px(t[3], H), px(0.25, W), px(0.43, W));
    const rt = _lbRegion(d, W, H, [t[0] + 0.03, t[1] + 0.02, t[2] - 0.03, t[3] - 0.04]);
    const ry = _lbRegion(d, W, H, fr.type), rp = _lbRegion(d, W, H, fr.plate);
    // (A see-through type bar over the art, or a long type line on a dark bar,
    // is less plain: enough when the text box is plain with a line on every
    // side. Baleful Strix sld 2070, Toski khm 319.)
    const barPlain = ry.plain >= 0.38;
    const ok = top && (barPlain ? (rt.plain >= 0.55 || (all && rt.plain >= 0.33 && (!hasPt || rp.plain >= 0.6)))
      : (all && ry.plain >= 0.30 && rt.plain >= 0.55));
    if (!ok) return null;
    // (A see-through box or bar must have a type line too: a poster-like
    // printing can have lines and plain ground in all the right places.)
    typeDy = _lbTypeShift(d, W, H, fr.type, ry.light);
    if ((rt.plain < 0.55 || !barPlain) && typeDy === null) return null;
    // (A type line far from its place, or no digits on the power/toughness
    // plate: a frame of its own, with its boxes elsewhere.)
    if (typeDy !== null && Math.abs(typeDy) > 0.022 * H) return null;
    if (hasPt && rp.thin < 30) return null;
    lightText = rt.light; lightType = ry.light; lightPt = rp.light;
    res.light = { text: lightText, type: lightType, pt: lightPt };
    // (Dark print on a dark box, as on the black and white werewolves of 2021:
    // the blue of a changed word is lost there.)
    const dim = r => !r.light && r.med < 115;
    res.dim = { text: dim(rt), type: dim(ry), pt: dim(rp) };
  }
  if (fr.fixed) {
    const ry = _lbRegion(d, W, H, fr.type), rp = hasPt ? _lbRegion(d, W, H, fr.plate) : { light: false, med: 255 };
    // (The two-colour lands of 2007 print their rules in white on a dark,
    // see-through box. Graven Cairns, Grove of the Burnwillows.)
    const t = fr.text, rt = _lbRegion(d, W, H, [t[0] + 0.03, t[1] + 0.02, t[2] - 0.03, t[3] - 0.04]);
    lightText = rt.light; lightType = ry.light; lightPt = rp.light;
    res.light = { text: lightText, type: lightType, pt: lightPt };
    const dim = r => !r.light && r.med < 115;
    res.dim = { text: dim(rt), type: dim(ry), pt: dim(rp) };
    // (White print on a pale bar, as on this frame's lands: the yellow of a
    // changed word is lost there, the blue is not.)
    res.mid = { type: ry.light && ry.med >= 140, pt: rp.light && rp.med >= 140 };
    res.ptBelow = true;        // nothing of the P/T box is in the text box
  }

  // Text box: each side from its border line, else the measured place; the
  // patch stays inside by a margin the printed text never enters.
  const t = fr.text, range = px(0.022, W);
  const midY0 = px(t[1] + (t[3] - t[1]) * 0.2, H), midY1 = px(t[1] + (t[3] - t[1]) * 0.8, H);
  const midX0 = px(t[0] + (t[2] - t[0]) * 0.2, W), midX1 = px(t[0] + (t[2] - t[0]) * 0.8, W);
  const lowX1 = px(t[0] + (t[2] - t[0]) * 0.42, W);          // clear of the stamp and the P/T box
  const side = (s, guess, a, b, found, missed) => {
    let e = _lbEdge(d, W, H, s, guess, range, a, b, show);
    const inward = (s === 'l' || s === 't') ? 1 : -1;
    // (Such a box may be a little larger than the usual one, with its words
    // starting where the usual box's side would be: a "line" found inside the
    // usual place is the words' own margin, not a border.)
    if (show && e !== null && (e - guess) * inward > 3) e = null;
    // (On a showcase or borderless printing a line may be two or three pixels
    // thick and pale: the patch starts a little further in.)
    return e === null ? guess + inward * (show ? 3 : missed) : e + inward * (show ? found + 2 : found);
  };
  // The first line can start 2 px under the box's top line, and an italic
  // capital reaches 4 px left of the text's margin. Where the top or left
  // line was found, the patch starts right inside it, and what is dark along
  // that side is print, not frame.
  const found = (s, guess, a, b) => _lbEdge(d, W, H, s, guess, range, a, b, show) !== null;
  const topFound = found('t', px(t[1], H), midX0, midX1), leftFound = found('l', px(t[0], W), midY0, midY1);
  const x0 = fr.fixed ? px(t[0], W) : side('l', px(t[0], W), midY0, midY1, 2, 8), x1 = fr.fixed ? px(t[2], W) : side('r', px(t[2], W), midY0, midY1, 4, 8) + 1;
  const y0 = fr.fixed ? px(t[1], H) : side('t', px(t[1], H), midX0, midX1, 2, 8), y1 = fr.fixed ? px(t[3], H) : side('b', px(t[3], H), midX0, lowX1, page ? 2 : 4, 8) + 1;
  // (A page's reminder text often fills it: the tail of a "p" in its last
  // line ends 3 px above the page's foot, and a patch that stopped there took
  // the letter for frame. A page's patch runs 2 px further down.)
  const keep = (hasPt && fr.cut) ? [px(fr.cut[0], W), px(fr.cut[1], H)] : null;
  if (page === 'l') res.ptBelow = true;
  // (A see-through box lets the art's bright specks in along every side: on a
  // showcase or borderless printing only the stamp at the foot is frame.)
  // (The bowed sides of the future frame's box come into the patch anywhere.)
  const seeds = fr.fixed ? 'lrtb' : show ? 'b' : (page === 'l' ? 'R' : 'r') + 'b' + (topFound ? '' : 't') + (leftFound ? '' : 'l');
  res.text = _lbRect(x0, y0, x1, y1, W, H, _lbErase(d, W, H, x0, y0, x1, y1, px(0.02, W), px(0.02, W), 3, keep, seeds, lightText ? 'adapt' : false));

  if (fr.type) {
    // (After a colour indicator the line starts 4.7% of the card further in,
    // and a long one ends nearer the set symbol.)
    // (The future frame prints no indicator dot: Dryad Arbor.)
    if (fr.fixed) ind = false;
    const f = fr.type, a = px(f[0] + (ind ? 0.047 : 0), W), c = px(f[2] + (ind ? 0.03 : 0), W);
    // (The back face of a double-faced card prints its type line in white on
    // a darkened bar.)
    if (ind && !show && !fr.light) {
      lightType = _lbRegion(d, W, H, [f[0] + 0.047, f[1], f[2], f[3]]).light;
      if (lightType) res.light = { text: false, type: true, pt: false };
    }
    // (A showcase frame may print its type line a little higher or lower.)
    const dy = typeDy || 0;
    const b = px(f[1], H) + dy, e = px(f[3], H) + dy;
    res.type = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.05, W), 3, 2, null, fr.typeSeeds || (show ? false : 'bar'), lightType === true ? 'adapt' : lightType));
  }
  // The title bar, when the card's name has changed (cost: the number of mana
  // symbols, -1 when the name is the printed one). Not on a showcase printing.
  if (fr.name && !show && cost >= 0) {
    const f = fr.name, a = px(f[0], W), b = px(f[1], H), e = px(f[3], H);
    const c = _lbNameEnd(d, W, H, a, b, px(f[2], W), e, cost);
    if (c !== null && c - a > W * 0.3) {
      res.name = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.05, W), 3, 2, null, fr.light ? 'r' : 'bar', fr.light || false));
    }
  }
  if (fr.plate && hasPt) {
    const f = fr.plate, a = px(f[0], W), b = px(f[1], H), c = px(f[2], W), e = px(f[3], H);
    res.pt = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.03, W), fr.light ? 3 : 2, 2, null, fr.light ? 'none' : true, (show || fr.fixed) && lightPt ? 'adapt' : lightPt));
  }
  return res;
}

function _liveBgPump() {
  if (_liveBgBusy || !_liveBgQueue.length) return;
  _liveBgBusy = true;
  const job = _liveBgQueue.shift();
  const finish = (result) => {
    _liveBg.set(job.key, { done: true, result });
    _liveBgBusy = false;
    applyLiveBackgrounds();
    setTimeout(_liveBgPump, 0);
  };
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    let result = null;
    try { result = _liveBgAnalyze(img, job.frame, job.hasPt, job.hasText, job.ind, job.page, job.cost); } catch (e) { result = null; }
    finish(result);
  };
  img.onerror = () => finish(null);
  img.src = job.src;
}

function _liveBgPlace(el, r) {
  const pct = (v) => (v * 100).toFixed(3) + '%';
  el.style.left = pct(r.x); el.style.top = pct(r.y);
  el.style.width = pct(r.w); el.style.height = pct(r.h);
  el.style.right = 'auto'; el.style.bottom = 'auto';
  el.style.maxWidth = 'none'; el.style.minWidth = '0';
  el.style.backgroundImage = `url(${r.url})`;
  el.classList.add('bf-live-exact');
  el.classList.remove('bf-live-drawn', 'bf-live-wait');
}

function _liveBgApply(box, res) {
  box.classList.add('bf-live-ok');
  // (A showcase or borderless printing may print in white on a dark box.)
  if (res.light) {
    for (const k of ['type', 'text', 'pt']) {
      const el = box.querySelector('.bf-live-' + k);
      if (el) el.classList.toggle('bf-live-light', !!res.light[k]);
      if (el) el.classList.toggle('bf-live-dim', !!(res.dim && res.dim[k]));
      if (el) el.classList.toggle('bf-live-mid', !!(res.mid && res.mid[k]));
    }
  }
  const type = box.querySelector('.bf-live-type');
  if (type && res.type) {
    _liveBgPlace(type, res.type);
    const high = res.type.h * res.aspect * 100;
    type.style.lineHeight = high.toFixed(2) + 'cqw';
    // A line too long for its bar is set smaller, as a printed one is, before
    // it is cut short. (The line's height in pixels gives the size of a cqw.)
    type.style.fontSize = '';
    const cs = getComputedStyle(type), cqw = parseFloat(cs.lineHeight) / high, base = parseFloat(cs.fontSize) / cqw;
    if (cqw > 0 && base > 0) {
      for (let k = 0.96; k >= 0.74 && type.scrollWidth > type.clientWidth + 1; k -= 0.04) type.style.fontSize = (base * k).toFixed(2) + 'cqw';
    }
  }
  // The name, over the title bar where it was read, else on a drawn bar there.
  const name = box.querySelector('.bf-live-name');
  if (name && res.name) {
    _liveBgPlace(name, res.name);
    const high = res.name.h * res.aspect * 100;
    name.style.lineHeight = high.toFixed(2) + 'cqw';
    name.style.fontSize = '';
    const cs = getComputedStyle(name), cqw = parseFloat(cs.lineHeight) / high, base = parseFloat(cs.fontSize) / cqw;
    if (cqw > 0 && base > 0) {
      for (let k = 0.96; k >= 0.66 && name.scrollWidth > name.clientWidth + 1; k -= 0.04) name.style.fontSize = (base * k).toFixed(2) + 'cqw';
    }
  } else if (name) name.classList.add('bf-live-drawn');
  const pt = box.querySelector('.bf-live-pt:not(.bf-live-drawn)');
  if (pt && res.pt) _liveBgPlace(pt, res.pt);
  // (A textless printing whose plate was not found gets a drawn box.)
  else if (pt && box.dataset.frame === 'showbare') pt.classList.add('bf-live-drawn');
  // The strip of gained abilities ends just above the type bar
  const gain = box.querySelector('.bf-live-gain');
  if (gain) {
    if (res.barTop) gain.style.bottom = ((1 - res.barTop) * 100 + 0.9).toFixed(2) + '%';
    gain.classList.remove('bf-live-wait');
  }
  // (A Room has a text box for each door.)
  box.querySelectorAll('.bf-live-text').forEach(text => {
    const rect = res.texts ? res.texts[+(text.dataset.half || 0)] : res.text;
    if (!rect) { text.classList.remove('bf-live-wait'); return; }
    _liveBgPlace(text, rect);
    if (res.ptBelow) text.classList.remove('bf-live-haspt');
    // The font was estimated for the usual box: now that the real box is known,
    // take the largest size that fits it.
    let size = parseFloat(text.style.fontSize) || 4;
    const max = parseFloat(text.dataset.max) || 4.8, min = parseFloat(text.dataset.min) || 2;
    const fits = () => text.scrollHeight <= text.clientHeight + 1;
    const set = (v) => { size = v; text.style.fontSize = v.toFixed(1) + 'cqw'; };
    while (fits() && size < max) set(size + 0.2);
    while (!fits() && size > min) set(size - 0.2);
  });
}

/* Called after the battlefield is drawn: every card's patches get the card's
   own image with the print erased, at once when the image has been read before,
   otherwise when its reading is done. */
function applyLiveBackgrounds() {
  document.querySelectorAll('#battlefield .bf-live[data-src]').forEach(box => {
    const src = box.dataset.src, frame = box.dataset.frame, hasPt = box.dataset.pt === '1', hasText = box.dataset.text === '1', ind = box.dataset.ind === '1';
    const page = box.dataset.page || '';
    const cost = box.dataset.cost ? +box.dataset.cost : -1;
    const key = src + '|' + frame + (hasPt ? 1 : 0) + (hasText ? 1 : 0) + (ind ? 1 : 0) + page + '|' + cost;
    const hit = _liveBg.get(key);
    if (hit) {
      if (hit.done && hit.result) _liveBgApply(box, hit.result);
      else if (hit.done) { box.querySelectorAll('.bf-live-name').forEach(n => n.classList.add('bf-live-drawn')); box.classList.add('bf-live-failed'); box.querySelectorAll('.bf-live-wait').forEach(g => g.classList.remove('bf-live-wait')); }   // unreadable image: the first-guess place
      return;
    }
    _liveBg.set(key, { done: false });
    _liveBgQueue.push({ key, src, frame, hasPt, hasText, ind, page, cost });
  });
  _liveBgPump();
}
/* [END: LIVE-BG] */
