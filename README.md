# Mosaphoto

Application web qui crée un **mur de photos** (mosaïque) à partir de 1 à 100 photos,
avec une composition **automatique** qui tient compte de l'orientation de chaque photo.

Aucune installation, aucun serveur : ouvrez `index.html` dans un navigateur
(ou publiez le dossier sur GitHub Pages). Les photos ne quittent jamais l'ordinateur.

## Fonctions

- **Jusqu'à 100 photos** (glisser-déposer ou sélection), doublons ignorés, retrait individuel.
- **2 presets de format** : Paysage (16:9) et Portrait (9:16).
- **2 qualités** : 4K (3840 × 2160) et 1080p (1920 × 1080). La composition est identique entre les deux.
- **Composition intelligente** (`js/layout.js`) :
  - mise en page « justifiée » : un portrait prend une tuile haute et étroite, un paysage une tuile large ;
  - répartition optimale des photos en rangées (programmation dynamique) ;
  - recherche locale : mélange portraits/paysages, échanges de photos et **empilement de deux
    photos** dans une tuile pour remplir exactement le cadre ;
  - compare rangées, colonnes et (pour ≤ 16 photos) un découpage en blocs, et garde la
    composition qui **recadre le moins** (souvent < 1 %) avec des tailles homogènes ;
  - recadrage résiduel centré sur le **point d'intérêt** de chaque photo (zone la plus détaillée).
- Réglages : espacement, coins arrondis, couleur de fond, bordure, garder l'ordre d'import,
  bouton « Autre composition ».
- Orientation EXIF respectée (photos de smartphone).

## Optimisation du poids

- Les originaux ne sont jamais gardés décodés en mémoire : seules des vignettes servent à l'aperçu,
  et chaque original est décodé puis libéré un par un lors de l'export.
- Chaque photo est réduite à la taille exacte de sa tuile, avec une réduction progressive (meilleure netteté).
- Export **JPEG** ou **WebP** (plus léger), qualité réglable, métadonnées supprimées.
- **Poids max** (1 / 2 / 5 / 10 Mo) : la qualité est ajustée automatiquement (dichotomie)
  pour rester sous la limite avec la meilleure qualité possible.

Exemple : 60 photos (12,9 Mo d'originaux) → mosaïque 4K JPEG d'environ 0,4–3 Mo selon le contenu.

## Fichiers

- `index.html` — interface
- `css/style.css` — styles
- `js/layout.js` — moteur de composition (utilisable aussi sous Node : `require('./js/layout.js')`)
- `js/app.js` — import, aperçu, rendu et export
