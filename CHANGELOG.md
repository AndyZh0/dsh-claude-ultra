# Changelog

Every version below is also a [GitHub release](https://github.com/AndyZh0/dsh-claude-ultra/releases) with the same notes and the packed archive attached. Nothing here is released without a green unit suite, a green end-to-end smoke, and a recorded negative proof for each behaviour it adds.

The version tracks this package, not an API: it ships a bundle for a DSH profile rather than a library other code imports.

## 0.1.7 — 2026-11-01

### Added

- **`npm run smoke:noswitcher`**, a second end-to-end lane for the composition without `dsh-codex-effort-switcher`. The plugin's worst historical failure was a client boot audit failure that blanked the whole GUI, and the lane also proves the `ultracode` and `ultrathink` keyword triggers work with no switcher installed at all.
- The shared smoke harness both lanes now run on, extracted from the original lane.
- This changelog.

### Fixed

- **The `ultrathink` boost could be wiped by the previous turn.** It was cleared on the session's `turn/end`, which lands about a tenth of a second after the reply renders, so a prompt typed in that window was inserted first and then had its boost cleared by the turn that had just finished. A prompt queued mid-turn lost it the same way. The boost is now bound to the turn that **claims** the prompt, and only that turn's end releases it.

  The new lane found this on its first three runs; the switcher lane could not, because the race is in the gap between a reply rendering and its turn ending.

## 0.1.6 — 2026-11-01

### Fixed

- **`ultrathink` was matched more strictly than Claude matches it.** Both keywords were going through the span-aware matcher ported for `ultracode`, but Claude's ultrathink reminder emitter guards on `/\bultrathink\b/i`; its span-aware matcher drives only the composer highlight. A quoted, backticked, slash-prefixed or dotted `ultrathink` now boosts, as it does in Claude.

### Documented

- Claude's keyword family also names `ultraplan` and `ultrareview`, and this plugin does not carry them. Neither is part of the reminder family, whose attachment table lists exactly four Ultra entries.

## 0.1.5 — 2026-11-01

### Changed

- **The Ultra reminder now follows Claude's cadence.** Claude emits the full text on the first turn under Ultra, the short text once every ten typed prompts, the exit text once when the mode ends, and nothing at all on the turns in between. This plugin had repeated the entry text on every assembly and the exit text for as long as the mode stayed off.

### Fixed

- A child agent whose own snapshot had left Ultra now inherits an active parent instead of staying quiet. The old behaviour was an artifact of the early return that re-emitted the last snapshot, not a decision.

## 0.1.4 — 2026-11-01

### Added

- **The `ultrathink` keyword.** A prompt containing it raises that turn to the model's top effort without moving the tier, and carries Claude's `ultrathink_effort` reminder.

### Fixed

- **The boost no longer raises the Session for good.** DSH keeps the effort in the request header and its selection projection reads `lastUsed` from every `request/header`, so a boost that only rewrote one config persisted. The turn's end now restores what the boost displaced. The end-to-end smoke caught this; it asserts the seat stays on the tier's level after an ultrathink turn.

## 0.1.3 — 2026-11-01

### Added

- **`npm run smoke`**, an end-to-end lane that packs and installs both plugins into a throwaway `DSH_HOME`, points a fixture provider at a local OpenAI-compatible endpoint that records every request body, boots `dsh web` from the checkout, and drives Microsoft Edge through the real card.
- **`tests/decode-session.mjs`**, which reads a session log — a concatenation of zstd frames that neither `zstdDecompressSync` nor a stream decoder spans — and reduces it to per-turn facts.

## 0.1.2 — 2026-11-01

### Added

- **The `ultracode` keyword.** A prompt containing the whole word opts its turn into multi-agent orchestration without moving the tier, matching Claude's `workflow_keyword_request` reminder.

### Fixed

- The keyword opt-in is held in memory rather than folded from the session log. DSH appends `system/message` before `user/message`, so a fold trails the turn by one; and `agent/inbox/claimed` fires inside `inbox.claim`, before the assembly that needs it. `agent/inbox/inserted` is the point that precedes the assembly and still carries the prompt the human typed.

## 0.1.1 — 2026-11-01

### Changed

- The install example names the archive the release actually attaches.
- The switcher is linked by URL, and the package declares its repository, homepage, bugs, and keywords.

## 0.1.0 — 2026-11-01

### Added

- The fifth **Ultra** tier, contributed to `dsh-codex-effort-switcher`, mapping to the model's top advertised effort.
- The Ultra mode: Claude's entry, repeat, and exit texts, pinned verbatim apart from the tool names DSH actually has, carried in a `system-prompt/assemble` section.
- A durable projection folded from the logged system messages, so the mode survives reload, restart, and resume without a new session event type.
