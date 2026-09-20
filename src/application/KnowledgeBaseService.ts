import type { Note, NoteFrontmatter } from "../domain/Note.js";
import { NoteParser } from "../domain/NoteParser.js";
import { RefactorService } from "../domain/RefactorService.js";
import type { NoteRepository } from "../ports/NoteRepository.js";
import type { GhostNoteRecord, IndexStore, NoteRecord } from "../ports/IndexStore.js";

export interface CreateNoteInput {
  title: string;
  body?: string;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}

export interface UpdateNoteInput {
  body?: string;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}

export interface RenameNoteResult {
  oldTitle: string;
  newTitle: string;
  updatedReferencingNotes: string[];
}

export class KnowledgeBaseService {
  constructor(
    private readonly noteRepo: NoteRepository,
    private readonly indexStore: IndexStore
  ) {}

  /**
   * Creates a new Note, persists it to the Vault as markdown, and indexes it in SQLite.
   */
  async createNote(input: CreateNoteInput): Promise<Note> {
    const title = input.title.trim();
    if (!title) {
      throw new Error("Note title cannot be empty.");
    }

    if (await this.noteRepo.exists(title)) {
      throw new Error(`Note with title "${title}" already exists.`);
    }

    const tags = Array.isArray(input.tags)
      ? Array.from(new Set(input.tags.map(String).map((t) => t.trim()).filter(Boolean)))
      : [];

    const body = input.body ? input.body.trim() : "";
    const links = NoteParser.extractWikiLinks(body);

    const nowIso = new Date().toISOString();
    const frontmatter: NoteFrontmatter = {
      title,
      tags,
      createdAt: nowIso,
      updatedAt: nowIso,
      ...input.frontmatter,
    };

    const note: Note = {
      title,
      frontmatter,
      tags,
      body,
      links,
    };

    await this.noteRepo.save(note);

    const record: NoteRecord = {
      title,
      filePath: `${title}.md`,
      mtime: Date.now(),
      createdAt: nowIso,
      updatedAt: nowIso,
      tags,
      links,
    };
    await this.indexStore.upsertNote(record);

    return note;
  }

  /**
   * Saves or overwrites a Note entity, persisting to the Vault and updating the SQLite index.
   */
  async saveNote(note: Note): Promise<void> {
    const links = NoteParser.extractWikiLinks(note.body);
    const noteWithLinks: Note = {
      ...note,
      links,
    };

    await this.noteRepo.save(noteWithLinks);

    const existingMeta = await this.indexStore.getNoteMetadata(note.title);
    const nowIso = new Date().toISOString();
    const record: NoteRecord = {
      title: note.title,
      filePath: `${note.title}.md`,
      mtime: Date.now(),
      createdAt:
        existingMeta?.createdAt ??
        (typeof note.frontmatter?.createdAt === "string" ? note.frontmatter.createdAt : nowIso),
      updatedAt: nowIso,
      tags: note.tags,
      links,
    };
    await this.indexStore.upsertNote(record);
  }

  /**
   * Updates an existing note's body, tags, and/or frontmatter and updates the SQLite index.
   */
  async updateNote(title: string, input: UpdateNoteInput): Promise<Note> {
    const trimmedTitle = title.trim();
    const existing = await this.noteRepo.get(trimmedTitle);
    if (!existing) {
      throw new Error(`Note with title "${trimmedTitle}" does not exist.`);
    }

    const nowIso = new Date().toISOString();
    const body = input.body !== undefined ? input.body.trim() : existing.body;
    const tags =
      input.tags !== undefined
        ? Array.from(new Set(input.tags.map(String).map((t) => t.trim()).filter(Boolean)))
        : existing.tags;
    const links = NoteParser.extractWikiLinks(body);

    const updatedNote: Note = {
      title: trimmedTitle,
      frontmatter: {
        ...existing.frontmatter,
        ...input.frontmatter,
        updatedAt: nowIso,
        tags,
      },
      tags,
      body,
      links,
    };

    await this.saveNote(updatedNote);
    return updatedNote;
  }

  /**
   * Retrieves a Note by its title.
   */
  async getNote(title: string): Promise<Note | null> {
    return this.noteRepo.get(title.trim());
  }

  /**
   * Searches the SQLite index for all note titles matching a given tag.
   */
  async searchByTag(tag: string): Promise<string[]> {
    return this.indexStore.searchByTag(tag.trim());
  }

  /**
   * Deletes a Note from both disk and the SQLite index.
   */
  async deleteNote(title: string): Promise<boolean> {
    const trimmedTitle = title.trim();
    const deletedFromDisk = await this.noteRepo.delete(trimmedTitle);
    await this.indexStore.deleteNote(trimmedTitle);
    return deletedFromDisk;
  }

  /**
   * Retrieves all outbound Wiki-link targets from a note recorded in the index.
   */
  async getOutboundLinks(title: string): Promise<string[]> {
    return this.indexStore.getOutboundLinks(title.trim());
  }

  /**
   * Retrieves all incoming Backlinks for a given note title.
   */
  async getBacklinks(title: string): Promise<string[]> {
    return this.indexStore.getBacklinks(title.trim());
  }

