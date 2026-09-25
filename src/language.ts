/**
 * The language a song is sung in, where the words alone cannot say: Taiwanese Hokkien is often
 * written in the same characters as Mandarin, and the app needs to know which to romanize it as.
 *
 * BCP 47 primary subtags: `zh` Mandarin, `nan` Hokkien, `yue` Cantonese.
 */

import type { Store } from './db.ts';

export const LANGUAGES = ['nan', 'zh', 'yue'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Where an answer came from. Only `tagged` exists yet; the others are what may follow it. */
export type LanguageSource = 'tagged' | 'detected' | 'musicbrainz' | 'wikidata';

export function isLanguage(value: unknown): value is Language {
  return (LANGUAGES as readonly unknown[]).includes(value);
}

/**
 * What the server knows about a track's language, or null for unknown.
 *
 * The admin's tag, on this key or on another key for the same recording (by ISRC). Anything added
 * later, a detector over the held lyrics included, comes after a tag and never overrides it.
 */
export function languageOf(
  store: Store,
  key: string,
  isrc?: string | null,
): { language: Language; source: LanguageSource } | null {
  const tag = store.languageTag(key, isrc);
  return tag ? { language: tag.language, source: 'tagged' } : null;
}
