<div align="center">

<img src="frontend/assets/logo.png" alt="Moonlight-Web" width="112" />

# Moonlight-Web — fork auto-hébergé

Streaming Apollo/Sunshine dans le navigateur, derrière votre propre reverse proxy HTTPS.

</div>

Ce dépôt est le fork [aerodomigue/moonlight-web](https://github.com/aerodomigue/moonlight-web)
du projet [linckosz/moonlight-web](https://github.com/linckosz/moonlight-web), créé par
**Bruno Martin**. Il conserve le client web et le serveur local du projet amont,
avec un accès direct par votre domaine et le Wake-on-LAN des machines enregistrées.

## Fonctionnement de ce fork

```text
Navigateur → votre reverse proxy HTTPS / WSS → Moonlight-Web → Apollo / Sunshine sur le LAN
```

Le profil auto-hébergé est actif par défaut, même sans variable d'environnement.
Le flux vidéo, le son et les commandes passent en **WebSocket sécurisé (WSS)** par
votre proxy. Aucun relais ni serveur de rendez-vous MoonlightWeb n'est nécessaire.

Dans ce profil, les services suivants sont désactivés, même si un ancien fichier
`settings.json` les activait :

- Rendez-vous et relais externes MoonlightWeb.
- STUN public et listes de secours du navigateur.
- Télémétrie des sessions et géolocalisation IP.
- Détection automatique de l'IP publique et ouvertures de ports par UPnP.
- Vérifications et installation automatiques des mises à jour amont.

Le serveur Moonlight-Web local reste nécessaire pour joindre les hôtes
Apollo/Sunshine et adapter leur flux au navigateur. Les fonctionnalités héritées
du projet amont, dont l'hôte natif et le partage de session, restent dans le dépôt.
Les limites du navigateur, des codecs et du matériel continuent de s'appliquer.

## Démarrage avec Docker Compose

Images publiées pour **Linux amd64 et arm64** :

| Image                                               | Usage                                                         |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `ghcr.io/aerodomigue/moonlight-web-dev:dev`         | Dernière image de développement publiée du fork.              |
| `ghcr.io/aerodomigue/moonlight-web-dev:sha-77ec4b6` | Version identifiée contenant le WOL et le mode reverse proxy. |

```bash
git clone https://github.com/aerodomigue/moonlight-web.git
cd moonlight-web
cp .env.example .env
```

Renseignez votre domaine et les adresses de votre proxy dans `.env` :

```dotenv
MW_PUBLIC_URL=https://moonlight.example.com
MW_TRUSTED_PROXIES=127.0.0.1/32,::1/128
```

Le domaine est **configurable au démarrage**. `MW_PUBLIC_URL` doit être une
origine HTTPS, éventuellement avec un port, sans sous-chemin, identifiants,
paramètres ou fragment. Sans cette variable, l'interface utilise son origine
courante ; les invitations publiques nécessitent une URL configurée.

`MW_TRUSTED_PROXIES` désigne les IP réelles du proxy **vues par le backend**.
Les valeurs ci-dessus conviennent à un proxy qui se connecte depuis la boucle
locale. Pour un proxy sur une autre machine ou dans un conteneur, remplacez-les
par ses IP ou CIDR. Les en-têtes d'une source non approuvée sont ignorés.

```bash
docker compose --env-file .env -f docker/docker-compose.yml up -d
docker compose --env-file .env -f docker/docker-compose.yml exec moonlightweb moonlightweb --status
```

Le fichier Compose utilise le réseau hôte sous Linux pour le WOL et la découverte
mDNS. Il configure le backend HTTP sur **8080**, et HTTPS sur **8443**, pour éviter
les ports habituels du proxy. Ces ports se changent dans la section `environment`
du fichier Compose. Le volume `/data` conserve les machines, associations,
réglages et certificats : réutilisez votre volume existant lors d'une mise à jour.

Le PIN de connexion est indiqué par `--status`. Si nécessaire, générez-en un :

```bash
docker compose --env-file .env -f docker/docker-compose.yml exec moonlightweb moonlightweb --new-pin
```

### Reverse proxy

Configurez votre proxy existant pour :

1. Terminer TLS avec le certificat de votre domaine.
2. Transmettre tous les chemins au port HTTP du backend, **8080** avec ce Compose.
3. Conserver le `Host` public et l'en-tête `Origin` du navigateur.
4. Autoriser l'upgrade **WebSocket**, y compris sur `/ws*`.
5. Écraser `X-Forwarded-Proto` avec `https` et ajouter l'IP réelle du client à
   `X-Forwarded-For`.
6. Désactiver le buffering du flux et prévoir des délais adaptés à une session
   de streaming.

Aucun port média UDP public n'est nécessaire dans ce mode. L'authentification
par PIN reste active. L'administration distante nécessite le mot de passe et,
pour un client sur une IP publique, l'autorisation Internet correspondante.
Une requête proxifiée ne bénéficie jamais de l'exemption de l'hôte local.

Voir [le guide reverse proxy](docs/reverse-proxy.md) et
[le guide Docker](docker/README.md) pour les détails.

## Wake-on-LAN des machines enregistrées

Moonlight-Web mémorise les informations de réveil disponibles lors de
l'enregistrement et des échanges avec l'hôte : **IP locale et adresse MAC**.
Elles restent disponibles après un redémarrage du serveur et lorsque le PC
est hors ligne.

Sur une carte de PC hors ligne, le bouton de réveil apparaît lorsque les
informations nécessaires sont valides. Le menu **⋯ → Configurer le Wake-on-LAN** permet de
renseigner ou corriger l'IP locale et la MAC si la découverte ne suffit pas.

Le paquet est émis **par le backend sur le LAN de la cible**, avec le masque
réel de son interface, sur les ports UDP 7 et 9. Les adresses publiques et les
cibles hors des sous-réseaux directement connectés sont refusées. Le navigateur
peut se trouver à distance derrière votre proxy : c'est le serveur qui doit
avoir accès au LAN du PC.

Le WOL doit aussi être activé dans le firmware et sur la carte réseau de la
machine cible. Le bridge Docker standard ne fournit généralement pas l'accès
direct au sous-réseau nécessaire ; le Compose fourni utilise donc le réseau hôte.
Il n'est pas nécessaire d'exposer un port WOL sur Internet.

## Variables principales

| Variable                         | Valeur par défaut               | Rôle                                                                       |
| -------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `MW_REVERSE_PROXY`               | `1`                             | Profil auto-hébergé et transport WSS.                                      |
| `MW_PUBLIC_URL`                  | Vide                            | Origine HTTPS utilisée pour les liens publics et le partage.               |
| `MW_TRUSTED_PROXIES`             | `127.0.0.1/32,::1/128`          | Proxys autorisés à fournir l'adresse client et le schéma HTTPS.            |
| `MW_NO_TELEMETRY`                | `1` dans l'image                | Désactivation supplémentaire des rapports et vérifications de mise à jour. |
| `MW_HTTP_PORT` / `MW_HTTPS_PORT` | `8080` / `8443` dans le Compose | Ports appliqués par l'entrypoint Docker.                                   |

L'exemple complet se trouve dans [`.env.example`](.env.example).
`MW_LAN_ONLY` est une restriction distincte. Ne mettez pas `MW_REVERSE_PROXY=0`
pour ce déploiement : cela réactive explicitement le comportement amont historique.

## Mettre à jour

```bash
docker compose --env-file .env -f docker/docker-compose.yml pull
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

Le tag `dev` suit les images publiées. Pour choisir une version précise, modifiez
le champ `image` du Compose avec un tag `sha-…` publié. Sauvegardez et conservez
le volume `/data` ; `docker compose down -v` supprimerait les données du volume.
Les installateurs et images du projet amont ne contiennent pas les modifications
de ce fork.

## Compiler et contribuer

Le backend utilise **C++17, Qt 6, CMake et OpenSSL** ; le frontend est en JavaScript.
Initialisez les sous-modules avant de compiler :

```bash
git submodule update --init --recursive

# Linux / macOS
./backend/build.sh

# Windows, depuis l'environnement MSVC
cmd /c backend/build_msvc.bat
```

Le binaire se trouve dans `build/`. Si Qt n'est pas détecté, renseignez
`CMAKE_PREFIX_PATH` avec votre kit Qt. Les dépendances et la configuration de
l'outillage sont détaillées dans [CONTRIBUTING.md](CONTRIBUTING.md) ; les instructions
concernant les services de rendez-vous amont ne sont pas nécessaires ici.

Contrôles frontend :

```bash
npm --prefix frontend ci
npm --prefix frontend run check
npm --prefix frontend test
```

La [CI du fork](https://github.com/aerodomigue/moonlight-web/actions/workflows/ci.yml)
contrôle aussi le format C++, l'analyse statique et les tests backend avec un seuil
de couverture. Le [workflow Docker](https://github.com/aerodomigue/moonlight-web/actions/workflows/docker.yml)
construit les deux architectures ; un lancement manuel avec `publish=true`
publie dans `ghcr.io/aerodomigue/moonlight-web-dev`.

La [documentation technique héritée](docs/wiki/Home.md) reste disponible ; ses
sections sur le rendez-vous, le STUN et la télémétrie décrivent le comportement
amont, désactivé dans le profil auto-hébergé de ce fork.

## Origine et licence

Projet original : [linckosz/moonlight-web](https://github.com/linckosz/moonlight-web),
par **Bruno Martin**. Fork maintenu dans
[aerodomigue/moonlight-web](https://github.com/aerodomigue/moonlight-web).

Copyright © 2026 Bruno Martin <brunoocto@gmail.com>.
Distribué sous **GNU GPL-3.0**. Les mentions de copyright et les licences des
composants tiers sont conservées dans [LICENSE](LICENSE) et [COPYRIGHT](COPYRIGHT).
