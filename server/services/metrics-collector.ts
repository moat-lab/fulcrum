import os from 'node:os'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { db } from '../db'
import { hosts, systemMetrics } from '../db/schema'
import { desc, eq, lt } from 'drizzle-orm'
import { log } from '../lib/logger'
import { getSSHConnectionManager, type SSHConnectionConfig } from '../terminal/ssh-connection-manager'

const COLLECT_INTERVAL = 5_000 // 5 seconds
const REMOTE_COLLECT_INTERVAL = 60_000 // 1 minute
const RETENTION_HOURS = 24
const LOCAL_HOST_ID = 'local'
const isMacOS = process.platform === 'darwin'

interface CpuSnapshot {
  idle: number
  total: number
}

interface MemoryInfo {
  total: number
  used: number // Actual used (excluding cache/buffers)
  cache: number // Cache + Buffers
}

interface RawMetricSnapshot {
  cpuPercent: number
  memory: MemoryInfo
  disk: { used: number; total: number }
}

export type HostHealthStatus = 'connected' | 'disconnected' | 'degraded'

export interface HostMetricSummary {
  id: string
  name: string
  status: HostHealthStatus
  lastSeenAt: number | null
  current: CurrentMetrics
}

export interface CurrentMetrics {
  cpu: number
  memory: { total: number; used: number; cache: number; usedPercent: number; cachePercent: number }
  disk: { total: number; used: number; usedPercent: number; path: string }
}

// Parse memory info using platform-specific methods
// Returns memory values in bytes
function getMemoryInfo(): MemoryInfo {
  if (isMacOS) {
    return getMemoryInfoMacOS()
  }
  return getMemoryInfoLinux()
}

