#!/usr/bin/env node
/**
 * @trynullsec/legion — the one-command installer for Nullsec Legion.
 *
 * It is NOT the product; it is a thin, dependency-free orchestrator over
 * git / pnpm / uv / docker that collapses the manual setup into a single
 * command and fails fast with a clear, actionable message when the host is
 * missing something. Your API keys are written only to .env — never logged,
 * echoed, or transmitted.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/trynullsec/legion.git';
const BOARD_URL = 'http://localhost:4242';
const DEFAULT_PG_PORT = 5434;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolved during preflight: ['docker','compose'] or ['docker-compose'].
let COMPOSE = ['docker', 'compose'];

// ---------------------------------------------------------------------------
// presentation — minimal ANSI, honored only on a real TTY
// ---------------------------------------------------------------------------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (open, close) => (s) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const c = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  cyan: paint(36, 39),
};
const STAR = '\u2726'; // ✦
const out = (s = '') => process.stdout.write(s + '\n');
const step = (n, title) => out(`\n${c.bold(`${STAR} [${n}/6] ${title}`)}`);
const ok = (s) => out(`  ${c.green('\u2713')} ${s}`);
const info = (s) => out(`  ${c.dim('\u00b7')} ${s}`);
const warn = (s) => out(`  ${c.yellow('!')} ${s}`);

class SetupError extends Error {}

/** Print a clear, actionable failure block and exit non-zero. Never a stack. */
function fail(title, lines = []) {
  out(`\n${c.red(`${STAR} ${title}`)}`);
  for (const l of lines) out(`  ${l}`);
  out('');
  process.exit(1);
}

const forOS = ({ mac, linux }) => (IS_MAC ? mac : linux);

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------
/** True if `bin args` exits 0. */
function probe(bin, args = ['--version']) {
  const r = spawnSync(bin, args, { stdio: 'ignore' });
  return !r.error && r.status === 0;
}
/** Capture stdout/stderr without inheriting the terminal. */
function capture(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', ...opts });
  return { status: r.status ?? -1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
/** Run a command with inherited stdio; throw SetupError on failure. Never receives secrets. */
function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: 'inherit', ...opts });
  if (r.error) throw new SetupError(`could not run "${bin}": ${r.error.message}`);
  if (r.status !== 0) throw new SetupError(`"${bin} ${args.join(' ')}" exited with code ${r.status}`);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// prompts — built on node:readline (no third-party code touches your keys)
// ---------------------------------------------------------------------------
function ask(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

/** Prompt without echoing what is typed — used for API keys. */
function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (str) => {
      if (!muted) process.stdout.write(str);
    };
    rl.question(query, (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a.trim());
    });
    muted = true; // the query is already written; hide everything after it
  });
}

