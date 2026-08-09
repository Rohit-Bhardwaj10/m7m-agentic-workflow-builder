# PRD — AI Agent Workflow Builder
**Stack:** nhost (Postgres + Hasura + Auth + Storage + Functions) · Hasura GraphQL Engine · PostgreSQL · GraphQL · Next.js/React

---

## 1. Problem Statement

Build a multi-tenant, mini-n8n-style workflow builder purpose-built for chaining AI agent steps. Organizations contain members with roles; members build workflows out of typed steps; workflows are started via multiple trigger mechanisms; and every action — from viewing a workflow to clearing an approval gate — is checked against **two independent, differently-enforced permission layers**.

The deliverable is proven correct by **one live, end-to-end scenario**, not a feature checklist. That scenario is the actual product spec: everything below exists to make it pass.

## 2. Goals

- Prove strict multi-tenant isolation enforced at the database layer (Hasura permissions), not just in application code.
- Prove step-level authorization enforced in application/Action-handler code, where DB row permissions can't express the logic (e.g., mid-execution approval decisions).
- Prove a real (or honestly-stubbed) execution engine: ordered step execution, retries, conditional branching, pause/resume.
- Prove four distinct ways to start a run, at least one of which is not a button click.
- Prove live status propagation via GraphQL subscriptions, with no polling/refresh.

## 3. Non-Goals (explicitly out of scope)

- Visual drag-and-drop workflow canvas — functional UI to add/reorder/configure steps is sufficient.
- Arbitrary step types beyond the six specified.
- Production-grade LLM orchestration (parallel steps, loops, sub-workflows).
- Billing/payment for quota — quota is tracked and enforced, not monetized.
- Polished design system — clarity and correctness over visual polish.

## 4. Users & Roles

| Role | Can view org's workflows | Can create/edit workflows & steps | Can trigger a run | Can manage org members | Can add `db_write` / `notify` step (owner-only step types) | Can approve `approval_gate` |
|---|---|---|---|---|---|---|
| **owner** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **editor** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| **viewer** | ✅ (read-only) | ❌ | ❌ | ❌ | ❌ | ❌ |

> **Note:** `webhook` is a **trigger type** (Section 7), not a step type. The owner-only restriction applies to the `db_write` and `notify` **step types** only. Adding a webhook trigger to a workflow is also owner-only and is enforced via Layer 2 (Section 8).

All of the above is additionally scoped: a role only grants access **within the caller's own org**, verified via `org_members`. Same role in a different org = no access, including via direct ID guessing.

## 5. Data Model

```
organizations
  id, name, quota_limit, quota_used, quota_period_start

org_members
  id, org_id (fk), user_id (fk -> nhost auth.users), role (owner|editor|viewer)

workflows
  id, org_id (fk), name, created_by (fk -> org_members), created_at

workflow_steps
  id, workflow_id (fk), step_order (int), type (enum), config (jsonb)

workflow_triggers
  id, workflow_id (fk), type (manual|webhook|scheduled|db_event), config (jsonb)
  UNIQUE(workflow_id)  -- enforces one active trigger per workflow (mirrors the UI constraint in Section 11)

workflow_runs
  id, workflow_id (fk), status (pending|running|paused|completed|failed),
  started_by (fk -> auth.users, nullable for system-initiated runs), started_at, completed_at

step_runs
  id, workflow_run_id (fk), workflow_step_id (fk), status (pending|running|
  paused|approved|rejected|completed|failed), input (jsonb), output (jsonb),
  error (text), attempt_count (int), approved_by (fk, nullable),
  approved_at (timestamptz, nullable)
```

**Relationship chain:** `organizations → org_members → workflows → workflow_steps / workflow_triggers`, and `workflows → workflow_runs → step_runs`.

**Computed aggregation (mandatory):**
- Postgres view `org_usage_this_month` (sum of `workflow_runs` in current period per org), exposed via Hasura as a computed field on `organizations`. This is **required** — it directly powers the quota/usage indicator in Section 11 and the quota enforcement check in Section 9. `avg_run_duration` may be added as a supplementary view but does not substitute for `org_usage_this_month`.

## 6. Step Types

| Type | Behavior | Notes |
|---|---|---|
| `llm_call` | Calls a real LLM API (Groq/OpenRouter/Gemini free tier, or a disclosed stub with artificial delay) | Output feeds next step / conditional |
| `http_request` | Generic external API call | Retry on failure (min. 1 retry) |
| `db_write` | Persists a result into app tables | **Owner-only to add to a workflow (authoring-time restriction only).** Any role that can trigger a run may execute a workflow that already contains a `db_write` step — the restriction is not re-checked at execution time. |
| `notify` | Slack/email alert | The step writes a dedicated row to a `notifications` table (or sets a trigger field on the `step_run`); a **Hasura Event Trigger** on that table fires the outbound webhook/email call to Slack or a mail provider. This keeps the outbound call asynchronous and outside the synchronous Action handler. **Owner-only to add.** |
| `conditional_branch` | Branches based on previous step's output | Drives the demo's "LLM output changes behavior" requirement |
| `approval_gate` | Pauses the run until an authorized user approves | Resume logic lives in the Action handler, not a DB permission |

