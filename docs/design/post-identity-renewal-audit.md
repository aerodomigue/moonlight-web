# Audit élargi après déploiement du renouvellement d’identité

Date : 24 octobre 2026. Référence examinée :
`a7fbb7c7d353b902d1b947a68229bec31c130563` (PR #6 fusionnée).

## Livraison préalable et méthode

Le correctif PIN/SSO a été déployé **avant cet audit**, comme demandé :
`0.2.1.g124.stg`, service natif sur `10.2.10.105`, sans Docker. Sauvegarde et retour
arrière : `/var/backups/moonlightweb/20261024-195750-identity-renewal`.

Les contrôles de déploiement ont conservé clés serveur et Apollo, comptes, sessions,
configuration/secret SSO, PIN, WOL, Internet et UPnP. Chromium a renouvelé une ancienne
identité IndexedDB contre le vrai service, sans remplacer la clé privée navigateur.
Le compte et la session de vérification ont été supprimés. Le flux vidéo réel de
l’utilisateur reste à valider depuis son navigateur.

L’audit examine authentification/persistance, autorisations REST/WebSocket,
signalisation, opérations de machines, proxy/Internet/WOL et démarrage frontend.
Il combine lecture du code et reproductions sur **instances temporaires**, sans
injection de panne sur la VM de production. Il ne constitue pas une preuve
d’absence de tout autre bug, notamment dans les pilotes/captures natives propres
aux autres plateformes et les équipements réseau réels.

## Constats confirmés, par priorité

### A1 — P1 conditionnel : déconnexion non durable si les sessions ne s’enregistrent pas

Dans `AuthManager::destroySession`, le résultat de `saveSessions()` est ignoré.
`logoutSession()` et la route de déconnexion annoncent pourtant la réussite.

Reproduction avec un compte SSO temporaire et un répertoire de sessions rendu
non inscriptible : HTTP **200**, ancienne copie du cookie refusée en mémoire,
fichier inchangé, puis ancienne copie du cookie **acceptée après redémarrage**
une fois les permissions rétablies. Aucun cookie réel n’est utilisé ou affiché.

Le même défaut de propagation du résultat existe à la création d’une session
mémorisable et à l’enregistrement de sa clé navigateur ; leurs conséquences
précises demandent des tests séparés de la reproduction de déconnexion.

Correction prioritaire : propager l’échec de persistance, conserver la révocation
en mémoire, organiser sa reprise et ne pas annoncer une révocation durable avant
sa confirmation. Tester erreur d’écriture/commit, reprise, redémarrage et refus
du cookie révoqué. Une erreur disque ne doit pas être masquée par un HTTP 200.

### A2 — P1 conditionnel : révocation administrateur pouvant arrêter le serveur

La route `/api/admin/users/:id/revoke-sessions` appelle `revokeUserSessions()` sans
traiter son exception de persistance. Le routeur ne contient pas non plus de
barrière d’exception sur cet appel synchrone.

Avec le même défaut d’écriture injecté, la requête se termine par
`RemoteDisconnected` et le processus serveur sort avec **-6 (SIGABRT)**.
Cette panne nécessite une action administrateur et un stockage défaillant ; ce
n’est pas une route de crash anonyme démontrée.

Correction prioritaire : réponse d’erreur contrôlée et service maintenu en vie,
avec la sémantique durable d’A1. Vérifier aussi les autres appels susceptibles
de lever une exception. Test requis : erreur HTTP explicite, `/api/health` encore
accessible, aucune réactivation silencieuse des sessions.

### A3 — P1 conditionnel : identité serveur volatile quand une clé ne peut être sauvegardée

`AppSettings::hostSigningKeyPem()` renvoie la clé qu’il vient de générer sans
vérifier qu’elle a été enregistrée. Si aucune clé utilisable n’est lisible et que
l’écriture échoue, chaque nouvelle lecture peut générer une autre identité.

Reproduction : retirer uniquement la clé de la configuration temporaire, rendre
son stockage non inscriptible, puis lire deux fois le statut authentifié. Les
deux `host_id` diffèrent et aucune clé n’est persistée. Cela peut provoquer des
refus d’identité/signature même après une authentification fraîche.

Correction prioritaire : charger une identité cohérente et refuser explicitement
de fonctionner avec une nouvelle identité non persistée ; distinguer première
installation, fichier illisible et contenu invalide. Les tests doivent couvrir
échec d’écriture/commit, stabilité entre lectures/processus et redémarrage.

Sur la VM déployée, les clés sont conservées et les fichiers examinés sont
accessibles au service avec permissions privées. La panne n’a pas été injectée
sur cette installation. Un essai complémentaire de lecture interdite n’a pas
démontré d’écrasement des autres champs : cette perte de configuration n’est donc
pas présentée comme un bug reproduit.

### A4 — P2 : client LAN reclassé Internet après résolution correcte du proxy

`ProxyHeaders::apply()` résout correctement un client `10.2.100.122` depuis un
proxy approuvé. Ensuite `streamClientKind()` dans `main.cpp` revoit la présence
de `X-Forwarded-For` et renvoie systématiquement `Public`.

Le corps exact de cette fonction, compilé dans une sonde isolée, donne :
`resolved_peer = private`, `stream_class = public`. Les journaux de la tentative
initiale montraient également cette sélection Internet pour le client privé.

Conséquence conditionnelle : candidats LAN masqués, chemin public/UPnP privilégié,
dépendance inutile au NAT hairpin, délais ou échec UDP selon le routeur. Cela ne
prouve pas que toute connexion LAN échoue.

Correction : utiliser l’adresse déjà résolue pour un proxy explicitement approuvé,
tout en conservant le traitement conservateur des en-têtes provenant de pairs
non approuvés. Extraire cette politique pour tester LAN `10.2.0.0/16`, client
public, en-têtes absents/malformés, proxy non approuvé et usurpation d’adresse.
Compléter par un essai vidéo LAN et extérieur sur le réseau réel.

### A5 — P2 : réponse SDP invalide avec le codec audio RED

`WebRtcMedia::_handleSdpOffer()` retire les lignes RED/ULPFEC globalement, laisse
des séparateurs vides et ne corrige pas les listes de payloads correspondantes.

Reproduction Chromium : une offre valide contenant RED audio produit une réponse
brute que `setLocalDescription()` accepte. La même offre passée dans le vrai
`WebRtcMedia` échoue avec **Invalid SDP line** après ses transformations.
Le service actuel annonce Opus seul dans le scénario principal testé : ce cas
RED ne démontre pas une régression du correctif d’identité livré.

Correction : traiter les sections média et leurs listes de payloads de façon
cohérente, sans supprimer le codec audio par une règle vidéo. Tests avec CRLF/LF,
audio RED, vidéo RED/ULPFEC, RTX associé, Opus seul et négociation Chromium réelle.

### A6 — P2 : accès local sans session perturbé par une ancienne identité navigateur

L’accès depuis la machine hôte peut être autorisé sans cookie. Le serveur émet
alors volontairement une offre non signée, car aucune clé de session n’est liée.
Le navigateur charge malgré cela son ancienne identité IndexedDB et refuse
l’offre pour signature absente.

La reproduction utilise le vrai transport avec un enregistrement navigateur
valide : offre non signée, identité mémorisée présente, résultat `identity_refused`.
La lecture des chemins de démarrage/session confirme la possibilité de cette
combinaison. Ce cas concerne le mode local sans session, pas la connexion publique
PIN/SSO renouvelée livrée par la PR #6.

Correction : exprimer explicitement le contexte local sans session dans le choix
du handshake. Ne jamais déduire une exemption d’un simple drapeau navigateur ou
d’une adresse LAN passée par un proxy. Tests local sans cookie avec/sans IndexedDB,
accès distant, proxy et invité ; conserver le refus des offres non signées dans
une session réellement appairée.

## Contrôles sans nouvelle défaillance démontrée

- Les 15 scénarios d’intégration existants couvrent séparation des comptes,
  refus REST/WebSocket, rôles, désactivation, liaison SSO, suppression reprenable,
  transfert/duplication avec appairage partagé et conflits d’opérations.
- Revue des baux par PC physique, des recherches par propriétaire et des callbacks
  de polling utilisant l’UUID plutôt qu’un pointeur supprimé. Pas de nouvelle
  prise de contrôle intercompte démontrée dans le périmètre examiné.
- WOL : **65/65** vérifications, filtrage des destinations privées/locales et
  conservation des paramètres lors du déploiement. Aucun réveil réel envoyé par
  l’audit. UPnP actif confirmé par lecture du statut sur la VM.
- Proxy : **58/58** vérifications des en-têtes approuvés et des privilèges.
  Ces tests n’exerçaient pas la seconde classification ICE d’A4.
- Revue des garde-fous désactivant relay/télémétrie du projet en mode reverse
  proxy. Aucun service de projet n’a été réactivé pendant la livraison.
- Les sérialisations de machines ne renvoient ni token backend, ni mot de passe
  Apollo, ni clé privée. Les fichiers d’authentification et de sessions de la VM
  sont `0600` sous un répertoire de service `0700`.
- Les identifiants de sessions exposés à l’administration sont des empreintes,
  pas les cookies `v2` rejouables. Leur présence dans une ligne de révocation n’est
  pas considérée, à elle seule, comme une fuite de cookie valide.

## Points restant à approfondir

Les parcours certificat/raccourci et certaines anciennes méthodes de collecte
d’identité ignorent encore un retour `false` de `rememberHostIdentity()` ; ils
ne doivent pas être déclarés corrigés par la livraison PIN/SSO. Les courses entre
changements de compte, les erreurs de sauvegarde des alias/configurations de
machines et le nettoyage des identités sans référence nécessitent leurs propres
reproductions. Aucun résultat négatif n’est inventé pour ces pistes.

## Preuves et suites

Les sondes reproductibles se trouvent dans `backend/tests/audit_runtime/`. Elles
utilisent le fournisseur HTTPS de test, des fichiers temporaires, de vrais
WebCrypto/IndexedDB et des processus isolés. Elles affichent des observations,
pas une validation de non-régression : A1 à A6 restent **ouverts** dans ce rapport.

Ordre recommandé : A1/A2 ensemble pour la révocation durable et la continuité du
service ; A3 pour la persistance d’identité ; A4 pour les chemins LAN/extérieurs ;
A5/A6 dans des correctifs de signalisation séparés. Pour chaque correctif : test
qui échoue avant, modification minimale, revue du diff et des interactions,
tests ciblés puis CI complète avant toute fusion. Le service déployé pour les
essais utilisateur reste sur la version validée de la PR #6 pendant cette revue.
