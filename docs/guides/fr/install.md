# Installer une application

## Ce qu'est cette librairie, avant toute chose

**Elle est propriétaire de x-core.** Pas « conçue pour » lui, pas « fonctionne au mieux avec » : elle parle le protocole de x-core, et il n'existe nulle part d'autre implémentation de ce protocole.

Concrètement, elle ne tournera contre rien d'autre :

- les routes sont celles de x-core - `PUT /api/v1/sso/consumer/config`, `POST|PUT|DELETE /api/v1/sso/consumer/session`, `GET /api/v1/sso/me`, `POST /api/v1/portal/install` ;
- l'authentification est le schéma HMAC de x-core, via `@naskot/node-hmac-auth-core`, signant `MÉTHODE + chemin(+query) + horodatage + nonce + sha256(corps)` avec un secret **haché** ;
- le modèle d'identité est celui de x-core : le clientId HMAC EST l'identité SSO. Il n'y a pas de couple `client_id` / `client_secret`, pas de document de découverte OAuth, pas de JWKS, pas d'OIDC. Pointer ceci sur un fournisseur OAuth2 ou OIDC n'échoue pas poliment - rien ne correspond ;
- les permissions sont le catalogue `resource:action` de x-core, recalculé par compte et répondu entier avec chaque `me` ;
- le protocole temps réel est celui de x-core, jusqu'à ses codes de fermeture ;
- les adresses du fournisseur sont **dérivées de celle qu'une application écrit** ([`src/provider.ts`](../../../src/provider.ts)) : la fenêtre de connexion est l'hôte de l'API sans son port, la socket est un port plus loin, et le portail revient avec l'appairage.

Il lui faut aussi un x-core assez récent pour servir `POST /api/v1/portal/install`. Contre un plus ancien, tout fonctionne sauf l'installation : le credential doit être provisionné à la main par `POST /api/v1/sso/consumer/config` et livré par le broker, et on tend alors à cette librairie un magasin qui le détient déjà.

## L'installation a lieu avant l'application

C'est la partie qui vaut d'être lue deux fois, parce qu'elle n'est plus là où elle était.

Une application n'est pas créée par un opérateur qui remplit un formulaire, et elle ne se crée pas elle-même non plus. Un opérateur va sur le manager de x-core, sous _Portails applicatifs → Jetons d'installation → Générer un jeton_, parcourt quatre étapes, et ce que la dernière rend est un **code d'appairage**. Cet acte EST l'installation :

| Étape | Où     | Quoi                                                                                      |
| ----- | ------ | ----------------------------------------------------------------------------------------- |
| 1     | x-core | demande au **manager d'infrastructure** une queue et un compte broker pour elle           |
| 2     | x-core | enregistre la **cible de propagation** sur laquelle le credential voyagera                |
| 3     | x-core | enregistre le **consumer SSO** : identité, callback, URL d'annulation, template, barrière |
| 4     | x-core | frappe le **credential HMAC** et le vise sur cette queue                                  |
| 5     | x-core | scelle les deux secrets sur la ligne du jeton, et répond le code                          |

Au moment où le code est remis, tout existe. La queue est sur le broker, le compte y est cantonné, l'identité est dans le SSO. Ce que l'opérateur emporte est une valeur.

Trois choses en découlent, et c'est tout l'intérêt :

**Un échec atterrit sur un formulaire.** Il atterrissait avant sur le premier démarrage d'un service que personne ne regardait, des heures plus tard, avec le code déjà dépensé - et la personne qui aurait pu réparer était rentrée chez elle. Maintenant une clé qui n'ouvre rien, un nom déjà pris, un manager en panne : tout ça refuse devant celui qui peut y faire quelque chose.

**La clé du manager appartient à l'opérateur, et elle est gardée.** La clé du manager d'infrastructure collée pour construire la réservation est scellée sur la ligne - c'est la seule chose qui peut redescendre le compte broker - et x-core ne la coupe jamais. Une clé installe autant d'applications qu'un opérateur en a à installer, et c'est sur le manager qu'il la révoque quand il a fini. Seule l'adresse sur laquelle elle est épinglée est exigée là-bas ; une expiration est bienvenue et pas demandée.

