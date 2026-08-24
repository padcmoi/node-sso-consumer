# Le fichier de service

Un appel, un fichier. Tout ce que cette application est vis-à-vis de x-core, et tout ce qu'elle lui prête, tient dans `createXcoreBridge({ … })`. Il n'y a pas de second endroit : rien n'est relu ailleurs et rien n'est corrigé après coup par un autre fichier.

Deux moitiés :

- **ce que l'application décide** - l'adresse du fournisseur, où ses routes se montent, la forme de son cookie. Des valeurs, écrites en dur, pas des réglages, et aucune ne vient d'un `.env` ;
- **ce qu'elle prête**, sous `di`, et rien d'autre n'est de l'injection.

Ce que l'application **est** vis-à-vis du fournisseur n'est pas ici. Identité, URL de retour, URL d'annulation, template et barrière sont saisis sur la console de x-core, à l'étape « l'application » du formulaire qui frappe le jeton d'installation, et l'appairage les rapporte. Un seul endroit en décide, et ce n'est pas ce fichier.

**Une seule valeur se copie à la main**, depuis l'écran qui frappe le jeton, et elle se colle ici une fois pour la vie de l'application :

```ts
installToken: "EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4",
```

Un jeton appartient au x-core qui l'a frappé, et l'adresse de ce x-core est écrite juste au-dessus. Les deux vont ensemble : un déploiement qui change l'une change l'autre, et il n'existe aucun état où l'une désigne un fournisseur et l'autre un second.

**Il n'y a pas de `install()` à appeler.** Ce qui décide si l'installation a lieu n'est pas la présence du jeton mais la clé `INSTALLED` de `di.environment` : tant qu'elle ne vaut pas vrai le démarrage l'échange, et dès qu'elle vaut vrai le démarrage ne le regarde plus jamais. Le jeton n'est donc jamais dépensé deux fois, il n'y a rien à retirer d'une configuration après coup - le geste qu'on oublie - et rien à penser à appeler au bon démarrage.

**Rien ne vient d'un `.env`**, pas même le mot de passe qui scelle le cookie. Il vit sous `SSO_SESSION_PASSWORD` dans `di.environment`, tiré au premier démarrage et relu ensuite. Une variable d'environnement de moins est un secret de moins à poser sur un serveur, à faire suivre à un redéploiement, et à retrouver le jour où personne ne sait plus où il était.

`di` est courte, et c'est le fait principal de cette librairie : **elle ne persiste rien.** Pas de table, pas de migration, pas de schéma - une application qui l'installe n'en crée aucune. La session est un cookie scellé chez le lecteur ; le compte et les droits sont demandés à x-core à chaque requête et jamais mis en cache.

## Le fichier

