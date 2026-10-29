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
Il conserve **« Activer l'accès Internet »**, la découverte d'IP publique par STUN,
la configuration des ports média par **UPnP** et les transports **WebRTC**, avec
**WSS** en secours via votre proxy.

Seuls le rendez-vous/relais MoonlightWeb et la télémétrie sont désactivés. Les
anciennes valeurs d'activation dans `settings.json` ne peuvent pas réactiver ces
services. Le STUN utilise Cloudflare, avec Google en secours pour la détection
backend, ou votre serveur explicitement configuré ; aucun STUN MoonlightWeb
n'est utilisé dans ce profil. Les fournisseurs STUN et les pairs connectés
peuvent voir l'IP publique, ce qui sert à établir la connexion directe.

Activez **l'accès Internet** pour lancer la détection d'IP et autoriser les
ouvertures UPnP des ports média. Le trafic de l'interface reste accessible par
votre domaine HTTPS et sur le LAN. Les vérifications automatiques de mises à
jour amont et la géolocalisation restent désactivées.

Le serveur Moonlight-Web local reste nécessaire pour joindre Apollo/Sunshine
et adapter leur flux au navigateur. L'hôte natif et le partage de session hérités
du projet amont restent disponibles selon les capacités du matériel et du navigateur.

## Fluidité et diagnostics

Les réglages manuels de résolution, FPS et débit sont conservés pendant une
congestion ; seuls les paramètres en Auto sont ajustés. Le rendu vidéo HDR est
alimenté sans attendre une seconde cadence de page. Cela ne garantit pas à lui
seul le débit de décodage ou d'affichage du matériel.

Un [diagnostic temporaire du flux](docs/wiki/16-Streaming-Diagnostics.md) distingue
réception, décodage, soumission au rendu et composition vidéo, sans exporter de
secrets ni d'images. La [revue et les mesures](docs/design/streaming-frame-pacing-review.md)
précisent les résultats reproductibles et la validation matérielle encore nécessaire.

## Identifier la version déployée

L’en-tête distingue **Interface** (commit des fichiers chargés, huit caractères)
et **Serveur** (version du binaire en cours). Le survol affiche le commit complet.
Une mise à jour du frontend seule change donc l’identifiant Interface sans prétendre
avoir remplacé le backend. Un paquet issu de sources modifiées est marqué « modifié » ;
un checkout non empaqueté est indiqué « développement ».

Sur la VM de construction, après configuration CMake, préparer uniquement le frontend :

```sh
cmake --install build --prefix "$PWD/stage-ui" --component Frontend
```

Ce composant exclut les tests et dépendances de développement, et génère l’identité
dans les fichiers préparés. Déployer l’ensemble du frontend préparé avec sa métadonnée,
après sauvegarde ; vérifier les empreintes des fichiers servis et recharger la page.
Aucune compilation ni aucun redémarrage du backend n’est nécessaire pour une correction
limitée à cette interface.

## Dashboard et connexion

Le bouton **Découverte automatique** enregistre un choix par utilisateur, partagé
entre ses navigateurs. Sans choix explicite, la découverte est désactivée dès
qu’un PC activé est enregistré, même hors ligne. Sinon, elle est activée. Les
recherches sont limitées dans le temps et démarrent à l’ouverture du dashboard,
au retour au premier plan ou lors de l’activation du bouton. Désactiver la
découverte n’arrête pas la surveillance des PC enregistrés ni leur Wake-on-LAN.

**Découvrir n’enregistre plus un PC.** La section **PC détectés — à ajouter**
présente des candidats temporaires propres au compte, conservés deux minutes
après leur dernière détection. **Ajouter** revérifie le PC et crée un enregistrement
personnel non appairé, avec sa propre identité client. Aucun appairage d’un autre
compte n’est repris ; seuls les clonages et transferts administratifs explicites
conservent l’identité existante. Désactiver la découverte efface ses candidats.

La liste de PC du serveur fait autorité : une machine retirée disparaît du
dashboard. Un changement de compte invalide les réponses en attente et les caches.
Les autres onglets masquent leur ancien contenu et se revalident ; une déconnexion
explicite les ramène à la connexion sans relancer automatiquement le SSO.

Les menus **…** restent accessibles au-delà des cartes, y compris sur mobile.
**Se déconnecter**, dans Paramètres → Général, ferme la session Moonlight-Web et
revient au choix PIN/SSO autorisé. Une déconnexion volontaire n’entraîne pas de
reconnexion SSO automatique, mais ne ferme pas la session globale Authentik.
L’option **Rester connecté** appartient au PIN ; en SSO, le contrôle Authentik à
chaque ouverture et la durée maximale de huit heures restent obligatoires.

