# Diagnostiquer la fluidité du flux

Le compteur FPS principal décrit le décodage. Il ne suffit pas à prouver que toutes
les images sont affichées. Le rendu vidéo distingue maintenant les images acceptées
et abandonnées ; les paramètres manuels ne sont plus remplacés par l'adaptation à
la congestion. Les paramètres laissés en Auto restent adaptatifs.

Pour une mesure temporaire, terminer la connexion PIN/SSO, revenir au dashboard,
puis ouvrir la console du navigateur et exécuter :

```js
localStorage.setItem('mw_perf_diag', '1');
```

Le résultat `undefined` est normal. Lancer ensuite le flux **sans recharger la page** :
le réglage est lu à sa création. Un changement de compte peut effacer ce réglage de
diagnostic. Pour les lignes `[perf]` historiques, activer les statistiques et garder
leur panneau ouvert ; le nouvel export fonctionne aussi avec ce panneau masqué.
Afficher ensuite une scène animée.
Après dix secondes de chauffe et soixante secondes de mesure, **avant de quitter
le flux**, copier le diagnostic dans Chromium :

```js
copy(JSON.stringify(window.mwStreamingDiagnostics.export(), null, 2));
```

Le JSON conserve au maximum trois minutes de compteurs et 16384 observations de
composition/rafraîchissement. Il ne contient ni images, ni contenu du presse-papiers,
ni identifiants de compte, ni adresse de PC, ni secrets. Il n'est pas envoyé
automatiquement au serveur. Quitter le flux efface cette capture temporaire.
Pour désactiver les diagnostics, puis revenir au fonctionnement habituel :

```js
localStorage.removeItem('mw_perf_diag');
```

Recharger ensuite la page. Si le stockage est interdit, l'activation par ce mécanisme
n'est pas disponible ; aucune règle de sécurité ne doit être désactivée pour l'obtenir.

## Lecture des mesures

- `requestedFps` : cadence demandée, pas une mesure.
- `backend.relayReceived` : images complètes livrées au relais ; `workerDrops` compte
  séparément les images abandonnées avant cette livraison.
- `backend.submitted` : images soumises au transport, sans garantie de réception.
- `counters.received`, `decoded`, `rendered` : réception navigateur, décodage et
  acceptation par le renderer. `dropped` et `pipeline.dropRender` expliquent des pertes.
- `counters.decodeSubmitted` : compteur historique d'entrée du décodeur, distinct
  des images complètes reçues avant les rejets pour ancienneté ou erreur de décodage.
  Il est absent pour le transport vidéo natif, qui fournit ses propres compteurs.
- `composed` : compteur du navigateur pour les images vidéo soumises à la composition.
  Il reste absent si la mesure n'est pas disponible ; aucun équivalent n'est inventé
  pour les canvas. Ce n'est pas une mesure physique de l'écran.
- `callbackGaps` : callbacks vidéo manqués, pas nécessairement des images perdues.
- `latency`, `pipeline`, `mainThread` : délais, files, pertes et occupation du navigateur.
  Les percentiles du worker ne sont présents que s'il les fournit réellement.

Les compteurs sont cumulatifs : calculer leurs différences sur l'intervalle mesuré,
en tenant compte des réinitialisations et des champs absents. Pour une comparaison
avec Moonlight natif, garder le même PC, réseau, contenu animé, résolution, codec,
HDR et débit. Faire trois passages de 60 secondes par client ; comparer aussi
120/144/240 FPS. Une scène immobile n'est pas un test de débit maximal.

Les résultats et limites de la correction sont décrits dans la
[revue de cadence](../design/streaming-frame-pacing-review.md).

Les essais directs sur Apollo distinguent également la livraison réseau du rendu :
le banc sans décodage reçoit 144 FPS en 4K HEVC 4:2:0 SDR/HDR, contre environ
102 FPS en 4:4:4 sur la session testée. Ce résultat ne garantit pas la présentation
sur chaque navigateur. Les mesures détaillées et les limites matérielles figurent
dans la revue ; aucun profil de qualité n'est remplacé automatiquement.