**Supprimer le code est une annulation.** La ligne sur cet écran est la seule chose qui sait qu'un compte broker et une identité SSO ont été créés pour une application qui n'est jamais arrivée. La supprimer redescend le credential, le consumer, la cible de propagation et le compte broker, dans cet ordre. Rien ne reste sous un nom pour lequel la tentative suivante serait refusée.

Le code lui-même : **une destination, un code** ; **il expire**, en heures ; **il est à usage unique**, et l'échanger supprime la ligne ; et **il reste lisible** sur cet écran tant qu'il vit, parce qu'une installation n'est pas toujours finie le jour où elle est préparée.

## Sa place dans la configuration

Le code va dans la configuration de l'application et y RESTE, pour la vie de l'application :

```ts
createXcoreBridge({
  // ALLUMÉ, OU DOUBLURE. La première clé, parce qu'elle décide toutes les autres.
  //
  // À `false` il n'y a pas d'appairage, pas de déclaration et pas de socket - ET CETTE
  // LIBRAIRIE AUTHENTIFIE QUAND MÊME, contre les comptes prêtés sous
  // `di.local_accounts`. Elle ne s'écarte PAS : les gardes tiennent,
  // `requirePermissions` refuse un droit qui manque, et la session qui en sort a
  // exactement la forme que x-core répond.
  //
  // À `false` avec RIEN de prêté, toutes les portes SE FERMENT : pas de fournisseur à
  // qui demander et pas d'annuaire à lire signifie que personne ne peut jamais se
  // connecter. S'écarter est ce qui servait autrefois chaque page protégée à qui
  // demandait.
  //
  // CE N'EST PAS UN « MODE DEV », c'est un interrupteur, et c'est l'application qui le
  // calcule. Une machine de développement qui veut la vraie chaîne écrit
  // `mode: "sso"` et n'y revient plus.
  //
  // PASSÉE, PAS LUE : cette librairie ne lit aucun `process.env`. Un bundler fige de
  // toute façon cette valeur à la construction, donc lue de l'intérieur elle porterait
  // ce qui était vrai sur la machine qui a construit l'image.
  mode: NODE_ENV === "production" ? "sso" : "local",

  // UN x-core, nommé par son API AVEC son port, et la seule adresse que cette
  // application écrit elle-même. La fenêtre de connexion vit sur les mêmes noms sans le
  // port et répond 204 à tout ce qu'elle ne connaît pas - donc une application pointée
  // dessus se déclare « avec succès » à chaque démarrage alors que rien n'existe en
  // face. Le démarrage sonde l'adresse avant de lui déclarer quoi que ce soit.
  //
  // Les trois autres adresses sont dérivées : la fenêtre de connexion est cet hôte sans
  // le port, la socket est un port plus loin, et le portail revient avec l'appairage.
  provider: { baseUrl: "https://x-core.example.com:13001" },

  // Le jeton d'installation frappé sur la console, et la SEULE valeur qu'un opérateur
  // recopie de tout ce flux. Il reste ici pour la vie de l'application : `INSTALLED`
  // décide s'il est échangé, pas sa présence.
  installToken: "EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4",
  di: { hmac: { … }, environment: { load, save } },
});
```

Il n'y a pas d'identité ici, pas d'URL de retour, pas de barrière et pas de mot de passe de session. Tout cela a été saisi sur la console au moment où le code a été frappé, et l'appairage le rapporte - il y a donc exactement un endroit qui décide de ce qu'est cette application, et ce n'est pas ce fichier.

### Il n'y a pas de `install()` à appeler

Ce qui décide si l'appairage a lieu n'est pas la présence du code mais la clé `INSTALLED` du magasin de l'application :

