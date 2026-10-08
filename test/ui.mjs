/**
 * Live UI check. Run with: node test/ui.mjs http://127.0.0.1:3080
 *
 * Drives the real GUI in headless Chrome, waits for the plugin boot to settle,
 * and reports whether the header control mounted plus every console error the
 * page produced. This is the only check that can prove the client half runs:
 * the offline bundle test exercises the code, not the module loader's decision
 * to load it.
 */

import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://127.0.0.1:3080';
/** Chrome ships inside the puppeteer cache on this machine. */
const cacheRoot = process.env.PUPPETEER_CACHE_DIR ?? `${process.env.HOME}/.cache/puppeteer`;

async function findChrome() {
	const { readdir } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const { existsSync } = await import('node:fs');
	for (const dir of await readdir(cacheRoot)) {
		for (const candidate of [
			join(cacheRoot, dir, 'chrome-linux64', 'chrome'),
			join(cacheRoot, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
		]) {
			if (existsSync(candidate)) return candidate;
		}
	}
	throw new Error(`no chrome under ${cacheRoot}`);
}

const executablePath = process.env.CHROME_PATH ?? (await findChrome());
const browser = await puppeteer.launch({
	executablePath,
	headless: true,
	args: ['--no-sandbox', '--disable-dev-shm-usage']
});

const page = await browser.newPage();
const errors = [];
const requests = [];

page.on('console', (message) => {
	if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => errors.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
page.on('response', (response) => {
	if (response.url().includes('dsh-undo-redo')) requests.push(`${String(response.status())} ${response.url()}`);
});

await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
/* Let the plugin boot settle and the client module graph finish arriving. */
await new Promise((resolve) => setTimeout(resolve, 6000));

const report = await page.evaluate(() => {
	const header = document.querySelector('[class*="header"]');
	const buttons = [...document.querySelectorAll('button[aria-label]')].map((node) => node.getAttribute('aria-label'));
	const undoish = [...document.querySelectorAll('button')]
		.map((node) => ({ label: node.getAttribute('aria-label'), title: node.getAttribute('title'), text: node.textContent?.trim() }))
		.filter((entry) => /unsend|restore|undo|redo/i.test(`${entry.label ?? ''}${entry.title ?? ''}${entry.text ?? ''}`));
	return {
		undoish,
		headerPresent: header !== null,
		ariaCount: buttons.length,
		bodyText: (document.body.innerText ?? '').slice(0, 200)
	};
});

console.log('--- requests for our bundle ---');
console.log(requests.length === 0 ? 'NONE — the page never fetched the bundle' : requests.join('\n'));
console.log('--- undo/redo-ish buttons in the DOM ---');
console.log(report.undoish.length === 0 ? 'NONE FOUND' : JSON.stringify(report.undoish, null, 1));
console.log('--- header present:', report.headerPresent, '| aria-labelled buttons:', report.ariaCount);
console.log('--- console errors ---');
console.log(errors.length === 0 ? 'none' : errors.slice(0, 12).join('\n'));

await browser.close();
