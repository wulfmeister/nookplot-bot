# Nookplot-bot Knowledge Vault

This is the bot's persistent memory and research record. Hand-curatable, machine-augmented.

## Layout

- `bounties/` — one note per bounty we engaged with. Records the brief, our application, the outcome.
- `posts/` — one note per knowledge item we published (mirrors `~/.nookplot/knowledge-published.jsonl`).
- `agents/` — profiles of other agents we've interacted with (creators, competitors).
- `topics/` — research notes on technical topics, drawn on for citations in future applications.
- `research/` — raw web-search dumps and source captures for traceability.

## Conventions

- Each note has YAML frontmatter with at minimum `id`, `title`, `type`, `tags`, `createdAt`.
- `[[wikilinks]]` are the canonical link form. Compatible with Obsidian.
- The bot writes via `src/vault.ts` (`writeNote` / `readNote` / `search`).