| `INSTALLED`    | Ce que fait le démarrage                                                |
| -------------- | ----------------------------------------------------------------------- |
| absente, false | échange le code, écrit le credential, range tout avec `INSTALLED: true` |
| true           | ne regarde même pas le code, déclare, et c'est tout                     |

Deux choses en découlent, et ce sont les deux qui rendaient l'ancienne forme fragile.

Le code **reste dans la configuration**. Il n'y a rien à retirer après le premier démarrage, donc rien à oublier de retirer. Et comme il n'est plus lu une fois la clé posée, un déploiement qui le garde ne le dépense pas une seconde fois - il n'ouvrirait rien de toute façon : x-core a supprimé la ligne à l'instant où il a été dépensé.

L'état est **écrit**, pas déduit. La question « est-ce déjà installé ? » se répondait en cherchant un credential dans le magasin, ce qui est une preuve indirecte : un credential arrivé par propagation, sans installation derrière, répondait « oui » à une question qu'on ne lui posait pas.

`INSTALLED` est écrit dans le MÊME `save` que tout ce qu'il annonce, et jamais avant. Écrit en premier, un démarrage qui tomberait entre les deux se croirait appairé sans rien détenir de ce que cela annonce - et ne réessaierait jamais, puisqu'il ne regarde plus le code.

## Un appel, et il n'y a rien à faire

```ts
await xcore.start();
```

Il lit le magasin, appaire s'il le faut, et déclare. Il va à l'adresse `provider` configurée ci-dessus, et à exactement une route dessus :

```http
POST https://x-core.example.com:13001/api/v1/portal/install
x-install-token: EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4
content-type: application/json

{}
```

Ce qu'il fait est petit, et plus petit qu'il n'y paraît :

| Étape | Où              | Quoi                                                                                             |
| ----- | --------------- | ------------------------------------------------------------------------------------------------ |
| 1     | cette librairie | lit `di.environment.load()` et regarde `INSTALLED`                                               |
| 2     | cette librairie | `POST {provider}/api/v1/portal/install`, **non signé**, **sans corps**                           |
| 3     | x-core          | lit la réservation, la répond entière et supprime la ligne                                       |
| 4     | x-core          | laisse la clé du manager tranquille : elle est à l'opérateur, et elle installe la suivante aussi |
| 5     | cette librairie | ouvre la file de propagation ; le credential y arrive et passe par `di.hmac.setCredential`       |
| 6     | cette librairie | range la réponse entière, `INSTALLED` compris, en un seul `save`                                 |
| 7     | cette librairie | déclare le consumer, signé, comme le fait chaque démarrage suivant                               |

C'est le seul appel non signé que cette librairie fait jamais, et il ne peut pas en être autrement : ce qu'il collecte est le credential à partir duquel une signature serait construite, donc en exiger une reviendrait à exiger le résultat comme entrée.

**Pas de corps**, et c'est délibéré. Une application qui pourrait encore envoyer sa propre URL de retour ici serait une application capable de pointer l'installation de quelqu'un d'autre sur elle-même.

### Il ne lève jamais

Tout ce qui précède revient sous forme de valeur, et est dit en une ligne bruyante dans le journal :

```ts
const started = await xcore.start();
if (!started.ok) console.error(`[app] le SSO ne sert pas (${started.status}) : ${started.reason}`);
```

