/**
 * dsh-always-queue — browser half.
 *
 * The single-in-progress gate, entirely client-side:
 *
 * 1. registers the alwaysQueue dictionaries;
 * 2. gates the conversation service's send verbs at the INSTANCE level:
 *    sendSession / send are wrapped as own properties of the service
 *    instance. This intercepts every read path — both ctx.get('conversation')
 *    (what the composer's InputHub sink calls) and ctx.conversation property
 *    access — because both resolve through the cordis traceable proxy, which
 *    exposes instance own-properties with the per-caller ctx rebinding
 *    intact. (The internal/get waterfall only fires on property access; the
 *    composer sink reads the store directly, so a waterfall listener would
 *    never see it.) A send addressed to a session that is NOT itself running
 *    is HELD while any other session is busy. There is deliberately no
 *    send-immediately path for held messages. Sends to the running session
 *    pass through untouched, so the default in-session queueing and steer
 *    behavior is preserved exactly;
 * 3. a HELD first send mirrors the harness's first-send engagement on the
 *    target session (promptAttempted / blankBit flip + onEngaged list
 *    mutation): without it the session would stay blank in every client
 *    projection — the New Session flow reuses blank sessions, so the user
 *    could not create a second new session while the first one's message
 *    waited. The same hold assigns the session its provisional title via
 *    rename (the deterministic first-five-words fallback, byte-identical to
 *    the title the host would derive when the message releases), so the
 *    sidebar shows it like the normal flow instead of the workspace name;
 * 4. runs the release loop: when nothing is busy, the oldest waiting
 *    session's whole batch is released through session.prompt in FIFO order.
 *    A CLAIM marks a session busy from the moment its turn starts
 *    (pass-through or release) until its running flag lands in the list
 *    snapshot (or a safety timeout), so host-flag latency can never open a
 *    second session in the gap. Liveness: a check that arrives while a
 *    release is in flight re-runs after it settles, a sweep timer re-checks
 *    when the oldest claim expires, and a stuck-gate watchdog re-pulls the
 *    host list when the gate stays closed with a non-empty queue — a missed
 *    running frame or a quiet host can never wedge the queue, and failed
 *    releases retry with capped backoff instead of dropping the message;
 * 6. traces every gate decision, claim, release and queue mutation to the
 *    browser console under the [dsh-always-queue] prefix (plus a 30 s
 *    heartbeat while anything is held) — the debug surface for stuck queues;
 * 5. registers an ADDITIONAL conversation.input.dock entry (id always-queue,
 *    order 30) so held messages are visible per session.
 *
 * All @deepseek-ai/* imports are type-only: collaboration happens through
 * cordis services, events, and slot registration only (client bundle purity).
 */
import type {
  ClientContext, PromptContentPart, RpcResult, SessionId, SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  IConversation, SubmitImageAttachment,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, en, zh } from './locales.ts'
import { AlwaysQueueDock } from './dock.tsx'
import type { AlwaysQueueDockInjected } from './dock.tsx'
import { pendingStore } from './pending-store.ts'
import { decideGate, releaseBatch } from './gate.ts'

/** Services required by the browser half (fiber injection list). */
export const inject = ['slots', 'locale', 'sessions', 'conversation']

/**
 * The traceable-proxy escape hatch: reading this symbol off a face returns
 * the raw service instance behind every traceable wrapper (cordis symbols,
 * global registry).
 */
const ORIGINAL = Symbol.for('cordis.original')

/** Marker on wrapped verbs so re-provisioning never double-wraps. */
const GATED = Symbol.for('dsh-always-queue.gated')

/**
 * Diagnostic console prefix. Every gate decision, claim transition, release
 * attempt and queue mutation is traced here (console.debug) so a stuck queue
 * is visible in the browser DevTools console without any other tooling.
 */
const LOG = '[dsh-always-queue]'

/** One diagnostic trace line (the debug surface for the single-session gate). */
const log = (...args: unknown[]): void => { console.debug(LOG, ...args) }

/**
 * Claim safety valve: a turn that starts and finishes before its host
 * running frame lands keeps the next session waiting at most this long.
 */
const CLAIM_TIMEOUT_MS = 15000

/** Failed prompt RPCs retry this often, doubling per attempt (list updates also re-trigger). */
const RELEASE_RETRY_MS = 2000

/** Cap of the release-retry backoff (2s doubling from RELEASE_RETRY_MS). */
const RELEASE_RETRY_MAX_MS = 60000

/**
 * Release-poll cadence while anything is held: the release check runs on
 * this timer INDEPENDENTLY of list events, so a completed session's queued
 * successor starts within one poll even if its status frame was lost, the
 * list subscription died, or no further event ever arrives. (Contract:
 * the queue pops within ~15 s of a session completing — 5 s gives 3x margin
 * over frame latency.)
 */
