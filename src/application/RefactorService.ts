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
  | { type: "indexRename"; oldTitle: string; newTitle: string }
  | { type: "indexUpsert"; record: NoteRecord };

export class RefactorService {
  constructor(
    private readonly noteRepo: NoteRepository,
    private readonly indexStore: IndexStore
  ) {}

  /**
   * Renames a Note on disk and in the SQLite index, refactoring all incoming Wiki-links across the Vault.
   * Protects vault consistency with an atomic rollback on disk or index write failures.
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
      if (refNote) {
        referencingNotesMap.set(refTitle, refNote);
      }
    }

    const rollbackStack: RollbackAction[] = [];
    const updatedReferencingNotes: string[] = [];

    try {
      // 1. Rename the main note file and update its title and self-referential links
      const nowIso = new Date().toISOString();
      const updatedBody = NoteParser.refactorWikiLinks(oldNote.body, trimmedOld, trimmedNew);
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
      const updatedNotesMap = new Map<string, Note>();
      for (const [refTitle, refNote] of referencingNotesMap.entries()) {
        const newRefBody = NoteParser.refactorWikiLinks(refNote.body, trimmedOld, trimmedNew);
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
      await this.indexStore.renameNote(trimmedOld, trimmedNew);
      rollbackStack.push({ type: "indexRename", oldTitle: trimmedOld, newTitle: trimmedNew });

      // Reconcile index for updated referencing notes so outbound links and mtimes match new body
      for (const refTitle of updatedReferencingNotes) {
        const priorMeta = priorReferencingMeta.get(refTitle);
        if (priorMeta) {
          rollbackStack.push({ type: "indexUpsert", record: priorMeta });
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
          } else if (action.type === "indexRename") {
            await this.indexStore.renameNote(action.newTitle, action.oldTitle);
          } else if (action.type === "indexUpsert") {
            await this.indexStore.upsertNote(action.record);
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
