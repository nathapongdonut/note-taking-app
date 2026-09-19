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
});

