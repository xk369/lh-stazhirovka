import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeNameStatus,
  formatSafetyAnalysis,
  parseNameStatus
} from '../scripts/check-migration-pr-safety.js';

test('migration PR safety check blocks strategy docs, env files and runtime data', () => {
  const analysis = analyzeNameStatus(parseNameStatus([
    'M\tdocs/MIGRATION_EXECUTION_PLAN.md',
    'A\t.env',
    'M\tdata/db.json'
  ].join('\n')));

  assert.equal(analysis.ok, false);
  assert.deepEqual(
    analysis.failures.map(item => item.path),
    [
      'docs/MIGRATION_EXECUTION_PLAN.md',
      '.env',
      'data/db.json'
    ]
  );
});

test('migration PR safety check allows env examples but warns on high-risk runtime files', () => {
  const analysis = analyzeNameStatus(parseNameStatus([
    'M\t.env.example',
    'M\tsrc/server.js',
    'M\tpublic/booking.html'
  ].join('\n')));

  assert.equal(analysis.ok, true);
  assert.deepEqual(analysis.allowed.map(item => item.path), ['.env.example']);
  assert.deepEqual(
    analysis.warnings.map(item => item.path),
    ['src/server.js', 'public/booking.html']
  );
});

test('migration PR safety check catches forbidden paths in renames', () => {
  const analysis = analyzeNameStatus(parseNameStatus('R100\tdata/db.json\tdata/db.backup'));

  assert.equal(analysis.ok, false);
  assert.deepEqual(
    analysis.failures.map(item => item.path),
    ['data/db.json', 'data/db.backup']
  );
});

test('migration PR safety formatter reports pass and fail states clearly', () => {
  const failed = analyzeNameStatus(parseNameStatus('M\tdocs/CODEX_HANDOFF.md'));
  const passed = analyzeNameStatus(parseNameStatus('A\tsrc/postgres/write-shifts.js'));

  assert.match(formatSafetyAnalysis(failed), /Status: FAIL/);
  assert.match(formatSafetyAnalysis(failed), /Forbidden changes:/);
  assert.match(formatSafetyAnalysis(passed), /Status: PASS/);
  assert.match(formatSafetyAnalysis(passed), /No forbidden or high-risk paths detected/);
});
