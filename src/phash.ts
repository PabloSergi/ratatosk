/**
 * A fingerprint of what a photograph looks like, rather than of its bytes.
 *
 * The same flat is advertised on three boards by the same agent. The text is rewritten each time, the
 * price is rounded differently, the address is spelt another way — but the photographs are the same
 * photographs, re-encoded and re-sized. Nothing else about a listing survives that trip, which is why
 * a picture is the one honest key for telling "this is the same flat" from "these are two flats".
 *
 * A byte hash is useless here: re-encoding changes every byte. So the image is reduced to almost
 * nothing — eight rows of nine grey pixels — and what is kept is whether each pixel is brighter than
 * the one to its right. That survives re-compression, re-sizing and mild cropping, and it differs
 * between two genuinely different rooms.
 *
 * This is a difference hash, and the choice is deliberate: an average hash calls every dim photograph
 * identical, and a DCT hash costs a great deal more for a gain nobody here can measure.
 */
import sharp from 'sharp';

/** Wide by one, so eight comparisons per row give eight bits. */
const WIDE = 9;
const TALL = 8;

/**
 * The hash of one image, as sixteen hex characters.
 *
 * Undefined rather than a throw when the bytes are not an image at all: a board serves the occasional
 * placeholder or half-written file, and one of those is not a reason to stop fetching a thousand more.
 */
export async function phash(bytes: Buffer | Uint8Array): Promise<string | undefined> {
  let grey: Buffer;
  try {
    grey = await sharp(bytes).greyscale().resize(WIDE, TALL, { fit: 'fill' }).raw().toBuffer();
  } catch {
    return undefined;
  }
  if (grey.length < WIDE * TALL) return undefined;

  const bits: number[] = [];
  for (let row = 0; row < TALL; row++) {
    for (let column = 0; column < WIDE - 1; column++) {
      const here = grey[row * WIDE + column]!;
      const next = grey[row * WIDE + column + 1]!;
      bits.push(here > next ? 1 : 0);
    }
  }

  let hex = '';
  for (let at = 0; at < bits.length; at += 4) {
    hex += ((bits[at]! << 3) | (bits[at + 1]! << 2) | (bits[at + 2]! << 1) | bits[at + 3]!).toString(16);
  }
  return hex;
}

/**
 * How far apart two fingerprints are, in bits.
 *
 * The service joins listings at a distance of eight or less. That number is not arbitrary: below it,
 * re-encodings of one photograph land; above it, two photographs of the same room from two angles
 * start to be called the same thing, and joining two different flats is worse than missing a join.
 */
export function distance(one: string, other: string): number {
  if (one.length !== other.length) return Number.MAX_SAFE_INTEGER;

  let apart = 0;
  for (let at = 0; at < one.length; at++) {
    let differing = parseInt(one[at]!, 16) ^ parseInt(other[at]!, 16);
    while (differing) {
      apart += differing & 1;
      differing >>= 1;
    }
  }
  return apart;
}