```ts
import {
  createXcoreBridge,
  type SsoLogger,
  type StandInAccount,
  type XcoreAccountStore,
  type XcoreBridge,
  type XcoreSeenAccount,
} from "@gestionpratique/node-sso-consumer";

import { credentials } from "../hmac";
import { settings } from "../settings";
import { accountStore } from "../store";

export interface SsoDeps {
  logger?: SsoLogger;
}

/**
 * L'ACCÈS À L'ANNUAIRE LOCAL, lu seulement quand `mode` vaut `"local"`.
 *
 * QUATRE FONCTIONS sur la table où cette application garde ses comptes, et rien
 * au-dessus. La librairie décide qui entre, ce que répond un mauvais mot de passe et
 * ce qu'un enregistrement doit contenir ; celles-ci disent où sont les lignes. C'est
 * la règle que suivent déjà `di.hmac` et `di.environment`, dont aucune ne s'appelle
 * « tourner le credential ».
 *
 * C'était un TABLEAU écrit dans ce fichier, et c'était son plafond : un annuaire
 * écrit en littéral ne s'enrichit pas sans redéploiement, et un hash scrypt tapé dans
 * un fichier source n'est pas mieux protégé que le mot de passe en clair qu'il
 * remplace. Ce qui donne un sens au hash, c'est une table.
 *
 * LE MOT DE PASSE NE TRAVERSE JAMAIS CETTE LIGNE. `xcore.accounts.signUp({ ...,
 * password })` hache et passe un enregistrement à `create` ; `xcore.accounts.update(id,
 * { password })` fait pareil. Une application qui produirait le hash elle-même devrait
 * reproduire le format et les paramètres scrypt, et le jour où l'un des deux bouge
 * rien n'échoue bruyamment - tous les mots de passe deviennent faux d'un coup.
 *
 * Ce qu'un enregistrement porte est MINCE. La librairie complète le reste à la forme
 * exacte que x-core répond, donc un composant ne voit aucune différence :
 *
 *   `id`           dérivé de l'email s'il est absent, donc stable d'un démarrage à
 *                  l'autre - un cookie scellé hier s'ouvre demain. `accountIdOf` le
 *                  compose, pour un magasin qui écrit ses propres lignes
 *   `displayName`  « PRÉNOM NOM », comme x-core le compose
 *   `profile`      complet, avec ses `null` là où rien n'est connu
 *   `permissions`  namespacées si elles ne le sont pas déjà, plus le groupe
 *                  `_sso_user_<email>` qu'x-core crée pour chaque compte
 *   `isRoot`       passe tout, vérifié avant que la liste soit parcourue
 */
const accounts = {
  /** La lecture de connexion. L'adresse arrive déjà en minuscules. */
  findByEmail: (email: string) => accountStore.findByEmail(email),
  /** La relecture par requête, depuis l'id du cookie scellé. */
  findById: (id: string) => accountStore.findById(id),
  /** Écrit un enregistrement dont la librairie vient de produire le `passwordHash`. */
  create: (account: StandInAccount) => accountStore.insert(account),
  /** En modifie un. Un patch sans `passwordHash` laisse cette colonne tranquille. */
  update: (id: string, patch: Partial<StandInAccount>) => accountStore.patch(id, patch),

  /**
   * LES DEUX MODES, et le seul qui ait un sens sur x-core.
   *
   * Les lignes d'une application appartiennent à quelqu'un, et une clé étrangère ne
   * traverse pas deux bases - le compte vit dans celle de x-core. Ceci écrit donc la
   * ligne locale que pointe `factures.owner`, et rafraîchit ce qu'un écran affiche à
   * côté.
   *
   * Les permissions ne sont PAS passées et ne doivent pas être stockées : x-core les
   * recalcule à chaque `me`, et une copie est une seconde vérité qui périme en
   * silence.
   *
   * Appelée une fois par compte et par processus, puis de nouveau après une
   * déconnexion. Non attendue - une table lente ne doit pas transformer une bonne
   * session en refus.
   */
  seen: (account: XcoreSeenAccount) => accountStore.project(account),
} satisfies XcoreAccountStore;

export const createXcore = ({ logger }: SsoDeps): XcoreBridge =>
  createXcoreBridge({
    // ── QUI DÉCIDE QUI EST LÀ ────────────────────────────────────────────────
    //
    // À `true`, c'est x-core. Le jeton d'installation doit être valide et le
    // fournisseur joignable : sans ça rien de ce qui est derrière une garde n'est
    // servi. Jamais appairé, c'est un `500` - il n'y a même pas d'adresse de portail
    // où envoyer quelqu'un, puisqu'elle arrive AVEC l'appairage. Appairé mais refusé,
    // expiré, ou x-core injoignable, c'est un `401` et le portail.
    //
    // À `false` le SSO est éteint - ET LA LIBRAIRIE AUTHENTIFIE QUAND MÊME, contre les
    // comptes prêtés sous `di.accounts`. Elle ne s'écarte pas : les gardes
    // tiennent, `requirePermissions` refuse un droit qui manque, et la session qui en
    // sort a EXACTEMENT la forme de celle que x-core répond - `user`, un `profile`
    // complet, `permissions.global` namespacées, `isRoot`, les groupes, et
    // `permissions.portail` VIDE : une exigence est ce qu'un PORTAIL réclame avant de
    // laisser entrer, et en doublure il n'y a pas de portail. Tout le monde entre.
    //
    // C'est ce qui rend l'interrupteur honnête. Un écran développé hors ligne lit
    // `me.profile.city` et `can('read:user')` comme il les lira en production, et le
    // jour du branchement il n'y a qu'une ligne qui change.
    //
    // CE N'EST PAS UN « MODE DEV », c'est un interrupteur, et c'est l'application qui
    // le calcule. La ligne ci-dessous l'allume en production et l'éteint ailleurs
    // parce que c'est le cas courant. Rien n'y oblige : une machine de développement
    // qui veut justement la vraie chaîne - appairage réel, propagation réelle, une
    // révocation qui arrive vraiment par la socket - écrit `mode: "sso"` et n'y
    // revient plus.
    //
    // PASSÉE, PAS LUE, et c'est la règle de cette librairie plutôt qu'un détail : elle
    // ne lit aucun `process.env`. Un bundler remplace `process.env.NODE_ENV` par une
    // constante à la construction, donc une valeur lue depuis une librairie embarquée
    // porte ce qui était vrai sur la machine qui a construit l'image plutôt que ce qui
    // est vrai au démarrage. Cette ligne-ci est dans le build de l'application, qui sait.
    mode: process.env.NODE_ENV === "production" ? "sso" : "local",

    // ── OÙ ELLE APPELLE ──────────────────────────────────────────────────────
    //
    // `baseUrl` est l'API du fournisseur AVEC SON PORT, et rien d'autre : les chemins
    // sont ceux de la librairie, elle les compose elle-même.
    //
    // C'est la seule adresse qu'une application écrit elle-même, et il ne peut pas en
    // être autrement : tout le reste revient par l'appairage, mais on n'apprend pas où
    // joindre le fournisseur depuis le fournisseur.
    //
    // LE PORT EST LE PIÈGE. La fenêtre de connexion vit sur les mêmes noms sans port et
    // répond `204 No Content` à tout ce qu'elle ne connaît pas, appels non signés
    // compris - donc une application pointée dessus se déclare « avec succès » à chaque
    // démarrage et rien n'existe en face. `start()` refuse ça en prouvant l'adresse
    // d'abord.
    //
    // `frontUrl` est ÉNONCÉE plutôt que dérivée, et c'est une ceinture. Dérivée, c'est
    // « le même hôte sans le port », ce qui n'est juste que là où la fenêtre de
    // connexion n'a pas de nom à elle - et en production elle en a souvent un. x-core
    // la répond à l'appairage sous `SSO_FRONT_URL` et la valeur rangée gagne sur
    // celle-ci, donc cette ligne ne couvre que la fenêtre avant que ça n'atteigne tous
    // les déploiements. Une mauvaise devinette est un `502` à l'instant où un lecteur
    // clique, sur une application qui s'est appairée, déclarée et qui signe parfaitement.
    provider: {
      baseUrl: "https://x-core.example.test:13001",
      frontUrl: "https://x-sso.example.test",
    },

    // ── QUI EST CETTE APPLICATION : PAS ICI ──────────────────────────────────
    //
    // Pas de `clientId`, et c'est le point. L'identité SSO est décidée SUR LA CONSOLE
    // au moment où le jeton est frappé, et l'installation la rapporte. La librairie la
    // range par `di.environment.save` avec le reste et la relit par `load` à chaque
    // démarrage suivant.
    //
    // L'écrire en dur ici en ferait une seconde source : deux endroits qui décident du
    // même nom, et le jour où ils divergent l'application s'installe proprement puis
    // signe sous un nom qui n'est pas le sien - ce qui remonte en `401` sur tout, des
    // heures plus tard, sans que rien ne nomme la cause.
    //
    // Il n'y a donc pas de couple client_id / client_secret dans ce protocole : le
    // clientId HMAC EST l'identité.
    //
    // Il n'y a pas non plus de bloc `consumer`. Identité, URL de retour, URL
    // d'annulation, template et ressources requises sont saisis sur la console. Les
    // réécrire ici en ferait une seconde déclaration du même objet - et comme
    // `declare()` les renvoie à chaque démarrage, le jour où les deux divergent c'est
    // l'application qui gagnerait et écraserait en silence ce qu'un opérateur a réglé.
    installToken: "EXAMPLE_ONLY_yTgc9Qm2LbVx7Kd0Rf3PnW8sHjA6ZuE4",

    // ── LA SESSION QU'ELLE TIENT ─────────────────────────────────────────────
    //
    // Pas de mot de passe et pas de nom de cookie ici. Le premier est tiré au premier
    // démarrage - 32 octets, base64url - et rangé sous `SSO_SESSION_PASSWORD` ; le
    // second arrive sous `SSO_SESSION_COOKIE_NAME`, dérivé de l'identité par x-core,
    // donc `oauth-x-example` donne `sso_oauth_x_example`.
    //
    // Une application ne choisit pas le nom, et c'est ce qui rend une collision
    // impossible par construction : deux applications servies sous un même hôte
    // écriraient sinon toutes les deux `sso_session` et se déconnecteraient l'une
    // l'autre à chaque navigation, en silence, puisque du point de vue de chacune le
    // cookie est simplement absent.
    session: {
      cookie: {
        // `false` UNIQUEMENT là où l'on sert du HTTP nu : un cookie Secure y est jeté
        // par le navigateur, et ce qu'on lit alors est « déconnecté » à chaque
        // navigation, sans rien dans les journaux.
        secure: true,
        // `lax` et pas `strict` : le cookie doit survivre à la redirection de retour
        // de la fenêtre de connexion, qui est une navigation inter-sites.
        sameSite: "lax",
        // De l'hygiène de navigateur, pas un mécanisme de sécurité. Ce qui fait
        // vraiment expirer une session est la ligne côté x-core : un cookie qui lui
        // survit n'ouvre rien, puisque le fournisseur est interrogé à chaque requête.
        maxAgeDays: 30,
      },
    },

    // ── OÙ SES ROUTES SE MONTENT ─────────────────────────────────────────────
    //
    // `basePath` compte plus qu'un défaut ne compte d'habitude : la console de x-core
    // COMPOSE le callback qu'elle enregistre en `<adresse>/api/auth/sso/callback`, sans
    // champ offrant autre chose. Une application qui le déplace est déclarée à une
    // adresse et écoute à une autre.
    //
    // `loginPath` n'est lu QU'en `"local"` : en `"sso"` le portail est le seul
    // endroit où quelqu'un se connecte et cette librairie ne rend aucune page de
    // connexion.
    //
    // `signUp` OUVRE `<base>/sso/sign-up`, et c'est un opt-in à deux tours :
    // `"local"`, et cette ligne. Prêter `di.accounts.create` ne suffit délibérément
    // pas - une application peut le prêter pour un écran d'administration et ne rien
    // vouloir d'ouvert sur internet, et une route qui apparaîtrait dès que `create`
    // existe serait une inscription publique sur un déploiement dont l'auteur n'a
    // jamais lu cette ligne. Elle répond `201` avec le compte et le cookie, `409` sur
    // une adresse déjà prise, et `422` en dessous de huit caractères de mot de passe.
    routes: {
      basePath: "/api/auth",
      afterLogin: "/",
      loginPath: "/login",
      signUp: false,
    },

    // ── LE TEMPS RÉEL ────────────────────────────────────────────────────────

    realtime: {
      // Le chemin que le NAVIGATEUR appelle sur l'hôte de cette application - pas sur
      // le fournisseur. Comparé exactement, si bien que plusieurs bridges peuvent
      // partager un serveur HTTP.
      path: "/_ws/realtime",

      // Où attend un ticket de 30 secondes entre le moment où la page en demande un et
      // celui où la socket le dépense. EN MÉMOIRE PAR DÉFAUT, ce qui est juste pour UN
      // processus et un bug le jour où il y en a deux : un ticket frappé par un worker
      // doit être dépensable par l'autre, et un serveur de dev qui recharge entre la
      // frappe et l'appel le perd aussi. Prêter alors un magasin adossé à Redis - `put`
      // et `take`, où `take` lit ET supprime.
      //
      // tickets: redisTicketStore,
    },

    // ── SUIVRE LES COMPTES DEPUIS LE CÔTÉ SERVEUR ────────────────────────────
    //
    // `live` ouvre UNE socket par compte pour lequel ce processus tient une session, et
    // tend ce qui arrive à `di.onAccount` et `di.onSignedOut`. UN RELAIS, et rien qu'un
    // relais : AUCUN GARDE NE LIT DEDANS. Chaque lecture redemande au fournisseur.
    //
    // Le laisser ÉTEINT sauf si quelque chose ici doit l'entendre : un store à soi, un
    // cache dont la librairie ne sait rien, des navigateurs qu'on éventaille soi-même.
    // Sans aucun des deux rappels prêtés, chacune de ces sockets porte des frames vers
    // nulle part - une contre x-core par lecteur connecté, pour rien.
    live: { enabled: true },

    // ── TOUT CE QUI EST INJECTÉ, ET RIEN D'AUTRE ─────────────────────────────
    //
    // UNE clé, UN objet, et tout est dedans. Il est court, et c'est le fait principal
    // de cette librairie.
    //
    // Ce qu'il y a là-dedans n'est jamais une décision. C'est un magasin, un accès, un
    // annuaire, une façon de parler - la donnée ou la porte, jamais le choix.
    di: {
      // ── LE CREDENTIAL : DEUX FONCTIONS, ET L'INSTANCE RESTE DEHORS ────────
      //
      // Le magasin de credentials n'entre PAS dans la librairie. Il vit ici et est
      // capturé par les fermetures ci-dessous. La librairie ne le reçoit pas, ne le
      // tient pas, ne nomme aucune de ses méthodes.
      //
      // C'est ce qui rend la dépendance sans risque. Elle connaît trois moments -
      // « donne-moi le hash courant », « range celui-ci », « cette identité a disparu »
      // - et ton code sait comment. Le jour où le paquet de credentials renomme une
      // méthode, ce qui casse est ces trois lignes, dans ce fichier, corrigées sans
      // attendre de release ici.
      //
      // UN HASH, jamais un secret. La réponse de l'appairage porte bien un secret en
      // clair, et ce n'est pas lui qui signe : x-core range
      // `hashClientSecret(secret, poivre)` et vérifie contre ça, le poivre est le sien
      // et ne circule jamais. Une application qui hacherait le secret brut elle-même
      // signerait avec tout autre chose et récolterait un `401 BAD_SIGNATURE` sur
      // chaque appel en tenant pourtant le bon secret. Ce qui marche est le hash que
      // x-core a calculé, et il n'arrive que par la file de propagation - c'est
      // pourquoi cette file n'est pas un confort.
      hmac: {
        // RELU À CHAQUE APPEL SIGNÉ et jamais capturé : le credential est remplacé par
        // propagation, et un client fabriqué au démarrage signerait avec l'ancien
        // jusqu'au prochain redémarrage.
        getCredential: (clientId) => credentials.get(clientId),
        // Appelée à chaque rotation que la file porte.
        setCredential: (clientId, secretHash) => credentials.set(clientId, secretHash),
        // Facultative. Une application qui ne supprime jamais rien laisse simplement un
        // credential mort derrière elle, qui ne signe rien puisque l'autre bout le refuse.
        deleteCredential: (clientId) => credentials.remove(clientId),
      },

      // ── L'ÉTAGÈRE PROPRE À CETTE APPLICATION ─────────────────────────────
      //
      // Deux fonctions autour de clés dont les VALEURS SONT DU JSON. Pas des chaînes :
      // une barrière est une liste, un port est un nombre, `INSTALLED` est un booléen,
      // et les aplatir en texte rendrait chaque lecteur responsable de les déplier -
      // une convention de plus, non écrite, que le premier `split(",")` de travers casse.
      //
      // Les vingt clés sont listées plus bas, avec ce à quoi ressemble une vraie table.
      //
      // Rangées où l'application veut : une table clé/valeur, un coffre, un fichier. La
      // librairie ne sait pas et n'a pas à savoir.
      environment: {
        // TOUT, d'un coup, et appelée avant le reste. Quatre choses en sortent :
        // `INSTALLED`, qui décide s'il faut échanger le jeton ; `SSO_SESSION_PASSWORD`,
        // sans lequel aucun cookie ne s'ouvre ; `SSO_CLIENT_ID`, sans lequel la
        // librairie ne sait pas sous quel nom signer ; et la déclaration entière, que
        // `declare()` renvoie telle quelle.
        //
        // Pas de lecture par clé : ce serait vingt allers à chaque démarrage pour vingt
        // valeurs qui se lisent ensemble, et une qui échouerait laisserait une
        // application à moitié configurée sans que rien ne l'ait dit.
        //
        // Une clé jamais écrite est ABSENTE, pas `null`. C'est ce qui distingue
        // « jamais posée » de « posée à vide » - une barrière vide veut dire que cette
        // application ne filtre rien, et c'est une déclaration plutôt qu'une absence.
        load: () => settings.all(),

        // CRÉE OU MET À JOUR chaque clé donnée, et ne touche pas aux autres. Un upsert,
        // pas un remplacement.
        //
        // Atomique sur ce qu'on lui donne : l'appairage lui tend tout d'un coup,
        // `INSTALLED` compris, et c'est ce qui garantit qu'il n'existe aucun instant où
        // l'application se croit appairée sans tenir ce que cela annonce.
        save: (values) => settings.upsertAll(values),
      },

      // ── L'ANNUAIRE, QUAND CE N'EST PAS x-core QUI RÉPOND ─────────────────
      //
      // Lu UNIQUEMENT à `mode: "local"`. Allumée, cette clé n'est jamais regardée :
      // qui est là est la réponse de x-core et rien d'autre ne peut la donner.
      //
      // UNE LISTE, et rien de plus. Pas de `signIn` à écrire, pas de comparaison de mot
      // de passe, pas de formulaire : le login est le travail de la librairie,
      // exactement comme il l'est à `mode: "sso"`. Ce que l'application prête est
      // l'ANNUAIRE, jamais la procédure.
      //
      // Une fonction `signIn` prêtée à la place serait deux logins dans l'écosystème, un
      // vrai et un écrit à la main dans chaque application, et le second finit toujours
      // par s'écarter.
      //
      // `accounts` et pas `fakeAccounts` : ces comptes connectent vraiment
      // quelqu'un, tiennent vraiment une session et sont vraiment refusés quand un droit
      // manque. Ce qui change est d'où ils viennent, pas ce qu'ils valent.
      accounts,

      // ── COMMENT CETTE APPLICATION DIT « REFUSÉ » ─────────────────────────
      //
      // La librairie décide SI et POURQUOI - c'est la seule chose qui parle au
      // fournisseur, donc la seule qui le peut. Elle ne décide pas COMMENT, parce que ça
      // appartient au framework en dessous : Nitro veut une `H3Error` levée, Nest veut
      // une exception à lui, Express veut `next` avec quelque chose dessus.
      //
      // On lui tend la requête et la réponse brutes AVEC le refus, si bien qu'une seule
      // fonction répond à tous les cas : `403` et `500` en corps, et le `401` qui envoie
      // un navigateur au portail en redirection.
      //
      // FACULTATIVE. Ne rien prêter et la librairie écrit la réponse simple elle-même -
      // une redirection s'il y a un portail, du JSON sinon. Elle ne laisse jamais une
      // requête en suspens.
      //
      // `WebResponse` est volontairement étroite - `statusCode`, `getHeader`,
      // `setHeader`, `end` - parce que c'est tout ce que la réponse de Node garantit.
      // Pas de `writeHead`, pas de `res.json`, pas de `res.redirect` : ceux-là
      // appartiennent à un framework, et cette librairie tourne sous trois.
      errors: (refusal, _req, res) => {
        if (refusal.redirectTo) {
          res.statusCode = 302;
          res.setHeader("location", refusal.redirectTo);
          res.end();
          return;
        }
        res.statusCode = refusal.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: refusal.message, code: refusal.code }));
      },

      // ── CE QUE LE FOURNISSEUR A POUSSÉ ───────────────────────────────────
      //
      // Pour ce que cette application garde et que la librairie ne peut pas connaître :
      // son propre store, ses propres sockets, un cache à elle. Les lectures sont déjà
      // réactives sans ça. Appelés seulement si `live.enabled` vaut vrai.
      onAccount: (userId, me) => accountStore.replace(userId, me),
      onSignedOut: (userId) => accountStore.clear(userId),
    },

    // ── LE RESTE ─────────────────────────────────────────────────────────────

    logger,
    timeoutMs: 10_000,
    // Le fournisseur peut démarrer après cette application. Cinq tentatives à trois
    // secondes couvrent un `docker compose up` où les deux partent ensemble.
    retry: { attempts: 5, delayMs: 3_000 },
  });

export type Xcore = ReturnType<typeof createXcore>;
```

