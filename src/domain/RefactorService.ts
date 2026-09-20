export class RefactorService {
  /**
   * Safely renames all [[oldTitle]] Wiki-links to [[newTitle]] in markdown content.
   * Preserves aliases ([[oldTitle|Alias]]), code blocks (fenced and inline),
   * escaped characters, and surrounding text untouched.
   */
  static renameWikiLinks(content: string, oldTitle: string, newTitle: string): string {
    if (!content) {
      return "";
    }

    const trimmedOld = oldTitle.trim();
    const trimmedNew = newTitle.trim();

    if (!trimmedOld || !trimmedNew || trimmedOld === trimmedNew) {
      return content;
    }

    // Matches:
    // 1. Fenced code blocks (``` or ~~~ with at least 3 markers)
    // 2. Inline code spans (`...` or ``...``)
    // 3. Escaped characters (\.)
    // 4. Wiki-links [[...]]
    const pattern =
      /(?:^|\n)([`~]{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*(?=\n|$)|(`+)[\s\S]*?\2|\\.|\[\[([^\[\]\r\n]+?)\]\]/g;

    return content.replace(pattern, (match, fence, inlineCode, linkContent) => {
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
}
