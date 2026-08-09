'use client'

import { useEffect, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { nhost, parseJwt } from '@/lib/nhost'
import { apolloClient } from '@/lib/apollo'
import { gql } from '@apollo/client'

const GET_WORKFLOW = gql`
  query GetWorkflow($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      name
      created_at
      trigger {
        type
        config
      }
      steps(order_by: { step_order: asc }) {
        id
        step_order
        type
        config
      }
      runs(order_by: { started_at: desc }, limit: 5) {
        id
        status
        started_at
        completed_at
      }
    }
  }
`

const TRIGGER_WORKFLOW = gql`
  mutation TriggerWorkflow($workflow_id: uuid!) {
    triggerWorkflowRun(workflow_id: $workflow_id) {
      workflow_run_id
    }
  }
`

interface Step {
  id: string
  step_order: number
  type: string
  config: Record<string, unknown>
}

interface Run {
  id: string
  status: string
  started_at: string
  completed_at: string | null
}

interface Workflow {
  id: string
  name: string
  created_at: string
  trigger: { type: string; config: Record<string, unknown> } | null
  steps: Step[]
  runs: Run[]
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#22c55e',
  running: '#3b82f6',
  paused: '#f59e0b',
  failed: '#ef4444',
  pending: '#6b7280',
}

export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [loading, setLoading] = useState(true)
  const [triggering, setTriggering] = useState(false)
  const [error, setError] = useState('')
  const [userRole, setUserRole] = useState<string>('')

  useEffect(() => {
    const token = nhost.auth.getAccessToken()
    if (!token) { router.replace('/login'); return }

    // Get role from JWT claims
    const decoded: any = parseJwt(token)
    const role = decoded?.['https://hasura.io/jwt/claims']?.['x-hasura-default-role'] ?? 'viewer'
    setUserRole(role)

    apolloClient
      .query<{ workflows_by_pk: Workflow }>({
        query: GET_WORKFLOW,
        variables: { id },
        fetchPolicy: 'network-only',
      })
      .then((res: any) => setWorkflow(res.data?.workflows_by_pk))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [id, router])

  async function handleRun() {
    if (!workflow) return
    setTriggering(true)
    setError('')
    try {
      const result: any = await apolloClient.mutate({
        mutation: TRIGGER_WORKFLOW,
        variables: { workflow_id: workflow.id },
      })

      if (result.errors?.length) throw new Error(result.errors[0].message)
      const runId = result.data?.triggerWorkflowRun?.workflow_run_id
      if (runId) {
        router.push(`/dashboard/workflows/${workflow.id}/runs/${runId}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTriggering(false)
    }
  }

  if (loading) return <Screen><p style={styles.muted}>Loading…</p></Screen>
  if (!workflow) return <Screen><p style={styles.errorText}>Workflow not found.</p></Screen>

  return (
    <Screen>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 }}>
        <div>
          <Link href="/dashboard" style={styles.back}>← Dashboard</Link>
          <h1 style={styles.heading}>{workflow.name}</h1>
          <p style={styles.muted}>Trigger: {workflow.trigger?.type ?? 'none'}</p>
        </div>
        {/* Run button hidden for viewer role */}
        {userRole !== 'viewer' && (
          <button
            id="run-btn"
            onClick={handleRun}
            disabled={triggering}
            style={styles.runBtn}
          >
            {triggering ? 'Starting…' : '▶ Run Workflow'}
          </button>
        )}
      </div>

      {error && <p style={styles.errorText}>{error}</p>}

      {/* Steps */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={styles.sectionTitle}>Steps</h2>
        <div style={styles.stepList}>
          {workflow.steps.map((step) => (
            <div key={step.id} style={styles.stepCard}>
              <span style={styles.stepNum}>{step.step_order}</span>
              <div>
                <div style={styles.stepType}>{step.type}</div>
                <pre style={styles.configPre}>{JSON.stringify(step.config, null, 2)}</pre>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Recent runs */}
      <section>
        <h2 style={styles.sectionTitle}>Recent Runs</h2>
        {workflow.runs.length === 0 && <p style={styles.muted}>No runs yet.</p>}
        <div style={styles.stepList}>
          {workflow.runs.map((run) => (
            <Link key={run.id} href={`/dashboard/workflows/${workflow.id}/runs/${run.id}`} style={styles.runRow}>
              <span style={{ ...styles.badge, background: STATUS_COLORS[run.status] ?? '#555' }}>
                {run.status}
              </span>
              <span style={styles.muted}>{new Date(run.started_at).toLocaleString()}</span>
              <span style={styles.muted}>→</span>
            </Link>
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
  heading: { color: '#fff', fontSize: 24, fontWeight: 700, margin: '4px 0' },
  sectionTitle: { color: '#aaa', fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  muted: { color: '#666', fontSize: 13 },
  back: { color: '#6366f1', fontSize: 13, textDecoration: 'none', display: 'block', marginBottom: 8 },
  errorText: { color: '#f87171', fontSize: 13 },
  runBtn: {
    background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8,
    padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  stepList: { display: 'flex', flexDirection: 'column', gap: 8 },
  stepCard: {
    background: '#1a1a1f', border: '1px solid #2a2a35', borderRadius: 8,
    padding: '14px 16px', display: 'flex', gap: 16, alignItems: 'flex-start',
  },
  stepNum: {
    background: '#2a2a35', borderRadius: 4, color: '#888',
    fontSize: 11, fontWeight: 700, padding: '2px 8px', flexShrink: 0,
  },
  stepType: { color: '#fff', fontWeight: 600, fontSize: 14, marginBottom: 4 },
  configPre: { color: '#666', fontSize: 11, margin: 0, whiteSpace: 'pre-wrap' },
  runRow: {
    background: '#1a1a1f', border: '1px solid #2a2a35', borderRadius: 8,
    padding: '12px 16px', textDecoration: 'none', display: 'flex',
    alignItems: 'center', gap: 12,
  },
  badge: { borderRadius: 4, color: '#fff', fontSize: 11, fontWeight: 600, padding: '2px 8px' },
}
