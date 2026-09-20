import { describe, it, expect, beforeEach } from "vitest";
import { ReconciliationService } from "./ReconciliationService.js";
import { SqliteIndexStore } from "../adapters/SqliteIndexStore.js";
import type { NoteRepository, NoteFileInfo } from "../ports/NoteRepository.js";
import type { Note } from "../domain/Note.js";

class InMemoryNoteRepository implements NoteRepository {
  public notes = new Map<string, Note>();
  public fileInfos = new Map<string, NoteFileInfo>();

  async save(note: Note): Promise<void> {
    this.notes.set(note.title, note);
    this.fileInfos.set(note.title, {
      title: note.title,
      filePath: `${note.title}.md`,
      mtime: Date.now(),
    });
  }

  async get(title: string): Promise<Note | null> {
    return this.notes.get(title) || null;
  }

  async delete(title: string): Promise<boolean> {
    const deleted = this.notes.delete(title);
    this.fileInfos.delete(title);
    return deleted;
  }

  async listTitles(): Promise<string[]> {
    return Array.from(this.notes.keys());
  }

  async exists(title: string): Promise<boolean> {
    return this.notes.has(title);
  }

  async rename(oldTitle: string, newTitle: string): Promise<void> {
    const note = this.notes.get(oldTitle);
    if (note) {
      this.notes.delete(oldTitle);
      this.fileInfos.delete(oldTitle);
      note.title = newTitle;
      this.save(note);
    }
  }

  async getFileInfo(title: string): Promise<NoteFileInfo | null> {
    return this.fileInfos.get(title) || null;
  }

  async listAllFiles(): Promise<NoteFileInfo[]> {
    return Array.from(this.fileInfos.values());
  }
}

describe("ReconciliationService", () => {
  let noteRepo: InMemoryNoteRepository;
  let indexStore: SqliteIndexStore;
  let service: ReconciliationService;

  beforeEach(() => {
    noteRepo = new InMemoryNoteRepository();
    indexStore = new SqliteIndexStore(":memory:");
    service = new ReconciliationService(noteRepo, indexStore);
  });

  it("reports no changes when disk and index are in sync", async () => {
    noteRepo.notes.set("Intro", {
      title: "Intro",
      frontmatter: { title: "Intro" },
      tags: ["start"],
      body: "Welcome.",
      links: [],
    });
    noteRepo.fileInfos.set("Intro", {
      title: "Intro",
      filePath: "Intro.md",
      mtime: 100,
    });

    await indexStore.upsertNote({
      title: "Intro",
      filePath: "Intro.md",
      mtime: 100,
      tags: ["start"],
      links: [],
    });

    const result = await service.reconcile();
    expect(result).toEqual({
      added: [],
      modified: [],
      deleted: [],
    });
  });

  it("detects newly added files on disk and indexes them with tags and links", async () => {
    noteRepo.notes.set("NewNote", {
      title: "NewNote",
      frontmatter: { title: "NewNote" },
      tags: ["discovered"],
      body: "References [[ExternalGhost]].",
      links: ["ExternalGhost"],
    });
    noteRepo.fileInfos.set("NewNote", {
      title: "NewNote",
      filePath: "NewNote.md",
      mtime: 150,
    });

    const result = await service.reconcile();
    expect(result.added).toEqual(["NewNote"]);
    expect(result.modified).toEqual([]);
    expect(result.deleted).toEqual([]);

    const meta = await indexStore.getNoteMetadata("NewNote");
    expect(meta).not.toBeNull();
    expect(meta?.tags).toEqual(["discovered"]);
    expect(meta?.links).toEqual(["ExternalGhost"]);

    const ghostNotes = await indexStore.getGhostNotes();
    expect(ghostNotes).toEqual([
      { targetTitle: "ExternalGhost", referencedBy: ["NewNote"] },
    ]);
  });

  it("detects modified files on disk (disk mtime > index mtime) and updates metadata", async () => {
    // Initially synced at mtime 100
    await indexStore.upsertNote({
      title: "ExistingNote",
      filePath: "ExistingNote.md",
      mtime: 100,
      tags: ["v1"],
      links: ["OldLink"],
    });

    // Modified outside CLI at mtime 200
    noteRepo.notes.set("ExistingNote", {
      title: "ExistingNote",
      frontmatter: { title: "ExistingNote" },
      tags: ["v2"],
      body: "Now links to [[NewLink]].",
      links: ["NewLink"],
    });
    noteRepo.fileInfos.set("ExistingNote", {
      title: "ExistingNote",
      filePath: "ExistingNote.md",
      mtime: 200,
    });

    const result = await service.reconcile();
    expect(result.modified).toEqual(["ExistingNote"]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);

    const meta = await indexStore.getNoteMetadata("ExistingNote");
    expect(meta?.mtime).toBe(200);
    expect(meta?.tags).toEqual(["v2"]);
    expect(meta?.links).toEqual(["NewLink"]);
  });

  it("ignores files on disk whose mtime has not advanced", async () => {
    await indexStore.upsertNote({
      title: "UnchangedNote",
      filePath: "UnchangedNote.md",
      mtime: 500,
      tags: ["static"],
      links: [],
    });

    noteRepo.notes.set("UnchangedNote", {
      title: "UnchangedNote",
      frontmatter: { title: "UnchangedNote" },
      tags: ["static"],
      body: "Unchanged content.",
      links: [],
    });
    noteRepo.fileInfos.set("UnchangedNote", {
      title: "UnchangedNote",
      filePath: "UnchangedNote.md",
      mtime: 500,
    });

    const result = await service.reconcile();
    expect(result.modified).toEqual([]);
  });

  it("detects deleted files on disk, removes them from index, and reverts links to ghost notes", async () => {
    // Both notes in index, Caller links to DeletedNote
    await indexStore.upsertNote({
      title: "Caller",
      filePath: "Caller.md",
      mtime: 100,
      tags: [],
      links: ["DeletedNote"],
    });

    await indexStore.upsertNote({
      title: "DeletedNote",
      filePath: "DeletedNote.md",
      mtime: 100,
      tags: ["old"],
      links: [],
    });

    // On disk: DeletedNote is removed
    noteRepo.notes.set("Caller", {
      title: "Caller",
      frontmatter: { title: "Caller" },
      tags: [],
      body: "Links to [[DeletedNote]].",
      links: ["DeletedNote"],
    });
    noteRepo.fileInfos.set("Caller", {
      title: "Caller",
      filePath: "Caller.md",
      mtime: 100,
    });

    const result = await service.reconcile();
    expect(result.deleted).toEqual(["DeletedNote"]);

    // DeletedNote should be gone from index
    expect(await indexStore.getNoteMetadata("DeletedNote")).toBeNull();

    // DeletedNote should now appear as a Ghost Note referenced by Caller
    const ghostNotes = await indexStore.getGhostNotes();
    expect(ghostNotes).toEqual([
      { targetTitle: "DeletedNote", referencedBy: ["Caller"] },
    ]);
  });
});
