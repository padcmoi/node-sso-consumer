<script setup lang="ts">
const route = useRoute()
const session = useSessionState()
const open = ref(false)

const links = [
  { label: "Vue d'ensemble", to: '/', icon: 'i-lucide-layout-dashboard' },
  { label: 'Services', to: '/services', icon: 'i-lucide-server' },
  { label: 'Test', to: '/test', icon: 'i-lucide-flask-conical' },
]

const current = computed(() => links.find((link) => link.to === route.path)?.label ?? 'POC Nuxt 4 + Nitro')

watch(() => route.path, () => {
  open.value = false
})
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-200">
    <div
      v-if="open"
      class="fixed inset-0 z-30 bg-black/60 lg:hidden"
      @click="open = false"
    />

    <aside
      class="fixed inset-y-0 left-0 z-40 flex w-64 -translate-x-full flex-col border-r border-white/5 bg-slate-900/80 backdrop-blur transition-transform lg:translate-x-0"
      :class="open ? 'translate-x-0' : ''"
    >
      <div class="flex items-center gap-2 px-5 py-5">
        <UIcon name="i-lucide-shield" class="size-5 text-primary-400" />
        <span class="text-sm font-semibold text-white">POC Nuxt 4 + Nitro</span>
      </div>

      <nav class="flex-1 space-y-1 px-3">
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors"
          :class="route.path === link.to
            ? 'bg-primary-500/10 text-primary-400'
            : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'"
        >
          <UIcon :name="link.icon" class="size-4 shrink-0" />
          {{ link.label }}
        </NuxtLink>
      </nav>

      <div class="border-t border-white/5 p-3">
        <div class="flex items-center gap-3 rounded-md px-2 py-2">
          <UAvatar
            :alt="session?.user.email"
            size="sm"
            :ui="{ root: 'bg-primary-500/20 text-primary-300' }"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-white">
              {{ session?.user.email }}
            </p>
            <p class="truncate font-mono text-xs text-slate-500">
              {{ session?.session.token.slice(0, 8) }}
            </p>
          </div>
          <UButton
            icon="i-lucide-log-out"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Se déconnecter"
            @click="logout()"
          />
        </div>
      </div>
    </aside>

    <div class="lg:pl-64">
      <header
        class="sticky top-0 z-20 flex items-center gap-3 border-b border-white/5 bg-slate-950/80 px-4 py-4 backdrop-blur sm:px-6"
      >
        <UButton
          icon="i-lucide-panel-left"
          color="neutral"
          variant="ghost"
          size="sm"
          class="lg:hidden"
          aria-label="Ouvrir le menu"
          @click="open = !open"
        />
        <h1 class="text-sm font-semibold text-primary-400">
          {{ current }}
        </h1>
      </header>

      <main class="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <slot />
      </main>
    </div>
  </div>
</template>
