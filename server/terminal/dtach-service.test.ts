import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { DtachService, getDtachService, getMultiplexerService, resolveMultiplexerKind, resetMultiplexerService } from './dtach-service'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

describe('DtachService', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  describe('kind', () => {
    test('returns dtach', () => {
      const service = new DtachService()
      expect(service.kind).toBe('dtach')
    })
  })

  describe('isAvailable', () => {
    test('returns boolean indicating dtach availability', () => {
      const service = new DtachService()
      const available = service.isAvailable()
      expect(typeof available).toBe('boolean')
    })
  })

  describe('constructor', () => {
    test('creates sockets directory if it does not exist', () => {
      new DtachService()
      const socketsDir = join(testEnv.fulcrumDir, 'sockets')
      expect(existsSync(socketsDir)).toBe(true)
    })
  })

  describe('getSessionIdentifier', () => {
    test('returns path in sockets directory', () => {
      const service = new DtachService()
      const socketPath = service.getSessionIdentifier('test-terminal-id')

      expect(socketPath).toContain('sockets')
      expect(socketPath).toContain('terminal-test-terminal-id.sock')
    })

    test('returns consistent path for same terminal ID', () => {
      const service = new DtachService()
      const path1 = service.getSessionIdentifier('my-terminal')
      const path2 = service.getSessionIdentifier('my-terminal')

      expect(path1).toBe(path2)
    })

    test('returns different paths for different terminal IDs', () => {
      const service = new DtachService()
      const path1 = service.getSessionIdentifier('terminal-1')
      const path2 = service.getSessionIdentifier('terminal-2')

      expect(path1).not.toBe(path2)
    })
  })

  describe('hasSession', () => {
    test('returns false for non-existent session', () => {
      const service = new DtachService()
      expect(service.hasSession('nonexistent-terminal')).toBe(false)
    })
  })

  describe('getLocalCreateCommand', () => {
    test('returns dtach command with correct flags', () => {
      const service = new DtachService()
      const cmd = service.getLocalCreateCommand('test-id')

      expect(cmd[0]).toBe('dtach')
      expect(cmd).toContain('-n')
      expect(cmd).toContain('-z')
      expect(cmd).toContain('-li')
    })

    test('uses SHELL env var or defaults to /bin/bash', () => {
      const originalShell = process.env.SHELL

      process.env.SHELL = '/bin/zsh'
      const service1 = new DtachService()
      const cmd1 = service1.getLocalCreateCommand('test-1')
      expect(cmd1).toContain('/bin/zsh')

      delete process.env.SHELL
      const service2 = new DtachService()
      const cmd2 = service2.getLocalCreateCommand('test-2')
      expect(cmd2).toContain('/bin/bash')

      if (originalShell) {
        process.env.SHELL = originalShell
      }
    })

    test('includes socket path in command', () => {
      const service = new DtachService()
      const cmd = service.getLocalCreateCommand('test-id')
      const socketPath = service.getSessionIdentifier('test-id')

      expect(cmd).toContain(socketPath)
    })
  })

  describe('getLocalAttachCommand', () => {
    test('returns bash wrapper command', () => {
      const service = new DtachService()
      const cmd = service.getLocalAttachCommand('test-id')

      expect(cmd[0]).toBe('bash')
      expect(cmd).toContain('-c')
    })

    test('includes stty -echoctl to suppress control char echo', () => {
      const service = new DtachService()
      const cmd = service.getLocalAttachCommand('test-id')
      const bashCommand = cmd.find((arg) => arg.includes('stty'))

      expect(bashCommand).toBeDefined()
      expect(bashCommand).toContain('stty -echoctl')
    })

    test('includes dtach -a with socket path', () => {
      const service = new DtachService()
      const cmd = service.getLocalAttachCommand('test-id')
      const socketPath = service.getSessionIdentifier('test-id')
      const bashCommand = cmd.find((arg) => arg.includes('dtach'))

      expect(bashCommand).toBeDefined()
      expect(bashCommand).toContain('dtach -a')
      expect(bashCommand).toContain(socketPath)
      expect(bashCommand).toContain('-z')
    })

    test('uses exec to replace wrapper shell with dtach', () => {
      const service = new DtachService()
      const cmd = service.getLocalAttachCommand('test-id')
      const bashCommand = cmd.find((arg) => arg.includes('exec'))

      expect(bashCommand).toBeDefined()
      expect(bashCommand).toContain('exec dtach')
    })
  })

  describe('getRemoteCreateCommand', () => {
    test('returns shell command with mkdir, cd, and dtach -n', () => {
      const service = new DtachService()
      const cmd = service.getRemoteCreateCommand('test-id', {
        remoteDir: '/home/user/.fulcrum/sockets',
        cwd: '/home/user/project',
      })

      expect(cmd).toContain('mkdir -p /home/user/.fulcrum/sockets')
      expect(cmd).toContain('cd /home/user/project')
      expect(cmd).toContain('dtach -n /home/user/.fulcrum/sockets/terminal-test-id.sock -z bash -li')
    })

    test('includes env exports when provided', () => {
      const service = new DtachService()
      const cmd = service.getRemoteCreateCommand('test-id', {
        remoteDir: '/home/user/.fulcrum/sockets',
        cwd: '/home/user/project',
        env: { FULCRUM_URL: 'http://localhost:7777', TERM: 'xterm-256color' },
      })

      expect(cmd).toContain('export FULCRUM_URL=http://localhost:7777')
      expect(cmd).toContain('export TERM=xterm-256color')
    })
  })

  describe('getRemoteAttachCommand', () => {
    test('returns stty + exec dtach -a command', () => {
      const service = new DtachService()
      const cmd = service.getRemoteAttachCommand('test-id', '/home/user/.fulcrum/sockets')

      expect(cmd).toContain('stty -echoctl')
      expect(cmd).toContain('exec dtach -a /home/user/.fulcrum/sockets/terminal-test-id.sock -z')
    })
  })

  describe('getMultiplexerService', () => {
    test('returns DtachService for dtach kind', () => {
      const service = getMultiplexerService('dtach')
      expect(service).toBeInstanceOf(DtachService)
      expect(service.kind).toBe('dtach')
    })

    test('returns same instance on subsequent calls (singleton)', () => {
      const service1 = getMultiplexerService('dtach')
      const service2 = getMultiplexerService('dtach')
      expect(service1).toBe(service2)
    })

    test('returns TmuxService for tmux kind', () => {
      const service = getMultiplexerService('tmux')
      expect(service.kind).toBe('tmux')
    })
  })

  describe('getDtachService', () => {
    test('returns DtachService instance', () => {
      const service = getDtachService()
      expect(service).toBeInstanceOf(DtachService)
    })

    test('returns same instance on subsequent calls (singleton)', () => {
      const service1 = getDtachService()
      const service2 = getDtachService()
      expect(service1).toBe(service2)
    })
  })

  describe('resetMultiplexerService', () => {
    test('clears singleton so next call creates new instance', () => {
      const service1 = getDtachService()
      resetMultiplexerService()
      const service2 = getDtachService()
      expect(service1).not.toBe(service2)
    })
  })

  describe('resolveMultiplexerKind', () => {
    test('explicit dtach returns dtach', () => {
      const kind = resolveMultiplexerKind('dtach')
      expect(kind).toBe('dtach')
    })

    test('auto returns a valid MultiplexerKind', () => {
      const kind = resolveMultiplexerKind('auto')
      expect(['dtach', 'tmux']).toContain(kind)
    })

    test('explicit tmux throws when tmux is not available', () => {
      const tmuxService = getMultiplexerService('tmux')
      const originalIsAvailable = tmuxService.isAvailable.bind(tmuxService)
      tmuxService.isAvailable = () => false
      try {
        expect(() => resolveMultiplexerKind('tmux')).toThrow('not available')
      } finally {
        tmuxService.isAvailable = originalIsAvailable
      }
    })
  })

  describe('killSession', () => {
    test('does not throw for non-existent session', () => {
      const service = new DtachService()
      expect(() => service.killSession('nonexistent')).not.toThrow()
    })
  })

  describe('killAgentInSession', () => {
    test('returns false for non-existent session', () => {
      const service = new DtachService()
      const result = service.killAgentInSession('nonexistent')
      expect(result).toBe(false)
    })
  })
})
