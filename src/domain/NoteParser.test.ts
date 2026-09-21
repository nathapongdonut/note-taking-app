import { describe, it, expect } from "vitest";
import { NoteParser } from "./NoteParser.js";

describe("NoteParser", () => {
  it("parses a markdown string with valid YAML frontmatter into a Note entity", () => {
    const rawMarkdown = `---
title: "Cardiology Overview"
tags:
  - medicine
  - heart
---
Heart disease is a major topic in clinical medicine.`;

    const note = NoteParser.parse(rawMarkdown);

    expect(note.title).toBe("Cardiology Overview");
    expect(note.tags).toEqual(["medicine", "heart"]);
    expect(note.body).toBe("Heart disease is a major topic in clinical medicine.");
  });

  it("serializes a Note entity back to a Markdown string with formatted frontmatter", () => {
    const note = {
      title: "Pharmacology 101",
      tags: ["drugs", "receptors"],
      frontmatter: { title: "Pharmacology 101", author: "Medical Student" },
      body: "Beta blockers antagonize beta-adrenergic receptors.",
    };

    const serialized = NoteParser.serialize(note);

    expect(serialized).toContain("title: Pharmacology 101");
    expect(serialized).toContain("author: Medical Student");
    expect(serialized).toContain("- drugs");
    expect(serialized).toContain("- receptors");
    expect(serialized).toContain("Beta blockers antagonize beta-adrenergic receptors.");

    // Round-trip test: parsing the serialized text should reconstruct the Note
    const roundTripped = NoteParser.parse(serialized);
    expect(roundTripped.title).toBe(note.title);
    expect(roundTripped.tags).toEqual(note.tags);
    expect(roundTripped.body).toBe(note.body);
  });

  it("extracts title from the first Markdown heading when frontmatter has no title", () => {
    const rawMarkdown = `---
tags: [surgery]
---
# Acute Appendicitis

Clinical symptoms include right lower quadrant pain.`;

    const note = NoteParser.parse(rawMarkdown, "Default Title");
    expect(note.title).toBe("Acute Appendicitis");
    expect(note.tags).toEqual(["surgery"]);
    expect(note.body).toContain("Clinical symptoms include right lower quadrant pain.");
  });

  it("parses plain markdown without frontmatter using heading or fallback title", () => {
    const rawMarkdown = `# Neurological Examination\n\nAssess cranial nerves I through XII.`;

    const note = NoteParser.parse(rawMarkdown, "Default Fallback");
    expect(note.title).toBe("Neurological Examination");
    expect(note.tags).toEqual([]);
    expect(note.body).toBe(rawMarkdown);
  });

  it("handles malformed YAML frontmatter gracefully without throwing an error", () => {
    const rawMarkdown = `---
title: [unclosed list
tags: {broken json
---
Body text despite bad frontmatter.`;

    const note = NoteParser.parse(rawMarkdown, "Recovered Title");
    expect(note.title).toBe("Recovered Title");
    expect(note.tags).toEqual([]);
    expect(note.body).toBe("Body text despite bad frontmatter.");
  });

  describe("extractWikiLinks", () => {
    it("extracts all [[Target Title]] patterns from markdown text", () => {
      const content = `Refer to [[Cardiology]] and [[Neurology]] for further details.`;
      const links = NoteParser.extractWikiLinks(content);
      expect(links).toEqual(["Cardiology", "Neurology"]);
    });

    it("deduplicates multiple links pointing to the same target note", () => {
      const content = `Review [[Cardiology]] in morning, then [[Cardiology]] in evening.`;
      const links = NoteParser.extractWikiLinks(content);
      expect(links).toEqual(["Cardiology"]);
    });

    it("extracts target note title when alias syntax is used", () => {
      const content = `See [[Cardiology|Heart Study]] and [[Neurology|Brain]].`;
      const links = NoteParser.extractWikiLinks(content);
      expect(links).toEqual(["Cardiology", "Neurology"]);
    });

    it("ignores Wiki-links inside fenced code blocks (backticks and tildes)", () => {
      const content = `
Normal link: [[Cardiology]]

\`\`\`typescript
// Fenced code block with backticks
const note = "[[Ignored Backtick Link]]";
\`\`\`

~~~python
# Fenced code block with tildes
note = "[[Ignored Tilde Link]]"
~~~

Another normal link: [[Pulmonology]]
`;
      const links = NoteParser.extractWikiLinks(content);
      expect(links).toEqual(["Cardiology", "Pulmonology"]);
    });

    it("ignores Wiki-links inside inline code spans", () => {
      const content = `Check \`[[Ignored Inline Link]]\` or \`\`[[Double Backtick Link]]\`\`, but visit [[Neurology]].`;
      const links = NoteParser.extractWikiLinks(content);
      expect(links).toEqual(["Neurology"]);
    });

    it("ignores escaped Wiki-link brackets", () => {
      const content = `
Escaped single bracket: \\[[Not A Link]]
Escaped double bracket: \\[\\[Also Not A Link\\]\\]
Escaped backslash before real link: \\\\[[Real Link]]
`;
      const links = NoteParser.extractWikiLinks(content);
      expect(links).toEqual(["Real Link"]);
    });

    it("ignores standard markdown links and empty brackets", () => {
      const content = `[Regular Link](https://example.com) and [[ ]] and [[]] and [[Valid Link]].`;
      const links = NoteParser.extractWikiLinks(content);
      expect(links).toEqual(["Valid Link"]);
    });

    it("populates links field in Note when parsing markdown", () => {
      const raw = `---
title: Clinical Note
---
Consult [[Dr Smith]] regarding [[Blood Work]]. Duplicate [[Blood Work]].`;

      const note = NoteParser.parse(raw);
      expect(note.title).toBe("Clinical Note");
      expect(note.links).toEqual(["Dr Smith", "Blood Work"]);
    });
  });

  describe("refactorWikiLinks", () => {
    it("replaces a single Wiki-link with the new title", () => {
      const markdown = "Refer to [[Cardiology]] for details.";
      const result = NoteParser.refactorWikiLinks(markdown, "Cardiology", "Cardiovascular Medicine");
      expect(result).toBe("Refer to [[Cardiovascular Medicine]] for details.");
    });

    it("replaces multiple Wiki-link occurrences across different lines", () => {
      const markdown = `
# Overview
See [[Cardiology]] in morning.
Later, consult [[Cardiology]] again.
Also see [[Neurology]].
`;
      const result = NoteParser.refactorWikiLinks(markdown, "Cardiology", "Cardio");
      expect(result).toContain("See [[Cardio]] in morning.");
      expect(result).toContain("Later, consult [[Cardio]] again.");
      expect(result).toContain("Also see [[Neurology]].");
    });

    it("preserves link alias while updating the target title", () => {
      const markdown = "Check out [[Cardiology|Heart Notes]] and [[Cardiology|Study Guide]].";
      const result = NoteParser.refactorWikiLinks(markdown, "Cardiology", "Cardiovascular");
      expect(result).toBe("Check out [[Cardiovascular|Heart Notes]] and [[Cardiovascular|Study Guide]].");
    });

    it("does not replace links whose title is only a prefix or suffix of the target", () => {
      const markdown = "Visit [[Cardiology]], but do not touch [[Cardiology Overview]] or [[Pediatric Cardiology]].";
      const result = NoteParser.refactorWikiLinks(markdown, "Cardiology", "Cardio");
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
      const result = NoteParser.refactorWikiLinks(markdown, "Old Note", "New Note");
      expect(result).toContain("Link outside: [[New Note]]");
      expect(result).toContain('const link = "[[Old Note]]";');
      expect(result).toContain('link = "[[Old Note]]"');
      expect(result).toContain("Another outside: [[New Note]]");
    });

    it("ignores links inside inline code spans", () => {
      const markdown = "Do not replace `[[Old Note]]` or ``[[Old Note]]``, but replace [[Old Note]].";
      const result = NoteParser.refactorWikiLinks(markdown, "Old Note", "New Note");
      expect(result).toBe("Do not replace `[[Old Note]]` or ``[[Old Note]]``, but replace [[New Note]].");
    });

    it("ignores escaped Wiki-link brackets", () => {
      const markdown = "Escaped: \\[[Old Note]] and \\[\\[Old Note\\]\\], but real link: [[Old Note]].";
      const result = NoteParser.refactorWikiLinks(markdown, "Old Note", "New Note");
      expect(result).toBe("Escaped: \\[[Old Note]] and \\[\\[Old Note\\]\\], but real link: [[New Note]].");
    });

    it("handles escaped backslashes correctly before a real link", () => {
      const markdown = "Escaped backslash: \\\\[[Old Note]].";
      const result = NoteParser.refactorWikiLinks(markdown, "Old Note", "New Note");
      expect(result).toBe("Escaped backslash: \\\\[[New Note]].");
    });

    it("returns content unchanged if oldTitle is not referenced", () => {
      const markdown = "Plain text with [[Other Note]].";
      const result = NoteParser.refactorWikiLinks(markdown, "Old Note", "New Note");
      expect(result).toBe(markdown);
    });

    it("refactors Wiki-links with heading anchors and optional aliases", () => {
      const markdown = "See [[Cardiology#Anatomy]], [[Cardiology#Treatment|Therapy]], and [[#LocalHeading]].";
      const result = NoteParser.refactorWikiLinks(markdown, "Cardiology", "Cardiovascular");
      expect(result).toBe("See [[Cardiovascular#Anatomy]], [[Cardiovascular#Treatment|Therapy]], and [[#LocalHeading]].");
    });

    it("adheres to CONTEXT.md language rules: provides refactorWikiLinks and omits renameWikiLinks", () => {
      expect(typeof NoteParser.refactorWikiLinks).toBe("function");
      expect((NoteParser as Record<string, unknown>).renameWikiLinks).toBeUndefined();
    });
  });
});

