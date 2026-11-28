# GitHub team runs

**Status:** Proposed for review. Extends the [backend system design](2026-11-26-backend-system-design.md), the [internal API](2026-11-26-internal-api-design.md), the [portal design](2026-11-26-storage-and-container-design.md) and [Active Sessions](2026-11-26-active-sessions-attention-design.md). Builds on the supervised cloud launch on `feat/live-copilot`. The decision is recorded in [ADR 0001](../../adr/0001-github-runs-coordinate-hosted-copilot.md), and the C4 views, swimlanes and lifecycle are in [the diagrams](../../architecture/github-team-runs/README.md).

## Intent

A requester points Software Factory at a GitHub repository they can access and hands it one open issue. A team of GitHub Copilot cloud agents works on that issue:

1. A planner proposes how to split the issue into pieces.
2. The requester approves the plan.
3. Implementers work on the pieces in parallel.
4. A reviewer from a different model family checks each pull request until it holds up.

The run ends with draft PRs that the team reviews and merges. Everything executes on GitHub-hosted Copilot compute, under the requester's own Copilot license and delegated GitHub identity. The factory only coordinates.

Today the factory starts one opaque Copilot session per issue, with no plan, no roles and no review, and live task execution exists only as a developer trial. Yet the factory exists so that agents can collaborate on issues. The loop that makes that collaboration work is a gated plan, a lead agent with specialist reviewers, a check by a second model and bounded follow-up after the PR opens. Owning the agent runtime would add workers, sandboxing, fleet operations and a long tail of recovery rules. This design keeps the loop and leaves execution to GitHub.

**The proof of concept is ready when** one real issue on an approved, disposable GitHub repository completes a run in each implementer mode, and in each run:

- a plan with at least two pieces is approved after one change request;
- the pieces become sub-issues, including their dependency;
- at least two implementers run in parallel;
- every PR gets at least one review round from another model family, and its findings are addressed;
- the resulting draft PRs pass the repository's checks and a human could merge them;
- the run shows its measured cost;
- restarting the factory mid-run neither duplicates nor loses work.

## Goals, non-goals and anti-goals

**Goals**

- One run per GitHub issue: plan, approval, sub-issues, parallel implementers, review rounds by another model family, and draft PRs ready for the team.
- Two implementer modes, chosen per run: **Factory sessions** (mode A) and **GitHub assignment** (mode B). Planning, approval, filing pieces and review behave the same way in both.
- A live run view in mode A and an accurate polled view in mode B, each showing the run's measured cost.
- Orchestration that survives restarts without duplicating sessions, issues, comments or PRs.

**Non-goals for the PoC**

