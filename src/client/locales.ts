/**
 * \`claudeUltra\` dictionaries.
 *
 * \`tier.description\` renders Claude's own ultracode slider caption ("dynamic
 * workflows on every task") in this plugin's wording.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'tier.label': 'Ultra',
  'tier.description': '对每个实质性任务启用多智能体编排 · 最高用量',
  'error.unsupported': '当前模型没有可用于 Ultra 的推理强度',
} satisfies Record<string, string>

/** The dictionary key union every locale must cover. */
export type CopyKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en: Record<CopyKey, string> = {
  'tier.label': 'Ultra',
  'tier.description': 'Multi-agent orchestration on every substantive task · highest usage',
  'error.unsupported': 'This model exposes no reasoning effort that Ultra can use',
}
