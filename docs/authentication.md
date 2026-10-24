# Connexion par PIN et OpenID Connect

Moonlight-Web peut accepter le PIN, le SSO, ou proposer les deux. La configuration
peut être modifiée dans **Administration → Connexion**, sans redémarrage. Le protocole utilisé pour identifier les utilisateurs est
OpenID Connect, avec Authorization Code et PKCE S256.

| Variable | Valeur / comportement |
| --- | --- |
| `MW_AUTH_METHODS` | `pin` par défaut, `sso`, ou `pin,sso` |
| `MW_PUBLIC_URL` | Origine HTTPS publique de cette installation, sans chemin |
| `MW_OIDC_ISSUER` | Issuer exact indiqué par le fournisseur OIDC, barre finale comprise s'il y en a une |
| `MW_OIDC_CLIENT_ID` | Identifiant de l'application OIDC |
| `MW_OIDC_CLIENT_SECRET_FILE` | Fichier contenant le secret client, accessible au compte du service |
| `MW_OIDC_CLIENT_SECRET` | Autre possibilité : secret dans l'environnement ; le fichier a priorité |
| `MW_OIDC_ADMIN_SUBJECTS` | Liste séparée par des virgules des valeurs `sub` autorisées à administrer |
| `MW_OIDC_CA_FILE` | Facultatif : certificat PEM d'une CA privée supplémentaire pour le fournisseur |

Les connexions au fournisseur vérifient toujours TLS. Les signatures RS256 et
ES256 sont prises en charge. Le fournisseur doit annoncer PKCE S256. Les clients
confidentiels peuvent utiliser `client_secret_basic` ou `client_secret_post` ;
un client public doit annoncer la méthode `none` et utiliser PKCE.

## Configuration Authentik

Créer une application avec un fournisseur **OAuth2/OpenID Connect** :

1. Choisir Authorization Code, PKCE S256 et une clé de signature RS256 ou ES256.
2. Enregistrer une URI de redirection exacte :
   `https://votre-domaine/api/auth/oidc/callback`.
3. Autoriser les scopes `openid` et `profile`.
4. Dans **Administration → Connexion**, reporter l'issuer exact, le Client ID et
   le secret. Tester le fournisseur, puis enregistrer **PIN et SSO**.
5. Effectuer une connexion SSO et attribuer le rôle administrateur au compte
   concerné dans **Administration → Utilisateurs**. Le mode SSO seul devient
   possible après une connexion réussie d'un administrateur avec ces paramètres.

Le test de fournisseur contrôle discovery, TLS, clés de signature et PKCE ;
il ne prouve pas que le secret est correct. Celui-ci est vérifié lors du véritable
échange OIDC. L'URI de retour est affichée avec un bouton de copie. L'URL publique
reste celle configurée pour le serveur (`MW_PUBLIC_URL`).

La configuration gérée est écrite atomiquement dans `auth-config.json`, au même
emplacement que les sessions, avec les permissions `0600`. Le secret n'est jamais
renvoyé par l'API ni réaffiché. Un champ vide le conserve ; une action explicite
permet de l'effacer. Les changements annulent les transactions OIDC en attente.

Les variables restent disponibles pour initialiser une installation sans
configuration gérée. Dès le premier enregistrement dans l'interface, les valeurs
gérées sont prioritaires sur les variables d'authentification, y compris
`MW_AUTH_METHODS=pin` d'un ancien drop-in systemd. L'URL publique reste fournie
par la configuration réseau existante.

Exemple de variables de démarrage, avec des valeurs à adapter :

```ini
MW_AUTH_METHODS=pin,sso
MW_PUBLIC_URL=https://moonlight.example.org
MW_OIDC_ISSUER=https://auth.example.org/application/o/moonlight/
MW_OIDC_CLIENT_ID=moonlight-web
MW_OIDC_CLIENT_SECRET_FILE=/etc/moonlightweb/oidc-client-secret
MW_OIDC_ADMIN_SUBJECTS=subject-du-compte-administrateur
```

