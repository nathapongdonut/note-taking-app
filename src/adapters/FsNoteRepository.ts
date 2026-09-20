import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Note } from "../domain/Note.js";
import { NoteParser } from "../domain/NoteParser.js";
import type { NoteFileInfo, NoteRepository } from "../ports/NoteRepository.js";

export class FsNoteRepository implements NoteRepository {
  constructor(private readonly vaultDirectory: string) {}

  private getFilePath(title: string): string {
    const sanitizedTitle = title.trim();
    return path.join(this.vaultDirectory, `${sanitizedTitle}.md`);
  }

  private async ensureVaultExists(): Promise<void> {
    await fs.mkdir(this.vaultDirectory, { recursive: true });
  }

  async save(note: Note): Promise<void> {
    await this.ensureVaultExists();
    const filePath = this.getFilePath(note.title);
    const content = NoteParser.serialize(note);
    await fs.writeFile(filePath, content, "utf-8");
  }

  async get(title: string): Promise<Note | null> {
    const filePath = this.getFilePath(title);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return NoteParser.parse(content, title);
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(title: string): Promise<boolean> {
    const filePath = this.getFilePath(title);
    try {
      await fs.unlink(filePath);
      return true;
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async listTitles(): Promise<string[]> {
    await this.ensureVaultExists();
    const entries = await fs.readdir(this.vaultDirectory);
    return entries
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3));
  }

  async exists(title: string): Promise<boolean> {
    const filePath = this.getFilePath(title);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async rename(oldTitle: string, newTitle: string): Promise<void> {
    const oldPath = this.getFilePath(oldTitle);
    const newPath = this.getFilePath(newTitle);

    const note = await this.get(oldTitle);
    if (!note) {
      throw new Error(`Cannot rename note: "${oldTitle}" does not exist.`);
    }

    // Update note's internal title
    note.title = newTitle;
    if (note.frontmatter && typeof note.frontmatter.title === "string") {
      note.frontmatter.title = newTitle;
    }

    await this.save(note);
    if (oldPath !== newPath) {
      await fs.unlink(oldPath);
    }
  }

  async getFileInfo(title: string): Promise<NoteFileInfo | null> {
    const filePath = this.getFilePath(title);
    try {
      const stats = await fs.stat(filePath);
      return {
        title: title.trim(),
        filePath: `${title.trim()}.md`,
        mtime: Math.floor(stats.mtimeMs),
      };
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async listAllFiles(): Promise<NoteFileInfo[]> {
    await this.ensureVaultExists();
    const entries = await fs.readdir(this.vaultDirectory);
    const mdFiles = entries.filter((file) => file.endsWith(".md"));

    const files: NoteFileInfo[] = [];
    for (const file of mdFiles) {
      const title = file.slice(0, -3);
      const fullPath = path.join(this.vaultDirectory, file);
      try {
        const stats = await fs.stat(fullPath);
        files.push({
          title,
          filePath: file,
          mtime: Math.floor(stats.mtimeMs),
        });
      } catch {
        // file removed concurrently
      }
    }
    return files;
  }

  private isNotFoundError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "ENOENT"
    );
  }
}
