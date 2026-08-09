import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'

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

  // ── Slice 1: basic role check (owner/editor only) ──────────────────────────
  // Full org-membership verification added in Slice 3.
  if (role === 'viewer') {
    return NextResponse.json(
      { message: 'Viewers cannot trigger workflow runs.' },
      { status: 403 }
    )
  }

  try {
    // 1. Load workflow + steps ordered by step_order
    const workflow = await prisma.workflow.findUnique({
      where: { id: workflow_id },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
      },
    })

    if (!workflow) {
      return NextResponse.json({ message: 'Workflow not found.' }, { status: 404 })
    }

    // 2. Create workflow_run row (status = running)
    const run = await prisma.workflowRun.create({
      data: {
        workflowId: workflow_id,
        status: 'running',
        startedBy: userId,
      },
    })

    // 3. Execute each step sequentially
    let previousOutput: Record<string, unknown> = {}

    for (const step of workflow.steps) {
      // Create step_run row (status = running)
      const stepRun = await prisma.stepRun.create({
        data: {
          workflowRunId: run.id,
          workflowStepId: step.id,
          status: 'running',
          input: previousOutput as Prisma.InputJsonValue,
          attemptCount: 1,
        },
      })

      let output: Record<string, unknown> = {}
      let error: string | null = null
      let status: 'completed' | 'failed' = 'completed'

      try {
        const config = step.config as Record<string, unknown>
        output = await executeStep(step.type, config, previousOutput)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        status = 'failed'
      }

      // Update step_run with result
      await prisma.stepRun.update({
        where: { id: stepRun.id },
        data: { status, output: output as Prisma.InputJsonValue, error },
      })

      if (status === 'failed') {
        // Fail the whole run on first step failure (retry added in Slice 2)
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: { status: 'failed', completedAt: new Date() },
        })
        return NextResponse.json(
          { message: `Step ${step.stepOrder} failed: ${error}` },
          { status: 500 }
        )
      }

      previousOutput = output
    }

    // 4. Mark run as completed
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: 'completed', completedAt: new Date() },
    })

    // Return the workflow_run_id to Hasura (matches Action output type)
    return NextResponse.json({ workflow_run_id: run.id })
  } catch (err) {
    console.error('[triggerWorkflowRun] Unexpected error:', err)
    return NextResponse.json({ message: 'Internal server error.' }, { status: 500 })
  }
}

// ─────────────────────────────────────────────
// Step executor (Slice 1: http_request + llm_call stub only)
// ─────────────────────────────────────────────

async function executeStep(
  type: string,
  config: Record<string, unknown>,
  previousOutput: Record<string, unknown>
): Promise<Record<string, unknown>> {
  switch (type) {
    case 'http_request':
      return executeHttpRequest(config)

    case 'llm_call':
      return executeLlmCall(config, previousOutput)

    default:
      // Remaining step types implemented in Slice 4
      throw new Error(`Step type "${type}" is not yet implemented in this slice.`)
  }
}

// http_request: call any external URL
async function executeHttpRequest(
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const url = config.url as string
  const method = (config.method as string | undefined) ?? 'GET'
  const headers = (config.headers as Record<string, string> | undefined) ?? {}
  const bodyData = config.body

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(bodyData ? { body: JSON.stringify(bodyData) } : {}),
  })

  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }

  return { status: res.status, body: json }
}

// llm_call: real call or disclosed stub
async function executeLlmCall(
  config: Record<string, unknown>,
  previousOutput: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const isStub = config.stub === true

  if (isStub || !process.env.GROQ_API_KEY) {
    // Stub: artificial 1s delay + fixed response (disclosed in README)
    await new Promise((r) => setTimeout(r, 1000))
    return {
      stub: true,
      model: 'stub',
      content: `[STUB] Summarized: ${JSON.stringify(previousOutput).slice(0, 100)}`,
    }
  }

  // Real Groq call
  const prompt = (config.prompt as string) ?? 'Summarize the input.'
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        {
          role: 'user',
          content: `${prompt}\n\nContext: ${JSON.stringify(previousOutput)}`,
        },
      ],
      max_tokens: 256,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Groq API error ${res.status}: ${err}`)
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>
    model: string
  }
  return {
    stub: false,
    model: data.model,
    content: data.choices[0]?.message?.content ?? '',
  }
}
