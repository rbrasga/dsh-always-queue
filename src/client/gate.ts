/**
 * Pure gate decisions for the single-in-progress rule.
 *
 * The rule: a message sent to a session that is NOT itself running is held
 * while ANY other session is running (or a release was just made for another
 * session, bridging the window until its running flag lands). A message sent
 * to the running session passes through untouched — the default in-session
 * queueing and steer behavior is preserved exactly.
 */
import type { PendingEntry } from './pending-store.ts'

/** The two gate verdicts. */
export type GateVerdict = 'pass' | 'hold'

/** The facts the gate decides on (derived from the session list snapshot). */
export interface GateFacts {
  /** Whether the target session itself has an open turn right now. */
  targetRunning: boolean
  /** Whether any OTHER session has an open turn (or a fresh release claim). */
  otherBusy: boolean
}

/**
 * Decide one intercepted send. Pure so the wiring and its tests share one
 * truth.
 * @param facts - the derived running facts.
 * @returns 'hold' only for an idle target while another session is busy.
 */
export function decideGate(facts: GateFacts): GateVerdict {
  if (facts.targetRunning) return 'pass'
  return facts.otherBusy ? 'hold' : 'pass'
}

/**
 * Select the release batch: every entry of the oldest waiting session, in
 * FIFO order. Releasing one session's whole batch (instead of only its head)
 * lets follow-up messages join that session's own default queue once it
 * starts; every other session's entries stay held until this one completes.
 * @param entries - the full FIFO pending queue.
 * @returns the head session's entries (empty queue yields an empty batch).
 */
export function releaseBatch(entries: readonly PendingEntry[]): readonly PendingEntry[] {
  if (entries.length === 0) return []
  const firstSessionId = entries[0]?.sessionId
  if (firstSessionId === undefined) return []
  return entries.filter(entry => entry.sessionId === firstSessionId)
}

/** Preview text of one held entry (first text part, '' when images only). */
export function previewOf(entry: Pick<PendingEntry, 'content'>): string {
  for (const part of entry.content) {
    if (part.type === 'text') return part.text
  }
  return ''
}

/** Whether one held entry carries image parts. */
export function hasImages(entry: Pick<PendingEntry, 'content'>): boolean {
  return entry.content.some(part => part.type === 'image')
}
