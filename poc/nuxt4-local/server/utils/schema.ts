import { NoteEntity, SsoAccountEntity, type NoteRow, type SsoAccountRow } from "./entities";

/**
 * The schema and the seed, done ONCE and awaited by everything that needs them.
 *
 * A memoised promise rather than a plugin others rely on running first. Nitro calls
 * its plugins in filename order but does NOT await them, so an `async` one returns a
 * promise nobody holds and the next plugin starts while the first is still working.
 * The library's boot reads `app_sso_settings` immediately, so it has to wait.
 *
 * The schema itself comes from the entities - `synchronize: true` in `db.ts`.
 */

/**
 * The two accounts this POC signs in with, seeded on an empty table.
 *
 * THE HASH IS NOT WRITTEN HERE. `xcore.accounts.signUp` takes a password, hashes it
 * with the library's own `hashPassword` and hands `di.accounts.create` a record - so
 * the scrypt format lives in one place. A seed that pasted a hash literal would be
 * the very thing this task removed.
 */
const SEED = [
  {
    email: "julien@example.test",
    password: "julien",
    firstName: "Julien",
    lastName: "Example",
    // Namespaced or not: `read:note` becomes `<app>:read:note`, and a value that
    // already carries its prefix is left alone.
    permissions: ["read:note"],
  },
  {
    email: "admin@example.test",
    password: "admin",
    firstName: "Admin",
    lastName: "Example",
    // Empty, and `isRoot` instead: x-core answers `isRoot: true` for an account that
    // passes everything, and `can()` reads it before looking at the list.
    permissions: [],
    isRoot: true,
  },
];

const NOTES = [
  ["Ce que la table ne contient pas", "Ni session, ni mot de passe en clair. Le hash est produit par la librairie."],
  ["Le mode local", "Aucun fournisseur n'est appelé. La session est réelle, le cookie est scellé, les gardes refusent."],
  ["La clé étrangère", "notes.owner pointe sur app_sso_accounts.id, la même cible dans les deux modes."],
];

async function waitForDb() {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      await useSource();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("database unreachable");
}

async function seed() {
  const accounts = await useRepo<SsoAccountRow>(SsoAccountEntity);
  if ((await accounts.count()) === 0) {
    for (const account of SEED) await xcore.accounts.signUp(account);
    console.info(`[poc] seeded ${SEED.length} local account(s) through xcore.accounts.signUp`);
  }

  const notes = await useRepo<NoteRow>(NoteEntity);
  if ((await notes.count()) > 0) return;

  // Owned by the first account, which is what makes the foreign key real rather
  // than declared: these rows cannot exist without a row in `app_sso_accounts`.
  const owner = await accounts.findOne({ where: { email: SEED[0]!.email } });
  if (!owner) return;

  for (const [title, body] of NOTES) {
    await notes.save(notes.create({ owner: owner.id, title: title!, body: body! }));
  }
}

let building: Promise<void> | null = null;

export function schemaReady() {
  building ??= (async () => {
    await waitForDb();
    await seed();
  })();

  return building;
}
