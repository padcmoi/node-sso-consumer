<script setup lang="ts">
/**
 * The sign-in screen, and ONLY while the library stands in for x-core.
 *
 * With `mode: "sso"` nobody ever lands here: the portal is the one place anybody
 * signs in, and `middleware/auth.global.ts` sends a reader without a session there.
 * This page exists because standing in there IS no portal.
 *
 * The split is deliberate. The library owns the LOGIN - it compares, it seals the
 * cookie, it holds the session, exactly as it does against x-core - and it does it
 * inside the API. This page owns the SCREEN, and posts to the relay like everything
 * else. There is no logic here worth the name: two fields, one POST, and a redirect.
 */
definePageMeta({ layout: false });

const email = ref("");
const password = ref("");
const refused = ref(false);
const busy = ref(false);

const route = useRoute();

// Where to land afterwards. Defaulted to `/`, never to a value from the query alone:
// an open redirect is exactly what a `next` parameter becomes when it is followed
// without being checked.
const next = computed(() => {
  const asked = route.query.next;
  return typeof asked === "string" && asked.startsWith("/") && !asked.startsWith("//") ? asked : "/";
});

async function submit() {
  busy.value = true;
  refused.value = false;

  try {
    await $fetch("/api/auth/sso/sign-in", {
      method: "POST",
      body: { email: email.value, password: password.value },
    });
    // A full navigation rather than a router push: the cookie was just written, and
    // what has to be re-read is the guard in front of every page.
    window.location.assign(next.value);
  } catch {
    refused.value = true;
    password.value = "";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-default p-4">
    <UCard class="w-full max-w-sm">
      <template #header>
        <div class="flex items-center gap-3">
          <UIcon name="i-lucide-shield-check" class="size-6 text-primary" />
          <div>
            <p class="font-semibold text-highlighted">POC Nuxt 4 + NestJS</p>
            <p class="text-sm text-muted">Comptes locaux, x-core est éteint</p>
          </div>
        </div>
      </template>

      <UForm :state="{ email, password }" class="space-y-4" @submit="submit">
        <UFormField label="Email" name="email" required>
          <UInput v-model="email" type="email" autocomplete="username" class="w-full" />
        </UFormField>

        <UFormField label="Mot de passe" name="password" required>
          <UInput v-model="password" type="password" autocomplete="current-password" class="w-full" />
        </UFormField>

        <!-- Un seul message pour les deux moitiés : nommer celle qui est fausse
             indique à qui demande quelles adresses existent ici. -->
        <UAlert
          v-if="refused"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-x"
          description="Email ou mot de passe incorrect."
        />

        <UButton type="submit" block :loading="busy" :disabled="!email || !password">Se connecter</UButton>
      </UForm>

      <template #footer>
        <p class="text-sm text-muted">
          Ces comptes vivent dans <code class="font-mono">api/src/sso/xcore.service.ts</code>. Avec
          <code class="font-mono">mode: "sso"</code>, cet écran n'est jamais atteint : c'est le portail qui connecte.
        </p>
      </template>
    </UCard>
  </div>
</template>
