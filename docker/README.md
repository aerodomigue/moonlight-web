# Docker — fork auto-hébergé Moonlight-Web

Ce guide concerne l'image **aerodomigue**, avec le WOL des hôtes enregistrés et
l'accès direct par votre reverse proxy. Les services de rendez-vous, de relais
externe et de télémétrie du projet amont sont désactivés par défaut.

## Image

```text
ghcr.io/aerodomigue/moonlight-web-dev:dev
```

L'image est publiée pour **linux/amd64** et **linux/arm64**. Le tag `dev` suit
les publications du fork ; les tags `sha-…` permettent de sélectionner un commit
publié, par exemple `sha-<commit>` en remplaçant `<commit>` par le tag publié souhaité.

## Installation

Depuis la racine du dépôt :

```bash
cp .env.example .env
```

Configurez votre origine HTTPS et les adresses du proxy dans `.env` :

```dotenv
MW_PUBLIC_URL=https://moonlight.example.com
MW_TRUSTED_PROXIES=127.0.0.1/32,::1/128
```

Le domaine est un exemple, remplaçable au démarrage. Les adresses de boucle
locale conviennent seulement si le proxy s'y connecte réellement. Pour un proxy
sur une autre machine ou dans un conteneur, indiquez son IP vue par Moonlight-Web,
avec le CIDR adapté. N'accordez pas votre confiance à tous les clients du réseau.

```bash
docker compose --env-file .env -f docker/docker-compose.yml up -d
docker compose --env-file .env -f docker/docker-compose.yml exec moonlightweb moonlightweb --status
```

Le fichier [docker-compose.yml](docker-compose.yml) :

- Utilise le réseau hôte sous Linux pour le WOL et la découverte mDNS.
- Configure HTTP sur **8080** et HTTPS sur **8443**, modifiables dans sa section
  `environment`.
- Active `MW_REVERSE_PROXY=1` et `MW_NO_TELEMETRY=1`.
- Conserve l'état de l'application dans le volume `mw-data`, monté sur `/data`.
- Vérifie la disponibilité du serveur avec `moonlightweb --status`.

Les ports déclarés dans le Dockerfile n'ouvrent aucun accès à eux seuls. Avec le
réseau hôte, le processus écoute directement sur les ports configurés : le proxy
rejoint l'adresse de la machine exécutant Moonlight-Web, au port 8080.

## Reverse proxy HTTPS et WebSockets

Le flux suit ce chemin :

```text
Interface / WSS : navigateur → votre proxy HTTPS → Moonlight-Web
Média WebRTC : navigateur ↔ ports média UPnP ↔ Moonlight-Web → Apollo/Sunshine sur le LAN
```

Le proxy termine TLS avec votre certificat et transmet tous les chemins, dont
`/api/*`, `/ws*` et `/p/*`. Activez les WebSockets, conservez `Host` et `Origin`,
écrasez `X-Forwarded-Proto` avec `https`, et ajoutez l'adresse réelle du client à
`X-Forwarded-For`. Désactivez le buffering et adaptez les délais au streaming.

Le bouton **Activer l'accès Internet** reste disponible : il déclenche la détection
STUN de l'IP publique et autorise les ouvertures des ports média par UPnP. WebRTC
reste le transport direct, avec WSS en secours par le proxy. Cloudflare et Google
peuvent être interrogés pour le STUN ; aucun relais ou STUN MoonlightWeb n'est
utilisé. La télémétrie et la géolocalisation restent désactivées.

Les requêtes proxifiées doivent s'authentifier ; elles n'héritent pas des privilèges
de l'hôte local. Les clients du LAN restent accessibles directement sur les ports
du backend : seuls les proxys déclarés ont le droit de fournir des en-têtes d'adresse.

Voir [le guide de configuration complet](../docs/reverse-proxy.md).

## PIN et administration

Consultez le PIN et l'état du serveur :

```bash
docker compose --env-file .env -f docker/docker-compose.yml exec moonlightweb moonlightweb --status
```

Générez un nouveau PIN si nécessaire :

```bash
docker compose --env-file .env -f docker/docker-compose.yml exec moonlightweb moonlightweb --new-pin
```

L'administration depuis un autre appareil nécessite l'activation du mot de passe
administrateur distant. Pour une IP cliente publique, activez également son
option Internet. La présence du proxy ne dispense pas de ces contrôles.

## Wake-on-LAN

La carte d'une machine enregistrée hors ligne propose le réveil si son IP LAN
et sa MAC sont connues et valides. Le menu **⋯ → Configurer le Wake-on-LAN** permet de corriger
ces informations. Elles sont conservées lorsque la cible est éteinte et après un
redémarrage de Moonlight-Web.

Le backend émet les paquets sur le LAN directement connecté, selon le masque réel
de l'interface, en UDP 7 et 9. Les IP publiques et les cibles hors de ces
sous-réseaux sont refusées. Activez aussi le WOL dans le firmware et sur la carte
réseau du PC cible.

Le bridge Docker standard ne fournit généralement pas l'interface LAN nécessaire :
utilisez le Compose avec réseau hôte pour ce déploiement. Le fichier historique
`docker-compose.bridge.yml` n'est pas le guide de déploiement de ce fork et ne
convient pas au WOL LAN sans adaptation.

## Données et mises à jour

`/data` contient notamment :

- Les réglages, le PIN, les certificats et les journaux de Moonlight-Web.
- Les associations avec les hôtes et l'identité du client Moonlight.

Conservez votre volume existant lors du remplacement de l'image et sauvegardez-le.
Ne lancez pas `docker compose down -v` pour une mise à jour : cette option supprime
les volumes du projet.

```bash
docker compose --env-file .env -f docker/docker-compose.yml pull
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

Ces commandes mettent à jour un déploiement utilisant `:dev`. Si vous avez choisi
un tag `sha-…`, changez d'abord le champ `image` pour la nouvelle version souhaitée.
Les mises à jour automatiques vers le projet amont sont désactivées.

## Diagnostic

```bash
docker compose --env-file .env -f docker/docker-compose.yml ps
docker compose --env-file .env -f docker/docker-compose.yml logs --tail 100 moonlightweb
```

| Symptôme                                  | Vérification                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Redirection vers le port HTTPS interne    | IP du proxy dans `MW_TRUSTED_PROXIES` et `X-Forwarded-Proto: https`.               |
| Interface accessible, flux indisponible   | Upgrade WebSocket, chemins `/ws*`, buffering et délais du proxy.                   |
| Bouton WOL absent                         | IP locale, MAC valide, interface et sous-réseau réellement accessibles au backend. |
| Liens publics incorrects                  | Valeur HTTPS de `MW_PUBLIC_URL`, sans sous-chemin.                                 |
| Perte des associations après remplacement | Réutilisation du même volume monté sur `/data`.                                    |

Le [README principal](../README.md) décrit le fork ; la configuration des variables
se trouve dans [`.env.example`](../.env.example).
