-- =============================================
-- Seed: Org A with owner user + demo workflow
-- =============================================
-- NOTE: Replace the user_id UUIDs below with real nhost auth.users IDs
-- after creating users via nhost dashboard / signup.
-- These are placeholder UUIDs for local dev.

-- Org A
INSERT INTO organizations (id, name, quota_limit, quota_used)
VALUES ('00000000-0000-0000-0000-000000000001', 'Org A', 100, 0);

-- Org A owner (user_id must match a real nhost auth.users row)
INSERT INTO org_members (id, org_id, user_id, role)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000100',  -- placeholder: replace with real user_id
  'owner'
);

-- Demo workflow
INSERT INTO workflows (id, org_id, name, created_by)
VALUES (
  '00000000-0000-0000-0000-000000000020',
  '00000000-0000-0000-0000-000000000001',
  'Demo Workflow',
  '00000000-0000-0000-0000-000000000010'
);

-- Step 1: http_request
INSERT INTO workflow_steps (id, workflow_id, step_order, type, config)
VALUES (
  '00000000-0000-0000-0000-000000000030',
  '00000000-0000-0000-0000-000000000020',
  1,
  'http_request',
  '{"url": "https://httpbin.org/get", "method": "GET"}'
);

-- Step 2: llm_call (stubbed)
INSERT INTO workflow_steps (id, workflow_id, step_order, type, config)
VALUES (
  '00000000-0000-0000-0000-000000000031',
  '00000000-0000-0000-0000-000000000020',
  2,
  'llm_call',
  '{"prompt": "Summarize the previous step output in one sentence.", "stub": true}'
);

-- Trigger: manual
INSERT INTO workflow_triggers (workflow_id, type, config)
VALUES (
  '00000000-0000-0000-0000-000000000020',
  'manual',
  '{}'
);