## Paramètres et administration

Les paramètres personnels sont organisés en **Vidéo et audio**, **Contrôles** et
**Général**. L’administration propose **Connexion**, **Utilisateurs**, **PC**,
**Sessions**, **Réseau** et **Serveur**. Changer d’onglet conserve les formulaires
sans les enregistrer ; aucun brouillon ou secret SSO n’est stocké dans le navigateur.

Les comptes SSO sont créés automatiquement à la première connexion validée, avec
les rôles fournis par Authentik. En mode SSO seul, la création de comptes locaux
et les actions PIN sont masquées ; la gestion des comptes existants et la
récupération locale restent disponibles.

Dans **PC**, rechercher et filtrer les enregistrements par propriétaire ou état,
puis utiliser **Actions** pour déplacer, cloner, désactiver/réactiver ou supprimer.
Une désactivation bloque uniquement cet enregistrement, qui reste visible chez
son propriétaire. Elle survit au redémarrage et ne peut pas être annulée par un
scan ou un ajout manuel. Les autres copies restent indépendantes. Un PC occupé
par un flux ou une opération doit être libéré avant modification.

Déplacement et clonage conservent configuration, état d’activation et appairage ;
les clones partagent l’identité client Apollo/Sunshine. Supprimer retire seulement
l’enregistrement, sans désappairer ni éteindre le PC. La capture native reste
attachée au propriétaire local.

## Partage, presse-papiers et capture des entrées

Le partage de session est réservé au propriétaire local. Les autres comptes,
y compris les administrateurs SSO, n’affichent pas le menu Partage. Un refus
permanent arrête les rafraîchissements du menu.

Avec **Apollo distant**, le presse-papiers texte est bidirectionnel (Unicode,
multilignes, maximum **256 Kio en UTF-8**). Les permissions Apollo de lecture,
d’écriture et de clavier s’appliquent séparément au certificat déjà appairé.
Le presse-papiers fonctionne sans contrôle supplémentaire dans le flux. Le collage
attend l’écriture réussie sur Apollo avant d’envoyer le raccourci ; un échec ne colle
pas l’ancien contenu. La lecture ne s’effectue que pendant un flux au premier
plan, au maximum une fois par seconde. Si le navigateur refuse l’écriture
locale, le texte reste en mémoire et la copie est retentée lors des gestes utilisateur
existants ; aucune action de secours n’est affichée. Les images/fichiers, les invités
restreints et Sunshine sans cette extension ne sont pas pris en charge par cet
adaptateur. Le presse-papiers de la capture locale reste disponible.

Le **Mode exclusif** propose **Souris**, **Clavier** ou **Souris + clavier**,
avec une activation au démarrage indépendante du choix, dans les paramètres.
Ces paramètres sont maîtres : M et Z ne modifient que le flux en cours ; chaque
nouveau flux reprend la configuration enregistrée. Le rappel M reste visible
dans le bandeau même lorsque la capture est désactivée. La capture utilise Pointer
Lock standard, sans entrée souris brute. Keyboard Lock dépend du navigateur et nécessite le
plein écran ; une indication ponctuelle signale une capture indisponible ou partielle.

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Activer, libérer ou reprendre la capture sélectionnée | Ctrl + Alt + Maj + M | Ctrl + Option + Cmd + M |
| Libérer les captures (ancien raccourci) | Ctrl + Alt + Maj + Z | Ctrl + Option + Cmd + Z |
| Basculer le plein écran, indépendamment de la capture | Ctrl + Alt + Maj + X | Ctrl + Option + Cmd + X |

