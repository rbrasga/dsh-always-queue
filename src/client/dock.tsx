/**
 * Cross-session pending-queue strip.
 *
 * An ADDITIONAL conversation.input.dock entry (id "always-queue", order 30 —
 * below the official queue strip at order 20, which keeps rendering the
 * per-session inbox untouched). It shows the messages the gate held for the
 * viewed session: a "waiting" banner plus one row per held message.
 *
 * Deliberately NO steer (send-immediately) control exists on these rows: a held
 * message starts only when the running session completes or pauses (that is
 * the whole point of the plugin). The only exits are remove and
 * pull-back-to-composer (text entries with a free draft).
 */
import { useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the conversation contract declarations (module augmentation).
// No value import crosses the plugin boundary.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconRightUpOutline16, IconTrashOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { hasImages, previewOf } from './gate.ts'
import { pendingStore, type PendingEntry } from './pending-store.ts'
import css from './dock.module.css'

/** Operations injected by the session-scoped registration. */
export interface AlwaysQueueDockInjected {
  /** Back-fill the composer draft (the pull-back-to-composer path). */
  setDraft: (text: string) => void
}

/** Full props of the dock entry: InputZone owner + session kit + locale seat. */
export type AlwaysQueueDockProps =
  PropsRuntime<'conversation.input.dock'> & AlwaysQueueDockInjected & PropsLocale<'alwaysQueue'>

/**
 * The pending strip; renders nothing while the viewed session holds nothing
 * (the gate, the release loop, and this view all share the pending store).
 */
export function AlwaysQueueDock({ sessionId, input, setDraft, t }: AlwaysQueueDockProps) {
  const sid = sessionId ?? ''
  const entries = useSyncExternalStore(
    pendingStore.subscribe,
    () => pendingStore.getSnapshotFor(sid),
  )
  if (entries.length === 0) return null

  const composerEmpty = input.draft.trim() === ''

  /** Pull one held text entry back into the composer draft for editing. */
  const pullBack = (entry: PendingEntry): void => {
    const text = previewOf(entry)
    if (text === '') return
    setDraft(text)
    pendingStore.remove(entry.id)
  }

  return (
    <div className={css.dock} data-always-queue-dock="">
      <div className={css.panel}>
        <div className={css.banner} role="status">
          <span className={css.bannerDot} aria-hidden />
          {t('waiting', { n: entries.length })}
        </div>
        <ul className={css.list}>
          {entries.map((entry) => {
            const images = hasImages(entry)
            const text = previewOf(entry)
            const pullBackDisabled = images || !composerEmpty
            const pullBackLabel = images
              ? t('pullBack.images')
              : !composerEmpty ? t('pullBack.busy') : t('pullBack')
            return (
              <li key={entry.id} className={css.row} data-pending-row="">
                <span className={css.preview} title={text === '' ? undefined : text}>
                  {text === '' ? t('noText') : text}
                </span>
                {images && <span className={css.imageMark}>{t('hasImage')}</span>}
                <div className={css.actions}>
                  <Tooltip label={pullBackLabel} side="bottom" delayMs={500}>
                    <button
                      type="button"
                      className={css.action}
                      aria-label={t('pullBack')}
                      title={pullBackLabel}
                      disabled={pullBackDisabled}
                      onClick={() => {
                        console.debug('[dsh-always-queue] dock: user pulled back entry', entry.id, 'for session', sid)
                        pullBack(entry)
                      }}
                    >
                      <IconRightUpOutline16 />
                    </button>
                  </Tooltip>
                  <Tooltip label={t('remove')} side="bottom" delayMs={500}>
                    <button
                      type="button"
                      className={css.action}
                      aria-label={t('remove')}
                      title={t('remove')}
                      onClick={() => {
                        console.debug('[dsh-always-queue] dock: user removed entry', entry.id, 'for session', sid)
                        pendingStore.remove(entry.id)
                      }}
                    >
                      <IconTrashOutline16 size={14} />
                    </button>
                  </Tooltip>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
