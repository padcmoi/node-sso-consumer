# Consommer le temps réel

[02-protocol-realtime.md](02-protocol-realtime.md) est ce que x-core sert. Ceci est ce qu'une application doit construire pour le recevoir, et chaque pièce existe pour une raison qui n'est pas négociable.

## Pourquoi le navigateur ne peut pas appeler x-core lui-même

Deux raisons, et chacune suffit :

- la signature HMAC dont le handshake a besoin est un **secret serveur** ;
- un WebSocket n'est **pas soumis à la politique de même origine**. N'importe quelle page d'internet peut en ouvrir un vers cet hôte et le navigateur y attachera le cookie de session, donc le cookie ne doit pas être ce qui ouvre une socket.

Il y a donc trois sauts au lieu d'un : la page demande un **ticket** sur sa session authentifiée, appelle la socket **de cette application** avec, et cette application appelle x-core. Le compte derrière une socket est décidé par le ticket qui l'a ouverte et jamais par ce que la page envoie ensuite.

## Le ticket

```
POST <app>/…/realtime-ticket        authentifié comme n'importe quelle autre route
-> { ticket }                        32 octets aléatoires, base64url
```

Gardé face à l'access token qu'il représente, avec une expiration de **30 secondes** : le temps entre la demande d'un ticket et l'appel d'une socket, et rien de plus. Un ticket n'est pas une session.

Lu ET supprimé en un seul geste, si bien qu'il est consommé par le premier arrivé et qu'un handshake rejoué ne trouve rien. Où se trouve ce magasin et comment il orthographie ses clés est l'affaire de l'application - un `GETDEL` Redis est la forme évidente, et la librairie n'appelle jamais que `take`.

**En mémoire par défaut, et partagé dès qu'il y a plus d'un processus.** Le magasin est `put(ticket, accessToken, ttlSeconds)` et `take(ticket)`, où `take` lit ET supprime - un ticket lu deux fois est un ticket rejoué.

Le défaut les garde dans le processus qui les a frappés, ce qui est exactement juste pour un seul : rien à configurer, rien à faire tourner à côté. C'est faux dès qu'il y en a deux, parce qu'un ticket frappé par un worker doit être dépensable par l'autre, et en développement il doit aussi survivre à un rechargement du serveur entre la frappe et l'appel. Les deux cas tendent un magasin partagé par `realtime.tickets`. Voir [Plusieurs processus](../../guides/fr/multi-process.md).

Se tromper n'est pas silencieux, et ce n'est pas fatal non plus : le second worker n'a jamais entendu parler du ticket, ferme en `4402`, la page en redemande un, et la boucle est stable - une socket qui se reconnecte indéfiniment et ne transporte jamais rien.

L'access token reste côté serveur du début à la fin : le ticket le représente, et le navigateur ne détient jamais de credential. Le demander est un XHR ordinaire, que CORS protège, et c'est toute la raison pour laquelle un ticket existe plutôt que le cookie ouvrant la socket.

## Le bridge

Une socket depuis la page, une socket vers x-core, et une file entre les deux.

```
upgrade
  lire ?ticket=, le dépenser. Pas de token -> refuser avant que l'upgrade n'aboutisse
open
  signer le handshake, appeler x-core
  à l'ouverture : envoyer { event: "auth", data: { accessToken } } D'ABORD, puis vider la file
page -> x-core
  transmettre chaque frame, SAUF toute frame dont l'event est "auth"
x-core -> page
  transmettre tel quel
close
  mapper le code, fermer l'autre côté, lâcher le bridge
```

**La file n'est pas une optimisation.** La page souscrit dès que sa propre socket s'ouvre, ce qui est avant que celle en amont soit levée. Sans elle ces frames sont perdues et la page attend des topics qu'elle croit avoir demandés.

**`auth` est refusée depuis la page, toujours.** C'est la frame qui nomme le compte, et elle appartient à ce bout-ci seul. Une page autorisée à l'envoyer pourrait nommer quelqu'un d'autre.

**L'identité voyage en premier**, avant tout ce que la page a demandé : x-core ferme une socket qui ne s'est pas authentifiée sous cinq secondes.

**Les codes de fermeture sont mappés, pas transmis aveuglément.** `1000` et la plage `4xxx` passent, parce qu'ils signifient « ne réessaie pas, reconnecte-toi » et qu'un client ne peut pas déduire ça d'une panne de transport autrement. Tout le reste devient `1011` : plusieurs codes `1xxx`, `1006` en tête, appartiennent au runtime et ne peuvent pas légalement être renvoyés.

Une note sur où se trouve l'amont. Quand l'application joint x-core par une adresse interne alors que le certificat nomme la publique, l'appel doit en être informé explicitement. C'est un fait de déploiement et ça relève de la configuration ; ce n'est jamais un défaut, et jamais une raison d'arrêter de vérifier ailleurs.

Où le bridge est monté est l'affaire de l'application : l'événement `upgrade` d'un serveur HTTP existant, ou le gestionnaire WebSocket du framework. S'il partage un serveur avec d'autres sockets, son chemin est comparé **exactement**. Un chemin qui est le préfixe d'un autre signifie deux gestionnaires répondant à un upgrade, le second `handleUpgrade` levant depuis une promesse que personne ne peut attraper, et c'est un rejet non géré, c'est-à-dire le worker perdu et redémarré aussi longtemps que quelqu'un ouvre cette page.

