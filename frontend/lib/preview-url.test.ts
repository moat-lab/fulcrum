import { describe, test, expect } from 'bun:test'
import { getDefaultBrowserUrl, normalizeBrowserUrl } from './preview-url'

describe('getDefaultBrowserUrl', () => {
  test('uses Tailscale IPv4 when available', () => {
    expect(getDefaultBrowserUrl('100.101.102.103')).toBe('http://100.101.102.103:3000')
  })

  test('falls back to localhost when Tailscale IPv4 is unavailable', () => {
    expect(getDefaultBrowserUrl(null)).toBe('http://localhost:3000')
  })
})

describe('normalizeBrowserUrl', () => {
  test('preserves explicit http URL as typed', () => {
    expect(normalizeBrowserUrl('http://localhost:5173/demo?x=1')).toBe('http://localhost:5173/demo?x=1')
  })

  test('preserves explicit https URL as typed', () => {
    expect(normalizeBrowserUrl('https://example.com/app')).toBe('https://example.com/app')
  })

  test('adds http scheme only when user omits one', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173')
  })
})
