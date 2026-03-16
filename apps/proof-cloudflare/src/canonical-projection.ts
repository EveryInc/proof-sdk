/**
 * Canonical Projection — Y.Doc ↔ Markdown conversion for Durable Objects.
 *
 * Converts between the live Y.Doc (ProseMirror XmlFragment) and the canonical
 * markdown representation used by agent routes. This is the DO-native equivalent
 * of the Express server's canonical-document.ts + collab.ts interaction.
 */

import * as Y from "yjs";
import {
  yXmlFragmentToProseMirrorRootNode,
  prosemirrorToYXmlFragment,
} from "y-prosemirror";
import {
  getHeadlessMilkdownParser,
  serializeMarkdown,
  parseMarkdownWithHtmlFallback,
} from "./milkdown-headless.js";
import type { HeadlessMilkdownParser } from "./milkdown-headless.js";

export type { HeadlessMilkdownParser };

// Ephemeral collab span pattern (inserted by Yjs collab during typing)
const EPHEMERAL_COLLAB_SPAN_RE =
  /<span\s+data-proof="authored"\s+data-by="[^"]*"\s*>\s*<\/span>/g;

/**
 * Strip empty proof authored spans that appear during live collab editing.
 */
export function stripEphemeralCollabSpans(markdown: string): string {
  return markdown.replace(EPHEMERAL_COLLAB_SPAN_RE, "");
}

/**
 * Derive canonical markdown from the Y.Doc's ProseMirror fragment.
 * This is the primary read path for agent state requests.
 */
export async function deriveMarkdownFromYDoc(
  doc: Y.Doc,
): Promise<{ markdown: string; parser: HeadlessMilkdownParser }> {
  const parser = await getHeadlessMilkdownParser();
  const fragment = doc.getXmlFragment("prosemirror");

  // If the fragment is empty, fall back to Y.Text "markdown" field
  if (fragment.length === 0) {
    const markdownText = doc.getText("markdown");
    const text = markdownText.toString();
    if (text) {
      return { markdown: stripEphemeralCollabSpans(text), parser };
    }
    return { markdown: "", parser };
  }

  try {
    const pmDoc = yXmlFragmentToProseMirrorRootNode(fragment, parser.schema);
    const raw = await serializeMarkdown(pmDoc);
    const markdown = stripEphemeralCollabSpans(raw);
    return { markdown, parser };
  } catch {
    // If fragment → ProseMirror fails, fall back to the Y.Text markdown field
    const markdownText = doc.getText("markdown");
    const fallback = stripEphemeralCollabSpans(markdownText.toString());
    return { markdown: fallback, parser };
  }
}

/**
 * Apply markdown content to the Y.Doc by replacing the ProseMirror fragment.
 * This is the primary write path for agent edits and rewrites.
 *
 * Returns the new markdown (which may differ slightly from input due to
 * ProseMirror normalization).
 */
export async function applyMarkdownToYDoc(
  doc: Y.Doc,
  markdown: string,
  origin?: string,
): Promise<string> {
  const parser = await getHeadlessMilkdownParser();

  // Parse markdown → ProseMirror document
  const parseResult = parseMarkdownWithHtmlFallback(parser, markdown);
  if (!parseResult.doc) {
    throw new Error(
      `Failed to parse markdown: ${parseResult.error instanceof Error ? parseResult.error.message : String(parseResult.error)}`,
    );
  }

  const pmDoc = parseResult.doc;

  // Serialize the parsed doc back to get the normalized markdown
  const normalized = stripEphemeralCollabSpans(await serializeMarkdown(pmDoc));

  // Apply to Y.Doc in a transaction
  doc.transact(() => {
    const fragment = doc.getXmlFragment("prosemirror");

    // Clear existing fragment
    if (fragment.length > 0) {
      fragment.delete(0, fragment.length);
    }

    // Convert ProseMirror doc to Y.XmlFragment content
    prosemirrorToYXmlFragment(pmDoc, fragment);

    // Also update the Y.Text markdown field for compatibility
    const markdownText = doc.getText("markdown");
    applyYTextDiff(markdownText, normalized);
  }, origin ?? "cf-canonical-projection");

  return normalized;
}

/**
 * Apply a diff to a Y.Text by finding the minimal edit.
 */
export function applyYTextDiff(ytext: Y.Text, newContent: string): void {
  const oldContent = ytext.toString();
  if (oldContent === newContent) return;

  // Find common prefix
  let prefixLen = 0;
  const minLen = Math.min(oldContent.length, newContent.length);
  while (prefixLen < minLen && oldContent[prefixLen] === newContent[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (don't overlap with prefix)
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldContent[oldContent.length - 1 - suffixLen] ===
      newContent[newContent.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const deleteLen = oldContent.length - prefixLen - suffixLen;
  if (deleteLen > 0) {
    ytext.delete(prefixLen, deleteLen);
  }

  const insertText = newContent.slice(prefixLen, newContent.length - suffixLen);
  if (insertText) {
    ytext.insert(prefixLen, insertText);
  }
}

/**
 * Compute a SHA-256 checksum of markdown content.
 * Used for precondition validation in edit requests.
 */
export async function computeMarkdownChecksum(
  markdown: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(markdown);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = "";
  for (const byte of hashArray) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
