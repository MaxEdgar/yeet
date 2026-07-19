import React from 'react'
import {Box, Text} from 'ink'
import Spinner from 'ink-spinner'
import {truncate} from '../lib/format.js'
import type {BatchItem} from '../lib/batch.js'
import {useTheme} from '../theme.js'

const MAX_VISIBLE = 7

function StatusIcon({status}: {status: BatchItem['status']}) {
  const theme = useTheme()
  if (status === 'active') {
    return (
      <Text color={theme.primary}>
        <Spinner type="dots" />
      </Text>
    )
  }
  if (status === 'done') return <Text color={theme.primary}>✓</Text>
  if (status === 'error') return <Text color={theme.gray} dimColor={theme.dimSecondary}>✗</Text>
  if (status === 'skipped') return <Text color={theme.gray} dimColor={theme.dimSecondary}>⤫</Text>
  return <Text color={theme.gray} dimColor={theme.dimSecondary}>·</Text>
}

/**
 * Fixed-height scrolling list — keeps the active (or last) row centered so a
 * long playlist doesn't push the rest of the screen around as it progresses.
 */
export function QueueList({items, width}: {items: BatchItem[]; width: number}) {
  const theme = useTheme()
  if (items.length === 0) return null

  const activeIndex = items.findIndex(item => item.status === 'active')
  const anchor = activeIndex === -1 ? items.length - 1 : activeIndex
  const start = Math.max(0, Math.min(anchor - Math.floor(MAX_VISIBLE / 2), Math.max(0, items.length - MAX_VISIBLE)))
  const visible = items.slice(start, start + MAX_VISIBLE)
  const hiddenAbove = start
  const hiddenBelow = Math.max(0, items.length - (start + visible.length))

  return (
    <Box flexDirection="column" width={width}>
      {hiddenAbove > 0 ? (
        <Text color={theme.gray} dimColor={theme.dimSecondary}>{`  ↑ ${hiddenAbove} more`}</Text>
      ) : null}
      {visible.map(item => (
        <Box key={item.id}>
          <Box width={2}>
            <StatusIcon status={item.status} />
          </Box>
          <Text
            color={item.status === 'done' || item.status === 'active' ? theme.primary : theme.gray}
            dimColor={item.status !== 'done' && item.status !== 'active' && theme.dimSecondary}
          >
            {truncate(item.title || item.url, Math.max(4, width - 3))}
          </Text>
        </Box>
      ))}
      {hiddenBelow > 0 ? (
        <Text color={theme.gray} dimColor={theme.dimSecondary}>{`  ↓ ${hiddenBelow} more`}</Text>
      ) : null}
    </Box>
  )
}
