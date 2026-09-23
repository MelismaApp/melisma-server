/**
 * Just enough protobuf to read one undocumented reply.
 *
 * Spotify's Canvas endpoint answers `application/protobuf` and publishes no `.proto`, so what
 * arrives is field numbers and wire types and nothing else. A generic reader is the honest shape for
 * that: it decodes the frame and leaves the meaning to whoever knows that field 2 is a URL.
 *
 * Deliberately not a protobuf library. No schemas, no `oneof`, no packed repeated fields, no
 * zig-zag decoding — none of which the one reply this exists for uses. Adding them speculatively
 * would be code with no reader to check it.
 */

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const FIXED32 = 5;

export interface Field {
  /** The wire type, so a reader can tell a number it can trust from bytes it cannot. */
  wire: number;
  /** A varint, or the bytes of a length-delimited or fixed-width field. */
  value: number | Uint8Array;
}

/** Field number to every value carried under it, in the order they arrived. */
export type Message = Map<number, Field[]>;

/**
 * Splits a message into its fields.
 *
 * Throws on anything it cannot account for. A reply that does not decode is not a reply with a
 * missing field — it is evidence the format changed or the body is not protobuf at all — and the
 * callers here treat those two cases differently.
 */
export function decode(input: Uint8Array): Message {
  const message: Message = new Map();
  let at = 0;

  const varint = (): number => {
    let value = 0;
    let scale = 1;
    // Ten bytes is the most a 64-bit varint can occupy, so an eleventh means the length prefix
    // that led us here was wrong and we are reading someone else's bytes.
    for (let read = 0; read < 10; read++) {
      if (at >= input.length) throw new Error('protobuf: a varint ran past the end');
      const byte = input[at++]!;
      // Multiplied rather than shifted: `<<` is 32-bit in JavaScript, so a varint past four bytes
      // would silently wrap. Past 2^53 this loses precision instead, which is why `integer` is only
      // ever pointed at small fields.
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 128;
    }
    throw new Error('protobuf: a varint longer than ten bytes');
  };

  const take = (length: number): Uint8Array => {
    if (length < 0 || at + length > input.length) {
      throw new Error('protobuf: a field ran past the end');
    }
    const slice = input.subarray(at, at + length);
    at += length;
    return slice;
  };

  while (at < input.length) {
    const tag = varint();
    // Divided rather than shifted, for the reason above: a field number near the protobuf maximum
    // puts the tag past 2^31, where `>>>` gives the wrong answer.
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error('protobuf: field number 0');

    let value: number | Uint8Array;
    switch (wire) {
      case VARINT:
        value = varint();
        break;
      case LENGTH:
        value = take(varint());
        break;
      // Kept as bytes rather than decoded into a number: nothing here reads one, and a fixed64 does
      // not fit a JavaScript number anyway. Consumed properly so an unknown field of this type
      // cannot derail the rest of the message.
      case FIXED64:
        value = take(8);
        break;
      case FIXED32:
        value = take(4);
        break;
      // 3 and 4 are the deprecated group encoding, which nothing has emitted for over a decade.
      default:
        throw new Error(`protobuf: wire type ${wire} is not supported`);
    }

    const existing = message.get(number);
    if (existing) existing.push({ wire, value });
    else message.set(number, [{ wire, value }]);
  }

  return message;
}

/** A length-delimited field as UTF-8. */
export function text(message: Message, field: number): string | null {
  const found = message.get(field)?.find((entry) => entry.wire === LENGTH);
  return found ? new TextDecoder().decode(found.value as Uint8Array) : null;
}

/** A varint field. Only a varint: a fixed-width field is not returned as a number. See `decode`. */
export function integer(message: Message, field: number): number | null {
  const found = message.get(field)?.find((entry) => entry.wire === VARINT);
  return found ? (found.value as number) : null;
}

/**
 * Every value under a field, read as a nested message.
 *
 * Skips the ones that do not decode rather than throwing. Without a `.proto` the caller is guessing
 * that a given field is a message, and a field that is really a string will not parse — refusing the
 * whole reply because one optional guess was wrong is worse than ignoring it.
 */
export function submessages(message: Message, field: number): Message[] {
  const found: Message[] = [];
  for (const entry of message.get(field) ?? []) {
    if (entry.wire !== LENGTH) continue;
    try {
      found.push(decode(entry.value as Uint8Array));
    } catch {
      // Not a message after all.
    }
  }
  return found;
}

export function submessage(message: Message, field: number): Message | null {
  return submessages(message, field)[0] ?? null;
}

/** A length-delimited field, ready to send. The only shape of field anything here writes. */
export function lengthDelimited(field: number, value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const header = [...varintBytes(field * 8 + LENGTH), ...varintBytes(bytes.length)];
  const out = new Uint8Array(header.length + bytes.length);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function varintBytes(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) throw new Error(`protobuf: cannot encode ${value}`);
  const bytes: number[] = [];
  let left = value;
  do {
    const byte = left % 128;
    left = Math.floor(left / 128);
    bytes.push(left > 0 ? byte | 0x80 : byte);
  } while (left > 0);
  return bytes;
}
