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
 * 3. runs the release loop: when nothing is busy, the oldest waiting
 *    session's whole batch is released through session.prompt in FIFO order.
 *    A CLAIM marks a session busy from the moment its turn starts
 *    (pass-through or release) until its running flag lands in the list
 *    snapshot (or a safety timeout), so host-flag latency can never open a
 *    second session in the gap;
 * 4. registers an ADDITIONAL conversation.input.dock entry (id always-queue,
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

/** The input-hub face the gate reaches for composer notices. */
interface InputHubLike {
  for(actx: unknown): {
    notify(level: 'info' | 'error', text: string): void
  }
}

/** A verb pair on the conversation service instance. */
type GateVerbs = 'send' | 'sendSession'

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
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const inFlight = new Set<string>()

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
      if (!targetRunning) claims.set(targetId, { at: Date.now() })
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
    if (releasing) return
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
          // flag lands (or the claim safety valve elapses).
          claims.set(releasedSession, { at: Date.now() })
        }
      } finally {
        releasing = false
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
