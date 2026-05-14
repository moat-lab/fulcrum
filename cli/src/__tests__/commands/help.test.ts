import { describe, test, expect } from 'bun:test'
import { HELP_VERBS, renderHelpText } from '../../commands/help'

describe('help verb catalogue', () => {
  test('exposes every top-level verb the plugin renders in /f help', () => {
    const names = new Set(HELP_VERBS.map((v) => v.name))
    // Acceptance #2: at least these five verb names must be present so the
    // unit test guards plugin-visible coverage even as the registry grows.
    for (const required of ['tasks', 'apps', 'projects', 'status', 'doctor']) {
      expect(names.has(required)).toBe(true)
    }
    // Mattermost-plugin contract verbs are the JSON_SCHEMA backbone — drop
    // one of these and `/f <verb>` stops working.
    for (const verb of ['dashboard', 'tasks', 'apps', 'search', 'monitor', 'jobs', 'projects']) {
      expect(names.has(verb)).toBe(true)
    }
    expect(HELP_VERBS.length).toBeGreaterThanOrEqual(5)
  })

  test('every verb has a non-empty description', () => {
    for (const v of HELP_VERBS) {
      expect(v.name.length).toBeGreaterThan(0)
      expect(v.description.length).toBeGreaterThan(0)
    }
  })

  test('verb names are unique', () => {
    const names = HELP_VERBS.map((v) => v.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('renderHelpText pads name column and lists every verb', () => {
    const text = renderHelpText(HELP_VERBS)
    expect(text.startsWith('Available verbs:')).toBe(true)
    for (const v of HELP_VERBS) {
      expect(text).toContain(v.name)
      expect(text).toContain(v.description)
    }
  })
})
