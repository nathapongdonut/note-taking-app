import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteIndexStore } from "./SqliteIndexStore.js";
import type { NoteRecord } from "../ports/IndexStore.js";

describe("SqliteIndexStore (SQLite Metadata Index Adapter)", () => {
  let indexStore: SqliteIndexStore;

  beforeEach(() => {
    // Use an in-memory SQLite database for blazing-fast isolated unit tests
    indexStore = new SqliteIndexStore(":memory:");
  });

  afterEach(async () => {
    await indexStore.close();
  });

  it("upserts a note record and retrieves its metadata with tags", async () => {
    const record: NoteRecord = {
      title: "Cardiology",
      filePath: "/vault/Cardiology.md",
      mtime: 1700000000,
      createdAt: "2026-09-20T00:00:00Z",
      updatedAt: "2026-09-20T01:00:00Z",
      tags: ["medicine", "cardio"],
    };

    await indexStore.upsertNote(record);

    const metadata = await indexStore.getNoteMetadata("Cardiology");
    expect(metadata).not.toBeNull();
    expect(metadata?.title).toBe("Cardiology");
    expect(metadata?.filePath).toBe("/vault/Cardiology.md");
    expect(metadata?.mtime).toBe(1700000000);
    expect(metadata?.tags.sort()).toEqual(["cardio", "medicine"]);
  });

  it("returns null when querying metadata of a note not in the index", async () => {
    const metadata = await indexStore.getNoteMetadata("Nonexistent");
    expect(metadata).toBeNull();
  });

  it("searches notes by tag accurately", async () => {
    await indexStore.upsertNote({
      title: "Hypertension",
      filePath: "/vault/Hypertension.md",
      mtime: 1700000001,
      tags: ["cardio", "chronic"],
    });

    await indexStore.upsertNote({
      title: "Asthma",
      filePath: "/vault/Asthma.md",
      mtime: 1700000002,
      tags: ["pulmonary", "chronic"],
    });

    const cardioNotes = await indexStore.searchByTag("cardio");
    expect(cardioNotes).toEqual(["Hypertension"]);

    const chronicNotes = await indexStore.searchByTag("chronic");
    expect(chronicNotes.sort()).toEqual(["Asthma", "Hypertension"]);

    const neurologyNotes = await indexStore.searchByTag("neurology");
    expect(neurologyNotes).toEqual([]);
  });

  it("synchronizes tags properly when a note is updated with new tags", async () => {
    // Initial insert with tags: ["tag1", "tag2"]
    await indexStore.upsertNote({
      title: "Study Topic",
      filePath: "/vault/Study.md",
      mtime: 1700000000,
      tags: ["tag1", "tag2"],
    });

    // Update with tags: ["tag2", "tag3"] (tag1 removed, tag3 added)
    await indexStore.upsertNote({
      title: "Study Topic",
      filePath: "/vault/Study.md",
      mtime: 1700000010,
      tags: ["tag2", "tag3"],
    });

    const metadata = await indexStore.getNoteMetadata("Study Topic");
    expect(metadata?.tags.sort()).toEqual(["tag2", "tag3"]);

    // "tag1" should no longer match this note
    const tag1Matches = await indexStore.searchByTag("tag1");
    expect(tag1Matches).toEqual([]);

    // "tag3" should now match this note
    const tag3Matches = await indexStore.searchByTag("tag3");
    expect(tag3Matches).toEqual(["Study Topic"]);
  });

  it("deletes a note and cascades deletion of its indexed tags", async () => {
    await indexStore.upsertNote({
      title: "ToDelete",
      filePath: "/vault/ToDelete.md",
      mtime: 1700000000,
      tags: ["temp"],
    });

    expect(await indexStore.searchByTag("temp")).toEqual(["ToDelete"]);

    const deleted = await indexStore.deleteNote("ToDelete");
    expect(deleted).toBe(true);

    expect(await indexStore.getNoteMetadata("ToDelete")).toBeNull();
    expect(await indexStore.searchByTag("temp")).toEqual([]);

    // Deleting non-existent note returns false
    expect(await indexStore.deleteNote("ToDelete")).toBe(false);
  });

  it("lists all indexed note titles", async () => {
    await indexStore.upsertNote({
      title: "Alpha",
      filePath: "/vault/Alpha.md",
      mtime: 1,
      tags: [],
    });
    await indexStore.upsertNote({
      title: "Beta",
      filePath: "/vault/Beta.md",
      mtime: 2,
      tags: [],
    });

    const titles = await indexStore.listAllIndexedTitles();
    expect(titles.sort()).toEqual(["Alpha", "Beta"]);
  });

  it("stores and retrieves outbound links for an indexed note", async () => {
    await indexStore.upsertNote({
      title: "Cardiology",
      filePath: "/vault/Cardiology.md",
      mtime: 1700000000,
      tags: ["medicine"],
      links: ["Heart Failure", "Arrhythmia"],
    });

    const outbound = await indexStore.getOutboundLinks("Cardiology");
    expect(outbound).toEqual(["Arrhythmia", "Heart Failure"]);

    const metadata = await indexStore.getNoteMetadata("Cardiology");
    expect(metadata?.links).toEqual(["Arrhythmia", "Heart Failure"]);
  });

  it("replaces old outbound links when a note is updated with new links", async () => {
    // Initial links: ["Alpha", "Beta"]
    await indexStore.upsertNote({
      title: "SourceNote",
      filePath: "/vault/SourceNote.md",
      mtime: 1700000000,
      tags: [],
      links: ["Alpha", "Beta"],
    });

    expect(await indexStore.getOutboundLinks("SourceNote")).toEqual(["Alpha", "Beta"]);

    // Update with new links: ["Beta", "Gamma"] (Alpha removed, Gamma added)
    await indexStore.upsertNote({
      title: "SourceNote",
      filePath: "/vault/SourceNote.md",
      mtime: 1700000010,
      tags: [],
      links: ["Beta", "Gamma"],
    });

    expect(await indexStore.getOutboundLinks("SourceNote")).toEqual(["Beta", "Gamma"]);
  });

  it("cascades deletion of outbound links when a note is deleted", async () => {
    await indexStore.upsertNote({
      title: "TemporarySource",
      filePath: "/vault/TemporarySource.md",
      mtime: 1700000000,
      tags: [],
      links: ["TargetA", "TargetB"],
    });

    expect(await indexStore.getOutboundLinks("TemporarySource")).toEqual(["TargetA", "TargetB"]);

    const deleted = await indexStore.deleteNote("TemporarySource");
    expect(deleted).toBe(true);

    expect(await indexStore.getOutboundLinks("TemporarySource")).toEqual([]);
  });

  it("allows linking to uncreated target notes (ghost notes)", async () => {
    await indexStore.upsertNote({
      title: "ExistingNote",
      filePath: "/vault/ExistingNote.md",
      mtime: 1700000000,
      tags: [],
      links: ["UncreatedGhostNote"],
    });

    const outbound = await indexStore.getOutboundLinks("ExistingNote");
    expect(outbound).toEqual(["UncreatedGhostNote"]);
  });

  it("retrieves incoming backlinks for a given note title", async () => {
    await indexStore.upsertNote({
      title: "Cardiology",
      filePath: "/vault/Cardiology.md",
      mtime: 1,
      tags: [],
      links: ["Pharmacology"],
    });
    await indexStore.upsertNote({
      title: "Neurology",
      filePath: "/vault/Neurology.md",
      mtime: 2,
      tags: [],
      links: ["Pharmacology", "Anatomy"],
    });
    await indexStore.upsertNote({
      title: "Pharmacology",
      filePath: "/vault/Pharmacology.md",
      mtime: 3,
      tags: [],
      links: [],
    });

    const backlinks = await indexStore.getBacklinks("Pharmacology");
    expect(backlinks).toEqual(["Cardiology", "Neurology"]);

    const emptyBacklinks = await indexStore.getBacklinks("Cardiology");
    expect(emptyBacklinks).toEqual([]);
  });

  it("discovers all ghost notes with their referencing sources and resolves them once authored", async () => {
    await indexStore.upsertNote({
      title: "NoteA",
      filePath: "/vault/NoteA.md",
      mtime: 1,
      tags: [],
      links: ["GhostAlpha", "GhostBeta"],
    });
    await indexStore.upsertNote({
      title: "NoteB",
      filePath: "/vault/NoteB.md",
      mtime: 2,
      tags: [],
      links: ["GhostAlpha", "NoteA"],
    });

    // GhostAlpha is referenced by NoteA and NoteB.
    // GhostBeta is referenced by NoteA.
    // NoteA is referenced by NoteB, but NoteA exists in notes table so it is NOT a ghost note.
    const ghostNotes = await indexStore.getGhostNotes();
    expect(ghostNotes).toEqual([
      { targetTitle: "GhostAlpha", referencedBy: ["NoteA", "NoteB"] },
      { targetTitle: "GhostBeta", referencedBy: ["NoteA"] },
    ]);

    // Author GhostAlpha -> it should no longer be a ghost note
    await indexStore.upsertNote({
      title: "GhostAlpha",
      filePath: "/vault/GhostAlpha.md",
      mtime: 3,
      tags: [],
      links: [],
    });

    const updatedGhosts = await indexStore.getGhostNotes();
    expect(updatedGhosts).toEqual([
      { targetTitle: "GhostBeta", referencedBy: ["NoteA"] },
    ]);
  });
});
