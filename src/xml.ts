/**
 * A small XML reader, because TTML is the only format here that needs one and pulling in
 * a general-purpose parser for it would be the server's only dependency.
 *
 * It reads into a tree rather than streaming events: TTML files are a few hundred KB at
 * most, and walking a tree makes the awkward part of the format — untimed annotation
 * spans sitting as siblings of timed ones — obvious instead of a state machine.
 *
 * Namespace prefixes are kept verbatim (`ttm:role`, not `role`), because that is how
 * every real file writes them and how the lookups below expect to find them. Where a
 * producer omits the prefix, the readers try both.
 */

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XChild[];
}

export type XChild = XNode | string;

export function isElement(child: XChild): child is XNode {
  return typeof child !== 'string';
}

/** The tag name without its namespace prefix. */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

/** An attribute by prefixed name, falling back to the bare local name. */
export function attr(node: XNode, ...names: string[]): string | undefined {
  for (const name of names) {
    const direct = node.attrs[name];
    if (direct !== undefined) return direct;
  }
  for (const name of names) {
    const bare = localName(name);
    for (const [key, value] of Object.entries(node.attrs)) {
      if (localName(key) === bare) return value;
    }
  }
  return undefined;
}

/** Direct children with the given local name. */
export function children(node: XNode, name: string): XNode[] {
  return node.children.filter(
    (c): c is XNode => isElement(c) && localName(c.name) === name,
  );
}

/** The first descendant with the given local name, breadth-first. */
export function find(node: XNode, name: string): XNode | undefined {
  const queue: XNode[] = [node];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of current.children) {
      if (!isElement(child)) continue;
      if (localName(child.name) === name) return child;
      queue.push(child);
    }
  }
  return undefined;
}

/** All descendants with the given local name, in document order. */
export function findAll(node: XNode, name: string): XNode[] {
  const out: XNode[] = [];
  const walk = (current: XNode) => {
    for (const child of current.children) {
      if (!isElement(child)) continue;
      if (localName(child.name) === name) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/** Concatenated text of a node and everything under it. */
export function textOf(node: XNode): string {
  let out = '';
  for (const child of node.children) {
    out += isElement(child) ? textOf(child) : child;
  }
  return out;
}

// ---- reading --------------------------------------------------------------

export class XmlError extends Error {}

export function parseXml(source: string): XNode {
  const root: XNode = { name: '#document', attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let i = 0;

  const push = (child: XChild) => stack[stack.length - 1].children.push(child);

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      appendText(push, source.slice(i));
      break;
    }
    if (lt > i) appendText(push, source.slice(i, lt));

    // Declarations, comments and CDATA, in the order they are cheap to detect.
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const raw = source.slice(lt + 9, end < 0 ? source.length : end);
      // CDATA is literal by definition — no entity decoding.
      if (raw) push(raw);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      // A DOCTYPE may carry an internal subset in brackets, which can itself contain '>'.
      i = skipDoctype(source, lt);
      continue;
    }

    if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt);
      if (end < 0) throw new XmlError('unterminated closing tag');
      const name = source.slice(lt + 2, end).trim();
      // Tolerate a stray or mismatched close rather than refusing the file: a lyric with
      // one bad tag is still worth reading, and every caller already handles a null.
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
      i = end + 1;
      continue;
    }

    const tag = readTag(source, lt);
    const node: XNode = { name: tag.name, attrs: tag.attrs, children: [] };
    push(node);
    if (!tag.selfClosing) stack.push(node);
    i = tag.end;
  }

  const documentElement = root.children.find(isElement);
  if (!documentElement) throw new XmlError('no root element');
  return documentElement;
}

function appendText(push: (child: XChild) => void, raw: string): void {
  if (!raw) return;
  push(decodeEntities(raw));
}

function skipDoctype(source: string, from: number): number {
  let depth = 0;
  for (let i = from + 2; i < source.length; i++) {
    const ch = source[i];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '>' && depth <= 0) return i + 1;
  }
  return source.length;
}

interface Tag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  /** Index just past the '>'. */
  end: number;
}

function readTag(source: string, from: number): Tag {
  let i = from + 1;
  const nameStart = i;
  while (i < source.length && !/[\s/>]/.test(source[i])) i++;
  const name = source.slice(nameStart, i);
  const attrs: Record<string, string> = {};

  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) break;

    if (source[i] === '>') return { name, attrs, selfClosing: false, end: i + 1 };
    if (source[i] === '/') {
      const close = source.indexOf('>', i);
      return { name, attrs, selfClosing: true, end: close < 0 ? source.length : close + 1 };
    }

    const keyStart = i;
    while (i < source.length && !/[\s=/>]/.test(source[i])) i++;
    const key = source.slice(keyStart, i);
    while (i < source.length && /\s/.test(source[i])) i++;

    if (source[i] !== '=') {
      // A valueless attribute. Not legal XML, but harmless to accept.
      if (key) attrs[key] = '';
      continue;
    }
    i++;
    while (i < source.length && /\s/.test(source[i])) i++;

    const quote = source[i];
    if (quote === '"' || quote === "'") {
      const end = source.indexOf(quote, i + 1);
      const value = source.slice(i + 1, end < 0 ? source.length : end);
      attrs[key] = decodeEntities(value);
      i = end < 0 ? source.length : end + 1;
    } else {
      const valueStart = i;
      while (i < source.length && !/[\s/>]/.test(source[i])) i++;
      attrs[key] = decodeEntities(source.slice(valueStart, i));
    }
  }

  return { name, attrs, selfClosing: false, end: i };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// ---- writing --------------------------------------------------------------

export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;',
  );
}

export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}
