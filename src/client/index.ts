/**
 * dsh-always-queue — browser half.
 *
 * The single-in-progress gate, entirely client-side:
 *
 * 1. registers the alwaysQueue dictionaries;
 * 2. intercepts every resolution of the conversation service (the cordis
 *    internal/get waterfall) and wraps its send / sendSession verbs: a send
 *    addressed to a session that is NOT itself running is HELD while any
 *    other session is running (or a release was just made for another
 *    session). Held messages land in the pending store; nothing is ever
 *    re-sent eagerly — there is deliberately no send-immediately path for them.
 *    Sends to the running session pass through untouched, so the default
 *    in-session queueing and steer behavior is preserved exactly;
 * 3. runs the release loop: when no session reports running (and no fresh
 *    release claim is pending), the oldest waiting session's whole batch is
 *    released through session.prompt in FIFO order. The next session's
 *    entries stay held until that session completes or pauses;
 * 4. registers an ADDITIONAL conversation.input.dock entry (id always-queue,
 *    order 30 — the official queue strip at order 20 keeps rendering the
 *    per-session inbox untouched) so held messages are visible per session.
 *
 * All @deepseek-ai/* imports are type-only: collaboration happens through
 * cordis services, events, and slot registration only (client bundle purity).
 */
import type {
  ClientContext, PromptContentPart, RpcResult, SessionId,
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
 * Bridge window: after a release, the target session's running flag takes a
 * short while to land in the list snapshot. Until it does (or the claim
 * times out / the session vanishes), the gate treats the released session as
 * busy so a second session cannot start in the gap.
 */
const RELEASE_GUARD_MS = 5000

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

  // The gate state.
  let guard: { sessionId: string; at: number } | undefined
  let releasing = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const inFlight = new Set<string>()

  const conversation = ctx.get('conversation') as IConversation | undefined
  const hubInput: InputHubLike | undefined = conversation?.input as InputHubLike | undefined

  /** Session ids currently reporting an open turn (all rows, any kind). */
  const runningIds = (): string[] =>
    Object.values(sessions.list.getSnapshot().byId)
      .filter(summary => summary.running)
      .map(summary => summary.id)

  /** Whether a fresh release claim makes another session count as busy. */
  const guardBusyFor = (targetId: string): boolean => {
    if (guard === undefined || guard.sessionId === targetId) return false
    return Date.now() - guard.at < RELEASE_GUARD_MS
  }

  /** Best-effort composer notice that a message was held (no scope, silent). */
  const notifyHeld = (sessionId: string): void => {
    try {
      const actx = sessions.scope(sessionId)
      if (actx === undefined) return
      hubInput?.for(actx).notify('info', t('queued'))
    } catch {
      /* best-effort only */
    }
  }

  /** Invoke the original verb with the traceable proxy as the this-context. */
  const callOriginal = (target: object, prop: 'send' | 'sendSession', args: readonly unknown[]): unknown => {
    const method = Reflect.get(target, prop, target)
    return Reflect.apply(method, target, args as never[])
  }

  /** One intercepted send: hold when the gate is closed, else pass through. */
  const gate = async (
    prop: 'send' | 'sendSession',
    target: object,
    args: readonly unknown[],
  ): Promise<unknown> => {
    // Resolve the addressed session.
    let targetId: string | undefined
    if (prop === 'sendSession') {
      const session = args[0] as { sessionId?: SessionId } | undefined
      targetId = session?.sessionId
    } else {
      // Plain send addresses the CALLER scope: the traceable proxy exposes
      // the reading context on its ctx property.
      const callerCtx = Reflect.get(target, 'ctx', target)
      if (callerCtx !== undefined) targetId = sessions.scopeOf(callerCtx)
    }
    if (targetId === undefined) return callOriginal(target, prop, args)

    const list = sessions.list.getSnapshot()
    if (list.phase !== 'ready') return callOriginal(target, prop, args)

    const targetRunning = list.byId[targetId]?.running === true
    const verdict = decideGate({
      targetRunning,
      otherBusy: runningIds().some(id => id !== targetId) || guardBusyFor(targetId),
    })
    if (verdict !== 'hold') return callOriginal(target, prop, args)

    // ----- hold: capture the full content, store it, report success locally.
    let content: readonly PromptContentPart[]
    if (prop === 'sendSession') {
      const text = typeof args[1] === 'string' ? args[1] : ''
      const imageIds = Array.isArray(args[2]) ? (args[2] as readonly string[]) : []
      if (imageIds.length > 0) {
        let images: readonly SubmitImageAttachment[]
        try {
          const serializer = Reflect.get(target, 'serializeDraftImages', target)
          images = await Reflect.apply(
            serializer as (ids: readonly string[]) => Promise<readonly SubmitImageAttachment[]>,
            target,
            [imageIds],
          )
        } catch {
          // Drafts no longer resolvable: behave exactly as without the plugin
          // (the original path surfaces its own failure).
          return callOriginal(target, prop, args)
        }
        // Captured: release the draft attachments so previews do not leak
        // (the committed draft no longer references them).
        for (const id of imageIds) {
          const releaser = Reflect.get(target, 'releaseDraftImage', target)
          Reflect.apply(releaser as (id: string) => void, target, [id])
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
      if (content.length === 0) return callOriginal(target, prop, args)
    } else {
      const text = args[0]
      if (typeof text !== 'string' || text === '') return callOriginal(target, prop, args)
      content = [{ type: 'text' as const, text }]
    }

    pendingStore.add({ sessionId: targetId, content })
    notifyHeld(targetId)
    checkRelease() // close the race: the busy session may have just finished
    return prop === 'sendSession' ? { kind: 'success' } : undefined
  }

  /**
   * The release loop: retire the guard, then — only when nothing reports
   * running and no fresh claim is pending — release the oldest waiting
   * session's whole batch in FIFO order (skipping in-flight entries).
   */
  const checkRelease = (): void => {
    if (releasing) return
    const list = sessions.list.getSnapshot()
    if (guard !== undefined) {
      const summary = list.byId[guard.sessionId]
      if (summary === undefined || summary.running === true || Date.now() - guard.at > RELEASE_GUARD_MS) {
        guard = undefined
      }
    }
    if (list.phase !== 'ready') return
    const entries = pendingStore.entries().filter(entry => !inFlight.has(entry.id))
    if (entries.length === 0) return
    if (guard !== undefined || runningIds().length > 0) return
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
          guard = { sessionId: releasedSession, at: Date.now() }
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

  // Intercept every conversation-service resolution and wrap its send verbs.
  ctx.on(
    'internal/get',
    (_readCtx: object, name: string, _error: unknown, next: () => unknown) => {
      if (name !== 'conversation') return next()
      const value = next()
      if (value === null || value === undefined) return value
      return new Proxy(value, {
        get(target, prop, receiver) {
          if (prop === 'send' || prop === 'sendSession') {
            const method = Reflect.get(target, prop, receiver)
            if (typeof method !== 'function') return method
            const verb = prop
            return (...args: readonly unknown[]) => gate(verb, target, args)
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    },
    'dsh-always-queue: conversation gate',
  )

  // The pending strip: an ADDITIONAL input-dock entry (never shadows the
  // official queue strip, so the per-session inbox UI stays untouched).
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'always-queue',
    order: 30,
    locale: NS,
    inject: (sessionId: SessionId): AlwaysQueueDockInjected => {
      const actx = sessions.scope(sessionId)
      if (actx === undefined) throw new Error(`always-queue dock: session "${sessionId}" resolved no scope`)
      const face = actx.get<IConversation>('conversation')
      if (face === undefined) throw new Error('always-queue dock: conversation service unavailable')
      return {
        setDraft: (text) => { face.input.for(actx).actions.setDraft(text) },
      }
    },
  }, AlwaysQueueDock))
}
