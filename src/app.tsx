import React, {useCallback, useEffect, useRef, useState} from 'react'
import os from 'node:os'
import path from 'node:path'
import {Box, Text, useApp, useInput, useStdout} from 'ink'
import SelectInput, {type IndicatorProps, type ItemProps} from 'ink-select-input'
import Spinner from 'ink-spinner'
import {FramedInput} from './components/framed-input.js'
import {FullScreen} from './components/fullscreen.js'
import {Logo} from './components/logo.js'
import {Panel} from './components/panel.js'
import {ProgressBar} from './components/progress-bar.js'
import {QueueList} from './components/queue-list.js'
import {Shortcuts} from './components/shortcuts.js'
import {TextInput} from './components/text-input.js'
import {batchSummary, makeBatchItems, type BatchItem} from './lib/batch.js'
import {clickTargetAt, findFrameRow, frameRowSpan, type ClickTarget} from './lib/click-map.js'
import {formatBytes, formatDuration, formatEta, formatSpeed, shortenPath, truncate, wrapText} from './lib/format.js'
import {addToHistory, loadHistory} from './lib/history.js'
import {detectPlatform, isProbablyUrl, type Platform} from './lib/platforms.js'
import {useMouseClick} from './lib/use-mouse-click.js'
import {nextThemeMode, ThemeProvider, type Theme, type ThemeMode, useTheme} from './theme.js'
import {
  buildChoices,
  download,
  ensureYtDlp,
  findFfmpeg,
  probe,
  QUEUE_PRESETS,
  type DownloadChoice,
  type DownloadProgress,
  type VideoInfo,
} from './lib/ytdlp.js'

const OUT_DIR = path.join(os.homedir(), 'Downloads')
const YEET_BUTTON = 'yeet'
const DONE_LABEL = '↵ yeet another'
const TAGLINE = 'yeet any video. paste. yeet. done.'

const choiceLabel = (choice: DownloadChoice) => `${choice.kind === 'audio' ? '♪ ' : '▶ '}${choice.label}`

function ChoiceIndicator({isSelected}: IndicatorProps) {
  const theme = useTheme()
  return (
    <Box marginRight={1}>
      <Text color={theme.primary}>{isSelected ? '❯' : ' '}</Text>
    </Box>
  )
}

function ChoiceItem({isSelected, label}: ItemProps) {
  const theme = useTheme()
  return (
    <Text color={theme.primary} bold={isSelected}>
      {label}
    </Text>
  )
}

// explicit blank lines — empty <Box height={1}/> spacers can collapse, and
// ink boxes default to flexShrink=1, so spacers are the first thing yoga
// crushes when content overflows the terminal
const Gap = ({lines = 1}: {lines?: number}) => (
  <Box flexDirection="column" flexShrink={0}>
    {Array.from({length: lines}, (_, i) => (
      <Text key={i}> </Text>
    ))}
  </Box>
)

// fixed-width slots — the centered line must not change width as values tick,
// otherwise the whole layout shifts on every progress update
function partLabel(progress: DownloadProgress): string {
  // explains the bar resetting between files (video, then audio)
  return progress.totalParts > 1 ? `part ${progress.part + 1}/${progress.totalParts}  ` : ''
}

function downloadMeta(progress: DownloadProgress): string {
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  const eta = progress.eta ? `${formatEta(progress.eta)} left` : ''
  return `${partLabel(progress)}${speed.padStart(10)}  ${eta.padEnd(12)}`
}

function indeterminateMeta(progress: DownloadProgress): string {
  const bytes = formatBytes(progress.downloadedBytes)
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  return `${partLabel(progress)}${bytes.padStart(8)}  ${speed.padEnd(10)}`
}

/**
 * The bar/spinner/meta block for an in-progress download — shared by the
 * single-video flow and whichever item is currently active in a batch, so
 * both look and behave identically.
 */
