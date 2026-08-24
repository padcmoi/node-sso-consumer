# La surface HTTP signée

Chaque appel qu'une application fait à x-core est signé, de serveur à serveur. Il n'y a pas de couple `client_id` / `client_secret`, pas de document de découverte, pas de JWKS et pas d'OIDC : **le clientId HMAC EST l'identité SSO**, et une route résout l'appelant depuis la signature plutôt que depuis quoi que ce soit dans la charge utile.

## La signature

Construite par `buildHttpSignedHeaders` de `@naskot/node-hmac-auth-core`, sur :

- la **méthode**,
- le **chemin, query string comprise**,
- un horodatage et un nonce,
- le **hash du corps**.

Trois conséquences, à connaître avant de les rencontrer sous forme de 401 :

- signer un `POST` et envoyer un `PUT` échoue, donc le verbe est un paramètre et jamais une constante ;
- la query est couverte, ce qui rend `GET /sso/me?accessToken=…` légitime plutôt qu'un credential qui fuit dans une URL ;
- **les en-têtes ne sont pas couverts**, et c'est pourquoi aucun credential n'y voyage jamais.

Un `GET` n'envoie pas de corps et signe sur la chaîne vide, ce que le vérificateur hache de son côté. Un `DELETE` sans corps fait pareil.

Le secret lui-même ne vit jamais dans le processus appelant. Ce qui est lu du magasin de credentials est le **hash** calculé par x-core, et la librairie signe à partir de lui avec `secretIsHashed: true`. Il est relu à chaque appel : un client fabriqué une fois au démarrage continuerait de signer avec un credential qu'une rotation a déjà remplacé.

## Les routes

Chemin de base `/api/v1`. `SsoMe` ci-dessous est la forme de [session.json](session.json).

| Verbe et chemin                            | Corps ou query                                                                      | Répond                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------ |
| `PUT /sso/consumer/config`                 | `{ redirectUri, cancelUri?, template?, dependGlobalRessource[], skipAccessCheck? }` | `204`                                |
| `GET /sso/consumer/config?consumer=`       | réservé à l'identité du front SSO                                                   | `{ data: … }`, ou `401` à tout autre |
| `POST /sso/consumer/session`               | `{ code, clientIp, clientUserAgent }`                                               | `{ data: SsoSession }`               |
| `PUT /sso/consumer/session`                | `{ refreshToken, clientIp, clientUserAgent }`                                       | `{ data: SsoSession }`               |
| `DELETE /sso/consumer/session`             | `{ refreshToken }`                                                                  | `204`                                |
| `GET /sso/me?accessToken=`                 |                                                                                     | `{ data: SsoMe }`                    |
| `PUT /sso/me`                              | `{ accessToken, ...profilePatch }`                                                  | `{ data: SsoMe }`                    |
| `GET /sso/me/sessions?accessToken=&limit=` |                                                                                     | `{ data: SsoMeSession[], count }`    |
| `DELETE /sso/me/sessions/:id?accessToken=` |                                                                                     | `204`                                |

`POST /sso/consumer/config` existe aussi et **n'est pas** pour une application : elle provisionne un credential et est réservée à l'identité de gestion des credentials de x-core.

### Déclarer comment l'application se branche

`PUT`, pas `POST` : renvoyer la même charge utile laisse la même ligne, et la ligne est clefée par l'identité HMAC qui a signé, jamais nommée dans le corps. Personne n'enregistre une application à la main, et changer son callback, son écran de connexion ou sa barrière d'accès est un changement de configuration qui se déploie comme n'importe quel autre.

`dependGlobalRessource` est un **tableau, envoyé à chaque déclaration, vide ou non**. Un champ optionnel n'est écrit que s'il est fourni, donc l'omettre pourrait poser une barrière et ne jamais en retirer une.

`redirectUri` est résolu côté serveur depuis cette ligne quand un navigateur revient. **Aucun `redirect_uri` ne voyage jamais dans une query**, ce qui rend une redirection ouverte impossible.

### Ouvrir, faire tourner et fermer une session

Les trois verbes portent leur credential (le code, ou le refresh token) dans le **corps**, qui est ce que la charge signée hache. Ni l'un ni l'autre n'a sa place dans une URL : les journaux d'accès, le `Referer` et les traces le garderaient.

`clientIp` et `clientUserAgent` sont ceux du **navigateur**, transmis par l'application. Ils voyagent aussi sur la rotation, pas seulement à l'ouverture : la rotation remplace la ligne que x-core garde, donc sans eux chaque renouvellement classe la session sous l'adresse du conteneur appelant, ce que le propriétaire du compte lit ensuite sur l'écran des sessions du portail.