// macOS: Use vm_stat and sysctl for accurate memory breakdown
function getMemoryInfoMacOS(): MemoryInfo {
  try {
    // Get total memory from sysctl
    const totalStr = execSync('sysctl -n hw.memsize', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    const total = parseInt(totalStr, 10)

    // Parse vm_stat output
    const vmstat = execSync('vm_stat', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Extract page size from first line: "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
    const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/)
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384

    // Parse page counts (format: "Pages free:                               19826.")
    const parsePages = (key: string): number => {
      const match = vmstat.match(new RegExp(`${key}:\\s+([\\d.]+)`))
      return match ? Math.floor(parseFloat(match[1])) : 0
    }

    const pagesActive = parsePages('Pages active')
    const pagesInactive = parsePages('Pages inactive')
    const pagesWired = parsePages('Pages wired down')
    const pagesCompressorOccupied = parsePages('Pages occupied by compressor')
    const pagesPurgeable = parsePages('Pages purgeable')

    // Calculate memory usage like Activity Monitor:
    // - Used = Wired + Active + Occupied by Compressor (actual RAM being used)
    // - Cache = Inactive + Purgeable (can be reclaimed if needed)
    const wiredBytes = pagesWired * pageSize
    const activeBytes = pagesActive * pageSize
    const compressorOccupiedBytes = pagesCompressorOccupied * pageSize
    const inactiveBytes = pagesInactive * pageSize
    const purgeableBytes = pagesPurgeable * pageSize

    const used = wiredBytes + activeBytes + compressorOccupiedBytes
    const cache = inactiveBytes + purgeableBytes

    return {
      total,
      used: Math.max(used, 0),
      cache: Math.max(cache, 0),
    }
  } catch (err) {
    log.metrics.error('Failed to get macOS memory info', { error: String(err) })
    // Fallback to basic Node.js API
    const total = os.totalmem()
    const free = os.freemem()
    return {
      total,
      used: total - free,
      cache: 0,
    }
  }
}

// Linux: Parse /proc/meminfo for accurate memory breakdown
function getMemoryInfoLinux(): MemoryInfo {
  const total = os.totalmem()

  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8')
    const values: Record<string, number> = {}

    for (const line of meminfo.split('\n')) {
      const match = line.match(/^(\w+):\s+(\d+)\s+kB/)
      if (match) {
        values[match[1]] = parseInt(match[2], 10) * 1024 // Convert kB to bytes
      }
    }

    const memTotal = values['MemTotal'] || total
    const memFree = values['MemFree'] || 0
    const buffers = values['Buffers'] || 0
    const cached = values['Cached'] || 0
    const sReclaimable = values['SReclaimable'] || 0
    const shmem = values['Shmem'] || 0

    // Calculate cache/buffers (like Beszel/htop)
    // Note: gopsutil adds SReclaimable to Cached, so we do the same
    let cacheBuffers = buffers + cached + sReclaimable - shmem
    if (cacheBuffers < 0) {
      cacheBuffers = 0
    }

    // Used = Total - Free - Buffers - Cached - SReclaimable + Shmem
    // This matches htop's "used" calculation
    const used = memTotal - memFree - buffers - cached - sReclaimable + shmem

    return {
      total: memTotal,
      used: Math.max(used, 0),
      cache: cacheBuffers,
    }
  } catch {
    // Fallback to basic Node.js API (includes cache in "used")
    const free = os.freemem()
    return {
      total,
      used: total - free,
      cache: 0,
    }
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null
let remoteIntervalId: ReturnType<typeof setInterval> | null = null
let pruneIntervalId: ReturnType<typeof setInterval> | null = null
let previousCpu: CpuSnapshot | null = null

// Calculate CPU usage by comparing current snapshot to previous
function getCpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus()
  let idle = 0
  let total = 0

  for (const cpu of cpus) {
    idle += cpu.times.idle
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
  }

  return { idle, total }
}

function calculateCpuPercent(): number {
  const current = getCpuSnapshot()

  if (!previousCpu) {
    previousCpu = current
    return 0
  }

  const idleDiff = current.idle - previousCpu.idle
  const totalDiff = current.total - previousCpu.total

  previousCpu = current

  if (totalDiff === 0) return 0

  const usedPercent = ((totalDiff - idleDiff) / totalDiff) * 100
  return Math.round(usedPercent * 100) / 100 // Round to 2 decimal places
}

// Get disk usage for root filesystem
function getDiskUsage(): { used: number; total: number } {
  try {
    if (isMacOS) {
      // macOS APFS: Query /System/Volumes/Data for user data volume
      // The root "/" is just a read-only system snapshot with minimal usage
      // Format: Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted
      const output = execSync('df -k /System/Volumes/Data 2>/dev/null || df -k /', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: '/bin/bash',
      })
      const lines = output.trim().split('\n')
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/)
        // parts[2] = used in KB, parts[3] = available in KB
        // Use (used + available) as total to match Finder/Disk Utility
        if (parts.length >= 4) {
          const used = (parseInt(parts[2], 10) || 0) * 1024 // Convert KB to bytes
          const available = (parseInt(parts[3], 10) || 0) * 1024
          const total = used + available
          return { used, total }
        }
      }
    } else {
      // Linux: Use df -B1 (bytes)
      const output = execSync('df -B1 / | tail -1', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const parts = output.trim().split(/\s+/)
      // Format: Filesystem 1B-blocks Used Available Use% Mounted
      if (parts.length >= 4) {
        const total = parseInt(parts[1], 10) || 0
        const used = parseInt(parts[2], 10) || 0
        return { used, total }
      }
    }
  } catch (err) {
    log.metrics.error('Failed to get disk usage', { error: String(err) })
  }

  return { used: 0, total: 0 }
}

function insertMetric(hostId: string, timestamp: number, snapshot: RawMetricSnapshot): void {
  db.insert(systemMetrics)
    .values({
      hostId,
      timestamp,
      cpuPercent: snapshot.cpuPercent,
      memoryUsedBytes: snapshot.memory.used,
      memoryTotalBytes: snapshot.memory.total,
      memoryCacheBytes: snapshot.memory.cache,
      diskUsedBytes: snapshot.disk.used,
      diskTotalBytes: snapshot.disk.total,
    })
    .run()
}

function collectMetrics(): void {
  const timestamp = Math.floor(Date.now() / 1000) // Unix timestamp in seconds
  insertMetric(LOCAL_HOST_ID, timestamp, {
    cpuPercent: calculateCpuPercent(),
    memory: getMemoryInfo(),
    disk: getDiskUsage(),
  })
}

function hostToSshConfig(host: typeof hosts.$inferSelect): SSHConnectionConfig {
  return {
    host: host.hostname,
    port: host.port,
    username: host.username,
    authMethod: host.authMethod as 'key' | 'password',
    privateKeyPath: host.privateKeyPath ?? undefined,
    hostFingerprint: host.hostFingerprint ?? undefined,
  }
}

