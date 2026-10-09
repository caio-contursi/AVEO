// Both acceptance transports share the same narrow, immutable read/simulation allowlist.
export const FAULT_READ_METHODS = Object.freeze([
  'getMultipleAccounts', 'getAccountInfo', 'getSignatureStatuses', 'getTransaction',
  'getLatestBlockhash', 'simulateTransaction',
] as const)
