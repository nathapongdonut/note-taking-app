import { NoteParser } from "./NoteParser.js";

export class RefactorService {
  /**
   * Safely refactors all [[oldTitle]] Wiki-links to [[newTitle]] in markdown content.
   * Preserves aliases ([[oldTitle|Alias]]), code blocks (fenced and inline),
   * escaped characters, and surrounding text untouched.
   */
  static refactorWikiLinks(content: string, oldTitle: string, newTitle: string): string {
    if (!content) {
      return "";
    }

    const trimmedOld = oldTitle.trim();
    const trimmedNew = newTitle.trim();

    if (!trimmedOld || !trimmedNew || trimmedOld === trimmedNew) {
      return content;
    }

    return content.replace(NoteParser.WIKILINK_TOKEN_REGEX, (match, fence, inlineCode, linkContent) => {
      // Return code blocks and escaped characters untouched
      if (fence || inlineCode || match.startsWith("\\")) {
        return match;
      }

      if (linkContent !== undefined) {
        if (linkContent.includes("|")) {
          const parts = linkContent.split("|");
          const target = parts[0].trim();
          if (target === trimmedOld) {
            return `[[${trimmedNew}|${parts.slice(1).join("|")}]]`;
          }
        } else {
          if (linkContent.trim() === trimmedOld) {
            return `[[${trimmedNew}]]`;
          }
        }
      }

      return match;
    });
  }

  /**
   * Alias for backward compatibility.
   */
  static renameWikiLinks(content: string, oldTitle: string, newTitle: string): string {
    return this.refactorWikiLinks(content, oldTitle, newTitle);
  }
}