/** Yes/no. `-y` accepts; a non-interactive shell takes the default. */
async function confirm(prompt, defYes) {
  if (ARGS.yes) return true;
  if (!process.stdin.isTTY) return defYes;
  const a = await ask(`  ${prompt} ${defYes ? '[Y/n]' : '[y/N]'} `);
  if (!a) return defYes;
  return /^y(es)?$/i.test(a);
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
let ARGS;
try {
  ARGS = parseArgs({
    options: {
      dir: { type: 'string', short: 'd' },
      'no-start': { type: 'boolean' },
      update: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: false,
  }).values;
} catch (e) {
  fail('Unrecognized option', [String(e.message), 'Run `npx @trynullsec/legion --help` for usage.']);
}

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

function printHelp() {
  out(`${c.bold(`${STAR} Nullsec Legion`)} — installer

  One command to clone, configure, and launch Legion on a fresh machine.

${c.bold('Usage')}
  npx @trynullsec/legion [options]

${c.bold('Options')}
  -d, --dir <path>   Where to install Legion (default: ./legion)
      --no-start     Set everything up but do not launch the board
      --update       If the target dir already has Legion, update it
  -y, --yes          Accept defaults / skip confirmations (non-interactive)
  -h, --help         Show this help
  -v, --version      Show the installer version

${c.bold('What it does')}
  1. Preflight   Node 20+, git, pnpm, uv, Docker (running)${IS_MAC ? '' : ', bubblewrap'}
  2. Fetch       clone the repo + the vendored agent runtime
  3. Configure   prompt for your OpenRouter (+ optional Tavily) key -> .env
  4. Install     pnpm install + worker/scanner setup
  5. Database    docker compose up -> wait for Postgres -> migrations
  6. Start       pnpm dev -> ${BOARD_URL}

  Your API keys are written only to .env. They are never logged or transmitted.
`);
}

// ---------------------------------------------------------------------------
// 1. PREFLIGHT
// ---------------------------------------------------------------------------
async function preflight() {
  step(1, 'Preflight \u2014 checking your environment');

  if (IS_WIN) {
    fail('Windows is not supported directly', [
      'Legion runs on macOS and Linux. On Windows, use WSL2:',
      `  1. Install WSL2:  ${c.cyan('https://learn.microsoft.com/windows/wsl/install')}`,
      '  2. Open your Linux (e.g. Ubuntu) shell.',
      '  3. Re-run this installer inside WSL2.',
    ]);
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) {
    fail('Node.js 20 or newer is required', [
      `You are running Node ${process.versions.node}.`,
      `Install Node 20+:  ${c.cyan('https://nodejs.org')}  (or with nvm: \`nvm install 20\`)`,
    ]);
  }
  ok(`Node ${process.versions.node}`);

  if (!probe('git')) {
    fail('git is not installed', [
      forOS({
        mac: 'Install the Xcode command line tools:  xcode-select --install',
        linux: 'Install git:  sudo apt-get install -y git',
      }),
      `Or see:  ${c.cyan('https://git-scm.com/downloads')}`,
    ]);
  }
  ok('git');

  if (!probe('pnpm')) {
    warn('pnpm is not installed.');
    if (await confirm('Enable pnpm via corepack now (bundled with Node)?', true)) {
      try {
        run('corepack', ['enable', 'pnpm']);
      } catch {
        /* fall through to the re-check */
      }
      if (!probe('pnpm')) {
        try {
          run('corepack', ['prepare', 'pnpm@latest', '--activate']);
        } catch {
          /* fall through */
        }
      }
    }
    if (!probe('pnpm')) {
      fail('pnpm is required', [
        'Enable it with corepack (ships with Node):',
        '  corepack enable pnpm',
        `Or install it another way:  ${c.cyan('https://pnpm.io/installation')}`,
      ]);
    }
  }
  ok(`pnpm ${capture('pnpm', ['--version']).out}`);

  // uv powers the worker venv + semgrep in step 4 — required for setup to complete.
  if (!probe('uv')) {
    warn('uv (Python toolchain) is not installed \u2014 needed for the worker runtime and scanners.');
    if (await confirm('Install uv now via the official script?', true)) {
      try {
        run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh']);
      } catch {
        /* re-checked below */
      }
      // uv installs to ~/.local/bin by default — make it visible to this run.
      for (const d of ['.local/bin', '.cargo/bin']) {
        const p = path.join(process.env.HOME || '', d);
        if (existsSync(p) && !(process.env.PATH || '').split(path.delimiter).includes(p)) {
          process.env.PATH = `${p}${path.delimiter}${process.env.PATH || ''}`;
        }
      }
    }
    if (!probe('uv')) {
      fail('uv is required', [
        'Install it:  curl -LsSf https://astral.sh/uv/install.sh | sh',
        `Then open a new shell and re-run.  Docs:  ${c.cyan('https://docs.astral.sh/uv/')}`,
      ]);
    }
  }
  ok('uv');

  if (!probe('docker', ['--version'])) {
    fail('Docker is not installed', [
      forOS({
        mac: `Install Docker Desktop:  ${c.cyan('https://www.docker.com/products/docker-desktop/')}`,
        linux: `Install Docker Engine:  ${c.cyan('https://docs.docker.com/engine/install/')}`,
      }),
      'Legion uses Docker to run its Postgres database.',
    ]);
  }
  if (capture('docker', ['info']).status !== 0) {
    fail('Docker is installed but not running', [
      forOS({
        mac: 'Open Docker Desktop, wait until it reports "running", then re-run this installer.',
        linux: 'Start the daemon:  sudo systemctl start docker   (then re-run this installer)',
      }),
    ]);
  }
  ok('docker (running)');

  if (capture('docker', ['compose', 'version']).status === 0) {
    COMPOSE = ['docker', 'compose'];
  } else if (probe('docker-compose', ['version'])) {
    COMPOSE = ['docker-compose'];
  } else {
    fail('Docker Compose is not available', [
      'It ships with modern Docker Desktop / Docker Engine.',
      `See:  ${c.cyan('https://docs.docker.com/compose/install/')}`,
    ]);
  }
  ok(`docker compose (${COMPOSE.join(' ')})`);

  // Linux confinement uses bubblewrap; without it, every worker REFUSES to
  // start (Legion never runs unconfined). macOS uses the built-in sandbox.
  if (IS_MAC) {
    info('macOS confinement uses the built-in sandbox (seatbelt) \u2014 nothing to install.');
  } else if (!probe('bwrap', ['--version'])) {
    warn('bubblewrap (bwrap) is not installed \u2014 Legion needs it to confine workers on Linux.');
    if (await confirm('Install bubblewrap now (sudo apt-get install -y bubblewrap)?', true)) {
      try {
        run('sudo', ['apt-get', 'install', '-y', 'bubblewrap']);
      } catch {
        /* re-checked below */
      }
    }
    if (!probe('bwrap', ['--version'])) {
      warn('Continuing without bubblewrap, but missions will not run until it is installed:');
      out('      sudo apt-get install -y bubblewrap   (Debian/Ubuntu)');
      out(`      or see  ${c.cyan('https://github.com/containers/bubblewrap')}`);
    }
  } else {
    ok('bubblewrap');
  }
}

// ---------------------------------------------------------------------------
// 2. FETCH
// ---------------------------------------------------------------------------
function isLegionCheckout(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'agent-legion';
  } catch {
    return false;
  }
}

async function fetchSource(dir) {
  step(2, 'Fetch \u2014 cloning Legion');
  const exists = existsSync(dir) && readdirSync(dir).length > 0;

  if (exists) {
    if (!isLegionCheckout(dir)) {
      fail('The target directory is not empty and is not a Legion checkout', [
        `Directory: ${dir}`,
        'Pick another location with  --dir <path>,  or empty this one first.',
      ]);
    }
    info(`${dir} already contains Legion.`);
    if (ARGS.update || (await confirm('Update it (git pull + submodules)?', true))) {
      run('git', ['-C', dir, 'pull', '--ff-only']);
      ok('Updated to the latest commit');
    } else {
      info('Keeping the existing checkout as-is.');
    }
  } else {
    run('git', ['clone', REPO, dir]);
    ok('Cloned the repository');
  }

  info('Fetching the vendored agent runtime (submodule \u2014 this can take a minute)\u2026');
  run('git', ['-C', dir, 'submodule', 'update', '--init', '--recursive']);
  ok('Agent runtime ready');
}

// ---------------------------------------------------------------------------
// 3. CONFIGURE
// ---------------------------------------------------------------------------
/** Treat the .env.example placeholders (…) as "unset". */
function realKey(v) {
  const t = (v || '').trim();
  if (!t || t.endsWith('...') || t === 'sk-or-...' || t === 'tvly-...') return '';
  return t;
}

async function configure(dir) {
  step(3, 'Configure \u2014 your API keys');
  const examplePath = path.join(dir, '.env.example');
  const envPath = path.join(dir, '.env');

  if (!existsSync(examplePath)) {
    fail('.env.example is missing from the checkout', [
      'The clone may be incomplete. Remove the directory and re-run.',
    ]);
  }

  if (existsSync(envPath)) {
    info('.env already exists.');
    if (!(await confirm('Replace it with new keys?', false))) {
      info('Keeping your existing .env.');
      return;
    }
  }

  // OpenRouter (required). Prefer the environment; otherwise prompt (hidden).
  let openrouter = realKey(process.env.OPENROUTER_API_KEY);
  if (openrouter) {
    info('Using OPENROUTER_API_KEY from your environment.');
  } else if (process.stdin.isTTY) {
    out(`  Get a key at ${c.cyan('https://openrouter.ai/keys')} (any model, no lock-in).`);
    openrouter = await askHidden('  OpenRouter API key (required, input hidden): ');
  }
  if (!openrouter) {
    fail('An OpenRouter API key is required', [
      `Get one at  ${c.cyan('https://openrouter.ai/keys')}`,
      'Then re-run, or set OPENROUTER_API_KEY in your environment first.',
    ]);
  }

  // Tavily (optional — enables read-only web research missions).
  let tavily = realKey(process.env.LEGION_SEARCH_API_KEY);
  if (tavily) {
    info('Using LEGION_SEARCH_API_KEY from your environment.');
  } else if (process.stdin.isTTY) {
    tavily = await askHidden('  Tavily key for web research (optional, Enter to skip, hidden): ');
  }

  let env = readFileSync(examplePath, 'utf8');
  env = env.replace(/^OPENROUTER_API_KEY=.*$/m, `OPENROUTER_API_KEY=${openrouter}`);
  if (tavily) env = env.replace(/^LEGION_SEARCH_API_KEY=.*$/m, `LEGION_SEARCH_API_KEY=${tavily}`);
  writeFileSync(envPath, env, { mode: 0o600 });

  ok(`Wrote ${path.relative(process.cwd(), envPath) || '.env'} (keys hidden, file mode 600)`);
  if (!tavily) info('No Tavily key set \u2014 code & task missions work; add one later for web research.');
}

// ---------------------------------------------------------------------------
// 4. INSTALL
// ---------------------------------------------------------------------------
function install(dir) {
  step(4, 'Install \u2014 dependencies, worker runtime, scanners');
  run('pnpm', ['install'], { cwd: dir });
  ok('Node dependencies installed');

  info('Provisioning the worker runtime (Python venv + vendored agent)\u2026');
  run('bash', [path.join('scripts', 'setup-workers.sh')], { cwd: dir });
  ok('Worker runtime ready');

  info('Provisioning the scan engine (gitleaks + semgrep)\u2026');
  run('bash', [path.join('scripts', 'setup-scanners.sh')], { cwd: dir });
  ok('Scan engine ready');
}

// ---------------------------------------------------------------------------
// 5. DATABASE
// ---------------------------------------------------------------------------
/** A stable, per-install-dir compose project name so two checkouts never collide. */
function projectName(dir) {
  const hash = createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8);
  return `legion-${hash}`;
}

