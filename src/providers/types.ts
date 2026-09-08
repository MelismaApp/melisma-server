/**
 * What a lyrics source has to be able to do.
 *
 * Two things beyond fetching, both for the admin page: say what credentials it needs, and
 * be able to prove it can reach its service. The second matters more than it sounds — every
 * one of these endpoints is undocumented or borrowed, several will break when somebody
 * ships a change, and "which of my six sources stopped working" is otherwise a research
 * project.
 */

import type { Config, SecretName } from '../config.ts';
import type { LyricsDocument } from '../model.ts';
import type { TrackQuery } from '../match.ts';

export interface ProviderContext {
  config: Config;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface ProviderAnswer {
  doc: LyricsDocument;
  /** How confident the provider is that this is the right track, 0..1. */
  match: number;
  /** Exactly what came back, kept so a better merge can be run over it later. */
  raw: { body: string; contentType: string };
  note?: string;
}

export interface ProviderTest {
  ok: boolean;
  detail: string;
  ms?: number;
}

export interface Provider {
  id: string;
  label: string;
  description: string;
  /** Secrets without which this source cannot work at all. */
  requires: SecretName[];
  /** True when it can supply syllable timings, not just line timings. */
  wordLevel: boolean;
  isConfigured(config: Config): boolean;
  fetch(query: TrackQuery, ctx: ProviderContext): Promise<ProviderAnswer | null>;
  test(ctx: ProviderContext): Promise<ProviderTest>;

  /**
   * Reads an archived response back into a document, without the network.
   *
   * This is what makes an improved merge cheap: the raw bodies are already on disk, so a new
   * algorithm is a local recompute rather than thousands of requests to services that are
   * doing this for free. Every provider has to be able to do it, which is also a useful
   * constraint — it forces `fetch` to archive something self-contained.
   */
  reparse(body: string, contentType: string): LyricsDocument | null;
}
