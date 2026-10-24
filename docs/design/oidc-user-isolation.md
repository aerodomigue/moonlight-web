# SSO et isolation des utilisateurs : cadrage et validation

Branche dédiée : `feat/oidc-user-isolation`.
Référence initiale : `95d2476734472e1705ff46de3c34f368483e4aa4`.

Ce document consigne les décisions et les exigences de validation avant
l'implémentation. La branche ne fournit pas encore de connexion OIDC.

## Comportement demandé

- PIN seul : connexion au compte propriétaire local unique.
- SSO seul : redirection automatique vers le fournisseur OIDC ; les erreurs
  et la déconnexion doivent rester utilisables sans boucle de redirection.
- PIN et SSO : choix explicite de la méthode à la connexion.
- Un PIN d'appairage est lié à un compte ; un compte SSO peut aussi recevoir
  un PIN lorsque cette méthode est activée.
- Authentik est le premier fournisseur à valider. Fournisseur, URL publique
  et liste explicite des administrateurs sont configurables.
- Chaque utilisateur ajoute ses machines. Deux utilisateurs peuvent ajouter
  indépendamment le même PC, avec des enregistrements et appairages distincts.
- Les machines et appairages existants sont conservés et attribués au
  propriétaire local lors de la migration.

## Points relevés dans le code actuel

- `SessionInfo` représente un navigateur, sans identité utilisateur persistante.
- Le PIN est global ; les sessions et les clés d'appairage sont déjà gérées
  par `AuthManager` et doivent conserver leurs garanties de révocation.
- `ComputerManager` stocke les machines globalement, par UUID physique.
  L'isolation nécessite de distinguer l'enregistrement utilisateur du PC.
- Les slots de streaming contiennent une session, mais cela ne remplace pas
  l'autorisation de chaque route et de chaque connexion WebSocket.
- Les identifiants et caches du navigateur doivent être examinés pour éviter
  qu'un changement de compte réutilise les données du compte précédent.
- Le reverse proxy impose actuellement une redirection Authentik en amont.
  Ce comportement devra être adapté pour rendre possible le choix PIN ou SSO.

## Tests à chaque étape

Chaque changement fonctionnel doit être accompagné de tests des comportements
et des refus pertinents. Exécuter les tests ciblés à chaque étape, puis les
suites concernées avant chaque commit fonctionnel. Une validation complète
est requise avant fusion. Tout nouvel échec doit être corrigé ou expliqué ;
ne pas masquer les échecs existants par une exclusion générale.

| Domaine     | Scénarios à couvrir                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| Connexion   | Les trois modes, méthode désactivée refusée côté API, erreur fournisseur, déconnexion sans boucle              |
| OIDC        | Code avec PKCE, transaction liée au navigateur, `state` et `nonce`, signature et claims, expiration et rejeu   |
| Comptes     | Identité stable `iss` + `sub`, PIN du bon compte, liste d'administrateurs, aucune promotion implicite          |
| Machines    | Deux comptes distincts, même PC ajouté deux fois, accès direct aux identifiants d'autrui refusé                |
| Opérations  | Applications et images, WOL, paramètres WOL, appairage, renommage, suppression et backend                      |
| Streaming   | Démarrage, reprise, arrêt, slots et WebSocket ; aucune commande sur le flux d'un autre compte                  |
| Persistance | Migration, redémarrage, révocation, expiration, conservation des appairages et changement de compte navigateur |
| Réseau      | LAN, reverse proxy, Internet et UPnP préservés ; services externes MoonlightWeb toujours désactivés            |

## Revue avant fusion

Relire l'ensemble du diff par rapport à `main`, puis suivre les parcours de
connexion et de streaming de bout en bout. Examiner particulièrement les
chemins alternatifs d'authentification, les privilèges locaux/admin, les
callbacks asynchrones, les caches et les accès par identifiant fourni par le
client. Vérifier les secrets, les journaux, la configuration et la migration.
Consigner les corrections, résultats des tests et limites restantes dans la PR.

## État de référence vérifié le 24 octobre 2026

- `npm run check` : formatage, ESLint et traductions valides.
- `npm run coverage` : 1 589 tests valides ; couverture des lignes 93,41 %.
- Compilation de la suite backend : réussie.
- Suite backend complète : 16 699 assertions valides sur 16 704. Les cinq
  échecs existants concernent le scénario Steam Windows exécuté sous Linux,
  dans `test_launcher_detect.cpp`, lignes 54 à 58. La suite n'est donc pas verte.
- `build-tests/run_tests --wake-on-lan` : 65 assertions valides.
- `build-tests/run_tests --reverse-proxy` : 58 assertions valides, dont la
  conservation des réglages Internet/UPnP. Cela ne constitue pas un essai réel
  d'ouverture de ports sur un routeur.

Les journaux locaux sont dans `work/oidc-baseline-*.log` et ne sont pas suivis
par Git. Les tests du nouveau SSO et de l'isolation restent à implémenter.
