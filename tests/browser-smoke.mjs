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
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import {
  bootWeb, cli, installPlugins, launchPage, makeRunDir, makeSend, pack, pickerOverlay,
  profilePatch, promptText, root, startFixture, turnRequestOf,
} from './smoke-harness.mjs'

const run = await makeRunDir('browser-')
const environment = { ...process.env, DSH_HOME: resolve(run, 'home'), DSH_CLAUDE_ULTRA_TEST_KEY: 'local-fixture' }

const ourTarball = pack(resolve('.'))
const switcherTarball = process.env.DSH_SWITCHER_TGZ ?? pack(resolve(root, 'plugins/codex-effort-switcher'))

// The packed archive is what a profile installs, so pack rather than pointing
// the profile at lib/. The switcher goes first: the bundle row order is what
// publishes codexModelTiers before this plugin reads it.
const bundles = await installPlugins({ cli, home: resolve(run, 'home'), tarballs: [switcherTarball, ourTarball], env: environment })
assert.ok(bundles.includes('dsh-claude-ultra'), 'the bundle row was not added: ' + JSON.stringify(bundles))
assert.ok(
  bundles.indexOf('dsh-codex-effort-switcher') < bundles.indexOf('dsh-claude-ultra'),
  'the switcher must compose before this plugin, which is what publishes codexModelTiers: ' + JSON.stringify(bundles),
)

const fixture = await startFixture()
const requests = fixture.requests

await writeFile(resolve(run, 'home/profiles/web/cordis.patch.yml'), profilePatch({ modelURL: fixture.url }))

const host = await bootWeb({ cli, home: resolve(run, 'home'), patch: pickerOverlay, env: environment })

let browser
const errors = []
try {
  const opened = await launchPage(host.url, errors)
  browser = opened.browser
  const page = opened.page

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

  const send = makeSend({ page, requests })

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
  assert.ok(!promptText(ultraRequest).includes('opting this turn into multi-agent orchestration'), 'a keyword section appeared without the keyword')

  // Path 2: the keyword, at a lower tier, so the entry section must be absent.
  await trigger.click()
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).click()
  await page.waitForTimeout(500)
  const keywordRequest = turnRequestOf(await send('ultracode: reply with the fixture text.'))
  assert.ok(keywordRequest !== undefined, 'the keyword turn produced no tool-bearing request')
  assert.equal(keywordRequest.reasoning_effort, 'high', 'the keyword must not move the tier')
  assert.ok(promptText(keywordRequest).includes('opting this turn into multi-agent orchestration'), 'the keyword section did not reach the request')
  assert.ok(!promptText(keywordRequest).includes('Ultracode is on:'), 'the entry section outlived the tier')

  // Path 3: the opt-in is per turn, so the next prompt must not carry it.
  const plainRequest = turnRequestOf(await send('Reply with the fixture text again.'))
  assert.ok(plainRequest !== undefined, 'the follow-up turn produced no tool-bearing request')
  assert.ok(!promptText(plainRequest).includes('opting this turn into multi-agent orchestration'), 'the keyword section leaked into the next turn')
  // Claude emits the exit reminder once, not on every later turn.
  assert.ok(!promptText(plainRequest).includes('Ultracode is off'), 'the exit reminder repeated after the turn that announced it')

  // Path 4: ultrathink raises this turn's effort without touching the tier, and
  // the boost is turn-scoped, so the turn after it is back at the tier's level.
  const deepRequest = turnRequestOf(await send('ultrathink: reply with the fixture text.'))
  assert.ok(deepRequest !== undefined, 'the ultrathink turn produced no tool-bearing request')
  assert.equal(deepRequest.reasoning_effort, 'max', 'the ultrathink keyword did not raise the effort')
  assert.ok(promptText(deepRequest).includes('requesting deeper reasoning on this turn'), 'the ultrathink section did not reach the request')
  assert.ok(!promptText(deepRequest).includes('Ultracode is on:'), 'the entry section appeared without the tier')
  // DSH keeps the effort in the request header, so the boost would raise the
  // Session for good; the turn's end submits a selection undoing it. That undo
  // is submitted in the background, so the seat returns a moment later.
  const settle = Date.now() + 15000
  while (!/reasoning effort High$/.test((await trigger.getAttribute('aria-label')) ?? '') && Date.now() < settle) {
    await page.waitForTimeout(200)
  }
  assert.match(await trigger.getAttribute('aria-label'), /reasoning effort High$/, 'ultrathink left the tier raised')

  const afterDeep = turnRequestOf(await send('Reply with the fixture text once more.'))
  assert.ok(afterDeep !== undefined, 'the turn after ultrathink produced no tool-bearing request')
  assert.equal(afterDeep.reasoning_effort, 'high', 'the ultrathink boost outlived its turn')

  assert.deepEqual(errors, [])
  console.log('Smoke passed: fifth tier, top-effort routing, the entry section, the keyword section and its per-turn lifetime, and the ultrathink boost with its turn-end undo.')
} catch (error) {
  console.error(error.message)
  for (const entry of errors.slice(0, 4)) console.error('BROWSER: ' + entry.slice(0, 400))
  console.error(host.logs.slice(-4000).replace(/token=[^\s]+/g, 'token=<redacted>'))
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
      keyword: JSON.stringify(body.messages ?? []).includes('opting this turn into multi-agent orchestration'),
      ultrathink: JSON.stringify(body.messages ?? []).includes('requesting deeper reasoning on this turn'),
    })),
  }, null, 2) + '\n')
  await writeFile(resolve(run, 'host.log'), host.logs)
  await browser?.close()
  await host.stop()
  await fixture.close()
  console.log('Evidence: ' + run)
}
