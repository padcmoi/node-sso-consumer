<script setup lang="ts">
const { data: services, status } = await useFetch('/api/services')

function colorFor(status: string) {
  if (status === 'running') return 'success'
  if (status === 'degraded') return 'warning'
  if (status === 'stopped') return 'error'
  return 'neutral'
}
</script>

<template>
  <div class="space-y-6">
    <UAlert
      icon="i-lucide-server"
      color="neutral"
      variant="subtle"
      title="Services"
      description="Lignes lues dans la table `services` de MariaDB, servies par le backend Nitro."
    />

    <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10', body: 'p-0 sm:p-0' }">
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-white/5 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="px-4 py-3 font-medium">Nom</th>
              <th class="px-4 py-3 font-medium">Type</th>
              <th class="px-4 py-3 font-medium">Hôte</th>
              <th class="px-4 py-3 font-medium">État</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            <tr v-if="status === 'pending'">
              <td colspan="4" class="px-4 py-6 text-center text-slate-500">Chargement...</td>
            </tr>
            <tr
              v-for="service in services"
              :key="service.id"
              class="hover:bg-white/5"
            >
              <td class="px-4 py-3 font-medium text-slate-100">{{ service.name }}</td>
              <td class="px-4 py-3 text-slate-400">{{ service.kind }}</td>
              <td class="px-4 py-3 font-mono text-xs text-slate-400">{{ service.host }}</td>
              <td class="px-4 py-3">
                <UBadge :color="colorFor(service.status)" variant="subtle" size="sm">
                  {{ service.status }}
                </UBadge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>
  </div>
</template>