## Le client navigateur

Ouvert dès que la page sait qu'elle est connectée, rouvert si ça change, et tenu pour la **session entière** quelle que soit la page affichée.

```
connect
  demander un ticket. Refusé -> réessayer sur le même backoff, ne pas abandonner
  ouvrir ws://<cet hôte>/<chemin du bridge>?ticket=…
  à l'ouverture : souscrire à me-changed, me-signed-out et me-sessions,
                  plus tout ce que la page a demandé
frames
  #pong                  ignorée, mais elle compte comme signe de vie
  me-changed             le compte, écrit directement. Aucune lecture HTTP derrière
  me-signed-out === true déconnexion, maintenant
  me-sessions            les connexions du compte. Voir plus bas
  autre chose            les données de la page, pour qui a déclaré un intérêt
close
  4001 / 4002 / 4003     déconnexion. Réessayer donne la même réponse
  4402                   le ticket était dépensé ou expiré. Rappeler TOUT DE SUITE,
                         avec un ticket neuf et sans backoff
  autre chose            reconnexion, backoff 1 s doublant jusqu'à 30 s
```

**Trois topics toujours actifs, pas deux.** `me-sessions` est le troisième et c'est lui qui fait atterrir une révocation : le fournisseur calcule `me-signed-out` depuis la session IdP et l'accès du compte, et terminer la session d'UNE application depuis l'écran des connexions ne bouge ni l'une ni l'autre. Cette frame ne vient donc jamais et la page continue de peindre. Le fournisseur marque déjà `current` la ligne propre à l'appelant, donc rien n'a eu à être ajouté nulle part.

Il est lu avec un verrou, et il le faut : une socket sans ligne à faire correspondre lirait « aucune n'est la mienne » dès sa première frame et déconnecterait tout le monde. Il ne signifie quelque chose qu'une fois qu'une ligne A été vue puis disparaît - et même là, la réponse est confirmée plutôt qu'appliquée, par UNE lecture de `/session`, parce que la rotation remplace la ligne tous les quarts d'heure et qu'une frame lue dans l'intervalle ne montre aucune ligne à nous alors que la session est parfaitement vivante.

**`4402` est le code propre à l'application consommatrice, pas celui de x-core.** Il dit que le ticket était dépensé ou expiré, ce qui n'est pas une session terminée : le ticket suivant est frappé par une route qui pose au fournisseur la même question que les lectures, et qui le refusera si la session est réellement terminée.

**Battement de cœur.** Un ping toutes les 25 s, et une socket silencieuse pendant 60 s est fermée comme morte. Le contrôle de silence ne s'exécute **que si l'onglet est visible** : un onglet caché voit ses timers bridés à environ un déclenchement par minute, donc le contrôle lirait un silence qui n'a pas eu lieu et raccrocherait une socket saine, précisément quand un changement poussé compte le plus, puisque rien d'autre ne va demander.

**Reconnexion immédiate sur `online`, sur `focus` et sur `visibilitychange`.** Revenir sur un onglet est exactement le moment où une connexion morte se remarque, et y attendre un backoff est une page qui reste périmée une demi-minute devant quelqu'un.

**Un ticket neuf par tentative.** Un ticket dépensé est refusé, donc une reconnexion ne peut pas rejouer le premier.

**Les topics se déclarent, ils ne s'appellent pas.** Un composant dit qu'il est intéressé, le client souscrit et se désabonne en conséquence, et un topic que personne ne regarde ne coûte rien des deux côtés. `me-changed`, `me-signed-out` et `me-sessions` sont hors de ce mécanisme : les trois sont souscrits à l'ouverture et jamais relâchés.

**L'envoi est au mieux.** La seule action client vers serveur au-delà de la souscription est de terminer une session, et l'état faisant foi revient sous forme de frame poussée plutôt que de réponse. Un message tiré alors que la socket est tombée est perdu, ce qui se voit comme « rien n'a changé » et est réessayé par le lecteur, plutôt que d'être silencieusement cru réussi.

## Se déconnecter, complètement

`me-signed-out: true` et les codes de fermeture fatals sont le même événement vu deux fois, et les deux font le travail entier :

1. arrêter le client, pour que rien ne se reconnecte dans une session terminée ;
2. lâcher le compte que la page détient ;
3. **appeler la route de déconnexion de l'application** et la laisser effacer le cookie scellé et fermer la session consumer chez x-core. Un WebSocket n'a pas de réponse sur laquelle écrire un cookie, donc c'est la seule façon pour la moitié serveur de mourir maintenant plutôt qu'à la requête suivante ;
4. partir, vers le portail ou vers la page de connexion de l'application.

Une frame qui arrive après une déconnexion ne doit pas remettre un compte : le compte n'est appliqué que tant qu'une session est tenue.

## Ce que la page fait d'un changement

La frame remplace ce que la page détient, en entier. Une permission retirée dans une autre application a disparu ici en quelques secondes, sans rien à invalider.

Ça ne suffit pas en soi. Un garde de route s'exécute quand une route est **entrée**, donc un droit révoqué pendant que quelqu'un est assis sur la page qu'elle ouvre retire l'entrée de menu et laisse la page debout, offrant une action que l'API refuse désormais. La même question est donc reposée dès que la réponse peut avoir bougé : quand les droits changent, et quand la route change. Voir [06-permissions.md](06-permissions.md).
