import { ClientConfig } from '../types';

/**
 * Per-client rate limit configuration.
 * In production this would live in a database or config service.
 * Easily extended by adding entries here — no code changes elsewhere required.
 */
const clientConfigs: Record<string, ClientConfig> = {
  'client-1': {
    clientId: 'client-1',
    limit: 5,
    windowMs: 10_000, // 5 req / 10 s  — tight, easy to trigger in demos
    drainRate: 1,     // leaky bucket drains 1 req per windowMs
  },
  'client-2': {
    clientId: 'client-2',
    limit: 10,
    windowMs: 10_000, // 10 req / 10 s
    drainRate: 2,
  },
  'client-premium': {
    clientId: 'client-premium',
    limit: 100,
    windowMs: 10_000, // 100 req / 10 s — premium tier
    drainRate: 10,
  },
  'client-free': {
    clientId: 'client-free',
    limit: 2,
    windowMs: 10_000, // 2 req / 10 s — free tier, very restricted
    drainRate: 1,
  },
};

export function getClientConfig(clientId: string): ClientConfig | null {
  return clientConfigs[clientId] ?? null;
}

export function getAllClientConfigs(): Record<string, ClientConfig> {
  return { ...clientConfigs };
}
