/**
 * Deploying a Node.js repository as a container.
 *
 * The panel looks at the repository through the git API before anything is
 * cloned: no package.json means it is not a Node project and the deployment is
 * refused rather than half-attempted. What it finds — the engines field, the
 * scripts, the framework — becomes the suggested settings on the form, which
 * the person can still overrule.
 */

import { parseEnvInput } from './envVars.js';

/**
 * The kinds of project the panel can deploy.
 *
 * `server` types run the app itself in the container. `static` types build the
 * project and then serve the result with nginx, which is what Angular, React
 * and friends actually need — running `npm start` on those would give you a
 * development server, not a site.
 */
export const APP_TYPES = [
  {
    key: 'nextjs',
    label: 'Next.js',
    runtime: 'server',
    detect: ['next'],
    port: 3000,
    build: 'npm run build',
    start: 'npm run start',
    hint: 'Built and run with Next.js\'s own server.',
  },
  {
    key: 'nestjs',
    label: 'NestJS',
    runtime: 'server',
    detect: ['@nestjs/core'],
    port: 3000,
    build: 'npm run build',
    start: 'node dist/main.js',
    hint: 'Compiled to dist/ and run with Node.',
  },
  {
    key: 'nuxt',
    label: 'Nuxt',
    runtime: 'server',
    detect: ['nuxt'],
    port: 3000,
    build: 'npm run build',
    start: 'node .output/server/index.mjs',
    hint: 'Built to .output and run with Node.',
  },
  {
    key: 'node',
    label: 'Node.js service',
    runtime: 'server',
    detect: ['express', 'fastify', 'koa', '@hapi/hapi'],
    port: 3000,
    build: null,
    start: null,
    hint: 'Express, Fastify, Koa or anything else with a start script.',
  },
  {
    key: 'angular',
    label: 'Angular',
    runtime: 'static',
    detect: ['@angular/core', '@angular/cli'],
    port: 80,
    build: 'npm run build',
    outputDir: 'dist',
    hint: 'Built, then served by nginx with a fallback to index.html so routing works.',
  },
  {
    key: 'react',
    label: 'React · Vite · Vue (static build)',
    runtime: 'static',
    detect: ['vite', 'react-scripts', 'parcel', '@vitejs/plugin-react'],
    port: 80,
    build: 'npm run build',
    outputDir: 'dist',
    hint: 'Built, then served by nginx. Use this for any single-page app.',
  },
  {
    key: 'static',
    label: 'Static site',
    runtime: 'static',
    detect: [],
    port: 80,
    build: null,
    outputDir: 'dist',
    hint: 'No build, or a build you name — whatever lands in the output folder is served.',
  },
];

export const appType = (key) => APP_TYPES.find((t) => t.key === key) || null;

export const publicAppTypes = () => APP_TYPES.map((t) => ({
  key: t.key, label: t.label, runtime: t.runtime, port: t.port, hint: t.hint,
  build: t.build, start: t.start, outputDir: t.outputDir || null,
}));

/** Where each framework leaves its built files, when it is not the default. */
const STATIC_OUTPUT = {
  'react-scripts': 'build',
  parcel: 'dist',
  vite: 'dist',
};

export const NODE_VERSIONS = ['24', '22', '20', '18'];
const DEFAULT_NODE = '22';

/** "^20.11.0" / ">=18" / "20.x" → "20" */
function nodeMajorFrom(range) {
  const m = /(\d+)/.exec(String(range || ''));
  if (!m) return null;
  return NODE_VERSIONS.includes(m[1]) ? m[1] : m[1];
}

/**
 * Decide whether this repository can be deployed, and with what.
 * `files` is the repository's top level, used to spot a Dockerfile.
 */
