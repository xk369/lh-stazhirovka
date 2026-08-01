import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const FORBIDDEN_EXACT_PATHS = new Set([
  'data/db.json',
  'docs/MIGRATION_EXECUTION_PLAN.md',
  'docs/POSTGRES_MIGRATION_ROADMAP.md',
  'docs/CODEX_HANDOFF.md'
]);

const REVIEW_REQUIRED_EXACT_PATHS = new Set([
  'src/server.js',
  'src/report.js',
  'src/telegram.js',
  'src/telegram-delivery.js',
  'package.json',
  'package-lock.json',
  'docker-compose.yml',
  'nginx.example.conf'
]);

const FORBIDDEN_PATTERNS = [
  {
    name: 'environment secret file',
    test: path => isEnvSecretPath(path)
  },
  {
    name: 'runtime data or production snapshot',
    test: path => (
      path.startsWith('data/')
      || path.startsWith('backups/')
      || path.startsWith('migration-source/')
      || /\.(dump|backup|sqlite|db|tar|tgz|gz|zip)$/i.test(path)
    )
  }
];

const REVIEW_REQUIRED_PATTERNS = [
  {
    name: 'production/deploy configuration',
    test: path => (
      path.startsWith('deploy/')
      || path === 'Dockerfile'
      || path.includes('Caddyfile')
      || path.includes('compose')
    )
  },
  {
    name: 'large frontend surface',
    test: path => path === 'public/booking.html'
  },
  {
    name: 'database migration',
    test: path => path.startsWith('db/migrations/')
  }
];

function normalizePath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function basename(path) {
  return normalizePath(path).split('/').pop() || '';
}

function isEnvSecretPath(path) {
  const name = basename(path);
  if (name === '.env.example') return false;
  return name === '.env' || name.startsWith('.env.');
}

export function parseNameStatus(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\t');
      const status = parts[0] || '';
      return {
        status,
        paths: parts.slice(1).map(normalizePath).filter(Boolean)
      };
    })
    .filter(entry => entry.paths.length);
}

function classifyPath(path) {
  if (FORBIDDEN_EXACT_PATHS.has(path)) {
    return {
      severity: 'fail',
      path,
      reason: 'protected migration strategy/runtime data file'
    };
  }
  const forbidden = FORBIDDEN_PATTERNS.find(rule => rule.test(path));
  if (forbidden) {
    return {
      severity: 'fail',
      path,
      reason: forbidden.name
    };
  }
  if (REVIEW_REQUIRED_EXACT_PATHS.has(path)) {
    return {
      severity: 'warn',
      path,
      reason: 'high-risk file requires manual Codex review'
    };
  }
  const reviewRequired = REVIEW_REQUIRED_PATTERNS.find(rule => rule.test(path));
  if (reviewRequired) {
    return {
      severity: 'warn',
      path,
      reason: reviewRequired.name
    };
  }
  return {
    severity: 'ok',
    path,
    reason: 'allowed by automatic safety check'
  };
}

export function analyzeNameStatus(entries) {
  const findings = [];
  for (const entry of entries) {
    for (const path of entry.paths) {
      findings.push({
        status: entry.status,
        ...classifyPath(path)
      });
    }
  }
  const failures = findings.filter(item => item.severity === 'fail');
  const warnings = findings.filter(item => item.severity === 'warn');
  const ok = findings.filter(item => item.severity === 'ok');
  return {
    ok: failures.length === 0,
    failures,
    warnings,
    allowed: ok,
    total: findings.length
  };
}

export function formatSafetyAnalysis(analysis) {
  const lines = [];
  lines.push('Migration PR safety check');
  lines.push(`Status: ${analysis.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`Changed paths checked: ${analysis.total}`);

  if (analysis.failures.length) {
    lines.push('');
    lines.push('Forbidden changes:');
    for (const item of analysis.failures) {
      lines.push(`- ${item.path} (${item.reason})`);
    }
  }

  if (analysis.warnings.length) {
    lines.push('');
    lines.push('Manual review required:');
    for (const item of analysis.warnings) {
      lines.push(`- ${item.path} (${item.reason})`);
    }
  }

  if (!analysis.failures.length && !analysis.warnings.length) {
    lines.push('');
    lines.push('No forbidden or high-risk paths detected.');
  }

  return `${lines.join('\n')}\n`;
}

function gitNameStatus(baseRef, headRef) {
  return execFileSync(
    'git',
    ['diff', '--name-status', `${baseRef}...${headRef}`],
    { encoding: 'utf8' }
  );
}

function isCliEntryPoint() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isCliEntryPoint()) {
  const baseRef = process.argv[2] || 'migration/postgres-foundation';
  const headRef = process.argv[3] || 'HEAD';
  const entries = parseNameStatus(gitNameStatus(baseRef, headRef));
  const analysis = analyzeNameStatus(entries);
  process.stdout.write(formatSafetyAnalysis(analysis));
  process.exitCode = analysis.ok ? 0 : 1;
}