function parseRemoteMetrics(output: string): RawMetricSnapshot {
  const values: Record<string, number> = {}
  for (const line of output.trim().split('\n')) {
    const [key, value] = line.split('=')
    if (key && value) values[key] = Number(value)
  }
  return {
    cpuPercent: values.cpu_percent ?? 0,
    memory: {
      total: values.memory_total ?? 0,
      used: values.memory_used ?? 0,
      cache: values.memory_cache ?? 0,
    },
    disk: {
      used: values.disk_used ?? 0,
      total: values.disk_total ?? 0,
    },
  }
}

function remoteMetricsCommand(): string {
  return `set -e
read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat
first_idle=$((idle + iowait))
first_total=$((user + nice + system + idle + iowait + irq + softirq + steal))
sleep 1
read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat
second_idle=$((idle + iowait))
second_total=$((user + nice + system + idle + iowait + irq + softirq + steal))
total_diff=$((second_total - first_total))
idle_diff=$((second_idle - first_idle))
if [ "$total_diff" -gt 0 ]; then cpu_percent=$((10000 * (total_diff - idle_diff) / total_diff)); else cpu_percent=0; fi
awk '
  /^MemTotal:/ { total=$2 * 1024 }
  /^MemFree:/ { free=$2 * 1024 }
  /^Buffers:/ { buffers=$2 * 1024 }
  /^Cached:/ { cached=$2 * 1024 }
  /^SReclaimable:/ { sreclaimable=$2 * 1024 }
  /^Shmem:/ { shmem=$2 * 1024 }
  END {
    cache=buffers + cached + sreclaimable - shmem
    if (cache < 0) cache=0
    used=total - free - buffers - cached - sreclaimable + shmem
    if (used < 0) used=0
    printf "memory_total=%.0f\\nmemory_used=%.0f\\nmemory_cache=%.0f\\n", total, used, cache
  }
' /proc/meminfo
df -B1 / | awk 'NR==2 { printf "disk_total=%s\\ndisk_used=%s\\n", $2, $3 }'
printf "cpu_percent=%s.%02d\\n" $((cpu_percent / 100)) $((cpu_percent % 100))`
}

async function collectRemoteHostMetrics(): Promise<void> {
  const remoteHosts = db.select().from(hosts).all()
  const manager = getSSHConnectionManager()
  const timestamp = Math.floor(Date.now() / 1000)

  await Promise.all(remoteHosts.map(async (host) => {
    try {
      const output = await manager.execCommand(hostToSshConfig(host), remoteMetricsCommand(), 10_000)
      insertMetric(host.id, timestamp, parseRemoteMetrics(output))
      if (host.status !== 'connected') {
        db.update(hosts).set({ status: 'connected', lastConnectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).where(eq(hosts.id, host.id)).run()
      }
    } catch (err) {
      db.update(hosts).set({ status: 'error', updatedAt: new Date().toISOString() }).where(eq(hosts.id, host.id)).run()
      log.metrics.warn('Failed to collect remote host metrics', { hostId: host.id, host: host.name, error: String(err) })
    }
  }))
}

function pruneOldMetrics(): void {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_HOURS * 60 * 60 // 24 hours ago
  const result = db.delete(systemMetrics).where(lt(systemMetrics.timestamp, cutoff)).run()

  if (result.changes > 0) {
    log.metrics.debug('Pruned old metrics records', { count: result.changes })
  }
}

export function startMetricsCollector(): void {
  if (intervalId) return // Already running

  log.metrics.info('Metrics collector started', { intervalSeconds: COLLECT_INTERVAL / 1000 })

  // Initialize CPU baseline
  previousCpu = getCpuSnapshot()

  // Collect immediately after a short delay (to get first CPU reading)
  setTimeout(() => {
    collectMetrics()
  }, 1000)

  // Then collect every 5 seconds
  intervalId = setInterval(() => {
    collectMetrics()
  }, COLLECT_INTERVAL)

  setTimeout(() => {
    void collectRemoteHostMetrics()
  }, 1000)

  remoteIntervalId = setInterval(() => {
    void collectRemoteHostMetrics()
  }, REMOTE_COLLECT_INTERVAL)

  // Prune old metrics every hour
  pruneIntervalId = setInterval(() => {
    pruneOldMetrics()
  }, 60 * 60 * 1000)

  // Prune once on startup
  pruneOldMetrics()
}

export function stopMetricsCollector(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    log.metrics.info('Metrics collector stopped')
  }
  if (remoteIntervalId) {
    clearInterval(remoteIntervalId)
    remoteIntervalId = null
  }
  if (pruneIntervalId) {
    clearInterval(pruneIntervalId)
    pruneIntervalId = null
  }
}

