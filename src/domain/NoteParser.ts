import YAML from "yaml";
import type { Note, NoteFrontmatter } from "./Note.js";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export class NoteParser {
  /**
   * Parses raw markdown text into a structured Note domain entity.
   */
  static parse(rawContent: string, fallbackTitle?: string): Note {
    const match = rawContent.match(FRONTMATTER_REGEX);

    if (match) {
      const frontmatterRaw = match[1];
      const body = match[2].trim();
      let parsedFrontmatter: Record<string, unknown> = {};

      try {
        parsedFrontmatter = (YAML.parse(frontmatterRaw) as Record<string, unknown>) || {};
      } catch {
        parsedFrontmatter = {};
      }

      const frontmatter: NoteFrontmatter = { ...parsedFrontmatter };
      const title =
        typeof frontmatter.title === "string" && frontmatter.title.trim().length > 0
          ? frontmatter.title.trim()
          : this.extractFirstHeading(body) || fallbackTitle || "Untitled";

      const tags = Array.isArray(frontmatter.tags)
        ? (frontmatter.tags.map(String).map((t) => t.trim()).filter(Boolean) as string[])
        : [];

      const links = this.extractWikiLinks(body);

      return {
        title,
        frontmatter,
        tags,
        body,
        links,
      };
    }

    const body = rawContent.trim();
    const title = this.extractFirstHeading(body) || fallbackTitle || "Untitled";
    const links = this.extractWikiLinks(body);

    return {
      title,
      frontmatter: {},
      tags: [],
      body,
      links,
    };
  }

  /**
   * Shared regex matching fenced code blocks, inline code spans, backslash escapes, and wiki-links.
   * Group 1: Fenced code fence
   * Group 2: Inline code ticks
   * Group 3: Wiki-link content
   */
  static readonly WIKILINK_TOKEN_REGEX =
    /(?:^|\n)([`~]{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*(?=\n|$)|(`+)[\s\S]*?\2|\\.|\[\[([^\[\]\r\n]+?)\]\]/g;

  /**
   * Extracts all unique [[Target Title]] Wiki-links from markdown content,
   * ignoring code blocks (fenced and inline) and escaped characters.
   */
  static extractWikiLinks(content: string): string[] {
    if (!content) {
      return [];
    }

    const matches = content.matchAll(NoteParser.WIKILINK_TOKEN_REGEX);
    const links: string[] = [];
    for (const match of matches) {
      const [fullMatch, fence, inlineCode, linkContent] = match;
      if (fence || inlineCode || fullMatch.startsWith("\\")) {
        continue;
      }
      if (linkContent !== undefined) {
        const target = linkContent.split("|")[0].trim();
        if (target.length > 0) {
          links.push(target);
        }
      }
    }

    return Array.from(new Set(links));
  }

  private static extractFirstHeading(content: string): string | null {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    return headingMatch ? headingMatch[1].trim() : null;
  }


  /**
   * Serializes a Note entity back into a markdown string with YAML frontmatter.
   */
  static serialize(note: Note): string {
    const frontmatterToSerialize: Record<string, unknown> = {
      title: note.title,
      ...note.frontmatter,
    };

    if (note.tags.length > 0) {
      frontmatterToSerialize.tags = note.tags;
    }

    const yamlString = YAML.stringify(frontmatterToSerialize).trim();
    return `---\n${yamlString}\n---\n\n${note.body}`;
  }
}
