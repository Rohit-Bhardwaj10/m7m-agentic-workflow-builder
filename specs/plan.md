# Build Plan — AI Agent Workflow Builder
## Horizontal Slices (Walking Skeleton Approach)

Each slice touches **every layer**: schema → Hasura config → backend Action handler → frontend UI.
Each slice ends with a **concrete done signal** — something you can open in a browser and prove works right now.

Layers key: 🗄️ Schema/DB · ⚙️ Hasura · 🔧 Backend Action · 🖥️ Frontend

---

## Slice 1 — "Hello, Workflow" (Walking Skeleton)

> **Goal:** Full stack wired end-to-end. One org, one user, one workflow, two steps, runs to completion.
> By the end you have a deployable app, not just a schema.

### 🗄️ Schema / Migrations
- Create all 7 tables with correct FK relationships:
  `organizations`, `org_members`, `workflows`, `workflow_steps`, `workflow_triggers`, `workflow_runs`, `step_runs`
- Add `UNIQUE(workflow_id)` on `workflow_triggers`
- Seed: 1 org (Org A), 1 owner user, 1 workflow with 2 hardcoded steps:
  - Step 1: `http_request` (call any public API, e.g. `https://httpbin.org/get`)
  - Step 2: `llm_call` (stubbed — returns fixed string with 1s artificial delay)

