/* Calcul de la composition en arrière-plan : l'interface reste fluide.
   1) une composition rapide est envoyée tout de suite,
   2) puis une recherche plus longue l'affine si elle trouve mieux. */
importScripts('layout.js');

self.onmessage = (e) => {
  const { id, ars, opts } = e.data;
  const quick = self.MosaicLayout.computeLayout(ars, { ...opts, timeBudget: 50 });
  self.postMessage({ id, res: quick, final: false });
  const n = ars.length;
  const budget = n <= 16 ? 900 : 600; // par sens testé (rangées, colonnes, blocs)
  const full = self.MosaicLayout.computeLayout(ars, { ...opts, timeBudget: budget });
  self.postMessage({ id, res: full.score < quick.score ? full : quick, final: true });
};