// Get metrics for a specific time window
export function getMetrics(
  windowSeconds: number,
  hostId = LOCAL_HOST_ID
): Array<{
  timestamp: number
  cpuPercent: number
  memoryUsedPercent: number
  memoryCachePercent: number
  diskUsedPercent: number
}> {
  const cutoff = Math.floor(Date.now() / 1000) - windowSeconds

  const rows = db
    .select()
    .from(systemMetrics)
    .all()
    .filter((r) => r.hostId === hostId && r.timestamp >= cutoff)

  return rows.map((row) => ({
    timestamp: row.timestamp,
    cpuPercent: row.cpuPercent,
    memoryUsedPercent: row.memoryTotalBytes > 0 ? (row.memoryUsedBytes / row.memoryTotalBytes) * 100 : 0,
    memoryCachePercent: row.memoryTotalBytes > 0 ? (row.memoryCacheBytes / row.memoryTotalBytes) * 100 : 0,
    diskUsedPercent: row.diskTotalBytes > 0 ? (row.diskUsedBytes / row.diskTotalBytes) * 100 : 0,
  }))
}

function toCurrentMetrics(row: typeof systemMetrics.$inferSelect | undefined, localFallback = false): CurrentMetrics {
  if (!row && localFallback) {
    const memory = getMemoryInfo()
    const disk = getDiskUsage()
    return {
      cpu: 0,
      memory: {
        total: memory.total,
        used: memory.used,
        cache: memory.cache,
        usedPercent: memory.total > 0 ? (memory.used / memory.total) * 100 : 0,
        cachePercent: memory.total > 0 ? (memory.cache / memory.total) * 100 : 0,
      },
      disk: {
        total: disk.total,
        used: disk.used,
        usedPercent: disk.total > 0 ? (disk.used / disk.total) * 100 : 0,
        path: '/',
      },
    }
  }

  return {
    cpu: row?.cpuPercent ?? 0,
    memory: {
      total: row?.memoryTotalBytes ?? 0,
      used: row?.memoryUsedBytes ?? 0,
      cache: row?.memoryCacheBytes ?? 0,
      usedPercent: row && row.memoryTotalBytes > 0 ? (row.memoryUsedBytes / row.memoryTotalBytes) * 100 : 0,
      cachePercent: row && row.memoryTotalBytes > 0 ? (row.memoryCacheBytes / row.memoryTotalBytes) * 100 : 0,
    },
    disk: {
      total: row?.diskTotalBytes ?? 0,
      used: row?.diskUsedBytes ?? 0,
      usedPercent: row && row.diskTotalBytes > 0 ? (row.diskUsedBytes / row.diskTotalBytes) * 100 : 0,
      path: '/',
    },
  }
}

export function getCurrentMetrics(hostId = LOCAL_HOST_ID): CurrentMetrics {
  const latest = db
    .select()
    .from(systemMetrics)
    .where(eq(systemMetrics.hostId, hostId))
    .orderBy(desc(systemMetrics.timestamp))
    .limit(1)
    .all()

  return toCurrentMetrics(latest[0], hostId === LOCAL_HOST_ID)
}

export function getHostMetricSummaries(): HostMetricSummary[] {
  const allHosts = db.select().from(hosts).all()
  const cutoff = Math.floor(Date.now() / 1000) - REMOTE_COLLECT_INTERVAL / 1000 * 2

  return [
    {
      id: LOCAL_HOST_ID,
      name: 'Local',
      status: 'connected',
      lastSeenAt: db.select().from(systemMetrics).where(eq(systemMetrics.hostId, LOCAL_HOST_ID)).orderBy(desc(systemMetrics.timestamp)).limit(1).all()[0]?.timestamp ?? null,
      current: getCurrentMetrics(LOCAL_HOST_ID),
    },
    ...allHosts.map((host) => {
      const latest = db.select().from(systemMetrics).where(eq(systemMetrics.hostId, host.id)).orderBy(desc(systemMetrics.timestamp)).limit(1).all()[0]
      const status: HostHealthStatus = host.status === 'error'
        ? 'disconnected'
        : latest && latest.timestamp >= cutoff
          ? 'connected'
          : latest
            ? 'degraded'
            : 'disconnected'

      return {
        id: host.id,
        name: host.name,
        status,
        lastSeenAt: latest?.timestamp ?? null,
        current: toCurrentMetrics(latest),
      }
    }),
  ]
}