## Le démarrer, et l'arrêter

`start()` **ne lève jamais.** Chaque issue revient sous forme de valeur, parce qu'un démarrage qui mourrait parce qu'un jeton a été dépensé, parce que le broker n'était pas encore levé ou parce que le fournisseur démarrait encore emporterait toute l'application avec lui - y compris les pages qui n'ont rien à voir avec le SSO, et y compris ce qu'un opérateur utiliserait pour regarder le problème.

```ts
const xcore = createXcore({ logger: console });

const started = await xcore.start();
if (!started.ok) {
  // `withdrawn` | `ready` | `not-paired` | `not-declared`, et une phrase disant pourquoi.
  console.error(`[sso] ne sert pas (${started.status}) : ${started.reason}`);
}

// À l'arrêt. Un processus qui sort sans ça laisse un consumer enregistré sur le broker
// jusqu'à l'expiration de son battement, et le démarrage suivant en trouve deux.
await xcore.close();
```

## Ce qui est injecté, et rien d'autre

| Clé                                  | Reçoit                  | Rend                      | Appelée                                                 |
| ------------------------------------ | ----------------------- | ------------------------- | ------------------------------------------------------- |
| `hmac.getCredential(clientId)`       | une identité            | le hash courant           | avant chaque appel signé                                |
| `hmac.setCredential(clientId, hash)` | une identité et un hash | rien                      | à chaque credential reçu                                |
| `hmac.deleteCredential(clientId)`    | une identité            | rien                      | facultative, quand le fournisseur dit qu'elle a disparu |
| `environment.load()`                 | rien                    | `Record<string, unknown>` | à chaque démarrage, en premier                          |
| `environment.save(values)`           | les clés à écrire       | rien                      | à l'appairage, et à chaque rotation                     |
| `accounts`                           | une liste               | -                         | seulement à `mode: "local"`                             |
| `errors(refusal, req, res)`          | un refus déjà décidé    | rien, ou lève             | facultative, à chaque refus                             |
| `onAccount(userId, me)`              | un compte               | rien                      | facultative, quand `live` en pousse un                  |
| `onSignedOut(userId)`                | un id de compte         | rien                      | facultative, quand une session se termine               |

