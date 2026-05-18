import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { execSync } from 'child_process'
import { setupTestEnv, type TestEnv } from '../__tests__/utils/env'
import { TmuxService, getTmuxService, resetTmuxService } from './tmux-service'
import { getDescendantPids, isAgentProcess } from './process-utils'

function tmuxAvailable(): boolean {
  try {
    execSync('which tmux', { encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

function cleanupSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${name} 2>/dev/null`)
  } catch {
    // ignore
  }
}

describe('TmuxService', () => {
  let testEnv: TestEnv

  beforeEach(() => {
    testEnv = setupTestEnv()
    resetTmuxService()
  })

  afterEach(() => {
    testEnv.cleanup()
  })

  describe('kind', () => {
    test('returns tmux', () => {
      const service = new TmuxService()
      expect(service.kind).toBe('tmux')
    })
  })

  describe('isAvailable', () => {
    test('returns boolean indicating tmux availability', () => {
      const service = new TmuxService()
      const available = service.isAvailable()
      expect(typeof available).toBe('boolean')
      if (tmuxAvailable()) {
        expect(available).toBe(true)
      }
    })
  })

  describe('getSessionIdentifier', () => {
    test('returns fulcrum-prefixed session name', () => {
      const service = new TmuxService()
      const name = service.getSessionIdentifier('test-terminal-id')
      expect(name).toBe('fulcrum-test-terminal-id')
    })

    test('returns consistent name for same terminal ID', () => {
      const service = new TmuxService()
      const name1 = service.getSessionIdentifier('my-terminal')
      const name2 = service.getSessionIdentifier('my-terminal')
      expect(name1).toBe(name2)
    })

    test('returns different names for different terminal IDs', () => {
      const service = new TmuxService()
      const name1 = service.getSessionIdentifier('terminal-1')
      const name2 = service.getSessionIdentifier('terminal-2')
      expect(name1).not.toBe(name2)
    })
  })

  describe('hasSession', () => {
    test('returns false for non-existent session', () => {
      if (!tmuxAvailable()) return
      const service = new TmuxService()
      expect(service.hasSession('nonexistent-terminal-999')).toBe(false)
    })
  })

  describe('getLocalCreateCommand', () => {
    test('returns tmux new-session command with correct flags', () => {
      const service = new TmuxService()
      const cmd = service.getLocalCreateCommand('test-id')

      expect(cmd[0]).toBe('tmux')
      expect(cmd[1]).toBe('new-session')
      expect(cmd).toContain('-d')
      expect(cmd).toContain('-s')
      expect(cmd).toContain('fulcrum-test-id')
    })

    test('uses SHELL env var or defaults to /bin/bash', () => {
      const originalShell = process.env.SHELL

      process.env.SHELL = '/bin/zsh'
      const service1 = new TmuxService()
      const cmd1 = service1.getLocalCreateCommand('test-1')
      expect(cmd1).toContain('/bin/zsh')

      delete process.env.SHELL
      const service2 = new TmuxService()
      const cmd2 = service2.getLocalCreateCommand('test-2')
      expect(cmd2).toContain('/bin/bash')

      if (originalShell) {
        process.env.SHELL = originalShell
      }
    })
  })

  describe('getLocalAttachCommand', () => {
    test('returns tmux attach-session command', () => {
      const service = new TmuxService()
      const cmd = service.getLocalAttachCommand('test-id')

      expect(cmd[0]).toBe('tmux')
      expect(cmd[1]).toBe('attach-session')
      expect(cmd).toContain('-t')
      expect(cmd).toContain('fulcrum-test-id')
    })
  })

  describe('getRemoteCreateCommand', () => {
    test('returns shell command with cd and tmux new-session', () => {
      const service = new TmuxService()
      const cmd = service.getRemoteCreateCommand('test-id', {
        remoteDir: '/home/user/.fulcrum/sockets',
        cwd: '/home/user/project',
      })

      expect(cmd).toContain('cd /home/user/project')
      expect(cmd).toContain('tmux new-session -d -s fulcrum-test-id bash -li')
    })

    test('includes env exports when provided', () => {
      const service = new TmuxService()
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
    test('returns tmux attach-session command string', () => {
      const service = new TmuxService()
      const cmd = service.getRemoteAttachCommand('test-id', '/home/user/.fulcrum/sockets')

      expect(cmd).toContain('tmux attach-session -t fulcrum-test-id')
    })
  })

  describe('getTmuxService', () => {
    test('returns TmuxService instance', () => {
      const service = getTmuxService()
      expect(service).toBeInstanceOf(TmuxService)
    })

    test('returns same instance on subsequent calls (singleton)', () => {
      const service1 = getTmuxService()
      const service2 = getTmuxService()
      expect(service1).toBe(service2)
    })
  })

  describe('resetTmuxService', () => {
    test('clears singleton so next call creates new instance', () => {
      const service1 = getTmuxService()
      resetTmuxService()
      const service2 = getTmuxService()
      expect(service1).not.toBe(service2)
    })
  })

  describe('killSession', () => {
    test('does not throw for non-existent session', () => {
      const service = new TmuxService()
      expect(() => service.killSession('nonexistent-999')).not.toThrow()
    })
  })

  describe('killAgentInSession', () => {
    test('returns false for non-existent session', () => {
      if (!tmuxAvailable()) return
      const service = new TmuxService()
      const result = service.killAgentInSession('nonexistent-999')
      expect(result).toBe(false)
    })
  })

  describe('live tmux integration', () => {
    const testTerminalId = `test-${Date.now()}`
    const testSessionName = `fulcrum-${testTerminalId}`

    afterEach(() => {
      cleanupSession(testSessionName)
    })

    test('create, has, validate, capture, sendKeys, list, kill round-trip', () => {
      if (!tmuxAvailable()) return

      const service = new TmuxService()

      const cmd = service.getLocalCreateCommand(testTerminalId)
      execSync(cmd.join(' '))

      expect(service.hasSession(testTerminalId)).toBe(true)
      expect(service.validateSession(testTerminalId)).toBe(true)

      const marker = `FULCRUM_TEST_MARKER_${Date.now()}`
      service.sendKeys(testSessionName, `echo ${marker}`)

      // Give tmux time to process
      execSync('sleep 0.3')

      const content = service.capturePaneContent(testSessionName)
      expect(content).toContain(marker)

      const managed = service.listManagedSessions()
      const found = managed.find((s) => s.name === testSessionName)
      expect(found).toBeDefined()
      expect(found!.id).toBe(testTerminalId)

      service.killSession(testTerminalId)
      expect(service.hasSession(testTerminalId)).toBe(false)
    })

    test('listManagedSessions filters out non-fulcrum sessions', () => {
      if (!tmuxAvailable()) return

      const service = new TmuxService()
      const userSession = `user-test-${Date.now()}`

      const cmd = service.getLocalCreateCommand(testTerminalId)
      execSync(cmd.join(' '))
      execSync(`tmux new-session -d -s ${userSession} /bin/sh`)

      try {
        const managed = service.listManagedSessions()
        const fulcrumFound = managed.find((s) => s.name === testSessionName)
        const userFound = managed.find((s) => s.name === userSession)

        expect(fulcrumFound).toBeDefined()
        expect(userFound).toBeUndefined()
      } finally {
        cleanupSession(userSession)
      }
    })

    test('killAgentInSession kills agent process and leaves session alive', () => {
      if (!tmuxAvailable()) return

      const service = new TmuxService()
      const killTestId = `kill-agent-${Date.now()}`
      const killTestSession = `fulcrum-${killTestId}`

      try {
        const cmd = service.getLocalCreateCommand(killTestId)
        execSync(cmd.join(' '))
        expect(service.hasSession(killTestId)).toBe(true)

        service.sendKeys(killTestSession, "bash -c 'exec -a claude sleep 60' &")
        execSync('sleep 0.5')

        const panePidStr = execSync(
          `tmux list-panes -t ${killTestSession} -F '#{pane_pid}'`,
          { encoding: 'utf-8' },
        ).trim()
        const panePid = parseInt(panePidStr, 10)
        const descendants = getDescendantPids(panePid)
        const agentPid = descendants.find((pid) => isAgentProcess(pid))
        expect(agentPid).toBeDefined()

        const result = service.killAgentInSession(killTestId)
        expect(result).toBe(true)

        execSync('sleep 0.2')
        expect(() => process.kill(agentPid!, 0)).toThrow()

        expect(service.hasSession(killTestId)).toBe(true)
      } finally {
        cleanupSession(killTestSession)
      }
    })
  })
})
