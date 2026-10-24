# Administration des utilisateurs et de la connexion : revue

Branche : `feat/admin-users-login`, depuis `dbb605b63647f217add199e25b416030f85213d0`.

## Comportement retenu

Deux sections administrateur : connexion PIN/SSO et gestion des comptes locaux/SSO.
Les nouveaux comptes locaux ont un PIN à usage unique de cinq minutes. Les comptes
SSO sont créés automatiquement, avec rôle utilisateur par défaut. Le rattachement
explicite à un compte local exige un parcours OIDC vérifié et une confirmation.

Les transferts et duplications administrateur conservent l'appairage ; les copies
partagent volontairement le certificat client. L'ajout normal reste indépendant.
Supprimer un compte retire ses enregistrements, sans toucher aux PC. Un compte SSO
supprimé peut revenir vide ; la désactivation interdit son accès.

## Vérifications et corrections de revue

- Les nouvelles routes exigent les droits administrateur et le contrôle CSRF
  existant. Les routes utilisateur gardent le filtrage par propriétaire.
- Le PIN historique du propriétaire ne donne pas automatiquement l'administration
  aux anciens appareils ; l'étape du mot de passe distant est conservée. Les
  autres comptes utilisateur ne peuvent pas contourner leur rôle par cette porte.
- Le secret OIDC est enregistré dans un fichier privé atomique, jamais renvoyé par
  les API. Les transactions et callbacks obsolètes sont annulés à chaque changement.
- SSO seul exige une véritable connexion réussie d'un administrateur avec les
  paramètres proposés. Le dernier administrateur utilisable est protégé.
- Les droits et désactivations survivent au rafraîchissement du profil SSO. Les
  associations sont uniques par issuer/sujet et ne se font jamais par e-mail.
- Une association vérifiée est temporaire, à usage unique, liée à la session de
  l'administrateur et à la révision de configuration. Elle ne remplace pas sa session.
- Les suppressions de comptes utilisent un état durable de suppression ; la reprise
  se fait avec le compte bloqué. Les sessions sont sauvegardées atomiquement avec
  permissions `0600` sous Unix (répertoire du profil utilisateur sous Windows), y compris lors du nettoyage de sessions ignorées au démarrage.
- Un ajout réseau déjà engagé ne peut pas recréer une machine pour un compte
  supprimé ou désactivé. Un worker ne démarre pas après révocation de sa session.
- La fermeture des WebSockets et des workers est limitée aux sessions révoquées.
  Les indicateurs de streaming ne s'annulent plus entre comptes concurrents.
- Les mutations de machines occupées sont refusées, pour les routes administrateur
  comme pour la suppression utilisateur. Une collision de destination n'écrase rien.
- Les copies conservent leur référence de certificat après suppression de la source.
  Aucun désappairage ou arrêt distant n'est effectué pour supprimer un enregistrement.
- L'interface échappe les noms, garde les protections après génération d'un PIN et
  ignore les réponses arrivant après fermeture. Les confirmations traduites affichent
  les vrais noms et quantités. Les écrans ont été vérifiés sur ordinateur et mobile.

## Validation

- Tests ciblés à chaque étape, puis suites frontend et backend complètes.
- Frontend : 1 631 tests, couverture des lignes 93,11 %, Prettier/ESLint/i18n.
- Intégration : 14 scénarios sur le vrai serveur avec issuer HTTPS, signatures et PC
  simulé : comptes, rôles, sessions, copie/transfert, rattachement et conflits,
  désactivation, reprise après interruption, opérations en cours, callbacks obsolètes,
  refus CSRF et fermeture du seul WebSocket révoqué.
- Quatre suites CTest : sécurité, OIDC/administration, native-host et licence.
- Revue du formatage C++ 19 et analyse cppcheck des sources modifiées.
- Les cinq attentes de chemins Steam Windows sous Linux sont préexistantes.
  La suite complète est aussi vérifiée sous Windows par la CI. Un essai fortement
  concurrent a également déclenché les limites de timing du test IPC existant ;
  la réexécution hors compilations concurrentes confirme uniquement les cinq
  échecs Steam de référence.

## Livraison et limites

La fusion attend la CI du commit final et la validation du paquet Linux. Le
redéploiement natif sur 10.2.10.105 conserve PIN, données, Internet, UPnP et WOL,
avec sauvegarde de l'état et retour arrière. Le lecteur de comptes version 2
nécessite une restauration de cet état pour revenir à un ancien binaire.

Le vrai fournisseur Authentik et une session vidéo sur un PC réel ne sont pas
reproduits par les fixtures. Le proxy public impose encore Authentik en amont ;
son adaptation est distincte. Aucun mécanisme de déconnexion globale OIDC n'est
ajouté. Cette revue décrit les contrôles effectués, sans garantir l'absence de bug.