## 7. Trigger Types

| Type | Mechanism |
|---|---|
| Manual | User clicks Run → calls `triggerWorkflowRun` Action directly |
| Webhook | Hasura Action exposed as an inbound HTTP endpoint external systems call |
| Scheduled | Cron-based nhost/Hasura scheduled function |
| Database event | Hasura Event Trigger on a watched table row-change auto-invokes the run |

At least one non-manual trigger must be **actually wired and demonstrable**, not just described.

## 8. Permissions — Two Layers

### Layer 1 — Hasura row-level permissions (org + role scoping)
- Enforced entirely in Hasura's permission system using session variables (`X-Hasura-User-Id`, `X-Hasura-Role`, `X-Hasura-Org-Id` if using a custom claim, or a relationship-based check against `org_members`).
- Every table's select/insert/update/delete permission includes a check that `org_members.user_id = X-Hasura-User-Id AND org_members.org_id = <row's org_id>` (directly or via relationship).
- This is what makes cross-org ID guessing fail: even a syntactically valid query for another org's `workflow_id` returns nothing, because the permission filter excludes rows outside the caller's org membership.

### Layer 2 — Application-level step gating (enforced in Action handlers)
- Cannot be expressed as a simple row permission because it's conditional on **step type** and **mid-execution state**, not a static row check.
- Rules enforced in code before mutation/execution proceeds:
  - Only `owner` may create a `db_write` step, `notify` step, or `webhook` trigger type — checked in the create/edit workflow mutation resolver or a Hasura permission preset combined with a validation function. (Note: `webhook` here refers to the **trigger type**, not a step type. There is no `webhook` step type.)
  - `approveStep` Action explicitly re-verifies the caller's role/org membership server-side before flipping `step_runs.status` from `paused` → `approved` and resuming execution — this must not rely on the client having already passed a UI gate.
  - **`viewer` role is explicitly blocked from calling `approveStep`** — even if a viewer somehow constructs a valid `approveStep` mutation, the Action handler must reject it with a permission error after re-fetching the caller's role from session variables. Do not rely on the UI hiding the Approve button as the sole enforcement.

**Design principle to state explicitly in the write-up:** Layer 1 answers "can this identity touch this row at all," Layer 2 answers "given a decision point mid-execution, is this identity allowed to make it" — the second can't be precomputed as a row filter because it depends on run state at the moment of the call.

## 9. Core Integration — `triggerWorkflowRun` Action

Sequence:
1. Verify caller is `owner`/`editor` in the workflow's org (Layer 1 + explicit check, since Actions bypass table permissions by default).
2. **Atomically** check and reserve quota: run `UPDATE organizations SET quota_used = quota_used + 1 WHERE id = $org_id AND quota_used < quota_limit RETURNING id`. If 0 rows are updated, the quota is exhausted — reject immediately before any step executes. This prevents the race condition where concurrent runs all pass a plain `SELECT` check before any of them increments the counter.
3. Create `workflow_runs` row (`status = running`).
4. Execute `workflow_steps` in `step_order`:
   - `llm_call` / `http_request`: real external call, minimum 1 retry on failure, update `step_runs` (status/output/error/attempt_count) after each attempt.
   - `conditional_branch`: evaluate previous step's output, select next path.
   - `approval_gate`: set `step_runs.status = paused`, set `workflow_runs.status = paused`, **stop execution**.
5. `approveStep` Action (separate call): verify approver's role is `owner` or `editor` (not `viewer`) in the workflow's org, set `approved_by`/`approved_at`, resume execution from the next step.
6. On full completion:
   - If the run **succeeds**: set `workflow_runs.status = completed`. The quota reservation made in Step 2 is permanently consumed — no further action needed.
   - If the run **fails** (unrecoverable error, not a paused state): set `workflow_runs.status = failed` and **decrement `organizations.quota_used` by 1** (`UPDATE organizations SET quota_used = quota_used - 1 WHERE id = $org_id`). Quota is charged only for successfully completed runs per the original specification — the atomic check-and-reserve in Step 2 is a concurrency guard, not a permanent deduction on failure.
7. Every status write must occur in a way the `step_runs` subscription picks up live (i.e., writes go through the DB, not just in-memory state).

## 10. GraphQL Operations

- **Query:** org's workflows with nested steps, triggers, and most recent `workflow_runs.status`.
- **Mutation:** create/edit a workflow with its steps and triggers (transactional — steps/triggers shouldn't half-save).
- **Mutation:** `approveStep(step_run_id)` → Action, Layer 2 enforced inside.
- **Subscription:** `step_runs` filtered by `workflow_run_id`, streaming status transitions including `paused`.

## 11. Frontend Requirements

- Auth via nhost; org context switcher if a user belongs to multiple orgs.
- Workflow builder screen: add/reorder/configure steps (type + JSON config), attach one trigger.
- Run button — **hidden for `viewer` role**.
- Live run view: per-step status via subscription, pause/approve UI surfaced only to authorized roles.
- Quota/usage indicator on the org dashboard.

## 12. Acceptance Criteria — The Final Scenario

This is the single source of truth for "done." All six must hold in one live walkthrough:

1. Two orgs exist, each with its own users/roles.
2. Org A owner builds a workflow with ≥3 step types including `llm_call`, `http_request`, and a `conditional_branch` whose path changes based on the LLM's actual output.
3. The workflow starts two ways: manually **and** via webhook or event trigger.
4. An `approval_gate` step pauses the run; only an owner/editor in Org A can approve it forward.
5. Live status streams step-by-step, no refresh, including the `paused` state, visible in the UI.
6. Logged in as an Org B user: cannot see, trigger, or approve any Org A resource — including by directly guessing an Org A `workflow_id`/`step_run_id`.

## 13. Non-Functional Requirements

- Retry logic on `llm_call`/`http_request` must be visible in `step_runs.attempt_count` (not silent).
- Quota enforcement must reject a run *before* any step executes if exhausted.
- Cross-org isolation must be verified adversarially (attempt direct ID access as the wrong org's user), not just "not shown in the UI."
- README must state clearly whether the LLM call is live or stubbed, and why.

## 14. Suggested Build Sequence (de-risk the hard parts first)

Given the "fastest correct submission wins" evaluation, sequence to prove the risky integration points early rather than polishing UI first:

1. Schema + migrations + seed two orgs/users/roles.
2. Hasura Layer 1 permissions — test cross-org isolation manually via GraphiQL with different session tokens **before writing any frontend**.
3. `triggerWorkflowRun` Action skeleton — hardcode a 2-step workflow to prove execution + status writes + subscription update end-to-end. (This is an incremental step; the final acceptance scenario requires ≥3 step types — expand in Step 5.)
4. Add `approval_gate` pause/resume + Layer 2 gating in `approveStep`.
5. Add `conditional_branch` + real `llm_call`/`http_request` with retry.
6. Wire one non-manual trigger (webhook is usually fastest to stand up as another Action).
7. Frontend: builder screen → run view w/ subscriptions → quota indicator.
8. Record the Final Task scenario; write the ~1 page write-up.

## 15. Deliverables

- GitHub repo + README (setup, local run instructions, API key / stub notes).
- Hosted Next.js app (Vercel or similar).
- Hasura metadata/migrations (schema, relationships, both permission layers).
- ~1 page write-up: schema reasoning, how the two permission layers differ in enforcement, how pause/resume works.
- Screen recording of the Final Task scenario.

## 16. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Layer 1 and Layer 2 permission logic drift out of sync during fast iteration | Write the cross-org isolation test once, early, rerun it after every schema/permission change |
| Approval gate resume silently doesn't re-check role (relies on stale client state) | `approveStep` must re-fetch role from session vars server-side on every call, never trust client-passed role |
| Subscription doesn't reflect `paused` state due to status write happening off the DB write path | Ensure every state transition in the Action handler is a committed DB write, not in-memory only |
| Running out of time before webhook/event trigger is wired | Build webhook trigger before scheduled/db-event — it reuses the same Action pattern as manual trigger |

## 17. Evaluation Criteria

Priority order — from the original assignment. Higher-ranked items are weighted more heavily; a broken item at the top is not offset by polish at the bottom:

| Priority | Criterion |
|---|---|
| 1 (highest) | **The Final Task passes, live** — all six acceptance criteria hold in one uninterrupted walkthrough |
| 2 | **Cross-org isolation is airtight** — including adversarial direct ID guessing, not just "not shown in UI" |
| 3 | **Step-level permission gating enforced in the Action handler** — not assumed or delegated to the client |
| 4 | **Retry/failure handling and quota enforcement** — attempt_count visible, quota rejected before first step executes |
| 5 | **Schema and Hasura relationship correctness** |
| 6 (lowest) | **Code and documentation clarity** |

> **Implication for build order:** nail isolation and the Action handler before touching UI polish. A flawless Final Task with minimal UI beats a beautiful UI with a broken permission layer.

## 18. Time & Submission

- **No fixed time limit** — submit when the Final Task scenario passes end-to-end.
- **Priority rule:** earliest *correct* submission is reviewed first. Submitting early with a broken scenario does **not** beat a later working one. The ordering is: correctness first, then speed.
- **How to submit:** GitHub repo link + hosted app URL.
- Do not submit if any of the six Final Task acceptance criteria (Section 12) are broken — reviewers will run the scenario live on the hosted app.