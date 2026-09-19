import type { Note, NoteFrontmatter } from "../domain/Note.js";
import type { NoteRepository } from "../ports/NoteRepository.js";
import type { IndexStore, NoteRecord } from "../ports/IndexStore.js";

export interface CreateNoteInput {
  title: string;
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
      body: input.body ? input.body.trim() : "",
    };

    await this.noteRepo.save(note);

    const record: NoteRecord = {
      title,
      filePath: `${title}.md`,
      mtime: Date.now(),
      createdAt: nowIso,
      updatedAt: nowIso,
      tags,
    };
    await this.indexStore.upsertNote(record);

    return note;
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
   * Lists all existing note titles in the Vault.
   */
  async listAllTitles(): Promise<string[]> {
    return this.noteRepo.listTitles();
  }
}
