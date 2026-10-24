# Revue : SSO et isolation des machines

Branche : `feat/oidc-user-isolation`. Comparaison avec `main` à partir de
`95d2476734472e1705ff46de3c34f368483e4aa4`. Revue effectuée le 24 octobre 2026.

## Parcours et autorisations examinés

- Configuration PIN/SSO, démarrage, discovery HTTPS, échange du code avec PKCE,
  validation des signatures RS256/ES256 et des claims OIDC.
- Création des comptes par `iss` + `sub`, rôles explicites, création et révocation
  des sessions, cookies, PIN par compte et changement de compte dans le navigateur.
- Stockage et migration des machines, découverte, ajout manuel, identité de
  certificat, appairage, listes d'applications et images.
- Contrôles REST, WebSocket direct et ancien transport tunnel, démarrage,
  commutation de qualité, arrêt normal et forcé, invitations et callbacks.
- Préservation des réglages Internet/UPnP et du WOL, absence de réactivation
  des services externes MoonlightWeb, confidentialité des journaux.

## Problèmes corrigés pendant la revue

| Constat                                                                                | Correction et vérification                                                                                            |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Le stockage par UUID physique fusionnait les machines des comptes                      | Identifiant d'enregistrement par compte ; tests de persistance et ajout du même PC par deux comptes                   |
| Le choix d’un backend interne pouvait contourner la propriété de l’écran du serveur    | Capture native refusée sur les enregistrements SSO ; test de tentative de sélection du backend natif                  |
| Un ancien identifiant brut pouvait entrer en collision avec un identifiant privé       | Fusion et réponse refusées si le propriétaire diffère ; test avec un faux PC revendiquant l’identifiant privé         |
| Une session valide suffisait pour accéder aux routes d'une autre machine               | Autorisation centrale avant dispatch et listes filtrées ; tests GET/POST/DELETE croisés                               |
| Un utilisateur pouvait viser le slot de signalisation d'un autre                       | Vérification de la session propriétaire pour WebSocket et les slots standby                                           |
| L'arrêt forcé traitait les slots et identifiants de manière globale                    | Arrêt limité à l'enregistrement demandé ; conservation des autres comptes                                             |
| Un arrêt asynchrone pouvait être suivi d'un démarrage étranger avant la fin du cancel  | Réservation du PC physique pendant l'opération ; test d'intégration avec cancel suspendu                              |
| Une fonction récursive conservait son propre callback indéfiniment                     | Référence faible ; test confirmant que la réservation est libérée après l'arrêt                                       |
| Une suppression pendant un callback pouvait invalider son pointeur de machine          | Suppression refusée pendant une opération active ; test d'intégration                                                 |
| Le partage historique pouvait cibler un enregistrement SSO                             | Invitations limitées au propriétaire local et à ses machines, avec contrôle du PC physique pour les invités           |
| Un sous-domaine pouvait tenter de déposer un cookie de compte                          | Cookies `__Host-`, noms sensibles à la casse, refus des nouveaux jetons dans l'ancien cookie ; tests de falsification |
| Le changement de compte pouvait laisser les anciennes données du navigateur            | Nettoyage du stockage local au changement, révocation de la session remplacée ; tests unitaires et d'intégration      |
| Un retour SSO ou une déconnexion pouvait relancer une boucle automatique               | Écran de reprise explicite ; tests Vitest et Chromium                                                                 |
| Les droits de navigation restaient ceux du visiteur anonyme après un PIN de compte SSO | Nouvelle lecture des droits après connexion ; trois tests de rôle et contrôle Chromium du PIN administrateur          |
| Une réponse SSO tardive pouvait rediriger après fermeture de la vue                    | Vérification du cycle de vie ; test avec réponse différée                                                             |
| Des contrôles PIN restaient visibles en mode SSO seul                                  | Masquage des contrôles et refus serveur des méthodes désactivées                                                      |
| Une requête vers un PC pouvait hériter du privilège de boucle locale du serveur | Requêtes sortantes marquées et exemption locale refusée ; test opérateur local / requête interne |
| Les traces OAuth pouvaient contenir un code ou un secret                               | Masquage des champs OAuth dans les archives, tests de nettoyage                                                       |

## Validation locale

- Compilation du serveur natif et des tests réussie.
- Tests ciblés des identités, PIN, autorisations et signatures : 139 assertions
  valides. WOL : 65 ; reverse proxy/Internet/UPnP : 58.
- Sept scénarios d'intégration avec le vrai serveur, un fournisseur OIDC HTTPS
  local et un faux PC : comptes séparés, accès croisés, cookie/state/rejeu,
  secret fichier, TLS, sessions temporaires, redémarrage et arrêt asynchrone.
- Chromium : interface française, choix des méthodes, SSO seul, redirection
  entre deux sites, cookie de session, identité d'appairage et déconnexion.
- Quatre suites CTest valides : sécurité, OIDC, native-host et licence.
  Le scénario OIDC est exécuté sous Linux par la CI existante.
- Frontend : 1 612 tests valides, couverture des lignes 93,11 %, formatage,
  ESLint et traductions valides. C++ : clang-format 19 et cppcheck sur les sources modifiées.
- La suite backend complète sous Linux conserve les cinq échecs de référence
  de `test_launcher_detect.cpp` (chemins Steam Windows). Aucun nouvel échec
  relevé. La CI Windows reste le contrôle de la suite complète sur sa plateforme.

## Limites à conserver dans la description de PR

La configuration du vrai client Authentik et un flux vidéo sur un PC réel
n'ont pas été validés par ces fixtures. Les invitations des comptes SSO et
la déconnexion globale/back-channel OIDC sont hors de cette première version.
Un Sunshine/Apollo à bureau unique ne devient pas un serveur à plusieurs bureaux :
la prise de contrôle d'un autre compte est refusée. Les anciens enregistrements
restent au propriétaire local ; un compte SSO effectue son propre appairage.

La fusion doit attendre les résultats de CI du commit retenu. Cette revue décrit
les contrôles effectués et leurs limites ; elle ne garantit pas l'absence de tout bug.
