// nhost client — use @nhost/react's NhostClient (v3 stable SDK)
// @nhost/nhost-js v4 is a completely different auto-generated SDK with different auth APIs.
// We use v3 here because it is stable, has getAccessToken(), signIn(), getUser(), etc.
import { NhostClient } from '@nhost/react'

export const nhost: any = new NhostClient({
  subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN ?? 'local',
  region: process.env.NEXT_PUBLIC_NHOST_REGION ?? 'ap-south-1',
})

