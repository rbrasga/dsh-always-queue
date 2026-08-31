/**
 * Local contract declarations for the @deepseek-ai/* platform surfaces the
 * plugin consumes. The npm publication chain for the harness client packages
 * is incomplete (rc placeholders miss several transitive packages), and the
 * plugin never value-imports them anyway — the browser half talks to cordis
 * services and slot registration only, and the loader module table supplies
 * the real modules at runtime.
 *
 * These declarations mirror the harness sources (verified against
 * deepseek-harness v0.1.1-rc.2); drift against a future harness release shows
 * up as a slot-registration or type error at build time.
 */
/* eslint-disable @typescript-eslint/no-unused-vars -- ambient exports consumed cross-file */

declare module '@deepseek-ai/cordis' {
  /** Minimal host-side context face (the node half only receives it). */
  export interface Context {
    [key: string]: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  /** Tooltip wrapper (subset of the harness props used by this plugin). */
  export interface TooltipProps {
    label: ReactNode
    side?: 'top' | 'bottom' | 'left' | 'right'
    delayMs?: number
    disabled?: boolean
    children: ReactNode
  }

  export function Tooltip(props: TooltipProps): ReactNode

  export function IconRightUpOutline16(props?: { size?: number; className?: string }): ReactNode

  export function IconTrashOutline16(props?: { size?: number; className?: string }): ReactNode
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  /** Branded session identity (mirrors the connection package's SessionId). */
  export type SessionId = string & { readonly __sessionId?: unique symbol }

  /** Prompt content part as accepted by the session prompt verb (wire shape). */
  export type PromptContentPart =
    | { type: 'text'; text: string }
    | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }

