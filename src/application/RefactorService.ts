import type { Note } from "../domain/Note.js";
import { NoteParser } from "../domain/NoteParser.js";
import type { NoteRepository } from "../ports/NoteRepository.js";
import type { IndexStore, NoteRecord } from "../ports/IndexStore.js";

export interface RenameNoteResult {
  oldTitle: string;
  newTitle: string;
  updatedReferencingNotes: string[];
}

export class RefactorRollbackError extends Error {
  constructor(
    message: string,
    public readonly triggerError: unknown,
    public readonly rollbackErrors: Error[]
  ) {
    super(message);
    this.name = "RefactorRollbackError";
  }
}

type RollbackAction =
  | { type: "save"; note: Note }
  | { type: "delete"; title: string }
  | {
      type: "indexTargetRollback";
      oldTitle: string;
      newTitle: string;
      priorMeta: NoteRecord | null;
    }
  | { type: "indexUpsert"; record: NoteRecord }
  | { type: "indexDelete"; title: string };

export class RefactorService {
  constructor(
    private readonly noteRepo: NoteRepository,
    private readonly indexStore: IndexStore
  ) {}

  /**
   * Refactors the renamed target Note's title, body, Wiki-links, and frontmatter.
   */
  private refactorTargetNote(
    note: Note,
    oldTitle: string,
    newTitle: string,
    nowIso: string
  ): Note {
    const updatedBody = NoteParser.refactorWikiLinks(note.body, oldTitle, newTitle);
    const links = NoteParser.extractWikiLinks(updatedBody);

    return {
      ...note,
      title: newTitle,
      body: updatedBody,
      links,
      frontmatter: {
        ...note.frontmatter,
        title: newTitle,
        ...(note.frontmatter.updatedAt ? { updatedAt: nowIso } : {}),
      },
    };
  }

  /**
   * Refactors incoming Wiki-links across a referencing Note without mutating its title.
   */
  private refactorReferencingNote(
    note: Note,
    oldTitle: string,
    newTitle: string,
    nowIso: string
  ): Note {
    const updatedBody = NoteParser.refactorWikiLinks(note.body, oldTitle, newTitle);
    const links = NoteParser.extractWikiLinks(updatedBody);

    return {
      ...note,
      body: updatedBody,
      links,
      frontmatter: {
        ...note.frontmatter,
        ...(note.frontmatter.updatedAt ? { updatedAt: nowIso } : {}),
      },
    };
  }

