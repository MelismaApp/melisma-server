/**
 * Every source, and the rules for which get asked.
 *
 * They are asked in parallel rather than in turn, which is the difference between a track
 * resolving in one round trip and six. The order below only decides ties in the merge — it is
 * not a fallback chain, because a fallback chain stops at the first answer and the first
 * answer is rarely the best one.
 */

import type { Config } from '../config.ts';
import type { Provider } from './types.ts';
import { amll } from './amll.ts';
import { apple } from './apple.ts';
import { lrclib } from './lrclib.ts';
import { musixmatch } from './musixmatch.ts';
import { netease } from './netease.ts';
import { spotify } from './spotify.ts';

export const PROVIDERS: Provider[] = [apple, amll, netease, musixmatch, spotify, lrclib];

export function providerById(id: string): Provider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * The sources to ask for a lookup, in priority order.
 *
 * A source that is enabled but has no credentials is skipped rather than queried: it would
 * fail, and a failure the user cannot act on is worse than silence. The admin page is where
 * "why is Apple not answering" gets a real answer.
 */
export function activeProviders(config: Config): Provider[] {
  return PROVIDERS.filter((provider) => {
    const setting = config.providers[provider.id];
    if (!setting?.enabled) return false;
    return provider.isConfigured(config);
  }).sort(
    (a, b) => (config.providers[a.id]?.priority ?? 99) - (config.providers[b.id]?.priority ?? 99),
  );
}

export type { Provider, ProviderAnswer, ProviderContext, ProviderTest } from './types.ts';
