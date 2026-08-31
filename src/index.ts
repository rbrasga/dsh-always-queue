/**
 * dsh-always-queue — node half.
 *
 * The node half is the Loader entry every client plugin must ship; it carries
 * no host-side behavior. The browser half (src/client/index.ts) owns the whole
 * feature: the cross-session send gate (conversation-service interception) and
 * the pending-queue dock.
 */
import type { Context } from '@deepseek-ai/cordis'

/** @param ctx - host-side context; intentionally unused (client-plugin shape). */
export function apply(ctx: Context): void {
  void ctx
}
