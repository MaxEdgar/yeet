import type {DownloadProgress} from './ytdlp.js'

export type BatchStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped'

export type BatchItem = {
  id: string
  url: string
  title?: string
  status: BatchStatus
  progress?: DownloadProgress
  processing?: boolean
  filepath?: string
  error?: string
}

/** Build the working queue from playlist entries or manually-pasted urls. */
export function makeBatchItems(entries: Array<{url: string; title?: string}>): BatchItem[] {
  return entries.map((entry, index) => ({
    id: `${index}-${entry.url}`,
    url: entry.url,
    title: entry.title,
    status: 'pending',
  }))
}

export type BatchSummary = {done: number; error: number; skipped: number; pending: number; total: number}

export function batchSummary(items: BatchItem[]): BatchSummary {
  const done = items.filter(item => item.status === 'done').length
  const error = items.filter(item => item.status === 'error').length
  const skipped = items.filter(item => item.status === 'skipped').length
  const pending = items.filter(item => item.status === 'pending' || item.status === 'active').length
  return {done, error, skipped, pending, total: items.length}
}
