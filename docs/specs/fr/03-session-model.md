# La session vit dans x-core

La règle que toute cette librairie existe pour faire respecter, en une ligne :

> **L'application ne tient rien.** Un cookie scellé portant un couple de tokens émis par x-core, et c'est tout l'état local d'un lecteur connecté.

Pas de table d'utilisateurs, pas de table de sessions, pas de table de permissions, pas de colonne mot de passe, pas de parcours de réinitialisation, pas de page de connexion, pas de cache. Pas « le moins possible » : aucun.

## Pourquoi il n'y a rien à garder

Deux garanties découlent du fait de ne rien tenir, et aucune ne survit à une copie locale.

**Une révocation s'applique à l'appel suivant.** Le compte, le profil et les droits sont demandés à x-core à chaque requête, si bien qu'un compte déconnecté au portail, désactivé, ou privé de son accès à cette application cesse d'être répondu ici immédiatement. Une ligne de session locale ne peut pas faire ça : elle serait encore valide, et l'honorer est précisément l'accès forcé que ce modèle ferme. Il n'y a rien à invalider et aucun webhook à exposer.

**Rien de personnel n'existe pour dériver ou pour survivre à une suppression.** Un email changé dans une autre application est déjà la valeur que la prochaine lecture répond. Une copie serait une seconde vérité, et la seconde vérité gagne toujours par accident.

## Le cookie

L'unique artefact local. Ce qu'il porte :

```jsonc
{
  "userId": "00000000-0000-4000-8000-000000000001",
  "tokens": {
    "accessToken": "…",
    "accessTokenExpiresAt": "…",
    "refreshToken": "…",
    "refreshTokenExpiresAt": "…",
  },
}
```

L'id du compte est là pour qu'une requête sache de qui est la session sans aller-retour ; tout le reste sur la personne vient de `GET /sso/me`.

Ce qui n'y est **jamais** : un email, un nom, une adresse, une permission, un rôle, un avatar, un id de session locale, un refresh token local, une expiration propre à l'application.

### Son nom appartient à x-core

```
sso_${clientId.replace(/[^A-Za-z0-9]/g, "_")}
```

`oauth-x-facturation` devient `sso_oauth_x_facturation`. Des underscores partout, rien d'autre, parce qu'un nom de cookie est un token RFC 6265 où un tiret serait légal mais où la moitié de l'écosystème écrit déjà ces noms avec des underscores, et un nom orthographié de deux façons est la différence que personne ne remarque jusqu'à ce qu'une session soit lue dans le mauvais bocal.

Il est **dérivé de l'identité, et répondu par x-core plutôt que deviné de ce côté**. Deux applications servies sous un même hôte écriraient sinon toutes les deux le même nom et se déconnecteraient l'une l'autre à chaque navigation, en silence, puisque du point de vue de chacune le cookie est simplement absent.

### Son scellement appartient à l'application

AES-256-GCM, sur une enveloppe `{ id, createdAt, data }`, avec un mot de passe qui est celui de l'application et ne vient de nulle part ailleurs. Il est tiré au premier démarrage et gardé dans le magasin clé/valeur de l'application, jamais reçu de x-core : deux applications qui le partageraient pourraient ouvrir les cookies l'une de l'autre, alors que chacune détient déjà sa propre session révocable là-bas. Supprimer la clé déconnecte tout le monde d'un coup et le démarrage suivant en tire une neuve, ce qui est un outil plutôt qu'une panne.

Un cookie qui ne se descelle pas est un cookie d'un autre mot de passe ou d'un autre processus. Il se lit comme « pas de session », jamais comme une erreur, parce que c'est ce qu'il signifie pour qui le détient.

### Ses drapeaux

```
httpOnly   la page ne doit jamais lire le couple
secure     production seulement : un cookie Secure est jeté sur le HTTP nu du dev
sameSite   lax, pour qu'il survive à la redirection de retour du SSO
path       /
ttl        aucun sur le scellement
```

**Pas de ttl, volontairement.** x-core fait expirer la session, pas le cookie. Un cookie portant un couple dont x-core a fini n'ouvre rien, et une expiration propre à l'application serait une seconde horloge pour contredire la première.

## Ce qui est donné à la page du lecteur

La réponse de `GET /sso/me`, c'est-à-dire [session.json](session.json) : le compte sous `user`, le profil civil, les permissions avec leurs groupes, et les champs du compte aplatis à la racine pour qu'un composant lise `displayName` sans traverser une enveloppe.

```jsonc
{
  "user":        { "id": "…", "email": "…", "displayName": "…", "avatarUrl": "…", "hasPassword": true },
  "profile":     { "gender": "mr", "firstname": "…", "city": "…", … },
  "permissions": { "global": ["core:access", …], "isRoot": true, "groups": [ … ] },
  "id": "…", "email": "…", "displayName": "…", "avatarUrl": "…"
}
```

**Le couple de tokens n'y est pas et ne doit jamais y être.** Un refresh token est un mot de passe qui vit un mois, et tout ce qu'une page peut lire, tout ce qui tourne sur cette page peut le prendre. La socket est ouverte avec un ticket plutôt qu'avec un credential précisément pour que la page n'ait jamais à en détenir un.

La page garde cette valeur le temps d'un chargement, alimentée ensuite par la socket ([02-protocol-realtime.md](02-protocol-realtime.md)). Elle n'est pas persistée : un store écrit dans `localStorage` serait une session qui survit à celle qu'elle reflète, ce que ce modèle interdit.

## La seule chose qu'une application possède encore

Ses propres données, et qui peut toucher quelle ligne. La barrière déclarée à x-core dit qui peut entrer tout court ; savoir si ce lecteur peut éditer cette facture est l'affaire de l'application, et l'a toujours été.