  /**
   * Renames a Note in the Vault and SQLite index, refactoring all incoming Wiki-links across referencing Notes.
   * Protects consistency with an atomic compensating rollback on disk or index write failures.
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
    const referencingTitles = await this.indexStore.getBacklinks(trimmedOld);

    // Snapshot referencing notes for atomic rollback
    const referencingNotesMap = new Map<string, Note>();
    for (const refTitle of referencingTitles) {
      if (refTitle === trimmedOld) continue;
      const refNote = await this.noteRepo.get(refTitle);
      if (!refNote) {
        throw new Error(
          `Cannot refactor note "${trimmedOld}": referencing note "${refTitle}" found in index does not exist in the vault.`
        );
      }
      referencingNotesMap.set(refTitle, refNote);
    }

    const rollbackStack: RollbackAction[] = [];
    const updatedReferencingNotes: string[] = [];

    try {
      // 1. Rename target Note in the Vault and update its title and self-referential Wiki-links
      const nowIso = new Date().toISOString();
      const renamedNote = this.refactorTargetNote(oldNote, trimmedOld, trimmedNew, nowIso);

      rollbackStack.push({ type: "delete", title: trimmedNew });
      await this.noteRepo.save(renamedNote);

      rollbackStack.push({ type: "save", note: oldNote });
      await this.noteRepo.delete(trimmedOld);

      // 2. Refactor incoming Wiki-links across all referencing notes
      const updatedNotesMap = new Map<string, Note>();
      for (const [refTitle, refNote] of referencingNotesMap.entries()) {
        const updatedRefNote = this.refactorReferencingNote(
          refNote,
          trimmedOld,
          trimmedNew,
          nowIso
        );

        // Skip notes whose body did not change (e.g. backlink was in code block or stale)
        if (updatedRefNote.body === refNote.body) {
          continue;
        }

        rollbackStack.push({ type: "save", note: refNote });
        await this.noteRepo.save(updatedRefNote);
        updatedNotesMap.set(refTitle, updatedRefNote);
        updatedReferencingNotes.push(refTitle);
      }

      // Snapshot pre-rename index state of referencing notes before index mutations for rollback
      const priorReferencingMeta = new Map<string, NoteRecord>();
      for (const refTitle of updatedReferencingNotes) {
        const meta = await this.indexStore.getNoteMetadata(refTitle);
        if (meta) {
          priorReferencingMeta.set(refTitle, meta);
        }
      }

      // 3. Update SQLite index
      const priorTargetMeta = await this.indexStore.getNoteMetadata(trimmedOld);
      await this.indexStore.renameNote(trimmedOld, trimmedNew);
      rollbackStack.push({
        type: "indexTargetRollback",
        oldTitle: trimmedOld,
        newTitle: trimmedNew,
        priorMeta: priorTargetMeta,
      });

      // Update index for renamed target Note to match title, links, tags, and frontmatter
      const targetMetaAfterRename = await this.indexStore.getNoteMetadata(trimmedNew);
      if (targetMetaAfterRename) {
        await this.indexStore.upsertNote({
          ...targetMetaAfterRename,
          updatedAt:
            typeof renamedNote.frontmatter.updatedAt === "string"
              ? renamedNote.frontmatter.updatedAt
              : undefined,
          tags: renamedNote.tags,
          links: renamedNote.links,
        });
      }

      // Update index for referencing Notes whose Wiki-links were refactored
      for (const refTitle of updatedReferencingNotes) {
        const priorMeta = priorReferencingMeta.get(refTitle);
        if (priorMeta) {
          rollbackStack.push({ type: "indexUpsert", record: priorMeta });
        } else {
          rollbackStack.push({ type: "indexDelete", title: refTitle });
        }

        const updatedNote = updatedNotesMap.get(refTitle);
        if (updatedNote) {
          await this.indexStore.upsertNote({
            title: refTitle,
            filePath: priorMeta?.filePath ?? `${refTitle}.md`,
            mtime: Date.now(),
            createdAt: priorMeta?.createdAt,
            updatedAt:
              typeof updatedNote.frontmatter.updatedAt === "string"
                ? updatedNote.frontmatter.updatedAt
                : undefined,
            tags: updatedNote.tags,
            links: updatedNote.links,
          });
        }
      }

      return {
        oldTitle: trimmedOld,
        newTitle: trimmedNew,
        updatedReferencingNotes,
      };
    } catch (triggerError) {
      // Execute rollback in reverse order
      const rollbackErrors: Error[] = [];
      for (let i = rollbackStack.length - 1; i >= 0; i--) {
        const action = rollbackStack[i];
        try {
          if (action.type === "save") {
            await this.noteRepo.save(action.note);
          } else if (action.type === "delete") {
            await this.noteRepo.delete(action.title);
          } else if (action.type === "indexTargetRollback") {
            await this.indexStore.renameNote(action.newTitle, action.oldTitle);
            if (action.priorMeta) {
              await this.indexStore.upsertNote(action.priorMeta);
            }
          } else if (action.type === "indexUpsert") {
            await this.indexStore.upsertNote(action.record);
          } else if (action.type === "indexDelete") {
            await this.indexStore.deleteNote(action.title);
          }
        } catch (err) {
          rollbackErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }

      if (rollbackErrors.length > 0) {
        throw new RefactorRollbackError(
          `Rollback failed during note refactoring: ${rollbackErrors.map((e) => e.message).join("; ")}`,
          triggerError,
          rollbackErrors
        );
      }

      throw triggerError;
    }
  }
}
