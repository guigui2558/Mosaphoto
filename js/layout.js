/*
 * Mosaphoto — moteur de composition.
 *
 * Principe : mise en page "justifiée" (comme un mur de photos) qui remplit
 * exactement le cadre final. Chaque photo garde (presque) son ratio d'origine :
 * une photo en portrait occupe naturellement une cellule étroite et haute,
 * une photo en paysage une cellule large.
 *
 *  1. Pour un nombre de rangées k donné, une programmation dynamique répartit
 *     les photos en rangées dont la hauteur naturelle est la plus proche
 *     possible de la hauteur cible (H / k).
 *  2. Une recherche locale mélange portraits/paysages, échange des photos et
 *     peut empiler deux photos dans une même tuile pour ajuster le remplissage.
 *  3. On compare rangées, colonnes et (pour peu de photos) un découpage en
 *     arbre, et on garde la composition qui recadre le moins les photos tout
 *     en gardant des tailles homogènes.
 *
 * Fichier utilisable dans le navigateur (window.MosaicLayout) et sous Node.
 */
(function (root) {
  'use strict';

  // Poids du recadrage dans le score : on préfère nettement ne pas couper les photos.
  const CROP_WEIGHT = 20;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* Un "jeton" = une photo seule, ou deux photos empilées verticalement.
     Empiler deux photos (souvent deux paysages) crée une tuile étroite :
     c'est le levier qui permet de remplir le cadre sans recadrer.
     Largeur d'un jeton en fonction de la hauteur de la rangée : w = A·h + B. */
  function tokenCoef(tok, ars, gap) {
    if (tok.length === 1) return [ars[tok[0]], 0];
    const A = 1 / (1 / ars[tok[0]] + 1 / ars[tok[1]]);
    return [A, -gap * A];
  }

  /* Répartition optimale (DP) d'une séquence ordonnée de jetons en k rangées. */
  function partitionRows(As, Bs, W, H, gap, k) {
    const n = As.length;
    if (k < 1 || k > n) return null;
    const target = (H - gap * (k - 1)) / k;
    if (target <= 0) return null;
    const PA = new Float64Array(n + 1), PB = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { PA[i + 1] = PA[i] + As[i]; PB[i + 1] = PB[i] + Bs[i]; }

    const INF = 1e18;
    let prev = new Float64Array(n + 1).fill(INF);
    prev[0] = 0;
    const choices = [];
    for (let r = 1; r <= k; r++) {
      const cur = new Float64Array(n + 1).fill(INF);
      const ch = new Int32Array(n + 1).fill(-1);
      const jMax = n - (k - r);
      for (let j = r; j <= jMax; j++) {
        for (let i = j - 1; i >= r - 1; i--) {
          const avail = W - gap * (j - i - 1) - (PB[j] - PB[i]);
          if (avail <= 0) break;
          const d = Math.log(avail / (PA[j] - PA[i]) / target);
          if (d < -1.2) break; // rangée beaucoup trop chargée : inutile d'aller plus loin
          const p = prev[i];
          if (p >= INF) continue;
          const v = p + d * d;
          if (v < cur[j]) { cur[j] = v; ch[j] = i; }
        }
      }
      choices.push(ch);
      prev = cur;
    }
    if (prev[n] >= INF) return null;

    const rows = [];
    let j = n;
    for (let r = k; r >= 1; r--) {
      const i = choices[r - 1][j];
      if (i < 0) return null;
      rows.push([i, j]);
      j = i;
    }
    rows.reverse();
    return rows;
  }

  /* Construit les cellules (repère local : rangées de largeur W, hauteur H). */
  function buildRowCells(tokens, As, Bs, rows, ars, W, H, gap) {
    const k = rows.length;
    const hs = rows.map(([i, j]) => {
      let a = 0, b = 0;
      for (let t = i; t < j; t++) { a += As[t]; b += Bs[t]; }
      return (W - gap * (j - i - 1) - b) / a;
    });
    const sum = hs.reduce((x, y) => x + y, 0);
    const s = (H - gap * (k - 1)) / sum; // étirement vertical uniforme => léger recadrage
    const cells = [];
    let y = 0;
    for (let r = 0; r < k; r++) {
      const [i, j] = rows[r];
      const hNat = hs[r];
      const h = hNat * s;
      let x = 0;
      for (let t = i; t < j; t++) {
        let w = As[t] * hNat + Bs[t];
        if (t === j - 1) w = W - x;
        const tok = tokens[t];
        if (tok.length === 1) {
          cells.push({ index: tok[0], x, y, w, h });
        } else {
          const h1n = w / ars[tok[0]], h2n = w / ars[tok[1]];
          const h1 = (h - gap) * h1n / (h1n + h2n);
          cells.push({ index: tok[0], x, y, w, h: h1 });
          cells.push({ index: tok[1], x, y: y + h1 + gap, w, h: h - h1 - gap });
        }
        x += w + gap;
      }
      y += h + gap;
    }
    return cells;
  }

  function kRange(As, W, H, spread) {
    const n = As.length;
    let S = 0;
    for (const a of As) S += a;
    const kIdeal = Math.sqrt((H * S) / W);
    const lo = Math.max(1, Math.floor(kIdeal) - spread);
    const hi = Math.min(n, Math.ceil(kIdeal) + spread);
    const out = [];
    for (let k = lo; k <= hi; k++) out.push(k);
    return out;
  }

  /* Ordre "équilibré" : on alterne portraits et paysages pour que chaque
     rangée contienne un mélange des deux. */
  function interleavedOrder(ars, rand) {
    const idx = ars.map((_, i) => i);
    const portrait = shuffle(idx.filter((i) => ars[i] < 1), rand);
    const landscape = shuffle(idx.filter((i) => ars[i] >= 1), rand);
    const out = [];
    const total = idx.length;
    let p = 0, l = 0;
    for (let t = 0; t < total; t++) {
      const wantP = portrait.length * (t + 1) / total - p;
      const wantL = landscape.length * (t + 1) / total - l;
      if ((wantP >= wantL && p < portrait.length) || l >= landscape.length) out.push(portrait[p++]);
      else out.push(landscape[l++]);
    }
    return out;
  }

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /* Meilleure composition en rangées pour une suite de jetons donnée. */
  function evalTokens(tokens, ars, W, H, gap, kList) {
    const As = [], Bs = [];
    for (const t of tokens) { const [A, B] = tokenCoef(t, ars, gap); As.push(A); Bs.push(B); }
    const ks = kList || kRange(As, W, H, 3);
    let best = null;
    for (const k of ks) {
      const rows = partitionRows(As, Bs, W, H, gap, k);
      if (!rows) continue;
      const cells = buildRowCells(tokens, As, Bs, rows, ars, W, H, gap);
      let ok = true;
      for (const c of cells) if (!(c.w > 2 && c.h > 2)) { ok = false; break; }
      if (!ok) continue;
      const score = scoreCells(ars, cells);
      if (!best || score < best.score) best = { score, cells, k };
    }
    return best;
  }

  /* Recherche de la meilleure composition en rangées (repère W x H). */
  function solve(ars, W, H, gap, opts) {
    const n = ars.length;
    const rand = mulberry32(opts.seed >>> 0);
    const identity = ars.map((_, i) => i);
    const toTokens = (order) => order.map((i) => [i]);

    const orders = [identity];
    if (!opts.keepOrder && n > 2) {
      for (let t = 0; t < 3; t++) orders.push(interleavedOrder(ars, rand));
      for (let t = 0; t < 3; t++) orders.push(shuffle(identity.slice(), rand));
    }

    let best = null, bestTokens = null;
    for (const order of orders) {
      const tokens = toTokens(order);
      const r = evalTokens(tokens, ars, W, H, gap);
      if (r && (!best || r.score < best.score)) { best = r; bestTokens = tokens; }
    }
    if (!best) return null;

    // Recherche locale : échanger/déplacer des photos, empiler/dépiler des paires.
    const deadline = now() + opts.timeBudget;
    let iter = 0;
    while (n > 1 && now() < deadline && iter < 5000) {
      iter++;
      const cand = bestTokens.map((t) => t.slice());
      const m = cand.length;
      const op = rand();
      const a = Math.floor(rand() * m);
      if (op < 0.35) {
        // empiler deux jetons simples voisins
        if (a + 1 >= m || cand[a].length !== 1 || cand[a + 1].length !== 1) continue;
        cand.splice(a, 2, [cand[a][0], cand[a + 1][0]]);
      } else if (op < 0.5) {
        // dépiler une paire
        if (cand[a].length !== 2) continue;
        cand.splice(a, 1, [cand[a][0]], [cand[a][1]]);
      } else if (opts.keepOrder) {
        continue;
      } else if (op < 0.8) {
        // échanger deux photos (n'importe où, y compris dans des paires)
        const b = Math.floor(rand() * m);
        const ia = Math.floor(rand() * cand[a].length), ib = Math.floor(rand() * cand[b].length);
        const t = cand[a][ia]; cand[a][ia] = cand[b][ib]; cand[b][ib] = t;
      } else {
        // déplacer un jeton
        const [el] = cand.splice(a, 1);
        cand.splice(Math.floor(rand() * m), 0, el);
      }
      const ks = [best.k - 1, best.k, best.k + 1].filter((k) => k >= 1 && k <= cand.length);
      const r = evalTokens(cand, ars, W, H, gap, ks);
      if (r && r.score < best.score) { best = r; bestTokens = cand; }
    }
    return best;
  }

  /* ---------- Composition en arbre (petits nombres de photos) ----------
     Pour peu de photos, les rangées imposent souvent un fort recadrage.
     On cherche alors un découpage récursif (côte à côte / empilé) dont le
     ratio global colle au cadre : ex. une grande photo paysage à gauche et
     deux portraits empilés à droite. Chaque nœud a une largeur affine en sa
     hauteur : w = A·h + B (B dû aux espacements), ce qui donne un calcul exact. */
  function treeSolve(ars, W, H, gap, opts) {
    const n = ars.length;
    const rand = mulberry32((opts.seed ^ 0x9e3779b9) >>> 0);

    function randomTree(order, lo, hi) {
      if (hi - lo === 1) return { leaf: order[lo] };
      const m = lo + 1 + Math.floor(rand() * (hi - lo - 1));
      return { dir: rand() < 0.5 ? 'h' : 'v', a: randomTree(order, lo, m), b: randomTree(order, m, hi) };
    }
    function coef(nd) {
      if (nd.leaf !== undefined) { nd.A = ars[nd.leaf]; nd.B = 0; return; }
      coef(nd.a); coef(nd.b);
      if (nd.dir === 'h') { nd.A = nd.a.A + nd.b.A; nd.B = nd.a.B + nd.b.B + gap; }
      else {
        const S = 1 / nd.a.A + 1 / nd.b.A;
        nd.A = 1 / S;
        nd.B = (nd.a.B / nd.a.A + nd.b.B / nd.b.A - gap) / S;
      }
    }
    function place(nd, x, y, w, h, out) {
      if (nd.leaf !== undefined) { out.push({ index: nd.leaf, x, y, w, h }); return; }
      if (nd.dir === 'h') {
        const wa = nd.a.A * h + nd.a.B, wb = nd.b.A * h + nd.b.B;
        const k = (w - gap) / (wa + wb);
        const w1 = wa * k;
        place(nd.a, x, y, w1, h, out);
        place(nd.b, x + w1 + gap, y, w - w1 - gap, h, out);
      } else {
        const ha = (w - nd.a.B) / nd.a.A, hb = (w - nd.b.B) / nd.b.A;
        const k = (h - gap) / (ha + hb);
        const h1 = ha * k;
        place(nd.a, x, y, w, h1, out);
        place(nd.b, x, y + h1 + gap, w, h - h1 - gap, out);
      }
    }
    function evalTree(t) {
      coef(t);
      const cells = [];
      place(t, 0, 0, W, H, cells);
      for (const c of cells) if (!(c.w > 4 && c.h > 4)) return null;
      return { cells, score: scoreCells(ars, cells) };
    }
    function leaves(t, out) {
      if (t.leaf !== undefined) out.push(t); else { leaves(t.a, out); leaves(t.b, out); }
      return out;
    }
    function internals(t, out) {
      if (t.leaf === undefined) { out.push(t); internals(t.a, out); internals(t.b, out); }
      return out;
    }
    const clone = (t) => (t.leaf !== undefined ? { leaf: t.leaf } : { dir: t.dir, a: clone(t.a), b: clone(t.b) });

    const identity = ars.map((_, i) => i);
    let best = null, bestTree = null;
    const deadline = now() + opts.timeBudget;
    // 1) générations aléatoires
    const half = deadline - opts.timeBudget / 2;
    for (let tries = 0; tries < 6000; tries++) {
      const order = opts.keepOrder ? identity : shuffle(identity.slice(), rand);
      const t = randomTree(order, 0, n);
      const r = evalTree(t);
      if (r && (!best || r.score < best.score)) { best = r; bestTree = t; }
      if (tries > 50 && now() > half) break;
    }
    if (!best) return null;
    // 2) recherche locale : inversion d'orientation, échange de photos
    while (now() < deadline) {
      const t = clone(bestTree);
      const ins = internals(t, []);
      const lv = leaves(t, []);
      const m = rand();
      if (m < 0.5 && ins.length) {
        const nd = ins[Math.floor(rand() * ins.length)];
        nd.dir = nd.dir === 'h' ? 'v' : 'h';
      } else if (!opts.keepOrder && lv.length > 1) {
        const a = lv[Math.floor(rand() * lv.length)], b = lv[Math.floor(rand() * lv.length)];
        const tmp = a.leaf; a.leaf = b.leaf; b.leaf = tmp;
      } else if (ins.length) {
        const nd = ins[Math.floor(rand() * ins.length)];
        const tmp = nd.a; nd.a = nd.b; nd.b = tmp;
        if (opts.keepOrder) continue;
      }
      const r = evalTree(t);
      if (r && r.score < best.score) { best = r; bestTree = t; }
    }
    return best;
  }

  /* Score commun : recadrage des photos + disparité des tailles. */
  function scoreCells(ars, cells) {
    let crop = 0, mean = 0;
    const la = new Array(cells.length);
    cells.forEach((c, i) => {
      const d = Math.log(c.w / c.h / ars[c.index]);
      crop += d * d;
      la[i] = Math.log(c.w * c.h);
      mean += la[i];
    });
    mean /= cells.length;
    let v = 0;
    for (const x of la) v += (x - mean) * (x - mean);
    return (crop / cells.length) * CROP_WEIGHT + (v / cells.length) * 0.25;
  }

  function meanCropPct(ars, cells) {
    let s = 0;
    for (const c of cells) {
      const r = c.w / c.h / ars[c.index];
      s += 1 - Math.min(r, 1 / r);
    }
    return (s / cells.length) * 100;
  }

  /**
   * @param {number[]} ars  ratios largeur/hauteur des photos
   * @param {object} o  { width, height, gap, padding, keepOrder, seed, timeBudget }
   * @returns {{cells:{index,x,y,w,h}[], cropPct:number, direction:string}}
   */
  function computeLayout(ars, o) {
    const n = ars.length;
    if (!n) return { cells: [], cropPct: 0, direction: 'rows' };
    const pad = o.padding || 0;
    const W = o.width - 2 * pad;
    const H = o.height - 2 * pad;
    const gap = o.gap || 0;
    const opts = {
      seed: o.seed || 1,
      keepOrder: !!o.keepOrder,
      timeBudget: o.timeBudget == null ? 200 : o.timeBudget,
    };

    const candidates = [];
    // Sens 1 : rangées horizontales.
    const rowsSol = solve(ars, W, H, gap, opts);
    if (rowsSol) candidates.push({ cells: rowsSol.cells, direction: 'rows', score: rowsSol.score });
    // Sens 2 : colonnes verticales (même problème, transposé).
    const inv = ars.map((a) => 1 / a);
    const colsSol = solve(inv, H, W, gap, opts);
    if (colsSol) {
      const cells = colsSol.cells.map((c) => ({ index: c.index, x: c.y, y: c.x, w: c.h, h: c.w }));
      // légère préférence pour les rangées (lecture plus naturelle)
      candidates.push({ cells, direction: 'cols', score: colsSol.score * 1.1 });
    }
    // Sens 3 : découpage en arbre, pour peu de photos.
    if (n <= 16 && n > 1) {
      const t = treeSolve(ars, W, H, gap, opts);
      if (t) candidates.push({ cells: t.cells, direction: 'tree', score: t.score * 1.05 });
    }

    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0];
    best.cells.forEach((c) => { c.x += pad; c.y += pad; });
    return { cells: best.cells, cropPct: meanCropPct(ars, best.cells), direction: best.direction, score: best.score };
  }

  const api = { computeLayout, scoreCells };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MosaicLayout = api;
})(typeof self !== 'undefined' ? self : this);