| `status`       | Ce que ça signifie                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`        | sert : soit appairé et déclaré, soit en doublure contre `di.local_accounts`                                                               |
| `not-paired`   | pas de jeton d'installation, un jeton refusé par le fournisseur - **dans ses propres mots** - ou l'interrupteur éteint sans rien de prêté |
| `not-declared` | le fournisseur n'a pas été informé de la façon dont cette application se branche                                                          |

`XcoreStartResult` déclare aussi un statut `withdrawn`. **Rien ne le rend.** À `mode: "local"` avec un annuaire prêté la réponse est `ready`, et sans rien de prêté c'est `not-paired` - ce membre d'union est un reste de l'époque où l'interrupteur signifiait s'écarter. Brancher sur `ok`, jamais sur cette valeur.

Un démarrage qui mourrait parce qu'un jeton a été dépensé, parce que le broker n'était pas encore levé ou parce que le fournisseur démarrait encore emporterait toute l'application avec lui - y compris les pages qui n'ont rien à voir avec le SSO, et y compris ce qu'un opérateur utiliserait pour regarder le problème. Elle se lève donc, dit ce qui ne marche pas, et se répare par une valeur dans une configuration plutôt que par un conteneur qui ne veut pas rester en vie.

Tant qu'elle n'est pas appairée, sur une application qui dit utiliser le SSO, **toutes les portes se ferment**. Il n'y a pas de nom de cookie à lire, pas de mot de passe de scellement et rien sous quoi signer, donc rien ne peut être appris d'un lecteur - et ce qui ne peut pas être identifié ne peut pas être servi. Elle s'écartait autrefois, au motif que refuser un lecteur pour une faute qui n'est pas la sienne est injuste ; s'écarter servait chaque page protégée à qui demandait, sur un déploiement que personne n'avait configuré, c'est-à-dire l'application avec sa serrure retirée.

Les cinq refus à reconnaître, et ce sont les phrases de x-core :

| Ce que x-core répond                                                      | Quoi faire                                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Unknown install token`                                                   | il n'a jamais été frappé, ou contre un autre x-core                                                                         |
| `This install token was withdrawn`                                        | quelqu'un l'a révoqué depuis la console                                                                                     |
| `This install token has expired`                                          | en frapper un nouveau                                                                                                       |
| `This install token was redeemed a moment ago`                            | déjà dépensé : en frapper un nouveau                                                                                        |
| `This install token carries no reservation: delete it and mint a new one` | un BROUILLON - le formulaire a été laissé à moitié fini, donc il n'y a ni queue, ni compte broker, ni credential à remettre |

### La queue

Elle compte au-delà de cet appel : c'est par elle que voyage chaque **rotation** ultérieure. Sans elle, le secret existerait dans x-core et dans cette unique réponse et nulle part ailleurs, et rien ne pourrait jamais le remplacer.

Le nom sur le broker est `hmac-<base>.queue`, où `base` est ce que le manager d'infrastructure a construit depuis la destination et l'environnement - `x-facturation-prod`, et le login `x_facturation_prod`. Rien de tout ça n'est décidé ici ni deviné : c'est relu de ce que le manager a répondu, si bien qu'il y a une implémentation de la convention plutôt que deux qui peuvent diverger.

## Ce qui revient, et où ça atterrit

Rien n'est rendu pour être recopié. `start()` range la réponse entière par `di.environment.save`, et `xcore.environment` la relit :

```ts
xcore.environment;
// {
//   INSTALLED:                   true,
//   SSO_SESSION_PASSWORD:        "…",                     // tiré ici, jamais reçu
//   SSO_SESSION_COOKIE_NAME:     "sso_oauth_x_facturation",
//   SSO_CLIENT_ID:               "oauth-x-facturation",
//   SSO_REDIRECT_URI:            "https://facturation.example.com/api/auth/sso/callback",
//   SSO_CANCEL_URI:              "https://facturation.example.com/",
//   SSO_PORTAL_URL:              "https://portal.example.com",     // où atterrit une déconnexion
//   SSO_FRONT_URL:               "https://x-sso.example.com",      // la fenêtre de connexion, si nommée
//   SSO_TEMPLATE:                "default",
//   SSO_DEPEND_GLOBAL_RESSOURCE: ["facturation"],
//
//   HMAC_AMQP_QUEUE:             "x-facturation-prod",
//   HMAC_PROPAGATION_SECRET:     "…",
//   HMAC_AMQP_VHOST:             "hmac-credentials",
//   HMAC_AMQP_BROKER_QUEUE:      "hmac-x-facturation-prod.queue",
//
//   RABBITMQ_PROTOCOL:           "amqps",
//   RABBITMQ_HOST:               "x-amqp.example.com",
//   RABBITMQ_PORT:               5671,
//   RABBITMQ_USER:               "x_facturation_prod",
//   RABBITMQ_PASSWORD:           "…",
//
//   // Écrite par cette librairie, jamais par l'appairage : une position, pas un réglage.
//   "HMAC_PROPAGATION_CURSOR:…":  { ts: "…", eventId: "…" },
// }
```

