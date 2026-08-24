# Intégration Nuxt 4, sur l'API serveur Nitro

> **Propriétaire de x-core.** Cette librairie parle les routes de x-core, son schéma HMAC, son catalogue de permissions et son protocole temps réel ; il n'en existe aucune autre implémentation. Voir [Installer une application](./install.md).

Nitro est là où la forme de cette librairie paie : il n'y a pas d'`app.use(middleware)` ici, pas de middleware d'erreur et pas de chaîne. Ce qu'il y a à la place est un dossier `server/` de handlers, un plugin avec le serveur HTTP brut, et `event.node.req` / `event.node.res` - c'est-à-dire exactement ce que la librairie lit et écrit.

Cinq fichiers. Rien du SSO ne vit en dehors d'eux.

> **Elle remplace toute l'authentification locale, pas une partie.** Pas de table
> d'utilisateurs, pas de colonne mot de passe, pas de parcours de réinitialisation, pas
> de table de sessions, pas de table de permissions, pas de page de connexion. Le
> compte, le profil et les droits sont demandés à x-core à chaque requête et jamais mis
> en cache - c'est ce qui fait qu'une révocation ailleurs s'applique dès l'appel
> suivant. Le cookie porte l'id du compte et le couple de tokens, et rien d'autre. Voir
> [ce qu'elle remplace](../../../README.md#it-replaces-the-whole-local-authentication).

## 1) Le service

`server/utils/xcore.ts`

Sous `server/utils/`, pour que Nitro l'auto-importe et que chaque handler atteigne la même instance. Construite une fois au niveau du module : plusieurs instances ouvriraient chacune leurs propres sockets pour les mêmes comptes.

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
  // `di.accounts`. Elle ne s'écarte PAS : les gardes tiennent,
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
| `accounts`                  | -                              | une liste     | lue seulement à `mode: "local"`  |

`errors` est facultative et c'est là qu'un refus est PRONONCÉ. La librairie décide si et pourquoi - c'est la seule chose qui parle au fournisseur - et tend la conclusion entière : le statut, le code, la phrase, et l'adresse où envoyer un navigateur quand il y en a une. Réponds comme le framework veut, sur `res` ou en levant ; le throw voyage intact. Ne rien prêter et la librairie écrit la réponse simple elle-même.

`accounts` est l'ACCÈS à un annuaire, pas une procédure : quatre fonctions sur la table où l'application garde ses comptes, et pas de fonction de connexion à écrire. Voir [`mode`](../../../README.md#mode---x-core-answers-or-this-library-stands-in-for-it).

La signature n'est pas écrite ici non plus : cette librairie tient `@naskot/node-hmac-auth-core` en dépendance à elle et construit le transport signé elle-même, depuis le hash que `getCredential` rend. Il n'y a donc pas de seconde implémentation du protocole de ce côté pour diverger de celle qui vérifie en face, et aucun secret ne traverse la frontière - un hash est demandé, un hash est rangé.

Le hash est relu à CHAQUE appel plutôt que capturé au démarrage : le credential est remplacé par propagation, et un client fabriqué une fois signerait avec l'ancien jusqu'au prochain redémarrage - ce qui remonte en `401` sur tout, sans que rien ne nomme la cause.

`environment` tient vingt clés et cette librairie les écrit : `INSTALLED`, `SSO_SESSION_PASSWORD`, `SSO_SESSION_COOKIE_NAME`, `SSO_CLIENT_ID`, `SSO_REDIRECT_URI`, `SSO_CANCEL_URI`, `SSO_PORTAL_URL`, `SSO_FRONT_URL`, `SSO_TEMPLATE`, `SSO_DEPEND_GLOBAL_RESSOURCE`, `HMAC_AMQP_QUEUE`, `HMAC_PROPAGATION_SECRET`, `HMAC_AMQP_VHOST`, `HMAC_AMQP_BROKER_QUEUE`, `RABBITMQ_PROTOCOL`, `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` et `HMAC_PROPAGATION_CURSOR`. Cette dernière est l'endroit où en est la file de credentials, pour qu'une rotation redélivrée ne soit appliquée qu'une fois : une position plutôt qu'un réglage, et la seule clé ici dont x-core ne sait rien. Les valeurs sont du JSON, pas des chaînes - une barrière est une liste, un port est un nombre - et `save` est un UPSERT : elle écrit les clés qu'on lui donne et laisse les autres tranquilles.

`xcore.environment` rend le tout, pour ce que l'application en fait d'autre. Le broker n'en fait plus partie : **cette librairie ouvre la file de credentials elle-même**, avec `@naskot/node-hmac-auth-core-propagation` en dépendance à elle, et une application n'écrit aucun AMQP. Cette file n'est pas un confort : c'est par elle qu'une application appairée obtient une clé qui vérifie tout court, puisque le secret que l'appairage répond est haché par x-core avec un poivre qui ne circule jamais.

## 2) Les routes

`server/middleware/sso.ts`

Le middleware Nitro s'exécute avant chaque handler et passe la main quand il ne répond rien - ce qui est exactement ce que fait `routes()`. Les deux sont la même idée, donc l'adaptateur fait quatre lignes.

```ts
export default defineEventHandler(async (event) => {
  const { req, res } = event.node;

  // `routes()` prend un `next`, et ici il n'y en a pas : ce que Nitro veut, c'est que
  // le handler rende la main. Donc `next` résout une promesse, et rendre la main
  // ensuite veut dire « ce n'était pas une de mes routes ».
  await new Promise<void>((resolve, reject) => {
    void xcore.middleware.routes()(req, res, (error) => (error ? reject(error) : resolve()));
  });

  // Répondu par la librairie : rien d'autre ne s'exécute pour cette requête.
  if (res.writableEnded) return;
});
```

## 3) Le garde

`server/utils/session.ts`

Il n'y a pas de middleware `requireSession()` à monter ici, et ce serait de toute façon la mauvaise forme : une application Nuxt sert des pages et une API depuis la même origine, et rediriger un XHR vers le portail tend à un composant une page de HTML là où il attendait du JSON. Le garde est donc une fonction que chaque handler appelle, et il lève ce que Nitro sait déjà répondre.

```ts
import type { H3Event } from "h3";

/** Le compte, ou un 401 que la page d'erreur de l'app transforme en connexion. */
export const requireSession = async (event: H3Event) => {
  const me = await xcore.session(event.node.req, event.node.res);
  if (!me) throw createError({ statusCode: 401, statusMessage: "No session" });
  return me;
};

/**
 * Le même, plus les actions. Refuse avec un 403 en nommant ce qui manque.
 *
 * Un 403 n'est jamais une redirection vers une connexion : le compte EST connecté, il
 * ne détient simplement pas le droit, et l'envoyer se reconnecter boucle sans rien
 * changer.
 */
export const requirePermissions = async (event: H3Event, ...actions: string[]) => {
  const me = await requireSession(event);
  const missing = actions.filter((action) => !xcore.auth.can(me.permissions, action));
  if (missing.length) {
    throw createError({
      statusCode: 403,
      statusMessage: `Missing ${missing.map((action) => xcore.auth.permissions.permission(action)).join(", ")}`,
    });
  }
  return me;
};
```

Utilisé comme n'importe quel autre handler Nitro lit son entrée :

```ts
// server/api/queues/index.get.ts
export default defineEventHandler(async (event) => {
  const me = await requirePermissions(event, "view-queues");

  return {
    data: await listQueues(),
    // Cache un bouton que l'API refuserait de toute façon. Cacher n'est pas appliquer -
    // la ligne au-dessus, si.
    can: { delete: xcore.auth.can(me.permissions, "delete-queues") },
  };
});
```

```ts
// server/api/queues/[name].delete.ts
export default defineEventHandler(async (event) => {
  await requirePermissions(event, "delete-queues");
  await removeQueue(getRouterParam(event, "name"));
  setResponseStatus(event, 204);
});
```

## 4) La socket et le démarrage

`server/plugins/sso.ts`

Un plugin Nitro est là où le démarrage a sa place : attendu avant que quoi que ce soit ne soit servi. C'est aussi ce qui est le plus proche du serveur HTTP brut, sur lequel le bridge realtime s'accroche - quoique pas directement, et ça vaut un paragraphe.

**Nitro n'a aucun hook d'exécution qui remette le serveur.** `listen` appartient à l'instance de BUILD et un plugin tourne dans celle qui a été construite, donc il n'y a rien à accrocher. Ce qui est joignable est le serveur derrière la première requête qui arrive - `event.node.req.socket.server` - et le bridge y est accroché, une fois. Node pose cette propriété sur chaque socket qu'un serveur a acceptée et ne la déclare pas dans ses propres types, donc c'est le seul endroit où une intégration lit défensivement plutôt qu'avec l'aide du compilateur.

Accroché **une fois**, et le drapeau n'est pas une micro-optimisation : un second écouteur `upgrade` sur le même chemin signifie deux gestionnaires répondant à un upgrade, le second `handleUpgrade` levant depuis une promesse que personne ne peut attraper, et ce rejet non géré est le worker perdu et redémarré aussi longtemps que quelqu'un ouvre cette page.

```ts
export default defineNitroPlugin(async (nitro) => {
  // Lit le magasin, appaire si `INSTALLED` le dit, ouvre la file de credentials,
  // déclare. Il NE LÈVE JAMAIS : ce qu'il a fait revient sous forme de valeur et est dit
  // dans le journal. Un démarrage qui mourrait sur un jeton dépensé emporterait toute
  // l'application avec lui.
  const started = await xcore.start();
  if (!started.ok) console.error(`[app] le SSO ne sert pas (${started.status}) : ${started.reason}`);

  let hung = false;
  nitro.hooks.hook("request", (event) => {
    if (hung) return;
    // Node pose `server` sur chaque socket qu'un serveur a acceptée et ne la type pas.
    const socket = event.node.req.socket as unknown as {
      server?: Parameters<typeof xcore.realtime.attach>[0];
    };
    if (!socket.server) return;

    hung = true;
    // Le bridge rend la main pour chaque upgrade qui n'est pas la sienne, si bien que la
    // socket HMR de Nuxt en dev est intacte, et son chemin est comparé EXACTEMENT.
    xcore.realtime.attach(socket.server);
  });

  nitro.hooks.hook("close", () => xcore.close());
});
```

En dev, Nitro recharge le serveur à chaque changement : tendre un magasin de tickets partagé, ou un ticket frappé une seconde avant un rechargement a disparu au moment où la socket arrive. Voir [Faire tourner plusieurs processus](./multi-process.md).

## 5) La page

`app/composables/useSso.ts` - la moitié navigateur, qui est aussi celle de la librairie.

```ts
import { createSsoClient, type SsoBrowserClient } from "@gestionpratique/node-sso-consumer/client";
import type { SsoMe } from "@gestionpratique/node-sso-consumer";

const account = ref<SsoMe | null>(null);
const connected = ref(false);
let client: SsoBrowserClient | null = null;

export const useSso = () => {
  onMounted(async () => {
    // Le client appelle une socket et lit un cookie : les deux sont l'affaire d'un
    // navigateur, donc rien ici ne tourne pendant le SSR.
    if (client) return;
    client = createSsoClient({
      basePath: "/api/auth",
      // Poussé, pas interrogé - et RIEN ici n'est interrogé en boucle : ce client
      // demande la session une fois, un ticket par socket, et une déconnexion sur un
      // clic. Tout le reste arrive sur la socket, ce à quoi sert une socket.
      onAccount: (me) => (account.value = me),
      // La session SSO a disparu, l'accès de cette application a été retiré, ou la
      // session a été terminée depuis l'écran des connexions du portail. Les trois
      // finissent ici.
      onSignedOut: () => {
        account.value = null;
        location.assign("https://portal.example.com/");
      },
      onConnectionChange: (up) => (connected.value = up),
    });

    if (!(await client.connect())) location.assign("/api/auth/sso/start");
  });

  onScopeDispose(() => {
    client?.close();
    client = null;
  });

  return {
    account: readonly(account),
    connected: readonly(connected),
    /** Cache un bouton que l'API refuserait de toute façon. Le serveur décide, toujours. */
    can: (permission: string) => Boolean(client?.can(permission)),
    logout: () => client?.logout(),
  };
};
```

Et une page le lit comme n'importe quoi d'autre :

```vue
<script setup lang="ts">
const { account, can, connected } = useSso();
</script>

<template>
  <header>
    <span>{{ account?.user.displayName }}</span>
    <span :class="{ live: connected }" />
  </header>
  <!-- Redessiné tout seul à l'instant où le droit est révoqué, sans rechargement. -->
  <button v-if="can('console:delete-queues')">Supprimer</button>
</template>
```

## 6) Notes de production

- La librairie ne tourne jamais pendant le SSR : `xcore` est un module `server/` et la moitié client est derrière `onMounted`. Importer l'un ou l'autre dans un composant est ce qui casse un build.
- Le relais doit ENVOYER `x-forwarded-for`, sinon chaque session est classée sous l'adresse de ce conteneur - ce que l'écran des sessions du portail montre ensuite. Cette librairie lit cet en-tête sur `event.node.req` elle-même, donc il n'y a rien à configurer dans Nitro.
- `await xcore.start()` dans le plugin, avant que quoi que ce soit ne soit servi, et le laisser là. Il lit le magasin, n'appaire que si `INSTALLED` n'est pas à vrai, et déclare. Le code d'appairage reste dans le fichier pour la vie de l'application : il n'est plus jamais regardé une fois la clé posée.
- Le dev recharge le serveur à chaque changement : tendre un magasin `realtime.tickets` partagé, ou la socket ne peut pas se reconnecter après un rechargement.
- Le mot de passe de scellement est tiré au premier démarrage et gardé sous `SSO_SESSION_PASSWORD`. Supprimer cette clé déconnecte tout le monde d'un coup, et le démarrage suivant en tire une neuve - ce qui est un outil, pas une panne.
- Rien ne lit de `.env`, ni ici ni dans la librairie. Ce qu'un déploiement portait autrefois - l'identité, le callback, la barrière, les credentials du broker, le mot de passe de scellement - vit dans le magasin de l'application, écrit par l'appairage.
- Plusieurs workers : élire dehors, dans le déploiement. Chaque worker appelle `await xcore.load()`, et seul l'élu appelle `await xcore.start()` - cette librairie ne sait rien de PM2 ni du nombre de processus.
