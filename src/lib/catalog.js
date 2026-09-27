/**
 * What the panel can install on a server.
 *
 * Two kinds of entry:
 *   host      — installed onto the machine itself (Docker and its compose plugin,
 *               because nothing else can be containerised without them)
 *   container — run as a Docker container, never installed onto the host
 *
 * Each container entry declares the form the UI should draw, so the fields live
 * in exactly one place and the browser renders whatever this file says.
 */

/** Everything a stored value can be asked for. */
const field = (name, label, opts = {}) => ({
  name,
  label,
  type: opts.type || 'text',
  placeholder: opts.placeholder || '',
  hint: opts.hint || '',
  required: Boolean(opts.required),
  default: opts.default ?? '',
  env: opts.env || null,
  secret: opts.type === 'password',
});

/**
 * A second (or third) port the service publishes.
 *
 * Most things here answer on one port. A broker or a search engine does not —
 * EMQX has its dashboard beside MQTT, Elasticsearch its transport port beside
 * the API — and hiding those behind `docker exec` would make them useless.
 */
const port = (name, label, containerPort, opts = {}) => ({
  name,
  label,
  containerPort,
  default: opts.default ?? containerPort,
  hint: opts.hint || '',
  optional: Boolean(opts.optional),
});

export const CATALOG = [
  {
    key: 'docker',
    label: 'Docker Engine',
    tagline: 'The container runtime everything else here needs',
    icon: '🐳',
    kind: 'host',
    detail: 'Installs Docker CE from get.docker.com and starts the daemon. Adds your SSH user to the docker group.',
    fields: [],
  },
  {
    key: 'compose',
    label: 'Docker Compose',
    tagline: 'The `docker compose` plugin',
    icon: '🧩',
    kind: 'host',
    requiresDocker: true,
    detail: 'Installs the compose v2 plugin so `docker compose up` works on this server.',
    fields: [],
  },
  {
    key: 'mysql',
    label: 'MySQL',
    tagline: 'Relational database',
    icon: '🐬',
    kind: 'container',
    requiresDocker: true,
    image: 'mysql',
    // 8.4 is the long-term-support line; 26 and 9.x are the newer releases.
    defaultTag: '8.4',
    tags: ['8.4', '26', '9.7', '8.0'],
    containerPort: 3306,
    defaultPort: 3306,
    volumePath: '/var/lib/mysql',
    detail: 'Runs the official MySQL image with a named volume, so the data survives a container rebuild.',
    fields: [
      field('root_password', 'Root password', { type: 'password', required: true, env: 'MYSQL_ROOT_PASSWORD', hint: 'Used for the root@% account inside the container.' }),
      field('database', 'Create a database', { placeholder: 'appdb', env: 'MYSQL_DATABASE' }),
      field('user', 'Create a user', { placeholder: 'appuser', env: 'MYSQL_USER' }),
      field('password', "That user's password", { type: 'password', env: 'MYSQL_PASSWORD' }),
    ],
  },
  {
    key: 'postgres',
    label: 'PostgreSQL',
    tagline: 'Relational database',
    icon: '🐘',
    kind: 'container',
    requiresDocker: true,
    image: 'postgres',
    defaultTag: '18',
    tags: ['18', '17', '16', '18-alpine'],
    containerPort: 5432,
    defaultPort: 5432,
    // The parent directory, not …/data: PostgreSQL 18 keeps its data in a
    // versioned folder under it, and 17 and older use …/data inside it.
    volumePath: '/var/lib/postgresql',
    detail: 'Runs the official PostgreSQL image with a named volume, so the data survives a container rebuild.',
    fields: [
      field('password', 'Superuser password', { type: 'password', required: true, env: 'POSTGRES_PASSWORD' }),
      field('user', 'Superuser name', { placeholder: 'postgres', env: 'POSTGRES_USER', hint: 'Leave empty for "postgres".' }),
      field('database', 'Create a database', { placeholder: 'appdb', env: 'POSTGRES_DB', hint: 'Leave empty to get one named after the superuser.' }),
    ],
  },
  {
    key: 'mongo',
    label: 'MongoDB',
    tagline: 'Document database',
    icon: '🍃',
    kind: 'container',
    requiresDocker: true,
    image: 'mongo',
    defaultTag: '8.0',
    tags: ['8.0', '8.3', '7.0'],
    containerPort: 27017,
    defaultPort: 27017,
    volumePath: '/data/db',
    detail: 'Runs the official MongoDB image. Filling in a username and password turns on authentication.',
    fields: [
      field('user', 'Root username', { placeholder: 'root', env: 'MONGO_INITDB_ROOT_USERNAME' }),
      field('password', 'Root password', { type: 'password', env: 'MONGO_INITDB_ROOT_PASSWORD' }),
      field('database', 'Create a database', { placeholder: 'appdb', env: 'MONGO_INITDB_DATABASE' }),
    ],
  },
  {
    key: 'redis',
    label: 'Redis',
    tagline: 'In-memory cache and key/value store',
    icon: '⚡',
    kind: 'container',
    requiresDocker: true,
    image: 'redis',
    defaultTag: '8-alpine',
    tags: ['8-alpine', '8', '7.4-alpine'],
    containerPort: 6379,
    defaultPort: 6379,
    volumePath: '/data',
    detail: 'Runs the official Redis image with append-only persistence turned on.',
    fields: [
      field('password', 'Password', { type: 'password', hint: 'Leave empty to run without authentication — only safe on a private network.' }),
    ],
  },
  {
    key: 'emqx',
    label: 'EMQX',
    tagline: 'MQTT broker for devices and IoT',
    icon: '📡',
    kind: 'container',
    requiresDocker: true,
    image: 'emqx',
    defaultTag: '5.8',
    tags: ['5.8', '5.7', 'latest'],
    containerPort: 1883,
    defaultPort: 1883,
    volumePath: '/opt/emqx/data',
    extraPorts: [
      port('dashboard_port', 'Dashboard port', 18083, { hint: 'The web dashboard — sign in as admin with the password below.' }),
      port('ws_port', 'WebSocket port', 8083, { optional: true, hint: 'MQTT over WebSocket, which is how a browser connects.' }),
      port('ssl_port', 'MQTT over TLS port', 8883, { optional: true, hint: 'Only useful once you have put certificates into the broker.' }),
    ],
    detail: 'Runs the official EMQX image with its data on a named volume. MQTT is published on the first port and the '
      + 'dashboard on its own, so the broker can be managed from a browser as soon as it is up.',
    fields: [
      field('dashboard_password', 'Dashboard password', {
        type: 'password', required: true, env: 'EMQX_DASHBOARD__DEFAULT_PASSWORD',
        hint: 'At least 8 characters. The dashboard user is "admin"; EMQX refuses to keep its own default.',
      }),
      field('node_cookie', 'Cluster cookie', {
        type: 'password', env: 'EMQX_NODE__COOKIE',
        hint: 'Only needed if this broker will later join others in a cluster.',
      }),
    ],
  },
  {
    key: 'elasticsearch',
    label: 'Elasticsearch',
    tagline: 'Search and analytics engine',
    icon: '🔍',
    kind: 'container',
    requiresDocker: true,
    image: 'elasticsearch',
    defaultTag: '8.15.3',
    tags: ['8.15.3', '8.14.3', '7.17.24'],
    containerPort: 9200,
    defaultPort: 9200,
    volumePath: '/usr/share/elasticsearch/data',
    extraPorts: [
      port('transport_port', 'Transport port', 9300, { optional: true, hint: 'Node-to-node traffic. Only needed if more nodes will join this one.' }),
    ],
    // Elasticsearch refuses to start unless the host allows enough memory maps,
    // and that is a kernel setting no container can make for itself.
    prepare: `sysctl -w vm.max_map_count=262144 >/dev/null 2>&1 || true
mkdir -p /etc/sysctl.d
grep -qs '^vm.max_map_count' /etc/sysctl.d/99-auto-deploy.conf || echo 'vm.max_map_count=262144' >> /etc/sysctl.d/99-auto-deploy.conf`,
    runArgs: ['--ulimit', 'nofile=65536:65536', '--ulimit', 'memlock=-1:-1'],
    detail: 'Runs a single-node Elasticsearch with its indices on a named volume. HTTPS is turned off so the API answers '
      + 'on plain HTTP; give it a password and the API needs the "elastic" user, leave it empty and it is open to anyone '
      + 'who can reach the port.',
    fields: [
      field('password', 'Password for the "elastic" user', {
        type: 'password', env: 'ELASTIC_PASSWORD',
        hint: 'At least 6 characters. Empty turns authentication off entirely — only safe on a private network.',
      }),
      field('heap', 'JVM heap', {
        default: '1g', placeholder: '1g',
        hint: 'Half the memory you can spare, as 512m or 2g. Elasticsearch is the one service here that needs to be told.',
      }),
    ],
  },
];

