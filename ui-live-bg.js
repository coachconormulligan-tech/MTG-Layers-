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
   nothing is erased (the P/T box in the text box's corner). */
function _lbErase(d, W, H, x0, y0, x1, y1, r, ry, grow, keep) {
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const ground = _lbRank(d, W, H, x0, y0, x1, y1, r, ry, 0.8);
  const kept = (x, y) => keep && x0 + x >= keep[0] && y0 + y >= keep[1];
  let mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (kept(x, y)) continue;
      if (_lbLum(d, ((y0 + y) * W + x0 + x) * 4) < _lbLum(ground, (y * w + x) * 4) - 14) mask[y * w + x] = 1;
    }
  }
  // Widen the mask: a glyph's soft edge and the ringing around it are ink too
  for (let pass = 0; pass < grow; pass++) {
    const next = new Uint8Array(mask);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] || kept(x, y)) continue;
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
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d'), im = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const o = (y * w + x) * 4;
      let done = false;
      for (const R of [3, 6, 12]) {
        const xa = Math.max(0, x - R), ya = Math.max(0, y - R), xb = Math.min(w, x + R + 1), yb = Math.min(h, y + R + 1);
        const n = box(3, xa, ya, xb, yb);
        if (n >= 8) {
          for (let c = 0; c < 3; c++) im.data[o + c] = box(c, xa, ya, xb, yb) / n;
          done = true;
          break;
        }
      }
      if (!done) for (let c = 0; c < 3; c++) im.data[o + c] = ground[o + c];
      im.data[o + 3] = 255;
    }
  }
  g.putImageData(im, 0, 0);
  return cv.toDataURL('image/png');
}

/* A box's border line: the position within `range` pixels of `guess` where the
   image steps most strongly from dark to light going into the box, averaged
   along the whole side (text never lines up along a side, a border does).
   side: 'l' | 'r' | 't' | 'b'; a, b: the span along the side to average over.
   Returns the first pixel inside the box, or null when no line stands out. */
function _lbEdge(d, W, H, side, guess, range, a, b) {
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
    const score = sum / (3 * n);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 5 ? best : null;
}

/* Where each frame prints its boxes, as fractions of the image (measured on
   Scryfall's images): text = the text box, plate = the flat inside of the P/T
   box, cut = the corner of the text box the P/T box covers, type = the part of
   the type bar that holds the words (it stops before the set symbol). The 1993
   and 1997 frames print the type line and P/T straight on the frame, so those
   two keep the blurred patch there. */
const LB_FRAME = {
  '2015': { text: [0.076, 0.631, 0.924, 0.922], plate: [0.791, 0.903, 0.930, 0.937], cut: [0.766, 0.889], type: [0.072, 0.569, 0.862, 0.611] },
  '2003': { text: [0.084, 0.628, 0.910, 0.899], plate: [0.752, 0.900, 0.908, 0.935], cut: [0.726, 0.886], type: [0.086, 0.571, 0.861, 0.607] },
  'old':  { text: [0.107, 0.600, 0.893, 0.884] },
};

function _lbRect(x0, y0, x1, y1, W, H, url) {
  return url ? { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H, url } : null;
}

function _liveBgAnalyze(img, frame, hasPt) {
  const fr = LB_FRAME[frame];
  if (!fr) return null;
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;       // throws if the image is not readable
  const px = (f, dim) => Math.round(f * dim);
  const res = { aspect: H / W };

  // Text box: each side from its border line, else the measured place; the
  // patch stays inside by a margin the printed text never enters.
  const t = fr.text, range = px(0.022, W);
  const midY0 = px(t[1] + (t[3] - t[1]) * 0.2, H), midY1 = px(t[1] + (t[3] - t[1]) * 0.8, H);
  const midX0 = px(t[0] + (t[2] - t[0]) * 0.2, W), midX1 = px(t[0] + (t[2] - t[0]) * 0.8, W);
  const lowX1 = px(t[0] + (t[2] - t[0]) * 0.42, W);          // clear of the stamp and the P/T box
  const side = (s, guess, a, b, found, missed) => {
    const e = _lbEdge(d, W, H, s, guess, range, a, b);
    const inward = (s === 'l' || s === 't') ? 1 : -1;
    return e === null ? guess + inward * missed : e + inward * found;
  };
  const x0 = side('l', px(t[0], W), midY0, midY1, 4, 8), x1 = side('r', px(t[2], W), midY0, midY1, 4, 8) + 1;
  const y0 = side('t', px(t[1], H), midX0, midX1, 4, 8), y1 = side('b', px(t[3], H), midX0, lowX1, 4, 8) + 1;
  const keep = (hasPt && fr.cut) ? [px(fr.cut[0], W), px(fr.cut[1], H)] : null;
  res.text = _lbRect(x0, y0, x1, y1, W, H, _lbErase(d, W, H, x0, y0, x1, y1, px(0.02, W), px(0.02, W), 3, keep));

  if (fr.type) {
    const f = fr.type, a = px(f[0], W), b = px(f[1], H), c = px(f[2], W), e = px(f[3], H);
    res.type = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.05, W), 3, 2, null));
  }
  if (fr.plate && hasPt) {
    const f = fr.plate, a = px(f[0], W), b = px(f[1], H), c = px(f[2], W), e = px(f[3], H);
    res.pt = _lbRect(a, b, c, e, W, H, _lbErase(d, W, H, a, b, c, e, px(0.03, W), 2, 2, null));
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
    try { result = _liveBgAnalyze(img, job.frame, job.hasPt); } catch (e) { result = null; }
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
}

function _liveBgApply(box, res) {
  const type = box.querySelector('.bf-live-type-line');
  if (type && res.type) {
    _liveBgPlace(type, res.type);
    type.style.lineHeight = (res.type.h * res.aspect * 100).toFixed(2) + 'cqw';
  }
  const pt = box.querySelector('.bf-live-pt:not(.bf-live-drawn)');
  if (pt && res.pt) _liveBgPlace(pt, res.pt);
  const text = box.querySelector('.bf-live-text');
  if (text && res.text) {
    _liveBgPlace(text, res.text);
    // The font was estimated for the usual box: now that the real box is known,
    // take the largest size that fits it.
    let size = parseFloat(text.style.fontSize) || 4;
    const fits = () => text.scrollHeight <= text.clientHeight + 1;
    const set = (v) => { size = v; text.style.fontSize = v.toFixed(1) + 'cqw'; };
    while (fits() && size < 4.8) set(size + 0.2);
    while (!fits() && size > 2.4) set(size - 0.2);
  }
}

/* Called after the battlefield is drawn: every card's patches get the card's
   own image with the print erased, at once when the image has been read before,
   otherwise when its reading is done. */
function applyLiveBackgrounds() {
  document.querySelectorAll('#battlefield .bf-live[data-src]').forEach(box => {
    const src = box.dataset.src, frame = box.dataset.frame, hasPt = box.dataset.pt === '1';
    const key = src + '|' + frame + (hasPt ? 1 : 0);
    const hit = _liveBg.get(key);
    if (hit) { if (hit.done && hit.result) _liveBgApply(box, hit.result); return; }
    _liveBg.set(key, { done: false });
    _liveBgQueue.push({ key, src, frame, hasPt });
  });
  _liveBgPump();
}
/* [END: LIVE-BG] */
