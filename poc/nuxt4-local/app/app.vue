<template>
  <div class="shell">
    <header>
      <strong>POC mode local</strong>
      <span class="muted">node-sso-consumer, sans fournisseur</span>
    </header>
    <main>
      <NuxtPage />
    </main>
  </div>
</template>

<style>
:root {
  color-scheme: dark;
  --bg: #0d1117;
  --fg: #e6edf3;
  --muted: #8b949e;
  --line: #30363d;
  --accent: #58a6ff;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
.shell {
  max-width: 46rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
}
header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.75rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--line);
  margin-bottom: 1.5rem;
}
.muted {
  color: var(--muted);
}
h1 {
  font-size: 1.4rem;
  margin: 0 0 0.5rem;
}
h2 {
  font-size: 1.05rem;
  margin: 2rem 0 0.75rem;
}
a {
  color: var(--accent);
}
code,
pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.86em;
}
pre {
  background: #161b22;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.75rem;
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  text-align: left;
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
th {
  color: var(--muted);
  font-weight: 500;
}
label {
  display: block;
  margin-bottom: 0.9rem;
}
label span {
  display: block;
  color: var(--muted);
  margin-bottom: 0.25rem;
}
input {
  width: 100%;
  padding: 0.5rem 0.6rem;
  background: #161b22;
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 6px;
}
button {
  padding: 0.5rem 1rem;
  background: var(--accent);
  color: #0d1117;
  border: 0;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.error {
  color: #ff7b72;
}
</style>
