/**
 * Built-plugin smoke through an isolated, supported dsh web profile and a local
 * model endpoint.
 *
 * Proves what the unit suite cannot: that the installed bundle registers the
 * fifth Ultra tier, that selecting it routes the model's top effort to the wire,
 * that Claude's ultracode sections reach the request, and that the ultracode
 * keyword opts a turn in without moving the tier.
 *
 * It packs and installs both plugins, so it needs dsh-codex-effort-switcher
 * beside this package (or DSH_SWITCHER_TGZ pointing at a packed archive) and a
 * built checkout (pnpm run build in the repository root).
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

/** The whole reply the fixture streams back, and what the transcript shows. */
const REPLY = 'claude ultra smoke passed'

const root = resolve('../..')
const cli = resolve(root, 'apps/cli/lib/bin.js')

await mkdir('.runtime', { recursive: true })
const run = await mkdtemp(resolve('.runtime/browser-'))
const environment = { ...process.env, DSH_HOME: resolve(run, 'home'), DSH_CLAUDE_ULTRA_TEST_KEY: 'local-fixture' }

/** Pack one plugin directory and return the archive path. */
function pack(directory) {
  const packed = spawnSync('npm', ['pack', '--silent'], { cwd: directory, shell: true, encoding: 'utf8', timeout: 180000 })
  assert.equal(packed.status, 0, 'npm pack failed in ' + directory + ': ' + packed.stderr)
  return resolve(directory, packed.stdout.trim().split(/\r?\n/).pop())
}

const ourTarball = pack(resolve('.'))
const switcherTarball = process.env.DSH_SWITCHER_TGZ ?? pack(resolve(root, 'plugins/codex-effort-switcher'))

// The packed archive is what a profile installs, so pack rather than pointing
// the profile at lib/. The switcher goes first: the bundle row order is what
// publishes codexModelTiers before this plugin reads it.
for (const tarball of [switcherTarball, ourTarball]) {
  const installer = spawnSync(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', tarball], {
    cwd: root, windowsHide: true, env: environment, encoding: 'utf8', timeout: 180000,
  })
  await writeFile(resolve(run, 'install-' + tarball.split(/[\\/]/).pop() + '.log'), (installer.stdout ?? '') + (installer.stderr ?? ''))
  assert.equal(installer.status, 0, 'plugin install failed for ' + tarball + ': ' + installer.stderr)
}
const installed = JSON.parse(await readFile(resolve(run, 'home/profiles/web/package.json'), 'utf8'))
const bundles = installed.dsh.profile.bundles
assert.ok(bundles.includes('dsh-claude-ultra'), 'the bundle row was not added: ' + JSON.stringify(bundles))
assert.ok(
  bundles.indexOf('dsh-codex-effort-switcher') < bundles.indexOf('dsh-claude-ultra'),
  'the switcher must compose before this plugin, which is what publishes codexModelTiers: ' + JSON.stringify(bundles),
)

/** Every request body the fixture received. */
const requests = []
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  if (request.url?.endsWith('/models')) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'fixture-model', name: 'Fixture Model' }] }))
    return
  }
  requests.push(JSON.parse(body))
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of [
    { choices: [{ delta: { role: 'assistant', content: REPLY }, index: 0, finish_reason: null }] },
    { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } },
  ]) response.write('data: ' + JSON.stringify(event) + '\n\n')
  response.end('data: [DONE]\n\n')
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const modelURL = 'http://127.0.0.1:' + server.address().port + '/v1'

await writeFile(resolve(run, 'home/profiles/web/cordis.patch.yml'), [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      fixture:',
  '        displayName: Fixture',
  '        api: openai-completions',
  '        baseURL: ' + JSON.stringify(modelURL),
  '        apiKeyEnv: DSH_CLAUDE_ULTRA_TEST_KEY',
  '        models:',
  '          - id: fixture-model',
  '            name: Fixture Model',
  '            reasoningEfforts:',
  '              low: low',
  '              high: high',
  '              max: max',
  '- id: ui-settings-models',
  '  config:',
  '    credentialOnboarding: false',
  '- id: ui-settings-general',
  '  config:',
  "    welcomeNoticeVersion: '2026-09-28.1'",
  '',
].join('\n'))

const child = spawn(process.execPath, [
  cli, 'web',
  '--patch', resolve(root, 'apps/web/tests/pin-browse-picker.overlay.yml'),
  '--no-open', '--port', '0',
], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment })

let logs = ''
let browser
const errors = []
try {
  const url = await new Promise((resolveURL, reject) => {
    const timeout = setTimeout(() => reject(new Error('DSH did not publish its URL within 120 seconds')), 120000)
    const collect = (chunk) => {
      logs += chunk.toString()
      const match = logs.replace(/\x1b\[[0-9;]*m/g, '').match(/http:\/\/127\.0\.0\.1:\d+[^\s]*/)
      if (match) { clearTimeout(timeout); resolveURL(match[0]) }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('exit', code => { clearTimeout(timeout); reject(new Error('DSH exited ' + code)) })
  })

  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push('console: ' + message.text()) })
  await page.goto(url)

  const trigger = page.locator('.dsh-codex-model .cx-trigger')
  await trigger.waitFor({ timeout: 60000 })
  await trigger.click()

  // A tier remaps the effort of the route already selected; it does not choose
  // the route. Point the session at the fixture before touching the tier, or the
  // turn runs on the profile's default provider and fails for want of a key.
  await page.locator('.cx-seat').click()
  await page.locator('.cx-option', { hasText: 'Fixture Model' }).click()
  assert.match(await trigger.getAttribute('aria-label'), /Fixture Model/)
  // Picking a model updates the seat in place and leaves the card on the model
  // pane; the first Escape returns to the effort face, the second dismisses.
  await page.keyboard.press('Escape')
  await page.locator('.cx-slider').waitFor({ timeout: 15000 })

  // The fifth tier is what this package contributes; without it the switcher
  // renders only the model's own levels.
  const ultra = page.getByRole('menuitemradio', { name: 'Ultra', exact: true })
  await ultra.waitFor({ timeout: 10000 })
  const levels = await page.locator('.cx-cell').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
  assert.ok(levels.includes('Ultra'), 'the Ultra tier is missing from ' + JSON.stringify(levels))
  await page.screenshot({ path: resolve(run, 'tiers.png') })

  const replies = () => page.locator('text="' + REPLY + '"').count()

  /** Send one prompt through the composer and wait for the fixture's reply. */
  const send = async (text) => {
    const input = page.locator('[data-composer-card] textarea, [data-composer-card] [contenteditable="true"]').first()
    const seenReplies = await replies()
    const seenRequests = requests.length
    await input.fill(text)
    await input.press('Enter')
    const deadline = Date.now() + 90000
    while (requests.length === seenRequests && Date.now() < deadline) await page.waitForTimeout(200)
    assert.ok(requests.length > seenRequests, 'the host sent no model request for ' + JSON.stringify(text))
    // The transcript keeps earlier replies, so wait for one more than was there.
    while (await replies() <= seenReplies && Date.now() < deadline) await page.waitForTimeout(200)
    assert.ok(await replies() > seenReplies, 'the transcript never rendered the reply for ' + JSON.stringify(text))
    return requests.slice(seenRequests)
  }

  /**
   * The one request of a turn that carried the tool schemas.
   *
   * A turn also fires a session-title call, which carries neither the effort
   * nor the system prompt, so selecting on the tools is what isolates the turn.
   */
  const turnRequestOf = (batch) => batch.find(body => Array.isArray(body.tools) && body.tools.length > 0)

  /** Every message's text in one request body. */
  const promptText = (body) => JSON.stringify(body.messages ?? [])

  // Path 1: the tier. It must route the top effort and carry the entry section.
  await ultra.click()
  await page.waitForTimeout(500)
  assert.match(await trigger.getAttribute('aria-label'), /reasoning effort Ultra$/)
  const ultraRequest = turnRequestOf(await send('Reply with the fixture text.'))
  assert.ok(ultraRequest !== undefined, 'the turn produced no tool-bearing request')
  assert.equal(ultraRequest.model, 'fixture-model')
  assert.equal(ultraRequest.reasoning_effort, 'max', 'the tier did not route the top effort')
  assert.ok(promptText(ultraRequest).includes('Ultracode is on:'), 'the entry section did not reach the request')
  assert.ok(promptText(ultraRequest).includes('subagent_fork'), 'the entry section lost its DSH tool names')
  assert.ok(!promptText(ultraRequest).includes('The user included the keyword'), 'a keyword section appeared without the keyword')

  // Path 2: the keyword, at a lower tier, so the entry section must be absent.
  await trigger.click()
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
  await page.waitForTimeout(500)
  const keywordRequest = turnRequestOf(await send('ultracode: reply with the fixture text.'))
  assert.ok(keywordRequest !== undefined, 'the keyword turn produced no tool-bearing request')
  assert.equal(keywordRequest.reasoning_effort, 'high', 'the keyword must not move the tier')
  assert.ok(promptText(keywordRequest).includes('The user included the keyword'), 'the keyword section did not reach the request')
  assert.ok(!promptText(keywordRequest).includes('Ultracode is on:'), 'the entry section outlived the tier')

  // Path 3: the opt-in is per turn, so the next prompt must not carry it.
  const plainRequest = turnRequestOf(await send('Reply with the fixture text again.'))
  assert.ok(plainRequest !== undefined, 'the follow-up turn produced no tool-bearing request')
  assert.ok(!promptText(plainRequest).includes('The user included the keyword'), 'the keyword section leaked into the next turn')

  assert.deepEqual(errors, [])
  console.log('Smoke passed: fifth tier, top-effort routing, the entry section, the keyword section, and its per-turn lifetime.')
} catch (error) {
  console.error(error.message)
  for (const entry of errors.slice(0, 4)) console.error('BROWSER: ' + entry.slice(0, 400))
  console.error(logs.slice(-4000).replace(/token=[^\s]+/g, 'token=<redacted>'))
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0]
    if (page) {
      console.error((await page.locator('body').innerText()).slice(-4000))
      await page.screenshot({ path: resolve(run, 'failure.png'), fullPage: true }).catch(() => {})
    }
  }
  process.exitCode = 1
} finally {
  // Written on both paths: a failing run is exactly when the bodies are wanted.
  await writeFile(resolve(run, 'evidence.json'), JSON.stringify({
    errors,
    requests: requests.map(body => ({
      model: body.model,
      effort: body.reasoning_effort,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      enter: JSON.stringify(body.messages ?? []).includes('Ultracode is on:'),
      keyword: JSON.stringify(body.messages ?? []).includes('The user included the keyword'),
    })),
  }, null, 2) + '\n')
  await writeFile(resolve(run, 'host.log'), logs)
  await browser?.close()
  if (child.exitCode === null) {
    const closed = once(child, 'exit')
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGTERM')
    await closed
  }
  server.closeAllConnections()
  await new Promise(resolveClose => server.close(resolveClose))
  console.log('Evidence: ' + run)
}