  /**
   * Retrieves all Ghost Notes (concepts referenced via Wiki-links that do not exist as notes).
   */
  async getGhostNotes(): Promise<GhostNoteRecord[]> {
    return this.indexStore.getGhostNotes();
  }

  /**
   * Lists all existing note titles in the Vault.
   */
  async listAllTitles(): Promise<string[]> {
    return this.noteRepo.listTitles();
  }

  /**
   * Renames a Note on disk and in the SQLite index, refactoring all incoming Wiki-links across the Vault.
   * Protects vault consistency with an atomic rollback on disk write failures.
   */
  async renameNote(oldTitle: string, newTitle: string): Promise<RenameNoteResult> {
    const trimmedOld = oldTitle.trim();
    const trimmedNew = newTitle.trim();

    if (!trimmedOld || !trimmedNew) {
      throw new Error("Note title cannot be empty.");
    }

    if (trimmedOld === trimmedNew) {
      return { oldTitle: trimmedOld, newTitle: trimmedNew, updatedReferencingNotes: [] };
    }

    const oldNote = await this.noteRepo.get(trimmedOld);
    if (!oldNote) {
      throw new Error(`Cannot rename note: "${trimmedOld}" does not exist.`);
    }

    if (await this.noteRepo.exists(trimmedNew)) {
      throw new Error(`Cannot rename note: "${trimmedNew}" already exists.`);
    }

    // 1. Discover all referencing notes via index backlinks
    const referencingTitles = await this.getBacklinks(trimmedOld);

    // Snapshot referencing notes for atomic rollback
    const referencingNotesMap = new Map<string, Note>();
    for (const refTitle of referencingTitles) {
      if (refTitle === trimmedOld) continue;
      const refNote = await this.noteRepo.get(refTitle);
      if (refNote) {
        referencingNotesMap.set(refTitle, refNote);
      }
    }

    // Track written files for atomic rollback
    type RollbackAction =
      | { type: "save"; note: Note }
      | { type: "delete"; title: string };

    const rollbackStack: RollbackAction[] = [];
    const updatedReferencingNotes: string[] = [];

    try {
      // 1. Rename the main note file and update its title and self-referential links
      const nowIso = new Date().toISOString();
      const updatedBody = RefactorService.renameWikiLinks(oldNote.body, trimmedOld, trimmedNew);
      const links = NoteParser.extractWikiLinks(updatedBody);

      const renamedNote: Note = {
        ...oldNote,
        title: trimmedNew,
        frontmatter: {
          ...oldNote.frontmatter,
          title: trimmedNew,
          ...(oldNote.frontmatter.updatedAt ? { updatedAt: nowIso } : {}),
        },
        body: updatedBody,
        links,
      };

      await this.noteRepo.save(renamedNote);
      rollbackStack.push({ type: "delete", title: trimmedNew });

      await this.noteRepo.delete(trimmedOld);
      rollbackStack.push({ type: "save", note: oldNote });

      // 2. Refactor incoming Wiki-links across all referencing notes
      for (const [refTitle, refNote] of referencingNotesMap.entries()) {
        const newRefBody = RefactorService.renameWikiLinks(refNote.body, trimmedOld, trimmedNew);
        const refLinks = NoteParser.extractWikiLinks(newRefBody);

        const updatedRefNote: Note = {
          ...refNote,
          body: newRefBody,
          links: refLinks,
          frontmatter: {
            ...refNote.frontmatter,
            ...(refNote.frontmatter.updatedAt ? { updatedAt: nowIso } : {}),
          },
        };

        await this.noteRepo.save(updatedRefNote);
        rollbackStack.push({ type: "save", note: refNote });
        updatedReferencingNotes.push(refTitle);
      }

      // 3. Update SQLite index
      await this.indexStore.renameNote(trimmedOld, trimmedNew);

      // Reconcile index for updated referencing notes so outbound links and mtimes match new body
      for (const refTitle of updatedReferencingNotes) {
        const meta = await this.indexStore.getNoteMetadata(refTitle);
        const savedNote = await this.noteRepo.get(refTitle);
        if (savedNote) {
          await this.indexStore.upsertNote({
            title: refTitle,
            filePath: meta?.filePath ?? `${refTitle}.md`,
            mtime: Date.now(),
            createdAt: meta?.createdAt,
            updatedAt: typeof savedNote.frontmatter.updatedAt === "string" ? savedNote.frontmatter.updatedAt : undefined,
            tags: savedNote.tags,
            links: savedNote.links,
          });
        }
      }

      return {
        oldTitle: trimmedOld,
        newTitle: trimmedNew,
        updatedReferencingNotes,
      };
    } catch (error) {
      // Execute rollback in reverse order
      for (let i = rollbackStack.length - 1; i >= 0; i--) {
        const action = rollbackStack[i];
        try {
          if (action.type === "save") {
            await this.noteRepo.save(action.note);
          } else if (action.type === "delete") {
            await this.noteRepo.delete(action.title);
          }
        } catch {
          // preserve original error
        }
      }
      throw error;
    }
  }
}
