'use client'

import { useActionState } from 'react'
import { signIn } from './actions'

export function LoginForm() {
  const [state, submit, pending] = useActionState(signIn, { refused: false })

  return (
    <form action={submit} className="space-y-4">
      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-wide text-slate-500">Email</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          className="w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs uppercase tracking-wide text-slate-500">Mot de passe</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
        />
      </label>

      {state.refused && <p className="text-sm text-red-400">Email ou mot de passe incorrect.</p>}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {pending ? '…' : 'Se connecter'}
      </button>
    </form>
  )
}
