# POC Nuxt 4 + Nitro (API)

POC : Nuxt 4 en front, **Nitro pour l'API**, Tailwind + Nuxt UI v4, MariaDB en réseau interne.

Point de départ avant la lib : une application avec son propre login, sa propre table
`users`, sa propre table `sessions` et son propre cookie. Rien de tout cela ne vient de
l'extérieur, et c'est exactement ce que `@naskot/node-sso-consumer` remplace.

## Démarrage

```bash
cp .env.sample .env   # puis remplacer les valeurs
pnpm prod:up          # docker compose up -d --build
pnpm prod:logs
pnpm prod:down
pnpm prod:reset       # supprime aussi le volume MariaDB
```

App : http://localhost:7003
phpMyAdmin : http://localhost:7004 (`root` / `DB_ROOT_PASSWORD`)

## Accès

Le compte est créé au premier démarrage à partir de `ADMIN_EMAIL` / `ADMIN_PASSWORD`
(`.env`), mot de passe stocké en scrypt (salt + dérivée).

## Pages

- `/` vue d'ensemble
- `/services` table lue en base
- `/test` dump JSON de la session en cours

Les trois sont derrière le middleware global `app/middleware/auth.global.ts`, et chaque
route d'API vérifie la session de son côté. `/login` est la seule page ouverte.

## API Nitro

| Route | Rôle |
| --- | --- |
| `POST /api/auth/login` | vérifie le mot de passe, ouvre une session, pose le cookie |
| `POST /api/auth/logout` | supprime la ligne `sessions` et le cookie |
| `GET /api/auth/session` | la session en cours, le compte, les sessions actives |
| `GET /api/services` | données métier, refusée sans session |

## Base de données

MariaDB 11.4, aucun port publié : joignable uniquement depuis le réseau Docker `backend`
(app + phpMyAdmin). Tables créées et seedées au boot par le plugin Nitro
`server/plugins/database.ts`.
