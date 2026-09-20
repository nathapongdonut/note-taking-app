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
});