## Le magasin, sous forme de lignes en base

Vingt clés. Cinq viennent de ce qu'un opérateur a saisi sur la console, quatre plus cinq décrivent le broker, deux sont tirées localement, et une est la comptabilité propre à la librairie. **Rien ici n'est tapé à la main dans un `.env`** : l'appairage rapporte tout et `save` le pose là où l'application garde ses affaires.

L'exemple ci-dessous est une table `app_sso_settings` pour une application fictive `oauth-x-example`. La colonne `type` n'est pas décorative : la librairie tend des valeurs JavaScript et en reprend, donc une barrière est un tableau, un port est un nombre et `INSTALLED` est un booléen. Rangée en un blob opaque, cette forme ne survit qu'aussi longtemps que celui qui la lit pense à parser, et le premier lecteur qui n'y pense pas est un démarrage qui compare la chaîne `"false"` à `false` et les trouve différentes.

```sql
CREATE TABLE app_sso_settings (
  `key`        VARCHAR(191) NOT NULL PRIMARY KEY,
  `type`       ENUM('string','number','boolean','array','object','null') NOT NULL,
  `value`      TEXT NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
);
```

Une `string` est rangée BRUTE plutôt que guillemetée, pour que la table reste lisible par un humain avec un client SQL. Tout le reste est du JSON.

