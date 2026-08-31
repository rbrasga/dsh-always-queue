/** alwaysQueue client dictionaries (zh / en). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'alwaysQueue'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  /** Banner above the held rows; {n} is the held count of the viewed session. */
  'waiting': '{n} 条消息排队中，其他会话结束后自动发送',
  /** Shown for an image-only entry (no text to preview). */
  'noText': '（图片消息）',
  /** Badge marking an entry that carries images. */
  'hasImage': '含图',
  /** Pull the held text back into the composer draft. */
  'pullBack': '取回输入框编辑',
  /** Pull-back disabled: the entry has images the draft cannot carry. */
  'pullBack.images': '含图消息无法取回编辑',
  /** Pull-back disabled: the composer draft is occupied. */
  'pullBack.busy': '输入框已有内容，先发送或清空后再取回',
  /** Remove the entry from the cross-session queue. */
  'remove': '移出队列',
  /** Composer notice when a message was held by the gate. */
  'queued': '已排队：其他会话结束或暂停后自动发送',
  /** Composer notice: a held message's release keeps failing ({n} attempts, {code} host error code). */
  'releaseFailed': '发送失败（第 {n} 次，{code}）：消息保留在队列中，将继续自动重试',
  /** Composer notice: a held message could not be delivered (target session gone). */
  'releaseGone': '排队消息无法发送：目标会话已不存在，该条消息已移出队列',
} satisfies Record<string, string>

/** English dictionary (keys mirror zh). */
export const en: Record<keyof typeof zh, string> = {
  'waiting': '{n} message(s) queued — will send automatically once other sessions finish',
  'noText': '(image message)',
  'hasImage': 'image',
  'pullBack': 'Pull back to composer',
  'pullBack.images': 'Entries with images cannot be pulled back',
  'pullBack.busy': 'The composer has content — send or clear it first',
  'remove': 'Remove from queue',
  'queued': 'Queued: will send automatically once other sessions finish or pause',
  'releaseFailed': 'Send failed (attempt {n}, {code}): message kept in queue, retrying automatically',
  'releaseGone': 'Queued message could not be sent: the target session no longer exists — entry removed',
}