export function inspectProject({ packageJson, files = [], angularJson = null }) {
  if (!packageJson) {
    return {
      ok: false,
      reason: 'There is no package.json at the root of this repository, so it is not a Node.js project. '
        + 'Only Node.js repositories — services, Next.js, NestJS, Angular, React and the like — can be deployed this way.',
    };
  }

  let pkg;
  try {
    pkg = JSON.parse(packageJson);
  } catch (err) {
    return { ok: false, reason: `The package.json in this repository could not be read: ${err.message}` };
  }
  if (!pkg || typeof pkg !== 'object') {
    return { ok: false, reason: 'The package.json in this repository is not a JSON object.' };
  }

  const scripts = pkg.scripts || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  // The first type whose marker dependency is present wins; a project with no
  // marker at all is a plain Node service if it can start, static otherwise.
  const type = APP_TYPES.find((t) => t.detect.some((d) => deps[d]))
    || (scripts.start || pkg.main ? appType('node') : appType('static'));

  const build = scripts.build ? 'npm run build' : (type.build || null);
  const nodeVersion = nodeMajorFrom(pkg.engines?.node) || DEFAULT_NODE;

  let start = null;
  if (type.runtime === 'server') {
    start = scripts.start ? 'npm run start' : (type.start || (pkg.main ? `node ${pkg.main}` : null));
    if (!start) {
      return {
        ok: false,
        reason: 'This project has no "start" script and no "main" file, so there is nothing to run. '
          + 'Add a start script — or, if it is a front-end, pick Angular or React below and it will be built and served by nginx instead.',
        detected: { name: pkg.name, type: type.key, scripts: Object.keys(scripts) },
      };
    }
  }

  const outputDir = type.runtime === 'static'
    ? (angularOutput(angularJson) || staticOutputFor(deps) || type.outputDir)
    : null;

  return {
    ok: true,
    detected: {
      name: pkg.name || null,
      version: pkg.version || null,
      type: type.key,
      typeLabel: type.label,
      runtime: type.runtime,
      engines: pkg.engines?.node || null,
      packageManager: files.includes('pnpm-lock.yaml') ? 'pnpm'
        : files.includes('yarn.lock') ? 'yarn'
          : 'npm',
      scripts: Object.keys(scripts),
      dependencies: Object.keys(pkg.dependencies || {}).length,
      hasDockerfile: files.includes('Dockerfile'),
      hasLockfile: files.includes('package-lock.json') || files.includes('yarn.lock') || files.includes('pnpm-lock.yaml'),
    },
    suggested: {
      name: safeName(pkg.name),
      type: type.key,
      nodeVersion,
      install: installCommandFor(files),
      build,
      start: start || '',
      outputDir,
      port: type.port,
      useRepoDockerfile: files.includes('Dockerfile'),
    },
  };
}

/** Angular states where it builds to, and v17+ adds a browser/ folder under it. */
function angularOutput(angularJson) {
  if (!angularJson) return null;
  try {
    const conf = JSON.parse(angularJson);
    const project = Object.values(conf.projects || {})[0];
    const build = project?.architect?.build || project?.targets?.build;
    if (!build) return null;

    const out = build.options?.outputPath;
    const path = typeof out === 'string' ? out : out?.base;
    if (!path) return null;

    // The application builder emits browser/ and server/ under outputPath.
    const modern = /:application$/.test(build.builder || '');
    return modern ? `${path.replace(/\/+$/, '')}/browser` : path;
  } catch {
    return null;
  }
}

const staticOutputFor = (deps) => Object.entries(STATIC_OUTPUT).find(([dep]) => deps[dep])?.[1] || null;

/** Whatever lockfile is in the repo decides how dependencies are installed. */
function installCommandFor(files) {
  if (files.includes('pnpm-lock.yaml')) return 'corepack enable && pnpm install --frozen-lockfile';
  if (files.includes('yarn.lock')) return 'corepack enable && yarn install --frozen-lockfile';
  if (files.includes('package-lock.json')) return 'npm ci --no-audit --no-fund';
  return 'npm install --no-audit --no-fund';
}

/** A package name like "@scope/my-app" is not a container name. */
export function safeName(name) {
  return String(name || 'app')
    .replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase() || 'app';
}

/* --------------------------------------------------------- Dockerfile */

/**
 * The Dockerfile the panel writes when the repository has none.
 *
 * One stage on purpose: it is easy to read, easy to debug when a build fails,
 * and the extra layers cost disk on a server you already own. Dev
 * dependencies are pruned afterwards when there was a build step.
 */
export function buildDockerfile(spec) {
  return spec.runtime === 'static' ? staticDockerfile(spec) : serverDockerfile(spec);
}

/**
 * Angular, React, Vue and anything else that compiles to files: build with
 * Node, then hand the result to nginx. The SPA fallback is what makes client
 * side routing work when somebody reloads a deep link.
 */
function staticDockerfile({ nodeVersion, install, build, outputDir }) {
  return [
    '# Written by AJ Pilot. Commit a Dockerfile to the repository to take over.',
    `FROM node:${nodeVersion}-alpine AS build`,
    '',
    'WORKDIR /app',
    'RUN apk add --no-cache libc6-compat',
    '',
    'COPY package*.json ./',
    ...(install.includes('yarn') ? ['COPY yarn.lock* ./'] : []),
    ...(install.includes('pnpm') ? ['COPY pnpm-lock.yaml* ./'] : []),
    `RUN ${install}`,
    '',
    'COPY . .',
    ...(build ? ['', `RUN ${build}`] : []),
    '',
    '# The built files are all that ships; nothing from node_modules follows.',
    'FROM nginx:alpine',
    `COPY --from=build /app/${String(outputDir || 'dist').replace(/^\/+|\/+$/g, '')} /usr/share/nginx/html`,
    'COPY nginx.autodeploy.conf /etc/nginx/conf.d/default.conf',
    'EXPOSE 80',
    '',
  ].join('\n');
}

