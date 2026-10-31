---
description: "Claude-style Ultra mode for DSH: the top reasoning effort plus Claude's standing multi-agent orchestration."
kind: "package-bundle"
---

# dsh-claude-ultra

English | [中文](README.zh.md)

## Summary

Adds Claude's **Ultra** mode to DSH. Ultra is a fifth tier on the [Codex effort switcher](https://github.com/AndyZh0/dsh-codex-effort-switcher)'s slider, above the model's own levels. Selecting it runs the session at the model's highest reasoning effort and keeps multi-agent orchestration standing, carrying the same instruction Claude Code carries when ultracode is on.

This package is the Host and browser half of the mode. The browser half reads the switcher's `codexModelTiers` client service, so **`dsh-codex-effort-switcher` 0.2.0 or newer must be installed in the same profile**. Without the switcher this package contributes no tier and the composer keeps its shipped picker.

## Table of Contents

- [Install](#install)
- [Use](#use)
- [How it works](#how-it-works)
- [Claude source](#claude-source)
- [Compatibility](#compatibility)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Develop and verify](#develop-and-verify)

-----

<a id="install"></a>
## Install

Build the package inside this directory; development dependencies and artifacts stay here. Use a Node.js version supported by DSH.

```powershell
npm install --ignore-scripts --workspaces=false
npm run build
npm pack
dsh plugin --profile <profile> add "./dsh-claude-ultra-0.1.4.tgz"
```

Install into the profile you actually use. `dsh plugin add` appends the bundle row and runs pnpm inside the profile directory. A profile composes its bundle rows at boot, so restart the app afterwards; `patchReload: live` reloads patch and config edits, not a new bundle row.

`dsh --profile web --dump-config` should list `dsh-codex-effort-switcher` and `dsh-claude-ultra` and print no "incompatible" line. The card then shows a fifth cell labelled **Ultra** above Max.

Reinstalling the same version is a no-op for pnpm: after rebuilding, `dsh plugin --profile web remove dsh-claude-ultra` then add it again, or the profile keeps serving the previous `lib/client.js`.

<a id="use"></a>
## Use

Click the model chip, choose a model that advertises a reasoning effort, and click the last cell. The trigger reads `<model> Ultra`, and the slider takes the violet top-tier treatment.

The next model request carries the mapped effort and a system-prompt section holding Claude's ultracode instruction plus the DSH agent-team usage notes. The mode stays active for later requests and for child agents. Choosing any lower level, in this card or through `/model`, makes the next assembly materialize Claude's exit text instead.

A prompt that contains the whole word `ultracode` opts that turn into orchestration even when the tier is not selected, which is Claude's keyword trigger. A prompt that contains `ultrathink` instead raises that turn's effort to the model's top level without moving the tier. The matcher is Claude's: a prompt that starts with a slash command is ignored, as is a keyword inside quotes, backticks, brackets or braces, and one glued to a path separator or a file extension. Each keyword contributes its own section, beside the standing one when the tier is active.

The mode is durable: it is folded from the logged `system/message` into the `claudeUltraMode` session projection, so a reload or a resume restores the fifth cell without a new request.

<a id="how-it-works"></a>
## How it works

1. The switcher appends the tier to its effort choices. `available(model)` is true when the model advertises a reasoning effort, and `effort(model)` maps `max` first, otherwise the highest advertised non-`off` level.
2. Applying the tier first calls the standard model-selection path with that mapped effort. The Host receives the same `session.selectModel` that `/model` uses; there is no second selection path.
3. The browser then calls `/api/dsh-claude-ultra/arm` with the session, provider, model, and mapped effort. The Host validates the route through `llm.resolveModelInfo` and `llm.resolveCallConfig` and stores an in-memory arm for that session.
4. The next system-prompt assembly matches the arm against the session's pending or last-used selection. A match materializes the entry text; a selection after an entry snapshot materializes the exit text; a child agent with no snapshot of its own inherits an active parent.
5. The `system/message` that carries the sections is logged. The `claudeUltraMode` projection folds that text, the `model/selection` events, and the newest typed prompt into `{ mode, dirty, keyword }`, where `mode` is `'full'`, `'still'`, `'off'`, or `null` and `keyword` records whether that prompt carries the ultracode keyword. The tier's active face is "an entry mode and not dirty", so a lower selection turns the fifth cell off immediately while the next request still receives the exit text.
6. The `agent/request` listener consumes the arm after the request it armed, and a later selection, agent disposal, or session teardown cannot reuse a stale intent.

### Why a system-prompt section

A section appended by the `system-prompt/assemble` waterfall is retained by the assembly and by the later runtime-context refresh, is model-visible, and is logged in the system message. A `systemPrompt.context()` contribution is optional by default and is dropped whenever a suppressor is active in the scope, which would leave the mode invisible to the model. The section survives unless some registered section sets `complete: true`; the shipped Standard preset does not.

### No DSH package dependency

The Host half imports no `@deepseek-ai/*` module: it reads the services it needs off the injected context through the structural views in `src/ports.ts`. That is not only a packaging convenience — the published `@deepseek-ai/dsh-llm`, `-session`, `-system-prompt`, and `-session-projection` versions on npm (0.0.1-rc.1) do not match the running runtime (0.2.0-rc.2 from a checkout, 0.2.1-rc.5 from the desktop runtime), so installing them is not possible. `zod` is the only runtime dependency and it is inlined into `lib/index.js`.

<a id="claude-source"></a>
## Claude source

The reminder bodies are copied from the attachment table inside `@anthropic-ai/claude-code` 2.1.316's `bin/claude.exe` — the JavaScript bundle embedded in the Bun single-file executable. The table starts at byte offset `296490096`; the effort scale and the `ultracode` alias are at `282594834` and `286520088`.

Claude's ultracode is a session-scoped switch that sits beside the effort levels on the effort slider (`effortSlider:toggleUltracode`, bound to Tab) and maps to `xhigh` when it is passed as an effort value (`{ ultracode: "xhigh" }`). DSH models advertise their own levels, so this plugin takes the model's top level — `max` on DeepSeek-V41-Flash.

Verbatim, with one substitution: DSH has no Workflow tool, so `the Workflow tool` becomes `the 'subagent' and 'subagent_fork' tools`, and `the workflow authoring reference` becomes `the DSH agent-team usage notes below`. Everything else, including the em dashes and the closing sentences, is unchanged.

| Claude attachment | Text used here |
|---|---|
| `ultra_effort_enter` (full) | Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the 'subagent' and 'subagent_fork' tools on every substantive task; token cost is not a constraint. See the **Ultracode** section and quality patterns in the DSH agent-team usage notes below. Solo only on conversational/trivial turns. |
| `ultra_effort_enter` (sparse) | Ultracode is still on — use the 'subagent' and 'subagent_fork' tools; see the Ultracode section of the DSH agent-team usage notes below. |
| `ultra_effort_exit` | Ultracode is off — the standard opt-in rule for multi-agent delegation applies again. Only delegate when the user has explicitly asked for sub-agents, delegation, or parallel agent work; a task that would merely benefit from parallelism does not count. |
| `workflow_keyword_request` | The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the 'subagent' and 'subagent_fork' tools to fulfill the request. |
| `ultrathink_effort` | The user included the keyword "ultrathink", requesting deeper reasoning on this turn. Reason as thoroughly as the task warrants. |

The exit text's second sentence restates the opt-in rule from Claude's Workflow tool description (`ONLY call this tool when the user has explicitly opted into multi-agent orchestration…`), which is the rule the first sentence refers to.

<a id="compatibility"></a>
## Compatibility

- Verified against DSH `0.2.1-rc.5` (the desktop runtime that serves a `web` profile) and the `0.2.0-rc.2` checkout.
- `dsh-codex-effort-switcher` 0.2.0 or newer, in the same profile.
- Web platform client bundles; the Host half is a normal bundle patch row.
- No DSH core changes and no new session event type: the mode rides the existing `system/message`, `user/message`, and `model/selection` events, so `SESSION_FORMAT_VERSION` is unchanged.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **The switcher is required.** `dsh-codex-effort-switcher` must be in the same profile. The client half reads its `codexModelTiers` service through `ctx.get` rather than `ctx.inject`, because a pending inject is reported by the client boot audit as a failed plugin load and blanks the whole surface; a composition without the switcher therefore loads normally and simply contributes no tier.
- **Reminder cadence.** Claude emits the entry reminder on the first turn and then a sparse one every 10 user turns (`Uxr()`), and the exit reminder once. Here the entry reminder is re-emitted on every assembly (full first, then the still-on text) and the exit text is re-emitted while the mode is off. Claude's reminders are message attachments, so repeating them would grow its transcript; this section is rebuilt into each request's system prompt, where repeating costs no context. The text is Claude's; the frequency is the DSH-native equivalent.
- **The `ultrathink` boost is undone at the turn's end.** DSH keeps the effort in the request header, which every later request inherits, so a boost that only rewrote the request config would raise the Session for good. The turn's end submits a selection restoring what the boost displaced, through `ctx.get('sessionController')` rather than an injection, so a composition without that service still loads and the boost then lasts until the Session's next selection. A selection the user makes during the boosted turn cancels the undo instead of being overwritten by it, and a prompt queued mid-turn loses its boost to the same `turn/end` — unlike the `ultracode` opt-in, which the turn that claims the prompt consumes.
- **Default selection save.** The standard `session.selectModel` path also saves the selection as the profile default where DSH does so, so selecting Ultra can leave the top level as the saved default for new sessions. The saved value carries the effort but not the mode, so a new session can start at that level without Ultra's instruction. This is the switcher's shared selection path, not a separate Ultra path.
- **The arm is in memory until the first request.** Selecting Ultra and reloading before sending a prompt loses the local cell. After the first request the logged system message restores it.
- **Uninstall leaves history.** Removing the plugin stops new Ultra sections and removes the fifth cell, but an existing session's logged system prompt still contains the mode text; resuming that session shows the old instruction.
- **No fallback for a model without reasoning.** The tier is hidden when a model advertises no non-`off` effort.
- **`complete: true` sections win.** A preset that registers a complete section replaces every other section after the waterfall, which would drop this one. The shipped Standard preset does not.
- **Fork and concurrency.** A fork taken before the first Ultra request has no mode; a fork after it inherits the projected state with the rest of the transcript. The arm is per session.

<a id="develop-and-verify"></a>
## Develop and verify

```powershell
npm run typecheck
npm test
npm run smoke
```

`npm test` builds the Host bundle and the Node-loadable browser bundle and runs 184 assertions over the effort mapping, the arm store, the projection fold, the pinned prompt text, the reminder resolution, the keyword matcher and its store, the arm route's every branch, and the browser tier. Each spec has a recorded negative proof.

`npm run smoke` is the end-to-end lane, and the only one that proves the wiring rather than the units. It packs and installs both plugins into a throwaway `DSH_HOME` profile through the built CLI, points a fixture provider at a local OpenAI-compatible endpoint that records every request body, boots `dsh web` from the checkout, and drives Microsoft Edge through the real card. It asserts that the fifth Ultra tier exists, that selecting it routes `reasoning_effort: max` and carries the entry section, that a prompt containing `ultracode` at a lower tier carries the keyword section instead, and that the opt-in does not survive into the next turn. It needs the switcher beside this package (or `DSH_SWITCHER_TGZ` pointing at a packed archive), a built DSH checkout, and Microsoft Edge; evidence lands under `.runtime/browser-*`.

A turn also fires a session-title call that carries neither the tools nor the effort, so the smoke selects the turn's request by its tool schemas.

`tests/decode-session.mjs` reads a session log and reduces it to the per-turn facts a verification cares about. A log is a concatenation of zstd frames, which neither `zstdDecompressSync` nor a stream decoder spans, so the boundaries are found from the frame magic; an undecoded slice is carried forward rather than dropped, which also absorbs a torn tail:

```powershell
node tests/decode-session.mjs "$env:USERPROFILE/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd"
```

`.runtime/no-switcher.overlay.yml` is a `--patch` overlay that disables the switcher, for reproducing the degradation path:

```powershell
dsh --profile web --patch ".runtime/no-switcher.overlay.yml" --no-open --port 0
```

Published packages ship `lib/`, the patch, and the READMEs only; the suites, the smoke, and the evidence stay out of the archive.

## License

MIT
