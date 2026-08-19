<script setup lang="ts">
definePageMeta({ layout: 'auth' })

const email = ref('')
const password = ref('')
const error = ref('')
const pending = ref(false)

async function submit() {
  pending.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/login', {
      method: 'POST',
      body: { email: email.value, password: password.value },
    })
    await refreshSession()
    await navigateTo('/')
  } catch {
    error.value = 'Identifiants invalides.'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <UCard :ui="{ root: 'bg-slate-900/70 ring-white/10' }">
    <div class="mb-6 flex items-center gap-2">
      <UIcon name="i-lucide-shield" class="size-5 text-primary-400" />
      <span class="text-sm font-semibold text-white">POC Nuxt 4 + Nitro</span>
    </div>

    <form class="space-y-4" @submit.prevent="submit">
      <UFormField label="Adresse email" name="email">
        <UInput
          v-model="email"
          type="email"
          autocomplete="email"
          placeholder="vous@exemple.tld"
          class="w-full"
          required
        />
      </UFormField>

      <UFormField label="Mot de passe" name="password">
        <UInput
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="w-full"
          required
        />
      </UFormField>

      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="error"
      />

      <UButton type="submit" block :loading="pending">
        Se connecter
      </UButton>
    </form>
  </UCard>
</template>