const RELEASE_POLL_MS = 5000

/**
 * A release is STUCK when its prompt RPC has been in flight this long
 * without settling: the connection is dead and the finally-block that
 * clears releasing will never run. The poller force-resets it (a hung
 * delivery may then be resent — a duplicate is preferable to a silently
 * lost message).
 */
const STUCK_RELEASE_MS = 30000

/**
 * Stuck-gate watchdog: while the queue is non-empty and the gate stays closed
 * this long (with no release in flight), the page re-pulls the host list — a
 * client-side running flag that missed its status frame (lost frame, quiet
 * host) self-heals against the host truth instead of holding the queue
 * forever. The re-pull is read-only: the gate is never forced open.
 */
const STUCK_GATE_AFTER_MS = 60000

/**
 * Provisional-title caps — mirrored from the web assembly's session-title
 * configuration (fallbackMaxWords/fallbackMaxBytes), so a held first send
 * titles the session with exactly the text the host's fallback would.
 */
const TITLE_FALLBACK_MAX_WORDS = 5
const TITLE_FALLBACK_MAX_BYTES = 40

/**
 * Control-escape sanitization — mirrors the harness title normalization
 * verbatim; the control characters are the point (they are stripped from
 * title text).
 */
/* eslint-disable no-control-regex -- intentional: mirrors the harness sanitizer */
const TITLE_OSC = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
const TITLE_CSI = /(?:\u001B\[|\u001B)[0-?]*[ -/]*[@-~]/gu
const TITLE_ESC = /\u001B[@-_]/gu
const TITLE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
const TITLE_DIRECTIONAL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu
/* eslint-enable no-control-regex */

/** The input-hub face the gate reaches for composer notices. */
interface InputHubLike {
  for(actx: unknown): {
    notify(level: 'info' | 'error', text: string): void
  }
}

/** A verb pair on the conversation service instance. */
type GateVerbs = 'send' | 'sendSession'

/**
 * Derive the deterministic first-five-words fallback title (the same text
 * the host would fold at release time: sanitized, whitespace-collapsed,
 * five leading words, capped at 40 UTF-8 bytes without splitting a code
 * point).
 * @param input - raw first-message text.
 * @returns the normalized title text, possibly empty.
 */
function fallbackTitle(input: string): string {
  const cleaned = input
    .replace(TITLE_OSC, '')
    .replace(TITLE_CSI, '')
    .replace(TITLE_ESC, '')
    .replace(TITLE_CONTROL, '')
    .replace(TITLE_DIRECTIONAL, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const words = cleaned.split(' ').filter(Boolean).slice(0, TITLE_FALLBACK_MAX_WORDS)
  let used = 0
  let output = ''
  for (const character of words.join(' ')) {
    const bytes = new TextEncoder().encode(character).length
    if (used + bytes > TITLE_FALLBACK_MAX_BYTES) break
    output += character
    used += bytes
  }
  return output.trimEnd()
}

/** The first text part of a held content (the title source), if any. */
function firstTextOf(content: readonly PromptContentPart[]): string | undefined {
  for (const part of content) {
    if (part.type === 'text') return part.text
  }
  return undefined
}

/**
 * Client plugin body: dictionaries, the conversation-service gate, the
 * release loop, and the pending-queue dock entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  log('client apply (browser half)')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-always-queue: dictionaries')

  const sessions = ctx.sessions
  if (sessions === undefined) return
  const t = ctx.locale.bind(NS)

  // ----- Gate state.
  /** SessionId -> claim timestamp: busy from turn start until the running flag lands. */
  const claims = new Map<string, { at: number }>()
  /**
   * SessionIds this plugin engaged client-side (a held first send flipped the
   * row un-blank locally while the host still reports the session blank). The
   * flip is ONE-SHOT: the harness applies it as a single 'engaged' list
   * mutation, and a full list re-fetch (sessions.refresh — including this
   * plugin's own stuck-gate watchdog) replaces the host baseline and drops
   * the mutation, re-blanking the row. reassertEngaged re-flips those rows on
   * every list change so the New Session reuse scan can never mistake a held
   * session for a fresh slot.
   */
  const engagedIds = new Set<string>()
  let releasing = false
  /** When the in-flight release started (the stuck-release watchdog). */
  let releasingSince = 0
  /** A check arrived while a release was in flight: re-run it when that settles. */
  let releaseQueuedAfterInflight = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let claimSweepTimer: ReturnType<typeof setTimeout> | undefined
  /** When the gate last was observed closed with a non-empty queue (diagnostics). */
  let gateClosedSince: number | undefined
  /** One-shot timer that re-validates a long-closed gate against the host list. */
  let stuckGateTimer: ReturnType<typeof setTimeout> | undefined
  const inFlight = new Set<string>()

  /**
   * Re-arm the sweep timer: re-check when the OLDEST active claim expires
   * (plus a margin). Nothing else may be required to wake the queue — a
   * missed running frame or a quiet host must not wedge a held message.
   */
  const syncClaimSweep = (): void => {
    if (claimSweepTimer !== undefined) {
      clearTimeout(claimSweepTimer)
      claimSweepTimer = undefined
    }
    let soonest: number | undefined
    for (const claim of claims.values()) {
      soonest = soonest === undefined ? claim.at : Math.min(soonest, claim.at)
    }
    if (soonest === undefined) return
    const delay = Math.max(50, soonest + CLAIM_TIMEOUT_MS + 50 - Date.now())
    claimSweepTimer = setTimeout(checkRelease, delay)
  }

  /**
   * Retire claims: dropped once the host running flag confirms the turn
   * (the flag then owns the tracking) or the safety valve elapses (fast
   * turn that finished before its frame landed).
   */
  const retireClaims = (list: SessionListState): void => {
    for (const [id, claim] of [...claims]) {
      const summary = list.byId[id as SessionId]
      if (summary?.running === true || Date.now() - claim.at > CLAIM_TIMEOUT_MS) {
        claims.delete(id)
        log('claim retired', id, summary?.running === true ? '(running flag landed)' : '(safety valve elapsed)')
      }
    }
    syncClaimSweep()
  }

  /** Every session that currently counts as in progress (flag or claim). */
  const busyIds = (list: SessionListState): string[] => {
    const busy: string[] = []
    const seen = new Set<string>()
    for (const summary of Object.values(list.byId)) {
      if (summary.running) {
        busy.push(summary.id)
        seen.add(summary.id)
      }
    }
    for (const id of claims.keys()) {
      if (!seen.has(id)) busy.push(id)
    }
    return busy
  }

  /**
   * Busy rows annotated with WHAT holds them (host running flag vs plugin
   * claim) — the diagnostics payload of every closed-gate trace.
   */
  const describeBusy = (list: SessionListState, busy: string[]): { id: string; kind: 'flag' | 'claim' }[] =>
    busy.map(id => ({
      id,
      kind: list.byId[id as SessionId]?.running === true ? 'flag' as const : 'claim' as const,
    }))

  /**
   * The titles of the session(s) holding the gate (host running flag or
   * plugin claim) — what the dock banner and the hold notice show: a queued
   * message must never look stalled without saying WHO is running.
   * @param list - fresh list snapshot.
   * @param busy - busy ids (from busyIds).
   */
  const holderNames = (list: SessionListState, busy: readonly string[]): string => {
    if (busy.length === 0) return ''
    const names = busy
      .map(id => list.byId[id as SessionId])
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map(s => s.title || s.displayTitle || '')
      .filter(Boolean)
    return names.length > 0 ? names.join(', ') : busy.length + ' session(s)'
  }

  /**
   * External store for the current gate-holder text (the dock banner reads
   * it with useSyncExternalStore). Republished on every list change and
   * send; the string identity gates re-renders.
   */
  const holdersState: { text: string; listeners: Set<() => void> } = {
    text: '',
    listeners: new Set<() => void>(),
  }
  const publishHolders = (list: SessionListState): void => {
    const text = list.phase === 'ready' ? holderNames(list, busyIds(list)) : ''
    if (text === holdersState.text) return
    holdersState.text = text
    for (const fn of [...holdersState.listeners]) fn()
  }

  /**
   * Stuck-gate state reset: the queue is empty or the gate is open, so no
   * re-validation may be pending.
   */
  const resetStuckGate = (): void => {
    gateClosedSince = undefined
    if (stuckGateTimer !== undefined) {
      clearTimeout(stuckGateTimer)
      stuckGateTimer = undefined
    }
  }

  /**
   * Arm the stuck-gate watchdog (at most one timer): once the gate has stayed
   * closed with a non-empty queue for STUCK_GATE_AFTER_MS, re-validate against
   * the host list. A still-stuck gate re-arms for the next full interval, so
   * the cadence is one read-only list pull per interval.
   */
  const armStuckGate = (): void => {
    const now = Date.now()
    if (gateClosedSince === undefined) gateClosedSince = now
    if (stuckGateTimer !== undefined) return
    const wait = Math.max(0, gateClosedSince + STUCK_GATE_AFTER_MS - now)
    stuckGateTimer = setTimeout(() => {
      stuckGateTimer = undefined
      gateClosedSince = Date.now()
      revalidateList()
    }, wait)
  }

  /**
   * Stuck-gate revalidation: re-pull the host list (and the subagent catalogs
   * busy rows belong to) so a client-side running flag that missed its status
   * frame converges on the host truth. The list subscription re-runs the
   * release check with the corrected flags. Read-only — the gate is never
   * forced open. Best effort: refresh() is a harness-runtime method absent
   * from the narrow contract face (and from test doubles).
   */
  const revalidateList = (): void => {
    const list = sessions.list.getSnapshot()
    const busy = busyIds(list)
    log('stuck-gate: gate closed with', pendingStore.entries().length, 'held message(s) for',
      gateClosedSince === undefined ? 0 : Date.now() - gateClosedSince, 'ms (busy:',
      JSON.stringify(describeBusy(list, busy)), ') — re-pulling host list')
    const s = sessions as unknown as {
      refresh?: () => Promise<unknown>
      refreshSubagents?: (parentId: SessionId) => Promise<unknown>
    }
    try {
      if (typeof s.refresh === 'function') {
        void s.refresh().then(
          () => log('stuck-gate: host list re-pulled'),
          (error: unknown) => console.warn(LOG, 'stuck-gate: list re-pull failed', error),
        )
      } else {
        console.warn(LOG, 'stuck-gate: sessions.refresh unavailable — cannot revalidate')
      }
      const parents = new Set<string>()
      for (const id of busy) {
        const parentId = list.byId[id as SessionId]?.parentId
        if (parentId !== undefined) parents.add(parentId)
      }
      for (const parentId of parents) {
        if (typeof s.refreshSubagents !== 'function') break
        void s.refreshSubagents(parentId as SessionId).catch(() => {})
      }
    } catch (error) {
      console.warn(LOG, 'stuck-gate: revalidation threw', error)
    }
  }

  /**
   * Best-effort composer notice that a message was held (no scope, silent).
   * Names the session(s) holding the gate so the wait is never a mystery.
   * @param sessionId - the held message's target session.
   * @param holders - gate-holder text at hold time ('' when unknown).
   */
  const notifyHeld = (sessionId: string, holders: string): void => {
    try {
      const actx = sessions.scope(sessionId as SessionId)
      if (actx === undefined) return
      hubInput?.for(actx).notify('info', holders !== '' ? t('queued.by', { who: holders }) : t('queued'))
    } catch {
      /* best-effort only */
    }
  }

  /** Best-effort composer notice that a held message's release failed (or vanished). */
  const notifyReleaseFailure = (sessionId: string, text: string): void => {
    try {
      const actx = sessions.scope(sessionId as SessionId)
      if (actx === undefined) return
      hubInput?.for(actx).notify('error', text)
    } catch {
      /* best-effort only */
    }
  }

  /**
   * Mirror the harness's first-send engagement on a held session, so the
   * client list row stops reporting blank: a held prompt is never admitted
   * by the host, so without this the session stays blank in every client
   * projection — and the New Session flow reuses blank sessions, making a
   * second new session uncreatable while the first one's message waits.
   * Best effort: the fields are harness-internal (Session instance); if
   * the shape ever changes the hold still works and only the reuse quirk
   * returns.
   * @param session - the target session face from the binding.
   */
  const engageSession = (session: object | undefined): void => {
    if (session === undefined) return
    try {
      const s = session as Record<string, unknown>
      s.promptAttempted = true
      if (s.blankBit === true) {
        s.blankBit = false
        s.firstPromptPendingTurn = true
        const options = s.options as { onEngaged?: (session: object) => void } | undefined
        options?.onEngaged?.(session)
        const sid = s.sessionId
        if (typeof sid === 'string') engagedIds.add(sid)
      }
      const notifier = s.notifier as { markDirty?: () => void } | undefined
      notifier?.markDirty?.()
    } catch {
      /* best-effort only */
    }
  }

  /**
   * Re-assert the client-side un-blank on every engaged session a full list
   * re-fetch re-blanked (the one-shot 'engaged' mutation is dropped when a
   * refetch lands, and the harness re-applies the host blank state to the
   * Session itself). Without this, a held session's row reports blank again:
   * the New Session reuse scan silently reuses it and the next prompt joins
   * its queue instead of opening a new session ("New Session does nothing").
   * Idempotent: flipping re-records the 'engaged' mutation, which the harness
   * replays if another refetch is in flight.
   * @param list - fresh list snapshot (any phase; non-ready is skipped).
   */
  const reassertEngaged = (list: SessionListState): void => {
    if (list.phase !== 'ready' || engagedIds.size === 0) return
    let flipped = 0
    for (const id of [...engagedIds]) {
      const summary = list.byId[id as SessionId]
      if (summary === undefined) {
        // Session left the list: nothing left to keep un-blanked.
        engagedIds.delete(id)
        continue
      }
      if (summary.blank !== true) {
        // Host-side un-blank stuck (a turn landed): the refetch baseline
        // carries blank false from now on, so re-assertion is never needed.
        if (pendingStore.entries().every(entry => entry.sessionId !== id)) {
          engagedIds.delete(id)
        }
        continue
      }
      const binding = sessions.binding(id as SessionId)
      const session = (binding?.session ?? undefined) as Record<string, unknown> | undefined
      if (session === undefined) {
        log('re-assert: no binding for', id, '— cannot re-flip (row stays blank until release)')
        continue
      }
      try {
        if (session.blankBit === true) {
          session.blankBit = false
          session.firstPromptPendingTurn = true
        }
        const options = session.options as { onEngaged?: (session: object) => void } | undefined
        options?.onEngaged?.(session)
        const notifier = session.notifier as { markDirty?: () => void } | undefined
        notifier?.markDirty?.()
        flipped += 1
        log('re-assert: un-blank re-flipped for', id, '(refetch dropped the engaged mutation)')
      } catch {
        /* best-effort only */
      }
    }
    if (flipped > 0) log('re-assert: done — flipped', flipped, 'engaged row(s); tracking', [...engagedIds].join(','))
  }

  /**
   * Give a held blank session its provisional title: the deterministic
   * first-five-words fallback, exactly the text the host would derive when
   * the message releases. Rename pins the title (user source), which
   * suppresses later automatic revision — acceptable because the provisional
   * text IS the fallback the automatic path would produce. Best effort:
   * failures leave the title for the release path to derive.
   * @param binding - target session binding, if eligible.
   * @param summary - target row from the list snapshot at hold time.
   * @param text - first text part of the held content.
   */
  const provisionTitle = (
    binding: { session: { rename(title: string): Promise<unknown> } } | undefined,
    summary: { blank?: boolean; title?: string } | undefined,
    text: string | undefined,
  ): void => {
    if (binding === undefined || summary === undefined) return
    if (summary.blank !== true || summary.title !== undefined) return
    if (text === undefined || text.trim() === '') return
    const title = fallbackTitle(text)
    if (title.length === 0) return
    void binding.session.rename(title).catch(() => {
      /* best-effort only */
    })
  }

  /**
   * One intercepted send: hold when the gate is closed, else pass through.
   * self is the receiver the traceable proxy handed to the verb (the
   * per-caller shadow); original is the pre-wrap verb it shadows.
   */
  const gate = async (
    prop: GateVerbs,
    self: object,
    original: (...args: never[]) => unknown,
    args: readonly unknown[],
  ): Promise<unknown> => {
    const passThrough = (): unknown => Reflect.apply(original, self, args)

    // Resolve the addressed session (and, for sendSession, the mode).
    let targetId: string | undefined
    let mode: string | undefined
    if (prop === 'sendSession') {
      const session = args[0] as { sessionId?: SessionId } | undefined
      targetId = session?.sessionId
      mode = typeof args[3] === 'string' ? args[3] : undefined
    } else {
      // Plain send addresses the CALLER scope: the shadow overlays the
      // reading context on the face's ctx property.
      const callerCtx = Reflect.get(self, 'ctx', self)
      if (callerCtx !== undefined) targetId = sessions.scopeOf(callerCtx)
    }
    if (targetId === undefined) return passThrough()

    const list = sessions.list.getSnapshot()
    if (list.phase !== 'ready') return passThrough()
    // A refetch may have re-blanked an engaged row between sends: heal it
    // before the verdict so the reuse scan never sees a stale blank.
    reassertEngaged(list)
    publishHolders(list)

    const targetRunning = list.byId[targetId as SessionId]?.running === true
    // A steer can never start a session: let the host handle (or reject) it
    // exactly as without the plugin.
    if (mode === 'steer' && !targetRunning) return passThrough()

    const busy = busyIds(list)
    const verdict = decideGate({
      targetRunning,
      otherBusy: busy.some(id => id !== targetId),
    })
    log('gate', {
      prop, targetId, mode: mode ?? null, phase: list.phase, targetRunning,
      busy: describeBusy(list, busy), verdict,
    })
    if (verdict !== 'hold') {
      // A pass-through send to an idle session starts a turn: claim it so
      // host-flag latency cannot open a second session in the gap.
      if (!targetRunning) {
        claims.set(targetId, { at: Date.now() })
        syncClaimSweep()
        log('claim set (pass-through send)', targetId)
      }
      return passThrough()
    }

    // ----- hold: capture the full content, store it, report success locally.
    let content: readonly PromptContentPart[]
    if (prop === 'sendSession') {
      const text = typeof args[1] === 'string' ? args[1] : ''
      const imageIds = Array.isArray(args[2]) ? (args[2] as readonly string[]) : []
      if (imageIds.length > 0) {
        let images: readonly SubmitImageAttachment[]
        try {
          const serializer = Reflect.get(self, 'serializeDraftImages', self)
          images = await Reflect.apply(
            serializer as (ids: readonly string[]) => Promise<readonly SubmitImageAttachment[]>,
            self,
            [imageIds],
          )
        } catch {
          // Drafts no longer resolvable: behave exactly as without the plugin
          // (the original path surfaces its own failure).
          return passThrough()
        }
        // Captured: release the draft attachments so previews do not leak
        // (the committed draft no longer references them).
        for (const id of imageIds) {
          const releaser = Reflect.get(self, 'releaseDraftImage', self)
          Reflect.apply(releaser as (id: string) => void, self, [id])
        }
        content = [
          ...images.map(part => ({
            type: 'image' as const,
            mediaType: part.mediaType,
            data: part.data,
            ...(part.name !== undefined ? { name: part.name } : {}),
          })),
          ...(text === '' ? [] : [{ type: 'text' as const, text }]),
        ]
      } else {
        content = text === '' ? [] : [{ type: 'text' as const, text }]
      }
      if (content.length === 0) return passThrough()
    } else {
      const text = args[0]
      if (typeof text !== 'string' || text === '') return passThrough()
      content = [{ type: 'text' as const, text }]
    }

    const held = pendingStore.add({ sessionId: targetId, content })
    log('held', {
      sessionId: targetId, id: held.id,
      parts: content.map(part => part.type).join(','),
      queueLength: pendingStore.entries().length,
      busy: describeBusy(list, busyIds(list)),
    })

    // Engage the target locally (un-blank it for the list / New Session flow)
    // and give it its provisional title — the same first-five-words text the
    // host would derive when the message releases.
    const binding = sessions.binding(targetId as SessionId)
    // Capture the row BEFORE the engage flip: the provisional-title decision
    // must judge the pre-flip (blank) state, never the locally un-blanked one.
    const targetSummary = list.byId[targetId as SessionId]
    engageSession(binding?.session)
    provisionTitle(
      binding === undefined ? undefined : { session: binding.session },
      targetSummary,
      firstTextOf(content),
    )

    notifyHeld(targetId, holderNames(list, busy))
    checkRelease() // close the race: the busy session may have just finished
    return prop === 'sendSession' ? { kind: 'success' } : undefined
  }

  /** Wrap the send verbs on the raw instance (idempotent via the GATED marker). */
  const patchConversation = (raw: object): void => {
    for (const prop of ['sendSession', 'send'] as const) {
      const current = Reflect.get(raw, prop, raw)
      if (typeof current !== 'function') continue
      if ((current as Record<PropertyKey, unknown>)[GATED] !== undefined) continue
      const original = current as (...args: never[]) => unknown
      const gated = function (this: object, ...args: unknown[]): Promise<unknown> {
        return gate(prop, this, original, args)
      }
      ;(gated as unknown as Record<PropertyKey, unknown>)[GATED] = true
      Reflect.set(raw, prop, gated, raw)
    }
  }

  // Gate the live instance immediately (the fiber injected the service, so it
  // is active when this runs), and re-gate on any (re)provision: the
  // internal/service event carries the raw impl value; global skips the
  // scope filter.
  const face = ctx.get('conversation') as object | undefined
  if (face !== undefined && face !== null) {
    patchConversation(Reflect.get(face, ORIGINAL, face) ?? face)
  }
  ctx.on(
    'internal/service',
    (name: string, value: unknown) => {
      if (name !== 'conversation' || value === undefined || value === null) return
      log('re-gate: internal/service event for', name)
      patchConversation(value)
    },
    { global: true },
  )

  const conversation = ctx.get('conversation') as IConversation | undefined
  const hubInput: InputHubLike | undefined = conversation?.input as InputHubLike | undefined

  /**
   * The release loop: retire claims, then — only when nothing reports busy —
   * release the oldest waiting session's whole batch in FIFO order (skipping
   * in-flight entries).
   */
  const checkRelease = (): void => {
    // A check arriving mid-release (a status frame racing the RPC) re-runs
    // after the in-flight batch settles, so no frame is ever lost.
    if (releasing) {
      if (releasingSince !== 0 && Date.now() - releasingSince > STUCK_RELEASE_MS) {
        // The prompt RPC never settled: the connection is dead and the
        // finally-block that clears releasing will never run. Without this,
        // every later check skips forever — the queue freezes with no
        // spinner anywhere. Force-reset; a hung delivery may be resent.
        console.error(LOG, 'release: STUCK — prompt RPC in flight for',
          Date.now() - releasingSince, 'ms without settling; forcing reset',
          '(a hung delivery may be resent — a duplicate beats a lost message)')
        releasing = false
        releasingSince = 0
        inFlight.clear()
        // fall through: re-run the check on the current state
      } else {
        releaseQueuedAfterInflight = true
        log('release: skip (release in flight — re-check queued)')
        return
      }
    }
    const list = sessions.list.getSnapshot()
    retireClaims(list)
    // Every list change (including a stuck-gate refetch completing) re-asserts
    // the client-side un-blank the harness's one-shot mutation may have lost.
    reassertEngaged(list)
    // ...and republishes the gate-holder text for the dock banner.
    publishHolders(list)
    if (list.phase !== 'ready') {
      resetStuckGate()
      log('release: skip (list phase', list.phase + ')')
      return
    }
    const entries = pendingStore.entries().filter(entry => !inFlight.has(entry.id))
    if (entries.length === 0) {
      resetStuckGate()
      return
    }
    const busy = busyIds(list)
    if (busy.length > 0) {
      // Gate closed: hold the queue. If it STAYS closed while messages wait,
      // the watchdog re-validates the client flags against the host list —
      // a missed status frame must never wedge a held message forever.
      armStuckGate()
      log('release: hold (gate closed by', JSON.stringify(describeBusy(list, busy)),
        '; pending sessions:', [...new Set(entries.map(e => e.sessionId))].join(','), ')')
      return
    }
    const batch = releaseBatch(entries)
    if (batch.length === 0) {
      resetStuckGate()
      return
    }

    resetStuckGate() // gate open: the release starts
    releasing = true
    releasingSince = Date.now()
    log('release: start batch for session', batch[0]?.sessionId, '(', batch.length, 'entries)')
    void (async () => {
      let releasedSession: string | undefined
      try {
        for (const entry of batch) {
          inFlight.add(entry.id)
          const binding = sessions.binding(entry.sessionId as SessionId)
          if (binding === undefined) {
            // The session vanished while its message waited: drop it — but
            // say so (a silent loss reads as "the message was forgotten").
            pendingStore.remove(entry.id)
            inFlight.delete(entry.id)
            console.error(LOG, 'dropping held message: session vanished from the list before release', {
              sessionId: entry.sessionId, id: entry.id,
            })
            notifyReleaseFailure(entry.sessionId, t('releaseGone'))
            continue
          }
          log('release: prompt →', entry.sessionId, 'entry', entry.id,
            'attempt', entry.attempts + 1, 'parts:', entry.content.map(part => part.type).join(','))
          let result: RpcResult<{ accepted: true }>
          try {
            result = await binding.session.prompt(entry.content, 'queue')
          } catch {
            result = { ok: false, error: { code: 'transport', message: 'prompt RPC failed' } }
          }
          inFlight.delete(entry.id)
          if (result.ok === true) {
            pendingStore.remove(entry.id)
            releasedSession ??= entry.sessionId
            log('release: delivered', entry.sessionId, 'entry', entry.id)
            continue
          }
          // Failed release: NEVER drop the message silently. Keep it at the
          // head with capped exponential backoff (list updates re-trigger
          // independently), and tell the user it is still queued.
          const attempts = entry.attempts + 1
          log('release: FAILED', entry.sessionId, 'entry', entry.id,
            'attempt', attempts, 'error:', JSON.stringify(result.error))
          if (result.error?.code === 'session-not-found') {
            // The host removed the session: nowhere left to deliver to.
            pendingStore.remove(entry.id)
            console.error(LOG, 'dropping held message: target session no longer exists on the host', {
              sessionId: entry.sessionId, id: entry.id, error: result.error,
            })
            notifyReleaseFailure(entry.sessionId, t('releaseGone'))
            break
          }
          pendingStore.requeueFront({ ...entry, attempts })
          const delay = Math.min(
            RELEASE_RETRY_MS * 2 ** Math.min(attempts - 1, 6),
            RELEASE_RETRY_MAX_MS,
          )
          retryTimer = setTimeout(checkRelease, delay)
          if (attempts === 1 || attempts % 5 === 0) {
            notifyReleaseFailure(entry.sessionId,
              t('releaseFailed', { n: attempts, code: result.error?.code ?? 'unknown' }))
          }
          break
        }
        if (releasedSession !== undefined) {
          // Claim the released session: it counts as busy until its running
          // flag lands (or the claim safety valve elapses — the sweep timer
          // then re-checks even if no further list update ever arrives).
          claims.set(releasedSession, { at: Date.now() })
          syncClaimSweep()
          log('claim set (release)', releasedSession)
        }
      } finally {
        releasing = false
        releasingSince = 0
        if (releaseQueuedAfterInflight) {
          releaseQueuedAfterInflight = false
          checkRelease()
        }
      }
    })()
  }

  // Subscribe the release loop to the session list (status frames drive it);
  // run once at boot to pick up a persisted queue after a reload.
  ctx.effect(() => {
    log('release loop subscribed (boot entries:', pendingStore.entries().length, ')')
    const off = sessions.list.subscribe(() => checkRelease())
    checkRelease()
    return () => {
      log('release loop torn down')
      off()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      if (claimSweepTimer !== undefined) clearTimeout(claimSweepTimer)
      if (stuckGateTimer !== undefined) clearTimeout(stuckGateTimer)
    }
  }, 'dsh-always-queue: release loop')

  // Release poller: while anything is held, re-run the release check on a
  // fixed cadence INDEPENDENT of list events. A completed session's queued
  // successor then starts within one poll (5 s) even if its status frame
  // was lost, the list subscription died, or no further event ever arrives —
  // the hard guarantee behind "the queue pops within 15 s of a session
  // completing". The poller also gets the stuck-release watchdog its ticks.
  ctx.effect(() => {
    log('release poller armed (every', RELEASE_POLL_MS, 'ms while anything is held)')
    const timer = setInterval(() => {
      if (pendingStore.entries().length === 0) return
      checkRelease()
    }, RELEASE_POLL_MS)
    return () => {
      log('release poller torn down')
      clearInterval(timer)
    }
  }, 'dsh-always-queue: release poller')

  // Diagnostics heartbeat: while anything is held, a 5 s console trace of
  // the whole gate state INCLUDING the verdict the next check will take —
  // the debug surface for "my queued session never starts". Quiet while the
  // queue is empty (no console noise in normal use).
  ctx.effect(() => {
    const timer = setInterval(() => {
      const entries = pendingStore.entries()
      if (entries.length === 0) return
      const list = sessions.list.getSnapshot()
      const busy = list.phase === 'ready' ? busyIds(list) : []
      let verdict: string
      if (releasing) {
        verdict = releasingSince !== 0 && Date.now() - releasingSince > STUCK_RELEASE_MS
          ? 'STUCK release — force-reset on next poll'
          : 'release in flight (' + (releasingSince === 0 ? '?' : Date.now() - releasingSince) + ' ms)'
      } else if (list.phase !== 'ready') {
        verdict = 'list ' + list.phase
      } else if (busy.length > 0) {
        verdict = 'hold — gate closed by ' + JSON.stringify(describeBusy(list, busy))
      } else if (entries.every(e => inFlight.has(e.id))) {
        verdict = 'all entries in flight'
      } else {
        verdict = 'GATE OPEN — will release on next poll'
      }
      log('heartbeat', {
        phase: list.phase,
        verdict,
        pending: entries.map(e => ({
          id: e.id, sessionId: e.sessionId, attempts: e.attempts,
          ageMs: Date.now() - e.queuedAt,
        })),
        busy: describeBusy(list, busy),
        claims: [...claims.entries()].map(([id, c]) => ({ id, ageMs: Date.now() - c.at })),
        inFlight: [...inFlight],
        releasing,
        gateClosedForMs: gateClosedSince === undefined ? 0 : Date.now() - gateClosedSince,
      })
    }, 5000)
    return () => { clearInterval(timer) }
  }, 'dsh-always-queue: diagnostics heartbeat')

  // The pending strip: an ADDITIONAL input-dock entry (never shadows the
  // official queue strip, so the per-session inbox UI stays untouched).
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'always-queue',
    order: 30,
    locale: NS,
    inject: (sessionId: SessionId): AlwaysQueueDockInjected => {
      const actx = sessions.scope(sessionId)
      if (actx === undefined) throw new Error('always-queue dock: session resolved no scope')
      const dockFace = actx.get<IConversation>('conversation')
      if (dockFace === undefined) throw new Error('always-queue dock: conversation service unavailable')
      return {
        setDraft: (text) => { dockFace.input.for(actx).actions.setDraft(text) },
        holdersSubscribe: (fn: () => void) => {
          holdersState.listeners.add(fn)
          return () => { holdersState.listeners.delete(fn) }
        },
        holdersSnapshot: () => holdersState.text,
      }
    },
  }, AlwaysQueueDock))
}
