<script setup lang="ts">
const route = useRoute();
const anonymous = computed(() => route.path === "/login" || route.path === "/register");
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-200">
    <header class="border-b border-white/5 bg-slate-900/60 backdrop-blur">
      <div class="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
        <UIcon name="i-lucide-key-round" class="size-5 text-primary-400" />
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold text-white">POC mode local</p>
          <p class="truncate text-xs text-slate-400">node-sso-consumer, sans fournisseur</p>
        </div>

        <UBadge v-if="anonymous" color="neutral" variant="subtle" size="sm" class="ml-auto shrink-0"> Aucune session </UBadge>
      </div>
    </header>

    <main class="mx-auto max-w-3xl px-4 py-8">
      <NuxtPage />
    </main>
  </div>
</template>