function DownloadStatus({
  theme,
  progress,
  processing,
  refreshing,
}: {
  theme: Theme
  progress?: DownloadProgress
  processing?: boolean
  refreshing?: boolean
}) {
  if (processing) {
    return (
      <>
        <ProgressBar percent={1} />
        <Gap />
        <Text>
          <Text color={theme.primary}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}> processing…</Text>
        </Text>
      </>
    )
  }
  if (progress?.totalBytes) {
    return (
      <>
        <ProgressBar percent={progress.downloadedBytes / progress.totalBytes} />
        <Gap />
        <Text color={theme.gray} dimColor={theme.dimSecondary}>{downloadMeta(progress)}</Text>
      </>
    )
  }
  if (progress) {
    return (
      <>
        <Text>
          <Text color={theme.primary}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}> downloading…</Text>
        </Text>
        <Gap />
        <Text color={theme.gray} dimColor={theme.dimSecondary}>{indeterminateMeta(progress)}</Text>
      </>
    )
  }
  return (
    <>
      <ProgressBar percent={0} />
      <Gap />
      <Text>
        <Text color={theme.primary}>
          <Spinner type="dots" />
        </Text>
        <Text color={theme.gray} dimColor={theme.dimSecondary}>
          {refreshing ? ' link expired — grabbing a fresh one…' : ' starting download…'}
        </Text>
      </Text>
    </>
  )
}

export type Outcome = {filepath?: string; count?: number}

type Phase =
  | {name: 'input'; warning?: string}
  | {name: 'probing'; status: string}
  | {name: 'picking'}
  | {
      name: 'downloading'
      choice: DownloadChoice
      progress?: DownloadProgress
      processing: boolean
      refreshing?: boolean
    }
  | {name: 'done'; filepath: string}
  | {name: 'batch-picking'}
  | {name: 'batch-running'; preset: DownloadChoice}
  | {name: 'batch-done'}
  | {name: 'error'; message: string}

const HINTS: Record<Phase['name'], Array<[string, string]>> = {
  input: [
    ['↵', 'yeet'],
    ['^c', 'quit'],
  ],
  probing: [
    ['esc', 'cancel'],
    ['^c', 'quit'],
  ],
  picking: [
    ['↑↓', 'choose'],
    ['↵', 'yeet'],
    ['esc', 'back'],
    ['^c', 'quit'],
  ],
  downloading: [
    ['esc', 'cancel'],
    ['^c', 'quit'],
  ],
  done: [['^c', 'quit']],
  'batch-picking': [
    ['↑↓', 'choose'],
    ['↵', 'yeet all'],
    ['esc', 'back'],
    ['^c', 'quit'],
  ],
  'batch-running': [
    ['s', 'skip'],
    ['esc', 'cancel'],
    ['^c', 'quit'],
  ],
  'batch-done': [
    ['↵', 'done'],
    ['^c', 'quit'],
  ],
  error: [
    ['↵', 'try again'],
    ['^c', 'quit'],
  ],
}

type AppProps = {
  initialUrl?: string
  clipboardUrl?: string
  initialThemeMode?: ThemeMode
  onOutcome: (outcome: Outcome) => void
}

export function App({initialThemeMode = 'auto', ...props}: AppProps) {
  const [themeMode, setThemeMode] = useState(initialThemeMode)
  const cycleTheme = useCallback(() => {
    setThemeMode(nextThemeMode)
  }, [])

  return (
    <ThemeProvider mode={themeMode}>
      <AppContent {...props} cycleTheme={cycleTheme} />
    </ThemeProvider>
  )
}

