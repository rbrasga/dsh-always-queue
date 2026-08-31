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
 *    release is in flight re-runs after it settles, and a sweep timer
 *    re-checks when the oldest claim expires — neither a missed running
 *    frame nor a quiet host can wedge the queue;
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
 * Claim safety valve: a turn that starts and finishes before its host
 * running frame lands keeps the next session waiting at most this long.
 */
const CLAIM_TIMEOUT_MS = 15000

/** Failed prompt RPCs retry this often (list updates also re-trigger). */
const RELEASE_RETRY_MS = 2000

/** A held message is dropped (with a console.error) after this many failed releases. */
const MAX_RELEASE_ATTEMPTS = 10

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
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-always-queue: dictionaries')

  const sessions = ctx.sessions
  if (sessions === undefined) return
  const t = ctx.locale.bind(NS)

  // ----- Gate state.
  /** SessionId -> claim timestamp: busy from turn start until the running flag lands. */
  const claims = new Map<string, { at: number }>()
  let releasing = false
  /** A check arrived while a release was in flight: re-run it when that settles. */
  let releaseQueuedAfterInflight = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let claimSweepTimer: ReturnType<typeof setTimeout> | undefined
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

  /** Best-effort composer notice that a message was held (no scope, silent). */
  const notifyHeld = (sessionId: string): void => {
    try {
      const actx = sessions.scope(sessionId as SessionId)
      if (actx === undefined) return
      hubInput?.for(actx).notify('info', t('queued'))
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
      }
      const notifier = s.notifier as { markDirty?: () => void } | undefined
      notifier?.markDirty?.()
    } catch {
      /* best-effort only */
    }
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

    const targetRunning = list.byId[targetId as SessionId]?.running === true
    // A steer can never start a session: let the host handle (or reject) it
    // exactly as without the plugin.
    if (mode === 'steer' && !targetRunning) return passThrough()

    const verdict = decideGate({
      targetRunning,
      otherBusy: busyIds(list).some(id => id !== targetId),
    })
    if (verdict !== 'hold') {
      // A pass-through send to an idle session starts a turn: claim it so
      // host-flag latency cannot open a second session in the gap.
      if (!targetRunning) {
        claims.set(targetId, { at: Date.now() })
        syncClaimSweep()
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

    pendingStore.add({ sessionId: targetId, content })

    // Engage the target locally (un-blank it for the list / New Session flow)
    // and give it its provisional title — the same first-five-words text the
    // host would derive when the message releases.
    const binding = sessions.binding(targetId as SessionId)
    engageSession(binding?.session)
    provisionTitle(
      binding === undefined ? undefined : { session: binding.session },
      list.byId[targetId as SessionId],
      firstTextOf(content),
    )

    notifyHeld(targetId)
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
      releaseQueuedAfterInflight = true
      return
    }
    const list = sessions.list.getSnapshot()
    retireClaims(list)
    if (list.phase !== 'ready') return
    const entries = pendingStore.entries().filter(entry => !inFlight.has(entry.id))
    if (entries.length === 0) return
    if (busyIds(list).length > 0) return
    const batch = releaseBatch(entries)
    if (batch.length === 0) return

    releasing = true
    void (async () => {
      let releasedSession: string | undefined
      try {
        for (const entry of batch) {
          inFlight.add(entry.id)
          const binding = sessions.binding(entry.sessionId as SessionId)
          if (binding === undefined) {
            // The session vanished while its message waited: drop it.
            pendingStore.remove(entry.id)
            inFlight.delete(entry.id)
            continue
          }
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
            continue
          }
          const attempts = entry.attempts + 1
          if (attempts >= MAX_RELEASE_ATTEMPTS) {
            pendingStore.remove(entry.id)
            console.error('[dsh-always-queue] giving up on a held message', {
              sessionId: entry.sessionId,
              error: result.error,
            })
            break
          }
          pendingStore.requeueFront({ ...entry, attempts })
          retryTimer = setTimeout(checkRelease, RELEASE_RETRY_MS)
          break
        }
        if (releasedSession !== undefined) {
          // Claim the released session: it counts as busy until its running
          // flag lands (or the claim safety valve elapses — the sweep timer
          // then re-checks even if no further list update ever arrives).
          claims.set(releasedSession, { at: Date.now() })
          syncClaimSweep()
        }
      } finally {
        releasing = false
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
    const off = sessions.list.subscribe(() => checkRelease())
    checkRelease()
    return () => {
      off()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      if (claimSweepTimer !== undefined) clearTimeout(claimSweepTimer)
    }
  }, 'dsh-always-queue: release loop')

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
      }
    },
  }, AlwaysQueueDock))
}