| `key`                         | `type`    | `value`                                                   | D'où ça vient                                                 |
| ----------------------------- | --------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `INSTALLED`                   | `boolean` | `true`                                                    | écrite par l'appairage, dans la même transaction que le reste |
| `SSO_SESSION_PASSWORD`        | `string`  | `EXAMPLE_ONLY_4pQvR7nZ2xKmT9wLbJ0sHdE6yUcA3fG`            | tirée localement au premier démarrage, jamais reçue           |
| `SSO_CLIENT_ID`               | `string`  | `oauth-x-example`                                         | la console                                                    |
| `SSO_SESSION_COOKIE_NAME`     | `string`  | `sso_oauth_x_example`                                     | dérivée de l'identité par x-core                              |
| `SSO_REDIRECT_URI`            | `string`  | `https://x-example.example.test/api/auth/sso/callback`    | la console                                                    |
| `SSO_CANCEL_URI`              | `string`  | `https://x-example.example.test/`                         | la console                                                    |
| `SSO_PORTAL_URL`              | `string`  | `https://portal.example.test/`                            | la console                                                    |
| `SSO_FRONT_URL`               | `string`  | `https://x-sso.example.test`                              | la console                                                    |
| `SSO_TEMPLATE`                | `string`  | `default`                                                 | la console                                                    |
| `SSO_DEPEND_GLOBAL_RESSOURCE` | `array`   | `["example"]`                                             | la console                                                    |
| `HMAC_AMQP_QUEUE`             | `string`  | `x-example-prod`                                          | l'appairage                                                   |
| `HMAC_AMQP_BROKER_QUEUE`      | `string`  | `hmac-x-example-prod.queue`                               | l'appairage                                                   |
| `HMAC_AMQP_VHOST`             | `string`  | `hmac-credentials`                                        | l'appairage                                                   |
| `HMAC_PROPAGATION_SECRET`     | `string`  | `EXAMPLE_ONLY_8b41d0c7ae52f39d6410bc27ff85ea93`           | l'appairage                                                   |
| `RABBITMQ_PROTOCOL`           | `string`  | `amqps`                                                   | l'appairage                                                   |
| `RABBITMQ_HOST`               | `string`  | `x-amqp.example.test`                                     | l'appairage                                                   |
| `RABBITMQ_PORT`               | `number`  | `5671`                                                    | l'appairage                                                   |
| `RABBITMQ_USER`               | `string`  | `x_example_prod`                                          | l'appairage                                                   |
| `RABBITMQ_PASSWORD`           | `string`  | `EXAMPLE_ONLY_Wq7ZvKm2TnRb9LdXsH0yJcE4`                   | l'appairage, en clair et une seule fois                       |
| `HMAC_PROPAGATION_CURSOR:…`   | `object`  | `{"ts":"1787555108907","eventId":"46b6af1b-f8f6-46e2-…"}` | la librairie, à chaque événement appliqué                     |