Le fichier du secret doit être lisible par le service et protégé des autres
comptes. En installation native, ajouter ces variables à un drop-in systemd du
service, puis redémarrer celui-ci. Ne pas enregistrer le secret dans Git.

Avec Docker Compose, les variables simples sont transmises par les fichiers
Compose fournis. Pour le secret, monter un secret Compose dans le conteneur et
définir `MW_OIDC_CLIENT_SECRET_FILE` avec son chemin **dans le conteneur** :

```yaml
services:
  moonlightweb:
    environment:
      MW_OIDC_CLIENT_SECRET_FILE: /run/secrets/oidc_client_secret
    secrets:
      - oidc_client_secret
secrets:
  oidc_client_secret:
    file: ./oidc-client-secret
```

Le reverse proxy doit laisser atteindre l'application et le callback sans
imposer une authentification SSO préalable pour toute requête. Sinon le choix
PIN n'est pas accessible. L'application valide elle-même OIDC ; des en-têtes
d'identité envoyés par un proxy ne connectent aucun utilisateur.

## Comptes, machines et sessions

- **PIN seul** conserve le propriétaire local et permet aussi des comptes locaux
  créés dans l'administration. Chaque nouveau compte a ses propres machines et
  reçoit un PIN à usage unique valable 5 minutes.
- **SSO seul** redirige automatiquement vers le fournisseur. Une erreur ou une
  déconnexion affiche une action de connexion explicite pour éviter une boucle.
- **PIN + SSO** affiche le choix de méthode. Un utilisateur SSO connecté peut
  générer son propre PIN dans les paramètres : usage unique, validité 5 minutes.
  Ce PIN ouvre le même compte. Les PIN désactivés sont aussi refusés par l'API.
- Chaque compte a sa liste de machines. L'enregistrement d'un même PC par deux
  comptes produit deux identifiants, deux configurations et deux appairages
  indépendants lors d'un ajout normal. Chacun doit autoriser son appairage sur le
  PC. Une **duplication administrateur** conserve explicitement le certificat
  et l'appairage de la source ; ces copies partagent l'identité client côté
  Apollo/Sunshine tout en conservant leurs listes et réglages distincts.
- Le rôle administrateur donne accès aux réglages, aux utilisateurs et à leurs
  enregistrements de machines via les routes administrateur. Les listes ordinaires
  restent privées. Les rôles valent par PIN comme par SSO. Pour le propriétaire
  local historique, le PIN conserve l'étape du mot de passe d'administration à
  distance ; il ne transforme pas les anciens appareils PIN en administrateurs.
- Les comptes SSO sont créés automatiquement à la première connexion. Un rôle
  défini dans l'interface et une désactivation ne sont pas écrasés par les claims.
  `MW_OIDC_ADMIN_SUBJECTS` reste un mécanisme de démarrage pour les comptes dont
  le rôle n'a pas encore été administré explicitement.
- Au premier démarrage après mise à jour, les anciennes machines et sessions
  appartiennent au propriétaire local. Leurs identifiants et appairages restent
  utilisables. Les anciennes sessions PIN sont refusées si le PIN est désactivé.
- Les sessions de navigateur restent révocables depuis l'administration. Une
  déconnexion termine la session Moonlight-Web du navigateur ; elle ne termine
  pas la session globale Authentik. La déconnexion globale/back-channel OIDC
  n'est pas implémentée.
- Les cookies nouvellement émis sont `Secure`, `HttpOnly` et limités à l'hôte
  avec le préfixe `__Host-`. Les anciennes sessions sont acceptées et migrées
  lorsqu'elles sont utilisées. Les jetons OIDC ne sont pas stockés dans le navigateur.
- Un changement de compte efface les historiques et préférences Moonlight-Web
  stockés localement dans le navigateur, pour ne pas afficher ceux du compte précédent.

