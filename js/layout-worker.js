/* Calcul de la composition en arrière-plan : l'interface reste fluide.
   1) une composition rapide est envoyée tout de suite,
   2) puis une recherche plus longue l'affine si elle trouve mieux. */
importScripts('layout.js');

self.onmessage = (e) => {
  const { id, ars, opts } = e.data;
  const n = ars.length;
  const t0 = performance.now();
  const quick = self.MosaicLayout.computeLayout(ars, { ...opts, timeBudget: 50 });
  const quickMs = performance.now() - t0;
  const budget = n <= 16 ? 900 : 600; // par sens testé (rangées, colonnes, blocs)
  const dirs = n > 1 && n <= 16 ? 3 : 2;
  // Durée prévue de l'affinage, pour la barre de progression.
  const expectedMs = dirs * budget + quickMs * 1.2;
  self.postMessage({ id, res: quick, final: false, expectedMs });
  const full = self.MosaicLayout.computeLayout(ars, { ...opts, timeBudget: budget });
  self.postMessage({ id, res: full.score < quick.score ? full : quick, final: true });
};
