import { DeskError, type EligibilityBackend } from '@aveo/contracts';

// Placeholder until gate A (official MPL-3643 access and tests) passes.
export const mplBackend: EligibilityBackend = {
  id: 'mpl3643',
  capabilities: () => [],
  inspect: async () => {
    throw new DeskError('BackendNotIntegrated');
  },
  planTransfer: async () => {
    throw new DeskError('BackendNotIntegrated');
  },
  verifyOutcome: async () => {
    throw new DeskError('BackendNotIntegrated');
  },
};
