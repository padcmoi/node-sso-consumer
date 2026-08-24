# Intégration NestJS

> **Propriétaire de x-core.** Cette librairie parle les routes de x-core, son schéma HMAC, son catalogue de permissions et son protocole temps réel ; il n'en existe aucune autre implémentation. Voir [Installer une application](./install.md).

Le même bridge, câblé comme Nest câble les choses : un provider, un middleware pour les routes, un garde pour les deux portes, et un filtre pour les refus.

Rien ici n'est spécifique à Express - la librairie lit ce que Node lui tend, donc ceci fonctionne pareil sous la plateforme Fastify.

> **Elle remplace toute l'authentification locale, pas une partie.** Pas de table
> d'utilisateurs, pas de colonne mot de passe, pas de parcours de réinitialisation, pas
> de table de sessions, pas de table de permissions, pas de page de connexion. Le
> compte, le profil et les droits sont demandés à x-core à chaque requête et jamais mis
> en cache - c'est ce qui fait qu'une révocation ailleurs s'applique dès l'appel
> suivant. Le cookie porte l'id du compte et le couple de tokens, et rien d'autre. Voir
> [ce qu'elle remplace](../../../README.md#it-replaces-the-whole-local-authentication).

## 1) Le service

`src/sso/xcore.service.ts`

Une instance pour toute l'application : plusieurs ouvriraient chacune leurs propres sockets pour les mêmes comptes. L'instanciation est synchrone et n'atteint personne ; le démarrage est un hook de cycle de vie, ce qui permet de l'attendre et d'échouer à voix haute.

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
import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { settings } from "./settings";
import { accountStore } from "./account-store";

@Injectable()
export class XcoreService implements OnApplicationBootstrap, OnModuleDestroy {
  readonly bridge = createXcoreBridge({
    // ALLUMÉ, OU DOUBLURE. La première clé, parce qu'elle décide toutes les autres.
    //
    // À `false` il n'y a pas d'appairage, pas de déclaration et pas de socket - ET
    // CETTE LIBRAIRIE AUTHENTIFIE QUAND MÊME, contre les comptes prêtés sous
    // `di.local_accounts`. Elle ne s'écarte PAS : les gardes tiennent,
    // `requirePermissions` refuse un droit qui manque, et la session qui en sort a
    // exactement la forme que x-core répond.
    //
    // À `false` avec RIEN de prêté, toutes les portes SE FERMENT : pas de fournisseur
    // à qui demander et pas d'annuaire à lire signifie que personne ne peut jamais se
    // connecter. S'écarter est ce qui servait autrefois chaque page protégée à qui
    // demandait.
    //
    // CE N'EST PAS UN « MODE DEV », c'est un interrupteur, et c'est l'application qui
    // le calcule. Une machine de développement qui veut la vraie chaîne écrit
    // `mode: "sso"` et n'y revient plus.
    //
    // PASSÉE, PAS LUE : cette librairie ne lit aucun `process.env`. Un bundler fige de
    // toute façon cette valeur à la construction, donc lue de l'intérieur elle
    // porterait ce qui était vrai sur la machine qui a construit l'image.
    mode: NODE_ENV === "production" ? "sso" : "local",

    // UN x-core, nommé par son API AVEC son port, et la seule adresse que cette
    // application écrit elle-même. La fenêtre de connexion vit sur les mêmes noms sans
    // le port et répond 204 à tout ce qu'elle ne connaît pas - donc une application
    // pointée dessus se déclare « avec succès » à chaque démarrage alors que rien
    // n'existe en face. Le démarrage sonde l'adresse avant de lui déclarer quoi que ce
    // soit.
    //
    // Les trois autres adresses sont dérivées : la fenêtre de connexion est cet hôte
    // sans le port, la socket est un port plus loin, et le portail revient avec
    // l'appairage.
    provider: { baseUrl: "https://x-core.example.com:13001" },

    // Le jeton d'installation frappé sur la console, et la SEULE valeur qu'un
    // opérateur recopie de tout ce flux. Il reste ici pour la vie de l'application :
    // `INSTALLED` décide s'il est échangé, pas sa présence.
    installToken: "EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4",

    session: {
      // Pas de mot de passe et pas de nom : le premier est tiré au premier démarrage,
      // le second est dérivé de l'identité par x-core. Ce qui reste est la forme du
      // cookie.
      cookie: { secure: true, sameSite: "lax", maxAgeDays: 30 },
    },
    routes: { basePath: "/api/auth", afterLogin: "/" },
    realtime: { path: "/_ws/realtime" },
    live: { enabled: true },

    di: {
      // DEUX FONCTIONS, et l'instance HMAC ne traverse jamais. Cette librairie ne nomme
      // aucune méthode de `@naskot/node-hmac-auth-core` : elle connaît deux moments -
      // « donne-moi le hash courant », « range celui-ci » - et ton code sait comment.
      // Le jour où ce paquet renomme une méthode, ce qui casse est cette ligne-ci.
      //
      // UN HASH dans les deux sens. x-core range `hashClientSecret(secret, poivre)` et
      // vérifie contre ça, et le poivre ne circule jamais : une application qui
      // hacherait le secret brut elle-même signerait avec autre chose et récolterait un
      // 401 sur chaque appel. Ce qui signe est le hash que x-core a calculé, et il
      // arrive sur la file de propagation que cette librairie consomme pour toi.
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

  // `onApplicationBootstrap` et pas `onModuleInit` : tout ce dont la déclaration a
  // besoin - le magasin de credentials, son broker - est levé à ce moment-là.
  async onApplicationBootstrap() {
    // NE LÈVE JAMAIS : ce qu'il a fait revient sous forme de valeur. Dit à voix haute
    // ici, parce qu'une application qui a raté sa déclaration démarre parfaitement et
    // refuse ensuite toutes les connexions - l'échec qui coûte un après-midi à remonter.
    const started = await this.bridge.start();
    if (!started.ok) console.error(`[sso] ne sert pas (${started.status}) : ${started.reason}`);
  }

  onModuleDestroy() {
    this.bridge.close();
  }
}
```

| Ce qu'elle prête            | Reçoit                         | Rend          | Appelée quand                    |
| --------------------------- | ------------------------------ | ------------- | -------------------------------- |
| `environment.load()`        | rien                           | chaque clé    | au démarrage, en premier         |
| `environment.save(values)`  | les clés à écrire              | rien          | à l'appairage, et à une rotation |
| `onAccount(userId, me)`     | ce que le fournisseur a poussé | rien          | une permission change            |
| `onSignedOut(userId)`       | le compte                      | rien          | la session est terminée          |
| `errors(refusal, req, res)` | un refus déjà décidé           | rien, ou lève | à chaque refus                   |
| `local_accounts`            | -                              | une liste     | lue seulement à `mode: "local"`  |

`errors` est facultative et c'est là qu'un refus est PRONONCÉ. La librairie décide si et pourquoi - c'est la seule chose qui parle au fournisseur - et tend la conclusion entière : le statut, le code, la phrase, et l'adresse où envoyer un navigateur quand il y en a une. Réponds comme le framework veut, sur `res` ou en levant ; le throw voyage intact. Ne rien prêter et la librairie écrit la réponse simple elle-même.

`local_accounts` est un ANNUAIRE, pas une procédure : une liste de comptes, et pas de fonction de connexion à écrire. Voir [`mode`](../../../README.md#mode---x-core-answers-or-this-library-stands-in-for-it).

La signature n'est pas écrite ici non plus : cette librairie tient `@naskot/node-hmac-auth-core` en dépendance à elle et construit le transport signé elle-même, depuis le hash que `getCredential` rend. Il n'y a donc pas de seconde implémentation du protocole de ce côté pour diverger de celle qui vérifie en face, et aucun secret ne traverse la frontière - un hash est demandé, un hash est rangé.

Le hash est relu à CHAQUE appel plutôt que capturé au démarrage : le credential est remplacé par propagation, et un client fabriqué une fois signerait avec l'ancien jusqu'au prochain redémarrage - ce qui remonte en `401` sur tout, sans que rien ne nomme la cause.

`environment` tient vingt clés et cette librairie les écrit : `INSTALLED`, `SSO_SESSION_PASSWORD`, `SSO_SESSION_COOKIE_NAME`, `SSO_CLIENT_ID`, `SSO_REDIRECT_URI`, `SSO_CANCEL_URI`, `SSO_PORTAL_URL`, `SSO_FRONT_URL`, `SSO_TEMPLATE`, `SSO_DEPEND_GLOBAL_RESSOURCE`, `HMAC_AMQP_QUEUE`, `HMAC_PROPAGATION_SECRET`, `HMAC_AMQP_VHOST`, `HMAC_AMQP_BROKER_QUEUE`, `RABBITMQ_PROTOCOL`, `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` et `HMAC_PROPAGATION_CURSOR`. Cette dernière est l'endroit où en est la file de credentials, pour qu'une rotation redélivrée ne soit appliquée qu'une fois : une position plutôt qu'un réglage, et la seule clé ici dont x-core ne sait rien. Les valeurs sont du JSON, pas des chaînes - une barrière est une liste, un port est un nombre - et `save` est un UPSERT : elle écrit les clés qu'on lui donne et laisse les autres tranquilles.

`xcore.environment` rend le tout, pour ce que l'application en fait d'autre. Le broker n'en fait plus partie : **cette librairie ouvre la file de credentials elle-même**, avec `@naskot/node-hmac-auth-core-propagation` en dépendance à elle, et une application n'écrit aucun AMQP. Cette file n'est pas un confort : c'est par elle qu'une application appairée obtient une clé qui vérifie tout court, puisque le secret que l'appairage répond est haché par x-core avec un poivre qui ne circule jamais.

## 2) Le garde et son décorateur

`src/sso/xcore.guard.ts`

Un garde pour les deux portes : il résout la session, la pose sur la requête, puis vérifie ce que la route a demandé. Authentifier et autoriser ne peuvent pas se séparer, et rien ne vaut ouvert par défaut.

```ts
import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SsoError } from "@gestionpratique/node-sso-consumer";
import { XcoreService } from "./xcore.service";

export const PERMISSIONS = "sso:permissions";
/** Chaque action listée, ou l'appel est refusé. */
export const RequirePermissions = (...actions: string[]) => SetMetadata(PERMISSIONS, actions);

@Injectable()
export class XcoreGuard implements CanActivate {
  constructor(
    private readonly xcore: XcoreService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const resolved = await this.xcore.bridge.sessionOf(req, res);
    // UNAUTHORIZED plutôt qu'une redirection : le filtre plus bas décide ce qu'un
    // navigateur voit, et un XHR ne doit pas recevoir le HTML du portail.
    if (!resolved) throw new SsoError("UNAUTHORIZED", "No session");

    req.me = resolved.me;
    req.ssoTokens = resolved.tokens;
    req.ssoUserId = resolved.userId;

    const actions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS, [context.getHandler(), context.getClass()]);
    // Lève FORBIDDEN en nommant ce qui manque.
    if (actions?.length) this.xcore.bridge.assert(req, ...actions);
    return true;
  }
}
```

## 3) Le filtre

`src/sso/xcore.filter.ts`

La distinction qui compte : `FORBIDDEN` parle du COMPTE et ne doit pas être redirigé vers une connexion, ce qui bouclerait - se reconnecter ne change rien à ce qu'il détient. `UNAUTHORIZED` parle de la SESSION, qu'un aller-retour répare.

```ts
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import { SsoError } from "@gestionpratique/node-sso-consumer";
import { XcoreService } from "./xcore.service";

@Catch(SsoError)
export class XcoreExceptionFilter implements ExceptionFilter {
  constructor(private readonly xcore: XcoreService) {}

  catch(error: SsoError, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest();
    const res = host.switchToHttp().getResponse();

    if (error.code === "FORBIDDEN") return res.status(403).json({ error: error.message });
    if (error.code === "UNAUTHORIZED") {
      // Un XHR reçoit un statut sur lequel il peut agir ; une navigation reçoit le
      // portail, qui est la seule chose dans cet écosystème qui connecte un humain.
      const wantsJson = String(req.headers?.accept ?? "").includes("application/json");
      return wantsJson ? res.status(401).json({ error: "No session" }) : res.redirect(this.xcore.bridge.provider.portalUrl);
    }
    // NO_CREDENTIAL, NOT_XCORE, UNREACHABLE, MALFORMED_ANSWER, REFUSED : le problème de
    // cette application, et jamais celui du lecteur.
    res.status(503).json({ error: "The identity provider is unavailable" });
  }
}
```

## 4) Le module

`src/sso/xcore.module.ts`

Les six routes se montent en middleware - ce sont les handlers de la librairie, et le garde ne doit pas passer devant : `/sso/start` est là où un navigateur déconnecté est envoyé.

```ts
import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { HmacModule } from "../hmac/hmac.module";
import { XcoreService } from "./xcore.service";
import { XcoreGuard } from "./xcore.guard";
import { XcoreExceptionFilter } from "./xcore.filter";

@Module({
  imports: [HmacModule],
  providers: [XcoreService, XcoreGuard, { provide: APP_FILTER, useClass: XcoreExceptionFilter }],
  exports: [XcoreService, XcoreGuard],
})
export class XcoreModule implements NestModule {
  constructor(private readonly xcore: XcoreService) {}

  configure(consumer: MiddlewareConsumer) {
    // GET  /api/auth/sso/start       où pointe la carte du portail
    // GET  /api/auth/sso/callback    le code revient, scellé en session
    // POST /api/auth/sso/sign-in     ne répond QU'EN doublure, 404 sinon
    // POST /api/auth/logout          ferme la session de CETTE app, pas celle du SSO
    // GET  /api/auth/session         le compte, ses détails, ses droits
    // POST /api/auth/realtime-ticket ce avec quoi la page appelle la socket
    consumer.apply(this.xcore.bridge.middleware.routes()).forRoutes("*");
  }
}
```

## 5) Un contrôleur

```ts
import { Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
// Importé une fois n'importe où dans l'app, pour son effet : c'est ce qui pose `req.me`
// sur le type de requête, si bien que ce fichier le lit sans tendre la main vers `any`.
import "@gestionpratique/node-sso-consumer/express";
import { XcoreGuard, RequirePermissions } from "../sso/xcore.guard";
import { XcoreService } from "../sso/xcore.service";

@Controller("api/queues")
@UseGuards(XcoreGuard)
export class QueuesController {
  constructor(
    private readonly xcore: XcoreService,
    private readonly broker: BrokerService
  ) {}

  @Get()
  @RequirePermissions("view-queues")
  async list(@Req() req: Request) {
    return {
      data: await this.broker.list(),
      // Cache un bouton que l'API refuserait de toute façon. Cacher n'est pas
      // appliquer - le décorateur sur chaque route, si.
      can: { create: this.xcore.bridge.can(req, "create-queues") },
    };
  }

  @Post()
  @RequirePermissions("create-queues")
  async create(@Req() req: Request) {
    // Le garde l'a déjà résolu pour cette requête ; redemander serait un autre
    // aller-retour - et une autre rotation de token - pour la même réponse.
    return { data: await this.broker.create(req.body, { by: req.me?.user.email }) };
  }
}
```

## 6) La socket

`src/main.ts` - le bridge s'accroche sur le serveur HTTP sous-jacent, et rend la main pour chaque upgrade qui n'est pas la sienne, si bien que les passerelles propres à l'application peuvent le partager.

```ts
const app = await NestFactory.create(AppModule);
app.set("trust proxy", true);
await app.listen(3333);

app.get(XcoreService).bridge.realtime.attach(app.getHttpServer());
```

## 7) La page

La moitié navigateur est celle de la librairie aussi - voir [le guide Express](./express.md#5-la-page) pour `@gestionpratique/node-sso-consumer/client`, qui est le même fichier quel que soit ce qui le sert.

## 8) Notes de production

- Le relais doit ENVOYER `x-forwarded-for`, sinon chaque session est classée sous l'adresse de ce conteneur plutôt que celle du navigateur. Cette librairie le lit sur la requête brute elle-même, donc `trust proxy` est de l'hygiène Express plutôt qu'une nécessité pour elle - et il exige `NestFactory.create<NestExpressApplication>(AppModule)` pour être seulement appelable.
- `onApplicationBootstrap` plutôt qu'`onModuleInit` : tout ce dont la déclaration a besoin - le magasin de credentials, son broker - est levé à ce moment-là. Il lit le magasin, appaire seulement si `INSTALLED` n'est pas à vrai, et déclare.
- Le code d'appairage reste dans le provider pour la vie de l'application. Il n'est plus jamais regardé une fois `INSTALLED` à vrai, et il n'ouvre rien de toute façon : x-core a supprimé sa ligne à l'instant où il a été dépensé.
- Plusieurs workers demandent une élection et un magasin de tickets partagé : voir [Faire tourner plusieurs processus](./multi-process.md).
- Le mot de passe de scellement est tiré au premier démarrage et gardé sous `SSO_SESSION_PASSWORD`. Supprimer cette clé déconnecte tout le monde d'un coup, et le démarrage suivant en tire une neuve.
- Rien ne lit de `.env`, ni ici ni dans la librairie. Ce qu'un déploiement portait autrefois vit dans le magasin de l'application, écrit par l'appairage.
- Plusieurs workers : élire dehors. Chaque worker appelle `await bridge.load()`, seul l'élu appelle `await bridge.start()`.