export const byKey = (key) => CATALOG.find((c) => c.key === key) || null;

/** The catalog as the browser needs it — the same shape, nothing secret in it. */
export const publicCatalog = () => CATALOG.map((c) => ({
  key: c.key,
  label: c.label,
  tagline: c.tagline,
  icon: c.icon,
  kind: c.kind,
  detail: c.detail,
  requiresDocker: Boolean(c.requiresDocker),
  image: c.image || null,
  defaultTag: c.defaultTag || null,
  tags: c.tags || [],
  defaultPort: c.defaultPort || null,
  containerPort: c.containerPort || null,
  extraPorts: c.extraPorts || [],
  fields: c.fields,
}));

/**
 * The extra ports as typed on the form, checked before anything is run.
 * An optional one left empty is simply not published.
 */
export function extraPortPlan(entry, values = {}) {
  const used = new Set();
  const list = [];

  for (const spec of entry.extraPorts || []) {
    const raw = String(values[spec.name] ?? '').trim();
    if (!raw) {
      if (spec.optional) continue;
      throw new Error(`${spec.label} is required for ${entry.label}`);
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${spec.label} must be a number between 1 and 65535`);
    }
    if (used.has(port)) throw new Error(`Port ${port} is given to two things — each needs its own`);
    used.add(port);
    list.push({ name: spec.name, label: spec.label, port, containerPort: spec.containerPort });
  }

  return list;
}

/**
 * Turn the submitted form into the container to run.
 * Returns { env, command } — the rest (ports, volume, network) is the same
 * for every entry and is assembled by the caller.
 */
export function containerPlan(entry, values = {}) {
  const env = {};
  for (const f of entry.fields) {
    const raw = String(values[f.name] ?? '').trim();
    if (f.required && !raw) throw new Error(`${f.label} is required for ${entry.label}`);
    if (raw && f.env) env[f.env] = raw;
  }

  const command = [];
  if (entry.key === 'redis') {
    // Redis takes its settings as arguments, not environment variables.
    command.push('redis-server', '--appendonly', 'yes');
    const password = String(values.password ?? '').trim();
    if (password) command.push('--requirepass', password);
  }

  if (entry.key === 'elasticsearch') {
    // One node on its own, and plain HTTP: with security on, 8.x would answer
    // over TLS with a self-signed certificate nothing else here would trust.
    env['discovery.type'] = 'single-node';
    env['xpack.security.enabled'] = env.ELASTIC_PASSWORD ? 'true' : 'false';
    env['xpack.security.http.ssl.enabled'] = 'false';
    env['bootstrap.memory_lock'] = 'false';

    const heap = String(values.heap ?? '').trim() || '1g';
    if (!/^\d{1,5}[mg]$/i.test(heap)) {
      throw new Error(`"${heap}" is not a heap size — use something like 512m or 2g`);
    }
    env.ES_JAVA_OPTS = `-Xms${heap.toLowerCase()} -Xmx${heap.toLowerCase()}`;

    if (env.ELASTIC_PASSWORD && env.ELASTIC_PASSWORD.length < 6) {
      throw new Error('Elasticsearch refuses a password shorter than 6 characters');
    }
  }

  if (entry.key === 'emqx') {
    if (String(values.dashboard_password ?? '').trim().length < 8) {
      throw new Error('EMQX refuses a dashboard password shorter than 8 characters');
    }
    env.EMQX_DASHBOARD__DEFAULT_USERNAME = 'admin';
  }

  return { env, command };
}

/** Which of a service's settings are worth showing back, with secrets dropped. */
export function publicSettings(entry, values = {}) {
  const out = {};
  for (const f of entry.fields || []) {
    const raw = String(values[f.name] ?? '').trim();
    if (!raw || f.secret) continue;
    out[f.name] = raw;
  }
  return out;
}
