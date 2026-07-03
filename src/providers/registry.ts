// Provider selection from config. Adding an engine = a new case here + its factory file.
import type { MergesmithConfig } from '../config.js';
import { loadEnvVarOptional } from '../lib.js';
import type { ImplementerProvider, VerifierProvider } from './types.js';
import { createCursorProvider } from './cursor.js';
import { createClaudeCodeProvider } from './claude-code.js';

export function getImplementer(config: MergesmithConfig): ImplementerProvider {
  switch (config.implementer.provider) {
    case 'cursor':
      return createCursorProvider({
        apiKeyEnv: config.implementer.apiKeyEnv,
        branchPrefix: config.implementer.branchPrefix,
        // MERGESMITH_IMPLEMENTER_MODEL (env or .env.local) overrides the config default — quick swap.
        model: loadEnvVarOptional('MERGESMITH_IMPLEMENTER_MODEL') ?? config.implementer.model,
      });
    default:
      throw new Error(`Implementer provider sconosciuto: "${config.implementer.provider}" (disponibili: cursor)`);
  }
}

export function getVerifier(config: MergesmithConfig): VerifierProvider {
  switch (config.verifier.provider) {
    case 'claude-code':
      return createClaudeCodeProvider({
        command: config.verifier.command,
        repo: config.repo,
        // MERGESMITH_VERIFIER_MODEL (env or .env.local) overrides the config default — quick swap.
        model: loadEnvVarOptional('MERGESMITH_VERIFIER_MODEL') ?? config.verifier.model,
      });
    default:
      throw new Error(`Verifier provider sconosciuto: "${config.verifier.provider}" (disponibili: claude-code)`);
  }
}
