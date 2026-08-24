# La passerelle realtime

Le second transport de x-core, devant les mêmes services que les routes HTTP appellent. C'est ce qui fait qu'une permission révoquée dans une autre application arrive ici en quelques secondes plutôt qu'au prochain clic, et ce qui ferme une application dès que la session SSO derrière elle est terminée ailleurs.

Une application qui consomme ce SSO **garde une socket ouverte toute la session**. Ce n'est pas une optimisation et ce n'est pas une fonctionnalité de page : `GET /sso/me` à chaque requête dit au côté serveur qu'une session est terminée, mais rien ne le dit à la **page** devant quelqu'un, et une coquille connectée laissée à l'écran pour un compte que l'API refuse déjà est exactement ce que ceci ferme.

## Où elle est

Sur son **propre port**, pas celui de l'API : une connexion longue n'a rien à faire dans le pool où l'API HTTP sert ses requêtes. Même hôte, même matériel TLS, un port plus loin.

```
wss://<même hôte que l'API>:<port ws>/realtime
```

Le port est un fait de déploiement, pas de protocole : x-core vaut `3002` par défaut, et un consumer qui l'atteint par un port publié rencontre ce port tel qu'il a été publié. C'est de la configuration, dérivée de la base de l'API elle-même pour qu'une seconde adresse ne puisse pas dériver de la première.

## Le handshake

Signé **exactement comme un appel HTTP** : une requête d'upgrade a une méthode, un chemin et des en-têtes, ce qui est tout ce que la signature couvre. C'est un `GET` sur un corps vide, construit comme n'importe quel autre appel ([01-protocol-http.md](01-protocol-http.md)).

x-core le vérifie dans `verifyClient`, **avant que l'upgrade n'aboutisse**, si bien qu'un appel non signé reçoit un `401` HTTP nu et ne devient jamais une socket. La vérification est la même chaîne que les routes HTTP exécutent : signature, dérive d'horloge, rejeu de nonce, expiration du credential, liste d'adresses autorisées, depuis le même magasin de credentials.

Hors production, x-core contourne ce contrôle, si bien qu'une pile locale est joignable sans signature. C'est une propriété du déploiement du fournisseur, et aucune raison pour un consumer de signer moins.

## Les deux credentials, répondant à deux questions

La socket porte **deux** identités, et elles ne sont pas interchangeables :

- la **signature HMAC sur le handshake** dit quelle APPLICATION se connecte ;
- l'**access token SSO dans la première frame** dit pour quel UTILISATEUR elle agit.

Puis les deux sont liées : le token doit avoir été émis pour l'application même qui a signé le handshake, vérifié contre l'en-tête `x-client-id`. Détenir un token valide ne suffit donc pas à le lire depuis ailleurs.

## Les frames

Un objet JSON par frame, dans les deux sens.

Envoyées par le client :

| Frame                                                  | Effet                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `{ "event": "auth", "data": { "accessToken": "…" } }`  | nomme l'utilisateur. **Exigée sous 5 s**, sinon la socket est fermée en `4002` |
| `{ "event": "subscribe", "data": { "topic": "…" } }`   | démarre un poller, pour cette socket seule                                     |
| `{ "event": "unsubscribe", "data": { "topic": "…" } }` | l'arrête                                                                       |
| `{ "event": "ping", "data": {} }`                      | reçoit `{ "topic": "#pong", "data": null }`                                    |
| `{ "event": "revoke", "data": { "sessionId": "…" } }`  | termine une des connexions PROPRES à l'appelant                                |

Envoyées par x-core :

```jsonc
{ "topic": "me-changed", "data": { … } }
```

`revoke` est la seule chose que cette socket peut changer, et seulement pour l'appelant : le compte vient de la socket authentifiée et jamais de la frame, donc une frame nommant l'id de session de quelqu'un d'autre n'atteint rien. Elle ne répond rien, par conception. La liste à jour arrive sous forme de frame poussée, ce qui est l'accusé de réception.

`ping` existe parce qu'une connexion morte ne lève pas toujours d'événement de fermeture. Un onglet suspendu ou un NAT qui laisse tomber son mapping laisse une socket à moitié ouverte, qui se prétend ouverte et ne délivre rien. Répondre à un ping est ce qui permet à un client de distinguer vivant de mort.

## Les topics