> Les valeurs ci-dessus sont inventées. Ne les copie pas : `SSO_SESSION_PASSWORD`,
> `HMAC_PROPAGATION_SECRET` et `RABBITMQ_PASSWORD` sont des secrets, et le premier est
> tiré par la librairie elle-même plutôt qu'écrit par qui que ce soit.

Trois d'entre elles méritent une phrase chacune.

**`SSO_SESSION_PASSWORD` est tiré ici, jamais reçu.** Deux applications qui le partageraient pourraient ouvrir les cookies l'une de l'autre, alors que chacune détient sa propre ligne révocable chez le fournisseur. Supprimer la clé est la façon pour un opérateur de déconnecter tout le monde d'un coup - chaque cookie existant cesse de s'ouvrir - et le démarrage suivant en tire un neuf. C'est un outil, pas une panne.

**`SSO_DEPEND_GLOBAL_RESSOURCE` est un tableau, vide ou non.** Un champ optionnel n'est écrit que s'il est fourni, donc l'omettre pourrait poser une barrière et ne jamais en retirer une. Sa première entrée est aussi ce qui nomme la ressource ACL globale que cette application **est**, ce qui permet à `actions()` de savoir quel préfixe retirer.

**`HMAC_PROPAGATION_CURSOR` est la seule clé dont x-core ne sait rien.** C'est une position plutôt qu'un réglage, écrite par la librairie pour qu'une rotation redélivrée ne soit appliquée qu'une fois, et elle porte un suffixe nommant le flux qu'elle suit - c'est pourquoi une vraie table montre une ligne par cible de propagation plutôt qu'une seule.

