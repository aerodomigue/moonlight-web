# Connexion par PIN et OpenID Connect

Moonlight-Web peut accepter le PIN, le SSO, ou proposer les deux. La configuration
est lue au démarrage. Le protocole utilisé pour identifier les utilisateurs est
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
4. Reporter l'issuer indiqué par Authentik, le client ID et le secret dans la
   configuration Moonlight-Web. Utiliser la valeur `sub` du compte pour la liste
   d'administrateurs : un nom d'utilisateur ou une adresse e-mail ne la remplace pas.

Exemple de variables, avec des valeurs à adapter :

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

- **PIN seul** conserve le compte propriétaire local. Aucun compte local
  supplémentaire n'est créé par cette fonctionnalité.
- **SSO seul** redirige automatiquement vers le fournisseur. Une erreur ou une
  déconnexion affiche une action de connexion explicite pour éviter une boucle.
- **PIN + SSO** affiche le choix de méthode. Un utilisateur SSO connecté peut
  générer son propre PIN dans les paramètres : usage unique, validité 5 minutes.
  Ce PIN ouvre le même compte. Les PIN désactivés sont aussi refusés par l'API.
- Chaque compte a sa liste de machines. L'enregistrement d'un même PC par deux
  comptes produit deux identifiants, deux configurations et deux appairages
  indépendants. Chacun doit autoriser son appairage sur le PC.
- Le rôle administrateur donne accès aux réglages et à la révocation des
  sessions ; il ne fusionne pas les listes personnelles de machines.
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
