export interface RuntimeConfig {
  remoteOnly: boolean
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on'])

export function getRuntimeConfig(): RuntimeConfig {
  return {
    remoteOnly: TRUE_VALUES.has((process.env.FULCRUM_REMOTE_ONLY ?? '').toLowerCase()),
  }
}
