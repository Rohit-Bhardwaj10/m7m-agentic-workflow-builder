'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { nhost } from '@/lib/nhost'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Redirect if already logged in
  useEffect(() => {
    const token = nhost.auth.getAccessToken()
    if (token) router.replace('/dashboard')
  }, [router])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { error } = await nhost.auth.signIn({ email, password })
      if (error) {
        setError(error.message)
      } else {
        router.replace('/dashboard')
      }
    } catch (err) {
      setError('Unexpected error. Please try again.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>mini-n8n</h1>
        <p style={styles.subtitle}>AI Agent Workflow Builder</p>
        <form onSubmit={handleLogin} style={styles.form}>
          <label style={styles.label}>Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoFocus
            style={styles.input}
          />
          <label style={styles.label}>Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
            style={styles.input}
          />
          {error && <p style={styles.error}>{error}</p>}
          <button id="login-btn" type="submit" disabled={loading} style={styles.button}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0f0f11',
    fontFamily: 'system-ui, sans-serif',
  },
  card: {
    background: '#1a1a1f',
    border: '1px solid #2a2a35',
    borderRadius: 12,
    padding: '40px 36px',
    width: '100%',
    maxWidth: 400,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: 700,
    margin: 0,
  },
  subtitle: {
    color: '#888',
    fontSize: 14,
    margin: '6px 0 28px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  label: {
    color: '#aaa',
    fontSize: 13,
    fontWeight: 500,
  },
  input: {
    background: '#111116',
    border: '1px solid #2a2a35',
    borderRadius: 8,
    color: '#fff',
    fontSize: 15,
    padding: '10px 14px',
    outline: 'none',
  },
  button: {
    marginTop: 8,
    background: '#6366f1',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '12px 0',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    margin: 0,
  },
}
