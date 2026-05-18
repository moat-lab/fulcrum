export type MultiplexerKind = 'dtach' | 'tmux'

export interface MultiplexerSessionInfo {
  id: string
  name: string
  createdAt: number | null
  attached: boolean
}

export interface RemoteSessionOptions {
  remoteDir: string
  cwd: string
  env?: Record<string, string>
}

interface MultiplexerServiceBase {
  readonly kind: MultiplexerKind
  getSessionIdentifier(terminalId: string): string
  hasSession(terminalId: string): boolean
  validateSession(terminalId: string): boolean
  getLocalCreateCommand(terminalId: string): string[]
  getRemoteCreateCommand(terminalId: string, options: RemoteSessionOptions): string
  getLocalAttachCommand(terminalId: string): string[]
  getRemoteAttachCommand(terminalId: string, remoteDir: string): string
  killSession(terminalId: string): void
  killAgentInSession(terminalId: string): boolean
  isAvailable(): boolean
}

export interface DtachMultiplexer extends MultiplexerServiceBase {
  readonly kind: 'dtach'
}

export interface TmuxMultiplexer extends MultiplexerServiceBase {
  readonly kind: 'tmux'
  capturePaneContent(sessionId: string): string
  sendKeys(sessionId: string, keys: string): void
  listManagedSessions(): MultiplexerSessionInfo[]
}

export type MultiplexerService = DtachMultiplexer | TmuxMultiplexer
