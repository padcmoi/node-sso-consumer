<script setup lang="ts">
import type { SsoMe } from "@gestionpratique/node-sso-consumer";

/**
 * La page derrière le garde.
 *
 * RIEN N'EST REDIRIGÉ D'ICI. Le middleware serveur a déjà renvoyé un navigateur sans
 * session sur `/login`, avant qu'un octet de cette page soit rendu - donc une page qui
 * S'AFFICHE a passé ce garde. Un second routeur au-dessus du premier finit toujours
 * par le contredire, exactement au moment où une session se termine.
 *
 * Il n'y a pas non plus de moitié navigateur, et ce n'est pas un oubli : la socket
 * ponte vers un fournisseur, et il n'y en a pas. Un droit changé en base arrive donc
 * à la requête SUIVANTE au lieu d'arriver en quelques secondes.
 */
interface NotesAnswer {
  reader: string;
  notes: { id: number; title: string; body: string; owner: string }[];
}

const { data: session } = await useFetch<{ data: SsoMe }>("/api/auth/session");
const { data: notes, error: notesError } = await useFetch<NotesAnswer>("/api/notes");

const me = computed(() => session.value?.data ?? null);
const refused = computed(() => (notesError.value as { statusCode?: number } | null)?.statusCode ?? null);

async function logout() {
  await $fetch("/api/auth/logout", { method: "POST" });
  window.location.assign("/login");
}
</script>

<template>
  <div class="space-y-8">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="space-y-1">
        <h1 class="text-2xl font-semibold text-white">{{ me?.user.displayName || "Session" }}</h1>
        <p class="text-sm text-slate-400">{{ me?.user.email }}</p>
      </div>
      <UButton color="neutral" variant="subtle" icon="i-lucide-log-out" @click="logout">Se déconnecter</UButton>
    </div>

    <div class="grid gap-4 sm:grid-cols-3">
      <UCard :ui="{ body: 'space-y-1' }">
        <p class="text-xs uppercase tracking-wide text-slate-500">Annuaire</p>
        <p class="text-sm font-medium text-white">app_sso_accounts</p>
        <p class="text-xs text-slate-500">relu à chaque requête</p>
      </UCard>
      <UCard :ui="{ body: 'space-y-1' }">
        <p class="text-xs uppercase tracking-wide text-slate-500">Droits</p>
        <p class="text-sm font-medium text-white">{{ me?.permissions.global.length ?? 0 }}</p>
        <p class="text-xs text-slate-500">{{ me?.permissions.isRoot ? "isRoot : passe tout" : "liste explicite" }}</p>
      </UCard>
      <UCard :ui="{ body: 'space-y-1' }">
        <p class="text-xs uppercase tracking-wide text-slate-500">Fournisseur</p>
        <p class="text-sm font-medium text-white">aucun</p>
        <p class="text-xs text-slate-500">ni appairage ni socket</p>
      </UCard>
    </div>

    <section class="space-y-3">
      <h2 class="text-sm font-semibold text-white">
        Les données de l'application, derrière <code class="text-primary-400">read:note</code>
      </h2>

      <UAlert
        v-if="refused"
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        :title="`Refusé (${refused})`"
        description="Ce compte n'a pas read:note. La session est pourtant bien ouverte - c'est exactement la séparation que ce mode doit reproduire."
      />

      <div v-else-if="notes" class="space-y-2">
        <p class="text-xs text-slate-500">Lues pour {{ notes.reader }}.</p>
        <UCard v-for="note in notes.notes" :key="note.id" :ui="{ body: 'space-y-1' }">
          <p class="text-sm font-medium text-white">{{ note.title }}</p>
          <p class="text-sm text-slate-400">{{ note.body }}</p>
          <p class="font-mono text-[11px] text-slate-600">owner = {{ note.owner }}</p>
        </UCard>
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-semibold text-white">Le compte, à la forme que x-core répondrait</h2>
      <pre class="overflow-x-auto rounded-lg border border-white/10 bg-slate-900/60 p-4 font-mono text-xs text-slate-300">{{
        JSON.stringify(me, null, 2)
      }}</pre>
    </section>

    <UAlert
      color="neutral"
      variant="subtle"
      icon="i-lucide-database"
      title="Ce qu'il n'y a pas en base"
      description="Ni table de sessions, ni mot de passe en clair. Trois tables : app_sso_settings, où la librairie garde le mot de passe qui scelle le cookie ; app_sso_accounts, l'annuaire et la cible de clé étrangère ; notes, les données de cette application."
    />
  </div>
</template>
