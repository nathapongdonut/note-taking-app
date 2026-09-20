import type { KnowledgeBaseService } from "../application/KnowledgeBaseService.js";

export interface CliIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

export async function runCli(
  args: string[],
  service: KnowledgeBaseService,
  io: CliIo = { log: console.log, error: console.error }
): Promise<number> {
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    io.log(`Usage: notes <command> [options]

Commands:
  create <title> [--body "<text>"] [--tags "<tag1,tag2>"]   Create a new note
  view <title>                                              View a note's content
  search --tag <tag>                                        Search notes by tag
  backlinks <title>                                         List incoming backlinks for a note
  ghost-notes                                               List Ghost Notes referenced via Wiki-links
  rename <old-title> <new-title>                            Rename note and refactor incoming Wiki-links
`);
    return 0;
  }

  try {
    switch (command) {
      case "create": {
        const title = rest[0];
        if (!title || title.startsWith("--")) {
          io.error("Error: Please provide a title for the note.");
          return 1;
        }

        let body = "";
        let tags: string[] = [];

        for (let i = 1; i < rest.length; i++) {
          if (rest[i] === "--body" && rest[i + 1] !== undefined) {
            body = rest[i + 1];
            i++;
          } else if (rest[i] === "--tags" && rest[i + 1] !== undefined) {
            tags = rest[i + 1].split(",").map((t) => t.trim()).filter(Boolean);
            i++;
          }
        }

        const note = await service.createNote({ title, body, tags });
        io.log(`Created note "${note.title}" successfully.`);
        if (note.tags.length > 0) {
          io.log(`Tags: ${note.tags.join(", ")}`);
        }
        return 0;
      }

      case "view": {
        const title = rest[0];
        if (!title) {
          io.error("Error: Please specify the note title to view.");
          return 1;
        }

        const note = await service.getNote(title);
        if (!note) {
          io.error(`Error: Note "${title}" not found.`);
          return 1;
        }

        const backlinks = await service.getBacklinks(note.title);

        io.log(`========================================`);
        io.log(`Title: ${note.title}`);
        if (note.tags.length > 0) {
          io.log(`Tags:  ${note.tags.join(", ")}`);
        }
        io.log(`========================================\n`);
        io.log(note.body || "(empty note body)");
        io.log(`\n========================================`);
        if (backlinks.length === 0) {
          io.log(`Backlinks: (none)`);
        } else {
          io.log(`Backlinks:`);
          for (const link of backlinks) {
            io.log(`  • ${link}`);
          }
        }
        io.log(`========================================`);
        return 0;
      }

      case "search": {
        let tagToSearch: string | undefined;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--tag" && rest[i + 1] !== undefined) {
            tagToSearch = rest[i + 1];
            break;
          }
        }

        if (!tagToSearch) {
          io.error("Error: Please specify a tag to search using --tag <tag>.");
          return 1;
        }

        const matchingTitles = await service.searchByTag(tagToSearch);
        if (matchingTitles.length === 0) {
          io.log(`No notes found with tag "${tagToSearch}".`);
        } else {
          io.log(`Notes matching tag "${tagToSearch}":`);
          for (const t of matchingTitles) {
            io.log(`  • ${t}`);
          }
        }
        return 0;
      }

      case "backlinks": {
        const title = rest[0];
        if (!title) {
          io.error("Error: Please specify the note title to find backlinks for.");
          return 1;
        }

        const backlinks = await service.getBacklinks(title);
        if (backlinks.length === 0) {
          io.log(`No backlinks found for "${title}".`);
        } else {
          io.log(`Backlinks for "${title}":`);
          for (const link of backlinks) {
            io.log(`  • ${link}`);
          }
        }
        return 0;
      }

      case "ghost-notes": {
        const ghostNotes = await service.getGhostNotes();
        if (ghostNotes.length === 0) {
          io.log("No ghost notes found.");
        } else {
          io.log("Ghost notes:");
          for (const ghost of ghostNotes) {
            io.log(`  • ${ghost.targetTitle} (referenced by: ${ghost.referencedBy.join(", ")})`);
          }
        }
        return 0;
      }

      case "rename": {
        const oldTitle = rest[0];
        const newTitle = rest[1];

        if (!oldTitle || !newTitle || oldTitle.startsWith("--") || newTitle.startsWith("--")) {
          io.error("Error: Please provide both old and new note titles: notes rename <old-title> <new-title>.");
          return 1;
        }

        const result = await service.renameNote(oldTitle, newTitle);
        io.log(`Renamed note "${result.oldTitle}" to "${result.newTitle}".`);
        io.log("Modified files:");
        io.log(`  • ${result.newTitle}.md`);
        for (const title of result.updatedReferencingNotes) {
          io.log(`  • ${title}.md`);
        }
        if (result.updatedReferencingNotes.length === 0) {
          io.log("No referencing notes needed updates.");
        } else {
          io.log(`Updated ${result.updatedReferencingNotes.length} referencing note(s):`);
          for (const title of result.updatedReferencingNotes) {
            io.log(`  • ${title}`);
          }
        }
        return 0;
      }

      default: {
        io.error(`Unknown command: "${command}". Run "notes --help" for available commands.`);
        return 1;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.error(`Error: ${message}`);
    return 1;
  }
}
