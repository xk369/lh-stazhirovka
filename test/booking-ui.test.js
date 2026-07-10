import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);

async function readPublicFile(name) {
  return readFile(new URL(`public/${name}`, projectRoot), 'utf8');
}

test('home menu names describe the user action behind every entry', async () => {
  const html = await readPublicFile('index.html');

  assert.match(html, /ЗАПИСАТЬСЯ НА СТАЖИРОВКУ/);
  assert.match(html, /ЧЕК-ЛИСТ СТАЖЁРА/);
  assert.match(html, /ОТЧЁТ НАСТАВНИКА/);
  assert.equal((html.match(/class="role-description"/g) || []).length, 3);
});

test('recruiter candidates button is a primary navigation item', async () => {
  const html = await readPublicFile('booking.html');
  const nav = html.match(/<nav class="recruiter-nav"[\s\S]*?<\/nav>/)?.[0] || '';
  const moreMenu = nav.match(/<div class="recruiter-more-menu">[\s\S]*?<\/details>/)?.[0] || '';

  assert.match(nav, /data-section="dates"[^>]*>Даты<\/button>/);
  assert.match(nav, /data-section="candidates"[^>]*>Кандидаты<\/button>/);
  assert.match(nav, /data-section="groups"[^>]*>Группы<\/button>/);
  assert.doesNotMatch(moreMenu, /data-section="candidates"/);
});

test('registry search updates results asynchronously without replacing its input', async () => {
  const html = await readPublicFile('booking.html');
  const registrySection = html.match(/<section id="registrySection"[\s\S]*?<section id="groupsSection"/)?.[0] || '';
  const renderRegistry = html.match(/function renderRegistry\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const inputHandler = html.match(/if \(event\.target\.id === "registrySearch"\) \{[\s\S]*?\n      \}/)?.[0] || '';

  assert.match(registrySection, /id="registrySearch"[^>]*type="search"/);
  assert.doesNotMatch(renderRegistry, /outerHTML|replaceWith/);
  assert.match(inputHandler, /scheduleRegistryRender\(\)/);
  assert.doesNotMatch(inputHandler, /render\(\)|renderRegistry\(\)/);
});

test('candidate cards are numbered, comment-free and use one step-back action', async () => {
  const html = await readPublicFile('booking.html');
  const renderCandidates = html.match(/function renderCandidates\(\) \{[\s\S]*?\n    \}\n\n    function registryRows/)?.[0] || '';

  assert.match(renderCandidates, /candidate-number/);
  assert.match(renderCandidates, /candidate-status/);
  assert.match(renderCandidates, /candidate-info-grid/);
  assert.match(renderCandidates, /data-step-back/);
  assert.doesNotMatch(renderCandidates, /class="badges"/);
  assert.doesNotMatch(renderCandidates, /data-comment|<textarea/);
  assert.doesNotMatch(renderCandidates, /Откатить к отчету|Откатить к приглашению/);
});
