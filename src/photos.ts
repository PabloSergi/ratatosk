/**
 * Where a scraper's photographs live, and what they look like.
 *
 * The fetching is a separate job — it runs for hours and has nothing to do with a run — but what it
 * leaves behind has to be answerable in one question, because whoever sends a batch of listings
 * onward needs the pictures of exactly those listings and nothing else.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Photos {
  /** File names inside this listing's directory, in the order the board gave them. */
  files: string[];
  /** A fingerprint per picture that could be read. Fewer than files when one would not decode. */
  phash: string[];
}

export function photosDirFor(scraper: string, id?: string): string {
  const root = join(process.env['RATATOSK_IMAGES'] ?? 'images', safe(scraper));
  return id ? join(root, safe(id)) : root;
}

/** What is on disk for these listings. A listing with no pictures yet is simply absent from the answer. */
export async function photosFor(scraper: string, ids: string[]): Promise<Record<string, Photos>> {
  const found: Record<string, Photos> = {};
  for (const id of ids) {
    try {
      const note = JSON.parse(await readFile(join(photosDirFor(scraper, id), 'photos.json'), 'utf8')) as Photos;
      if (Array.isArray(note.files) && note.files.length) found[id] = { files: note.files, phash: note.phash ?? [] };
    } catch {
      // No pictures for this one yet. Not an error: the fetch runs on its own clock.
    }
  }
  return found;
}

function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}
