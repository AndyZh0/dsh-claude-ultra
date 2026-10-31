/**
 * Wire vocabulary shared by the Host route and the browser half.
 */

/** Shared Connection channel carrying Ultra traffic. */
export const CLAUDE_ULTRA_API_CHANNEL = '/api'

/** Channel-relative endpoint the browser half calls. */
export const CLAUDE_ULTRA_ARM_ENDPOINT = 'dsh-claude-ultra/arm'

/** Absolute Fetch route registering the endpoint. */
export const CLAUDE_ULTRA_ARM_PATH = CLAUDE_ULTRA_API_CHANNEL + '/' + CLAUDE_ULTRA_ARM_ENDPOINT

/** Session projection key owned by this plugin. */
export const CLAUDE_ULTRA_PROJECTION_KEY = 'claudeUltraMode'

/** Stable system-prompt section that carries the mode to every model request. */
export const CLAUDE_ULTRA_SYSTEM_SECTION = 'claude-ultra:mode'

/** Stable system-prompt section that carries a turn's keyword opt-in. */
export const CLAUDE_ULTRA_KEYWORD_SECTION = 'claude-ultra:keyword'