## L'installation, sans méthode à appeler

`INSTALLED` est ce qui remplace `install(code)`. Le démarrage lit `di.environment`, regarde cette clé, et décide :

| `INSTALLED`         | Ce que fait le démarrage                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| absente, ou `false` | échange `installToken`, range tout avec `INSTALLED: true`, ouvre la file, déclare |
| `true`              | ne regarde même pas le jeton : ouvre la file et déclare                           |

Deux choses en découlent, et ce sont les deux qui rendaient l'ancienne forme fragile.

Le jeton **reste dans la configuration.** Il n'y a rien à retirer après le premier démarrage, donc rien à oublier de retirer. Et comme il n'est plus lu une fois `INSTALLED` à vrai, un déploiement qui le garde ne le dépense pas une seconde fois.

L'état est **écrit**, pas déduit. Demander « est-ce déjà installé ? » revenait à chercher un credential qui traînait dans le magasin, ce qui est une preuve indirecte : un credential arrivé par propagation, sans installation derrière, répondait « oui » à une question qu'on ne lui posait pas.

`INSTALLED` est écrit dans le **même `save`** que tout le reste et jamais avant. Écrit en premier, un démarrage qui tomberait entre les deux se croirait appairé sans rien détenir de ce que cela annonce - et ne réessaierait jamais, puisqu'il ne regarde plus le jeton.

