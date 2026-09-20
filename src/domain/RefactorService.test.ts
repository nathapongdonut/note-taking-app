import { describe, it, expect } from "vitest";
import { RefactorService } from "./RefactorService.js";

describe("RefactorService (Domain Link Refactoring)", () => {
  it("replaces a single Wiki-link with the new title", () => {
    const markdown = "Refer to [[Cardiology]] for details.";
    const result = RefactorService.renameWikiLinks(markdown, "Cardiology", "Cardiovascular Medicine");
    expect(result).toBe("Refer to [[Cardiovascular Medicine]] for details.");
  });

  it("replaces multiple Wiki-link occurrences across different lines", () => {
    const markdown = `
# Overview
See [[Cardiology]] in morning.
Later, consult [[Cardiology]] again.
Also see [[Neurology]].
`;
    const result = RefactorService.renameWikiLinks(markdown, "Cardiology", "Cardio");
    expect(result).toContain("See [[Cardio]] in morning.");
    expect(result).toContain("Later, consult [[Cardio]] again.");
    expect(result).toContain("Also see [[Neurology]].");
  });

  it("preserves link alias while updating the target title", () => {
    const markdown = "Check out [[Cardiology|Heart Notes]] and [[Cardiology|Study Guide]].";
    const result = RefactorService.renameWikiLinks(markdown, "Cardiology", "Cardiovascular");
    expect(result).toBe("Check out [[Cardiovascular|Heart Notes]] and [[Cardiovascular|Study Guide]].");
  });

  it("does not replace links whose title is only a prefix or suffix of the target", () => {
    const markdown = "Visit [[Cardiology]], but do not touch [[Cardiology Overview]] or [[Pediatric Cardiology]].";
    const result = RefactorService.renameWikiLinks(markdown, "Cardiology", "Cardio");
    expect(result).toBe("Visit [[Cardio]], but do not touch [[Cardiology Overview]] or [[Pediatric Cardiology]].");
  });

  it("ignores links inside fenced code blocks (backticks and tildes)", () => {
    const markdown = `
Link outside: [[Old Note]]

\`\`\`ts
// Inside backtick fence
const link = "[[Old Note]]";
\`\`\`

~~~python
# Inside tilde fence
link = "[[Old Note]]"
~~~

Another outside: [[Old Note]]
`;
    const result = RefactorService.renameWikiLinks(markdown, "Old Note", "New Note");
    expect(result).toContain("Link outside: [[New Note]]");
    expect(result).toContain('const link = "[[Old Note]]";');
    expect(result).toContain('link = "[[Old Note]]"');
    expect(result).toContain("Another outside: [[New Note]]");
  });

  it("ignores links inside inline code spans", () => {
    const markdown = "Do not replace `[[Old Note]]` or ``[[Old Note]]``, but replace [[Old Note]].";
    const result = RefactorService.renameWikiLinks(markdown, "Old Note", "New Note");
    expect(result).toBe("Do not replace `[[Old Note]]` or ``[[Old Note]]``, but replace [[New Note]].");
  });

  it("ignores escaped Wiki-link brackets", () => {
    const markdown = "Escaped: \\[[Old Note]] and \\[\\[Old Note\\]\\], but real link: [[Old Note]].";
    const result = RefactorService.renameWikiLinks(markdown, "Old Note", "New Note");
    expect(result).toBe("Escaped: \\[[Old Note]] and \\[\\[Old Note\\]\\], but real link: [[New Note]].");
  });

  it("handles escaped backslashes correctly before a real link", () => {
    const markdown = "Escaped backslash: \\\\[[Old Note]].";
    const result = RefactorService.renameWikiLinks(markdown, "Old Note", "New Note");
    expect(result).toBe("Escaped backslash: \\\\[[New Note]].");
  });

  it("returns content unchanged if oldTitle is not referenced", () => {
    const markdown = "Plain text with [[Other Note]].";
    const result = RefactorService.renameWikiLinks(markdown, "Old Note", "New Note");
    expect(result).toBe(markdown);
  });
});