Le credential HMAC n'est PAS parmi elles : il arrive sur la file de propagation et passe par `di.hmac.setCredential`, dans le magasin qui signe avec, et jamais sur une étagère clé/valeur à côté d'un mot de passe de broker.

Les clés `RABBITMQ_*` et `HMAC_AMQP_*` sont la configuration de propagation de l'application, et câbler le consumer avec reste son affaire - **cette librairie ouvre la file de credentials elle-même**, avec `@naskot/node-hmac-auth-core-propagation` en dépendance à elle. Ce qui a changé est qu'elles ne sont plus recopiées à la main depuis un écran, ce qui est le geste qu'on rate : non câblées, une application signe parfaitement à son premier démarrage puis rate toutes les rotations suivantes. Le secret est remplacé dans x-core, l'événement est publié sur une file que personne ne lit, et ce qui remonte des jours plus tard est un `401` sur chaque appel sans que rien ne nomme la cause.

L'ADRESSE du broker voyage avec elles, et c'est délibéré : elle appartient à l'infrastructure et bouge avec elle. Une application qui en tient une copie continue de composer l'ancienne longtemps après que tout le monde a déménagé.

`account` n'est plus jamais null. Il l'était, quand x-core créait la queue lui-même : administrer un utilisateur broker demande le plugin de management et un credential administrateur, que x-core ne détient pas et ne doit pas détenir. Le manager d'infrastructure le détient, c'est son travail, et le compte qu'il crée est cantonné aux queues de cette seule application et à rien d'autre sur le vhost. Un compte capable de lire tout le vhost de propagation pourrait lire les rotations de toutes les autres applications, c'est-à-dire leurs credentials.

`HMAC_PROPAGATION_SECRET` n'est pas décoratif non plus. Chaque événement de rotation que x-core publie porte le secret enregistré sur la ligne de cette queue, et le récepteur le compare à ce avec quoi il a été configuré. Une différence n'est pas une erreur que quelqu'un voit - c'est une rotation perdue en silence.

## Ensuite

Rien de l'installation ne s'exécute à nouveau. À partir de là l'application signe avec sa propre identité et se redéclare à chaque démarrage - `PUT /sso/consumer/config`, idempotent - ce qui est précisément ce que fait déjà chaque application de l'écosystème.

`start()` peut rester dans le chemin de démarrage pour toujours, et il n'y a pas de `install()` à côté - l'ancienne forme en avait un, et voici ce qui l'a remplacé :

- **`INSTALLED` vaut vrai** → le jeton n'est même pas lu. Le démarrage ouvre la file et déclare, et c'est tout ;
- **pas de jeton, et pas installé** → `not-paired`, avec une raison nommant l'écran de la console qui en frappe un. Rien ne lève ;
- **un jeton que le fournisseur refuse** → `not-paired`, portant la phrase de x-core : inconnu, révoqué, expiré, déjà échangé, ou encore brouillon ;
- **le magasin refuse de garder ce qui est revenu** → `not-paired`, et la raison dit que le jeton est dépensé et qu'il faut en frapper un nouveau. C'est le seul échec qu'un autre démarrage ne répare pas.

Il n'y a pas d'état à moitié installé dont il faudrait se remettre, parce que rien n'est construit à ce moment-là : l'appel trouve une réservation qui attend, ou ne trouve rien du tout. Et `INSTALLED` est écrit dans le même `save` que tout ce qu'il annonce, donc il n'existe aucun instant où l'application se croit appairée sans rien en détenir.

Faire tourner plusieurs workers : le code est à usage unique, donc exactement un d'entre eux peut le tenter. Voir [Faire tourner plusieurs processus](./multi-process.md).
