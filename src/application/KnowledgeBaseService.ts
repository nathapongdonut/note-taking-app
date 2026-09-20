import type { Note, NoteFrontmatter } from "../domain/Note.js";
import { NoteParser } from "../domain/NoteParser.js";
import type { NoteRepository } from "../ports/NoteRepository.js";
import type { IndexStore, NoteRecord } from "../ports/IndexStore.js";

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
   * Lists all existing note titles in the Vault.
   */
  async listAllTitles(): Promise<string[]> {
    return this.noteRepo.listTitles();
  }
}
