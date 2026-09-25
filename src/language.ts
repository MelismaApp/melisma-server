/**
 * The language a song is sung in, where the words alone cannot say: Taiwanese Hokkien is often
 * written in the same characters as Mandarin, and the app needs to know which to romanize it as.
 *
 * BCP 47 primary subtags: `zh` Mandarin, `nan` Hokkien, `yue` Cantonese.
 */

import type { Store } from './db.ts';
import { isHokkien } from './hokkien.ts';
import type { LyricsDocument } from './model.ts';

export const LANGUAGES = ['nan', 'zh', 'yue'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Where an answer came from. `musicbrainz` and `wikidata` are reserved, and nothing sets them yet. */
export type LanguageSource = 'tagged' | 'detected' | 'musicbrainz' | 'wikidata';

export function isLanguage(value: unknown): value is Language {
  return (LANGUAGES as readonly unknown[]).includes(value);
}

/**
 * What the server knows about a track's language, or null for unknown.
 *
 * The admin's tag, on this key or on another key for the same recording (by ISRC), and otherwise
 * the Hokkien detector over the lyrics: `document` when the caller has it, else the cached one. The
 * detector only ever says Hokkien; a song it does not flag is unknown, not Mandarin.
 */
export function languageOf(
  store: Store,
  key: string,
  isrc?: string | null,
  document?: LyricsDocument | null,
): { language: Language; source: LanguageSource } | null {
  const tag = store.languageTag(key, isrc);
  if (tag) return { language: tag.language, source: 'tagged' };
  const lines = (document ?? cachedDocument(store, key))?.lines.map((line) => line.text) ?? [];
  return lines.length > 0 && isHokkien(lines) ? { language: 'nan', source: 'detected' } : null;
}

function cachedDocument(store: Store, key: string): LyricsDocument | null {
  const merged = store.getEntry(key)?.merged;
  if (!merged) return null;
  try {
    return JSON.parse(merged) as LyricsDocument;
  } catch {
    return null;
  }
}
