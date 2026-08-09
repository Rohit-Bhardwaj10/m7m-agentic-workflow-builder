# context.md — AI Agent Workflow Builder
> **Living document.** Update this file after every task. It is the source of truth for current project state.

---

## Current Status

- **Active Slice:** Slice 2
- **Last Completed Task:** Completed Slice 1 (Scaffolding, Schema, Backend Actions, Basic Frontend)
- **Next Task:** Begin Slice 2 — Real-time subscriptions and approval_gate step type

---

## Project Identity

| Field | Value |
|---|---|
| Project name | mini-n8n — AI Agent Workflow Builder |
| Stack | nhost · Hasura GraphQL Engine · PostgreSQL · Next.js/React |
| Repo | _(not created yet)_ |
| Hosted URL | _(not deployed yet)_ |
| LLM provider | _(not chosen yet — Groq / OpenRouter / Gemini free tier or stub)_ |
| nhost project | _(not created yet)_ |

---

## Slice Progress

| Slice | Name | Status | Done Signal Achieved? |
|---|---|---|---|
| S1 | Hello, Workflow | ✅ Done | ✅ |
| S2 | Watch It Live + Approval Gate | ⬜ Not started | ❌ |
| S3 | Two Orgs, Airtight Walls | ⬜ Not started | ❌ |
| S4 | Full Step Palette + Smart Branching | ⬜ Not started | ❌ |
| S5 | Fire Without a Button + Quota Guard | ⬜ Not started | ❌ |
| S6 | Final Task Ready — Ship It | ⬜ Not started | ❌ |

Status legend: ⬜ Not started · 🔄 In progress · ✅ Done · 🔥 Blocked

---

## Key Decisions Log
> Record every design decision made so future sessions do not relitigate it.

| # | Decision | Rationale |
|---|---|---|
| 1 | Quota reserved atomically at run start via UPDATE...WHERE quota_used < quota_limit RETURNING id | Prevents race condition with concurrent runs; rolled back (decremented) if run ends as failed |
| 2 | notify step implemented via Hasura Event Trigger on notifications table INSERT | Original spec mandates Event Trigger; keeps outbound call async and outside the synchronous Action handler |
| 3 | UNIQUE(workflow_id) constraint on workflow_triggers | Enforces one trigger per workflow at DB level, mirrors the "attach one trigger" UI constraint |
| 4 | started_by in workflow_runs is nullable FK to auth.users | Nullable to support system-initiated runs (webhook, scheduled, db_event) where no user pressed a button |
| 5 | db_write step restriction is authoring-time only | Non-owner roles can still trigger runs that contain a db_write step added by an owner |
| 6 | viewer role blocked from approveStep explicitly in Action handler | Role table implies it; Layer 2 must enforce it server-side — cannot rely on UI hiding the button |
| 7 | org_usage_this_month Postgres view is mandatory | Required to power quota indicator; avg_run_duration is optional supplement only |

---

## Architecture Snapshot

```
nhost (cloud)
├── PostgreSQL
│   ├── organizations          (quota_limit, quota_used, quota_period_start)
│   ├── org_members            (org_id, user_id, role: owner|editor|viewer)
│   ├── workflows              (org_id, name, created_by -> org_members)
│   ├── workflow_steps         (workflow_id, step_order, type enum, config jsonb)
│   ├── workflow_triggers      (workflow_id UNIQUE, type, config jsonb)
│   ├── workflow_runs          (workflow_id, status, started_by nullable -> auth.users)
│   ├── step_runs              (workflow_run_id, workflow_step_id, status, input, output,
│   │                           error, attempt_count, approved_by, approved_at)
│   └── notifications          (step_run_id, channel, payload, sent_at)
│
├── Hasura GraphQL Engine
│   ├── Layer 1 permissions    (row-level: org_members join on every table)
│   ├── Relationships          (org->members->workflows->steps/triggers, workflow->runs->step_runs)
│   ├── Actions
│   │   ├── triggerWorkflowRun(workflow_id) -> workflow_run_id
│   │   ├── approveStep(step_run_id) -> Boolean
│   │   └── startWorkflowViaWebhook(workflow_id, payload) -> workflow_run_id
│   ├── Event Triggers
│   │   ├── on notifications INSERT -> outbound Slack/email handler
│   │   └── on <watched_table> row change -> startWorkflowViaWebhook (db_event trigger)
│   ├── Scheduled Events       (cron -> triggerWorkflowRun for scheduled trigger type)
│   └── Computed field         org_usage_this_month view on organizations
│
└── nhost Auth                 (JWT with X-Hasura-User-Id, X-Hasura-Role session vars)

Next.js (Vercel)
├── /login                     nhost auth
├── /dashboard                 org context switcher, quota indicator
├── /workflows                 list + create
├── /workflows/[id]            builder (steps + trigger config)
├── /workflows/[id]/runs/[id]  live run view (subscription)
└── /debug                     adversarial ID-guessing test page (Slice 3+)
```

