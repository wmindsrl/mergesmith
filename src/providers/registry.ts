// Provider selection from config. Adding an engine = a new case here + its factory file.
import type { MergesmithConfig } from '../config.js';
import type { ImplementerProvider, VerifierProvider } from './types.js';
import { createCursorProvider } from './cursor.js';
import { createClaudeCodeProvider } from './claude-code.js';

export function getImplementer(config: MergesmithConfig): ImplementerProvider {
  switch (config.implementer.provider) {
    case 'cursor':
      return createCursorProvider({
        apiKeyEnv: config.implementer.apiKeyEnv,
        branchPrefix: config.implementer.branchPrefix,
        model: config.implementer.model,
      });
    default:
      throw new Error(`Implementer provider sconosciuto: "${config.implementer.provider}" (disponibili: cursor)`);
  }
}

export function getVerifier(config: MergesmithConfig): VerifierProvider {
  switch (config.verifier.provider) {
    case 'claude-code':
      return createClaudeCodeProvider({ command: config.verifier.command, repo: config.repo });
    default:
      throw new Error(`Verifier provider sconosciuto: "${config.verifier.provider}" (disponibili: claude-code)`);
  }
}
