<script setup lang="ts">
const { account, connected } = useSso()

/**
 * Ce que `GET /api/auth/session` répond, à l'instant.
 *
 * Rien n'est relu ici : la valeur affichée est celle que la socket a poussée en
 * dernier. C'est tout l'intérêt de tenir cette socket ouverte - une permission
 * accordée ou retirée depuis n'importe quelle autre application arrive dans ce bloc
 * en quelques secondes, sans rechargement et sans requête.
 */
const payload = computed(() => JSON.stringify(account.value, null, 2))
const groups = computed(() => account.value?.permissions.groups ?? [])
</script>

<template>
  <div class="space-y-6">
    <UAlert
      icon="i-lucide-flask-conical"
      color="neutral"
      variant="subtle"
      title="La session, telle que x-core la répond"
      description="Le compte, le profil civil, les droits et les groupes par lesquels ils arrivent. Rien de tout cela n'est stocké ici : ni en base, ni en cache, ni dans un store persisté. Ce bloc est mis à jour par la socket, pas par une relecture."
    />

    <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10' }">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-mono text-sm text-slate-200">me-changed</h2>
          <UBadge :color="connected ? 'success' : 'error'" variant="subtle" size="sm">
            {{ connected ? 'socket ouverte' : 'socket fermée' }}
          </UBadge>
        </div>
      </template>

      <div class="overflow-x-auto rounded-md bg-slate-950/70 p-4 ring-1 ring-white/5">
        <pre class="font-mono text-xs leading-relaxed text-slate-300">{{ payload }}</pre>
      </div>
    </UCard>

    <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10', body: 'p-0 sm:p-0' }">
      <template #header>
        <h2 class="text-sm font-semibold text-white">
          Groupes ({{ groups.length }})
        </h2>
      </template>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-white/5 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="px-4 py-3 font-medium">Nom</th>
              <th class="px-4 py-3 font-medium">Description</th>
              <th class="px-4 py-3 font-medium">Identifiant</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            <tr v-if="!groups.length">
              <td colspan="3" class="px-4 py-6 text-center text-slate-500">
                Aucun groupe.
              </td>
            </tr>
            <tr v-for="group in groups" :key="group.id" class="hover:bg-white/5">
              <td class="px-4 py-3 font-medium text-slate-100">{{ group.name }}</td>
              <td class="px-4 py-3 text-slate-400">{{ group.description ?? '-' }}</td>
              <td class="px-4 py-3 font-mono text-xs text-slate-500">{{ group.id }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>
  </div>
</template>
