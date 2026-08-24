// Plain JavaScript, not TypeScript, and on purpose: Next parses this file at BOOT,
// and a `.ts` config makes that parse depend on `typescript` being installed. It is
// a devDependency, so the production image does not have it - and what that produces
// is a container that builds perfectly and refuses to start.
//
// Nothing to configure anyway. The custom server in `server.ts` is what this POC is
// about, and it is not declared here: it owns the HTTP server and hands Next the
// requests that are Next's.

/** @type {import('next').NextConfig} */
export default {
  // Several lockfiles live above this folder, and Turbopack picks a root from them.
  // Named here so the choice is this file's rather than a heuristic's.
  turbopack: { root: import.meta.dirname },
};