Un topic est un **poller**, exécuté par socket, qui ne publie que lorsque le JSON diffère de la dernière frame envoyée. Son intervalle est celui que le watcher déclare quand il en déclare un, et `1 s` sinon, avec un plancher à `500 ms` - les chiffres ci-dessous sont donc les réglages actuels de x-core plutôt que des promesses du protocole. Une page au repos coûte donc une requête bornée toutes les quelques secondes, et une page inchangée ne coûte aucun trafic. Chacun est répondu immédiatement à la souscription, si bien qu'un abonné n'attend jamais un intervalle entier pour sa première frame.

| Topic           | Frame                                                            | Intervalle | À quoi il sert                                                                                             |
| --------------- | ---------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `me-changed`    | le compte entier, la forme de [session.json](session.json)       | 3 s        | identité, profil, permissions et groupes, poussés dès que l'un d'eux bouge                                 |
| `me-signed-out` | `false` tant qu'elle tient, `true` une fois                      | 1 s        | la session est partie : déconnecté du SSO ailleurs, compte désactivé, ou accès à cette application révoqué |
| `me-sessions`   | les connexions du compte, 50 max, même forme que la lecture HTTP | 1 s        | l'écran des sessions, souscrit seulement tant qu'il est monté                                              |

`me-changed` et `me-signed-out` sont suivis pour la **session entière** et jamais désabonnés, quelle que soit la page affichée et que la fenêtre ait le focus ou non. Les deux ou aucun : un état alimenté par `me-changed` seul est un cache, et un compte révoqué se promènerait avec les derniers droits qu'on lui a poussés.

> Le client navigateur de cette librairie souscrit **trois** topics en permanence, `me-sessions` compris. Le troisième est ce qui rattrape une session coupée depuis l'écran des connexions du portail, que `me-signed-out` ne peut pas rapporter - voir [05-consuming-realtime.md](05-consuming-realtime.md).

**La frame EST la nouvelle valeur.** Elle porte le compte lui-même, donc rien ne relit `/sso/me` derrière. C'est tout l'intérêt de la socket.

## La latence, dite honnêtement

Du polling, pas un bus d'événements, et pour une raison : les valeurs publiées ici sont des lignes que plusieurs services écrivent, expirations comprises qu'aucun chemin de code ne touche, donc « est-ce que ça a changé » est une question à laquelle seule la lecture peut répondre.

| Ce qui arrive                                                                    | Comment ça remonte    | Sous  |
| -------------------------------------------------------------------------------- | --------------------- | ----- |
| une permission accordée ou révoquée, un groupe déplacé, un profil édité ailleurs | `me-changed`          | ~3 s  |
| la session SSO fermée, le compte désactivé, l'accès révoqué                      | `me-signed-out: true` | ~1 s  |
| la même chose, vue depuis la passerelle                                          | fermeture `4003`      | ~10 s |

Temps réel ici veut dire une à trois secondes selon le topic : `me-changed` porte le compte entier et c'est le coûteux, donc il tourne à trois, alors que la fin d'une session tourne à une. Une librairie qui promettrait l'instant mentirait d'une seconde au mieux.

## La revalidation, et pourquoi le code de fermeture compte

Une socket survit au token qui l'a ouverte : les sessions consumer tournent tous les quarts d'heure et la ligne à laquelle un token se résolvait est remplacée à chaque fois. Le droit de rester connecté est donc redemandé contre ce qui ne tourne **pas**, sur un intervalle de dix secondes : la session IdP doit être encore vivante et le compte doit encore détenir son accès. Dès que l'un des deux disparaît, la socket est fermée plutôt que laissée à diffuser vers quelqu'un que l'API HTTP refuse déjà.

| Code   | Signification                                |
| ------ | -------------------------------------------- |
| `4001` | non autorisé : la frame `auth` a été refusée |
| `4002` | la socket ne s'est pas authentifiée à temps  |
| `4003` | la session ou l'accès a disparu              |

Ils sont dans la plage 4000-4999 réservée aux applications, et un client les lit pour distinguer **« vous n'êtes pas le bienvenu »**, où réessayer ne sert à rien, d'une panne de transport, où réessayer avec backoff est la bonne réponse. Un consumer qui les relaie doit les laisser passer inchangés : voir [05-consuming-realtime.md](05-consuming-realtime.md).
