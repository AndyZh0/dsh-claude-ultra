/**
 * Shared harness for the built-plugin browser smoke lanes.
 *
 * A lane packs this package, installs it into an isolated DSH home, boots a
 * supported web profile against a local model endpoint, and drives the GUI with
 * a real browser. This module owns those steps so both lanes share them; each
 * lane owns its own composition, assertions, evidence, and exit code.
 *
 * It needs a built checkout (pnpm run build in the repository root) and the
 * switcher beside this package when a lane installs it (or DSH_SWITCHER_TGZ
 * pointing at a packed archive).
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

/** The whole reply the fixture streams back, and what the transcript shows. */
export const REPLY = 'claude ultra smoke passed'

/** Repository root of the checkout the lanes run against. */
export const root = resolve('../..')

/** The built CLI entry the lanes boot. */
export const cli = resolve(root, 'apps/cli/lib/bin.js')

/** The web overlay both lanes boot with, which installs the in-page directory picker. */
export const pickerOverlay = resolve(root, 'apps/web/tests/pin-browse-picker.overlay.yml')

/**
 * Pack one plugin directory.
 * @param directory - package directory to pack.
 * @returns the archive path.
 */
export function pack(directory) {
  const packed = spawnSync('npm', ['pack', '--silent'], { cwd: directory, shell: true, encoding: 'utf8', timeout: 180000 })
  assert.equal(packed.status, 0, 'npm pack failed in ' + directory + ': ' + packed.stderr)
  return resolve(directory, packed.stdout.trim().split(/\r?\n/).pop())
}

/**
 * Create one evidence directory under .runtime/.
 * @param prefix - directory name prefix, which is how a lane's runs are recognised.
 * @returns the absolute run directory.
 */
export async function makeRunDir(prefix) {
  await mkdir('.runtime', { recursive: true })
  return await mkdtemp(resolve('.runtime/' + prefix))
}

/**
 * Install packed plugins into the isolated profile, in the given order.
 *
 * The order is the composition order, and it is what publishes a service before
 * a later plugin reads it. One log per archive is written beside the home, on
 * both the succeeding and the failing path.
 * @param options - CLI entry, isolated home, archives, and environment.
 * @returns the profile's bundle rows.
 */
export async function installPlugins({ cli: cliPath, home, tarballs, env }) {
  const run = dirname(home)
  for (const tarball of tarballs) {
    const installer = spawnSync(process.execPath, [cliPath, 'plugin', '--profile', 'web', 'add', tarball], {
      cwd: root, windowsHide: true, env, encoding: 'utf8', timeout: 180000,
    })
    await writeFile(resolve(run, 'install-' + tarball.split(/[\\/]/).pop() + '.log'), (installer.stdout ?? '') + (installer.stderr ?? ''))
    assert.equal(installer.status, 0, 'plugin install failed for ' + tarball + ': ' + installer.stderr)
  }
  const installed = JSON.parse(await readFile(resolve(home, 'profiles/web/package.json'), 'utf8'))
  return installed.dsh.profile.bundles
}

/**
 * The profile patch that points the profile at the fixture endpoint.
 * @param options - fixture base URL, and the route a lane needs as the session default.
 * @returns the cordis.patch.yml body.
 */
export function profilePatch({ modelURL, defaultModel }) {
  const lines = [
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
  ]
  // A lane without the switcher has no card to pick the fixture route with, so
  // its profile states the default selection instead.
  if (defaultModel !== undefined) {
    lines.push(
      '- id: agent-default-model',
      '  config:',
      '    provider: ' + defaultModel.provider,
      '    model: ' + defaultModel.model,
    )
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Serve the local model endpoint one lane's turns run against.
 * @param options - the assistant text every completion streams back.
 * @returns the base URL, the live list of received request bodies, and a closer.
 */
export async function startFixture({ reply = REPLY } = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.url?.endsWith('/models')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'fixture-model', name: 'Fixture Model' }] }))
      return
    }
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      // A probe with no JSON body is not a completion. Answering it keeps the
      // rejection from taking the whole lane down with an opaque SyntaxError.
      response.writeHead(400, { 'content-type': 'text/plain' })
      response.end('expected a JSON request body')
      return
    }
    requests.push(parsed)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { choices: [{ delta: { role: 'assistant', content: reply }, index: 0, finish_reason: null }] },
      { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } },
    ]) response.write('data: ' + JSON.stringify(event) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/v1',
    requests,
    async close() {
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(resolveClose))
    },
  }
}

/**
 * Boot the web profile and wait for the URL it publishes.
 *
 * A boot that never publishes its URL kills the child before rejecting, so a
 * caller that never receives a handle cannot leak the process.
 * @param options - CLI entry, isolated home, overlay path, and environment.
 * @returns the published URL, a live getter for the host's output, and a stopper.
 */
export async function bootWeb({ cli: cliPath, home, patch, env }) {
  const child = spawn(process.execPath, [
    cliPath, 'web', '--patch', patch, '--no-open', '--port', '0',
  ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })

  let logs = ''
  const stop = async () => {
    if (child.exitCode !== null) return
    const closed = once(child, 'exit')
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else child.kill('SIGTERM')
    await closed
  }

  let url
  try {
    url = await new Promise((resolveURL, reject) => {
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
  } catch (error) {
    await stop()
    throw error
  }

  const handle = { url, stop }
  // The host keeps writing after boot, and a failing run is exactly when its
  // output is wanted, so this stays live rather than snapshotting at boot.
  Object.defineProperty(handle, 'logs', { get: () => logs })
  return handle
}

/**
 * Open one browser page on the booted GUI.
 * @param url - the URL the host published.
 * @param errors - array the page's errors and console errors are pushed onto.
 * @returns the browser and the page.
 */
export async function launchPage(url, errors) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push('console: ' + message.text()) })
  await page.goto(url)
  return { browser, page }
}

/** The composer's text field. */
export function composerInput(page) {
  return page.locator('[data-composer-card] textarea, [data-composer-card] [contenteditable="true"]').first()
}

/**
 * Build the send helper one lane drives its turns with.
 * @param options - the page, the live request list, and the reply text to await.
 * @returns a function sending one prompt and resolving the requests it produced.
 */
export function makeSend({ page, requests, reply = REPLY }) {
  const replies = () => page.locator('text="' + reply + '"').count()
  return async (text) => {
    const input = composerInput(page)
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
}

/**
 * The one request of a turn that carried the tool schemas.
 *
 * A turn also fires a session-title call, which carries neither the effort nor
 * the system prompt, so selecting on the tools is what isolates the turn.
 * @param batch - the requests one turn produced.
 * @returns the tool-bearing request, when there was one.
 */
export function turnRequestOf(batch) {
  return batch.find(body => Array.isArray(body.tools) && body.tools.length > 0)
}

/**
 * Every message's text in one request body.
 * @param body - one received request body.
 * @returns the messages serialized, which is what the sections are searched in.
 */
export function promptText(body) {
  return JSON.stringify(body.messages ?? [])
}
