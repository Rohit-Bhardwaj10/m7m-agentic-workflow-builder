'use client'

// Slice 1: polling-based run status page
// Slice 2 will replace this with a real GraphQL subscription.

import { use, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { nhost } from '@/lib/nhost'
import { apolloClient } from '@/lib/apollo'
import { gql } from '@apollo/client'

const GET_RUN_STATUS = gql`
  query GetRunStatus($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
      status
      started_at
      completed_at
      workflow {
        id
        name
      }
      step_runs(order_by: { workflow_step: { step_order: asc } }) {
        id
        status
        attempt_count
        error
        output
        workflow_step {
          step_order
          type
        }
      }
    }
  }
`

interface StepRun {
  id: string
  status: string
  attempt_count: number
  error: string | null
  output: Record<string, unknown> | null
  workflow_step: { step_order: number; type: string }
}

interface RunData {
  id: string
  status: string
  started_at: string
  completed_at: string | null
  workflow: { id: string; name: string }
  step_runs: StepRun[]
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#22c55e',
  running: '#3b82f6',
  paused: '#f59e0b',
  failed: '#ef4444',
  pending: '#6b7280',
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'paused'])

export default function RunStatusPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>
}) {
  const { id: workflowId, runId } = use(params)
  const router = useRouter()
  const [run, setRun] = useState<RunData | null>(null)
  const [loading, setLoading] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const token = nhost.auth.getAccessToken()
    if (!token) { router.replace('/login'); return }

    async function fetchStatus() {
      const { data } = await apolloClient.query<{ workflow_runs_by_pk: RunData }>({
        query: GET_RUN_STATUS,
        variables: { runId },
        fetchPolicy: 'network-only',
      })
      const runData = data?.workflow_runs_by_pk
      setRun(runData || null)
      setLoading(false)

      // Stop polling when in a terminal state
      if (runData && TERMINAL_STATUSES.has(runData.status)) {
        if (intervalRef.current) clearInterval(intervalRef.current)
      }
    }

    fetchStatus()
    // Poll every 2s (replaced by subscription in Slice 2)
    intervalRef.current = setInterval(fetchStatus, 2000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [runId, router])

  if (loading) return <Screen><p style={styles.muted}>Loading run…</p></Screen>
  if (!run) return <Screen><p style={styles.errorText}>Run not found.</p></Screen>

  const isTerminal = TERMINAL_STATUSES.has(run.status)

  return (
    <Screen>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <Link href={`/dashboard/workflows/${workflowId}`} style={styles.back}>
          ← {run.workflow.name}
        </Link>
        <div style={styles.runHeader}>
          <h1 style={styles.heading}>Run Status</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{ ...styles.badge, background: STATUS_COLORS[run.status] ?? '#555', fontSize: 13, padding: '4px 12px' }}
            >
              {run.status}
            </span>
            {!isTerminal && (
              <span style={styles.polling}>● polling every 2s</span>
            )}
          </div>
        </div>
        <p style={styles.muted}>
          Started: {new Date(run.started_at).toLocaleString()}
          {run.completed_at && ` · Completed: ${new Date(run.completed_at).toLocaleString()}`}
        </p>
      </div>

      {/* Step runs */}
      <section>
        <h2 style={styles.sectionTitle}>Steps</h2>
        <div style={styles.stepList}>
          {run.step_runs.map((sr) => (
            <div key={sr.id} style={{ ...styles.stepCard, borderColor: STATUS_COLORS[sr.status] ?? '#2a2a35' }}>
              <div style={styles.stepLeft}>
                <span style={styles.stepNum}>{sr.workflow_step.step_order}</span>
                <span style={styles.stepType}>{sr.workflow_step.type}</span>
              </div>
              <div style={{ flex: 1 }}>
                <span style={{ ...styles.badge, background: STATUS_COLORS[sr.status] ?? '#555' }}>
                  {sr.status}
                </span>
                {sr.attempt_count > 1 && (
                  <span style={styles.attempts}> attempts: {sr.attempt_count}</span>
                )}
                {sr.error && (
                  <pre style={styles.errorPre}>{sr.error}</pre>
                )}
                {sr.output && sr.status === 'completed' && (
                  <pre style={styles.outputPre}>{JSON.stringify(sr.output, null, 2)}</pre>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </Screen>
  )
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: '100vh', background: '#0f0f11', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 24px' }}>{children}</div>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  heading: { color: '#fff', fontSize: 22, fontWeight: 700, margin: 0 },
  runHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  sectionTitle: { color: '#aaa', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  muted: { color: '#666', fontSize: 13 },
  back: { color: '#6366f1', fontSize: 13, textDecoration: 'none', display: 'block', marginBottom: 8 },
  polling: { color: '#f59e0b', fontSize: 12 },
  errorText: { color: '#f87171', fontSize: 13 },
  stepList: { display: 'flex', flexDirection: 'column', gap: 8 },
  stepCard: {
    background: '#1a1a1f', border: '1px solid', borderRadius: 8,
    padding: '14px 16px', display: 'flex', gap: 16, alignItems: 'flex-start',
  },
  stepLeft: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 },
  stepNum: { background: '#2a2a35', borderRadius: 4, color: '#888', fontSize: 11, fontWeight: 700, padding: '2px 8px' },
  stepType: { color: '#888', fontSize: 11 },
  badge: { borderRadius: 4, color: '#fff', fontSize: 11, fontWeight: 600, padding: '2px 8px' },
  attempts: { color: '#888', fontSize: 11, marginLeft: 8 },
  errorPre: { background: '#1f0f0f', border: '1px solid #3f1f1f', borderRadius: 6, color: '#f87171', fontSize: 11, marginTop: 8, padding: 10, whiteSpace: 'pre-wrap' },
  outputPre: { background: '#111116', border: '1px solid #2a2a35', borderRadius: 6, color: '#4ade80', fontSize: 11, marginTop: 8, padding: 10, whiteSpace: 'pre-wrap' },
}
