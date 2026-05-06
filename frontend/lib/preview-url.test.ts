import { describe, test, expect } from 'bun:test'
import { rewriteLocalhostForPreview } from './preview-url'

describe('rewriteLocalhostForPreview', () => {
  const tailnet = 'citadel.tail-abcd.ts.net'

  test('passes through when tailscaleHostname is null', () => {
    expect(rewriteLocalhostForPreview('http://localhost:5173', null, 'citadel.fulcrum.example.com'))
      .toBe('http://localhost:5173')
  })

  test('passes through when UI is on localhost', () => {
    expect(rewriteLocalhostForPreview('http://localhost:5173', tailnet, 'localhost:6666'))
      .toBe('http://localhost:5173')
    expect(rewriteLocalhostForPreview('http://localhost:5173', tailnet, '127.0.0.1:7777'))
      .toBe('http://localhost:5173')
  })

  test('rewrites localhost host to tailnet hostname when UI is remote', () => {
    expect(rewriteLocalhostForPreview('http://localhost:5173', tailnet, 'citadel.fulcrum.example.com'))
      .toBe(`http://${tailnet}:5173/`)
  })

  test('rewrites 127.0.0.1', () => {
    expect(rewriteLocalhostForPreview('http://127.0.0.1:3000', tailnet, 'citadel.fulcrum.example.com'))
      .toBe(`http://${tailnet}:3000/`)
  })

  test('preserves non-localhost URLs', () => {
    expect(rewriteLocalhostForPreview('https://example.com', tailnet, 'citadel.fulcrum.example.com'))
      .toBe('https://example.com')
  })

  test('preserves https scheme on rewrite', () => {
    expect(rewriteLocalhostForPreview('https://localhost:5173', tailnet, 'citadel.fulcrum.example.com'))
      .toBe(`https://${tailnet}:5173/`)
  })

  test('preserves path and query', () => {
    expect(rewriteLocalhostForPreview(
      'http://localhost:5173/foo?bar=1',
      tailnet,
      'citadel.fulcrum.example.com',
    )).toBe(`http://${tailnet}:5173/foo?bar=1`)
  })

  test('returns invalid URLs untouched', () => {
    expect(rewriteLocalhostForPreview('not a url', tailnet, 'citadel.fulcrum.example.com'))
      .toBe('not a url')
  })

  test('returns empty string untouched', () => {
    expect(rewriteLocalhostForPreview('', tailnet, 'citadel.fulcrum.example.com')).toBe('')
  })
})
