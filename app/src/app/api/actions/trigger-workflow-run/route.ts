import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { executeWorkflowSteps } from '@/lib/executor'

// ─────────────────────────────────────────────
// Hasura Action handler: triggerWorkflowRun
// ─────────────────────────────────────────────
// Called by Hasura when the frontend calls the triggerWorkflowRun mutation.
// Hasura forwards the request to this URL with the action payload + session vars.
//
// Slice 1: sequential execution only — no quota, no approval gate, no retry.
// Slice 2 will add: approval_gate pause, retry logic.
// Slice 3 will add: strict org membership check.
// Slice 5 will add: atomic quota check + rollback.

interface HasuraActionPayload {
  action: { name: string }
  input: { workflow_id: string }
  session_variables: {
    'x-hasura-user-id': string
    'x-hasura-role': string
    'x-hasura-org-id'?: string
  }
}

export async function POST(req: NextRequest) {
  let body: HasuraActionPayload

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ message: 'Invalid request body' }, { status: 400 })
  }

  const { workflow_id } = body.input
  const userId = body.session_variables['x-hasura-user-id']
  const role = body.session_variables['x-hasura-role']

  try {
    // 1. Load workflow + steps + organization members
    const workflow = await prisma.workflow.findUnique({
      where: { id: workflow_id },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
        org: {
          include: {
            members: {
              where: { userId }
            }
          }
        }
      },
    })

    if (!workflow) {
      return NextResponse.json({ message: 'Workflow not found.' }, { status: 404 })
    }

    // ── Slice 3: strict org membership check (Layer 2) ──────────────────────────
    const member = workflow.org.members[0]
    if (!member) {
      return NextResponse.json({ message: 'Access denied: You are not a member of this organization.' }, { status: 403 })
    }
    if (member.role === 'viewer') {
      return NextResponse.json({ message: 'Access denied: Viewers cannot trigger workflow runs.' }, { status: 403 })
    }

    // 2. Create workflow_run row (status = running)
    const run = await prisma.workflowRun.create({
      data: {
        workflowId: workflow_id,
        status: 'running',
        startedBy: userId,
      },
    })

    // 3. Execute steps using shared executor
    const initialOutput: Record<string, unknown> = {}
    // executeWorkflowSteps handles execution, pausing at approval_gate, and marking run completed/failed
    await executeWorkflowSteps(run.id, workflow.steps, initialOutput)

    // Return the workflow_run_id to Hasura (matches Action output type)
    return NextResponse.json({ workflow_run_id: run.id })
  } catch (err) {
    console.error('[triggerWorkflowRun] Unexpected error:', err)
    return NextResponse.json({ message: 'Internal server error.' }, { status: 500 })
  }
}
