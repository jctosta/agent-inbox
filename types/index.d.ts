// State contract of the agent-inbox mod: what it keeps in $.state.
// Structurally the same as core/inbox.ts's Inbox, which the hooks module uses.

export type InboxItemState = {
  id: string
  n: number
  title: string
  detail?: string
  kind: 'action' | 'decision' | 'review' | 'secret' | 'info'
  blocking: boolean
  source: string
  createdAt: string
  status: 'open' | 'done' | 'dropped'
  closedAt?: string
  closedBy?: string
  note?: string
}

export type InboxState = {
  version: 1
  project: string
  nextN: number
  items: InboxItemState[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-inbox': {
      /** The project's inbox as last read from or written to its file. */
      inbox: InboxState | null
      /** Whether the band above the prompt is collapsed to its one-line form. */
      isCompact: boolean
      /** One line of feedback shown in the pane after an action. */
      message: string
    }
  }
}
