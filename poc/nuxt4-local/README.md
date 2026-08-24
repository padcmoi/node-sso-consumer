# POC Nuxt 4 - le mode `local`

Le seul POC **sans fournisseur**. Rien n'est appairé, rien n'est déclaré, aucun courtier
n'est ouvert et aucune socket n'est composée. La librairie répond « qui est-ce » contre un
annuaire prêté, et tout le reste ne change pas.

C'est ça qu'il prouve. Ce n'est pas un mode dégradé :

- la session est réelle, scellée dans le même cookie avec le mot de passe que la librairie
  a tiré et rangé
- le compte est **relu à chaque requête**, exactement comme il est demandé à x-core
- les gardes refusent pareil : un droit manquant est un `403`
- le compte rendu a la forme exacte que `/sso/me` répond, `profile` complet avec ses
  `null`, permissions namespacées, groupe `_sso_user_<email>`

Une page qui lit `me.profile.city` et `can('read:note')` ici les lit de la même façon en
production. C'est ce qui fait de `mode` un mode et pas une migration.

## Démarrer

```
pnpm prod:up      # docker compose up -d --build
pnpm prod:logs    # les logs de l'app
pnpm prod:down    # arrêter
pnpm prod:reset   # arrêter ET supprimer le volume de la base
```

| | adresse |
| --- | --- |
| l'application | http://127.0.0.1:7020 |
| phpMyAdmin | http://127.0.0.1:7021 |

Les deux comptes prêtés :

| adresse | mot de passe | droits |
| --- | --- | --- |
| `julien@example.test` | `julien` | `read:note` |
| `admin@example.test` | `admin` | aucun, mais `isRoot` |

Les mots de passe ne sont pas stockés ainsi. L'annuaire porte un `passwordHash` scrypt,
produit par `hashPassword` de la librairie et jamais écrit à la main :

```ts
import { hashPassword } from '@gestionpratique/node-sso-consumer'
console.log(await hashPassword('julien'))
```

Les paramètres voyagent dans le hash - `scrypt$N$r$p$sel$clé` - donc un enregistrement
écrit aujourd'hui reste vérifiable après qu'on les ait montés.

## Ce qu'il y a en base, et ce qu'il n'y a pas

Deux tables, et aucune n'est une session.

| table | ce qu'elle porte |
| --- | --- |
| `app_settings` | le mot de passe qui scelle le cookie, et le nom du cookie. **Deux lignes** |
| `notes` | les données de cette application, la seule chose qu'elle ait jamais possédée |

Il n'y a **pas** de table de comptes ni de colonne de mot de passe, même ici où les
comptes sont ceux de l'application : ils sont prêtés à la librairie sous forme de liste,
et c'est elle qui compare, scelle et tient la session. Et pas de table de sessions non
plus, parce qu'une ligne de session est précisément ce qui ne peut pas honorer une
révocation - elle serait encore valide.

Une application appairée porte vingt lignes dans `app_settings`. Celle-ci en porte deux.
Cet écart, c'est exactement ce que l'appairage apporte, dit sous forme de données.

## Ce qui change par rapport aux trois autres POC

**L'écran de connexion existe.** Il n'y a pas de portail où envoyer quelqu'un, donc un
lecteur sans session atterrit sur `/login` - c'est à ça que sert `routes.loginPath`, lu
uniquement dans ce mode. L'écran appartient à l'application, parce qu'une librairie ne
peut pas rendre une page, et il poste sur `/api/auth/sso/sign-in`.

**Il n'y a pas de moitié navigateur.** La socket ponte vers un fournisseur, et il n'y en a
pas. Un droit changé dans l'annuaire arrive donc à la **requête suivante** au lieu
d'arriver en quelques secondes. Rien d'autre ne change : la relecture par requête est ce
qui fait le travail dans les deux modes, la socket ne fait qu'avancer l'heure.

**Deux valeurs sont inventées.** `provider.baseUrl` et `di.hmac` sont obligatoires dans
les deux modes, et ici ni l'un ni l'autre n'est jamais atteint - rien ne signe, puisqu'il
n'y a personne à qui signer. L'adresse est quand même analysée à la construction, d'où le
`https://provider.invalid:13001` manifestement faux plutôt qu'une chaîne vide. C'est écrit
plutôt que contourné : une application qui ne fait que doubler doit inventer deux valeurs
qu'elle n'a pas.

## Ce que la librairie construit dans l'image

Le contexte de build est la racine de la **librairie**, pas ce dossier, parce que
`package.json` ici déclare `file:../..`. Le `Dockerfile` compile `src/` dans son propre
étage plutôt que de copier un `dist/` de l'hôte : `dist` est dans le `.dockerignore` de la
racine, exprès, et ce que le POC installe est ainsi le source de ce dépôt et pas ce que
quelqu'un a pensé à builder.