La rotation est à **usage unique**. Le refresh token présenté est dépensé et un nouveau couple est émis, donc ce qui revient doit être re-scellé ou la session meurt à la requête suivante. Voir [04-lifecycle.md](04-lifecycle.md) pour ce que cela impose.

`SsoSession` est le couple, plus pour qui il est :

```jsonc
{
  "accessToken": "…",
  "accessTokenExpiresAt": "…",
  "refreshToken": "…",
  "refreshTokenExpiresAt": "…",
  "user": { "id": "…", "email": "…", "displayName": "…", "avatarUrl": "…|null", "hasPassword": true },
}
```

L'identité est le même objet partout, ici et sous `me`. `hasPassword` dit si le compte détient un mot de passe local : il vaut `false` pour un compte ouvert via un fournisseur externe qui n'en a jamais posé, ce qui indique à un écran de profil de demander un nouveau mot de passe sans demander l'actuel.

`DELETE` termine la session **de cette application**. La session SSO dont elle descend reste ouverte, volontairement : se déconnecter d'une application n'est pas se déconnecter de l'écosystème.

### Lire et écrire le compte

`GET /sso/me` est le compte, entier, recalculé à chaque lecture : identité, profil civil, permissions et groupes. C'est aussi la **sonde de vivacité**, parce que l'access token porte la session IdP dont il descend et que x-core le refuse dès que cette session est fermée.

`PUT /sso/me` écrit l'identité civile et répond le compte **après** l'écriture, si bien que rien n'a besoin d'une seconde lecture. Les champs écrivables sont ceux du profil, moins ce qui appartient au fournisseur d'identité (`locale`, l'identifiant de sujet externe) et à la base de données (les horodatages). Un champ omis est laissé intact ; un `null` explicite l'efface.

```
avatarUrl gender lastname firstname birthDate address address2
city postalCode country latitude longitude phone1 phone2
```

`gender` est un code stable, jamais un libellé : `mr`, `mrs`, `other`.

### Les connexions du compte lui-même

`GET /sso/me/sessions` les liste, `DELETE /sso/me/sessions/:id` en termine une. Une ligne est nommée par son id, ce qui n'accorde rien en soi : le token de session ne quitte jamais x-core.

```jsonc
{
  "id": "…",
  "consumer": "…|null",
  "ip": "…|null",
  "userAgent": "…|null",
  "createdAt": "…",
  "expiresAt": "…",
  "revokedAt": "…|null",
  "lastSeenAt": "…|null",
  "active": true,
  "online": true,
  "current": false,
}
```

Les deux sont aussi joignables par la socket, et c'est comme ça qu'une application devrait s'y prendre : voir [02-protocol-realtime.md](02-protocol-realtime.md).

## Les réponses, et celle qui n'en est pas une

`204` ne porte pas de corps et ne doit pas être parsée. Un non-2xx est un refus à faire remonter, jamais à avaler.

**Une base qui répond `204` à tout est l'échec que ce protocole invite.** L'API et la fenêtre de connexion diffèrent d'un port, et un Nitro répond `204 No Content` à une route qu'il ne connaît pas. Une application pointée sur la fenêtre de connexion se déclare donc avec succès à chaque démarrage, écrit son propre succès dans ses journaux, et rien n'existe en face jusqu'à ce qu'une connexion échoue des semaines plus tard.

La sonde contre ça est un appel non signé :

```
PUT <apiBase>/api/v1/sso/consumer/config     sans signature
attendu : 401
```

`401` est la bonne réponse, et la seule qui prouve que l'autre bout vérifie les signatures. Tout le reste, succès compris, signifie que l'adresse n'est pas x-core et que rien ne doit lui être déclaré.

Le verbe est celui qu'utilise la déclaration elle-même, et aucune query n'est envoyée : ce qui est testé est si l'autre bout vérifie les signatures, et un appel non signé sur une route signée est toute la question.

## L'unique route qui ne porte pas de signature

`POST /api/v1/portal/install`, qui échange le jeton d'installation. C'est le moment où l'application n'a pas encore d'identité du tout, donc il n'y a pas de signature à faire et rien encore pour la faire : ce qui l'authentifie est le jeton, à usage unique, de courte durée, et frappé pour cette application seule.

C'est aussi ce qui rend le credential avec lequel tout le reste signe. Toutes les autres routes consommées exigent la signature.
