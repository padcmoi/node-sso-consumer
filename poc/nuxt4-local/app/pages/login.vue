<script setup lang="ts">
/**
 * The sign-in screen, and the ONE thing this application owns about signing in.
 *
 * The screen is the application's because a library cannot render a page: it belongs
 * to this design, this framework, this language. Everything behind it is the
 * library's - comparing the password against the scrypt record, sealing the cookie
 * with the password it minted, and holding the session.
 *
 * There is no portal here to send anybody to, which is what `routes.loginPath` is
 * for: the library sends a reader without a session to THIS page, and this page
 * posts to the route the library answers.
 */
const email = ref('')
const password = ref('')
const busy = ref(false)
const failed = ref(false)

async function submit() {
  busy.value = true
  failed.value = false
  try {
    await $fetch('/api/auth/sso/sign-in', {
      method: 'POST',
      body: { email: email.value, password: password.value },
    })
    // A full navigation rather than a router push: the cookie was just written on
    // this response, and what has to run next is the SERVER guard with it.
    window.location.assign('/')
  } catch {
    // One message for a wrong address and a wrong password, because the library
    // answers one refusal for both - telling them apart tells whoever is asking
    // which addresses exist here.
    failed.value = true
    password.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <h1>Se connecter</h1>
    <p class="muted">
      Aucun fournisseur n'est joignable ici. La librairie répond contre l'annuaire prêté dans
      <code>server/utils/xcore.ts</code>.
    </p>

    <form style="margin-top: 1.5rem; max-width: 22rem" @submit.prevent="submit">
      <label>
        <span>Adresse</span>
        <input v-model="email" type="email" autocomplete="username" required />
      </label>
      <label>
        <span>Mot de passe</span>
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>
      <p v-if="failed" class="error">Adresse ou mot de passe incorrect.</p>
      <button type="submit" :disabled="busy || !email || !password">
        {{ busy ? 'Vérification...' : 'Entrer' }}
      </button>
    </form>

    <h2>Les deux comptes prêtés</h2>
    <table>
      <thead>
        <tr>
          <th>Adresse</th>
          <th>Mot de passe</th>
          <th>Droits</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>julien@example.test</code></td>
          <td><code>julien</code></td>
          <td><code>read:note</code></td>
        </tr>
        <tr>
          <td><code>admin@example.test</code></td>
          <td><code>admin</code></td>
          <td>aucun, mais <code>isRoot</code></td>
        </tr>
      </tbody>
    </table>
    <p class="muted">
      Les mots de passe ne sont pas stockés ainsi : l'annuaire porte un <code>passwordHash</code> scrypt, et la
      comparaison est celle de la librairie.
    </p>
  </div>
</template>