/** The nginx config that ships beside a static build. */
export const NGINX_CONF = `server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  # Single-page apps route in the browser, so unknown paths return the shell.
  location / {
    try_files $uri $uri/ /index.html;
  }

  location ~* \\.(?:js|css|woff2?|png|jpe?g|gif|svg|ico|webp|avif)$ {
    expires 30d;
    add_header Cache-Control "public, immutable";
  }
}
`;

function serverDockerfile({ nodeVersion, install, build, start, port }) {
  const lines = [
    '# Written by AJ Pilot. Commit a Dockerfile to the repository to take over.',
    `FROM node:${nodeVersion}-alpine`,
    '',
    'WORKDIR /app',
    'RUN apk add --no-cache libc6-compat',
    '',
    '# Dependencies first, so a code-only change reuses this layer.',
    'COPY package*.json ./',
    ...(install.includes('yarn') ? ['COPY yarn.lock* ./'] : []),
    ...(install.includes('pnpm') ? ['COPY pnpm-lock.yaml* ./'] : []),
    `RUN ${install}`,
    '',
    'COPY . .',
  ];

  if (build) {
    lines.push('', `RUN ${build}`);
    if (install.startsWith('npm')) lines.push('RUN npm prune --omit=dev || true');
  }

  lines.push(
    '',
    'ENV NODE_ENV=production',
    `ENV PORT=${port}`,
    `EXPOSE ${port}`,
    `CMD ["sh", "-c", ${JSON.stringify(start)}]`,
    ''
  );

  return lines.join('\n');
}

/* ---------------------------------------------------------- validation */

const COMMAND_BANNED = /[\n\r\0]/;

export const MAX_CONTAINERS = 10;
export const MAX_VOLUMES = 6;

/**
 * Where a service keeps anything it must not lose.
 *
 * A container's own filesystem goes when the container does, and every deploy
 * replaces the container — so uploads, a SQLite file or generated files belong
 * on a named volume or they are gone at the next deploy. `/app/data` is the
 * default because the image this panel writes works in `/app`.
 */
export const DEFAULT_VOLUME_PATH = '/app/data';

/** The volume a service gets when you ask for the default one. */
export const defaultVolume = (name) => ({ name: `${name}-data`, path: DEFAULT_VOLUME_PATH, readOnly: false });

const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** Paths the container's own system lives at; a volume over one breaks it. */
const FORBIDDEN_MOUNTS = ['/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys', '/dev', '/boot', '/var', '/var/lib'];

/**
 * The volumes a service mounts, as the form sends them.
 * Nothing is created here — Docker makes a named volume the first time it is
 * mounted, and finds the same one again on every deploy after that.
 */
export function validateVolumes(body, appName) {
  const list = Array.isArray(body.volumes) ? body.volumes : [];
  if (!list.length) return { value: [] };
  if (list.length > MAX_VOLUMES) return { error: `${list.length} volumes is more than the ${MAX_VOLUMES} one service may mount` };

  const value = [];
  for (const raw of list) {
    const name = String(raw?.name ?? '').trim() || `${appName}-data`;
    const path = String(raw?.path ?? '').trim();

    if (!VOLUME_NAME.test(name)) {
      return { error: `"${name.slice(0, 40)}" is not a volume name — letters, numbers, dot, dash and underscore only` };
    }
    if (!/^\/[A-Za-z0-9._\-/]{1,190}$/.test(path) || path.includes('..') || path.includes('//')) {
      return { error: `"${path.slice(0, 60)}" is not a path inside the container — it must be absolute, such as /app/data` };
    }
    const clean = path.replace(/\/+$/, '') || '/';
    if (FORBIDDEN_MOUNTS.includes(clean)) {
      return { error: `A volume cannot be mounted over ${clean} — that is the container's own system. Use something like /app/data.` };
    }
    if (value.some((v) => v.path === clean)) return { error: `Two volumes are both mounted at ${clean}` };
    if (value.some((v) => v.name === name)) return { error: `The volume "${name}" is listed twice` };

    value.push({ name, path: clean, readOnly: raw?.readOnly === true || raw?.readOnly === 'true' });
  }

  return { value };
}

/**
 * The published ports, one per container.
 *
 * `ports` is what the form sends now — a row per container, each with its own
 * port. Without it the older shape is honoured: a first port and a count, which
 * simply numbers upwards.
 */
