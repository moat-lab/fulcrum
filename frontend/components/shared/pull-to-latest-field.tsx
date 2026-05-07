import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { HugeiconsIcon } from '@hugeicons/react'
import { Alert02Icon } from '@hugeicons/core-free-icons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface PullToLatestFieldProps {
  pullToLatest: boolean
  onPullToLatestChange: (value: boolean) => void
  pullRemoteBranch: string
  onPullRemoteBranchChange: (value: string) => void
  remoteBranches: string[]
  unpushedCommits: number
  uncommittedFiles: number
  baseBranch: string
  disabled?: boolean
}

export function PullToLatestField({
  pullToLatest,
  onPullToLatestChange,
  pullRemoteBranch,
  onPullRemoteBranchChange,
  remoteBranches,
  unpushedCommits,
  uncommittedFiles,
  baseBranch,
  disabled,
}: PullToLatestFieldProps) {
  const { t } = useTranslation('tasks')

  const noRemoteBranches = remoteBranches.length === 0
  const blockedByUnpushed = unpushedCommits > 0
  const blockedMessage = noRemoteBranches
    ? t('createModal.pullToLatestNoRemoteBranches')
    : blockedByUnpushed
      ? t('createModal.pullToLatestBlockedByUnpushed', { count: unpushedCommits, branch: baseBranch })
      : undefined
  const toggleDisabled = disabled || noRemoteBranches || blockedByUnpushed

  useEffect(() => {
    if ((noRemoteBranches || blockedByUnpushed) && pullToLatest) {
      onPullToLatestChange(false)
    }
  }, [noRemoteBranches, blockedByUnpushed, pullToLatest, onPullToLatestChange])

  return (
    <Field data-disabled={toggleDisabled || undefined}>
      <div
        className="flex items-center justify-between"
        title={blockedMessage}
      >
        <FieldLabel>{t('createModal.pullToLatest')}</FieldLabel>
        <Switch
          checked={pullToLatest && !noRemoteBranches && !blockedByUnpushed}
          onCheckedChange={onPullToLatestChange}
          disabled={toggleDisabled}
          aria-disabled={toggleDisabled}
          size="sm"
        />
      </div>
      {blockedMessage && (
        <p className="text-sm text-destructive">
          {blockedMessage}
        </p>
      )}
      {pullToLatest && !noRemoteBranches && !blockedByUnpushed && (
        <Select
          value={pullRemoteBranch}
          onValueChange={(v) => onPullRemoteBranchChange(v ?? '')}
          disabled={disabled}
        >
          <SelectTrigger className="w-full">
            <SelectValue>
              {pullRemoteBranch || (
                <span className="text-muted-foreground">
                  {t('createModal.selectPullBranch')}
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {remoteBranches.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {pullToLatest && !blockedByUnpushed && (
        <FieldDescription>{t('createModal.pullToLatestHint')}</FieldDescription>
      )}
      {uncommittedFiles > 0 && (
        <FieldDescription className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
          <HugeiconsIcon icon={Alert02Icon} size={14} className="mt-0.5 shrink-0" />
          <span>{t('createModal.uncommittedFilesNotice', { count: uncommittedFiles })}</span>
        </FieldDescription>
      )}
    </Field>
  )
}