- Azure DevOps execution, which is deferred (see [Deferred: Azure DevOps runner](#deferred-azure-devops-runner)).
- Starting runs from labels, schedules or webhooks.
- Automatic merges.
- Loops that fix CI outside the review round.
- Resolving merge conflicts.
- Plan review by a second model.
- Approval by more than one person, or visibility for a whole team.
- Runs that span repositories.
- Slack, chat or CLI surfaces.
- GitHub Enterprise Server.

**Anti-goals.** A run that does any of the following has failed, even if it produces code:

- Writing under any identity other than the requester's delegated GitHub grant, or falling back to a bot account or a personal access token (PAT).
- Writing to the default branch, merging anything, or changing branch protection.
- Acting on comments from anyone other than the requester, or treating issue or PR text as instructions to the factory.
- Duplicating a session, sub-issue, comment or PR after an ambiguous outcome.
- Reporting unmeasured usage as zero, or an uncertain session as running.
- Requiring files such as `.github/agents` profiles or workflow changes to be committed to the target repository before a run can start.
- Building a worker fleet, a sandbox or a second agent runtime for GitHub runs.

## Platform facts this design relies on

These were checked against GitHub's documentation on 2026-11-28, except where marked as a proof (see [Proofs before building the rest](#proofs-before-building-the-rest)).

| Capability | What GitHub provides | Consequence here |
| --- | --- | --- |
| SDK cloud sessions | `createSession({cloud:{repository:{owner,name,branch}}})` runs a session on GitHub-hosted compute. The call resolves once the remote worker reports `session.start`, and the session is published at `https://github.com/copilot/tasks/{sessionId}`. Sessions can be resumed with the standard `resumeSession` and stream events. When a policy or missing entitlement blocks creation, the call fails with a message. | The planner, the reviewer and mode A implementers are SDK cloud sessions. Setting `branch` starts a reviewer from a PR's branch, and resuming a session carries follow-ups. Our trial status reader already treats a cloud session's ID as its agent task ID. |
| Agent tasks REST API (preview) | Lists and gets tasks with their `state` (`queued`, `in_progress`, `completed`, `failed`, `idle`, `waiting_for_user`, `timed_out`, `cancelled`), their `artifacts` (a PR ID or branch refs), and `sessions[]` with model, timestamps, `usage` (`ai_credits` or `premium_requests`) and an error message. Only user-to-server tokens are accepted. **It returns no agent output.** `POST …/tasks` is limited to Copilot Business and Enterprise, and accepts `create_pull_request`, `base_ref` and `head_ref`. | In both modes, the tasks API is the source of truth for state, artifacts and usage. Plans and review verdicts can't come back through it, so the planner and the reviewer always run as SDK sessions. |
| Assigning issues to Copilot | The issues REST and GraphQL APIs assign `copilot-swe-agent` with an `agent_assignment` (`target_repo`, `base_branch`, `custom_instructions`, `custom_agent`, `model`). This requires a user token; GitHub App user-to-server tokens qualify. A fine-grained token needs read and write access to actions, contents, issues and pull requests. Whether Copilot can be assigned shows up in `suggestedActors(capabilities:[CAN_BE_ASSIGNED])`. | Mode B implementers use this. The GitHub App needs broader permissions for mode B than for mode A. |
| Sub-issues and dependencies | REST endpoints add, list and reorder sub-issues, and add, list and remove `blocked_by` dependencies. | The approved plan becomes visible structure on GitHub. |
| Cloud agent guarantees | The agent pushes only to its own branch: a new `copilot/` branch, or the PR's branch when a follow-up arrives on the PR. It is subject to branch protections and required checks. By default it runs a security check and gets a Copilot code review before it finishes. | The factory needs no sandbox for GitHub runs. Our review adds a second model family on top of GitHub's own review. |

Rules from the existing designs still apply:

- Provider writes use only the requester's delegated grant.
- Starting native GitHub work requires the repository grant and the Copilot grant to belong to the same verified user on the same host.
- Intent is reserved before any external effect, and an effect with an uncertain outcome is never retried blindly.
- Any capability that hasn't been proven returns `409 CAPABILITY_UNAVAILABLE`.
- Unknown usage is never shown as zero.

## Approaches

| Approach | Trade-offs | Outcome |
| --- | --- | --- |
| **A. Factory sessions.** Every role is an SDK cloud session that the factory creates, streams and resumes. | Live progress and usage per session, reusing the verified dispatch and supervised-launch path. But it means the most factory code, and the run only advances while the factory is running (the sessions themselves continue on GitHub). | Supported as an implementer mode. |
| **B. GitHub assignment.** The factory files sub-issues and assigns them to Copilot; follow-ups are `@copilot` comments on the PR. | GitHub links each issue, session and PR natively and shows them in its own UI, and the factory keeps the least state. There's no live stream, status and usage arrive by polling, and the App needs broader permissions. | Supported as an implementer mode. |
| **C. Hybrid.** The planner and reviewer run as SDK sessions; implementers are started by assignment. | Two launch paths to prove and to observe. | This is what mode B becomes, because the tasks API can't return plans or verdicts. |
| A single lead cloud session that splits the work internally. | One large PR, no sub-issues and no review by another model family. GitHub doesn't document whether cloud sessions can run sub-agents in parallel. | Rejected. |
| Owning the runtime on the factory host. | Full control and one runtime for every provider, but the factory takes on sandboxing, worker lifecycle and recovery. | Rejected for GitHub, which hosts execution itself. |

**The requester's decision:** support both A and B, and let the requester choose one per run.

**The designer's call that follows from it:** planning and review always use SDK cloud sessions. The mode choice therefore only decides how implementers are started, observed and followed up.

Earlier in the same conversation the requester also decided two things: GitHub repositories run only on GitHub-hosted sessions, and the Azure DevOps runner waits until this PoC is ready.

## The run

| Term | Meaning |
| --- | --- |
| Run | The factory's unit of work for one parent issue. It belongs to one requester and is bound to one connection generation and one Copilot account. |
| Plan revision | One validated proposal from the planner: a summary plus 1 to 6 pieces, each with dependencies and acceptance checks. |
| Piece | One approved unit of work. It is filed as a sub-issue of the parent issue and produces one draft PR. |
| Session | One Copilot cloud agent task with a role: `planner`, `implementer` or `reviewer`. Every planner and reviewer, and every mode A implementer, is an SDK session. Mode B implementers are tasks that GitHub creates when an issue is assigned to Copilot. |
| Review round | A reviewer session's verdict on one head revision of a PR, plus the follow-up that verdict triggers. |

```text
Start run ─> planning ─> awaiting approval ──approve──> filing pieces ─> working ─> ready for review ─> completed
                 ^              │ request changes (up to 3 revisions)           │
                 └──────────────┘ reject ─> rejected                            └─> waiting for merge (dependent pieces)
Any state ─> stopping ─> stopped · needs attention · needs auth · needs recovery · failed
```

### Planning and approval

The planner session receives:

- the factory's planner instructions;
- the parent issue's title and body, and the requester's own comments on it, marked off as untrusted data;
- the repository, given as the session's repository context.

The planner must not edit files, run commands, or create branches, commits, issues or PRs. It must end its turn with a short readable summary and a plan in a fenced JSON block.

The factory validates that block against a strict schema: 1 to 6 pieces, each with a title, a scope, acceptance checks and optional `dependsOn` piece IDs, with no cycles and bounded text sizes. If the block is invalid, the planner gets one automatic correction turn for that revision. If the second attempt is also invalid, the run moves to `needs_attention` and shows the planner's summary.

Only a validated revision reaches the requester. The requester approves it, requests changes with feedback, or rejects it, and every decision names the revision the requester saw. A decision naming any other revision returns `409 PLAN_REVISION_CHANGED`. Requesting changes resumes the same planner session with the feedback, which produces the next revision. After revision 3, the only choices left are approve and reject.

Plan text and feedback are protected application state: their size is bounded, they are kept as long as the run is, and they never go to logs.

### Filing pieces

After approval, the factory makes these writes in order, all authored by the requester:

1. One issue per piece, containing its title, scope and acceptance checks, a link to the parent issue, and a hidden factory marker carrying the piece ID.
2. The link that makes each new issue a sub-issue of the parent.
3. The `blocked_by` dependencies between pieces.
4. One comment on the parent issue that lists the approved plan and its sub-issues.

Each write is reserved before it is made and confirmed by the ID GitHub returns. If the outcome of creating an issue or comment is uncertain, the factory first looks for its marker among the parent's sub-issues or comments, and only retries if the marker isn't there.

### Implementers

A piece can start once it is filed and every piece it depends on has a merged PR. Each run has at most 3 implementers working at once, and pieces that are ready start in plan order.

- **Mode A (factory sessions).** The implementer is an SDK cloud session on the default branch. It receives the implementer instructions, the piece's scope and acceptance checks, and the approved plan summary. It is told to stay within the piece's scope and to open a draft PR whose description closes the piece's sub-issue. While the session runs, the factory keeps it open and turns its events into the live view, then resumes the same session for follow-ups.
- **Mode B (GitHub assignment).** The factory assigns the sub-issue to `copilot-swe-agent` with an `agent_assignment`: `base_branch` is the default branch, `custom_instructions` carries the same implementer instructions, and `model` is the chosen model. GitHub then opens the session and the PR. Follow-ups are comments on the PR, authored by the requester and starting with `@copilot`.

A piece's PR is linked only on evidence from the provider: the task's `pull` artifact, that PR closing the piece's sub-issue, and the expected repository and requester. In mode B, the factory finds the task by listing the repository's tasks that the requester created since the assignment. Until that evidence is complete, the piece shows "Assigned; waiting for GitHub". It never adopts a task or a PR based on its title, branch name or timing.

### Review rounds

When an implementer's turn ends with a linked PR, the factory starts a reviewer session from the PR's head branch. The reviewer uses a model from a different family than the implementer's, and receives the reviewer instructions, the piece's acceptance checks and the plan summary. It must not change code or create branches or PRs. It ends with a fenced JSON verdict, either `approve` or `changes_requested`, plus findings, each with a `severity`, a `path`, an optional `line`, a `summary` and a `suggestion`.

The verdict is tied to the head commit (SHA) it reviewed. If the head moves before the follow-up is sent, the factory discards the verdict and starts a new round on the new head.

The factory posts the findings as one PR comment authored by the requester. What happens next depends on the verdict and on the PR's checks:

| Verdict and checks | Next step |
| --- | --- |
| `approve`, and the checks on that head passed | The piece is **ready**. |
| `approve`, and checks are still pending | Wait for the checks, for a bounded time. The piece then becomes ready, or gets a follow-up naming the failing checks. |
| `changes_requested` or failing checks, with review rounds remaining (2 by default) | Send the implementer a follow-up with the findings and the names and links of the failing checks, then review the new head. In mode A the follow-up resumes the session; in mode B it is an `@copilot` comment. |
| No review rounds remaining | The piece is **ready with open findings**, and the run view lists what is unresolved. |

Findings are model output, not instructions from the requester, so follow-ups mark them off as data. The factory never acts on review comments written by anyone else. What the agent reads on GitHub by itself is governed by GitHub's own handling.

### Checks on Copilot's pushes (open decision)

By default, GitHub doesn't run Actions workflows on commits that Copilot pushes until someone with write access selects **Approve and run workflows**. A repository can turn this off with the **Require approval for workflow runs** policy. GitHub warns that this can let unreviewed agent code reach Actions secrets or gain write access.

Until the requester decides otherwise, this design assumes the default, in which the requester approves workflow runs on GitHub:

- The piece waits with the reason "Checks need your approval on GitHub" and a link to the PR. The review round can finish before CI does.
- The checks reader must tell apart four cases: checks awaiting approval, no checks at all, pending checks, and passed checks. That way, a piece is never ready just because CI never ran.
- With no checks, the piece becomes ready and shows "No checks".
- If checks are still pending when the bounded wait ends, the piece becomes ready and shows "Checks pending".

Two alternatives remain open:

- The repository turns the approval policy off. Runs become fully unattended, with GitHub's warning.
- The factory approves workflow runs as the requester. This needs Actions: write in mode A, and is a new effect with its own proof. It carries the same exposure, under the requester's name.

### Run and piece states

| Run state | Meaning |
| --- | --- |
| `planning` | The planner session is queued or working on a revision. |
| `awaiting_approval` | A validated revision is waiting for the requester. |
| `filing` | The plan is approved, and the sub-issues, dependencies and plan comment are being created. |
| `working` | At least one piece is being implemented or reviewed. |
| `waiting_for_merge` | No piece can progress until the requester merges a PR that another piece depends on. |
| `ready_for_review` | Every piece is ready (with or without open findings) or merged. |
| `completed` | Every piece's PR is merged or closed. |
| `needs_attention` | Blocked on the requester: planning needs a retry, or every remaining piece is blocked. |
| `needs_auth` | Blocked on the requester: a grant expired or was revoked. |
| `needs_recovery` | Blocked on the requester: the outcome of an effect on the whole run is uncertain. |
| `rejected`, `stopped`, `failed` | Terminal. |

Pieces move through `filed`, `blocked`, `implementing`, `in_review`, `revising`, `ready`, and finally `merged` or `closed`. `failed` and `needs_recovery` are the exceptions.

A failed implementer session doesn't fail the run. The piece shows the error GitHub reported and offers **Retry piece**, which acts only after the old session is terminal. A piece links at most one PR, and the factory never closes PRs:

| Situation | Mode A | Mode B |
| --- | --- | --- |
| No linked PR yet | Start a new implementer session. | Unassign Copilot, then assign it again, which creates a new task. |
| A PR is already linked | Resume the original session if it accepts input. Otherwise, once Proof 9 passes, start a new session from the PR's head branch. Until then the piece stays blocked and links the PR. | Post an `@copilot` comment on the linked PR. |

A branch that was left behind without a PR stays where it is, for the requester to delete.

**Stop run** stops scheduling new work, cancels queued work, and asks active sessions to stop where the platform supports that. Where a cloud session can't be stopped through an API, the run stays `stopping` and links each live session on GitHub until that session is terminal. Stopping a run never closes issues or PRs.

### Blockers and how a run gets unblocked

A blocker belongs either to one piece or to the whole run. A piece's blocker stops only that piece, and the other pieces keep going.

- **Piece blockers:** the implementer failed; Copilot is waiting for the requester (`waiting_for_user`); the reviewer failed; a piece effect is uncertain; a prerequisite PR was closed without merging.
- **Run blockers:** planning failed, or the plan was invalid twice; a grant expired or was revoked; an effect on the whole run (filing pieces) is uncertain.

The run moves to `needs_attention` only when planning needs a retry, or when every remaining piece is blocked on the requester.

The requester has these ways out, offered only where they apply:

| Action | What it does |
| --- | --- |
| **Retry planning** | Resumes the planner session if it accepts input. Otherwise it starts a new planner session with the last revision and the feedback. Revision numbering continues, and the 3-revision limit still applies. |
| **Retry review** | Starts a new reviewer session on the current head. |
| **Retry piece** | Restarts the implementer, as described in the previous table. |
| **Recheck** | Reruns reconciliation for the effect that `needs_recovery` names. The run continues only when the evidence settles the outcome. |
| **Stop run** | Available at any time. |

When Copilot waits for the requester, the piece links the session on GitHub. The factory never answers on the requester's behalf. When a prerequisite PR is closed without merging, the pieces that depend on it stay blocked with that reason until **Retry piece** runs on the prerequisite.

A run becomes `failed` only when it can't continue under its own binding: the parent issue or the repository is gone, or only a different account could act for it. If a request for changes can't resume the planner session after a long wait, the factory starts a new planner session with the last revision and the feedback. That attempt counts toward the revision limit.

## Trust, identity and permissions

| Need | Mode A | Mode B |
| --- | --- | --- |
| Create planner, reviewer and mode A implementer sessions | Copilot grant, for the same GitHub user and host as the repository grant | Same |
| Create sub-issues, dependencies, and the plan and findings comments | Issues: write; Pull requests: write | Same |
| Read session state, artifacts and usage | Agent tasks: read | Same |
| Read CI results for PR heads | Checks and commit statuses: read (already granted) | Same |
| Assign issues to Copilot | Not needed | Actions, Contents, Issues and Pull requests: write, following GitHub's requirements for fine-grained tokens |

The GitHub App requests the combined set. Existing installations must accept the new permissions, and until they do, only reads work. A mode becomes `CAPABILITY_UNAVAILABLE`, with the reason shown, when any of these holds:

- the installation hasn't granted that mode's permissions;
- Copilot isn't an assignable actor in the repository;
- the account isn't entitled to the cloud agent.

The other mode stays available. The factory never uses installation tokens, PATs or another user's grant, and never falls back from one mode to the other on failure.

Role instructions belong to the factory and are passed with each session, so nothing gets committed to the target repository. Using a repository's own `.github/agents` profiles is a later, opt-in extension.

**Reconnecting mid-run.** A run keeps its requester, Copilot account, mode and models for its whole life. Its connection generation can move forward only through a verified reconnect of the same provider account on the same host. Effects that were in flight under the old generation are reconciled before any new effect is made. Removing the connection stops the run, as part of the existing "Stop and remove" flow. A different account never inherits a run: the run stays `needs_auth` until the original account reconnects or the requester stops the run.

## Observation, recovery and cost

**Source of truth.** SQLite stores runs, plan revisions, pieces, sessions, review rounds and receipts for every external effect. For each active run, in both modes, the factory polls GitHub's tasks API, PRs, checks and issues at a bounded rate, with at most one poll in flight per run. In mode A, events streamed from the sessions update the live view between polls, but a state change always waits for evidence from the provider.

**The live view** shows normalized activity: turn starts and ends, tool categories and state labels. It doesn't show transcripts or prompts, consistent with the existing task-activity contract. The session's link on GitHub shows the full log.

**Recovery.** The run engine uses the existing in-process operation loop. Every external effect follows the same pattern: it is reserved, marked as in flight, and confirmed by its exact provider reference. The effects are creating a session, resuming one, creating an issue, linking a sub-issue, adding a dependency, assigning Copilot and posting a comment. An uncertain outcome is resolved by type:

| Effect | How an uncertain outcome is resolved |
| --- | --- |
| Creating a mode A session | Mode A sessions use a session ID reserved in advance, so the factory looks up that ID. |
| Creating an issue or comment | The factory looks for its marker. |
| Assigning Copilot | The factory checks the issue's assignees and the requester's tasks. |

Anything that can't be proven moves the run to `needs_recovery`, naming the specific effect, and nothing is retried while its outcome is uncertain. After a restart, active runs resume from their stored state, and mode A sessions are reattached by ID.

**Cost.** Each session's usage comes from GitHub's tasks API when GitHub reports it; otherwise it comes from the SDK's usage sample, and never from both. A run's total is the sum of its measured sessions, shown together with the number of sessions that have no measurement. Premium requests and AI credits are reported separately. Neither the run view nor Statistics shows unmeasured usage as zero.

## Portal

Each row in Open issues keeps two controls: **Start run**, which uses the defaults, and the gear, which opens **Configure run**. The defaults come from Copilot settings, which gain a default implementer mode and default models.

```text
Configure run · #42 Fix pagination on large imports
  Implementers   (•) Factory sessions (live)   ( ) GitHub assignment
  Implementer    [model ▾]  [effort ▾]
  Reviewer       [model from another family ▾]
                                          [Cancel]  [Start run]
```

An unavailable mode is shown disabled, with its reason. Only models valid for the selected mode and account are offered, and everything is checked again at start. If no model from another family is enabled, the reviewer uses the same family and the run view says so.

The repository's **Active tasks** pane becomes **Active runs**: one row per nonterminal run, which expands inline into the run view. Two example states of that view:

```text
#42 Fix pagination on large imports        Factory sessions · Awaiting your approval
Plan v2 (v1: changes requested)
  1  Page cursor encoding     scope: import cursor; tests over 10k rows
  2  Import batching          scope: batched writes of 500
  3  Docs for large imports   depends on 1
[Approve plan]  [Request changes…]  [Reject]

#42 Fix pagination on large imports        Factory sessions · Working · 41.2 credits
  #57 Page cursor encoding    Ready             PR #61 · review approved · checks 4/4
  #58 Import batching         In review         PR #62 · round 1 of 2 · checks 3/4
  #59 Docs for large imports  Waiting           blocked by #57 (merge PR #61)
  Sessions: planner ✓ · implementers 2 · reviewer 1                  [Stop run]
```

Changes to the other views:

- **Active Sessions** lists run sessions with their role and their run. Plans awaiting approval join its attention group, ahead of other sessions.
- **Statistics** counts runs and delivered PRs, and sums the measured credits per run.
- **Mode B rows** show "Status from GitHub, n s ago" and **Open in GitHub** instead of a live feed.

The visual design follows the existing design system and review process; the sketches above only fix content and order.

## HTTP contract additions

Every route follows the [shared HTTP rules](2026-11-26-internal-api-design.md#shared-http-rules), and each stays gated until its proofs pass.

| Method and path | Contract |
| --- | --- |
| `GET /api/connections/{id}/run-options` | Optional `copilotAccountId`. Returns `200 {copilotAccountId, start: Availability, modes: {factory_sessions: Availability, github_assignment: Availability}, models: {availability, items: {id, name, family, supportedEfforts, modes}[]}, limits: {maxPieces, maxParallel, maxPlanRevisions, maxReviewRounds}}`. |
| `POST /api/connections/{id}/runs` | Takes `StartRun` and returns `202 {runId, state: "planning"}` with `Location: /api/runs/{id}`. Replays return the same receipt. A different request reusing the same ID returns `409 REQUEST_ID_REUSED`, and an active run on the same issue returns `409 RUN_ALREADY_ACTIVE`. |
| `GET /api/connections/{id}/runs` | `state=active`, with cursor and limit. Returns `Page<RunRow>`. |
| `GET /api/runs/{id}` | Returns `RunDetail`: the state, mode and models; the current and previous plan revisions; the pieces with their sub-issue, PR, checks and review rounds; the sessions with their role, state, observation time and link; usage; and the actions available now. |
| `POST /api/runs/{id}/plan-decisions` | Takes `{requestId, revision, decision: "approve" \| "request_changes" \| "reject", feedback?}` and returns `202 {operationId}`. Returns `409 PLAN_REVISION_CHANGED` or `409 PLAN_DECISION_CLOSED`. |
| `POST /api/runs/{id}/actions` | Takes `{requestId, action: "retry_planning" \| "retry_review" \| "retry_piece" \| "recheck", pieceId?}` and returns `202 {operationId}`. Returns `409 ACTION_UNAVAILABLE` when the action doesn't apply to the current state, or `409 PIECE_BUSY` while that piece's previous session is still active. |
| `POST /api/runs/{id}/stop` | Takes `{confirmed: true}` and returns `202 {operationId}`. |

`StartRun` is `{startRequestId, workItemKey, copilotAccountId, implementerMode: "factory_sessions" | "github_assignment", implementer?: {model, reasoningEffort?}, reviewer?: {model, reasoningEffort?}}`, and the start fingerprint covers every field. `ActiveSessionSummary` rows gain `runId` and `role`, and `blocker` gains the values `plan_approval`, `checks_approval` and `agent_waiting`.

## Records and invariants

The builder chooses the tables and migrations, but these must hold:

- There is at most one nonterminal run per repository and parent issue, at most one active implementer per piece, and at most one active reviewer per piece and head SHA.
- A run's requester, Copilot account, mode and models are fixed when it starts. Its connection generation moves forward only through a verified reconnect of the same account, and a different account never inherits a run.
- Plan revisions are append-only. Exactly one revision per run can be approved, and the pieces reference it.
- Every session row records its role, mode and model; the task ID that was requested or discovered; the session URL, only once it is verified; the provider's state, with the time it was observed; and usage, with its source.
- Every review round records the head SHA, the verdict and findings, and references to the posted comment and the follow-up.
- Effect receipts never contain tokens or prompt text. Plan text, feedback, instructions and findings are protected application state with bounded size.
- For GitHub, runs replace single-session tasks as what Active Sessions and Statistics read. The developer trial's task records remain readable as history. Azure DevOps has no execution path until its runner is designed.

## Where the PoC runs

Runs are available in the normal hosted and desktop startup, not in the single-repository developer trial. The trial discards its database on exit, so it can't prove restart safety. Two operator settings gate runs:

- a feature flag, which can enable mode A alone until mode B's proofs pass;
- an allowlist of repositories by immutable GitHub repository ID, holding the PoC's disposable repositories.

Data persists in the normal data directory. The existing developer trial stays in place for the proofs.

Admission keeps the existing identity rule: the repository grant and the Copilot grant must belong to the same verified GitHub user on the same host. It drops the trial's rule that the requester must own the repository. An organization repository works when all of these hold:

- it is on the allowlist;
- the App is installed on it;
- the requester can write to it;
- the Copilot policy allows cloud sessions.

Proofs produce receipts that are kept with the release notes. Enabling runs, or a single mode, is an operator decision made through that configuration. The capability checker still evaluates the per-request facts (permissions, whether Copilot can be assigned, entitlement) on every start.

## Proofs before building the rest

Like the existing cloud trial, each proof runs from a development build against an explicitly approved, disposable personal repository, and reports a receipt.

1. A planner SDK session ends with a valid plan, and the tasks API shows no branch or PR artifact for it.
2. A mode A implementer session opens a draft PR that closes its sub-issue, and the PR appears as the task's `pull` artifact. If the session only pushes a branch, the proof records that. The fallback, a draft PR opened by the factory from the branch artifact under the requester's identity, then needs its own decision.
3. A reviewer session started from a PR's branch returns a verdict and pushes nothing.
4. Resuming the implementer session with findings adds commits to the same PR.
5. With a GitHub App user token, each of the following works:
   - creating issues, linking sub-issues and adding dependencies;
   - assigning Copilot with an `agent_assignment` model and instructions;
   - finding the resulting task and linking its PR on evidence;
   - an `@copilot` comment by the requester producing commits on the same PR.
6. The tasks API reports usage for each session in both modes.
7. Three implementer sessions run in parallel under one account without being throttled or run one at a time.
8. An active cloud session can be stopped through a supported API, confirmed by its terminal state.
9. A new SDK session started from an existing PR's head branch commits to that PR instead of opening another one.
10. On a Copilot-authored PR, the checks reader tells apart workflows awaiting approval, no checks, pending checks and passed checks.

A failed proof disables only what depends on it.

## Delivery slices

1. Proofs 1 to 10, as development scripts that produce receipts.
2. The run engine and plan approval on the operation loop: planner sessions, the run-options and plan-decision routes, and the run view's approval state.
3. Filing pieces, with reconciliation.
4. Mode A implementers and the review loop.
5. Mode B implementers.
6. Updates to Active Sessions, Statistics and Copilot settings, then end-to-end PoC runs in both modes on the disposable repository.

## Acceptance

The PoC definition in [Intent](#intent) must hold. These fault tests must also pass without network effects:

- duplicate start and decision requests;
- a stale plan revision;
- a restart while each type of effect is in flight;
- an ambiguous issue creation, which must not be repeated;
- a head SHA that moves during review;
- a mode B task that never links;
- a grant revoked mid-run, then a reconnect of the same account;
- a prerequisite PR closed without merging;
- checks that are held for approval, missing, or never complete;
- Copilot waiting for the requester;
- unmeasured usage;
- a capability missing for only one mode.

Strict checks and both 95% coverage gates pass.

## Left to the builder

- Table and migration design, within the invariants above.
- The exact prompts, and the JSON schemas for plans and verdicts.
- The polling rate.
- How model families are derived from catalog metadata.
- The bounded wait for pending checks.
- How streamed events from mode A sessions are normalized into activity.
- Whether the trial task path is removed or kept behind its development flag.

## Deferred: Azure DevOps runner

The requester chose to run Azure DevOps work on the factory host after this PoC, isolated with Microsoft Execution Containers (MXC), ideally in micro-VMs. These findings from 2026-11-28 are the starting point:

- **MXC** is an SDK that applications embed (`@microsoft/mxc-sdk` for Node). It applies one policy model (readable, writable and denied paths; network denied by default; proxies) across interchangeable isolation backends, and refuses to run a policy that a backend can't enforce.
- **Copilot's built-in command sandbox** uses MXC's process-level backends:
  - bubblewrap on Linux;
  - the Windows process container, on Windows 11 24H2 or 25H2 from build 26100.9278;
  - Seatbelt on macOS.

  It sandboxes shell commands, search, and local MCP and language servers. Built-in file edits only follow the policy on a best-effort basis. Git and `gh` credentials stay outside the sandbox through a proxy that masks them. The SDK docs don't describe enabling the sandbox for a single session.
- **MXC's micro-VM backend** is experimental and Windows x64 only. It needs the Windows Hypervisor Platform, boots a Linux guest from a registry image, limits each workload to one hour, and only has a development JSON API.
- **Bubblewrap doesn't run in a default Docker container.** It needs a seccomp profile that allows creating namespaces, an unmasked `/proc`, and `/dev/net/tun` for network access. Each of these weakens the outer container's isolation.
- **On Windows, MXC sends required diagnostic telemetry to Microsoft**, and administrative policy can't disable it.

## References

- [Copilot SDK cloud sessions](https://github.com/microsoft/copilot-sdk/blob/main/docs/features/cloud-sessions.md)
- [Using Copilot cloud agent via the API](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api)
- [Agent tasks REST API](https://docs.github.com/en/rest/agent-tasks/agent-tasks)
- [Sub-issues REST API](https://docs.github.com/en/rest/issues/sub-issues)
- [Issue dependencies REST API](https://docs.github.com/en/rest/issues/issue-dependencies)
- [Cloud agent risks and mitigations](https://docs.github.com/copilot/concepts/agents/coding-agent/risks-and-mitigations)
- [Custom agents for the cloud agent](https://docs.github.com/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents)
- [Copilot local sandboxing](https://docs.github.com/copilot/concepts/about-cloud-and-local-sandboxes)
- [MXC](https://github.com/microsoft/mxc)
