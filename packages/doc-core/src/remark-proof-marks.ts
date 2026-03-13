/**
 * remark plugin + stringify handler for Proof mark spans.
 *
 * Parses inline <span data-proof="...">...</span> HTML into mdast nodes
 * and serializes proofMark nodes back to HTML spans.
 */

type ProofMarkNode = {
  type: 'proofMark';
  proof: string;
  attrs?: Record<string, string | null | undefined>;
  children?: Array<{ type: string; value?: string; children?: any[] }>;
};

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  [key: string]: unknown;
};

type MdastParent = {
  children: MdastNode[];
};

function isProofHtml(value: string): boolean {
  return value.includes('<span') && value.includes('data-proof');
}

function parseAttributes(input: string): Record<string, string> | null {
  const attrs: Record<string, string> = {};
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    let name = '';
    while (i < input.length && /[^\s=]/.test(input[i])) {
      name += input[i];
      i++;
    }
    if (!name) return null;

    while (i < input.length && /\s/.test(input[i])) i++;

    let value = '';
    if (input[i] === '=') {
      i++;
      while (i < input.length && /\s/.test(input[i])) i++;
      const quote = input[i];
      if (quote === '"' || quote === '\'') {
        i++;
        while (i < input.length && input[i] !== quote) {
          value += input[i];
          i++;
        }
        if (input[i] !== quote) return null;
        i++;
      } else {
        while (i < input.length && /[^\s]/.test(input[i])) {
          value += input[i];
          i++;
        }
      }
    }

    attrs[name] = value;
  }

  return attrs;
}

function parseProofHtml(value: string): MdastNode[] | null {
  const root: MdastNode[] = [];
  const stack: ProofMarkNode[] = [];

  const pushNode = (node: MdastNode) => {
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children = parent.children ?? [];
      parent.children.push(node);
    } else {
      root.push(node);
    }
  };

  let i = 0;
  while (i < value.length) {
    const nextLt = value.indexOf('<', i);
    if (nextLt === -1) {
      const text = value.slice(i);
      if (text) pushNode({ type: 'text', value: text });
      break;
    }

    if (nextLt > i) {
      const text = value.slice(i, nextLt);
      if (text) pushNode({ type: 'text', value: text });
      i = nextLt;
    }

    if (value.startsWith('</span', i)) {
      const end = value.indexOf('>', i);
      if (end === -1) return null;
      if (stack.length === 0) return null;
      stack.pop();
      i = end + 1;
      continue;
    }

    if (value.startsWith('<span', i)) {
      const end = value.indexOf('>', i);
      if (end === -1) return null;
      const attrSource = value.slice(i + 5, end).trim();
      const attrs = parseAttributes(attrSource);
      if (!attrs) return null;
      const proof = attrs['data-proof'];
      if (!proof) return null;
      const proofId = proof === 'authored'
        ? (attrs['data-proof-id'] ?? attrs['data-id'])
        : attrs['data-id'];

      const proofNode: ProofMarkNode = {
        type: 'proofMark',
        proof,
        attrs: {
          id: proofId,
          by: attrs['data-by'],
          kind: attrs['data-kind'],
        },
        children: [],
      };

      pushNode(proofNode as MdastNode);
      stack.push(proofNode);
      i = end + 1;
      continue;
    }

    // Handle <code>...</code> inside proof spans (backwards compat)
    if (value.startsWith('<code>', i)) {
      const codeStart = i + 6;
      const codeEnd = value.indexOf('</code>', codeStart);
      if (codeEnd === -1) return null;
      pushNode({ type: 'inlineCode', value: value.slice(codeStart, codeEnd) });
      i = codeEnd + 7;
      continue;
    }

    // Handle <strong>...</strong>, <em>...</em>, <del>...</del>
    const htmlTagMatch = value.slice(i).match(/^<(strong|em|del)>/i);
    if (htmlTagMatch) {
      const tagName = htmlTagMatch[1].toLowerCase();
      const closeTag = `</${tagName}>`;
      const contentStart = i + htmlTagMatch[0].length;
      const closeIdx = value.indexOf(closeTag, contentStart);
      if (closeIdx === -1) return null;
      const inner = value.slice(contentStart, closeIdx);
      const mdastType = tagName === 'strong' ? 'strong' : tagName === 'em' ? 'emphasis' : 'delete';
      // Recursively parse inner content
      const innerParsed = parseProofHtml(inner);
      pushNode({ type: mdastType, children: innerParsed ?? [{ type: 'text', value: inner }] });
      i = closeIdx + closeTag.length;
      continue;
    }

    return null;
  }

  if (stack.length > 0) return null;
  return root;
}