L'accès local de récupération et les raccourcis de l'hôte restent disponibles à
l'opérateur. Les comptes distincts utilisent des workers de streaming séparés.
Un Sunshine/Apollo à bureau unique ne peut pas fournir deux bureaux isolés en
parallèle : une tentative qui interromprait le flux d'un autre compte est refusée.
Les invitations de joueurs restent réservées au propriétaire local dans cette
première version ; les comptes SSO ne peuvent pas lire ou modifier ses invitations.

Ces réglages ne désactivent ni l'accès Internet, ni UPnP, ni WebRTC, ni le WOL.
Les services de relais et de télémétrie MoonlightWeb restent désactivés par le
profil reverse proxy.

Le modèle enrichi est enregistré dans `users.json` version 2. Un retour à un
ancien binaire doit restaurer aussi la sauvegarde de l'état réalisée avant mise
à jour ; l'ancien lecteur ne comprend pas les comptes locaux enrichis.

## Gestion des comptes et des machines

L'administrateur peut créer, renommer, activer/désactiver un compte, modifier son
rôle, générer son PIN et révoquer ses sessions. Une désactivation ferme ses
connexions et ses flux propres. Le propriétaire local est protégé, ainsi que le
dernier administrateur SSO utilisable lorsque le PIN est désactivé.

Pour rattacher un compte local à une identité SSO, ouvrir l'administration sous
l'URL publique, sélectionner le compte, puis **Associer une identité SSO**. Le
fournisseur vérifie l'identité ; l'administrateur confirme ensuite le nom, l'issuer
et le sujet affichés. Le compte conserve son identifiant et ses machines. Une
identité déjà attribuée à un autre compte est refusée ; aucune association n'est
faite par nom ou e-mail. Un lien existant peut être retiré explicitement avant
réattribution, sous réserve des protections d'accès administrateur.

Un transfert déplace l'enregistrement avec ses réglages et son appairage. Une
copie conserve aussi l'appairage. La suppression d'un enregistrement ne touche
ni les autres copies, ni le PC, ni son appairage côté serveur. La capture native
reste au propriétaire local. Les opérations sur un PC occupé sont refusées.

La suppression d'un utilisateur demande confirmation avec les nombres de machines
et de sessions : elle révoque ses sessions et retire ses enregistrements, sans
éteindre les PC. Une suppression interrompue est reprise au démarrage ; le compte
reste bloqué entre-temps. **Un compte SSO supprimé peut être recréé vide à sa
prochaine connexion. Utiliser Désactiver pour interdire durablement l'accès.**

Les API de gestion sont réservées aux administrateurs :

- `GET/POST /api/admin/auth-config`, `POST /api/admin/auth-config/test` ;
- `GET/POST /api/admin/users`, `POST/DELETE /api/admin/users/:id` ;
- actions `pin`, `revoke-sessions`, `sso/prepare`, `sso/confirm` sous le compte,
  et lecture `GET /api/admin/users/:id/hosts` ;
- `POST /api/admin/hosts/:id/transfer`, `POST /api/admin/hosts/:id/duplicate`
  avec `user_id` destinataire, et `DELETE /api/admin/hosts/:id`.

Les écritures exigent le jeton CSRF d'administration. Les API utilisateur
existantes n'accordent aucun accès supplémentaire aux machines d'autrui.

## Validation

```bash
cmake -S backend/tests -B build-tests -G Ninja
cmake --build build-tests
build-tests/run_tests --identity
python3 backend/tests/test_oidc_integration.py build/MoonlightWeb
cd frontend
npm run check
npm run coverage
```

Le test d'intégration utilise un vrai serveur Moonlight-Web, un fournisseur
HTTPS OIDC local avec de vraies signatures et un faux PC GameStream. Tous les
ports, comptes, clés et fichiers sont temporaires. Il ne contacte pas Authentik
ni les machines de l'installation réelle.
