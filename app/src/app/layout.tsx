import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'mini-n8n — AI Agent Workflow Builder',
  description: 'Chain AI agent steps with multi-tenant workflow automation.',
}

import { NhostProviderWrapper } from '@/components/NhostProviderWrapper'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, boxSizing: 'border-box' }}>
        <NhostProviderWrapper>{children}</NhostProviderWrapper>
      </body>
    </html>
  )
}
