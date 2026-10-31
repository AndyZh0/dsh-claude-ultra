/**
 * Built-plugin smoke with the switcher absent.
 *
 * The client half reads codexModelTiers through ctx.get rather than declaring it
 * in inject, because a pending injection fails the client boot and blanks the
 * whole GUI. This lane installs this package alone, so a regression to the
 * injection shows up here as a surface that never loads.
 *
 * It is also a real composition rather than only a degraded one: the Host half
 * needs no switcher, so a user who installs only this package still gets the
 * ultracode and ultrathink triggers.
 *
 * It needs a built checkout (pnpm run build in the repository root).
 */
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import {
  bootWeb, cli, composerInput, installPlugins, launchPage, makeRunDir, makeSend, pack,
  pickerOverlay, profilePatch, promptText, startFixture, turnRequestOf,
} from './smoke-harness.mjs'

const run = await makeRunDir('browser-noswitcher-')
const environment = { ...process.env, DSH_HOME: resolve(run, 'home'), DSH_CLAUDE_ULTRA_TEST_KEY: 'local-fixture' }

const ourTarball = pack(resolve('.'))

// Only this package is installed: the lane exists to prove the composition
// without the switcher, so installing it here would defeat the run.
const bundles = await installPlugins({ cli, home: resolve(run, 'home'), tarballs: [ourTarball], env: environment })
assert.ok(bundles.includes('dsh-claude-ultra'), 'the bundle row was not added: ' + JSON.stringify(bundles))
assert.ok(!bundles.includes('dsh-codex-effort-switcher'), 'the switcher was installed, so this lane proves nothing: ' + JSON.stringify(bundles))

const fixture = await startFixture()
const requests = fixture.requests

await writeFile(resolve(run, 'home/profiles/web/cordis.patch.yml'), profilePatch({
  modelURL: fixture.url,
  // With no card there is no way to pick the fixture route, so the profile
  // states the session's default selection instead.
  defaultModel: { provider: 'fixture', model: 'fixture-model' },
}))

const host = await bootWeb({ cli, home: resolve(run, 'home'), patch: pickerOverlay, env: environment })

let browser
const errors = []
try {
  const opened = await launchPage(host.url, errors)
  browser = opened.browser
  const page = opened.page

  // 1. The surface loaded. A client half that declares a service this
  //    composition does not provide fails its boot and blanks the GUI, which is
  //    the regression this lane exists to catch.
  await composerInput(page).waitFor({ timeout: 60000 })
  const body = await page.locator('body').innerText()
  assert.ok(!body.includes('Failed to load plugins'), 'the GUI reported a plugin load failure: ' + body.slice(0, 400))

  // 2. The switcher really is absent, or the rest of the lane proves nothing.
  assert.equal(await page.locator('.dsh-codex-model').count(), 0, 'the switcher card is present in the no-switcher lane')
  await page.screenshot({ path: resolve(run, 'noswitcher.png') })

  const send = makeSend({ page, requests })

  // 3. The ultracode keyword opts the turn in. There is no tier to select, so
  //    the mode is off and the entry section must not appear.
  const keywordRequest = turnRequestOf(await send('ultracode: reply with the fixture text.'))
  assert.ok(keywordRequest !== undefined, 'the keyword turn produced no tool-bearing request')
  assert.equal(keywordRequest.model, 'fixture-model', 'the turn did not run on the profile default route')
  assert.ok(promptText(keywordRequest).includes('opting this turn into multi-agent orchestration'), 'the keyword section did not reach the request')
  assert.ok(!promptText(keywordRequest).includes('Ultracode is on:'), 'the entry section appeared without a tier')

  // 4. ultrathink raises the turn to the model's top advertised level with no
  //    switcher at all, which is the strongest thing this lane proves.
  const deepRequest = turnRequestOf(await send('ultrathink: reply with the fixture text.'))
  assert.ok(deepRequest !== undefined, 'the ultrathink turn produced no tool-bearing request')
  assert.equal(deepRequest.reasoning_effort, 'max', 'the ultrathink keyword did not raise the effort')
  assert.ok(promptText(deepRequest).includes('requesting deeper reasoning on this turn'), 'the ultrathink section did not reach the request')
  assert.ok(!promptText(deepRequest).includes('Ultracode is on:'), 'the entry section appeared without a tier')

  // 5. The opt-in is per turn, so the next prompt must not carry it.
  const plainRequest = turnRequestOf(await send('Reply with the fixture text again.'))
  assert.ok(plainRequest !== undefined, 'the follow-up turn produced no tool-bearing request')
  assert.ok(!promptText(plainRequest).includes('opting this turn into multi-agent orchestration'), 'the keyword section leaked into the next turn')

  assert.deepEqual(errors, [])
  console.log('Smoke passed (no switcher): the surface loaded without the switcher, the ultracode keyword opted its turn in, and ultrathink raised the request to the top effort.')
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
