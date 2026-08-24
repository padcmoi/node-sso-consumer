<script setup lang="ts">
import type { SsoMe } from '@gestionpratique/node-sso-consumer'

/**
 * The page behind the guard.
 *
 * NOTHING IS REDIRECTED FROM HERE. The server middleware already sent a browser with
 * no session to `/login`, before a byte of this page was rendered - so a page that IS
 * rendering has passed that guard. A second router on top of the first disagrees with
 * it at exactly the moment a session ends.
 *
 * There is no realtime half either, and that is not an omission: the socket bridges
 * to a provider, and in this mode there is none. A right changed in the directory
 * lands on the NEXT request instead of within seconds, because the library re-reads
 * the account on every one of them.
 */
const { data: session } = await useFetch<SsoMe>('/api/auth/session')
const { data: notes } = await useFetch<{ reader: string; notes: { id: number; title: string; body: string }[] }>(
  '/api/notes',
)

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' })
  window.location.assign('/login')
}
</script>

<template>
  <div>
    <h1>Session tenue par la librairie</h1>
    <p class="muted">
      Aucun fournisseur n'a été appelé. Le compte ci-dessous a été relu depuis l'annuaire prêté, à cette
      requête, comme il l'est à chacune.
    </p>

    <h2>Le compte, à la forme que x-core répondrait</h2>
    <pre>{{ JSON.stringify(session, null, 2) }}</pre>

    <h2>Les données de l'application, derrière <code>read:note</code></h2>
    <p v-if="notes" class="muted">Lues pour {{ notes.reader }}.</p>
    <table v-if="notes">
      <tbody>
        <tr v-for="note in notes.notes" :key="note.id">
          <td><strong>{{ note.title }}</strong><br /><span class="muted">{{ note.body }}</span></td>
        </tr>
      </tbody>
    </table>

    <h2>Ce qu'il n'y a pas en base</h2>
    <p class="muted">
      Ni table de comptes, ni colonne de mot de passe, ni table de sessions. Deux tables seulement :
      <code>app_settings</code>, où la librairie garde le mot de passe qui scelle le cookie, et
      <code>notes</code>, qui sont les données de cette application.
    </p>

    <p style="margin-top: 2rem"><button @click="logout">Se déconnecter</button></p>
  </div>
</template>
