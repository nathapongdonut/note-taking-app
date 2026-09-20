import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { KnowledgeBaseService } from "./KnowledgeBaseService.js";
import { FsNoteRepository } from "../adapters/FsNoteRepository.js";
import { SqliteIndexStore } from "../adapters/SqliteIndexStore.js";

describe("KnowledgeBaseService (Application Service Facade)", () => {
  let tempVaultDir: string;
  let noteRepo: FsNoteRepository;
  let indexStore: SqliteIndexStore;
  let service: KnowledgeBaseService;

  beforeEach(async () => {
    tempVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-service-test-"));
    noteRepo = new FsNoteRepository(tempVaultDir);
    indexStore = new SqliteIndexStore(":memory:");
    service = new KnowledgeBaseService(noteRepo, indexStore);
  });

  afterEach(async () => {
    await indexStore.close();
    await fs.rm(tempVaultDir, { recursive: true, force: true });
  });

  it("creates a note on disk and indexes its metadata and tags simultaneously", async () => {
    const createdNote = await service.createNote({
      title: "Cardiology",
      body: "Myocardial infarction is necrosis of heart muscle.",
      tags: ["medicine", "cardio"],
    });

    expect(createdNote.title).toBe("Cardiology");
    expect(createdNote.tags).toEqual(["medicine", "cardio"]);

    // 1. Verify file exists on disk
    const diskNote = await noteRepo.get("Cardiology");
    expect(diskNote).not.toBeNull();
    expect(diskNote?.body).toBe("Myocardial infarction is necrosis of heart muscle.");

    // 2. Verify indexed in SQLite
    const searchResults = await service.searchByTag("cardio");
    expect(searchResults).toEqual(["Cardiology"]);

    const metadata = await indexStore.getNoteMetadata("Cardiology");
    expect(metadata?.tags.sort()).toEqual(["cardio", "medicine"]);
  });

  it("throws an error when trying to create a note with a duplicate title", async () => {
    await service.createNote({
      title: "Duplicate Title",
      body: "First version",
    });

    await expect(
      service.createNote({
        title: "Duplicate Title",
        body: "Second version",
      })
    ).rejects.toThrow('Note with title "Duplicate Title" already exists.');
  });

  it("retrieves an existing note with getNote()", async () => {
    await service.createNote({
      title: "Neurology",
      body: "Brain and nervous system.",
    });

    const note = await service.getNote("Neurology");
    expect(note).not.toBeNull();
    expect(note?.title).toBe("Neurology");
    expect(note?.body).toBe("Brain and nervous system.");

    const nonExistent = await service.getNote("Ghost");
    expect(nonExistent).toBeNull();
  });

  it("deletes a note from disk and removes it from the SQLite index", async () => {
    await service.createNote({
      title: "Temporary",
      tags: ["temp"],
    });

    expect(await service.searchByTag("temp")).toEqual(["Temporary"]);

    const deleted = await service.deleteNote("Temporary");
    expect(deleted).toBe(true);

    expect(await noteRepo.exists("Temporary")).toBe(false);
    expect(await service.searchByTag("temp")).toEqual([]);
  });

  it("extracts Wiki-links and populates the SQLite link graph upon note creation", async () => {
    const note = await service.createNote({
      title: "IndexNote",
      body: "Check out [[NoteA]] and [[NoteB]], along with duplicate [[NoteA]]. Also inline `[[Ignored]]`.",
    });

    expect(note.links).toEqual(["NoteA", "NoteB"]);

    const outboundLinks = await service.getOutboundLinks("IndexNote");
    expect(outboundLinks).toEqual(["NoteA", "NoteB"]);

    const metadata = await indexStore.getNoteMetadata("IndexNote");
    expect(metadata?.links).toEqual(["NoteA", "NoteB"]);
  });

  it("replaces old outbound links when a note is updated", async () => {
    await service.createNote({
      title: "MutableNote",
      body: "Initially connects to [[OldTarget1]] and [[OldTarget2]].",
    });

    expect(await service.getOutboundLinks("MutableNote")).toEqual(["OldTarget1", "OldTarget2"]);

    // Update note body with different links
    await service.updateNote("MutableNote", {
      body: "Now connects only to [[NewTarget]] and [[OldTarget2]].",
    });

    const updatedLinks = await service.getOutboundLinks("MutableNote");
    expect(updatedLinks).toEqual(["NewTarget", "OldTarget2"]);
  });

  it("cleans up outbound links when a note is deleted", async () => {
    await service.createNote({
      title: "EphemeralNote",
      body: "Links to [[Ghost1]] and [[Ghost2]].",
    });

    expect(await service.getOutboundLinks("EphemeralNote")).toEqual(["Ghost1", "Ghost2"]);

    const deleted = await service.deleteNote("EphemeralNote");
    expect(deleted).toBe(true);

    expect(await service.getOutboundLinks("EphemeralNote")).toEqual([]);
  });
});