### ⚙️ Hasura
- Track all 7 tables
- Wire all FK relationships (object + array relationships)
- **Permissive owner-only permissions for now** (no cross-org isolation yet — that's Slice 3)
- Expose `triggerWorkflowRun` Action definition (input: `workflow_id`, output: `workflow_run_id`)

### 🔧 Backend Action Handler
- `triggerWorkflowRun(workflow_id)`:
  1. Look up workflow + steps ordered by `step_order`
  2. Create `workflow_runs` row (`status = running`)
  3. For each step: create `step_run` row → execute → update `step_run` (status/output/attempt_count)
  4. Set `workflow_runs.status = completed`
- No retry logic yet, no quota, no approval gate — just sequential execution

### 🖥️ Frontend
- nhost auth: login page, JWT session
- Org dashboard: hardcoded to Org A, shows list of workflows (query)
- Workflow detail page: "Run" button → calls `triggerWorkflowRun` mutation
- Run result: poll `workflow_runs.status` every 2s, show current status text (polling is fine here — replaced in Slice 2)

### ✅ Done Signal
```
Login as Org A owner → see workflow listed → click Run →
poll shows "running" → then "completed" →
DB has 2 step_run rows with status=completed and output filled in.
```

---

## Slice 2 — "Watch It Live + Approval Gate"

> **Goal:** Replace polling with a real GraphQL subscription. Add `approval_gate` pause/resume. 
> By the end, the live-streaming and approval loop work — two of the hardest moving parts.

### 🗄️ Schema / Migrations
- No new tables
- Ensure `step_runs.status` enum includes: `pending | running | paused | approved | rejected | completed | failed`
- Ensure `step_runs.approved_by` and `approved_at` columns exist

### ⚙️ Hasura
- Enable **subscription** on `step_runs` (filtered by `workflow_run_id`)
- Define `approveStep(step_run_id)` Action
- Add the `approveStep` Action resolver route in Hasura metadata

### 🔧 Backend Action Handler
- `triggerWorkflowRun` — extend step executor:
  - On `approval_gate` step: write `step_runs.status = paused`, `workflow_runs.status = paused`, **stop and return**
  - Retry logic for `http_request` steps: catch failure, increment `attempt_count`, retry once, write final status
- **New:** `approveStep(step_run_id)` handler:
  1. Re-fetch caller's role from Hasura session vars — **reject if `viewer`**
  2. Verify `step_run.workflow.org_id` matches caller's org — **reject if mismatch**
  3. Set `step_runs.status = approved`, write `approved_by`, `approved_at`
  4. Set `workflow_runs.status = running`
  5. Resume execution from the next step after the gate

### 🖥️ Frontend
- Replace polling with `useSubscription` on `step_runs` by `workflow_run_id`
- Live run view: one card per step, status badge updates in real time (pending → running → completed/paused)
- When a step has `status = paused`: show "Awaiting Approval" banner
- Show "Approve" button **only** to `owner` or `editor` roles (hide for `viewer`)
- Approve button calls `approveStep` mutation → watch subscription resume automatically

### ✅ Done Signal
```
Run a 3-step workflow (http_request → approval_gate → llm_call stub):
Cards appear and flip statuses live with zero page refresh →
Run pauses on step 2 → click Approve → step 3 runs to completion live.
Viewer role: Approve button is absent.
```

---

## Slice 3 — "Two Orgs, Airtight Walls"

> **Goal:** Multi-tenant isolation, adversarially verified. Priority #2 in evaluation criteria.
> By the end you can demo cross-org isolation on command.

### 🗄️ Schema / Migrations
- Seed Org B: 1 owner, 1 editor, 1 viewer — each with their own workflows and runs
- Confirm `org_members` entries for all new users

### ⚙️ Hasura
- **Tighten ALL table permissions** — replace permissive Slice 1 rules:
  - `select` permission for every table: require `org_members` join — `{ org_members: { user_id: { _eq: X-Hasura-User-Id }, org_id: { _eq: <row's org_id> } } }`
  - `insert/update/delete` permissions: same org check + role check where applicable
  - `workflows`, `workflow_steps`, `workflow_runs`, `step_runs`: all scoped through the org chain
- Test every table in Hasura's GraphiQL console with Org B's JWT — confirm zero Org A rows returned
- Test with a raw `workflow_id` from Org A as Org B user — must return `null` / empty

### 🔧 Backend Action Handler
- Both `triggerWorkflowRun` and `approveStep` already re-check role; add **explicit org membership verification**:
  - After Hasura session var extraction: query `org_members` for `(user_id, org_id)` — if no row found, `403 Forbidden`
  - This is essential because **Actions bypass Hasura row permissions by default**
- Add `viewer` trigger-block: if role is `viewer`, reject `triggerWorkflowRun` before any DB write

### 🖥️ Frontend
- Org context switcher in navbar (if user belongs to multiple orgs, show dropdown)
- When switched to Org B context: workflows list shows only Org B workflows
- **Adversarial demo UI:** add a hidden `/debug` page that lets you type any `workflow_id` UUID and attempt a `triggerWorkflowRun` — shows the 403 response visibly

### ✅ Done Signal
```
Logged in as Org B owner:
- Workflow list shows only Org B workflows
- Paste Org A's workflow_id into debug page → 403 Forbidden
- Paste Org A's step_run_id into subscription query → empty result
Cross-org isolation proven adversarially, not just by UI omission.
```

---

## Slice 4 — "Full Step Palette + Smart Branching"

> **Goal:** All 6 step types wired. LLM output drives `conditional_branch`. `notify` fires via Event Trigger.
> By the end you can build the exact workflow required by the Final Task acceptance criteria.

### 🗄️ Schema / Migrations
- Add `notifications` table:
  `id, step_run_id (fk), channel (text), payload (jsonb), sent_at (timestamptz, nullable)`
- Add `org_usage_this_month` Postgres view:
  ```sql
  CREATE VIEW org_usage_this_month AS
  SELECT org_id, COUNT(*) AS runs_this_month
  FROM workflow_runs
  WHERE started_at >= date_trunc('month', NOW())
    AND status = 'completed'
  GROUP BY org_id;
  ```

### ⚙️ Hasura
- Track `notifications` table, wire FK to `step_runs`
- **Event Trigger** on `notifications` INSERT → fires webhook to your notification handler (Slack/email or log stub)
- Expose `org_usage_this_month` view as a computed field on `organizations`
- Layer 2 enforcement: add column preset / check on `workflow_steps` insert that blocks `db_write` and `notify` type for non-owner roles

### 🔧 Backend Action Handler
- Extend step executor with all 6 step types:

  | Step Type | Handler Logic |
  |---|---|
  | `llm_call` | Call Groq/OpenRouter API with `config.prompt`; if stubbed, sleep 1s + return fixed JSON; min 1 retry |
  | `http_request` | `fetch(config.url, config.method/headers/body)`; min 1 retry; write response to `output` |
  | `db_write` | Insert `config.table` row with `config.data` merged with previous step's output |
  | `notify` | Insert row into `notifications` table → Event Trigger fires outbound call |
  | `conditional_branch` | Evaluate `config.condition` against previous step's `output` JSON; return `true_path` or `false_path` step index |
  | `approval_gate` | Already done in Slice 2 |

- `conditional_branch` skips to the correct next `step_order` based on evaluation result

### 🖥️ Frontend — Workflow Builder
- Workflow builder screen: list of steps with drag-handle reorder (or up/down buttons)
- Per step: type selector dropdown (6 options), JSON config textarea
- Enforce owner-only add for `db_write` / `notify` step types — disable options in dropdown for non-owner
- Save workflow: transactional mutation (upsert workflow + delete+insert steps + upsert trigger)

### ✅ Done Signal
```
Build a workflow: llm_call → conditional_branch → (path A: http_request, path B: db_write)
Run it → branch chosen matches LLM's output →
notify step fires → row appears in notifications table → Event Trigger log shows outbound call.
org_usage_this_month view shows incremented count.
```

---

## Slice 5 — "Fire Without a Button + Quota Guard"

> **Goal:** Non-manual trigger actually wired. Atomic quota enforcement with rollback on failure.
> By the end, the run can start from a `curl` and quota is bulletproof.

### 🗄️ Schema / Migrations
- No new tables
- Confirm `organizations.quota_limit`, `quota_used`, `quota_period_start` all set in seed data

### ⚙️ Hasura
- **Webhook trigger Action:** `startWorkflowViaWebhook(workflow_id, payload)` — public endpoint (no auth header), verifies a shared secret in `config.webhook_secret` instead
- Optional: Hasura Scheduled Event → cron expression in `workflow_triggers.config` for `scheduled` type
- Optional: Hasura Event Trigger on a "watched" table for `db_event` trigger type

### 🔧 Backend Action Handler
- `triggerWorkflowRun` — add atomic quota check (already specified in PRD §9 Step 2):
  ```sql
  UPDATE organizations
  SET quota_used = quota_used + 1
  WHERE id = $org_id AND quota_used < quota_limit
  RETURNING id
  ```
  - 0 rows returned → reject with `429 Quota Exhausted` before any step runs
- On run `failed`: decrement `quota_used` by 1 (rollback reservation)
- Webhook handler: extract `workflow_id` from request, look up trigger config, call the same core execution function as manual trigger

### 🖥️ Frontend
- Trigger config section in workflow builder: type = `webhook` shows the inbound URL to copy
- **Quota/usage indicator** on org dashboard: `org_usage_this_month.runs_this_month / organizations.quota_limit` shown as a progress bar
- Show "Quota exhausted" state if at limit — Run button disabled with tooltip

### ✅ Done Signal
```
curl -X POST https://<hasura-url>/api/rest/start-workflow \
  -d '{"workflow_id": "<uuid>", "secret": "xxx"}'
→ run starts with no browser interaction →
subscription in the UI reflects the run live.

Exhaust quota: set quota_used = quota_limit in DB →
click Run → rejected immediately, no step_run rows created.
```

---

## Slice 6 — "Final Task Ready — Ship It"

> **Goal:** All 6 acceptance criteria demonstrable in a single uninterrupted walkthrough. Write-up + deploy.

### 🗄️ Schema / Migrations
- Final migration: ensure seed has both Org A and Org B with correct users and roles
- Confirm `workflow_triggers` has at least one webhook trigger wired for the demo workflow
- `README.md`: setup steps, env vars list, note on LLM stub vs live

### ⚙️ Hasura
- Export full metadata: `hasura metadata export`
- Final permission audit: re-run every table's permissions against both Org A and Org B JWTs in GraphiQL
- Confirm Event Trigger for `notifications` is in metadata and pointing to correct handler URL

### 🔧 Backend
- `~1 page write-up.md`:
  - Schema reasoning (why the org→member→workflow chain, why JSONB for config)
  - Layer 1 vs Layer 2: where each is enforced and why Layer 2 can't be a DB permission
  - Pause/resume: how `approval_gate` stops the Action and `approveStep` resumes it
- End-to-end smoke test: run the 6-step Final Task scenario manually, fix any breakage

### 🖥️ Frontend
- Deploy to Vercel (`vercel --prod`)
- Org context switcher fully working (switch between Org A and Org B without re-login)
- Ensure the `/debug` adversarial page from Slice 3 still returns 403 on cross-org IDs
- Record the Final Task scenario screen recording (OBS or Loom):
  1. Org A owner builds workflow with ≥3 types
  2. Trigger manually → runs live
  3. Trigger via webhook → runs without button
  4. approval_gate pauses → owner approves → resumes
  5. subscription updates step-by-step, no refresh
  6. Switch to Org B → try to access Org A resources → blocked

### ✅ Done Signal (= The Final Task)
```
All six acceptance criteria from PRD §12 pass in one live walkthrough:
✅ Two orgs, own users/roles
✅ Workflow with llm_call + http_request + conditional_branch (LLM output changes branch)
✅ Started manually AND via webhook/event
✅ approval_gate pauses → only owner/editor in Org A can approve
✅ Live subscription, no refresh, paused state visible
✅ Org B user: cannot see, trigger, or approve Org A resources even by guessing IDs
```

---

## Layer Coverage Matrix

| Layer | S1 | S2 | S3 | S4 | S5 | S6 |
|---|---|---|---|---|---|---|
| 🗄️ Schema | All tables + seed | enum values | Org B seed | notifications + view | Quota fields | Final seed + README |
| ⚙️ Hasura | Track + basic perms | Subscription + approveStep Action | Tight Layer 1 perms | Event Trigger + computed field | Webhook Action | Metadata export + audit |
| 🔧 Backend | 2-step sequential executor | Pause/resume + retry | Org membership check in all Actions | All 6 step types + conditional logic | Atomic quota + rollback | Write-up + smoke test |
| 🖥️ Frontend | Login + run button + polling | Live subscription + approve UI | Org switcher + adversarial debug | Workflow builder (all step types) | Quota indicator + webhook URL | Deploy + record |

## Risk Watch-Points

| Risk | Slice | Mitigation |
|---|---|---|
| Hasura subscription not reflecting `paused` | S2 | Every state write must be a committed DB row — never in-memory only |
| Actions bypass row permissions → cross-org leak | S3 | Explicit `org_members` query inside every Action handler |
| `conditional_branch` jumps to wrong step | S4 | Compute next `step_order` from branch result, not array index |
| Concurrent runs exhaust quota past limit | S5 | Atomic `UPDATE...WHERE quota_used < quota_limit RETURNING id` |
| Webhook trigger URL exposed without auth | S5 | Verify shared secret from `workflow_triggers.config` in handler |
| Subscription still showing Org A data after org switch | S6 | Re-subscribe with new `workflow_run_id` on org context change |
