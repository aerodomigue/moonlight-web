# Accès direct via votre reverse proxy

Ce fork utilise par défaut votre propre entrée HTTPS. Aucun rendez-vous,
relais externe, serveur STUN public, rapport de session, géolocalisation IP ou
vérification automatique de mise à jour n'est contacté dans ce mode. Les anciennes
valeurs d'activation dans `settings.json` ne peuvent pas réactiver ces services.
Les mises à jour se font en remplaçant l'image du conteneur.

Le serveur local reste nécessaire : il se connecte à Apollo/Sunshine sur votre
réseau et transporte le flux vers le navigateur en WebSocket sécurisé, via votre
reverse proxy. Le streaming et la signalisation utilisent la même origine HTTPS.
Aucun port média UDP public ni redirection UPnP ne sont nécessaires.

## Configuration

Variables d'environnement au démarrage :

```dotenv
MW_REVERSE_PROXY=1
MW_NO_TELEMETRY=1
MW_PUBLIC_URL=https://moonlight.navet.dev
MW_TRUSTED_PROXIES=127.0.0.1/32,::1/128
```

`MW_PUBLIC_URL` est configurable ; `moonlight.navet.dev` est seulement un exemple.
Indiquez une origine HTTPS, éventuellement avec un port, sans sous-chemin. Elle
sert aux liens de partage et aux raccourcis. Sans cette variable, l'interface
fonctionne sur l'origine courante ; les invitations publiques nécessitent l'URL.
Une valeur non vide invalide empêche le démarrage avec une erreur explicite.

Dans `MW_TRUSTED_PROXIES`, remplacez les adresses de boucle locale par les IP
réelles de votre proxy vues par MoonlightWeb, ou leur CIDR si nécessaire. Par
exemple, si le proxy s'y connecte depuis `10.2.10.50`, utilisez `10.2.10.50/32`.
Ne faites pas confiance à tous les réseaux privés par défaut. Les en-têtes d'une
source non approuvée sont ignorés ; ils ne peuvent ni contourner HTTPS ni
accorder les privilèges de l'hôte local.

Dans votre proxy existant :

- Terminez TLS avec le certificat de votre domaine.
- Transmettez tous les chemins vers le port HTTP du backend (8080 dans le fichier
  Compose), y compris `/api/*`, `/ws*` et `/p/*`.
- Conservez le `Host` public et l'en-tête `Origin` du navigateur.
- Activez l'upgrade WebSocket (HTTP/1.1, `Upgrade`, `Connection`).
- Écrasez `X-Forwarded-Proto` avec `https` et ajoutez l'IP réelle du client à
  `X-Forwarded-For`. Ne transmettez pas aveuglément les valeurs du client.
- Désactivez le buffering du flux et prévoyez un délai de lecture long pour les
  WebSockets, compatible avec une session de jeu.

Le PIN et les contrôles d'accès restent nécessaires. L'administration distante
par mot de passe doit être activée explicitement, avec l'autorisation Internet
si vous souhaitez administrer depuis une IP publique. Une requête proxifiée ne
bénéficie jamais de l'exemption locale, y compris pour les WebSockets.

## Docker et Wake-on-LAN

Image : `ghcr.io/aerodomigue/moonlight-web-dev:dev` (amd64 et arm64).
Utilisez le fichier `docker/docker-compose.yml` avec les variables précédentes
dans le `.env` de Compose. Conservez le volume `/data` existant pour garder vos
machines et associations. Les ports HTTP/HTTPS du conteneur sont configurables
avec `MW_HTTP_PORT` et `MW_HTTPS_PORT` ; 8080/8443 évitent les ports du proxy.

Le fichier recommandé conserve le réseau hôte pour que le Wake-on-LAN puisse
utiliser l'interface LAN et son masque réels. Un conteneur sur le bridge Docker
standard n'a généralement pas de route directement connectée vers le LAN de la
cible : dans ce cas, le WOL restera indisponible. Aucune ouverture de port public
n'est requise pour le WOL ; le paquet part du serveur vers le réseau local.

`MW_LAN_ONLY=1` reste une restriction distincte. `MW_REVERSE_PROXY=0` réactive
explicitement le comportement amont historique ; ne le configurez pas pour ce
déploiement autonome.
