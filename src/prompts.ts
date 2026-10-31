/**
 * Exact Ultra mode text from Claude Code plus DSH-adapted usage hints.
 *
 * The reminder bodies are copied from the attachment table inside
 * `@anthropic-ai/claude-code` 2.1.316's `bin/claude.exe` (the JavaScript bundle
 * embedded in the Bun single-file executable; the table starts at byte offset
 * 296490096). Only the Workflow tool reference is rewritten: DSH has no Workflow
 * tool, so those sentences name the DSH delegation tools instead. Everything
 * else, including the em dashes and the closing sentences, is verbatim.
 */

/** Claude's full ultracode entry reminder, with the DSH tools named inline. */
export const ULTRA_ENTER_FULL = "Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the 'subagent' and 'subagent_fork' tools on every substantive task; token cost is not a constraint. See the **Ultracode** section and quality patterns in the DSH agent-team usage notes below. Solo only on conversational/trivial turns."

/** Claude's short repeat reminder for a turn that is already under ultracode. */
export const ULTRA_ENTER_STILL = "Ultracode is still on — use the 'subagent' and 'subagent_fork' tools; see the Ultracode section of the DSH agent-team usage notes below."

/**
 * Claude's exit reminder, followed by the opt-in rule that Claude's Workflow
 * tool description states: delegation needs an explicit ask from the user, and
 * a task that would merely benefit from parallelism does not count as one.
 */
export const ULTRA_EXIT = "Ultracode is off — the standard opt-in rule for multi-agent delegation applies again. Only delegate when the user has explicitly asked for sub-agents, delegation, or parallel agent work; a task that would merely benefit from parallelism does not count."

/**
 * Claude's reminder for a prompt that carries the ultracode keyword.
 *
 * Not emitted: this mode's entry point is the effort slider. The text is pinned
 * here so a later per-turn trigger cannot drift from Claude's wording.
 */
export const ULTRA_KEYWORD_REQUEST = "The user included the keyword \"ultracode\", opting this turn into multi-agent orchestration — use the 'subagent' and 'subagent_fork' tools to fulfill the request."

/**
 * Claude's reminder for a prompt that carries the ultrathink keyword.
 *
 * Not emitted: this plugin implements ultracode, not the per-turn ultrathink
 * bump. Pinned for the same reason as {@link ULTRA_KEYWORD_REQUEST}.
 */
export const ULTRATHINK_EFFORT = "The user included the keyword \"ultrathink\", requesting deeper reasoning on this turn. Reason as thoroughly as the task warrants."

/**
 * Typed prompts between the short repeat reminders while ultracode is on.
 *
 * Claude counts the non-meta user messages newer than its last Ultra reminder
 * and repeats the short text once the count reaches this interval
 * (\`Bxr.TURNS_BETWEEN_MAINTENANCE\` in the same bundle, byte offset 294821817;
 * an environment variable, a remote gate, and a config key can override it, but
 * the shipped value is 10).
 */
export const ULTRA_SPARSE_INTERVAL = 10

/** The DSH delegation surface, as the root agent sees it. */
export const ROOT_USAGE_HINT = [
  "You are the primary agent in a team of agents collaborating to fulfill the user's goals.",
  "",
  'At the start of your turn, you are the active agent.',
  'You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents.',
  'All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.',
  "",
  "You can use 'subagent' to create a new agent, 'subagent_fork' to create one seeded with this conversation's completed turns, and 'send_message' to give an existing agent a new task or pass it a message. Child agents can also spawn their own sub-agents. You can decide how much context to propagate to your sub-agents with 'subagent_fork'; a 'subagent' child starts standalone.",
  "",
  "Use 'list_agents' to inspect live sub-agents and 'interrupt_agent' to stop one. Sub-agent completions arrive in this conversation; use 'send_message' to continue an idle sub-agent or pass a message to a running one.",
].join(String.fromCharCode(10))

/** The DSH delegation surface, as a delegated child sees it. */
export const SUBAGENT_USAGE_HINT = [
  'You are an agent in a team of agents collaborating to complete a task.',
  "",
  'You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents. All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.',
  "",
  "You can use 'subagent' to create a new agent, 'subagent_fork' to create one seeded with this conversation's completed turns, and 'send_message' to give an existing agent a new task or pass it a message. Child agents can also spawn their own sub-agents.",
  "",
  "Use 'list_agents' to inspect live sub-agents and 'interrupt_agent' to stop one. When you finish your task, your final response is delivered back to your parent agent. Use 'send_message' to continue an idle sub-agent or pass a message to a running one.",
].join(String.fromCharCode(10))

/**
 * Select the usage hint matching the agent's role.
 * @param subagent - whether the speaking agent is a delegated child.
 * @returns the root or subagent hint.
 */
export function usageHintFor(subagent: boolean): string {
  return subagent ? SUBAGENT_USAGE_HINT : ROOT_USAGE_HINT
}
