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

  it("retrieves incoming backlinks through KnowledgeBaseService", async () => {
    await service.createNote({
      title: "DocA",
      body: "References [[CentralTopic]].",
    });
    await service.createNote({
      title: "DocB",
      body: "Also references [[CentralTopic]] and [[OtherTopic]].",
    });
    await service.createNote({
      title: "CentralTopic",
      body: "Core topic definition.",
    });

    const backlinks = await service.getBacklinks("CentralTopic");
    expect(backlinks).toEqual(["DocA", "DocB"]);

    const otherBacklinks = await service.getBacklinks("OtherTopic");
    expect(otherBacklinks).toEqual(["DocB"]);

    const nonReferenced = await service.getBacklinks("DocA");
    expect(nonReferenced).toEqual([]);
  });

  it("discovers ghost notes across the vault and resolves them when authored", async () => {
    await service.createNote({
      title: "Architecture",
      body: "Mentions [[HexagonalPattern]] and [[EventDrivenPattern]].",
    });

    const initialGhosts = await service.getGhostNotes();
    expect(initialGhosts).toEqual([
      { targetTitle: "EventDrivenPattern", referencedBy: ["Architecture"] },
      { targetTitle: "HexagonalPattern", referencedBy: ["Architecture"] },
    ]);

    // Now author HexagonalPattern
    await service.createNote({
      title: "HexagonalPattern",
      body: "Ports and Adapters architecture.",
    });

    const afterAuthoringGhosts = await service.getGhostNotes();
    expect(afterAuthoringGhosts).toEqual([
      { targetTitle: "EventDrivenPattern", referencedBy: ["Architecture"] },
    ]);
  });

  it("handles complex vault graph topologies (cyclic, self-referential, diamond, isolated)", async () => {
    // 1. Self-referential note
    await service.createNote({
      title: "Recursion",
      body: "See [[Recursion]] for recursion.",
    });

    // 2. Cyclic loop: CyclicA -> CyclicB -> CyclicA
    await service.createNote({
      title: "CyclicA",
      body: "Points to [[CyclicB]].",
    });
    await service.createNote({
      title: "CyclicB",
      body: "Points back to [[CyclicA]] and points to [[UnauthoredGhost]].",
    });

    // 3. Diamond pattern: DiamRoot -> DiamLeft & DiamRight -> DiamLeaf
    await service.createNote({
      title: "DiamRoot",
      body: "Branches to [[DiamLeft]] and [[DiamRight]].",
    });
    await service.createNote({
      title: "DiamLeft",
      body: "Converges to [[DiamLeaf]].",
    });
    await service.createNote({
      title: "DiamRight",
      body: "Converges to [[DiamLeaf]].",
    });
    await service.createNote({
      title: "DiamLeaf",
      body: "Terminal node.",
    });

    // 4. Isolated node
    await service.createNote({
      title: "Island",
      body: "No connections anywhere.",
    });

    // Assert self-reference
    expect(await service.getBacklinks("Recursion")).toEqual(["Recursion"]);

    // Assert cyclic backlinks
    expect(await service.getBacklinks("CyclicA")).toEqual(["CyclicB"]);
    expect(await service.getBacklinks("CyclicB")).toEqual(["CyclicA"]);

    // Assert diamond convergence
    expect(await service.getBacklinks("DiamLeaf")).toEqual(["DiamLeft", "DiamRight"]);
    expect(await service.getBacklinks("DiamLeft")).toEqual(["DiamRoot"]);
    expect(await service.getBacklinks("DiamRight")).toEqual(["DiamRoot"]);

    // Assert isolated node has no backlinks
    expect(await service.getBacklinks("Island")).toEqual([]);

    // Assert ghost note in cyclic structure
    const ghosts = await service.getGhostNotes();
    expect(ghosts.find((g) => g.targetTitle === "UnauthoredGhost")).toEqual({
      targetTitle: "UnauthoredGhost",
      referencedBy: ["CyclicB"],
    });
  });

  describe("renameNote", () => {
    it("renames file on disk, updates frontmatter title, rewrites referencing wiki-links, and updates SQLite index", async () => {
      await service.createNote({
        title: "OldTarget",
        body: "Original target content.",
        tags: ["target"],
      });

      await service.createNote({
        title: "CallerOne",
        body: "See [[OldTarget]] and [[OldTarget|Target Alias]].",
        tags: ["caller"],
      });

      await service.createNote({
        title: "CallerTwo",
        body: "Also references [[OldTarget]].",
      });

      const result = await service.renameNote("OldTarget", "NewTarget");

      expect(result.oldTitle).toBe("OldTarget");
      expect(result.newTitle).toBe("NewTarget");
      expect(result.updatedReferencingNotes.sort()).toEqual(["CallerOne", "CallerTwo"]);

      // 1. Physical file on disk
      expect(await noteRepo.exists("OldTarget")).toBe(false);
      expect(await noteRepo.exists("NewTarget")).toBe(true);

      const renamedDiskNote = await noteRepo.get("NewTarget");
      expect(renamedDiskNote?.title).toBe("NewTarget");
      expect(renamedDiskNote?.frontmatter.title).toBe("NewTarget");

      // 2. Referencing files on disk
      const diskCallerOne = await noteRepo.get("CallerOne");
      expect(diskCallerOne?.body).toBe("See [[NewTarget]] and [[NewTarget|Target Alias]].");

      const diskCallerTwo = await noteRepo.get("CallerTwo");
      expect(diskCallerTwo?.body).toBe("Also references [[NewTarget]].");

      // 3. SQLite index graph
      expect(await service.getBacklinks("OldTarget")).toEqual([]);
      expect(await service.getBacklinks("NewTarget")).toEqual(["CallerOne", "CallerTwo"]);
      expect(await service.getOutboundLinks("CallerOne")).toEqual(["NewTarget"]);
    });

    it("updates self-referential links within the renamed note itself", async () => {
      await service.createNote({
        title: "RecursiveNote",
        body: "Refers to [[RecursiveNote]].",
      });

      await service.renameNote("RecursiveNote", "NewRecursiveNote");

      const diskNote = await noteRepo.get("NewRecursiveNote");
      expect(diskNote?.body).toBe("Refers to [[NewRecursiveNote]].");
      expect(await service.getBacklinks("NewRecursiveNote")).toEqual(["NewRecursiveNote"]);
    });

    it("throws error when trying to rename a non-existent note", async () => {
      await expect(service.renameNote("GhostNote", "Any")).rejects.toThrow(
        'Cannot rename note: "GhostNote" does not exist.'
      );
    });

    it("throws error when target name already exists", async () => {
      await service.createNote({ title: "Note1" });
      await service.createNote({ title: "Note2" });

      await expect(service.renameNote("Note1", "Note2")).rejects.toThrow(
        'Cannot rename note: "Note2" already exists.'
      );
    });

    it("atomically rolls back all disk modifications if writing to a referencing file fails", async () => {
      await service.createNote({
        title: "TargetToRename",
        body: "Target body.",
      });

      await service.createNote({
        title: "SafeCaller",
        body: "Links to [[TargetToRename]].",
      });

      await service.createNote({
        title: "FaultyCaller",
        body: "Links to [[TargetToRename]].",
      });

      // Simulate a failure when saving FaultyCaller
      const originalSave = noteRepo.save.bind(noteRepo);
      let callCount = 0;
      noteRepo.save = async (note) => {
        if (note.title === "FaultyCaller") {
          throw new Error("Simulated disk I/O failure on FaultyCaller");
        }
        return originalSave(note);
      };

      await expect(service.renameNote("TargetToRename", "AbortedNewTarget")).rejects.toThrow(
        "Simulated disk I/O failure on FaultyCaller"
      );

      // Verify rollback: TargetToRename still exists and AbortedNewTarget does not
      expect(await noteRepo.exists("TargetToRename")).toBe(true);
      expect(await noteRepo.exists("AbortedNewTarget")).toBe(false);

      // SafeCaller was processed before FaultyCaller, verify it was rolled back to link to TargetToRename
      const rolledBackCaller = await noteRepo.get("SafeCaller");
      expect(rolledBackCaller?.body).toBe("Links to [[TargetToRename]].");
    });

    it("atomically rolls back both disk modifications and SQLite index rename if re-indexing referencing notes fails", async () => {
      await service.createNote({
        title: "TargetNote",
        body: "Target content.",
      });

      await service.createNote({
        title: "ReferencingNote",
        body: "Mentions [[TargetNote]].",
      });

      // Simulate a failure during upsertNote when re-indexing referencing notes
      const originalUpsert = indexStore.upsertNote.bind(indexStore);
      indexStore.upsertNote = async (record) => {
        if (record.title === "ReferencingNote") {
          throw new Error("Simulated index failure on referencing note");
        }
        return originalUpsert(record);
      };

      await expect(service.renameNote("TargetNote", "NewTargetNote")).rejects.toThrow(
        "Simulated index failure on referencing note"
      );

      // Verify disk rollback: TargetNote exists, NewTargetNote does not
      expect(await noteRepo.exists("TargetNote")).toBe(true);
      expect(await noteRepo.exists("NewTargetNote")).toBe(false);

      // Verify SQLite rollback: index still contains TargetNote, not NewTargetNote
      const indexedTitles = await indexStore.listAllIndexedTitles();
      expect(indexedTitles).toContain("TargetNote");
      expect(indexedTitles).not.toContain("NewTargetNote");

      // Verify backlinks still point to TargetNote
      expect(await service.getBacklinks("TargetNote")).toEqual(["ReferencingNote"]);
      expect(await service.getBacklinks("NewTargetNote")).toEqual([]);
    });

    it("restores previously upserted referencing notes in SQLite index if a subsequent referencing note index update fails", async () => {
      await service.createNote({
        title: "TargetNote",
        body: "Target content.",
      });

      await service.createNote({
        title: "Ref1",
        body: "Mentions [[TargetNote]].",
      });

      await service.createNote({
        title: "Ref2",
        body: "Also mentions [[TargetNote]].",
      });

      const initialRef1Meta = await indexStore.getNoteMetadata("Ref1");

      const originalUpsert = indexStore.upsertNote.bind(indexStore);
      indexStore.upsertNote = async (record) => {
        if (record.title === "Ref2") {
          throw new Error("Simulated index failure on Ref2");
        }
        return originalUpsert(record);
      };

      await expect(service.renameNote("TargetNote", "NewTargetNote")).rejects.toThrow(
        "Simulated index failure on Ref2"
      );

      // Verify Ref1 index record was rolled back to initialRef1Meta
      const rolledBackRef1Meta = await indexStore.getNoteMetadata("Ref1");
      expect(rolledBackRef1Meta?.mtime).toBe(initialRef1Meta?.mtime);
      expect(rolledBackRef1Meta?.links).toEqual(["TargetNote"]);
    });

    it("end-to-end integration: renames note on physical filesystem, updates referencing files on disk, and preserves SQLite graph consistency", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-e2e-"));
      const dbPath = path.join(tempDir, "test-index.db");

      try {
        const fsRepo = new FsNoteRepository(tempDir);
        const persistentStore = new SqliteIndexStore(dbPath);
        const e2eService = new KnowledgeBaseService(fsRepo, persistentStore);

        // 1. Create target note and two referencing notes
        await e2eService.createNote({
          title: "Architecture",
          body: "Core architectural concepts.",
          tags: ["architecture"],
        });

        await e2eService.createNote({
          title: "ModuleA",
          body: "Module A implements [[Architecture]] patterns.",
        });

        await e2eService.createNote({
          title: "ModuleB",
          body: "Module B relies on [[Architecture|System Architecture]] details.",
        });

        // 2. Perform rename refactor
        const result = await e2eService.renameNote("Architecture", "SystemArchitecture");
        expect(result.oldTitle).toBe("Architecture");
        expect(result.newTitle).toBe("SystemArchitecture");
        expect(result.updatedReferencingNotes.sort()).toEqual(["ModuleA", "ModuleB"]);

        // 3. Verify physical files on disk
        const oldFileExists = await fs.access(path.join(tempDir, "Architecture.md")).then(() => true, () => false);
        const newFileExists = await fs.access(path.join(tempDir, "SystemArchitecture.md")).then(() => true, () => false);
        expect(oldFileExists).toBe(false);
        expect(newFileExists).toBe(true);

        const newRawContent = await fs.readFile(path.join(tempDir, "SystemArchitecture.md"), "utf-8");
        expect(newRawContent).toContain("title: SystemArchitecture");

        const modARaw = await fs.readFile(path.join(tempDir, "ModuleA.md"), "utf-8");
        expect(modARaw).toContain("[[SystemArchitecture]]");

        const modBRaw = await fs.readFile(path.join(tempDir, "ModuleB.md"), "utf-8");
        expect(modBRaw).toContain("[[SystemArchitecture|System Architecture]]");

        // 4. Verify graph consistency in persistent SQLite
        expect(await e2eService.getBacklinks("Architecture")).toEqual([]);
        expect(await e2eService.getBacklinks("SystemArchitecture")).toEqual(["ModuleA", "ModuleB"]);
        expect(await e2eService.getOutboundLinks("ModuleA")).toEqual(["SystemArchitecture"]);
        expect(await e2eService.getOutboundLinks("ModuleB")).toEqual(["SystemArchitecture"]);

        await persistentStore.close();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("reconcile", () => {
    it("synchronizes files added, modified, and deleted directly on the filesystem", async () => {
      // 1. Initially create a note through the service
      await service.createNote({
        title: "BaseNote",
        body: "Points to [[TargetNote]].",
        tags: ["base"],
      });

      await service.createNote({
        title: "TargetNote",
        body: "Target content.",
      });

      // 2. Add an external file directly on disk (e.g. created in VS Code)
      const externalFilePath = path.join(tempVaultDir, "ExternalNote.md");
      await fs.writeFile(
        externalFilePath,
        "---\ntags: [external, sync]\n---\nCreated outside CLI, points to [[TargetNote]] and [[NewGhost]].",
        "utf-8"
      );

      // 3. Reconcile additions
      const addResult = await service.reconcile();
      expect(addResult.added).toEqual(["ExternalNote"]);
      expect(addResult.modified).toEqual([]);
      expect(addResult.deleted).toEqual([]);

      expect(await service.getBacklinks("TargetNote")).toEqual(["BaseNote", "ExternalNote"]);
      expect(await service.searchByTag("external")).toEqual(["ExternalNote"]);

      const ghosts = await service.getGhostNotes();
      expect(ghosts.find((g) => g.targetTitle === "NewGhost")).toEqual({
        targetTitle: "NewGhost",
        referencedBy: ["ExternalNote"],
      });

      // 4. Modify external file directly on disk with later mtime
      // Wait slightly or update mtime explicitly
      const laterTime = new Date(Date.now() + 2000);
      await fs.writeFile(
        externalFilePath,
        "---\ntags: [updated]\n---\nEdited outside CLI, now only points to [[OnlyTarget]].",
        "utf-8"
      );
      await fs.utimes(externalFilePath, laterTime, laterTime);

      const modResult = await service.reconcile();
      expect(modResult.modified).toEqual(["ExternalNote"]);
      expect(modResult.added).toEqual([]);
      expect(modResult.deleted).toEqual([]);

      expect(await service.searchByTag("external")).toEqual([]);
      expect(await service.searchByTag("updated")).toEqual(["ExternalNote"]);
      expect(await service.getOutboundLinks("ExternalNote")).toEqual(["OnlyTarget"]);

      // 5. Delete TargetNote directly on filesystem (e.g. deleted in Finder)
      const targetFilePath = path.join(tempVaultDir, "TargetNote.md");
      await fs.unlink(targetFilePath);

      const delResult = await service.reconcile();
      expect(delResult.deleted).toEqual(["TargetNote"]);
      expect(delResult.added).toEqual([]);
      expect(delResult.modified).toEqual([]);

      // BaseNote still points to TargetNote, so TargetNote should cleanly revert to a Ghost Note!
      const updatedGhosts = await service.getGhostNotes();
      expect(updatedGhosts.find((g) => g.targetTitle === "TargetNote")).toEqual({
        targetTitle: "TargetNote",
        referencedBy: ["BaseNote"],
      });
    });
  });
});
