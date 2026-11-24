/* Calcul de la composition en arrière-plan : l'interface reste fluide.
   1) une composition rapide est envoyée tout de suite,
   2) puis une recherche plus longue l'affine si elle trouve mieux. */
importScripts('layout.js');

self.onmessage = (e) => {
  const { id, ars, opts } = e.data;
  const L = self.MosaicLayout;
  const N = Math.max(1, Math.min(opts.slides || 1, ars.length));
  const split = N > 1 && !opts.pano;
  const perSlide = split ? Math.ceil(ars.length / N) : ars.length; // photos par mosaïque calculée
  const t0 = performance.now();
  const quick = L.computeSlides(ars, { ...opts, timeBudget: 50 });
  const quickMs = performance.now() - t0;
  const budget = perSlide <= 16 ? 900 : 600; // par sens testé (rangées, colonnes, blocs)
  const dirs = perSlide > 1 && perSlide <= 16 ? 3 : 2;
  // Durée prévue de l'affinage, pour la barre de progression.
  const expectedMs = (split ? budget * (0.6 + 0.5 * dirs) : dirs * budget) + quickMs * 1.2;
  self.postMessage({ id, res: quick, final: false, expectedMs });
  const full = L.computeSlides(ars, { ...opts, timeBudget: budget });
  self.postMessage({ id, res: full.score < quick.score ? full : quick, final: true });
};