---

## Step Type Reference

| Type | Owner-only to add | Retry | Async via Event Trigger |
|---|---|---|---|
| llm_call | No | Yes (min 1) | No |
| http_request | No | Yes (min 1) | No |
| db_write | Yes | No | No |
| notify | Yes | No | Yes (notifications table) |
| conditional_branch | No | No | No |
| approval_gate | No | No | No |

## Trigger Type Reference

| Type | Mechanism | Owner-only to add |
|---|---|---|
| manual | User clicks Run -> triggerWorkflowRun | No |
| webhook | Hasura Action as inbound HTTP endpoint | Yes |
| scheduled | Hasura Scheduled Event (cron) | No |
| db_event | Hasura Event Trigger on watched table | No |

---

## Slice Detail

### Slice 1 — Hello, Workflow
**Goal:** Full stack wired end-to-end. One org, one user, one workflow, two steps, runs to completion.

| Layer | Task |
|---|---|
| Schema | All 7 tables + migrations + seed Org A + 1 owner + 1 workflow (http_request -> llm_call stub) |
| Hasura | Track all tables, wire FK relationships, permissive owner-only permissions, expose triggerWorkflowRun Action |
| Backend | triggerWorkflowRun handler: look up steps -> create run row -> execute sequentially -> write step_runs -> mark completed |
| Frontend | nhost login, org dashboard, workflow list, Run button, poll workflow_runs.status every 2s |

**Done signal:** Login as Org A owner -> click Run -> poll shows running -> then completed -> DB has 2 step_run rows with output filled in.

**Risk:** Hasura Action handler returns before DB writes are committed -> subscription will not fire. Fix: await all DB writes before returning.

---

### Slice 2 — Watch It Live + Approval Gate
**Goal:** Replace polling with real subscription. Add approval_gate pause/resume.

| Layer | Task |
|---|---|
| Schema | Confirm step_runs status enum includes paused, approved, rejected; confirm approved_by, approved_at columns |
| Hasura | Enable subscription on step_runs by workflow_run_id; define approveStep(step_run_id) Action |
| Backend | triggerWorkflowRun — add approval_gate pause logic (write paused, stop); approveStep — verify role (not viewer) + org, write approved, resume next steps |
| Frontend | useSubscription replacing poll; per-step status cards; Awaiting Approval banner; Approve button for owner/editor only |

**Done signal:** Run pauses on approval_gate -> click Approve -> remaining steps complete live with zero refresh.

**Risk:** Subscription does not reflect paused state — ensure every state transition is a committed DB write, not in-memory.

---

### Slice 3 — Two Orgs, Airtight Walls
**Goal:** Multi-tenant isolation, adversarially proven.

| Layer | Task |
|---|---|
| Schema | Seed Org B: 1 owner + 1 editor + 1 viewer + their own workflows/runs |
| Hasura | Tighten ALL table permissions: org_members join check on every select/insert/update/delete |
| Backend | Explicit org_members query in triggerWorkflowRun + approveStep; viewer blocked from triggering |
| Frontend | Org context switcher; /debug page for adversarial ID testing |

**Done signal:** Org B user gets empty results on Org A workflow list; direct UUID guessing returns 403/null.

**Risk:** Actions bypass Hasura row permissions -> must manually re-check org membership inside every Action handler.

---

### Slice 4 — Full Step Palette + Smart Branching
**Goal:** All 6 step types working. LLM output drives conditional_branch. notify via Event Trigger.

