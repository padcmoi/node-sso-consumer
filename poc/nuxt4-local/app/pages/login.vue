<script setup lang="ts">
/**
 * L'écran de connexion, et la SEULE chose que cette application possède du login.
 *
 * L'écran lui appartient parce qu'une librairie ne peut pas rendre une page : elle
 * relève de ce design, de ce framework, de cette langue. Tout ce qui est derrière est
 * à la librairie - comparer le mot de passe contre l'enregistrement scrypt, sceller
 * le cookie avec le mot de passe qu'elle a tiré, et tenir la session.
 *
 * Il n'y a pas de portail où envoyer quelqu'un ici, et c'est à ça que sert
 * `routes.loginPath` : la librairie renvoie un lecteur sans session sur CETTE page,
 * qui poste sur la route qu'elle answers.
 */
const state = reactive({ email: "", password: "" });
const busy = ref(false);
const failed = ref(false);

async function submit() {
  busy.value = true;
  failed.value = false;
  try {
    await $fetch("/api/auth/sso/sign-in", { method: "POST", body: { ...state } });
    // Navigation complète plutôt qu'un push du routeur : le cookie vient d'être écrit
    // sur cette réponse, et ce qui doit tourner ensuite est le garde SERVEUR avec lui.
    window.location.assign("/");
  } catch {
    // Un seul message pour une mauvaise adresse et un mauvais mot de passe, parce que
    // la librairie ne répond qu'un refus pour les deux : les distinguer dirait à qui
    // demande quelles adresses existent ici.
    failed.value = true;
    state.password = "";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-8">
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold text-white">Se connecter</h1>
      <p class="text-sm text-slate-400">
        Aucun fournisseur n'est joignable ici. La librairie répond contre la table
        <code class="rounded bg-white/5 px-1 py-0.5 text-xs text-slate-300">app_sso_accounts</code>.
      </p>
    </div>

    <UCard :ui="{ body: 'space-y-4' }" class="max-w-md">
      <UForm :state="state" class="space-y-4" @submit="submit">
        <UFormField label="Adresse" name="email" required>
          <UInput v-model="state.email" type="email" autocomplete="username" icon="i-lucide-mail" class="w-full" />
        </UFormField>

        <UFormField label="Mot de passe" name="password" required>
          <UInput v-model="state.password" type="password" autocomplete="current-password" icon="i-lucide-lock" class="w-full" />
        </UFormField>

        <UAlert
          v-if="failed"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Adresse ou mot de passe incorrect"
        />

        <div class="flex items-center gap-3">
          <UButton type="submit" :loading="busy" :disabled="!state.email || !state.password" icon="i-lucide-log-in">
            Entrer
          </UButton>
          <UButton to="/register" variant="ghost" color="neutral" trailing-icon="i-lucide-arrow-right"> Créer un compte </UButton>
        </div>
      </UForm>
    </UCard>

    <div class="space-y-3">
      <h2 class="text-sm font-semibold text-white">Les deux comptes semés au premier démarrage</h2>

      <div class="overflow-hidden rounded-lg border border-white/10">
        <table class="w-full text-sm">
          <thead class="bg-white/5 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th class="px-4 py-2 text-left font-medium">Adresse</th>
              <th class="px-4 py-2 text-left font-medium">Mot de passe</th>
              <th class="px-4 py-2 text-left font-medium">Droits</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            <tr>
              <td class="px-4 py-2 font-mono text-xs">julien@example.test</td>
              <td class="px-4 py-2 font-mono text-xs">julien</td>
              <td class="px-4 py-2"><UBadge color="primary" variant="subtle" size="sm">read:note</UBadge></td>
            </tr>
            <tr>
              <td class="px-4 py-2 font-mono text-xs">admin@example.test</td>
              <td class="px-4 py-2 font-mono text-xs">admin</td>
              <td class="px-4 py-2"><UBadge color="warning" variant="subtle" size="sm">isRoot</UBadge></td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="text-xs text-slate-500">
        Les mots de passe ne sont pas stockés ainsi. La table porte un
        <code class="rounded bg-white/5 px-1 py-0.5 text-slate-300">password_scrypt</code> produit par la librairie, et le semis
        l'a écrit en appelant <code class="rounded bg-white/5 px-1 py-0.5 text-slate-300">signUp</code> - aucun hash n'est écrit à
        la main nulle part.
      </p>
    </div>
  </div>
</template>
