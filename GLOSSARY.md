# Software Factory

Software Factory connects a requester's repositories and coordinates GitHub Copilot cloud agents that work on their issues, so the requester decides on plans and pull requests instead of doing the work.

## Runs

**Run**:
One parent issue worked on by a team of Copilot cloud agents, from a plan to draft pull requests, owned by one requester.
_Avoid_: Task (the earlier single-session unit), job, swarm

**Plan revision**:
One validated proposal that splits a run's issue into pieces, with their dependencies and acceptance checks.
_Avoid_: Spec, proposal

**Piece**:
One approved unit of a run's plan, filed as a sub-issue of the parent issue and delivered as one draft pull request.
_Avoid_: Subtask, chunk, work package

**Session**:
One Copilot cloud agent working for a run in a single role.
_Avoid_: Agent task (GitHub's API term), worker, job

**Planner**:
The session role that proposes a run's plan without changing code.

**Implementer**:
The session role that delivers one piece as a draft pull request.

**Reviewer**:
The session role that checks one pull request, using a model from a different family than the implementer's.
_Avoid_: Auditor, checker

**Review round**:
One reviewer verdict on one head revision of a piece's pull request, plus the follow-up it triggers.

**Work mode**:
How a run's implementation work gets done on GitHub: **GitHub-managed** or **factory-managed**, chosen per run.
_Avoid_: Implementer mode, mode A, mode B

**GitHub-managed**:
The work mode in which the factory works through GitHub's Copilot API: it assigns sub-issues to Copilot and steers the work with `@copilot` mentions, while GitHub manages the sessions.
_Avoid_: GitHub assignment, native mode

**Factory-managed**:
The work mode in which the factory creates and manages Copilot cloud sessions itself.
_Avoid_: Factory sessions, live mode

## People

**Requester**:
The signed-in person who starts a run, decides on its plan, and owns every write the run makes.
_Avoid_: User, owner (an instance owner is a different role)

## Layers

**Coordination layer**:
The factory's part of a run: decisions, evidence, receipts and measured cost. It never runs repository code.

**Execution layer**:
GitHub-hosted Copilot compute and the repository, where sessions run and where their branches and pull requests live.