| Layer | Task |
|---|---|
| Schema | Add notifications table; add org_usage_this_month Postgres view |
| Hasura | Track notifications; Event Trigger on notifications INSERT; expose org_usage_this_month as computed field; Layer 2 column check blocking non-owners from adding db_write/notify steps |
| Backend | Extend step executor: real llm_call, http_request with retry, db_write, notify (insert -> Event Trigger), conditional_branch (evaluate condition -> set next step_order) |
| Frontend | Workflow builder: step type dropdown (6 options), JSON config textarea per step, up/down reorder; disable db_write/notify options for non-owner |

**Done signal:** llm_call -> conditional_branch -> branched path executes based on LLM output; notifications table row appears; Event Trigger log shows outbound call.

**Risk:** conditional_branch jumps to wrong step — compute next step_order from evaluated branch config, not array index.

---

### Slice 5 — Fire Without a Button + Quota Guard
**Goal:** Non-manual trigger wired. Atomic quota enforcement with rollback on failure.

| Layer | Task |
|---|---|
| Schema | Confirm quota fields in seed; set meaningful quota_limit values for testing |
| Hasura | startWorkflowViaWebhook(workflow_id, payload) Action (public endpoint, shared secret auth); optional Scheduled Event |
| Backend | Atomic quota check: UPDATE...WHERE quota_used < quota_limit RETURNING id; rollback: decrement on failed; webhook handler calls same core executor |
| Frontend | Trigger config section: webhook type shows inbound URL to copy; quota progress bar on dashboard; Quota exhausted state disables Run button |

**Done signal:** curl POST starts a run with no browser; quota bar increments; exhausting quota -> next run rejected before any step_run rows created.

**Risk:** Concurrent webhook calls bypass quota — atomic UPDATE is the only safe guard; SELECT+compare will race.

---

### Slice 6 — Final Task Ready — Ship It
**Goal:** All 6 acceptance criteria pass in one uninterrupted live walkthrough.

| Layer | Task |
|---|---|
| Schema | Final seed confirming both orgs; README with setup + env vars + LLM stub note |
| Hasura | hasura metadata export; full permission audit in GraphiQL with both org JWTs |
| Backend | ~1 page write-up (schema reasoning, Layer 1 vs 2, pause/resume); end-to-end smoke test |
| Frontend | Deploy to Vercel; org switcher working; record Final Task screen recording |

**Done signal:** All 6 PRD section 12 acceptance criteria pass live. Submit GitHub repo + hosted URL.

---

## Final Task Acceptance Criteria (PRD §12)

1. Two orgs exist, each with its own users/roles
2. Org A owner builds a workflow with >= 3 step types including llm_call, http_request, and a conditional_branch whose path changes based on the LLM actual output
3. The workflow starts two ways: manually AND via webhook or event trigger
4. An approval_gate step pauses the run; only an owner/editor in Org A can approve it forward
5. Live status streams step-by-step, no refresh, including the paused state, visible in the UI
6. Logged in as an Org B user: cannot see, trigger, or approve any Org A resource — including by directly guessing an Org A workflow_id/step_run_id

---

## Evaluation Priority (from original instructions)

1. Final Task passes, live — weighted above everything else
2. Cross-org isolation airtight — including adversarial direct ID guessing
3. Step-level permission gating in Action handler — not assumed or client-side
4. Retry/failure handling and quota enforcement — visible in attempt_count
5. Schema and Hasura relationship correctness
6. Code and documentation clarity (lowest — do not over-invest early)

> Correctness first, then speed. Earliest working submission wins, not just earliest.

---

## Submission

- GitHub repo link + hosted Next.js app URL
- Do not submit if any of the 6 Final Task acceptance criteria are broken

---

## Files in This Repo

| File | Purpose |
|---|---|
| prd.md | Full product requirements document (synced with original instructions) |
| context.md | This file — living project context, updated after every task |

---

## Change Log

| Date | Update |
|---|---|
| 2026-08-09 | PRD written and synced with original assignment instructions (9 irregularities fixed, 2 sections added) |
| 2026-08-09 | Build plan created — 6 horizontal slices defined |
| 2026-08-09 | context.md created from build plan |