/** docker compose, scoped to this install's project. */
function compose(project, dir, args) {
  return capture(COMPOSE[0], [...COMPOSE.slice(1), '-p', project, ...args], { cwd: dir });
}
function composeRun(project, dir, args, env) {
  run(COMPOSE[0], [...COMPOSE.slice(1), '-p', project, ...args], { cwd: dir, env });
}

/** Is something already listening on this host TCP port? */
function portInUse(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}
async function firstFreePort(from) {
  for (let p = from; p < from + 50; p++) {
    if (!(await portInUse(p))) return p;
  }
  throw new SetupError(`no free port found in ${from}..${from + 50}`);
}

/** The host port this project's postgres is already published on, or null. */
function publishedPgPort(project, dir) {
  // `compose port` prints e.g. "0.0.0.0:5434"; parse the trailing port.
  const r = compose(project, dir, ['port', 'postgres', '5432']);
  if (r.status !== 0 || !r.out) return null;
  const m = r.out.match(/:(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * A container literally named `legion-postgres` exists. Older checkouts pin
 * `container_name: legion-postgres`, which overrides Compose's per-project
 * naming and collides across installs. Returns { state } or null.
 */
function legacyContainer() {
  const r = capture('docker', [
    'ps', '-a', '--filter', 'name=^/legion-postgres$',
    '--format', '{{.State}}',
  ]);
  const state = r.out.split('\n')[0]?.trim();
  return state ? { state } : null;
}

/**
 * Defuse a hardcoded `container_name` in the cloned compose file so per-project
 * naming works. Idempotent; only touches the postgres container_name line.
 */
function neutralizeContainerName(dir) {
  const file = path.join(dir, 'docker-compose.yml');
  let yml;
  try {
    yml = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  if (!/^\s*container_name:\s*legion-postgres\s*$/m.test(yml)) return false;
  const next = yml.replace(
    /^(\s*)container_name:\s*legion-postgres\s*$/m,
    '$1# container_name removed by the installer so per-project naming applies',
  );
  writeFileSync(file, next);
  return true;
}

/** Read DATABASE_URL's port from .env, if present. */
function envPgPort(dir) {
  try {
    const env = readFileSync(path.join(dir, '.env'), 'utf8');
    const m = env.match(/^DATABASE_URL=postgres:\/\/[^@]+@[^:]+:(\d+)\//m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Rewrite DATABASE_URL's port in .env to match the chosen host port. */
function writeDbPort(dir, port) {
  const envPath = path.join(dir, '.env');
  const env = readFileSync(envPath, 'utf8');
  const next = env.replace(
    /^DATABASE_URL=(postgres:\/\/[^@]+@[^:]+:)\d+(\/.*)$/m,
    `DATABASE_URL=$1${port}$2`,
  );
  if (next !== env) writeFileSync(envPath, next, { mode: 0o600 });
}

async function database(dir) {
  step(5, 'Database \u2014 Postgres');
  const project = projectName(dir);

  // If this checkout still pins `container_name: legion-postgres` (older clone),
  // neutralize it so Compose's per-project naming applies and installs cannot
  // collide on the literal container name.
  if (neutralizeContainerName(dir)) {
    info('Adjusted docker-compose.yml so this install gets its own container name.');
  }

  // A leftover literal `legion-postgres` container (from an older single-install
  // setup) blocks compose only if it would reuse that name. With the name
  // neutralized above, a NEW project will not reuse it — but a stopped/dead one
  // squatting the name is still worth flagging. Never crash on it.
  const legacy = legacyContainer();
  if (legacy && legacy.state !== 'running') {
    warn(`A stopped container named "legion-postgres" exists (state: ${legacy.state}).`);
    if (await confirm('Remove this stale container? (your data volume is kept)', true)) {
      capture('docker', ['rm', '-f', 'legion-postgres']);
      ok('Removed the stale legion-postgres container');
    } else {
      info('Leaving it in place \u2014 this install uses its own per-project container regardless.');
    }
  } else if (legacy && legacy.state === 'running') {
    info('Your existing "legion-postgres" keeps running untouched; this install gets its own.');
  }

  // Idempotent reuse: this install's own stack is already running. Adopt its
  // published port and continue — re-running must never error.
  const ownPort = publishedPgPort(project, dir);
  if (ownPort !== null) {
    info(`Reusing this install's Postgres (project ${c.dim(project)}, port ${ownPort}).`);
    writeDbPort(dir, ownPort);
    await waitHealthy(project, dir);
    ok('Postgres is healthy');
    run('pnpm', ['migrate'], { cwd: dir });
    ok('Database migrations applied');
    return;
  }

  // First run for this dir: choose a host port. Prefer .env's value (default
  // 5434). If it is taken by something else, resolve the conflict.
  let port = envPgPort(dir) ?? DEFAULT_PG_PORT;
  if (await portInUse(port)) {
    const free = await firstFreePort(port + 1);
    warn(`Host port ${port} is already in use (likely another Legion / Postgres).`);
    out(`  ${c.dim('You can:')}`);
    out(`    ${c.dim('a)')} run THIS install's database on a separate free port ${c.bold(String(free))} ${c.dim('(recommended)')}`);
    out(`    ${c.dim('b)')} keep port ${port} (only safe if that IS the database you want this install to use)`);
    const choice =
      ARGS.yes || !process.stdin.isTTY
        ? 'a'
        : (await ask(`  Choose [${c.bold('a')}/b]: `)).toLowerCase() || 'a';
    if (choice === 'b') {
      info(`Keeping port ${port}. This install will connect to whatever Postgres owns it.`);
    } else {
      port = free;
      info(`Using port ${port} for this install's Postgres.`);
    }
  }

  // Lock the choice into .env (the daemon's DATABASE_URL) and pass it to compose.
  writeDbPort(dir, port);
  info(`Starting Postgres (project ${c.dim(project)}, host port ${port})\u2026`);
  try {
    composeRun(project, dir, ['up', '-d'], { ...process.env, LEGION_PG_PORT: String(port) });
  } catch (e) {
    // Last-resort clarity: if compose still hits a container-name collision,
    // explain it and the one-line fix rather than surfacing a raw exit code.
    const collision = capture('docker', [
      'ps', '-a', '--filter', 'name=^/legion-postgres$', '--format', '{{.Names}}',
    ]).out;
    if (collision) {
      fail('A container named "legion-postgres" is blocking startup', [
        'This is from an older single-install setup that pinned the container name.',
        'Remove it (your data volume is preserved) and re-run:',
        `  ${c.cyan('docker rm -f legion-postgres')}`,
        'Then re-run this installer \u2014 every step is safe to repeat.',
      ]);
    }
    throw e;
  }

  await waitHealthy(project, dir);
  ok(`Postgres is healthy on port ${port}`);

  run('pnpm', ['migrate'], { cwd: dir });
  ok('Database migrations applied');
}

/** Poll the project's postgres container health by compose label (no fixed name). */
async function waitHealthy(project, dir) {
  info('Waiting for Postgres to become healthy\u2026');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ps = compose(project, dir, ['ps', '-q', 'postgres']);
    const cid = ps.out.split('\n')[0]?.trim();
    if (cid) {
      const h = capture('docker', ['inspect', '-f', '{{.State.Health.Status}}', cid]);
      if (h.status === 0 && h.out === 'healthy') return;
    }
    await delay(2000);
  }
  fail('Postgres did not become healthy in time', [
    `Inspect it:  (cd ${dir} && ${COMPOSE.join(' ')} -p ${project} logs postgres)`,
    'Then re-run the installer \u2014 every step is safe to repeat.',
  ]);
}

// ---------------------------------------------------------------------------
// 6. START
// ---------------------------------------------------------------------------
function nextSteps(dir) {
  const rel = path.relative(process.cwd(), dir) || '.';
  const project = projectName(dir);
  out(`\n${c.bold(`${STAR} Legion is set up.`)}`);
  out(`  ${c.dim('1.')} Open ${c.cyan(BOARD_URL)}`);
  out(`  ${c.dim('2.')} Register your passkey (the merge gate is bound to it)`);
  out(`  ${c.dim('3.')} Create your first mission`);
  out('');
  out(`  ${c.dim('Docs:')}     ${c.cyan('https://github.com/trynullsec/legion#readme')}`);
  out(`  ${c.dim('Restart:')}  cd ${rel} && pnpm dev`);
  out(`  ${c.dim('Database:')} cd ${rel} && ${COMPOSE.join(' ')} -p ${project} up -d   ${c.dim('(its own scoped stack)')}`);
  out('');
}

function start(dir) {
  if (ARGS['no-start']) {
    step(6, 'Start \u2014 skipped (--no-start)');
    nextSteps(dir);
    info('Launch it yourself when ready with the "Restart" command above.');
    return;
  }
  step(6, `Start \u2014 launching the board at ${BOARD_URL}`);
  nextSteps(dir);
  info('Starting pnpm dev \u2014 the board builds first, then the API comes up. Press Ctrl+C to stop.\n');
  const child = spawn('pnpm', ['dev'], { cwd: dir, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (e) => fail('Could not start Legion', [String(e.message)]));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  if (ARGS.help) return printHelp();
  if (ARGS.version) return out(pkgVersion());

  out(`${c.bold(`${STAR} Nullsec Legion installer`)} ${c.dim(`v${pkgVersion()}`)}`);
  out(c.dim('  Sets up and runs Legion. Your API keys go to .env only \u2014 never logged.'));

  await preflight();
  const dir = path.resolve(ARGS.dir ?? './legion');
  await fetchSource(dir);
  await configure(dir);
  install(dir);
  await database(dir);
  start(dir);
}

main().catch((e) => {
  if (e instanceof SetupError) {
    fail('Setup failed', [
      e.message,
      'Every step is idempotent \u2014 fix the issue above and re-run the same command.',
    ]);
  }
  fail('Unexpected error', [e?.message || String(e)]);
});
