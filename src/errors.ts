/**
 * Debt E6: the single mapping from an error to user-readable text.
 * Four places each had their own ternary chain (GatewayError.detail / UpstreamError.message / String),
 * with inconsistent semantics too (the runner had no detail fallback, status did). One place from now on.
 */
import { GatewayError } from './gateway/client.js'
import { UpstreamError } from './upstream/rpc.js'

export const errorText = (error: unknown): string => {
  if (error instanceof GatewayError) return error.detail || error.message
  if (error instanceof UpstreamError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
