# Active Sessions: Attention, filters, and freshness

Status: proposed for review

## Goal

Help a signed-in requester see which Software Factory sessions need a decision across GitHub and Azure DevOps, without switching repository tabs. Keep the compact, light-only workbench and the 1080 x 720 laptop target. Open issues remains the default repository view. The header's existing **Active sessions** link remains the entry point.

## Approaches

- **Selected: extend Active sessions.** An attention strip, filters, and explicit freshness make the existing session list more useful without a new navigation item, duplicated data, or a new persistent store.
- **Deferred: a dedicated Overview.** A single page could combine session attention, repository freshness, and recent outcomes, but would duplicate Active sessions and Statistics before either view warrants a separate dashboard.

## View and actions

```text
Active Copilot sessions                         Read 8s ago  [Refresh]
Needs your answer  1   Reconnect required  1   Needs recovery  1
[All repos v] [All statuses v]                        4 of 4 sessions
Needs attention
  catalog-api  #43 Retry imports       Waiting for your answer  [View task]
  import-svc   #121 Preserve order     Reconnect required       [View task]
  import-svc   #122 Validate manifest  Needs recovery           [View task]
Other sessions
  catalog-api  #44 Trim metadata       Running                  [View task]
```

The strip shows counts for the selected repository scope before applying the status filter. Selecting a count sets that filter, and **All statuses** clears it. Group by attention first, then other sessions; use a stable order within a group so a refresh does not unexpectedly move the keyboard target. Preserve **View issue**, the inline **View task** accordion, and confirmed **Archive task**. If a session needs reconnect or recovery, name the known blocker in the row and point to the relevant existing control when possible. Keep credential changes and recovery actions in the existing authorized flows; the strip itself only filters.

Use query parameters for the repository and status filters. Resolve a repository parameter against the current account's authorized connections and use a safe default for invalid values. Never put tokens or prompt content in a URL. Changing a filter replaces that URL entry; visiting or leaving Active sessions is normal navigation. Opening a shared link authorizes the reader's own data, not the sender's.

## State and data

Stay within the [existing portal design](2026-11-26-storage-and-container-design.md#repository-portal): the header count and session view share one requester-scoped response across authorized repo connections. Include known factory-created sessions attached to nonterminal tasks; exclude sessions known to be terminal, unlinked sessions, and tasks that have no SDK session ID. Work blocked before a session starts remains visible in the repository's Active tasks pane.

| Stored task state | Display |
| --- | --- |
| `waiting_input` | Needs your answer |
| `needs_auth` | Reconnect required |
| `needs_recovery` | Needs recovery; never report as running |
| `queued`, `starting`, `running`, `publishing`, `stopping` | Other sessions, with the specific state shown |
| `completed`, `stopped`, `failed` | Not in Active sessions |

Handle any unrecognized or unverified state explicitly; do not count it as running or announce that nothing needs attention on incomplete data. SQLite remains the source for task ownership, mappings, and last-known state. The list reads the existing task records; opening an accordion can load current runtime details independently. Do not invent question age from a generic `updated_at` field.

## Keep the deployment lean

- Serve static Svelte assets and the same-origin API from the existing single Docker container. The frontend keeps only transient view state and URL filters. SQLite and Azure DevOps worktrees remain on host-local mounts; the installation is not stateless.
- Use one shared request owner for the count and list, one request in flight per identity scope, and a modest interval while the sessions view is visible. Catch up when the tab regains focus. A refresh reads the API's task summary; it does not call GitHub or Azure DevOps directly, trigger provider **Sync**, or start any work.
- On a transient refresh failure, retain last-good rows for the same authorized identity and mark them stale with the time of the last successful read. That timestamp is not proof of upstream session liveness. An initial error shows **Retry**, not an empty queue. Discard late results on account change and clear affected rows on access denial.
- No new daemon, scheduler, message broker, telemetry store, or event log. No team-wide visibility, worker-fleet dashboard, cost estimation, or imported Uzi code.

## Acceptance checks

At 1080 x 720 the strip, filters, and first task row fit without horizontal overflow. One row appears per eligible factory session; status filters change the list, not the header's all-repo count. An authorization failure clears affected data, and a transient error cannot be mistaken for zero sessions or no pending decisions. The design must work without starting a live agent or modifying provider data to demonstrate it.

## Research references

- Uzi [overview composition and calm-state guard](https://github.com/vtmocanu/uzi/blob/6783c9f783c3fe8fe5147923a33627cc10ada65b/web/src/pages/OverviewNext.tsx#L91-L109), [status buckets](https://github.com/vtmocanu/uzi/blob/6783c9f783c3fe8fe5147923a33627cc10ada65b/web/src/lib/overview.ts#L16-L53), and [run-list filters](https://github.com/vtmocanu/uzi/blob/6783c9f783c3fe8fe5147923a33627cc10ada65b/web/src/pages/RunsList.tsx#L835-L880).
- Uzi [visibility-aware polling](https://github.com/vtmocanu/uzi/blob/6783c9f783c3fe8fe5147923a33627cc10ada65b/web/src/lib/usePollWhileVisible.ts#L1-L49) and [last-good refresh behavior](https://github.com/vtmocanu/uzi/blob/6783c9f783c3fe8fe5147923a33627cc10ada65b/web/src/lib/useOverviewData.ts#L162-L226). Our freshness label and restriction against triggering provider Sync are Software Factory proposals.
