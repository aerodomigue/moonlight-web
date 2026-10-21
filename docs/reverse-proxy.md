# Accès Internet et reverse proxy personnel

Ce fork conserve le fonctionnement réseau de Moonlight-Web : **Activer l'accès
Internet**, découverte de l'IP publique, ouverture UPnP des ports média, WebRTC et
secours WSS. Le rendez-vous/relais MoonlightWeb et la télémétrie sont désactivés,
même si un ancien réglage les activait. La géolocalisation et les mises à jour
automatiques amont restent désactivées.

L'interface et l'API passent par votre proxy HTTPS. Le flux peut circuler
directement en WebRTC via les ports média UPnP ou par le proxy en WSS. Le serveur
local continue de joindre Apollo/Sunshine sur votre LAN.

## Configuration

```dotenv
MW_REVERSE_PROXY=1
MW_NO_TELEMETRY=1
MW_PUBLIC_URL=https://moonlight.example.com
MW_TRUSTED_PROXIES=127.0.0.1/32,::1/128,10.2.10.103/32
```

L'URL est configurable au démarrage. Indiquez une origine HTTPS sans sous-chemin,
identifiants, paramètres ou fragment. Elle sert aux raccourcis et aux invitations.
Une valeur invalide non vide empêche le démarrage avec une erreur explicite.

Les IP dans `MW_TRUSTED_PROXIES` sont celles du proxy vues par le backend.
`10.2.10.103/32` est un exemple : remplacez-le par votre proxy réel. Cette liste
ne limite pas l'accès des clients locaux. Un appareil sur `10.2.0.0/16` peut
accéder directement au serveur avec le PIN ; il n'a pas besoin d'être déclaré
comme proxy. Ne faites pas confiance à tout le LAN pour les en-têtes transférés.

## Reverse proxy

Dans votre proxy existant :

- Terminez TLS avec le certificat de votre domaine.
- Transmettez tous les chemins vers le backend, dont `/api/*`, `/ws*` et `/p/*`.
- Conservez le `Host` public et l'en-tête `Origin` du navigateur.
- Activez l'upgrade WebSocket pour la signalisation et le transport WSS.
- Écrasez `X-Forwarded-Proto` avec `https` et ajoutez l'IP réelle du client à
  `X-Forwarded-For`.
- Désactivez le buffering du flux et prévoyez des délais adaptés au streaming.

Le fichier Compose utilise HTTP 8080 et HTTPS 8443 ; une installation native
conserve ses ports configurés. Gardez votre redirection HTTP/HTTPS existante :
Moonlight-Web ne crée pas de redirection web automatique par UPnP.

## Activer l'accès Internet

Gardez **Activer l'accès Internet** coché dans l'administration pour la détection
d'IP et les ouvertures média UPnP. Ce réglage est enregistré et repris au démarrage.
`upnp_enabled` reste activé par défaut et peut être désactivé séparément.

Le STUN utilise Cloudflare, avec Google en secours pour la détection du backend,
ou le serveur configuré dans `stun_server`. Les fournisseurs STUN et les pairs
connectés voient l'IP publique. Aucun serveur STUN MoonlightWeb n'est utilisé
par le profil auto-hébergé. Le trafic vidéo et les rapports de session ne sont
pas envoyés à un relais ou service de télémétrie MoonlightWeb.

Le PIN reste nécessaire. L'administration distante doit être activée avec un mot
de passe, et son option Internet si le client a une IP publique. Une requête
proxifiée n'obtient jamais automatiquement les privilèges de l'hôte local.

## Wake-on-LAN et données

Le WOL part du backend vers le sous-réseau directement connecté de la cible,
avec sa MAC et son IP locale. Il ne passe pas par une IP publique. En Docker,
le réseau hôte sous Linux permet de conserver l'interface LAN et son masque réels.

Conservez le volume `/data` pour Docker, ou le répertoire de données du compte
exécutant le service natif, pour garder les machines, associations et réglages.
Le [guide Docker](../docker/README.md) décrit le déploiement et les mises à jour.

`MW_LAN_ONLY=1` est une restriction distincte, qui désactive les fonctions réseau
Internet. Ne l'activez pas pour une installation devant être joignable à distance.
