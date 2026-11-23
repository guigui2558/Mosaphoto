/* Mosaphoto — interface. Tout se passe dans le navigateur : aucune photo n'est envoyée. */
(function () {
  'use strict';

  const MAX_PHOTOS = 100;
  const THUMB_MAX = 640;      // taille des vignettes en mémoire (aperçu)
  const SIDEBAR_THUMB = 120;  // vignettes de la liste
  const MASTER_MAX = 2560;    // copie de travail compressée, gardée dès l'import
  const BASE = { landscape: [3840, 2160], portrait: [2160, 3840], square: [2160, 2160], insta: [2160, 2700] };
  const RES_SCALE = { '4k': 1, '1080': 0.5 };

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status'), count: $('count'), dropzone: $('dropzone'), fileInput: $('fileInput'),
    thumbs: $('thumbs'), clearBtn: $('clearBtn'), clearLabel: $('clearLabel'), gap: $('gap'), gapOut: $('gapOut'),
    radius: $('radius'), radiusOut: $('radiusOut'), bg: $('bg'), border: $('border'),
    keepOrder: $('keepOrder'), shuffleBtn: $('shuffleBtn'), quality: $('quality'),
    qualityOut: $('qualityOut'), maxSize: $('maxSize'), exportBtn: $('exportBtn'),
    result: $('result'), frame: $('frame'), preview: $('preview'), empty: $('empty'),
    busy: $('busy'), busyText: $('busyText'), meta: $('meta'), webpBtn: $('webpBtn'),
  };

  const state = {
    photos: [],
    seed: 1,
    layout: null,
    exporting: false,
    s: {
      orientation: 'landscape', resolution: '4k', format: 'image/jpeg',
      gap: 8, radius: 0, bg: '#ffffff', border: true, keepOrder: false,
      quality: 85, maxSize: 5,
    },
  };
  let nextId = 1;

  /* ------------------------------------------------------------------ utils */

  function fmtBytes(b) {
    if (b < 1024) return b + ' o';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' Ko';
    return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 2 : 1).replace('.', ',') + ' Mo';
  }

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /* Décode un fichier image. L'élément <img> applique l'orientation EXIF. */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve({ img, release: () => { URL.revokeObjectURL(url); img.src = ''; } });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('format non supporté')); };
      img.src = url;
    });
  }

  /* Réduction de qualité : divisions successives par 2 pour éviter le crénelage. */
  function drawScaled(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
    let cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
    const tmp = [];
    while (cw / 2 >= dw && ch / 2 >= dh) {
      const c = canvas(cw / 2, ch / 2);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(cur, cx, cy, cw, ch, 0, 0, c.width, c.height);
      tmp.push(c);
      cur = c; cx = 0; cy = 0; cw = c.width; ch = c.height;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, cx, cy, cw, ch, dx, dy, dw, dh);
    tmp.forEach((c) => { c.width = c.height = 0; });
  }

  /* Point d'intérêt : centre de gravité des détails (contours), légèrement
     ramené vers le centre et vers le haut (visages, ciel/sujet). Sert à
     choisir où couper quand un léger recadrage est nécessaire. */
  function computeFocus(src) {
    const s = 48;
    const r = src.width / src.height;
    const w = r >= 1 ? s : Math.max(8, Math.round(s * r));
    const h = r >= 1 ? Math.max(8, Math.round(s / r)) : s;
    const c = canvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    let sx = 0, sy = 0, sw = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = lum[i + 1] - lum[i - 1];
        const gy = lum[i + w] - lum[i - w];
        const e = gx * gx + gy * gy;
        sx += e * x; sy += e * y; sw += e;
      }
    }
    if (!sw) return { x: 0.5, y: 0.45 };
    const fx = sx / sw / (w - 1), fy = sy / sw / (h - 1);
    return {
      x: Math.min(1, Math.max(0, 0.5 + (fx - 0.5) * 0.8)),
      y: Math.min(1, Math.max(0, 0.45 + (fy - 0.5) * 0.8)),
    };
  }

  /* Dessine une photo dans une cellule en "cover", centrée sur son point d'intérêt. */
  function drawCell(ctx, src, srcW, srcH, focus, x, y, w, h, radius) {
    const target = w / h;
    let sw = srcW, sh = srcH;
    if (srcW / srcH > target) sw = srcH * target; else sh = srcW / target;
    const sx = Math.min(srcW - sw, Math.max(0, focus.x * srcW - sw / 2));
    const sy = Math.min(srcH - sh, Math.max(0, focus.y * srcH - sh / 2));
    ctx.save();
    if (radius > 0) {
      const r = Math.min(radius, w / 2, h / 2);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
      else {
        ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
      }
      ctx.clip();
    }
    drawScaled(ctx, src, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();
  }

  /* --------------------------------------------------------------- imports */

  async function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name));
    const known = new Set(state.photos.map((p) => p.key));
    let skipped = 0;
    const fresh = [];
    for (const f of files) {
      const key = f.name + '|' + f.size + '|' + f.lastModified;
      if (known.has(key)) continue;
      if (state.photos.length + fresh.length >= MAX_PHOTOS) { skipped++; continue; }
      known.add(key);
      fresh.push({ id: nextId++, key, pos: Date.now() + fresh.length, file: f, name: f.name, size: f.size, ready: false });
    }
    if (!fresh.length) {
      if (skipped) setStatus(`Limite de ${MAX_PHOTOS} photos atteinte.`);
      return;
    }
    state.photos.push(...fresh);
    renderThumbs();
    setStatus(`Chargement de ${fresh.length} photo${fresh.length > 1 ? 's' : ''}…`);

    const failed = [];
    let i = 0;
    const worker = async () => {
      while (i < fresh.length) {
        const p = fresh[i++];
        try { await preparePhoto(p); } catch (e) { failed.push(p); }
        updateThumb(p);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    if (failed.length) {
      const ids = new Set(failed.map((p) => p.id));
      state.photos = state.photos.filter((p) => !ids.has(p.id));
      renderThumbs();
    }
    let msg = '';
    if (failed.length) msg += `${failed.length} fichier(s) illisible(s) ignoré(s) (ex. HEIC hors Safari). `;
    if (skipped) msg += `${skipped} photo(s) au-delà de ${MAX_PHOTOS} ignorée(s).`;
    setStatus(msg || null);
    scheduleLayout();
  }

  /* Vignettes en mémoire (aperçu + liste) : on ne garde jamais l'original décodé. */
  function makeThumbs(p, img, w, h) {
    const k = Math.min(1, THUMB_MAX / Math.max(w, h));
    const t = canvas(w * k, h * k);
    drawScaled(t.getContext('2d'), img, 0, 0, w, h, 0, 0, t.width, t.height);
    p.thumb = t;
    const k2 = SIDEBAR_THUMB / Math.min(t.width, t.height);
    const st = canvas(t.width * k2, t.height * k2);
    drawScaled(st.getContext('2d'), t, 0, 0, t.width, t.height, 0, 0, st.width, st.height);
    p.thumbUrl = st.toDataURL('image/jpeg', 0.7);
  }

  /* ----------------------------------------------------------------- cache
     Les copies de travail sont gardées dans le navigateur (IndexedDB) :
     après un rechargement, les photos sont toujours là, sans réimport.
     Rien ne quitte l'appareil. Tout échec (navigation privée…) est ignoré. */
  const cache = (() => {
    let dbp = null;
    function db() {
      if (!dbp) {
        dbp = new Promise((res, rej) => {
          if (!window.indexedDB) return rej(new Error('IndexedDB indisponible'));
          const r = indexedDB.open('mosaphoto', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'key' });
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      }
      return dbp;
    }
    async function run(mode, fn) {
      try {
        const d = await db();
        return await new Promise((res, rej) => {
          const tx = d.transaction('photos', mode);
          const out = fn(tx.objectStore('photos'));
          tx.oncomplete = () => res(out && out.result);
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error);
        });
      } catch (e) {
        console.warn('Cache photos :', e);
        return null;
      }
    }
    let persistAsked = false;
    return {
      put(p) {
        if (!persistAsked && navigator.storage && navigator.storage.persist) { persistAsked = true; navigator.storage.persist().catch(() => {}); }
        return run('readwrite', (st) => st.put({
          key: p.key, pos: p.pos, name: p.name, size: p.size, w: p.w, h: p.h, focus: p.focus,
          master: p.master, masterW: p.masterW, masterH: p.masterH,
        }));
      },
      remove(key) { return run('readwrite', (st) => st.delete(key)); },
      clear() { return run('readwrite', (st) => st.clear()); },
      async all() { return (await run('readonly', (st) => st.getAll())) || []; },
    };
  })();

  async function restoreFromCache() {
    const recs = (await cache.all()).sort((a, b) => a.pos - b.pos).slice(0, MAX_PHOTOS);
    if (!recs.length) return;
    setStatus(`Restauration de ${recs.length} photo${recs.length > 1 ? 's' : ''}…`);
    const photos = recs.map((r) => ({
      id: nextId++, key: r.key, pos: r.pos, file: null, name: r.name, size: r.size,
      w: r.w, h: r.h, ar: r.w / r.h, focus: r.focus,
      master: r.master, masterW: r.masterW, masterH: r.masterH, ready: false,
    }));
    state.photos.push(...photos);
    renderThumbs();
    let i = 0;
    const bad = [];
    const worker = async () => {
      while (i < photos.length) {
        const p = photos[i++];
        try {
          const { img, release } = await loadImage(p.master);
          makeThumbs(p, img, img.naturalWidth, img.naturalHeight);
          release();
          p.ready = true;
        } catch (e) { bad.push(p); }
        updateThumb(p);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    for (const p of bad) removePhoto(p.id);
    setStatus(null);
    scheduleLayout();
  }

  async function preparePhoto(p) {
    const { img, release } = await loadImage(p.file);
    try {
      p.w = img.naturalWidth;
      p.h = img.naturalHeight;
      if (!p.w || !p.h) throw new Error('image vide');
      p.ar = p.w / p.h;
      makeThumbs(p, img, img.naturalWidth, img.naturalHeight);
      p.focus = computeFocus(p.thumb);
      // Copie de travail : sur mobile, le fichier d'origine peut devenir
      // illisible après l'import (accès temporaire du sélecteur de photos,
      // photos Google Photos dans le cloud…). On garde donc une version
      // réduite et compressée, suffisante pour l'export, sans dépendre du fichier.
      const km = Math.min(1, MASTER_MAX / Math.max(p.w, p.h));
      if (km < 1 || !/^image\/(jpeg|png|webp)$/.test(p.file.type)) {
        const m = canvas(p.w * km, p.h * km);
        drawScaled(m.getContext('2d'), img, 0, 0, p.w, p.h, 0, 0, m.width, m.height);
        p.master = await new Promise((r) => m.toBlob(r, 'image/jpeg', 0.92));
        p.masterW = m.width; p.masterH = m.height;
        m.width = m.height = 0;
      } else {
        p.master = new Blob([await p.file.arrayBuffer()], { type: p.file.type }); // déjà petit : vraie copie en mémoire
        p.masterW = p.w; p.masterH = p.h;
      }
      p.ready = true;
    } finally {
      release();
    }
    cache.put(p);
  }

  function renderThumbs() {
    els.thumbs.innerHTML = '';
    for (const p of state.photos) {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.dataset.id = p.id;
      els.thumbs.appendChild(d);
      updateThumb(p);
    }
    const n = state.photos.length;
    els.count.textContent = `${n} / ${MAX_PHOTOS}`;
    els.clearBtn.hidden = n === 0;
    updateStorageLabel();
  }

  /* Affiche la place occupée par les photos mémorisées sur l'appareil. */
  let storageTimer = 0;
  function updateStorageLabel() {
    clearTimeout(storageTimer);
    storageTimer = setTimeout(() => {
      const bytes = state.photos.reduce((s, p) => s + (p.master ? p.master.size : 0), 0);
      els.clearLabel.textContent = 'Effacer toutes les photos' + (bytes ? ` (${fmtBytes(bytes)})` : '');
    }, 300);
  }

  function updateThumb(p) {
    const d = els.thumbs.querySelector(`[data-id="${p.id}"]`);
    if (!d) return;
    d.classList.toggle('loading', !p.ready);
    updateStorageLabel();
    d.innerHTML = '';
    if (p.ready) {
      const img = document.createElement('img');
      img.src = p.thumbUrl;
      img.alt = p.name;
      img.title = `${p.name} — ${p.w}×${p.h} — ${fmtBytes(p.size)}`;
      d.appendChild(img);
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = p.ar < 0.95 ? 'P' : p.ar > 1.05 ? 'L' : '□';
      tag.title = p.ar < 0.95 ? 'Portrait' : p.ar > 1.05 ? 'Paysage' : 'Carré';
      d.appendChild(tag);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '×';
    b.title = 'Retirer';
    b.setAttribute('aria-label', `Retirer ${p.name}`);
    b.onclick = () => removePhoto(p.id);
    d.appendChild(b);
  }

  function removePhoto(id) {
    const p = state.photos.find((x) => x.id === id);
    if (!p) return;
    if (p.thumb) { p.thumb.width = p.thumb.height = 0; }
    cache.remove(p.key);
    state.photos = state.photos.filter((x) => x.id !== id);
    renderThumbs();
    scheduleLayout();
  }

  /* ---------------------------------------------------------------- layout */

  // 1080p en carré = 1080 × 1080, en 4:5 = 1080 × 1350 (publications Instagram).
  function updateResLabels() {
    const [w, h] = BASE[state.s.orientation];
    document.getElementById('res4k').textContent = `${w} × ${h}`;
    document.getElementById('res1080').textContent = `${w / 2} × ${h / 2}`;
  }

  function baseSize() { return BASE[state.s.orientation]; }
  function outSize() {
    const [w, h] = baseSize();
    const k = RES_SCALE[state.s.resolution];
    return [w * k, h * k];
  }
  function readyPhotos() { return state.photos.filter((p) => p.ready); }

  function saveSettings() {
    try { localStorage.setItem('mosaphoto.settings', JSON.stringify({ s: state.s, seed: state.seed })); } catch (e) { /* ignoré */ }
  }

  function loadSettings() {
    try {
      const d = JSON.parse(localStorage.getItem('mosaphoto.settings') || 'null');
      if (!d) return;
      for (const k of Object.keys(state.s)) if (k in d.s && typeof d.s[k] === typeof state.s[k]) state.s[k] = d.s[k];
      if (d.seed) state.seed = d.seed;
      if (!BASE[state.s.orientation]) state.s.orientation = 'landscape';
    } catch (e) { /* ignoré */ }
    document.querySelectorAll('.seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === state.s[seg.dataset.name]));
    });
    els.gap.value = state.s.gap; els.gapOut.textContent = state.s.gap + ' px';
    els.radius.value = state.s.radius; els.radiusOut.textContent = state.s.radius + ' px';
    els.bg.value = state.s.bg;
    els.border.checked = state.s.border;
    els.keepOrder.checked = state.s.keepOrder;
    els.quality.value = state.s.quality; els.qualityOut.textContent = state.s.quality;
    els.maxSize.value = String(state.s.maxSize);
  }

  let layoutTimer = 0;
  function scheduleLayout() {
    saveSettings();
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(runLayout, 120);
  }

  function runLayout() {
    const photos = readyPhotos();
    updateButtons();
    if (!photos.length) {
      state.layout = null;
      drawPreview();
      return;
    }
    showBusy('Composition…');
    // laisse le navigateur afficher l'indicateur avant le calcul
    setTimeout(() => {
      const [W, H] = baseSize();
      const gap = state.s.gap;
      const res = MosaicLayout.computeLayout(photos.map((p) => p.ar), {
        width: W, height: H, gap, padding: state.s.border ? gap : 0,
        keepOrder: state.s.keepOrder, seed: state.seed, timeBudget: 160,
      });
      state.layout = { ...res, photos, W, H };
      hideBusy();
      drawPreview();
    }, 30);
  }

  function drawPreview() {
    saveSettings();
    const L = state.layout;
    els.frame.classList.toggle('portrait', state.s.orientation === 'portrait');
    els.frame.classList.toggle('square', state.s.orientation === 'square');
    els.frame.classList.toggle('insta', state.s.orientation === 'insta');
    updateResLabels();
    els.empty.hidden = !!L;
    const cv = els.preview;
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(rect.width * dpr));
    cv.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = cv.getContext('2d');
    if (!L) { ctx.clearRect(0, 0, cv.width, cv.height); updateMeta(); return; }
    const k = cv.width / L.W;
    ctx.fillStyle = state.s.bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    for (const c of L.cells) {
      const p = L.photos[c.index];
      const x0 = Math.round(c.x * k), y0 = Math.round(c.y * k);
      const x1 = Math.round((c.x + c.w) * k), y1 = Math.round((c.y + c.h) * k);
      drawCell(ctx, p.thumb, p.thumb.width, p.thumb.height, p.focus, x0, y0, x1 - x0, y1 - y0, state.s.radius * k);
    }
    updateMeta();
  }

  function updateMeta() {
    const L = state.layout;
    const [w, h] = outSize();
    if (!L) { els.meta.textContent = ''; return; }
    const p = L.photos;
    const nP = p.filter((x) => x.ar < 0.95).length;
    const nL = p.filter((x) => x.ar > 1.05).length;
    const nS = p.length - nP - nL;
    const total = p.reduce((s, x) => s + x.size, 0);
    const dir = { rows: 'en rangées', cols: 'en colonnes', tree: 'en blocs' }[L.direction];
    const parts = [
      `${w} × ${h}`,
      `${p.length} photo${p.length > 1 ? 's' : ''} (${nL} paysage, ${nP} portrait${nS ? `, ${nS} carrée` : ''})`,
      `composition ${dir}`,
      `recadrage moyen ${L.cropPct < 0.1 ? '< 0,1' : L.cropPct.toFixed(1).replace('.', ',')} %`,
      `originaux ${fmtBytes(total)}`,
    ];
    els.meta.textContent = parts.join('  ·  ');
  }

  /* ---------------------------------------------------------------- export */

  function toBlob(cv, type, q) {
    return new Promise((res) => cv.toBlob(res, type, q));
  }

  async function exportMosaic() {
    const L = state.layout;
    if (!L || state.exporting) return;
    state.exporting = true;
    updateButtons();
    els.result.hidden = true;
    const [W, H] = outSize();
    const k = W / L.W;
    try {
      const cv = canvas(W, H);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = state.s.bg;
      ctx.fillRect(0, 0, W, H);
      let done = 0;
      let fallbacks = 0;
      // Les originaux sont décodés un par un puis libérés : mémoire maîtrisée.
      for (const c of L.cells) {
        showBusy(`Rendu ${++done} / ${L.cells.length}…`);
        const p = L.photos[c.index];
        const x0 = Math.round(c.x * k), y0 = Math.round(c.y * k);
        const x1 = Math.round((c.x + c.w) * k), y1 = Math.round((c.y + c.h) * k);
        const cw = x1 - x0, ch = y1 - y0;
        // Si la vignette suffit (petite cellule), inutile de décoder l'original.
        const need = Math.max(cw / p.thumb.width, ch / p.thumb.height);
        // Source la plus légère suffisante : vignette → copie de travail → original.
        // Si une source est illisible, on se rabat sur la précédente.
        const needM = p.masterW ? Math.max(cw / p.masterW, ch / p.masterH) : 2;
        const sources = need <= 0.9 ? [] : needM <= 1 ? [p.master] : [p.file, p.master];
        let drawn = false;
        for (const src of sources) {
          if (!src) continue;
          try {
            const { img, release } = await loadImage(src);
            drawCell(ctx, img, img.naturalWidth, img.naturalHeight, p.focus, x0, y0, cw, ch, state.s.radius * k);
            release();
            drawn = true;
            break;
          } catch (e) { /* source suivante */ }
        }
        if (!drawn) {
          if (sources.length) fallbacks++;
          drawCell(ctx, p.thumb, p.thumb.width, p.thumb.height, p.focus, x0, y0, cw, ch, state.s.radius * k);
        }
        if (done % 4 === 0) await new Promise((r) => setTimeout(r, 0));
      }

      showBusy('Compression…');
      const type = state.s.format;
      const limit = state.s.maxSize * 1024 * 1024;
      let q = state.s.quality / 100;
      let blob = await toBlob(cv, type, q);
      let note = '';
      if (limit && blob.size > limit) {
        // Recherche dichotomique de la meilleure qualité sous la limite.
        let lo = 0.4, hi = q, best = null;
        for (let i = 0; i < 7; i++) {
          const mid = (lo + hi) / 2;
          const b = await toBlob(cv, type, mid);
          if (b.size <= limit) { best = { b, q: mid }; lo = mid; } else hi = mid;
        }
        if (best) { blob = best.b; q = best.q; note = ` · qualité ajustée à ${Math.round(q * 100)} pour tenir sous ${state.s.maxSize} Mo`; }
        else { blob = await toBlob(cv, type, 0.4); q = 0.4; note = ` · impossible de descendre sous ${state.s.maxSize} Mo, qualité minimale utilisée`; }
      }
      cv.width = cv.height = 0;

      const ext = type === 'image/webp' ? 'webp' : 'jpg';
      const name = `mosaique-${state.s.resolution === '4k' ? '4k' : '1080p'}-${{ portrait: 'portrait', square: 'carre', insta: '4x5', landscape: 'paysage' }[state.s.orientation]}-${L.photos.length}photos.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      if (fallbacks) note += ` · ${fallbacks} photo(s) illisible(s) au moment de l\u2019export, rendue(s) depuis l\u2019aperçu (moins net)`;
      const total = L.photos.reduce((s, x) => s + x.size, 0);
      els.result.innerHTML = `<b>${name}</b><br>${W} × ${H} · <b>${fmtBytes(blob.size)}</b> (originaux : ${fmtBytes(total)})${note}`;
      els.result.hidden = false;
    } catch (e) {
      console.error(e);
      els.result.textContent = 'Erreur pendant l’export : ' + e.message;
      els.result.hidden = false;
    } finally {
      state.exporting = false;
      hideBusy();
      updateButtons();
    }
  }

  /* -------------------------------------------------------------------- ui */

  function setStatus(msg) {
    const n = state.photos.length;
    els.status.textContent = msg || (n ? `${n} photo${n > 1 ? 's' : ''} · gardées sur cet appareil` : 'Ajoutez des photos pour commencer');
  }
  function showBusy(t) { els.busyText.textContent = t; els.busy.hidden = false; }
  function hideBusy() { els.busy.hidden = true; }
  function updateButtons() {
    const has = readyPhotos().length > 0;
    els.exportBtn.disabled = !has || state.exporting;
    els.shuffleBtn.disabled = !has || state.exporting || state.s.keepOrder && readyPhotos().length > 16;
  }

  document.querySelectorAll('.seg').forEach((seg) => {
    const name = seg.dataset.name;
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      state.s[name] = b.dataset.value;
      saveSettings();
      if (name === 'orientation') scheduleLayout();
      else updateMeta();
    });
  });

  els.gap.addEventListener('input', () => { state.s.gap = +els.gap.value; els.gapOut.textContent = els.gap.value + ' px'; scheduleLayout(); });
  els.radius.addEventListener('input', () => { state.s.radius = +els.radius.value; els.radiusOut.textContent = els.radius.value + ' px'; drawPreview(); });
  els.bg.addEventListener('input', () => { state.s.bg = els.bg.value; drawPreview(); });
  els.border.addEventListener('change', () => { state.s.border = els.border.checked; scheduleLayout(); });
  els.keepOrder.addEventListener('change', () => { state.s.keepOrder = els.keepOrder.checked; scheduleLayout(); });
  els.quality.addEventListener('input', () => { state.s.quality = +els.quality.value; els.qualityOut.textContent = els.quality.value; saveSettings(); });
  els.maxSize.addEventListener('change', () => { state.s.maxSize = +els.maxSize.value; saveSettings(); });
  els.shuffleBtn.addEventListener('click', () => { state.seed = (state.seed * 48271 + 11) % 2147483647; scheduleLayout(); });
  els.exportBtn.addEventListener('click', exportMosaic);
  els.clearBtn.addEventListener('click', () => {
    const n = state.photos.length;
    if (!confirm(`Effacer les ${n} photo${n > 1 ? 's' : ''} de Mosaphoto ?\n\nElles seront aussi supprimées de la mémoire de l\u2019appareil. Tes photos d\u2019origine (galerie, Google Photos) ne sont pas touchées.`)) return;
    state.photos.forEach((p) => { if (p.thumb) p.thumb.width = p.thumb.height = 0; });
    state.photos = [];
    cache.clear();
    els.result.hidden = true;
    renderThumbs(); setStatus('Photos effacées.'); scheduleLayout();
  });


  els.fileInput.addEventListener('change', () => { addFiles(els.fileInput.files); els.fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); els.dropzone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => {
    e.preventDefault();
    if (t === 'drop' || !e.relatedTarget) els.dropzone.classList.remove('over');
  }));
  document.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawPreview, 100); });

  loadSettings();
  // WebP : désactivé si le navigateur ne sait pas l'encoder (ex. anciens Safari).
  if (!canvas(1, 1).toDataURL('image/webp').startsWith('data:image/webp')) {
    els.webpBtn.disabled = true;
    els.webpBtn.title = 'Non pris en charge par ce navigateur';
    if (state.s.format === 'image/webp') {
      state.s.format = 'image/jpeg';
      els.webpBtn.classList.remove('on');
      document.querySelector('[data-value="image/jpeg"]').classList.add('on');
    }
  }
  drawPreview();
  restoreFromCache();
})();