type ProofSpanToken =
  | { type: 'open'; proof: string; attrs: Record<string, string | null | undefined> }
  | { type: 'close' };

function parseProofSpanToken(value: string): ProofSpanToken | null {
  const trimmed = value.trim();
  if (/^<\/span\s*>$/i.test(trimmed)) {
    return { type: 'close' };
  }

  const openMatch = trimmed.match(/^<span\b([^>]*)>$/i);
  if (!openMatch) return null;

  const attrs = parseAttributes(openMatch[1].trim());
  if (!attrs) return null;
  const proof = attrs['data-proof'];
  if (!proof) return null;
  const proofId = proof === 'authored'
    ? (attrs['data-proof-id'] ?? attrs['data-id'])
    : attrs['data-id'];

  return {
    type: 'open',
    proof,
    attrs: {
      id: proofId,
      by: attrs['data-by'],
      kind: attrs['data-kind'],
    },
  };
}

function normalizeSplitProofSpans(parent: MdastParent): void {
  const { children } = parent;
  const stack: ProofMarkNode[] = [];
  let i = 0;

  while (i < children.length) {
    const child = children[i];
    if (child.type === 'html' && typeof child.value === 'string') {
      const token = parseProofSpanToken(child.value);
      if (token?.type === 'open') {
        const proofNode: ProofMarkNode = {
          type: 'proofMark',
          proof: token.proof,
          attrs: token.attrs,
          children: [],
        };

        const current = stack[stack.length - 1];
        if (current) {
          current.children = current.children ?? [];
          current.children.push(proofNode as MdastNode);
          children.splice(i, 1);
        } else {
          children.splice(i, 1, proofNode as MdastNode);
          i += 1;
        }

        stack.push(proofNode);
        continue;
      }

      if (token?.type === 'close') {
        if (stack.length > 0) {
          stack.pop();
          children.splice(i, 1);
          continue;
        }
      }
    }

    if (stack.length > 0) {
      const current = stack[stack.length - 1];
      current.children = current.children ?? [];
      current.children.push(child);
      children.splice(i, 1);
      continue;
    }
    i += 1;
  }
}

/**
 * Post-process proofMark children to convert legacy HTML formatting nodes
 * (e.g. <code>...</code>, <strong>...</strong>) into proper mdast nodes.
 * This provides backwards compatibility with files serialized before the
 * markdown-output fix.
 */
function normalizeHtmlFormattingInProofMarks(node: MdastNode): void {
  if (!node.children) return;
  for (const child of node.children) {
    if (child.type === 'proofMark' && child.children) {
      child.children = convertHtmlFormatting(child.children);
      normalizeHtmlFormattingInProofMarks(child);
    } else {
      normalizeHtmlFormattingInProofMarks(child);
    }
  }
}

