import { prisma } from '@/lib/prisma'
import { Prisma, WorkflowStep } from '@prisma/client'

export async function executeWorkflowSteps(
  runId: string,
  steps: WorkflowStep[],
  initialOutput: Record<string, unknown>
) {
  let previousOutput = initialOutput

  for (const step of steps) {
    if (step.type === 'approval_gate') {
      // Create paused step run
      await prisma.stepRun.create({
        data: {
          workflowRunId: runId,
          workflowStepId: step.id,
          status: 'paused',
          input: previousOutput as Prisma.InputJsonValue,
          attemptCount: 1,
        },
      })
      // Pause workflow run
      await prisma.workflowRun.update({
        where: { id: runId },
        data: { status: 'paused' },
      })
      return // Pause execution
    }

    // Normal step execution
    const stepRun = await prisma.stepRun.create({
      data: {
        workflowRunId: runId,
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
      // Fail the whole run on first step failure
      await prisma.workflowRun.update({
        where: { id: runId },
        data: { status: 'failed', completedAt: new Date() },
      })
      return // Stop execution
    }

    previousOutput = output
  }

  // All steps finished
  await prisma.workflowRun.update({
    where: { id: runId },
    data: { status: 'completed', completedAt: new Date() },
  })
}

// ─────────────────────────────────────────────
// Step executor
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
      throw new Error(`Step type "${type}" is not yet implemented in this slice.`)
  }
}

async function executeHttpRequest(config: Record<string, unknown>): Promise<Record<string, unknown>> {
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

async function executeLlmCall(config: Record<string, unknown>, previousOutput: Record<string, unknown>): Promise<Record<string, unknown>> {
  const isStub = config.stub === true
  if (isStub || !process.env.GROQ_API_KEY) {
    await new Promise((r) => setTimeout(r, 1000))
    return {
      stub: true,
      model: 'stub',
      content: `[STUB] Summarized: ${JSON.stringify(previousOutput).slice(0, 100)}`,
    }
  }

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
        { role: 'user', content: `${prompt}\n\nContext: ${JSON.stringify(previousOutput)}` },
      ],
      max_tokens: 256,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Groq API error ${res.status}: ${err}`)
  }

  const data = await res.json() as any
  return {
    stub: false,
    model: data.model,
    content: data.choices[0]?.message?.content ?? '',
  }
}
