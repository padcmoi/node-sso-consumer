<script setup lang="ts">
const { account, actions, connected } = useSso()
const { data: services } = await useFetch('/api/services')

const stats = computed(() => [
  {
    label: 'Services en base',
    value: String(services.value?.length ?? 0),
    icon: 'i-lucide-server',
    hint: `${services.value?.filter((service) => service.status === 'running').length ?? 0} en marche`,
  },
  {
    label: 'Droits sur cette app',
    value: String(actions.value.length),
    icon: 'i-lucide-key-round',
    hint: 'recalculés par x-core à chaque lecture',
  },
  {
    label: 'Temps réel',
    value: connected.value ? 'ouvert' : 'fermé',
    icon: 'i-lucide-radio',
    hint: 'me-changed, me-signed-out',
  },
  {
    label: 'Sessions en base',
    value: '0',
    icon: 'i-lucide-database',
    hint: 'aucune table de session ici',
  },
])
</script>

<template>
  <div class="space-y-6">
    <UAlert
      icon="i-lucide-info"
      color="neutral"
      variant="subtle"
      title="Ce que cette application détient"
      description="Un cookie scellé, et rien d'autre. Pas de table `users`, pas de colonne mot de passe, pas de table `sessions`, pas de permission stockée. Le compte, le profil et les droits ci-dessous sont demandés à x-core à chaque requête et jamais mis en cache."
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
          <dt class="text-xs uppercase tracking-wide text-slate-500">Nom</dt>
          <dd class="mt-1 text-sm text-slate-200">{{ account?.user.displayName }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-slate-500">Email</dt>
          <dd class="mt-1 text-sm text-slate-200">{{ account?.user.email }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-slate-500">Identifiant</dt>
          <dd class="mt-1 truncate font-mono text-xs text-slate-200">{{ account?.user.id }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-slate-500">Ville</dt>
          <dd class="mt-1 text-sm text-slate-200">{{ account?.profile.city ?? '—' }}</dd>
        </div>
      </dl>
    </UCard>

    <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10' }">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-sm font-semibold text-white">
            Droits sur cette application ({{ actions.length }})
          </h2>
          <!-- Retirez-en un depuis le manager : la liste ci-dessous change sans
               rechargement, parce que la frame EST la nouvelle valeur. -->
          <UBadge color="primary" variant="subtle" size="sm">poussés par websocket</UBadge>
        </div>
      </template>

      <div v-if="actions.length" class="flex flex-wrap gap-2">
        <UBadge v-for="action in actions" :key="action" color="neutral" variant="subtle" size="sm">
          {{ action }}
        </UBadge>
      </div>
      <p v-else class="text-sm text-slate-500">
        Aucun droit sur cette application.
      </p>
    </UCard>
  </div>
</template>
