import type { NoteFileInfo, NoteRepository } from "../ports/NoteRepository.js";
import type { IndexStore } from "../ports/IndexStore.js";

export interface ReconciliationResult {
  added: string[];
  modified: string[];
  deleted: string[];
}

export class ReconciliationService {
  constructor(
    private readonly noteRepo: NoteRepository,
    private readonly indexStore: IndexStore
  ) {}

  /**
   * Reconciles the SQLite Index with the physical Markdown files in the Vault
   * based on modification timestamps (mtime).
   */
  async reconcile(): Promise<ReconciliationResult> {
    const diskFiles = await this.noteRepo.listAllFiles();
    const indexedNotes = await this.indexStore.getAllNotesMetadata();

    const diskMap = new Map(diskFiles.map((f) => [f.title, f]));
    const indexMap = new Map(indexedNotes.map((n) => [n.title, n]));

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    // 1. Process files on disk: identify additions and modifications
    for (const diskFile of diskFiles) {
      const indexed = indexMap.get(diskFile.title);

      if (!indexed) {
        // New file on disk
        const indexedOk = await this.indexNoteFromDisk(diskFile);
        if (indexedOk) {
          added.push(diskFile.title);
        }
      } else if (diskFile.mtime > indexed.mtime) {
        // Modified file on disk
        const indexedOk = await this.indexNoteFromDisk(diskFile, indexed.createdAt);
        if (indexedOk) {
          modified.push(diskFile.title);
        }
      }
    }

    // 2. Process indexed records: identify deleted files
    for (const indexed of indexedNotes) {
      if (!diskMap.has(indexed.title)) {
        await this.indexStore.deleteNote(indexed.title);
        deleted.push(indexed.title);
      }
    }

    return {
      added,
      modified,
      deleted,
    };
  }

  private async indexNoteFromDisk(
    diskFile: NoteFileInfo,
    fallbackCreatedAt?: string
  ): Promise<boolean> {
    const note = await this.noteRepo.get(diskFile.title);
    if (!note) {
      return false;
    }

    const mtimeIso = new Date(diskFile.mtime).toISOString();
    const createdAt =
      typeof note.frontmatter.createdAt === "string"
        ? note.frontmatter.createdAt
        : fallbackCreatedAt ?? mtimeIso;
    const updatedAt =
      typeof note.frontmatter.updatedAt === "string"
        ? note.frontmatter.updatedAt
        : mtimeIso;

    await this.indexStore.upsertNote({
      title: diskFile.title,
      filePath: diskFile.filePath,
      mtime: diskFile.mtime,
      createdAt,
      updatedAt,
      tags: note.tags,
      links: note.links,
    });
    return true;
  }
}
