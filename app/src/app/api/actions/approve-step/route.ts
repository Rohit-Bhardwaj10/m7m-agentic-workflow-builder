import { prisma } from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'
import { executeWorkflowSteps } from '@/lib/executor'
import { Prisma } from '@prisma/client'

interface HasuraActionPayload {
  action: { name: string }
  input: { step_run_id: string }
  session_variables: {
    'x-hasura-user-id': string
    'x-hasura-role': string
  }
}

export async function POST(req: NextRequest) {
  let body: HasuraActionPayload

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ message: 'Invalid request body' }, { status: 400 })
  }

  const { step_run_id } = body.input
  const userId = body.session_variables['x-hasura-user-id']
  const role = body.session_variables['x-hasura-role']

  // 1. Check basic role (viewer cannot approve)
  if (role === 'viewer') {
    return NextResponse.json({ message: 'Viewers cannot approve steps.' }, { status: 403 })
  }

  try {
    // 2. Fetch the step run + workflow details
    const stepRun = await prisma.stepRun.findUnique({
      where: { id: step_run_id },
      include: {
        workflowStep: true,
        workflowRun: {
          include: {
            workflow: {
              include: {
                steps: { orderBy: { stepOrder: 'asc' } },
              },
            },
          },
        },
      },
    })

    if (!stepRun) {
      return NextResponse.json({ message: 'Step run not found.' }, { status: 404 })
    }

    if (stepRun.status !== 'paused' || stepRun.workflowStep.type !== 'approval_gate') {
      return NextResponse.json(
        { message: 'Step is not waiting for approval.' },
        { status: 400 }
      )
    }

    // 3. Mark step as approved
    await prisma.stepRun.update({
      where: { id: stepRun.id },
      data: {
        status: 'approved',
        approvedBy: userId,
        approvedAt: new Date(),
        output: stepRun.input ?? Prisma.JsonNull, // Pass input to output
      },
    })

    // 4. Mark workflow run as running
    const run = stepRun.workflowRun
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: 'running' },
    })

    // 5. Find remaining steps
    const currentStepOrder = stepRun.workflowStep.stepOrder
    const remainingSteps = run.workflow.steps.filter((s) => s.stepOrder > currentStepOrder)

    // 6. Resume execution asynchronously (don't block the HTTP response)
    // We pass the output of the approval gate (which is its input) as the initialOutput for the rest
    const initialOutput = (stepRun.input as Record<string, unknown>) ?? {}
    
    // Fire and forget so we don't block the Hasura Action
    executeWorkflowSteps(run.id, remainingSteps, initialOutput).catch((err) => {
      console.error('[approveStep] Error resuming execution:', err)
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[approveStep] Unexpected error:', err)
    return NextResponse.json({ message: 'Internal server error.' }, { status: 500 })
  }
}
