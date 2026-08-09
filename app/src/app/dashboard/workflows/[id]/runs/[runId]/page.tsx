'use client'

// Slice 1: polling-based run status page
// Slice 2 will replace this with a real GraphQL subscription.

import { use, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { nhost } from '@/lib/nhost'
import { apolloClient } from '@/lib/apollo'
import { gql } from '@apollo/client'

const SUBSCRIBE_RUN_STATUS = gql`
  subscription SubscribeRunStatus($runId: uuid!) {
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

const APPROVE_STEP = gql`
  mutation ApproveStep($stepRunId: uuid!) {
    approveStep(step_run_id: $stepRunId) {
      success
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
  const [approvingStep, setApprovingStep] = useState<string | null>(null)
  const [userRole, setUserRole] = useState<string>('viewer')

  useEffect(() => {
    const token = nhost.auth.getAccessToken()
    if (!token) { router.replace('/login'); return }

    // Get role from JWT for optimistic UI (layer 2 blocks it anyway)
    import('@/lib/nhost').then(({parseJwt }) => {
      const decoded: any = parseJwt(token)
      setUserRole(decoded?.['https://hasura.io/jwt/claims']?.['x-hasura-default-role'] ?? 'viewer')
    })

    const subscription = apolloClient
      .subscribe<{ workflow_runs_by_pk: RunData }>({
        query: SUBSCRIBE_RUN_STATUS,
        variables: { runId },
      })
      .subscribe({
        next({ data }) {
          setRun(data?.workflow_runs_by_pk || null)
          setLoading(false)
        },
        error(err) {
          console.error('Subscription error:', err)
        },
      })

    return () => subscription.unsubscribe()
  }, [runId, router])

  const handleApprove = async (stepRunId: string) => {
    if (userRole === 'viewer') return alert('Viewers cannot approve steps.')
    setApprovingStep(stepRunId)
    try {
      const result: any = await apolloClient.mutate({
        mutation: APPROVE_STEP,
        variables: { stepRunId },
      })
      if (result.errors?.length) throw new Error(result.errors[0].message)
    } catch (err: any) {
      alert(`Approval failed: ${err.message}`)
    } finally {
      setApprovingStep(null)
    }
  }

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
            {!isTerminal && run.status !== 'paused' && (
              <span style={styles.polling}>● live updates</span>
            )}
            {run.status === 'paused' && (
              <span style={styles.awaiting}>Awaiting Approval</span>
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
                {sr.status === 'paused' && sr.workflow_step.type === 'approval_gate' && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      onClick={() => handleApprove(sr.id)}
                      disabled={approvingStep === sr.id || userRole === 'viewer'}
                      style={{ ...styles.approveBtn, opacity: (approvingStep === sr.id || userRole === 'viewer') ? 0.5 : 1 }}
                    >
                      {approvingStep === sr.id ? 'Approving...' : 'Approve Step'}
                    </button>
                    {userRole === 'viewer' && <span style={{ marginLeft: 8, fontSize: 11, color: '#f87171' }}>Viewers cannot approve</span>}
                  </div>
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
  awaiting: { color: '#f59e0b', fontSize: 12, fontWeight: 600, border: '1px solid #f59e0b', borderRadius: 4, padding: '2px 8px' },
  approveBtn: { background: '#10b981', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
}
