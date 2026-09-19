# Eventual Consistency via Filesystem Reconciliation

Rather than enforcing filesystem locks or running an always-on background daemon process, the Index achieves eventual consistency with the Vault through on-demand timestamp (`mtime`) reconciliation. Operations executed through the application perform immediate write-through updates to both disk and SQLite, while external modifications made by third-party editors are detected and reconciled on command invocation or startup.
