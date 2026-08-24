# Intégration Express

> **Propriétaire de x-core.** Cette librairie parle les routes de x-core, son schéma HMAC, son catalogue de permissions et son protocole temps réel ; il n'en existe aucune autre implémentation. Voir [Installer une application](./install.md).

Une console d'infrastructure sans page de connexion : elle s'entre depuis le portail, tient sa session sur le SSO, montre et applique ses droits, et suit le compte par une socket.

Six fichiers, dans l'ordre où ils s'écrivent. Rien n'est élidé.

> **Elle remplace toute l'authentification locale, pas une partie.** Pas de table
> d'utilisateurs, pas de colonne mot de passe, pas de parcours de réinitialisation, pas
> de table de sessions, pas de table de permissions, pas de page de connexion. Le
> compte, le profil et les droits sont demandés à x-core à chaque requête et jamais mis
> en cache - c'est ce qui fait qu'une révocation ailleurs s'applique dès l'appel
> suivant. Le cookie porte l'id du compte et le couple de tokens, et rien d'autre. Voir
> [ce qu'elle remplace](../../../README.md#it-replaces-the-whole-local-authentication).

## 1) Le service

`src/sso/xcore.service.ts`

Une instance pour toute l'application, construite une fois au niveau du module : plusieurs ouvriraient chacune leurs propres sockets pour les mêmes comptes.

Ce que cette application DÉCIDE est court, et ce qu'elle PRÊTE est plus court encore. Ce qu'elle EST vis-à-vis de x-core - identité, URL de retour, URL d'annulation, template, barrière - est saisi sur la console au moment où le code d'appairage est frappé, et l'appairage le rapporte. Un seul endroit en décide, et ce n'est pas ce fichier.

Rien ne vient d'un `.env` non plus, pas même le mot de passe qui scelle le cookie : il est tiré au premier démarrage et gardé dans le magasin de l'application.

**Une seule valeur se copie à la main**, depuis l'écran qui frappe le code, et elle reste ici pour la vie de l'application :

```ts
installToken: "EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4",
```

Il n'y a pas de `install()` à appeler. Ce qui décide si l'appairage a lieu n'est pas la présence de ce code mais la clé `INSTALLED` de `di.environment` : tant qu'elle ne vaut pas vrai le démarrage échange le code, et dès qu'elle vaut vrai le démarrage ne le regarde plus. Il n'y a donc rien à retirer d'une configuration après coup, et rien à penser à appeler au bon démarrage.

```ts
// Construite par l'application, sur son propre Redis. Elle n'entre jamais dans cette
// librairie.
import { hmacInstance } from "./hmac";
import { createXcoreBridge } from "@gestionpratique/node-sso-consumer";
import { settings } from "./settings";
import { accountStore } from "./account-store";

export const xcore = createXcoreBridge({
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
  // `enabled: true` et n'y revient plus.
  //
  // PASSÉE, PAS LUE : cette librairie ne lit aucun `process.env`. Un bundler fige de
  // toute façon cette valeur à la construction, donc lue de l'intérieur elle porterait
  // ce qui était vrai sur la machine qui a construit l'image.
  enabled: NODE_ENV == "production" ? true : false,

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

  session: {
    // Pas de mot de passe et pas de nom : le premier est tiré au premier démarrage, le
    // second est dérivé de l'identité par x-core. Ce qui reste est la forme du cookie.
    cookie: { secure: true, sameSite: "lax", maxAgeDays: 30 },
  },
  routes: { basePath: "/api/auth", afterLogin: "/" },
  realtime: { path: "/_ws/realtime" },
  live: { enabled: true },

  di: {
    // DEUX FONCTIONS, et l'instance HMAC ne traverse jamais. Cette librairie ne nomme
    // aucune méthode de `@naskot/node-hmac-auth-core` : elle connaît deux moments -
    // « donne-moi le hash courant », « range celui-ci » - et ton code sait comment. Le
    // jour où ce paquet renomme une méthode, ce qui casse est cette ligne-ci.
    //
    // UN HASH dans les deux sens. x-core range `hashClientSecret(secret, poivre)` et
    // vérifie contre ça, et le poivre ne circule jamais : une application qui hacherait
    // le secret brut elle-même signerait avec autre chose et récolterait un 401 sur
    // chaque appel. Ce qui signe est le hash que x-core a calculé, et il arrive sur la
    // file de propagation que cette librairie consomme pour toi.
    hmac: {
      getCredential: (clientId) => hmacInstance.clients.getSecretHash(clientId),
      setCredential: (clientId, secretHash) => hmacInstance.clients.setSecretHash(clientId, secretHash),
    },
    environment: {
      load: () => settings.all(),
      save: (values) => settings.upsertAll(values),
    },
    onAccount: (userId, me) => accountStore.replace(userId, me),
    onSignedOut: (userId) => accountStore.clear(userId),
  },

  logger: console,
  timeoutMs: 10_000,
  retry: { attempts: 5, delayMs: 3_000 },
});
```

| Ce qu'elle prête            | Reçoit                         | Rend          | Appelée quand                    |
| --------------------------- | ------------------------------ | ------------- | -------------------------------- |
| `environment.load()`        | rien                           | chaque clé    | au démarrage, en premier         |
| `environment.save(values)`  | les clés à écrire              | rien          | à l'appairage, et à une rotation |
| `onAccount(userId, me)`     | ce que le fournisseur a poussé | rien          | une permission change            |
| `onSignedOut(userId)`       | le compte                      | rien          | la session est terminée          |
| `errors(refusal, req, res)` | un refus déjà décidé           | rien, ou lève | à chaque refus                   |
| `local_accounts`            | -                              | une liste     | lue seulement à `enabled: false` |

`errors` est facultative et c'est là qu'un refus est PRONONCÉ. La librairie décide si et pourquoi - c'est la seule chose qui parle au fournisseur - et tend la conclusion entière : le statut, le code, la phrase, et l'adresse où envoyer un navigateur quand il y en a une. Réponds comme le framework veut, sur `res` ou en levant ; le throw voyage intact. Ne rien prêter et la librairie écrit la réponse simple elle-même.

`local_accounts` est un ANNUAIRE, pas une procédure : une liste de comptes, et pas de fonction de connexion à écrire. Voir [`enabled`](../../../README.md#enabled---x-core-answers-or-this-library-stands-in-for-it).

La signature n'est pas écrite ici non plus : cette librairie tient `@naskot/node-hmac-auth-core` en dépendance à elle et construit le transport signé elle-même, depuis le hash que `getCredential` rend. Il n'y a donc pas de seconde implémentation du protocole de ce côté pour diverger de celle qui vérifie en face, et aucun secret ne traverse la frontière - un hash est demandé, un hash est rangé.

Le hash est relu à CHAQUE appel plutôt que capturé au démarrage : le credential est remplacé par propagation, et un client fabriqué une fois signerait avec l'ancien jusqu'au prochain redémarrage - ce qui remonte en `401` sur tout, sans que rien ne nomme la cause.

`environment` tient vingt clés et cette librairie les écrit : `INSTALLED`, `SSO_SESSION_PASSWORD`, `SSO_SESSION_COOKIE_NAME`, `SSO_CLIENT_ID`, `SSO_REDIRECT_URI`, `SSO_CANCEL_URI`, `SSO_PORTAL_URL`, `SSO_FRONT_URL`, `SSO_TEMPLATE`, `SSO_DEPEND_GLOBAL_RESSOURCE`, `HMAC_AMQP_QUEUE`, `HMAC_PROPAGATION_SECRET`, `HMAC_AMQP_VHOST`, `HMAC_AMQP_BROKER_QUEUE`, `RABBITMQ_PROTOCOL`, `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` et `HMAC_PROPAGATION_CURSOR`. Cette dernière est l'endroit où en est la file de credentials, pour qu'une rotation redélivrée ne soit appliquée qu'une fois : une position plutôt qu'un réglage, et la seule clé ici dont x-core ne sait rien. Les valeurs sont du JSON, pas des chaînes - une barrière est une liste, un port est un nombre - et `save` est un UPSERT : elle écrit les clés qu'on lui donne et laisse les autres tranquilles.

`xcore.environment` rend le tout, pour ce que l'application en fait d'autre. Le broker n'en fait plus partie : **cette librairie ouvre la file de credentials elle-même**, avec `@naskot/node-hmac-auth-core-propagation` en dépendance à elle, et une application n'écrit aucun AMQP. Cette file n'est pas un confort : c'est par elle qu'une application appairée obtient une clé qui vérifie tout court, puisque le secret que l'appairage répond est haché par x-core avec un poivre qui ne circule jamais.

## 2) Le serveur

`src/server.ts`

`start()` avant `listen` : une console qui a raté sa déclaration démarre parfaitement et refuse ensuite toutes les connexions, ce qui est l'échec le plus long à remonter.

```ts
import express from "express";
import { createServer } from "node:http";
// Importé une fois, pour son effet : c'est ce qui pose `req.me` sur le type d'Express.
import "@gestionpratique/node-sso-consumer/express";
import { queueRoutes } from "./routes/queues.routes";
import { accountRoutes } from "./routes/account.routes";
import { xcore } from "./sso/xcore.service";
const app = express();

app.use(express.json());
// De l'hygiène Express, et PAS quelque chose dont cette librairie dépend : elle lit
// `x-forwarded-for` sur les en-têtes bruts elle-même. Ce qui compte vraiment est que le
// relais ENVOIE cet en-tête - sans lui chaque session est classée sous l'adresse de ce
// conteneur, ce que l'écran des sessions du portail montre ensuite.
app.set("trust proxy", true);

// GET  /api/auth/sso/start       la carte du portail pointe ici
// GET  /api/auth/sso/callback    le code revient, scellé en session
// POST /api/auth/sso/sign-in     ne répond QU'EN doublure, 404 sinon
// POST /api/auth/logout          ferme la session de cette console, pas celle du SSO
// GET  /api/auth/session         le compte, ses détails, ses droits
// POST /api/auth/realtime-ticket ce avec quoi la page appelle la socket
app.use(xcore.middleware.routes());

// Rien sous /api n'est joignable déconnecté. Aucune exception et aucune route publique :
// un navigateur sans session repart au portail, qui est la seule chose dans cet
// écosystème qui connecte un humain.
app.use("/api", xcore.middleware.requireSession());

app.use(queueRoutes(xcore));
app.use(accountRoutes(xcore));

// En dernier, et après les routes : il mappe les codes de la librairie sur des réponses.
app.use(xcore.middleware.errors());

const server = createServer(app);
// La socket que le navigateur appelle, pontée vers celle du fournisseur. Elle rend la
// main pour chaque upgrade qui n'est pas la sienne, si bien que les flux propres à cette
// console peuvent partager le serveur.
xcore.realtime.attach(server);

await xcore.start();
server.listen(3333, () => console.info("[api] écoute sur 3333"));

export { xcore };
```

## 3) Les routes

`src/routes/queues.routes.ts` - les deux niveaux : ce que le middleware refuse, et ce que la réponse cache.

```ts
import { Router } from "express";
import type { Xcore } from "../sso/xcore.service";
import { brokerService } from "../services/broker.service";

export const queueRoutes = (xcore: Xcore) => {
  const router = Router();

  router.get("/api/queues", xcore.middleware.requirePermissions("view-queues"), async (req, res) => {
    res.json({
      data: await brokerService.list(),
      // La même liste que lisent les gardes part vers le navigateur, et c'est voulu :
      // ça cache un bouton que l'API refuserait de toute façon. Cacher n'est pas
      // appliquer - le middleware sur chaque route, si.
      can: {
        create: xcore.can(req, "create-queues"),
        manage: xcore.can(req, "manage-queues"),
        delete: xcore.can(req, "delete-queues"),
      },
    });
  });

  router.post("/api/queues", xcore.middleware.requirePermissions("create-queues"), async (req, res) => {
    // `requireSession` l'a déjà résolu pour cette requête ; redemander serait un autre
    // aller-retour - et une autre rotation de token - pour la même réponse.
    const queue = await brokerService.create(req.body, { by: req.me?.user.email });
    res.status(201).json({ data: queue });
  });

  // Relire un credential est un droit à part, pas une nuance de la gestion : celui qui
  // peut renommer une queue n'a pas à se voir remettre son mot de passe.
  router.post(
    "/api/queues/:name/credentials",
    xcore.middleware.requirePermissions("reveal-queue-credentials"),
    async (req, res) => {
      res.json({ data: await brokerService.credentials(req.params.name) });
    }
  );

  // Plusieurs actions veulent dire TOUTES, et le refus nomme celles qui manquent.
  router.post(
    "/api/queues/:name/regenerate",
    xcore.middleware.requirePermissions("manage-queues", "reveal-queue-credentials"),
    async (req, res) => {
      res.json({ data: await brokerService.regenerate(req.params.name) });
    }
  );

  // Supprimer est un droit à soi : les autres verbes se réparent en les refaisant,
  // celui-ci non.
  router.delete("/api/queues/:name", xcore.middleware.requirePermissions("delete-queues"), async (req, res) => {
    await brokerService.remove(req.params.name);
    res.status(204).end();
  });

  return router;
};
```

## 4) Le compte

`src/routes/account.routes.ts` - la seule route ici qui ne demande aucun droit : elle parle du lecteur, pas de l'infrastructure.

```ts
import { Router } from "express";
import type { Xcore } from "../sso/xcore.service";

export const accountRoutes = (xcore: Xcore) => {
  const router = Router();

  router.get("/api/me", (req, res) => {
    res.json({
      data: req.me,
      // Ce dont les écrans de CETTE console se servent : les actions que le compte
      // détient ici, sans leur préfixe. Rien n'a été déclaré pour les obtenir - elles
      // viennent avec le compte, recalculées par le fournisseur sur cette requête même.
      actions: xcore.actions(req),
    });
  });

  return router;
};
```

## 5) La page

`src/public/app.js` - la moitié navigateur, qui est aussi celle de la librairie.

```js
import { createSsoClient } from "@gestionpratique/node-sso-consumer/client";

const sso = createSsoClient({
  basePath: "/api/auth",
  // Poussé, pas interrogé - et RIEN ici n'est interrogé en boucle : ce client demande
  // la session une fois, un ticket par socket, et une déconnexion sur un clic. Tout le
  // reste arrive sur la socket, ce à quoi sert une socket.
  onAccount: (me) => render(me),
  // La session IdP a été fermée, le compte désactivé, son accès révoqué, ou cette
  // session terminée depuis l'écran des connexions du portail. Le portail est la seule
  // chose qui connecte un humain, donc c'est là que ça va.
  onSignedOut: () => location.assign("https://portal.example.com/"),
  onConnectionChange: (connected) => badge.classList.toggle("live", connected),
});

const me = await sso.connect();
if (!me) location.assign("/api/auth/sso/start");

// Cache un bouton que l'API refuserait de toute façon. Le serveur décide, toujours.
if (sso.can("infrastructure:delete-queues")) deleteButton.hidden = false;
```

Rien du ticket, de l'URL de la socket, de la reconnexion ni des codes de fermeture n'est écrit ici : `connect()` lit la session, demande un ticket, appelle cet hôte, et distingue une session terminée d'une connexion qui a lâché.

## 6) Suivre un compte ailleurs

Le bridge suit déjà chaque compte pour lequel il tient une session, et c'est ce qui rend les lectures réactives. Deux rappels existent pour ce que la librairie ne peut pas connaître - un store propre à cette console, un cache, un flux qu'elle éventaille elle-même :

```ts
createXcoreBridge({
  // ...
  di: {
    // ...
    onAccount: (userId, me) => store.replace(userId, me),
    onSignedOut: (userId) => store.clear(userId),
  },
});
```

Et pour une socket à soi, sur un compte :

```ts
// `sessions.read` lit le cookie scellé et ne demande rien au fournisseur, ce qui en fait
// le bon appel quand c'est le token lui-même qu'on veut.
const held = xcore.sessions.read(xcore.jar(req, res));
if (held) {
  const live = await xcore.follow({
    accessToken: held.tokens.accessToken,
    onAccount: (me) => feed.push(me),
    onSignedOut: () => feed.end(),
  });
  // L'appelant la possède et la ferme. `xcore.close()` ne lâche que ce que le bridge a
  // ouvert lui-même.
}
```

## 7) Notes de production

- Le relais doit ENVOYER `x-forwarded-for`, sinon chaque session est classée sous l'adresse de ce conteneur. Cette librairie lit cet en-tête sur la requête brute elle-même, donc `app.set("trust proxy", true)` est de l'hygiène Express plutôt qu'une nécessité pour elle.
- `await xcore.start()` avant `listen`, et le laisser là : il est sauté en silence dès qu'un credential est dans le magasin.
- Le code d'appairage reste dans le service pour la vie de l'application. Il n'est plus jamais regardé une fois `INSTALLED` à vrai, et il n'ouvre rien de toute façon : x-core a supprimé sa ligne à l'instant où il a été dépensé.
- Plusieurs workers : chacun appelle `await xcore.load()`, l'élu appelle `await xcore.start()`, et ils partagent un magasin `realtime.tickets` pour qu'un ticket frappé sur l'un soit dépensable sur l'autre. Voir [Faire tourner plusieurs processus](./multi-process.md).
- Le mot de passe de scellement est tiré au premier démarrage et gardé sous `SSO_SESSION_PASSWORD`. Supprimer cette clé déconnecte tout le monde d'un coup, et le démarrage suivant en tire une neuve.
- Lire `process.env` dans cette couche service, jamais dans la librairie.
