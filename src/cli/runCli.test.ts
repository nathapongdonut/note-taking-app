import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runCli, type CliIo } from "./runCli.js";
import { KnowledgeBaseService } from "../application/KnowledgeBaseService.js";
import { FsNoteRepository } from "../adapters/FsNoteRepository.js";
import { SqliteIndexStore } from "../adapters/SqliteIndexStore.js";

describe("CLI Adapter (runCli)", () => {
  let tempVaultDir: string;
  let service: KnowledgeBaseService;
  let indexStore: SqliteIndexStore;
  let logs: string[];
  let errors: string[];
  let io: CliIo;

  beforeEach(async () => {
    tempVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-test-"));
    const noteRepo = new FsNoteRepository(tempVaultDir);
    indexStore = new SqliteIndexStore(":memory:");
    service = new KnowledgeBaseService(noteRepo, indexStore);

    logs = [];
    errors = [];
    io = {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    };
  });

  afterEach(async () => {
    await indexStore.close();
    await fs.rm(tempVaultDir, { recursive: true, force: true });
  });

  it("handles 'create' command and creates a note with tags", async () => {
    const exitCode = await runCli(
      ["create", "Cardiology", "--body", "Heart anatomy and diseases.", "--tags", "medicine,cardio"],
      service,
      io
    );

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes('Created note "Cardiology"'))).toBe(true);

    // Verify it was persisted on disk and indexed
    const note = await service.getNote("Cardiology");
    expect(note?.body).toBe("Heart anatomy and diseases.");
    expect(note?.tags).toEqual(["medicine", "cardio"]);
  });

  it("handles 'view' command and displays note details", async () => {
    await service.createNote({
      title: "Neurology",
      body: "Brain overview.",
      tags: ["neuro"],
    });

    const exitCode = await runCli(["view", "Neurology"], service, io);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("Title: Neurology"))).toBe(true);
    expect(logs.some((l) => l.includes("Brain overview."))).toBe(true);
  });

  it("returns error code and message when viewing a non-existent note", async () => {
    const exitCode = await runCli(["view", "NonExistent"], service, io);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes('Note "NonExistent" not found.'))).toBe(true);
  });

  it("handles 'search --tag' command and lists matching notes", async () => {
    await service.createNote({
      title: "Asthma",
      body: "Airway inflammation",
      tags: ["pulmonary", "chronic"],
    });
    await service.createNote({
      title: "COPD",
      body: "Chronic obstructive lung disease",
      tags: ["pulmonary", "chronic"],
    });

    const exitCode = await runCli(["search", "--tag", "pulmonary"], service, io);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("Asthma"))).toBe(true);
    expect(logs.some((l) => l.includes("COPD"))).toBe(true);
  });

  it("outputs appropriate message when search finds no matching tags", async () => {
    const exitCode = await runCli(["search", "--tag", "nonexistent"], service, io);

    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes('No notes found with tag "nonexistent"'))).toBe(true);
  });

  it("returns error for unknown command", async () => {
    const exitCode = await runCli(["unknownCommand"], service, io);

    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Unknown command"))).toBe(true);
  });

  it("handles 'backlinks' command and lists incoming backlinks", async () => {
    await service.createNote({
      title: "NoteA",
      body: "Mentions [[SharedTopic]].",
    });
    await service.createNote({
      title: "NoteB",
      body: "Also mentions [[SharedTopic]].",
    });
    await service.createNote({
      title: "SharedTopic",
      body: "Target note content.",
    });

    const exitCode = await runCli(["backlinks", "SharedTopic"], service, io);
    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes('Backlinks for "SharedTopic":'))).toBe(true);
    expect(logs.some((l) => l.includes("• NoteA"))).toBe(true);
    expect(logs.some((l) => l.includes("• NoteB"))).toBe(true);

    const emptyExit = await runCli(["backlinks", "NoteA"], service, io);
    expect(emptyExit).toBe(0);
    expect(logs.some((l) => l.includes('No backlinks found for "NoteA"'))).toBe(true);
  });

  it("returns error when 'backlinks' command is run without a title", async () => {
    const exitCode = await runCli(["backlinks"], service, io);
    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("Please specify the note title"))).toBe(true);
  });

  it("handles 'ghost-notes' command and lists ghost notes with referrers", async () => {
    await service.createNote({
      title: "Article1",
      body: "See [[QuantumComputing]] and [[QuantumEntanglement]].",
    });
    await service.createNote({
      title: "Article2",
      body: "See [[QuantumComputing]].",
    });

    const exitCode = await runCli(["ghost-notes"], service, io);
    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("Ghost notes:"))).toBe(true);
    expect(logs.some((l) => l.includes("QuantumComputing") && l.includes("Article1, Article2"))).toBe(true);
    expect(logs.some((l) => l.includes("QuantumEntanglement") && l.includes("Article1"))).toBe(true);
  });

  it("outputs appropriate message when 'ghost-notes' finds no ghost notes", async () => {
    await service.createNote({
      title: "SelfContained",
      body: "No links here.",
    });

    const exitCode = await runCli(["ghost-notes"], service, io);
    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("No ghost notes found"))).toBe(true);
  });

  it("includes Backlinks section in 'view' command output", async () => {
    await service.createNote({
      title: "Source1",
      body: "Links to [[Target]].",
    });
    await service.createNote({
      title: "Target",
      body: "Target body text.",
    });

    const exitCode = await runCli(["view", "Target"], service, io);
    expect(exitCode).toBe(0);
    expect(logs.some((l) => l.includes("Backlinks:"))).toBe(true);
    expect(logs.some((l) => l.includes("• Source1"))).toBe(true);
  });

  describe("rename command", () => {
    it("renames note and outputs summary of modified referencing files", async () => {
      await service.createNote({
        title: "OldName",
        body: "Content.",
      });
      await service.createNote({
        title: "Linker",
        body: "Links to [[OldName]].",
      });

      const exitCode = await runCli(["rename", "OldName", "NewName"], service, io);
      expect(exitCode).toBe(0);
      expect(logs.some((l) => l.includes('Renamed note "OldName" to "NewName"'))).toBe(true);
      expect(logs.some((l) => l.includes("Modified files:"))).toBe(true);
      expect(logs.some((l) => l.includes("• NewName.md"))).toBe(true);
      expect(logs.some((l) => l.includes("• Linker.md"))).toBe(true);
      expect(logs.some((l) => l.includes("Updated 1 referencing note(s):"))).toBe(true);
      expect(logs.some((l) => l.includes("• Linker"))).toBe(true);
    });

    it("outputs appropriate message when renamed note has no referencing notes", async () => {
      await service.createNote({
        title: "LoneNote",
        body: "No other note links here.",
      });

      const exitCode = await runCli(["rename", "LoneNote", "RenamedLoneNote"], service, io);
      expect(exitCode).toBe(0);
      expect(logs.some((l) => l.includes('Renamed note "LoneNote" to "RenamedLoneNote"'))).toBe(true);
      expect(logs.some((l) => l.includes("No referencing notes needed updates."))).toBe(true);
    });

    it("returns error when old or new title argument is missing", async () => {
      const exitCode1 = await runCli(["rename"], service, io);
      expect(exitCode1).toBe(1);
      expect(errors.some((e) => e.includes("Please provide both old and new note titles"))).toBe(true);

      const exitCode2 = await runCli(["rename", "OnlyOld"], service, io);
      expect(exitCode2).toBe(1);
      expect(errors.some((e) => e.includes("Please provide both old and new note titles"))).toBe(true);
    });

    it("handles error when trying to rename non-existent note", async () => {
      const exitCode = await runCli(["rename", "DoesNotExist", "New"], service, io);
      expect(exitCode).toBe(1);
      expect(errors.some((e) => e.includes('Cannot rename note: "DoesNotExist" does not exist'))).toBe(true);
    });
  });
});