À la perte du focus, les touches et boutons distants sont relâchés. Au retour,
la capture clavier est redemandée sans attendre la réponse de la capture souris.
Une reprise est tentée une fois ; **« Reprendre la capture »** demande un geste
si le navigateur l’exige. Une libération volontaire annule cette reprise.
Le raccourci X conserve l’intention de capture lors des transitions dans les deux sens.
La souris est recapturée si le navigateur la relâche ; le clavier devient indisponible
en fenêtre, puis sa capture est redemandée au retour en plein écran. Un refus du
navigateur nécessite le geste de reprise habituel, sans modifier les paramètres.
Les raccourcis M et Z conservent le plein écran. Avec une capture clavier autorisée
en plein écran, un appui bref sur **Échap** est transmis au PC distant et conserve
les captures. La sortie de secours du navigateur reste disponible (appui prolongé
sur Échap dans [Chrome](https://developer.chrome.com/blog/better-full-screen-mode)).
Sans capture clavier accordée, Échap conserve son comportement de libération.
La capture ne modifie ni les paramètres vidéo ni les protections contre les entrées bloquées.

L’ancien réglage activé devient « Souris + clavier » ; désactivé, il conserve
les captures désactivées. Sans historique, le choix initial est « Souris ».

## Démarrage avec Docker Compose

Images publiées pour **Linux amd64 et arm64** :

| Image                                                | Usage                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `ghcr.io/aerodomigue/moonlight-web-dev:dev`          | Dernière image de développement publiée du fork.                      |
| `ghcr.io/aerodomigue/moonlight-web-dev:sha-<commit>` | Tag d’une version publiée, à remplacer par son identifiant de commit. |

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

Les ports média WebRTC sont configurés par UPnP lorsque l'accès Internet est activé ; WSS passe par le proxy en secours. L'authentification
par PIN reste active. L'administration distante nécessite le mot de passe et,
pour un client sur une IP publique, l'autorisation Internet correspondante.
Une requête proxifiée ne bénéficie jamais de l'exemption de l'hôte local.

Voir [le guide reverse proxy](docs/reverse-proxy.md) et
[le guide Docker](docker/README.md) pour les détails.

## Authentification SSO et espaces utilisateurs

La section **Administration → Connexion** configure le PIN, OpenID Connect ou
les deux, avec test du fournisseur et application sans redémarrage.
**Administration → Utilisateurs** gère les comptes locaux/SSO, les rôles, les PIN
temporaires et les transferts, copies ou suppressions de machines.
`MW_AUTH_METHODS=pin,sso` reste disponible pour initialiser une installation.
`pin` conserve la connexion actuelle ; `sso` redirige automatiquement vers le
fournisseur. Authentik est pris en charge avec une configuration OIDC générique.
Chaque compte possède ses machines et ses appairages, même lorsqu'un PC est
ajouté par plusieurs utilisateurs. Une duplication administrateur conserve
explicitement l’appairage partagé. Les anciennes machines restent au propriétaire
local. Authentik fournit le rôle via le claim signé `moonlight_role` :
`internal_admin` ouvre directement la console en SSO ; `internal_user` ne donne
aucun accès administrateur. Par PIN, un administrateur doit toujours déverrouiller
la console par mot de passe. Les rôles synchronisés sont affichés en lecture seule.
Chaque ouverture vérifie la session Authentik. Les sessions SSO sont protégées
contre la copie du cookie seul et peuvent être révoquées par back-channel logout ;
ce dernier exige le réglage indiqué dans le guide Authentik et reverse proxy.
Voir [la configuration et les limites du SSO](docs/authentication.md).

## Wake-on-LAN des machines enregistrées

Moonlight-Web mémorise les informations de réveil disponibles lors de
l'enregistrement et des échanges avec l'hôte : **IP locale et adresse MAC**.
Elles restent disponibles après un redémarrage du serveur et lorsque le PC
est hors ligne.

Sur une carte de PC hors ligne, le bouton de réveil apparaît lorsque les
informations nécessaires sont valides. Le menu **⋯ → Configurer le Wake-on-LAN** permet de
consulter les valeurs détectées et les réglages déjà enregistrés, puis choisir
**Automatique** ou **Manuel**. Le mode manuel conserve ses propres valeurs ; revenir
en automatique retire ces remplacements. La configuration ne réveille pas le PC.

Apollo masque la MAC avant appairage : Moonlight-Web la récupère ensuite en HTTPS
avec le certificat appairé. Les anciennes machines appairées sans MAC sont complétées
automatiquement lorsqu’elles sont accessibles, hors flux actif. Les échecs sont
réessayés au maximum toutes les cinq minutes. Une MAC authentifiée n’est pas
écrasée par une réponse HTTP ou ARP, ni par une valeur vide.

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
| `MW_REVERSE_PROXY`               | `1`                             | Profil auto-hébergé, sans relais ni télémétrie MoonlightWeb.               |
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

La [documentation technique héritée](docs/wiki/Home.md) reste disponible ; ses sections sur le rendez-vous et la télémétrie décrivent le comportement amont, désactivé ici. Le réseau et les transports restent fonctionnels.

## Origine et licence

Projet original : [linckosz/moonlight-web](https://github.com/linckosz/moonlight-web),
par **Bruno Martin**. Fork maintenu dans
[aerodomigue/moonlight-web](https://github.com/aerodomigue/moonlight-web).

Copyright © 2026 Bruno Martin <brunoocto@gmail.com>.
Distribué sous **GNU GPL-3.0**. Les mentions de copyright et les licences des
composants tiers sont conservées dans [LICENSE](LICENSE) et [COPYRIGHT](COPYRIGHT).
