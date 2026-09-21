# Personal Knowledge Base

A local-first personal knowledge management system for organizing interconnected study notes, ideas, and concepts.

## Language

**Note**:
A Markdown document representing a discrete concept, idea, or record.
_Avoid_: Memo, file, page, scratchpad, ticket

**Vault**:
The root directory containing the entire collection of notes and their attachments.
_Avoid_: Workspace, database, notebook, library

**Frontmatter**:
A structured metadata section at the beginning of a Note specifying its title, timestamps, and tags.
_Avoid_: Header, properties, metadata block

**Wiki-link**:
A reference syntax (`[[Note Title]]`) inside a Note's body that connects it to another Note.
_Avoid_: Internal link, hyperlink, cross-reference

**Backlink**:
An incoming link pointing to a Note from another Note that references it via a Wiki-link.
_Avoid_: Reverse link, incoming reference, citation

**Tag**:
A category keyword prefixed with `#` or listed in frontmatter to classify Notes by topic.
_Avoid_: Label, category, group

**Index**:
An embedded queryable data store that caches Note metadata, tags, and link connections extracted from the Vault.
_Avoid_: Master database, cache store

**Ghost Note**:
A referenced concept that appears inside a Wiki-link but has not yet been authored as a Note in the Vault.
_Avoid_: Missing note, uncreated note, broken link, dangling pointer

**Reconciliation**:
The process of inspecting file modification timestamps (`mtime`) on disk to synchronize the Index with external changes.
_Avoid_: Refresh, reindex, reload, scan

**Refactoring**:
The automated rewriting of Wiki-links referencing a Note (including incoming backlinks across the Vault and self-referential links) when its title changes.
_Avoid_: Link update, link migration, manual retargeting


