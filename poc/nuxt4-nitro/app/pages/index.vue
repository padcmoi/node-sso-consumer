<script setup lang="ts">
const session = useSessionState()
const { data: services } = await useFetch('/api/services')

const stats = computed(() => [
  {
    label: 'Services en base',
    value: String(services.value?.length ?? 0),
    icon: 'i-lucide-server',
    hint: `${services.value?.filter((service) => service.status === 'running').length ?? 0} en marche`,
  },
  {
    label: 'Sessions actives',
    value: String(session.value?.activeSessions.length ?? 0),
    icon: 'i-lucide-user-check',
    hint: 'pour ce compte',
  },
  {
    label: 'Session expire dans',
    value: `${Math.floor((session.value?.session.expiresInSeconds ?? 0) / 3600)} h`,
    icon: 'i-lucide-timer',
    hint: session.value?.session.expiresAt ?? '',
  },
  {
    label: 'Base de données',
    value: 'MariaDB',
    icon: 'i-lucide-database',
    hint: 'réseau interne uniquement',
  },
])
</script>

<template>
  <div class="space-y-6">
    <UAlert
      icon="i-lucide-info"
      color="neutral"
      variant="subtle"
      title="Vue d'ensemble"
      description="Tout ce qui est affiché ici est lu en base : les services, la session en cours et le compte connecté."
    />

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <UCard
        v-for="stat in stats"
        :key="stat.label"
        :ui="{ root: 'bg-slate-900/60 ring-white/10' }"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-xs uppercase tracking-wide text-slate-500">
              {{ stat.label }}
            </p>
            <p class="mt-2 text-2xl font-semibold text-white">
              {{ stat.value }}
            </p>
            <p class="mt-1 truncate text-xs text-slate-500">
              {{ stat.hint }}
            </p>
          </div>
          <UIcon :name="stat.icon" class="size-5 shrink-0 text-primary-400" />
        </div>
      </UCard>
    </div>

    <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10' }">
      <template #header>
        <h2 class="text-sm font-semibold text-white">Compte connecté</h2>
      </template>

      <dl class="grid gap-4 sm:grid-cols-2">
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-slate-500">Email</dt>
          <dd class="mt-1 text-sm text-slate-200">{{ session?.user.email }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-slate-500">Identifiant</dt>
          <dd class="mt-1 truncate font-mono text-xs text-slate-200">{{ session?.user.id }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-slate-500">Compte créé le</dt>
          <dd class="mt-1 text-sm text-slate-200">{{ session?.user.createdAt }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-slate-500">Session ouverte le</dt>
          <dd class="mt-1 text-sm text-slate-200">{{ session?.session.createdAt }}</dd>
        </div>
      </dl>
    </UCard>
  </div>
</template>