export function validatePorts(body) {
  const list = Array.isArray(body.ports) && body.ports.length
    ? body.ports
    : (() => {
      const first = Number(body.port);
      const count = Number(body.instances || 1);
      if (!Number.isInteger(count) || count < 1 || count > MAX_CONTAINERS) return null;
      return Array.from({ length: count }, (_, i) => first + i);
    })();

  if (!list) return { error: `The number of containers must be between 1 and ${MAX_CONTAINERS}` };
  if (list.length > MAX_CONTAINERS) {
    return { error: `${list.length} containers is more than the ${MAX_CONTAINERS} one service may run` };
  }

  const value = [];
  for (const raw of list) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `"${String(raw).slice(0, 20)}" is not a port — each container needs one between 1 and 65535` };
    }
    if (value.includes(port)) return { error: `Port ${port} is given to two containers — each one needs its own` };
    value.push(port);
  }

  return { value };
}

/**
 * The folder inside the repository the project lives in — "" for the root.
 * One repository can hold several projects (apps/api, apps/web, …).
 */
export function cleanRootDir(input) {
  const dir = String(input ?? '').trim().replace(/^\.?\/+|\/+$/g, '');
  if (!dir) return { value: '' };
  if (dir.length > 200 || !/^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)*$/.test(dir) || dir.split('/').some((p) => p === '..' || p === '.')) {
    return { error: `"${dir.slice(0, 60)}" is not a folder inside the repository — use a path like apps/api` };
  }
  return { value: dir };
}

/** Everything the deploy form must get right before a server is touched. */
export function validateAppSpec(body) {
  const name = safeName(body.name);
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(name)) {
    return { error: 'The app name may only use letters, numbers, dot, dash and underscore (2–40 characters)' };
  }

  const type = appType(body.type) || appType('node');

  const nodeVersion = String(body.node_version || DEFAULT_NODE).trim();
  if (!/^\d{1,2}(\.\d+)*(-\w+)?$/.test(nodeVersion)) {
    return { error: `"${nodeVersion}" is not a Node version the panel can use — try 22, 20 or 18` };
  }

  // One published port per container, chosen on the form. A body that sends
  // only `port` (an older client, or a single container) still works.
  const ports = validatePorts(body);
  if (ports.error) return { error: ports.error };
  const port = ports.value[0];
  const instances = ports.value.length;

  const containerPort = Number(body.container_port || type.port);
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    return { error: 'The port inside the container must be between 1 and 65535' };
  }

  const outputDir = String(body.output_dir || type.outputDir || 'dist').trim();
  if (type.runtime === 'static') {
    if (!outputDir || /^[/~]|\.\.|[\s'"$`\\]/.test(outputDir)) {
      return { error: 'The build output folder must be a path inside the project, such as dist or dist/app/browser' };
    }
  }

  for (const [field, value] of [['install', body.install], ['build', body.build], ['start', body.start]]) {
    if (value && COMMAND_BANNED.test(value)) return { error: `The ${field} command must be a single line` };
  }

  // A static build is served by nginx, so it needs no start command at all.
  const start = String(body.start || '').trim();
  if (type.runtime === 'server' && !start) {
    return { error: 'A start command is required — it is what the container runs' };
  }
  if (type.runtime === 'static' && !String(body.build || '').trim() && type.key !== 'static') {
    const article = /^[AEIOU]/i.test(type.label) ? 'An' : 'A';
    return { error: `${article} ${type.label} project needs a build command — that is what produces the files nginx serves` };
  }

  const branch = String(body.branch || '').trim();
  if (!branch || /[\s;&|'"$`\\]/.test(branch)) return { error: 'Pick a branch to deploy' };

  const repo = String(body.repo || '').trim();
  if (!/^[\w.-]+\/[\w./-]+$/.test(repo)) return { error: 'Pick the repository to deploy' };

  const tag = String(body.tag || 'latest').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(tag)) return { error: `"${tag}" is not a valid image tag` };

  // A whole .env file can be pasted or imported here, comments and all.
  const parsed = parseEnvInput(body.env);
  if (parsed.error) return { error: parsed.error };

  const volumes = validateVolumes(body, name);
  if (volumes.error) return { error: volumes.error };

  const rootDir = cleanRootDir(body.root_dir);
  if (rootDir.error) return { error: rootDir.error };

  return {
    spec: {
      rootDir: rootDir.value,
      ports: ports.value,
      volumes: volumes.value,
      name,
      repo,
      branch,
      type: type.key,
      runtime: type.runtime,
      nodeVersion,
      install: String(body.install || 'npm install --no-audit --no-fund').trim(),
      build: String(body.build || '').trim(),
      start,
      outputDir: type.runtime === 'static' ? outputDir : null,
      port,
      containerPort,
      instances,
      tag,
      env: parsed.pairs,
      network: String(body.network || '').trim(),
      restart: ['no', 'always', 'on-failure', 'unless-stopped'].includes(body.restart) ? body.restart : 'unless-stopped',
      useRepoDockerfile: body.use_repo_dockerfile === true || body.use_repo_dockerfile === 'true',
      push: body.push === true || body.push === 'true',
    },
  };
}
