<script setup lang="ts">
const session = useSessionState()
const pending = ref(false)

const payload = computed(() => JSON.stringify(session.value, null, 2))

async function reload() {
  pending.value = true
  await refreshSession()
  pending.value = false
}
</script>

<template>
  <div class="space-y-6">
    <UAlert
      icon="i-lucide-flask-conical"
      color="neutral"
      variant="subtle"
      title="La session en cours"
      description="La session avec laquelle cette console est connectée, telle que l'API la répond à l'instant : la ligne `sessions` de la base, le compte `users` associé et les autres sessions encore ouvertes pour ce compte. Rien ici n'est simulé et rien n'est modifié."
    />

    <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10' }">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-mono text-sm text-slate-200">Session en cours</h2>
          <div class="flex items-center gap-2">
            <UBadge color="primary" variant="subtle" size="sm">
              GET /api/auth/session
            </UBadge>
            <UButton
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="ghost"
              size="xs"
              :loading="pending"
              @click="reload"
            >
              Relire
            </UButton>
          </div>
        </div>
      </template>

      <div class="overflow-x-auto rounded-md bg-slate-950/70 p-4 ring-1 ring-white/5">
        <pre class="font-mono text-xs leading-relaxed text-slate-300">{{ payload }}</pre>
      </div>
    </UCard>

    <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10', body: 'p-0 sm:p-0' }">
      <template #header>
        <h2 class="text-sm font-semibold text-white">
          Sessions actives du compte ({{ session?.activeSessions.length ?? 0 }})
        </h2>
      </template>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-white/5 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th class="px-4 py-3 font-medium">Jeton</th>
              <th class="px-4 py-3 font-medium">Ouverte le</th>
              <th class="px-4 py-3 font-medium">Expire le</th>
              <th class="px-4 py-3 font-medium">IP</th>
              <th class="px-4 py-3 font-medium">Agent</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            <tr
              v-for="item in session?.activeSessions"
              :key="item.token"
              class="hover:bg-white/5"
            >
              <td class="px-4 py-3 font-mono text-xs text-slate-300">
                {{ item.token }}
                <UBadge v-if="item.current" color="primary" variant="subtle" size="sm" class="ml-2">
                  celle-ci
                </UBadge>
              </td>
              <td class="px-4 py-3 text-slate-400">{{ item.createdAt }}</td>
              <td class="px-4 py-3 text-slate-400">{{ item.expiresAt }}</td>
              <td class="px-4 py-3 font-mono text-xs text-slate-400">{{ item.ip }}</td>
              <td class="max-w-xs truncate px-4 py-3 text-xs text-slate-500">{{ item.userAgent }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>
  </div>
</template>
