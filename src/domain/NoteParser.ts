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
   * Extracts all unique [[Target Title]] Wiki-links from markdown content,
   * ignoring code blocks (fenced and inline) and escaped characters.
   */
  static extractWikiLinks(content: string): string[] {
    if (!content) {
      return [];
    }

    // 1. Remove fenced code blocks (``` or ~~~ with at least 3 markers)
    const noFencedCode = content.replace(
      /(?:^|\n)([`~]{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*(?=\n|$)/g,
      "\n"
    );

    // 2. Remove inline code spans (`...` or ``...``)
    const noInlineCode = noFencedCode.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, " ");

    // 3. Replace escaped characters (\.) with spaces
    const unescaped = noInlineCode.replace(/\\./g, " ");

    // 4. Extract [[Target Title]]
    const matches = unescaped.matchAll(/\[\[([^\[\]\r\n]+?)\]\]/g);
    const links: string[] = [];
    for (const match of matches) {
      const target = match[1].split("|")[0].trim();
      if (target.length > 0) {
        links.push(target);
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
