/**
 * Pending-queue dock component tests: renders nothing with no held entries,
 * lists held rows for the viewed session, removes entries, and pulls text
 * entries back into the composer draft (never for images or a busy draft).
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { AlwaysQueueDock } from '../src/client/dock.tsx'
import type { AlwaysQueueDockProps } from '../src/client/dock.tsx'
import { pendingStore } from '../src/client/pending-store.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: ({ label, children }: { label: string; children: ReactNode }) => (
    <span data-tip={label}>{children}</span>
  ),
  IconRightUpOutline16: () => <span data-icon="pull" />,
  IconTrashOutline16: () => <span data-icon="remove" />,
}))

const DICT: Record<string, string> = {
  'waiting': 'WAITING({n})',
  'noText': '(image message)',
  'hasImage': 'image',
  'pullBack': 'pullBack',
  'pullBack.images': 'pullBackImages',
  'pullBack.busy': 'pullBackBusy',
  'remove': 'remove',
  'queued': 'held',
}

function propsFor(overrides: Partial<Record<string, unknown>> = {}, setDraft = vi.fn()): AlwaysQueueDockProps {
  return {
    sessionId: 'S1',
    useSession: () => ({}),
    session: { running: false, queue: [] },
    input: { draft: '', queue: [], phase: 'plain' },
    t: (key: string, params?: Record<string, unknown>) =>
      (DICT[key] ?? key).replace('{n}', String(params?.n ?? '')),
    setDraft,
    ...overrides,
  } as unknown as AlwaysQueueDockProps
}

beforeEach(() => {
  pendingStore.clear()
})

afterEach(() => {
  cleanup()
})

describe('AlwaysQueueDock', () => {
  it('renders nothing while the viewed session holds nothing', () => {
    pendingStore.add({ sessionId: 'OTHER', content: [{ type: 'text', text: 'elsewhere' }] })
    const { container } = render(<AlwaysQueueDock {...propsFor()} />)
    expect(container.querySelector('[data-always-queue-dock]')).toBeNull()
  })

  it('renders a waiting banner plus one row per held message of the viewed session', () => {
    pendingStore.add({ sessionId: 'S1', content: [{ type: 'text', text: 'first' }] })
    pendingStore.add({ sessionId: 'S2', content: [{ type: 'text', text: 'not mine' }] })
    pendingStore.add({ sessionId: 'S1', content: [{ type: 'text', text: 'second' }] })
    render(<AlwaysQueueDock {...propsFor()} />)
    expect(screen.getByText('WAITING(2)')).toBeTruthy()
    expect(screen.getByText('first')).toBeTruthy()
    expect(screen.getByText('second')).toBeTruthy()
    expect(screen.queryByText('not mine')).toBeNull()
  })

  it('shows a placeholder for image-only entries and an image badge', () => {
    pendingStore.add({
      sessionId: 'S1',
      content: [{ type: 'image', mediaType: 'image/png', data: 'aGk=' }],
    })
    render(<AlwaysQueueDock {...propsFor()} />)
    expect(screen.getByText('(image message)')).toBeTruthy()
    expect(screen.getByText('image')).toBeTruthy()
  })

  it('remove deletes the entry from the queue', () => {
    const a = pendingStore.add({ sessionId: 'S1', content: [{ type: 'text', text: 'to remove' }] })
    render(<AlwaysQueueDock {...propsFor()} />)
    fireEvent.click(screen.getByLabelText('remove'))
    expect(pendingStore.entries().map(e => e.id)).not.toContain(a.id)
    expect(pendingStore.entries()).toHaveLength(0)
  })

  it('pull-back fills the composer draft and removes the entry (empty draft, text entry)', () => {
    const setDraft = vi.fn()
    pendingStore.add({ sessionId: 'S1', content: [{ type: 'text', text: 'edit me' }] })
    render(<AlwaysQueueDock {...propsFor({}, setDraft)} />)
    fireEvent.click(screen.getByLabelText('pullBack'))
    expect(setDraft).toHaveBeenCalledWith('edit me')
    expect(pendingStore.entries()).toHaveLength(0)
  })

  it('pull-back is disabled while the composer draft is occupied', () => {
    const setDraft = vi.fn()
    pendingStore.add({ sessionId: 'S1', content: [{ type: 'text', text: 'stays' }] })
    render(<AlwaysQueueDock {...propsFor({ input: { draft: 'occupied', queue: [], phase: 'plain' } }, setDraft)} />)
    const button = screen.getByLabelText('pullBack') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('pullBackBusy')
    fireEvent.click(button)
    expect(setDraft).not.toHaveBeenCalled()
    expect(pendingStore.entries()).toHaveLength(1)
  })

  it('pull-back is disabled for entries with images', () => {
    const setDraft = vi.fn()
    pendingStore.add({
      sessionId: 'S1',
      content: [{ type: 'image', mediaType: 'image/png', data: 'aGk=' }, { type: 'text', text: 'with img' }],
    })
    render(<AlwaysQueueDock {...propsFor({}, setDraft)} />)
    const button = screen.getByLabelText('pullBack') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('pullBackImages')
  })

  it('exposes no send-now / steer control on held rows', () => {
    pendingStore.add({ sessionId: 'S1', content: [{ type: 'text', text: 'waiting' }] })
    const { container } = render(<AlwaysQueueDock {...propsFor()} />)
    const labels = [...container.querySelectorAll('button')].map(b => b.getAttribute('aria-label'))
    expect(labels.every(label => label === 'pullBack' || label === 'remove')).toBe(true)
  })
})