function convertHtmlFormatting(children: MdastNode[]): MdastNode[] {
  const result: MdastNode[] = [];
  let i = 0;
  while (i < children.length) {
    const child = children[i];
    if (child.type === 'html' && typeof child.value === 'string') {
      const tag = child.value.trim();

      // Match <code>, <strong>, <em>, <del>
      const openMatch = tag.match(/^<(code|strong|em|del)>$/i);
      if (openMatch) {
        const tagName = openMatch[1].toLowerCase();
        const closeTag = `</${tagName}>`;
        // Collect content until closing tag
        const inner: MdastNode[] = [];
        let j = i + 1;
        let found = false;
        while (j < children.length) {
          const c = children[j];
          if (c.type === 'html' && typeof c.value === 'string' && c.value.trim().toLowerCase() === closeTag) {
            found = true;
            break;
          }
          inner.push(c);
          j++;
        }
        if (found) {
          if (tagName === 'code') {
            // Combine inner text into a single inlineCode node
            const text = inner.map(n => n.value ?? '').join('');
            result.push({ type: 'inlineCode', value: text });
          } else {
            // strong, em, del — wrap inner nodes
            const mdastType = tagName === 'strong' ? 'strong' : tagName === 'em' ? 'emphasis' : 'delete';
            result.push({ type: mdastType, children: convertHtmlFormatting(inner) });
          }
          i = j + 1; // skip past closing tag
          continue;
        }
      }
    }
    result.push(child);
    i++;
  }
  return result;
}

function visit(node: MdastNode): void {
  if (!node.children) return;
  normalizeSplitProofSpans(node as MdastParent);
  normalizeHtmlFormattingInProofMarks(node);
  const children = node.children;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'html' && typeof child.value === 'string' && isProofHtml(child.value)) {
      const parsed = parseProofHtml(child.value);
      if (parsed) {
        children.splice(i, 1, ...parsed);
        i += parsed.length - 1;
        continue;
      }
    }

    if (child.children) {
      visit(child);
    }
  }
}

export function remarkProofMarks() {
  return (tree: MdastNode) => {
    visit(tree);
  };
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInlineNodes(nodes?: MdastNode[]): string {
  if (!nodes || nodes.length === 0) return '';
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(node: MdastNode): string {
  switch (node.type) {
    case 'text':
      return node.value ?? '';
    case 'strong':
      return `**${renderInlineNodes(node.children)}**`;
    case 'emphasis':
      return `*${renderInlineNodes(node.children)}*`;
    case 'delete':
      return `~~${renderInlineNodes(node.children)}~~`;
    case 'inlineCode': {
      const val = node.value ?? '';
      // Use double backticks if value contains a backtick
      if (val.includes('`')) return `\`\` ${val} \`\``;
      return `\`${val}\``;
    }
    case 'link': {
      const href = String((node as MdastNode & { url?: string }).url ?? '');
      const text = renderInlineNodes(node.children);
      return `[${text}](${href})`;
    }
    case 'image': {
      const src = String((node as MdastNode & { url?: string }).url ?? '');
      const alt = String((node as MdastNode & { alt?: string }).alt ?? '');
      return `![${alt}](${src})`;
    }
    case 'break':
      return `\\\n`;
    case 'html':
      return typeof node.value === 'string' ? node.value : '';
    case 'proofMark':
      return renderProofMarkNode(node as ProofMarkNode);
    default:
      if (node.children && node.children.length > 0) {
        return renderInlineNodes(node.children);
      }
      return node.value ?? '';
  }
}

function renderProofMarkNode(node: ProofMarkNode): string {
  const proof = node.proof || 'comment';
  const attrs = node.attrs ?? {};
  const parts: string[] = [];

  parts.push(`data-proof="${escapeAttr(proof)}"`);

  if (attrs.id) {
    parts.push(
      proof === 'authored'
        ? `data-proof-id="${escapeAttr(String(attrs.id))}"`
        : `data-id="${escapeAttr(String(attrs.id))}"`,
    );
  }
  if (attrs.by) {
    parts.push(`data-by="${escapeAttr(String(attrs.by))}"`);
  }
  if (proof === 'suggestion' && attrs.kind) {
    parts.push(`data-kind="${escapeAttr(String(attrs.kind))}"`);
  }

  const content = renderInlineNodes(node.children as MdastNode[] | undefined);
  return `<span ${parts.join(' ')}>${content}</span>`;
}

export function proofMarkHandler(
  this: any,
  node: ProofMarkNode,
  _parent?: unknown,
  state?: { containerPhrasing?: (node: ProofMarkNode, info?: Record<string, unknown>) => string },
  info?: Record<string, unknown>
): string {
  void state;
  void info;
  return renderProofMarkNode(node);
}

export type { ProofMarkNode, MdastNode, MdastParent };
