-- =============================================================
-- Slice 1 Migration: All 7 tables
-- =============================================================

-- Enums
CREATE TYPE role_type AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE step_type AS ENUM ('llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate');
CREATE TYPE trigger_type AS ENUM ('manual', 'webhook', 'scheduled', 'db_event');
CREATE TYPE run_status AS ENUM ('pending', 'running', 'paused', 'completed', 'failed');
CREATE TYPE step_status AS ENUM ('pending', 'running', 'paused', 'approved', 'rejected', 'completed', 'failed');

-- Organizations
CREATE TABLE organizations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  quota_limit         INTEGER NOT NULL DEFAULT 100,
  quota_used          INTEGER NOT NULL DEFAULT 0,
  quota_period_start  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Org Members (references nhost auth.users)
CREATE TABLE org_members (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL,
  role     role_type NOT NULL,
  UNIQUE(org_id, user_id)
);

-- Workflows
CREATE TABLE workflows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_by  UUID NOT NULL REFERENCES org_members(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workflow Steps
CREATE TABLE workflow_steps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_order   INTEGER NOT NULL,
  type         step_type NOT NULL,
  config       JSONB NOT NULL DEFAULT '{}'
);

-- Workflow Triggers (one per workflow — UNIQUE enforced)
CREATE TABLE workflow_triggers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  type         trigger_type NOT NULL,
  config       JSONB NOT NULL DEFAULT '{}',
  UNIQUE(workflow_id)
);

-- Workflow Runs
CREATE TABLE workflow_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status        run_status NOT NULL DEFAULT 'pending',
  started_by    UUID,  -- nullable: system-initiated runs have no user
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

-- Step Runs
CREATE TABLE step_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id   UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id  UUID NOT NULL REFERENCES workflow_steps(id),
  status            step_status NOT NULL DEFAULT 'pending',
  input             JSONB,
  output            JSONB,
  error             TEXT,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  approved_by       UUID,  -- FK to auth.users (nullable)
  approved_at       TIMESTAMPTZ
);

-- Notifications table (for notify step via Event Trigger in Slice 4)
CREATE TABLE notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  step_run_id  UUID NOT NULL REFERENCES step_runs(id),
  channel      TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  sent_at      TIMESTAMPTZ
);

-- Indexes for common query patterns
CREATE INDEX idx_org_members_user_id    ON org_members(user_id);
CREATE INDEX idx_org_members_org_id     ON org_members(org_id);
CREATE INDEX idx_workflows_org_id       ON workflows(org_id);
CREATE INDEX idx_workflow_steps_wf_id   ON workflow_steps(workflow_id, step_order);
CREATE INDEX idx_workflow_runs_wf_id    ON workflow_runs(workflow_id);
CREATE INDEX idx_step_runs_run_id       ON step_runs(workflow_run_id);

-- org_usage_this_month view (mandatory per PRD)
CREATE VIEW org_usage_this_month AS
SELECT
  w.org_id,
  COUNT(*) AS runs_this_month
FROM workflow_runs wr
JOIN workflows w ON w.id = wr.workflow_id
WHERE
  wr.started_at >= date_trunc('month', now())
  AND wr.status = 'completed'
GROUP BY w.org_id;
