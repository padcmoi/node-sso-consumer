<script setup lang="ts">
import type { SsoMe } from "@gestionpratique/node-sso-consumer";

const { account, actions, connected } = useSso();

/**
 * La même session, lue une seconde fois - mais par un contrôleur NestJS derrière son
 * guard, et non par une route de la librairie.
 *
 * C'est la seule chose que ce POC ajoute au précédent, et c'est ce qu'il existe pour
 * prouver : `GET /api/me` est un contrôleur ordinaire, décoré de `@UseGuards`, qui
 * lit `req.me` sans écrire une ligne de session. Si ce bloc répond, le guard Nest
 * fonctionne contre le vrai x-core.
 */
const { data: guarded } = await useFetch<{ data: SsoMe }>("/api/me");

const payload = computed(() => JSON.stringify(account.value, null, 2));
</script>

<template>
  <div class="space-y-6">
    <UAlert
      icon="i-lucide-info"
      color="neutral"
      variant="subtle"
      title="Ce que chaque moitié détient"
      description="Ce Nuxt ne détient rien : une liste blanche et deux relais, et pas une ligne de SSO. L'API NestJS détient le pont - appairage, session, droits, file de propagation, socket vers x-core - et aucune table d'utilisateurs, de mots de passe, de sessions ni de permissions."
    />

    <div class="grid gap-4 sm:grid-cols-3">
      <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10' }">
        <p class="text-xs uppercase tracking-wide text-slate-500">Droits sur cette app</p>
        <p class="mt-2 text-2xl font-semibold text-white">{{ actions.length }}</p>
        <p class="mt-1 text-xs text-slate-500">recalculés par x-core à chaque lecture</p>
      </UCard>
      <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10' }">
        <p class="text-xs uppercase tracking-wide text-slate-500">Temps réel</p>
        <p class="mt-2 text-2xl font-semibold text-white">{{ connected ? "ouvert" : "fermé" }}</p>
        <p class="mt-1 text-xs text-slate-500">navigateur → Nuxt → API → x-core</p>
      </UCard>
      <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10' }">
        <p class="text-xs uppercase tracking-wide text-slate-500">Guard NestJS</p>
        <p class="mt-2 text-2xl font-semibold text-white">{{ guarded?.data ? "passé" : "-" }}</p>
        <p class="mt-1 truncate text-xs text-slate-500">GET /api/me</p>
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
          <dd class="mt-1 truncate text-sm text-slate-200">{{ account?.user.email }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-slate-500">Identifiant</dt>
          <dd class="mt-1 truncate font-mono text-xs text-slate-200">{{ account?.user.id }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-xs uppercase tracking-wide text-slate-500">Vu par le contrôleur Nest</dt>
          <dd class="mt-1 truncate text-sm text-slate-200">{{ guarded?.data?.user.email ?? "-" }}</dd>
        </div>
      </dl>
    </UCard>

    <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10' }">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-sm font-semibold text-white">Droits ({{ actions.length }})</h2>
          <!-- Retirez-en un depuis le manager : la liste change sans rechargement,
               parce que la frame EST la nouvelle valeur. -->
          <UBadge color="primary" variant="subtle" size="sm">poussés par websocket</UBadge>
        </div>
      </template>

      <div v-if="actions.length" class="flex flex-wrap gap-2">
        <UBadge v-for="action in actions" :key="action" color="neutral" variant="subtle" size="sm">
          {{ action }}
        </UBadge>
      </div>
      <p v-else class="text-sm text-slate-500">Aucun droit sur cette application.</p>
    </UCard>

    <UCard :ui="{ root: 'bg-slate-900/60 ring-white/10' }">
      <template #header>
        <h2 class="font-mono text-sm text-slate-200">me-changed</h2>
      </template>

      <div class="overflow-x-auto rounded-md bg-slate-950/70 p-4 ring-1 ring-white/5">
        <pre class="font-mono text-xs leading-relaxed text-slate-300">{{ payload }}</pre>
      </div>
    </UCard>
  </div>
</template>