function AppContent({
  initialUrl,
  clipboardUrl,
  onOutcome,
  cycleTheme,
}: {
  initialUrl?: string
  clipboardUrl?: string
  onOutcome: (outcome: Outcome) => void
  cycleTheme: () => void
}) {
  const theme = useTheme()
  const {exit} = useApp()
  const {stdout} = useStdout()
  const [url, setUrl] = useState(initialUrl ?? '')
  const [urlInput, setUrlInput] = useState('')
  const [history, setHistory] = useState(loadHistory)
  const [platform, setPlatform] = useState<Platform>()
  const [info, setInfo] = useState<VideoInfo>()
  const [choices, setChoices] = useState<DownloadChoice[]>([])
  const ytdlpRef = useRef('')
  const highlightRef = useRef(0) // choice under the cursor, for the ↵ hint click
  const batchHighlightRef = useRef(0) // preset under the cursor in batch-picking
  const infoJsonRef = useRef<string | undefined>(undefined)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>(initialUrl ? {name: 'probing', status: 'warming up…'} : {name: 'input'})

  // manually-queued urls (added with ^q), waiting for the batch to start
  const [queue, setQueue] = useState<string[]>([])
  // the working set once a batch (playlist or manual queue) has been built
  const [batchLabel, setBatchLabel] = useState('')
  const [batchItems, setBatchItems] = useState<BatchItem[]>([])
  const batchControlRef = useRef<{cancelled: boolean; controller?: AbortController}>({cancelled: false})

  const columns = stdout?.columns && stdout.columns > 0 ? stdout.columns : 80
  const boxWidth = Math.max(14, Math.min(64, columns - 6))
  const contentWidth = Math.max(10, Math.min(columns - 4, 78))
  const batchWidth = Math.max(20, Math.min(columns - 10, 60))

  const startProbe = useCallback(async (targetUrl: string) => {
    const controller = new AbortController()
    abortRef.current = controller
    setPlatform(detectPlatform(targetUrl))
    setPhase({name: 'probing', status: 'warming up…'})
    try {
      const ytdlp =
        ytdlpRef.current ||
        (await ensureYtDlp(status => setPhase({name: 'probing', status}), controller.signal))
      ytdlpRef.current = ytdlp
      if (controller.signal.aborted) return
      setPhase({name: 'probing', status: 'fetching video info…'})
      const result = await probe(ytdlp, targetUrl, controller.signal)
      if (controller.signal.aborted) return
      if (result.kind === 'playlist') {
        setBatchLabel(result.title)
        setBatchItems(makeBatchItems(result.entries))
        setPhase({name: 'batch-picking'})
        return
      }
      infoJsonRef.current = result.infoJsonPath
      setInfo(result.info)
      setChoices(buildChoices(result.info))
      highlightRef.current = 0
      setPhase({name: 'picking'})
    } catch (error) {
      if (controller.signal.aborted) return
      setPhase({name: 'error', message: error instanceof Error ? error.message : String(error)})
    }
  }, [])

  useEffect(() => {
    if (initialUrl) void startProbe(initialUrl)
  }, [initialUrl, startProbe])

  const resetToInput = useCallback(() => {
    setUrl('')
    setUrlInput('')
    setPlatform(undefined)
    setInfo(undefined)
    setChoices([])
    setBatchLabel('')
    setBatchItems([])
    setPhase({name: 'input'})
  }, [])

  const cancelRun = useCallback(() => {
    abortRef.current?.abort()
    resetToInput()
    setUrlInput(url) // keep the link around so a cancel isn't destructive
  }, [resetToInput, url])

  const startBatch = useCallback((initialItems: BatchItem[], preset: DownloadChoice) => {
    batchControlRef.current = {cancelled: false}
    let items = initialItems.map(item => ({...item}))
    setBatchItems(items)
    setPhase({name: 'batch-running', preset})

    void (async () => {
      let ytdlp: string
      try {
        ytdlp = ytdlpRef.current || (await ensureYtDlp(() => {}))
        ytdlpRef.current = ytdlp
      } catch (error) {
        items = items.map(item => ({...item, status: 'error', error: error instanceof Error ? error.message : String(error)}))
        setBatchItems(items)
        setPhase({name: 'batch-done'})
        return
      }
      const ffmpegLocation = await findFfmpeg()

      for (let index = 0; index < items.length; index++) {
        if (batchControlRef.current.cancelled) {
          items = items.map((item, i) => (i >= index && item.status === 'pending' ? {...item, status: 'skipped'} : item))
          setBatchItems(items)
          break
        }

        const controller = new AbortController()
        batchControlRef.current.controller = controller
        items = items.map((item, i) => (i === index ? {...item, status: 'active'} : item))
        setBatchItems(items)

        try {
          const handlers = {
            onProgress: (progress: DownloadProgress) => {
              items = items.map((item, i) => (i === index ? {...item, progress, processing: false} : item))
              setBatchItems(items)
            },
            onProcessing: () => {
              items = items.map((item, i) => (i === index ? {...item, processing: true} : item))
              setBatchItems(items)
            },
          }
          const filepath = await download(
            {ytdlp, ffmpegLocation, url: items[index]!.url, choice: preset, outDir: OUT_DIR},
            handlers,
            controller.signal,
          )
          items = items.map((item, i) => (i === index ? {...item, status: 'done', filepath} : item))
          setBatchItems(items)
          setHistory(addToHistory(items[index]!.url))
        } catch (error) {
          if (controller.signal.aborted) {
            // aborted on purpose — either "skip" (this item only) or "cancel" (whole batch)
            items = items.map((item, i) => (i === index ? {...item, status: 'skipped'} : item))
          } else {
            items = items.map((item, i) =>
              i === index
                ? {...item, status: 'error', error: error instanceof Error ? error.message : String(error)}
                : item,
            )
          }
          setBatchItems(items)
          if (batchControlRef.current.cancelled) {
            items = items.map((item, i) => (i > index ? {...item, status: 'skipped'} : item))
            setBatchItems(items)
            break
          }
        }
      }

      onOutcome({count: items.filter(item => item.status === 'done').length})
      setPhase({name: 'batch-done'})
    })()
  }, [onOutcome])

  useInput(
    (input, key) => {
      if (key.ctrl && input === 't') {
        cycleTheme()
        return
      }
      if (key.ctrl && input === 'q' && phase.name === 'input') {
        const trimmed = urlInput.trim()
        if (isProbablyUrl(trimmed)) {
          setQueue(q => [...q, trimmed])
          setUrlInput('')
        }
        return
      }
      if (input === 's' && phase.name === 'batch-running') {
        batchControlRef.current.controller?.abort()
        return
      }
      if (key.escape && phase.name === 'batch-running') {
        batchControlRef.current.cancelled = true
        batchControlRef.current.controller?.abort()
        return
      }
      if (key.escape && (phase.name === 'picking' || phase.name === 'batch-picking' || phase.name === 'error' || phase.name === 'done' || phase.name === 'batch-done')) {
        resetToInput()
      }
      if (key.escape && phase.name === 'probing') cancelRun()
      if (key.return && (phase.name === 'error' || phase.name === 'done' || phase.name === 'batch-done')) resetToInput()
    },
    {isActive: Boolean(process.stdin.isTTY)},
  )

  const handleUrlSubmit = (value: string) => {
    const trimmed = value.trim()

    if (queue.length > 0) {
      if (trimmed && !isProbablyUrl(trimmed)) {
        setPhase({name: 'input', warning: 'that doesn’t look like a link — clear it or paste a full url'})
        return
      }
      const urls = trimmed ? [...queue, trimmed] : [...queue]
      setQueue([])
      setUrlInput('')
      const items = makeBatchItems(urls.map(u => ({url: u})))
      setBatchLabel(`${items.length} queued link${items.length === 1 ? '' : 's'}`)
      setBatchItems(items)
      setPhase({name: 'batch-picking'})
      return
    }

    if (!isProbablyUrl(trimmed)) {
      setPhase({name: 'input', warning: 'that doesn’t look like a link — paste a full url'})
      return
    }
    setUrl(trimmed)
    void startProbe(trimmed)
  }

  const clipboardOffered = Boolean(clipboardUrl) && urlInput === '' && queue.length === 0
  const clipboardAccepted = Boolean(clipboardUrl) && urlInput === clipboardUrl

  const handlePick = (item: {value: number}) => {
    const choice = choices[item.value]
    const controller = new AbortController()
    abortRef.current = controller
    setPhase({name: 'downloading', choice, processing: false})
    void (async () => {
      const handlers = {
        onProgress: (progress: DownloadProgress) =>
          setPhase(prev => (prev.name === 'downloading' ? {...prev, progress, processing: false} : prev)),
        onProcessing: () =>
          setPhase(prev => (prev.name === 'downloading' ? {...prev, processing: true} : prev)),
      }
      try {
        const ffmpegLocation = await findFfmpeg()
        const base = {ytdlp: ytdlpRef.current, ffmpegLocation, url, choice, outDir: OUT_DIR}
        let filepath: string
        try {
          // reuse the probe's metadata — starts immediately instead of re-extracting
          filepath = await download({...base, infoJsonPath: infoJsonRef.current}, handlers, controller.signal)
        } catch (error) {
          if (controller.signal.aborted) throw error
          // media urls in the cached info can expire — retry with a fresh extraction
          setPhase(prev =>
            prev.name === 'downloading' ? {...prev, progress: undefined, refreshing: true} : prev,
          )
          filepath = await download(base, handlers, controller.signal)
        }
        onOutcome({filepath})
        setHistory(addToHistory(url))
        setPhase({name: 'done', filepath})
      } catch (error) {
        if (controller.signal.aborted) return
        setPhase({name: 'error', message: error instanceof Error ? error.message : String(error)})
      }
    })()
  }

  const handleBatchPick = (item: {value: number}) => {
    const preset = QUEUE_PRESETS[item.value]!
    startBatch(batchItems, preset)
  }

  let hints: Array<[string, string]> = [...HINTS[phase.name], ['^t', `theme:${theme.mode}`]]
  if (phase.name === 'input') {
    if (queue.length > 0) {
      hints = [hints[0]!, ['^q', `queued (${queue.length})`], ...hints.slice(1)]
    } else if (isProbablyUrl(urlInput.trim())) {
      hints = [hints[0]!, ['^q', 'add to queue'], ...hints.slice(1)]
    } else if (history.length > 0) {
      hints = [hints[0]!, ['↑', 'history'], ...hints.slice(1)]
    }
  }

  // Anything a mouse user would expect to press is clickable. Targets are
  // found by their text in the rendered frame (see lib/click-map.ts), so
  // there is no layout math to keep in sync.
  const hintAction = (key: string): (() => void) | undefined => {
    if (key === '^c') return () => exit()
    if (key === '^t') return cycleTheme
    if (key === 'esc') {
      if (phase.name === 'probing') return cancelRun
      if (phase.name === 'batch-running') {
        return () => {
          batchControlRef.current.cancelled = true
          batchControlRef.current.controller?.abort()
        }
      }
      return resetToInput
    }
    if (key === 's' && phase.name === 'batch-running') return () => batchControlRef.current.controller?.abort()
    if (key === '↵') {
      if (phase.name === 'input') return () => handleUrlSubmit(urlInput)
      if (phase.name === 'picking') return () => handlePick({value: highlightRef.current})
      if (phase.name === 'batch-picking') return () => handleBatchPick({value: batchHighlightRef.current})
      if (phase.name === 'error' || phase.name === 'done' || phase.name === 'batch-done') return resetToInput
    }
    return undefined // ↑↓ / ↑ stay keyboard-only
  }
  const clickTargets: ClickTarget[] = []
  if (phase.name === 'input') {
    // the frame button rows above/below the label are part of the button
    clickTargets.push({match: `  ${YEET_BUTTON}  `, padY: 1, action: () => handleUrlSubmit(urlInput)})
  }
  if (phase.name === 'picking') {
    for (const [index, choice] of choices.entries()) {
      clickTargets.push({match: choiceLabel(choice), action: () => handlePick({value: index})})
    }
  }
  if (phase.name === 'batch-picking') {
    for (const [index, choice] of QUEUE_PRESETS.entries()) {
      clickTargets.push({match: choiceLabel(choice), action: () => handleBatchPick({value: index})})
    }
  }
  if (phase.name === 'done' || phase.name === 'batch-done') {
    clickTargets.push({match: DONE_LABEL, padX: 4, padY: 1, action: resetToInput})
  }
  for (const [key, label] of hints) {
    const action = hintAction(key)
    if (action) clickTargets.push({match: `${key} ${label}`, action})
  }

  useMouseClick(
    (x, y) => {
      // the logo takes you home — it's the 3 rows one gap above the tagline
      const taglineRow = findFrameRow(TAGLINE)
      if (taglineRow > 3 && y - 1 >= taglineRow - 4 && y - 1 <= taglineRow - 2) {
        const span = frameRowSpan(y - 1)
        if (span && x >= span[0] - 1 && x <= span[1] + 1) {
          if (phase.name === 'probing') cancelRun()
          else if (phase.name === 'batch-running') {
            batchControlRef.current.cancelled = true
            batchControlRef.current.controller?.abort()
          } else if (phase.name !== 'input') resetToInput()
          return
        }
      }
      clickTargetAt(x, y, clickTargets)?.action()
    },
    Boolean(process.stdin.isTTY),
  )

  const batchActive = batchItems.find(item => item.status === 'active')
  const batchSummaryCounts = batchSummary(batchItems)

  return (
    <FullScreen>
      <Logo />
      <Gap />
      <Text color={theme.primary}>{TAGLINE}</Text>
      <Text color={theme.gray} dimColor={theme.dimSecondary}>youtube · x · instagram · threads · tiktok · +1800 more</Text>
      <Gap />

      {phase.name === 'input' && (
        <Box flexDirection="column" alignItems="center">
          <FramedInput title="Paste a link" width={boxWidth} button={YEET_BUTTON}>
            <TextInput
              value={urlInput}
              onChange={setUrlInput}
              onSubmit={handleUrlSubmit}
              placeholder="https://youtube.com/watch?v=…"
              width={boxWidth - 6}
              history={history}
              submitOnPaste={isProbablyUrl}
              onTab={() => {
                if (clipboardOffered) setUrlInput(clipboardUrl!)
              }}
            />
          </FramedInput>
          {phase.warning ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>✗ {phase.warning}</Text>
          ) : queue.length > 0 ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>
              {queue.length} link{queue.length === 1 ? '' : 's'} queued — ↵ to start, ^q to add another
            </Text>
          ) : clipboardOffered ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>link in your clipboard — ⇥ to paste it</Text>
          ) : clipboardAccepted ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>from your clipboard — ↵ to yeet it</Text>
          ) : null}
        </Box>
      )}

      {phase.name === 'probing' && (
        <Box flexDirection="column" alignItems="center">
          <FramedInput title={platform ? platform.label : 'Paste a link'} width={boxWidth} button={YEET_BUTTON} buttonDim>
            <Text color={theme.gray} dimColor={theme.dimSecondary}>{url.length > boxWidth - 8 ? `${url.slice(0, boxWidth - 9)}…` : url}</Text>
          </FramedInput>
        </Box>
      )}

      {phase.name === 'picking' && platform && (
        <Box width={contentWidth}>
          <Box flexDirection="column" flexGrow={1} flexBasis={0} paddingTop={1} paddingRight={3}>
            {/* wrapped by hand so continuation lines stay flush left —
                ink's wrapping keeps the break's space as a 1-cell indent */}
            {wrapText(info?.title ?? '', Math.max(10, contentWidth - 41)).map((line, index) => (
              <Text key={index} bold color={theme.primary}>
                {line}
              </Text>
            ))}
            <Gap />
            <Text color={theme.gray} dimColor={theme.dimSecondary}>
              ▸ {platform.label}
              {info?.duration ? ` · ${formatDuration(info.duration)}` : ''}
              {info?.uploader ? ` · ${info.uploader}` : ''}
            </Text>
          </Box>
          <Panel title="Download" width={38}>
            <SelectInput
              indicatorComponent={ChoiceIndicator}
              itemComponent={ChoiceItem}
              items={choices.map((choice, index) => ({
                key: String(index),
                label: choiceLabel(choice),
                value: index,
              }))}
              onSelect={handlePick}
              onHighlight={item => (highlightRef.current = item.value)}
            />
          </Panel>
        </Box>
      )}

      {phase.name === 'batch-picking' && (
        <Box width={contentWidth}>
          <Box flexDirection="column" flexGrow={1} flexBasis={0} paddingTop={1} paddingRight={3}>
            {wrapText(batchLabel, Math.max(10, contentWidth - 41)).map((line, index) => (
              <Text key={index} bold color={theme.primary}>
                {line}
              </Text>
            ))}
            <Gap />
            <Text color={theme.gray} dimColor={theme.dimSecondary}>
              ▸ {batchItems.length} video{batchItems.length === 1 ? '' : 's'} · same format for all
            </Text>
            <Gap />
            <QueueList items={batchItems} width={Math.max(10, contentWidth - 41)} />
          </Box>
          <Panel title="Download" width={38}>
            <SelectInput
              indicatorComponent={ChoiceIndicator}
              itemComponent={ChoiceItem}
              items={QUEUE_PRESETS.map((choice, index) => ({
                key: String(index),
                label: choiceLabel(choice),
                value: index,
              }))}
              onSelect={handleBatchPick}
              onHighlight={item => (batchHighlightRef.current = item.value)}
            />
          </Panel>
        </Box>
      )}

      {phase.name === 'downloading' && (
        <Box flexDirection="column" alignItems="center">
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            {info?.title ? `${truncate(info.title, 42)} · ` : ''}
            {phase.choice.label}
          </Text>
          <Gap />
          {/* every branch is exactly three rows — bar, gap, meta — so the layout never jumps */}
          <DownloadStatus theme={theme} progress={phase.progress} processing={phase.processing} refreshing={phase.refreshing} />
        </Box>
      )}

      {phase.name === 'batch-running' && (
        <Box flexDirection="column" alignItems="center">
          <QueueList items={batchItems} width={batchWidth} />
          <Gap />
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            {batchActive ? truncate(batchActive.title || batchActive.url, 46) : ''}
          </Text>
          <Gap />
          <DownloadStatus theme={theme} progress={batchActive?.progress} processing={batchActive?.processing} />
          <Gap />
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            {batchSummaryCounts.done}/{batchItems.length} done
            {batchSummaryCounts.error ? ` · ${batchSummaryCounts.error} failed` : ''}
            {batchSummaryCounts.skipped ? ` · ${batchSummaryCounts.skipped} skipped` : ''}
          </Text>
        </Box>
      )}

      {phase.name === 'done' && (
        <Box flexDirection="column" alignItems="center">
          <Text>
            <Text bold color={theme.primary}>✓ yeeted! </Text>
            <Text color={theme.primary}>find your file in:</Text>
          </Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{shortenPath(phase.filepath, os.homedir(), 60)}</Text>
          <Gap />
          <Box
            borderStyle="round"
            borderColor={theme.gray}
            borderDimColor={theme.dimSecondary}
            borderBackgroundColor={theme.background}
            paddingX={3}
          >
            <Text bold color={theme.primary}>{DONE_LABEL}</Text>
          </Box>
        </Box>
      )}

      {phase.name === 'batch-done' && (
        <Box flexDirection="column" alignItems="center">
          <QueueList items={batchItems} width={batchWidth} />
          <Gap />
          <Text>
            <Text bold color={theme.primary}>✓ {batchSummaryCounts.done}/{batchItems.length} yeeted</Text>
            {batchSummaryCounts.error ? (
              <Text color={theme.gray} dimColor={theme.dimSecondary}> · {batchSummaryCounts.error} failed</Text>
            ) : null}
            {batchSummaryCounts.skipped ? (
              <Text color={theme.gray} dimColor={theme.dimSecondary}> · {batchSummaryCounts.skipped} skipped</Text>
            ) : null}
          </Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}>saved to {shortenPath(OUT_DIR, os.homedir(), 60)}</Text>
          <Gap />
          <Box
            borderStyle="round"
            borderColor={theme.gray}
            borderDimColor={theme.dimSecondary}
            borderBackgroundColor={theme.background}
            paddingX={3}
          >
            <Text bold color={theme.primary}>{DONE_LABEL}</Text>
          </Box>
        </Box>
      )}

      {phase.name === 'error' && (
        <Box flexDirection="column" alignItems="center" width={Math.max(10, Math.min(columns - 6, 72))}>
          <Text bold color={theme.primary}>✗ {phase.message}</Text>
        </Box>
      )}

      {hints.length > 0 ? (
        <>
          <Gap lines={2} />
          <Shortcuts
            items={hints}
            leading={
              phase.name === 'probing' ? (
                <Text>
                  <Text color={theme.primary}>
                    <Spinner type="dots" />
                  </Text>
                  <Text color={theme.gray} dimColor={theme.dimSecondary}> {phase.status}</Text>
                </Text>
              ) : undefined
            }
          />
        </>
      ) : null}
    </FullScreen>
  )
}
