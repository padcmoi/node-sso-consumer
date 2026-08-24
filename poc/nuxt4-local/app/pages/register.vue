<script setup lang="ts">
/**
 * Créer un compte, et c'est le POINT DE CETTE PAGE : elle ne hache rien.
 *
 * Elle poste un mot de passe EN CLAIR sur `/api/auth/sso/sign-up`, et c'est la
 * librairie qui le hache avec `hashPassword`, écrit la ligne par `di.accounts.create`
 * et scelle le cookie dans la foulée. Le format scrypt n'existe donc qu'à un seul
 * endroit - une application qui produirait le hash de son côté devrait reproduire les
 * paramètres, et le jour où l'un des deux bouge rien n'échoue bruyamment : tous les
 * mots de passe deviennent faux d'un coup.
 *
 * La route n'existe que parce que `routes.signUp: true` est écrit dans le service.
 * Sans cette ligne elle répond `404`, même avec `create` prêté.
 */
const state = reactive({ firstName: "", lastName: "", email: "", password: "" });
const busy = ref(false);
const failed = ref("");

async function submit() {
  busy.value = true;
  failed.value = "";
  try {
    await $fetch("/api/auth/sso/sign-up", { method: "POST", body: { ...state } });
    window.location.assign("/");
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    failed.value =
      status === 409
        ? "Cette adresse est déjà prise."
        : status === 422
          ? "Il faut une adresse et un mot de passe de 8 caractères au moins."
          : "La création a échoué.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-8">
    <div class="space-y-2">
      <h1 class="text-2xl font-semibold text-white">Créer un compte</h1>
      <p class="text-sm text-slate-400">
        Le mot de passe part en clair sur
        <code class="rounded bg-white/5 px-1 py-0.5 text-xs text-slate-300">/api/auth/sso/sign-up</code> et c'est la librairie qui
        le hache. Cette page n'écrit ni hash ni ligne.
      </p>
    </div>

    <UCard class="max-w-md">
      <UForm :state="state" class="space-y-4" @submit="submit">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Prénom" name="firstName" required>
            <UInput v-model="state.firstName" autocomplete="given-name" class="w-full" />
          </UFormField>
          <UFormField label="Nom" name="lastName" required>
            <UInput v-model="state.lastName" autocomplete="family-name" class="w-full" />
          </UFormField>
        </div>

        <UFormField label="Adresse" name="email" required>
          <UInput v-model="state.email" type="email" autocomplete="username" icon="i-lucide-mail" class="w-full" />
        </UFormField>

        <UFormField label="Mot de passe" name="password" hint="8 caractères au moins" required>
          <UInput v-model="state.password" type="password" autocomplete="new-password" icon="i-lucide-lock" class="w-full" />
        </UFormField>

        <UAlert v-if="failed" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="failed" />

        <div class="flex items-center gap-3">
          <UButton type="submit" :loading="busy" :disabled="!state.email || state.password.length < 8" icon="i-lucide-user-plus">
            Créer et entrer
          </UButton>
          <UButton to="/login" variant="ghost" color="neutral" icon="i-lucide-arrow-left">J'ai déjà un compte</UButton>
        </div>
      </UForm>
    </UCard>

    <UAlert
      color="neutral"
      variant="subtle"
      icon="i-lucide-shield-off"
      title="Le compte créé ne détient rien"
      description="permissions: [] et isRoot: false. Il ouvre une session, passe le garde de page, et se fait refuser /api/notes qui demande read:note. C'est ce qui prouve que l'authentification et l'autorisation restent séparées dans ce mode."
    />
  </div>
</template>
