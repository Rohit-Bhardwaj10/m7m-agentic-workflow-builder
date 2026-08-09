'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { nhost } from '@/lib/nhost'
import { apolloClient } from '@/lib/apollo'
import { gql } from '@apollo/client'

const GET_WORKFLOWS = gql`
  query GetWorkflows {
    workflows(order_by: { created_at: desc }) {
      id
      name
      created_at
      trigger {
        type
      }
      runs(order_by: { started_at: desc }, limit: 1) {
        status
        started_at
      }
    }
  }
`

interface Workflow {
  id: string
  name: string
  created_at: string
  trigger: { type: string } | null
  runs: Array<{ status: string; started_at: string }>
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#22c55e',
  running: '#3b82f6',
  paused: '#f59e0b',
  failed: '#ef4444',
  pending: '#6b7280',
}

export default function DashboardPage() {
  const router = useRouter()
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [userEmail, setUserEmail] = useState('')

  useEffect(() => {
    const token = nhost.auth.getAccessToken()
    if (!token) {
      router.replace('/login')
      return
    }
    const user: any = nhost.auth.getUser()
    if (user?.email) {
      setUserEmail(user.email)
    } else if (user?.then) {
      user.then((res: any) => {
        if (res?.user?.email) setUserEmail(res.user.email)
      })
    }

    apolloClient
      .query<{ workflows: Workflow[] }>({ query: GET_WORKFLOWS, fetchPolicy: 'network-only' })
      .then((res: any) => setWorkflows(res.data?.workflows ?? []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [router])

  async function handleSignOut() {
    await nhost.auth.signOut()
    router.replace('/login')
  }

  return (
    <main style={styles.page}>
      {/* Navbar */}
      <nav style={styles.nav}>
        <span style={styles.brand}>mini-n8n</span>
        <div style={styles.navRight}>
          <span style={styles.email}>{userEmail}</span>
          <button id="signout-btn" onClick={handleSignOut} style={styles.signoutBtn}>
            Sign out
          </button>
        </div>
      </nav>

      {/* Content */}
      <div style={styles.content}>
        <h1 style={styles.heading}>Workflows</h1>

        {loading && <p style={styles.muted}>Loading…</p>}
        {error && <p style={styles.errorText}>Error: {error}</p>}

        {!loading && workflows.length === 0 && (
          <p style={styles.muted}>No workflows yet.</p>
        )}

        <div style={styles.grid}>
          {workflows.map((wf) => {
            const lastRun = wf.runs[0]
            const statusColor = lastRun ? STATUS_COLORS[lastRun.status] ?? '#6b7280' : '#3a3a45'

            return (
              <Link key={wf.id} href={`/dashboard/workflows/${wf.id}`} style={styles.card}>
                <div style={styles.cardHeader}>
                  <span style={styles.workflowName}>{wf.name}</span>
                  {lastRun && (
                    <span style={{ ...styles.badge, background: statusColor }}>
                      {lastRun.status}
                    </span>
                  )}
                </div>
                <div style={styles.cardMeta}>
                  <span>Trigger: {wf.trigger?.type ?? 'none'}</span>
                  {lastRun && (
                    <span>Last run: {new Date(lastRun.started_at).toLocaleString()}</span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      </div>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#0f0f11', fontFamily: 'system-ui, sans-serif' },
  nav: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 32px', height: 56, background: '#1a1a1f', borderBottom: '1px solid #2a2a35',
  },
  brand: { color: '#fff', fontWeight: 700, fontSize: 18 },
  navRight: { display: 'flex', alignItems: 'center', gap: 16 },
  email: { color: '#888', fontSize: 13 },
  signoutBtn: {
    background: 'transparent', border: '1px solid #2a2a35', borderRadius: 6,
    color: '#aaa', cursor: 'pointer', fontSize: 13, padding: '4px 12px',
  },
  content: { maxWidth: 900, margin: '0 auto', padding: '40px 24px' },
  heading: { color: '#fff', fontSize: 24, fontWeight: 700, marginBottom: 24 },
  grid: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: {
    background: '#1a1a1f', border: '1px solid #2a2a35', borderRadius: 10,
    padding: '18px 20px', textDecoration: 'none', display: 'block',
    transition: 'border-color 0.15s',
  },
  cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  workflowName: { color: '#fff', fontWeight: 600, fontSize: 15 },
  badge: { borderRadius: 4, color: '#fff', fontSize: 11, fontWeight: 600, padding: '2px 8px' },
  cardMeta: { color: '#666', fontSize: 12, display: 'flex', gap: 20 },
  muted: { color: '#555', fontSize: 14 },
  errorText: { color: '#f87171', fontSize: 14 },
}
