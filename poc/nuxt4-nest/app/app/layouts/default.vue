<script setup lang="ts">
const { account, connected, logout } = useSso()
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-200">
    <header
      class="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-white/5 bg-slate-950/80 px-4 py-4 backdrop-blur sm:px-6"
    >
      <UIcon name="i-lucide-shield" class="size-5 shrink-0 text-primary-400" />
      <h1 class="flex-1 truncate text-sm font-semibold text-white">POC Nuxt 4 + NestJS</h1>

      <!-- La socket, telle qu'elle est à l'instant. Elle traverse deux sauts ici :
           le navigateur parle à ce Nuxt, ce Nuxt relaie vers l'API, et c'est l'API
           qui tient le pont vers x-core. -->
      <UBadge :color="connected ? 'success' : 'neutral'" variant="subtle" size="sm">
        <span class="size-1.5 rounded-full" :class="connected ? 'bg-green-400' : 'bg-slate-500'" />
        {{ connected ? 'temps réel' : 'hors ligne' }}
      </UBadge>

      <div v-if="account" class="flex items-center gap-2">
        <span class="hidden truncate text-xs text-slate-400 sm:block">{{ account.user.email }}</span>
        <UButton
          icon="i-lucide-log-out"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Se déconnecter"
          @click="logout()"
        />
      </div>
    </header>

    <main class="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <slot />
    </main>
  </div>
</template>
