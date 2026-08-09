import { ApolloClient, InMemoryCache, createHttpLink, split } from '@apollo/client'
import { setContext } from '@apollo/client/link/context'
import { GraphQLWsLink } from '@apollo/client/link/subscriptions'
import { createClient } from 'graphql-ws'
import { getMainDefinition } from '@apollo/client/utilities'
import { nhost } from './nhost'

const HASURA_URL = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL ?? ''
const HASURA_WS_URL = HASURA_URL.replace(/^https/, 'wss').replace(/^http/, 'ws')

// HTTP link
const httpLink = createHttpLink({ uri: HASURA_URL })

// Auth link — injects the nhost JWT into every request
const authLink = setContext(async (_, { headers }) => {
  const token = nhost.auth.getAccessToken()
  return {
    headers: {
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }
})

// WebSocket link for subscriptions
const wsLink = typeof window !== 'undefined'
  ? new GraphQLWsLink(
      createClient({
        url: HASURA_WS_URL,
        connectionParams: () => {
          const token = nhost.auth.getAccessToken()
          return token
            ? { headers: { Authorization: `Bearer ${token}` } }
            : {}
        },
      })
    )
  : null

// Split: subscriptions go over WS, everything else over HTTP
const splitLink =
  typeof window !== 'undefined' && wsLink
    ? split(
        ({ query }) => {
          const def = getMainDefinition(query)
          return def.kind === 'OperationDefinition' && def.operation === 'subscription'
        },
        wsLink,
        authLink.concat(httpLink)
      )
    : authLink.concat(httpLink)

export const apolloClient = new ApolloClient({
  link: splitLink,
  cache: new InMemoryCache(),
})
