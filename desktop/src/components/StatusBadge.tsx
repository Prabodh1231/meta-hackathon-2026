import type { CitationStatus } from '../types'

const LABELS: Record<CitationStatus, string> = {
  pending: 'checking…',
  verified: 'verified',
  weak: 'partial support',
  unsupported: 'unsupported',
  quote_not_found: 'quote not found',
}

export function StatusBadge({ status, text }: { status: CitationStatus; text?: string }) {
  return <span className={`badge badge-${status}`}>{text ?? LABELS[status]}</span>
}