  /** RpcResult-style acceptance: business error branch is discriminated on ok. */
  export type RpcResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: { code: string; message: string } }

  /** One row of the session list (host summary mirror). */
  export interface SessionSummary {
    id: SessionId
    displayTitle: string
    title?: string
    cwd?: string
    agentPreset?: string
    parentId?: SessionId
    origin?: 'subagent'
    /** True while the session has an open agent turn. */
    running: boolean
    blank: boolean
    updatedAt: number
  }

  /** Session-list snapshot (the sessions.list store shape). */
  export interface SessionListState {
    ids: SessionId[]
    byId: Record<SessionId, SessionSummary>
    current: SessionId | undefined
    phase: 'pending' | 'ready'
    subagentsByParent: Readonly<Record<SessionId, unknown>>
    jobsBySession: Readonly<Record<SessionId, readonly unknown[]>>
    currentAddress: unknown
  }

  /** One row of the authoritative transient inbox projection. */
  export interface QueueRow {
    id: string
    messageId: string
    placement: 'queued' | 'steering' | 'context'
    preview: string
    text: string | null
    content: readonly unknown[]
  }

  /** The conversation snapshot consumed by the session standard kit. */
  export interface ConversationSnapshot {
    running: boolean
    subagent: { address: { mode: string }; parentAvailable: boolean } | null
    queue: readonly QueueRow[]
  }

  /** Session-store selector hook shape delivered to session-scope slots. */
  export type SnapshotSelectorHook<S> = <T>(selector: (snapshot: S) => T) => T

  /** Bare observable snapshot source (getSnapshot/subscribe). */
  export interface ObservableSnapshot<T> {
    getSnapshot(): T
    subscribe(fn: () => void): () => void
  }

  /** The outward session face (subset the plugin uses). */
  export interface SessionFace extends ObservableSnapshot<ConversationSnapshot> {
    readonly sessionId: SessionId
    prompt(
      content: readonly PromptContentPart[],
      mode: 'queue' | 'steer',
      signal?: AbortSignal,
    ): Promise<RpcResult<{ accepted: true }>>
    /**
     * Rename this session (explicit user title; pins it against automatic
     * regeneration).
     * @param title - raw title text; the host normalizes acceptance.
     * @returns the normalized accepted title and its event seq, or the business error.
     */
    rename(title: string): Promise<RpcResult<{ title: string; seq: number }>>
  }

  /** Session assembly handle (stable binding cache value). */
  export interface SessionBinding {
    readonly sessionId: SessionId
    readonly session: SessionFace
    readonly ctx: unknown
  }

  /** A session-scoped context: the scoped face that resolves session services. */
  export interface AgentContext {
    get<T>(key: string): T | undefined
  }

  /** Session registry: scope/binding resolution and the list snapshot. */
  export interface ISessions {
    readonly list: ObservableSnapshot<SessionListState>
    scope(sessionId: SessionId): AgentContext | undefined
    scopeOf(ctx: unknown): SessionId | undefined
    binding(id: SessionId): SessionBinding | undefined
  }

  /** The client root context merge the plugin's browser half receives. */
  export interface ClientContext {
    effect(cleanup: () => (() => void) | void, label?: string): void
    on(event: string, listener: (...args: never[]) => unknown, options?: unknown): () => void
    get<T>(key: string): T | undefined
    slots: import('@deepseek-ai/dsh-client-ui-slots').SlotsFace
    sessions: ISessions | undefined
    locale: import('@deepseek-ai/dsh-client-locale/client').LocaleFace
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  import type {
    ConversationSnapshot, SessionId, SessionSummary, SessionListState, SnapshotSelectorHook,
  } from '@deepseek-ai/dsh-client-runtime/client'

  /** Owner share of the input-region slots (session + input snapshots). */
  export interface InputZone {
    session: ConversationSnapshot
    input: { queue: readonly { id: string; preview: string; text: string | null }[]; phase: string; draft: string }
  }

  /** Slot map entries consumed by this plugin (subset of the harness table). */
  export interface SlotMap {
    'conversation.input.dock': { kind: 'list'; scope: 'session'; owner: InputZone }
  }

  /** Locale namespaces merged by client plugins. */
  export interface LocaleNamespaceMap {
    alwaysQueue: string
  }

  /** Session-standard kit delivered to session-scope slot components. */
  export interface SessionStandardProps {
    useSession: SnapshotSelectorHook<ConversationSnapshot>
    sessionId: SessionId
  }

  /** Runtime props share for a slot key (owner + session kit + global seat). */
  export type PropsRuntime<K extends keyof SlotMap & string> =
    (SlotMap[K] extends { owner: infer O extends object } ? O : object)
    & SessionStandardProps
    & Record<string, unknown>

  /** Translate thunk bound to one dictionary namespace. */
  export type TranslateNS<_N extends keyof LocaleNamespaceMap & string> =
    (key: string, params?: Record<string, unknown>) => string

  /** Locale seat delivered to slot components. */
  export type PropsLocale<N extends keyof LocaleNamespaceMap & string> = { t: TranslateNS<N> }

  /** One registration's options (list-kind shape used by this plugin). */
  export interface SlotRegisterOptions<K extends keyof SlotMap & string> {
    name: K
    id?: string
    order?: number
    priority?: number
    locale?: string
    inject?: (...args: never[]) => unknown
  }

  /** The slot registry face available on the client context. */
  export interface SlotsFace {
    /** Wait for the slot declaration, register, and roll back with the caller fiber. */
    inject(name: keyof SlotMap & string, fn: () => unknown): () => void
    register<K extends keyof SlotMap & string>(options: SlotRegisterOptions<K>, component: unknown): () => void
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  /** Dictionary registration and bound-translate face. */
  export interface LocaleFace {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): void
    bind<N extends string>(namespace: N): (key: string, params?: Record<string, unknown>) => string
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  import type { PromptContentPart, SessionFace } from '@deepseek-ai/dsh-client-runtime/client'

  /** Image attachment wire payload (base64, host-verified). */
  export interface SubmitImageAttachment {
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    readonly data: string
    readonly name?: string
  }

  /** Settled composer submit outcome. */
  export interface SubmitOutcome {
    readonly kind: 'success' | 'error'
    readonly text?: string
  }

  /**
   * The outward conversation face (scope-addressed verbs). The subset the
   * plugin wraps or reaches through.
   */
  export interface IConversation {
    send(text: string): Promise<void>
    sendSession(
      session: SessionFace,
      text: string,
      imageIds: readonly string[],
      mode: 'queue' | 'steer',
      signal?: AbortSignal,
    ): Promise<SubmitOutcome>
    serializeDraftImages(imageIds: readonly string[]): Promise<readonly SubmitImageAttachment[]>
    releaseDraftImage(id: string): void
    updateQueue(itemId: string, action: unknown): Promise<void>
    cancel(): Promise<void>
    loadOlder(): Promise<void>
    input: {
      for(actx: unknown): {
        notify(level: 'info' | 'error', text: string): void
        actions: { setDraft(text: string): void }
      }
    }
    blocks: {
      set(sessionId: string, block: { reason: string } | undefined): void
    }
  }
}