**Rien n'est créé par l'échange du jeton.** La queue, le compte broker, le consumer SSO et le credential HMAC ont tous été construits au moment où il a été FRAPPÉ, sur la console, devant celui qui l'a frappé. L'échange les collecte et x-core supprime sa ligne dans le même souffle. Un démarrage trouve sa réservation qui attend, ou ne trouve rien du tout, et jamais la moitié.

## Le broker, et pourquoi il n'apparaît nulle part ci-dessus

Il n'apparaît nulle part **parce que cette librairie le tient.** Elle prend `@naskot/node-hmac-auth-core-propagation` en dépendance à elle, ouvre la connexion, consomme la file et acquitte. Une application qui l'installe n'écrit pas une ligne d'AMQP et n'ajoute pas de second paquet à son `package.json`.

Elle est déjà la seule à tenir les neuf valeurs dont cette connexion a besoin - `HMAC_AMQP_QUEUE`, `HMAC_PROPAGATION_SECRET`, `HMAC_AMQP_VHOST`, `HMAC_AMQP_BROKER_QUEUE` et les cinq `RABBITMQ_*` - puisque l'appairage les a rapportées et que `load` les rend à chaque démarrage.

**Aucune variable d'environnement n'est ajoutée.** Pas une : tout vient de l'appairage, et rien de ce qui concerne le broker n'est écrit dans une configuration. L'adresse du broker en particulier vient de là plutôt que d'une constante quelque part, parce qu'elle appartient à l'infrastructure et bouge avec elle. Une application qui en tiendrait une copie continuerait de composer l'ancienne longtemps après que tout le monde a déménagé.

Toutes les routes consommées exigent la signature, sauf une : l'échange d'installation, qui est précisément ce qui rend le credential avec lequel on signerait.

L'ordre en découle : `load` est appelée **avant** le premier appel signé, puisque c'est elle qui rend l'identité sous laquelle signer.
