import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HugeiconsIcon } from '@hugeicons/react'
import { Loading03Icon } from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Area, AreaChart, XAxis, YAxis, CartesianGrid } from 'recharts'
import { useSystemMetrics, formatBytes, type HostMetricSummary, type TimeWindow } from '@/hooks/use-monitoring'

const TIME_WINDOWS: TimeWindow[] = ['1m', '10m', '1h', '3h', '6h', '12h', '24h']

const chartConfig: ChartConfig = {
  cpu: {
    label: 'CPU',
    color: 'var(--chart-system)', // Stormy Teal (light) / Cinnabar (dark)
  },
  memoryUsed: {
    label: 'Used',
    color: 'var(--chart-system)', // Stormy Teal (light) / Cinnabar (dark)
  },
  memoryCache: {
    label: 'Cache / Buffers',
    color: 'var(--muted-foreground)', // Lavender Grey
  },
  disk: {
    label: 'Disk',
    color: 'var(--muted-foreground)', // Lavender Grey
  },
}

function statusClass(status: HostMetricSummary['status']): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500'
    case 'degraded':
      return 'bg-amber-500'
    case 'disconnected':
      return 'bg-destructive'
  }
}

function statusLabel(status: HostMetricSummary['status']): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'degraded':
      return 'Degraded'
    case 'disconnected':
      return 'Disconnected'
  }
}

export default function SystemMetricsTab() {
  const { t } = useTranslation('monitoring')
  const [window, setWindow] = useState<TimeWindow>('1h')
  const [hostId, setHostId] = useState('local')
  const { data: metrics, isLoading, error } = useSystemMetrics(window, hostId)
  const selectedHost = metrics?.hosts.find((host) => host.id === hostId)

  // Transform data for charts - use timestamp as x-axis
  const chartData =
    metrics?.dataPoints.map((point) => ({
      time: new Date(point.timestamp * 1000).toLocaleTimeString(),
      timestamp: point.timestamp,
      cpu: Math.round(point.cpuPercent * 10) / 10,
      memoryUsed: Math.round(point.memoryUsedPercent * 10) / 10,
      memoryCache: Math.round(point.memoryCachePercent * 10) / 10,
    })) || []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {/* Time window selector */}
        {/* Mobile: dropdown */}
        <div className="sm:hidden">
          <Select value={window} onValueChange={(v) => setWindow(v as TimeWindow)}>
            <SelectTrigger size="sm" className="w-auto gap-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_WINDOWS.map((tw) => (
                <SelectItem key={tw} value={tw}>{t(`system.timeWindows.${tw}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Desktop: buttons */}
        <div className="hidden sm:flex gap-1">
          {TIME_WINDOWS.map((tw) => (
            <Button
              key={tw}
              variant={window === tw ? 'default' : 'ghost'}
              size="xs"
              onClick={() => setWindow(tw)}
            >
              {t(`system.timeWindows.${tw}`)}
            </Button>
          ))}
        </div>

        {metrics && (
          <Select value={hostId} onValueChange={(value) => value && setHostId(value)}>
            <SelectTrigger size="sm" className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {metrics.hosts.map((host) => (
                <SelectItem key={host.id} value={host.id}>
                  {host.name} · {statusLabel(host.status)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <HugeiconsIcon icon={Loading03Icon} className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {t('system.error', { message: error.message })}
        </div>
      )}

      {metrics && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {metrics.hosts.map((host) => (
              <button
                key={host.id}
                type="button"
                onClick={() => setHostId(host.id)}
                className={`rounded-lg border p-3 text-left transition-colors ${host.id === hostId ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{host.name}</span>
                  <span className={`size-2 rounded-full ${statusClass(host.status)}`} />
                </div>
                <div className="text-xs text-muted-foreground">{statusLabel(host.status)}</div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums">
                  <span>CPU {host.current.cpu.toFixed(0)}%</span>
                  <span>MEM {host.current.memory.usedPercent.toFixed(0)}%</span>
                  <span>DISK {host.current.disk.usedPercent.toFixed(0)}%</span>
                </div>
              </button>
            ))}
          </div>

          {selectedHost && selectedHost.status !== 'connected' && (
            <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              {selectedHost.name} is {statusLabel(selectedHost.status).toLowerCase()}; showing the latest collected metrics.
            </div>
          )}

          {/* CPU Chart */}
          <Card className="p-4">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-medium">{t('system.cpuUsage')}</h3>
              <span className="text-sm text-muted-foreground tabular-nums">
                {metrics.current.cpu.toFixed(1)}%
              </span>
            </div>
            <ChartContainer config={chartConfig} className="h-[150px] w-full">
              <AreaChart data={chartData} margin={{ left: 0, right: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={40}
                />
                <YAxis
                  domain={[0, 100]}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(value: number) => `${value}%`}
                />
                <ChartTooltip
                  content={<ChartTooltipContent hideLabel formatter={(value) => [`${value}% `, 'CPU']} />}
                />
                <Area
                  type="monotone"
                  dataKey="cpu"
                  stroke="var(--color-cpu)"
                  fill="var(--color-cpu)"
                  fillOpacity={0.4}
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          </Card>

          {/* Memory Chart */}
          <Card className="p-4">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-medium">{t('system.memoryUsage')}</h3>
              <span className="text-sm text-muted-foreground tabular-nums">
                {formatBytes(metrics.current.memory.used)} {t('system.memoryLabels.used').toLowerCase()} + {formatBytes(metrics.current.memory.cache)} {t('system.memoryLabels.cache').toLowerCase()}
                {' / '}{formatBytes(metrics.current.memory.total)}
              </span>
            </div>
            <ChartContainer config={chartConfig} className="h-[150px] w-full">
              <AreaChart data={chartData} margin={{ left: 0, right: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={40}
                />
                <YAxis
                  domain={[0, 100]}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(value: number) => `${value}%`}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      hideLabel
                      formatter={(value, name) => {
                        const label = name === 'memoryUsed' ? t('system.memoryLabels.used') : t('system.memoryLabels.cache')
                        return [`${value}% `, label]
                      }}
                    />
                  }
                />
                <Area
                  type="monotone"
                  dataKey="memoryUsed"
                  stroke="var(--color-memoryUsed)"
                  fill="var(--color-memoryUsed)"
                  fillOpacity={0.5}
                  strokeWidth={2}
                  stackId="memory"
                />
                <Area
                  type="monotone"
                  dataKey="memoryCache"
                  stroke="var(--color-memoryCache)"
                  fill="var(--color-memoryCache)"
                  fillOpacity={0.4}
                  strokeWidth={1}
                  stackId="memory"
                />
              </AreaChart>
            </ChartContainer>
          </Card>

          {/* Disk Usage */}
          <Card className="p-4">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-medium">{t('system.diskUsage', { path: metrics.current.disk.path })}</h3>
              <span className="text-sm text-muted-foreground tabular-nums">
                {metrics.current.disk.usedPercent.toFixed(1)}% ({formatBytes(metrics.current.disk.used)} /{' '}
                {formatBytes(metrics.current.disk.total)})
              </span>
            </div>
            <div className="h-4 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-chart-system transition-all"
                style={{ width: `${Math.min(metrics.current.disk.usedPercent, 100)}%` }}
              />
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
