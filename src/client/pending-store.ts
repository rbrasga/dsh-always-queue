/**
 * The cross-session pending queue.
 *
 * Holds messages the gate intercepted (sent to an idle session while another
 * session was in progress) and waits for the single-in-progress gate to open.
 * A module-level singleton: one queue per page, persisted to localStorage so
 * held messages survive a reload (the release loop re-runs at boot). React
 * components read it through useSyncExternalStore with a per-session cached
 * snapshot (stable identity between mutations).
 */
import type { PromptContentPart } from '@deepseek-ai/dsh-client-runtime/client'

/** One held message waiting for the global gate to open. */
export interface PendingEntry {
  /** Unique identity (crypto.randomUUID when available). */
  id: string
  /** Target session the message belongs to. */
  sessionId: string
  /** Full prompt content (text plus captured image parts). */
  content: readonly PromptContentPart[]
  /** Epoch millis the message was held. */
  queuedAt: number
  /** Release attempts (retry accounting for failed prompt RPCs). */
  attempts: number
}

/** Entries as stored in localStorage (content is plain JSON). */
interface StoredEntry {
  id: string
  sessionId: string
  content: readonly {
    type: 'text' | 'image'
    text?: string
    mediaType?: string
    data?: string
    name?: string
  }[]
  queuedAt: number
  attempts: number
}

/** localStorage key for the durable queue. */
const STORAGE_KEY = 'dsh-always-queue:pending:v1'

let counter = 0

/** Best-effort unique id (crypto absent in odd environments). */
function newId(): string {
  counter += 1
  try {
    const c = globalThis.crypto as { randomUUID?: () => string } | undefined
    if (c?.randomUUID !== undefined) return c.randomUUID()
  } catch {
    /* fall through to the synthetic id */
  }
  return `aq-${Date.now().toString(36)}-${counter}`
}

/** Whether the raw stored content parses as a valid entry content. */
function parseContent(raw: unknown): readonly PromptContentPart[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const parts: PromptContentPart[] = []
  for (const part of raw) {
    if (typeof part !== 'object' || part === null) return undefined
    const p = part as Record<string, unknown>
    if (p.type === 'text' && typeof p.text === 'string') {
      parts.push({ type: 'text', text: p.text })
    } else if (
      p.type === 'image'
      && (p.mediaType === 'image/png' || p.mediaType === 'image/jpeg' || p.mediaType === 'image/webp' || p.mediaType === 'image/gif')
      && typeof p.data === 'string'
    ) {
      parts.push({
        type: 'image',
        mediaType: p.mediaType,
        data: p.data,
        ...(typeof p.name === 'string' ? { name: p.name } : {}),
      })
    } else {
      return undefined
    }
  }
  return parts
}

/** Rehydrate the durable queue (malformed storage degrades to an empty queue). */
function rehydrate(): PendingEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (raw === null || raw === undefined) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const entries: PendingEntry[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const e = item as Record<string, unknown>
      if (typeof e.id !== 'string' || typeof e.sessionId !== 'string') continue
      const content = parseContent(e.content)
      if (content === undefined) continue
      entries.push({
        id: e.id,
        sessionId: e.sessionId,
        content,
        queuedAt: typeof e.queuedAt === 'number' ? e.queuedAt : Date.now(),
        attempts: typeof e.attempts === 'number' ? e.attempts : 0,
      })
    }
    return entries
  } catch {
    return []
  }
}

/** Throttle for persist-failure warnings (one per minute). */
let lastPersistWarnAt = 0

/**
 * Persist the queue. Quota/private-mode failures only disable persistence —
 * but they are traced (throttled), because silent persistence loss is exactly
 * how a held message "disappears" on the next reload.
 */
function persist(entries: readonly PendingEntry[]): void {
  try {
    const stored: StoredEntry[] = entries.map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      content: entry.content as StoredEntry['content'],
      queuedAt: entry.queuedAt,
      attempts: entry.attempts,
    }))
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch (error: unknown) {
    const now = Date.now()
    if (now - lastPersistWarnAt >= 60000) {
      lastPersistWarnAt = now
      console.warn('[dsh-always-queue] localStorage persist FAILED — held messages will not survive a reload', error)
    }
  }
}

/**
 * The pending-queue external store (plain subscribe/getSnapshot; React bridges
 * it through useSyncExternalStore). Not a cordis service on purpose: the gate,
 * the release loop, and the dock all live in one bundle and share this one
 * instance.
 */
export const pendingStore = {
  /** FIFO entries (head releases first). */
  entries: (): readonly PendingEntry[] => state,

  /** Subscribe to every queue mutation. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },

  /**
   * Cached per-session snapshot for useSyncExternalStore: stable identity
   * between mutations, recomputed lazily on the first read after one.
   * @param sessionId - the session whose held messages are requested.
   */
  getSnapshotFor(sessionId: string): readonly PendingEntry[] {
    let cached = sessionCache.get(sessionId)
    if (cached === undefined) {
      cached = state.filter(entry => entry.sessionId === sessionId)
      sessionCache.set(sessionId, cached)
    }
    return cached
  },

  /** Head entry id (the next session to start), for diagnostics/tests. */
  head(): PendingEntry | undefined {
    return state[0]
  },

  /** Append one held message at the tail (FIFO). */
  add(input: { sessionId: string; content: readonly PromptContentPart[] }): PendingEntry {
    const entry: PendingEntry = {
      id: newId(),
      sessionId: input.sessionId,
      content: [...input.content],
      queuedAt: Date.now(),
      attempts: 0,
    }
    state = [...state, entry]
    mutate()
    return entry
  },

  /** Remove one entry by id (no-op when it already left). */
  remove(id: string): void {
    if (!state.some(entry => entry.id === id)) return
    state = state.filter(entry => entry.id !== id)
    mutate()
  },

  /**
   * Remove and return every entry of one session in FIFO order (the release
   * batch take).
   * @param sessionId - the session being released.
   */
  takeBatchFor(sessionId: string): readonly PendingEntry[] {
    const batch = state.filter(entry => entry.sessionId === sessionId)
    if (batch.length === 0) return []
    const ids = new Set(batch.map(entry => entry.id))
    state = state.filter(entry => !ids.has(entry.id))
    mutate()
    return batch
  },

  /**
   * Put one failed release back at the head (it retries before anything held
   * later), carrying the incremented attempt count. Replaces the stored copy
   * of the same id — the entry stays in the queue while it retries, so a
   * no-op here would freeze the attempt count (and any backoff built on it).
   */
  requeueFront(entry: PendingEntry): void {
    if (state.some(e => e.id === entry.id)) {
      state = [entry, ...state.filter(e => e.id !== entry.id)]
    } else {
      state = [entry, ...state]
    }
    mutate()
  },

  /** Drop every entry (test helper). */
  clear(): void {
    if (state.length === 0) return
    state = []
    mutate()
  },
}

let state: readonly PendingEntry[] = rehydrate()
if (state.length > 0) persist(state)
const listeners = new Set<() => void>()
const sessionCache = new Map<string, readonly PendingEntry[]>()

function mutate(): void {
  sessionCache.clear()
  persist(state)
  for (const fn of [...listeners]) fn()
}
