// Connecting a platform: every built-in says what pressing Connect does, and the setup walkthroughs only ask
// for fields the connector has, explain every required key, link to https pages and catch common mix-ups.

import { describe, expect, it } from 'vitest'
import { BUILTINS } from '../src/connectors'
import type { FieldSpec } from '../src/shared/types'

const field = (id: string, key: string): FieldSpec => {
  const m = BUILTINS.find((c) => c.manifest.id === id)!.manifest
  return [...m.settings, ...m.connectFields].find((f) => f.key === key)!
}
const accepts = (f: FieldSpec, v: string) => new RegExp(f.pattern!).test(v)

describe('connecting', () => {
  for (const c of BUILTINS) {
    const m = c.manifest
    describe(m.name, () => {
      it('says in plain words what pressing Connect does', () => {
        expect(m.signIn?.length ?? 0).toBeGreaterThan(40)
      })
      it('has patterns that compile', () => {
        for (const f of [...m.settings, ...m.connectFields]) if (f.pattern) expect(() => new RegExp(f.pattern!), f.key).not.toThrow()
      })
      it('can be connected by just signing in, unless it has a login of its own', () => {
        // Rednote and Bilibili sign in directly; the platforms with an official API also offer the website way.
        if (m.guide) expect(m.web?.signIn.length ?? 0, 'web sign-in').toBeGreaterThan(40)
        for (const f of m.web?.fields ?? []) expect(f.required, f.key).toBeFalsy()
      })
      if (!m.guide) return
      const g = m.guide
      const known = new Set([...m.settings.map((s) => s.key), ...m.connectFields.map((f) => f.key)])
      it('only asks for fields the connector has', () => {
        for (const s of g.steps) for (const k of s.fields ?? []) expect(known.has(k), k).toBe(true)
      })
      it('explains every key it needs', () => {
        const asked = new Set(g.steps.flatMap((s) => s.fields ?? []))
        for (const f of [...m.settings, ...m.connectFields]) if (f.required && f.default === undefined) expect(asked.has(f.key), f.key).toBe(true)
      })
      it('links to https pages and only uses placeholders it can fill', () => {
        for (const s of g.steps) if (s.link) expect(s.link.url).toMatch(/^https:\/\/[^\s]+$/)
        const texts = [
          g.why,
          g.warning ?? '',
          m.signIn ?? '',
          ...g.steps.flatMap((s) => [s.text, s.detail ?? '', ...(s.copy ?? []).map((x) => x.value)]),
          ...(g.trouble ?? []).flatMap((t) => [t.problem, t.fix])
        ]
        for (const t of texts) for (const [, k] of t.matchAll(/\{(\w+)\}/g)) expect(m.settings.some((f) => f.key === k), `{${k}}`).toBe(true)
      })
      it('says “step N” only for steps that exist', () => {
        const all = [...g.steps.flatMap((s) => [s.text, s.detail ?? '']), ...(g.trouble ?? []).map((t) => t.fix)]
        const fieldHints = [...m.settings, ...m.connectFields].map((f) => f.mismatch ?? '')
        for (const t of [...all, ...fieldHints]) for (const [, n] of t.matchAll(/step (\d+)/g)) expect(Number(n)).toBeLessThanOrEqual(g.steps.length)
      })
      it('says what to have ready, how long it takes and what usually goes wrong', () => {
        expect(g.why.length).toBeGreaterThan(40)
        expect(g.need.length).toBeGreaterThan(0)
        expect(g.time).toMatch(/minute/)
        expect(g.trouble?.length ?? 0).toBeGreaterThan(1)
      })
    })
  }
})

describe('pasted values', () => {
  // Made-up values shaped like the real ones, assembled at runtime so secret scanners don't take them for keys.
  const fake = {
    googleId: `123456789012-${'a1'.repeat(16)}.apps.googleusercontent.com`,
    googleSecret: ['GOCSPX', 'x'.repeat(28)].join('-'),
    googleApiKey: ['AI', 'za', 'Sy'].join('') + 'Q'.repeat(33),
    xClientId: Buffer.from('px_4zLEmAxRtgdyOwYhQ:1:ci').toString('base64').replace(/=+$/, ''),
    xApiKey: 'k'.repeat(25),
    xClientSecret: 's'.repeat(50),
    igToken: ['IG', 'AA'].join('') + 'Q'.repeat(40),
    fbToken: ['EA', 'AG'].join('') + 'm'.repeat(20)
  }
  it('YouTube: a Google desktop client ID and secret pass, mix-ups are caught', () => {
    const id = field('youtube', 'clientId')
    expect(accepts(id, fake.googleId)).toBe(true)
    expect(accepts(id, fake.googleSecret)).toBe(false)
    expect(accepts(id, fake.googleApiKey)).toBe(false)
    const secret = field('youtube', 'clientSecret')
    expect(accepts(secret, fake.googleSecret)).toBe(true)
    expect(accepts(secret, fake.googleId)).toBe(false)
  })
  it('X: an OAuth 2.0 client ID passes; the API key or client secret does not', () => {
    const id = field('x', 'clientId')
    expect(accepts(id, fake.xClientId)).toBe(true)
    expect(accepts(id, fake.xApiKey)).toBe(false)
    expect(accepts(id, fake.xClientSecret)).toBe(false)
  })
  it('Instagram: an Instagram-login token passes; a Facebook token does not', () => {
    const t = field('instagram', 'accessToken')
    expect(accepts(t, fake.igToken)).toBe(true)
    expect(accepts(t, fake.fbToken)).toBe(false)
  })
})
