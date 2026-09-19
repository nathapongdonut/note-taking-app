# Decoupled Core Domain Library with CLI Adapter

We implement the core application logic (Note parsing, Vault management, Indexing, and Link graphing) as an independent, testable TypeScript library, exposing user interactions via a Command-Line Interface (CLI) adapter. This establishes a clean architectural boundary (Ports and Adapters), ensuring the domain logic is decoupled from user-interface technologies and can accommodate a web or GUI adapter in the future without modification.
