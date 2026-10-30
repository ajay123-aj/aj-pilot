/**
 * The AJ Pilot documentation: one list of guides, shown on the public /docs
 * pages (where search engines find them) and inside the app on the Docs page.
 *
 * Each guide: slug (its address), category, title, summary (one line, also
 * the search description) and body (HTML). `audience: 'admin'` guides are for
 * super admins only and never appear publicly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const tip = (html) => `<div class="doc-tip">💡 ${html}</div>`;
const warn = (html) => `<div class="doc-warn">⚠️ ${html}</div>`;

export const DOC_CATEGORIES = [
  'Getting started', 'Servers', 'Apps & deployments', 'Domains & SSL', 'Docker & installs',
  'Databases', 'Accounts & integrations', 'Team & plan', 'Help', 'Platform admin',
];

/** A command with a Copy button, on the public docs and inside the app alike. */
const cmd = (text) => `<div class="su-cmd"><pre><code>${text}</code></pre><button type="button" class="btn su-copy" data-lp-copy>Copy</button></div>`;

export const DOCS = [
  /* ---------------------------------------------------------- getting started */
  {
    slug: 'ubuntu-server-setup',
    category: 'Getting started',
    title: 'Set up an Ubuntu server (one setup file)',
    summary: 'Turn any PC, laptop or mini-PC into a 24/7 server: install Ubuntu, run one file, connect it to AJ Pilot.',
    body: `
<p>An old PC, a laptop or a mini-PC makes a perfectly good server. Install Ubuntu Server on it, run <b>one setup file</b>,
and it is ready for AJ Pilot: SSH on, awake around the clock — lid closed, screen off, never sleeping — with a firewall and
automatic security updates. Then you just type its address into AJ Pilot.</p>
<p><a class="btn primary" href="/setup/aj-pilot-setup.sh" download>⬇ Download the setup file (aj-pilot-setup.sh)</a></p>

<h2>What you need</h2>
<ul>
  <li>A 64-bit PC, laptop or mini-PC — <b>2 GB RAM</b> minimum (4 GB or more is better) and <b>25 GB</b> of disk (an SSD helps a lot).</li>
  <li>A <b>USB stick of 4 GB or more</b> — it will be wiped.</li>
  <li>A <b>network cable</b> to your router — far steadier than Wi-Fi.</li>
  <li>A screen and keyboard, only while installing.</li>
</ul>
${warn('Installing Ubuntu <b>erases the whole disk</b> you pick. Copy off anything you want to keep first.')}

<h2>1. Download Ubuntu Server</h2>
<p>Get the <b>LTS</b> version from <a href="https://ubuntu.com/download/server" target="_blank" rel="noopener">ubuntu.com/download/server</a> —
the <b>Server</b> edition, not Desktop. LTS means five years of security updates.</p>

<h2>2. Write it to the USB stick</h2>
<p>With <a href="https://etcher.balena.io" target="_blank" rel="noopener">balenaEtcher</a> (Windows, Mac, Linux) or
<a href="https://rufus.ie" target="_blank" rel="noopener">Rufus</a> (Windows): pick the downloaded <code>.iso</code>, pick the stick, <b>Flash</b>.</p>

<h2>3. Start the machine from the stick</h2>
<p>Plug it in, power on and tap the boot-menu key straight away, then choose the USB stick:</p>
<table class="doc-table">
  <tr><th>Make</th><th>Boot-menu key</th></tr>
  <tr><td>Dell, Lenovo, Acer</td><td><kbd>F12</kbd></td></tr>
  <tr><td>HP</td><td><kbd>F9</kbd> or <kbd>Esc</kbd></td></tr>
  <tr><td>ASUS</td><td><kbd>F8</kbd> or <kbd>Esc</kbd></td></tr>
  <tr><td>MSI</td><td><kbd>F11</kbd></td></tr>
</table>
${tip('Does not start from USB? Open the BIOS (usually <kbd>F2</kbd> or <kbd>Del</kbd> at power-on), turn off <b>Secure Boot</b>, and try again.')}

<h2>4. Install Ubuntu</h2>
<ol class="doc-steps">
  <li><b>Network</b>: leave the cable plugged in — it gets an address by itself.</li>
  <li><b>Storage</b>: <i>Use an entire disk</i>.</li>
  <li><b>Profile</b>: your name, a server name (e.g. <code>home-server</code>), a <b>username</b> and a <b>password</b> — AJ Pilot signs in with these.</li>
  <li><b>SSH</b>: tick <b>Install OpenSSH server</b>.</li>
  <li>Skip the extra snaps, let it finish, <b>Reboot now</b>, and pull out the stick. Sign in at the <code>login:</code> prompt.</li>
</ol>

<h2>5. Run the setup file</h2>
<p><b>The quickest way</b> — on the machine, run:</p>
${cmd('curl -fsSL %%SITE_URL%%/setup/aj-pilot-setup.sh -o aj-pilot-setup.sh\nsudo bash aj-pilot-setup.sh --dry-run\nsudo bash aj-pilot-setup.sh')}
<p>The <code>--dry-run</code> line only shows what it would change; the last line does it. It takes a few minutes.</p>
<p><b>No internet on the machine yet, or prefer a USB stick?</b> <a href="/setup/aj-pilot-setup.sh" download>Download the file</a>,
copy it onto a stick, plug it into the machine, then:</p>
${cmd('lsblk -o NAME,SIZE,LABEL\nsudo mount /dev/sdb1 /mnt     # use the name lsblk showed for the stick\nsudo bash /mnt/aj-pilot-setup.sh')}
<p><b>Already have SSH from another computer?</b> Copy it over (Windows PowerShell, Mac or Linux), then run it there:</p>
${cmd('scp aj-pilot-setup.sh your-username@192.168.1.50:\nssh your-username@192.168.1.50\nsudo bash aj-pilot-setup.sh')}

<h2>What the file does</h2>
<table class="doc-table">
  <tr><th>Setting</th><th>What happens</th></tr>
  <tr><td>SSH</td><td>Installed and started — how AJ Pilot signs in</td></tr>
  <tr><td>Never sleep</td><td>No sleep, suspend or hibernate, even if something asks</td></tr>
  <tr><td>Lid closed</td><td>On a laptop, closing the lid does nothing</td></tr>
  <tr><td>Screen off</td><td>The screen goes dark after a minute of no typing; the computer keeps running</td></tr>
  <tr><td>Wi-Fi</td><td>Power saving off, so it never drops off the network</td></tr>
  <tr><td>Wake-on-LAN</td><td>Another device on the network can switch it on</td></tr>
  <tr><td>Firewall</td><td>Allows SSH (and web ports 80/443) <i>before</i> switching on — you cannot be locked out</td></tr>
  <tr><td>fail2ban</td><td>Bans addresses that keep guessing passwords</td></tr>
  <tr><td>Updates</td><td>Security updates install themselves every day</td></tr>
  <tr><td>Time</td><td>Automatic clock</td></tr>
  <tr><td>Sudo</td><td>Your user can use sudo without a password, so AJ Pilot needs none</td></tr>
  <tr><td>Swap</td><td>A 2 GB swap file on machines with under 4 GB of memory</td></tr>
</table>
<p>It is <b>safe to run again</b> — it only changes what is not set up yet. On a virtual machine or cloud server it skips the
laptop, screen and power settings by itself. If one step fails, the others still run, and the summary says which one and why.
Run <code>bash aj-pilot-setup.sh --help</code> for every option (SSH port, time zone, machine name, Docker…).</p>
${tip('Signed in to AJ Pilot? <b>Servers → + Add server → Start from a blank machine</b> lets you tick each setting — SSH port, screen timeout, time zone, Docker — before you download your own copy.')}

<h2>6. Connect it in AJ Pilot</h2>
<p>When it finishes, the file prints a <b>Connect it in AJ Pilot</b> box:</p>
<pre><code>    Host / IP       192.168.1.50
    Port            22
    SSH username    ajay
    Sudo password   leave empty (passwordless sudo is on)</code></pre>
<ol class="doc-steps">
  <li>Sign in to AJ Pilot and open <b>Servers → + Add server</b>.</li>
  <li>Paste that box into <b>Paste what the setup file printed</b> (in the <i>Start from a blank machine</i> guide) — or type the address, port and username into <b>My server is ready</b>.</li>
  <li>Type your password, click <b>Test connection</b>, then <b>Save &amp; connect</b>. See <a href="/docs/add-a-server">Add a server</a>.</li>
</ol>

<h2>Keep it running for years</h2>
<ul>
  <li><b>Switch back on after a power cut</b>: in the BIOS (<kbd>F2</kbd> or <kbd>Del</kbd> at power-on) set <i>Restore on AC power loss</i> (or <i>AC power recovery</i>) to <b>Power On</b>. No file can change this.</li>
  <li><b>Keep its address</b>: in your router, reserve the address the file showed (<i>DHCP reservation</i>), so it never changes.</li>
  <li><b>Laptop</b>: keep it plugged in. If the BIOS offers a <i>battery charge limit</i> (60–80%), turn it on.</li>
  <li><b>Airflow</b>: a hard surface with space around it — heat is what wears out an old laptop running all day.</li>
  <li><b>AJ Pilot runs elsewhere</b> (in the cloud)? A home address like <code>192.168.x.x</code> cannot be reached from outside — add a
    <a href="/docs/connectors">Connector</a> on a PC in the same network.</li>
</ul>
${warn('Running a file with <code>sudo</code> gives it full control of the machine. This one holds no passwords or keys and only changes what is listed above — download it and read it, or use <code>--dry-run</code>, before you run it.')}`,
  },
  {
    slug: 'getting-started',
    category: 'Getting started',
    title: 'Getting started with AJ Pilot',
    summary: 'From your first sign-in to a live app on your own domain, in five steps.',
    body: `
<p>AJ Pilot is autopilot for your servers: it connects to your Ubuntu servers over SSH and does the work you would
otherwise do by hand — deploying apps, running databases, setting up domains and SSL. There is nothing to install on
your servers first.</p>
<h2>1. Sign in and choose a plan</h2>
<p>Click <b>Get started</b> on the home page to create your account — or sign in with the one your organisation's admin made
for you. Each sign-in asks for a <b>6-digit code</b> we send you, and a new account first confirms its email address with a
link. After you sign in, if your organisation has no plan yet
you will see <b>Plan &amp; billing</b>. Pick the <b>Free</b> plan to start straight away, or a paid plan — a paid plan is
switched on as soon as your payment is confirmed. See <a href="/docs/plans-and-billing">Plans &amp; billing</a>.</p>
<h2>2. Add a server</h2>
<p>Open <b>Servers → + Add server</b>, enter its IP address and SSH login, and click <b>Save &amp; connect</b>.
<a href="/docs/add-a-server">Add a server</a> explains every field.</p>
<h2>3. Connect your accounts</h2>
<p>In <b>Account management</b>, connect <b>GitHub or GitLab</b> (for your code) and <b>Cloudflare</b> (for your domains).
Docker Hub is optional. See <a href="/docs/connect-github-gitlab">Connect GitHub or GitLab</a> and
<a href="/docs/connect-cloudflare">Connect Cloudflare</a>.</p>
<h2>4. Deploy an app</h2>
<p>Open <b>Apps → + Custom service</b>, choose the repository, branch and server, and deploy. You can watch every step
and its log. See <a href="/docs/deploy-an-app">Deploy an app</a>.</p>
<h2>5. Put it on your domain</h2>
<p>Tick <b>Add a domain</b> while creating the app — or add one later from the app's page — and AJ Pilot creates the DNS
record, the nginx site and a free SSL certificate. See <a href="/docs/app-domains">Put an app on your domain</a>.</p>
<h2>Then keep an eye on it</h2>
<p>Each app card shows how much CPU and memory the app uses, and its <b>Live stats</b> tab shows it second by second. See
<a href="/docs/monitoring">Monitor servers and apps</a>.</p>
${tip('Stuck? <a href="/docs/troubleshooting">Troubleshooting</a> covers the problems people hit most, and the <b>Get started</b> form on the home page reaches us directly.')}`,
  },

  /* ------------------------------------------------------------------ servers */
  {
    slug: 'add-a-server',
    category: 'Servers',
    title: 'Add a server',
    summary: 'Connect an Ubuntu server over SSH with a password or a private key.',
    body: `
<p>Any Ubuntu server you can reach over SSH works — DigitalOcean, AWS, Hetzner, Linode, Hostinger, or your own hardware.</p>
<ol class="doc-steps">
  <li>Open <b>Servers</b> and click <b>+ Add server</b>.</li>
  <li><b>Name</b> — anything that helps you recognise it, e.g. <code>prod-web-01</code>.</li>
  <li><b>Host / IP</b> and <b>Port</b> — the address you would use with <code>ssh</code>; the port is usually <code>22</code>.</li>
  <li><b>SSH username</b> — e.g. <code>root</code> or <code>ubuntu</code>.</li>
  <li><b>Authentication</b> — a <b>password</b>, or a <b>private key</b> with its passphrase if it has one.
    For a key, click <b>Import key file</b> and choose it (or drop the file on the key box), or paste the whole block,
    including the <code>-----BEGIN … KEY-----</code> lines.</li>
  <li><b>Sudo password</b> — only if your user needs a password for <code>sudo</code>.</li>
  <li>Click <b>Test connection</b>. When it succeeds, click <b>Save &amp; connect</b>.</li>
</ol>
<h2>Importing a private key file</h2>
<p>Choose <b>Private key</b> under Authentication, then <b>Import key file</b>. The file is read in your browser and only
its text goes into the form. Your key is usually in the <code>.ssh</code> folder of your home folder:</p>
<table class="doc-table">
  <tr><th>Computer</th><th>Where the key usually is</th></tr>
  <tr><td>Windows</td><td><code>C:\\Users\\<i>you</i>\\.ssh\\id_ed25519</code> or <code>id_rsa</code></td></tr>
  <tr><td>macOS / Linux</td><td><code>~/.ssh/id_ed25519</code> or <code>~/.ssh/id_rsa</code></td></tr>
  <tr><td>Cloud provider</td><td>The <code>.pem</code> file you downloaded when the server was created (e.g. AWS)</td></tr>
</table>
<ul>
  <li><b>Choose the private key</b> — the file <i>without</i> <code>.pub</code>. If you pick the <code>.pub</code> file,
    the panel tells you and nothing is filled in.</li>
  <li><b>A key with a passphrase</b> is recognised; the panel asks for it and moves you to the <b>Key passphrase</b> box.</li>
  <li><b>A PuTTY key (.ppk)</b> has to be converted first: open it in PuTTYgen, choose
    <b>Conversions → Export OpenSSH key</b>, and import that file.</li>
</ul>
<p>AJ Pilot then reads the whole machine — hardware, disks, network, open ports, services — and keeps an eye on it:
the dot next to each server turns red within seconds if it goes offline.</p>
${tip('Every password and key is encrypted before it is stored, and is never shown again.')}
${warn('"Connection timed out" means the server could not be reached: check the IP address, and that port 22 is open in the server\'s firewall and in your cloud provider\'s security group.')}
<h2>A brand-new machine? Use the setup file</h2>
<ol class="doc-steps">
  <li>Click <b>+ Add server → Start from a blank machine</b> and install Ubuntu as the first step shows.</li>
  <li>In <b>Run the setup file</b>, tick what you want — SSH, never sleep, keep running with the lid closed, screen off, firewall,
    automatic updates — and click <b>Download aj-pilot-setup.sh</b>.</li>
  <li>Copy the file to the machine (a USB stick works — the guide shows the commands) and run <code>sudo bash aj-pilot-setup.sh</code>.</li>
  <li>When it finishes it shows the <b>address, port and username</b> to type into AJ Pilot. Click <b>Next</b> and enter them.</li>
</ol>
${tip('Safe to run again. In a virtual machine or cloud server it skips the laptop and power settings by itself.')}`,
  },
  {
    slug: 'connectors',
    category: 'Servers',
    title: 'Reach servers behind a VPN (connectors)',
    summary: 'Manage office servers that only a PC on your VPN can reach — with a small program on that PC.',
    body: `
<p>Some servers can only be reached from inside your office network or VPN, so AJ Pilot cannot connect to them directly.
A <b>connector</b> solves this: a small program you run on a PC that <i>can</i> reach them (your laptop with the VPN
connected, say). The panel then reaches those servers through that PC.</p>
<h2>Set one up</h2>
<ol class="doc-steps">
  <li>Open <b>Connectors</b> in the side menu.</li>
  <li>Type a name (for example <code>Office laptop</code>) and click <b>Create connector</b>.</li>
  <li>Download it for that PC — <b>Windows</b>, <b>Mac</b> or <b>Ubuntu / Linux</b>. The download already knows your panel
    and its key, so there is nothing to type.</li>
  <li>On the PC, connect your VPN, then start the downloaded file. It needs Node.js 22 or newer and offers to install it if
    it is missing.</li>
  <li>Keep its window open. The connector shows as <b>online</b> on the Connectors page.</li>
  <li>Add the server as usual (<a href="/docs/add-a-server">Add a server</a>) with its office or VPN address. When the panel
    cannot reach it directly, it goes through the connector automatically.</li>
</ol>
<h2>Good to know</h2>
<ul>
  <li>The connector only makes one <b>outgoing</b>, encrypted connection to the panel. Nothing is opened on the PC and no
    router settings change.</li>
  <li>Servers reached this way only work while that PC is on, connected to the VPN and running the connector.</li>
  <li>Want it to reach only certain networks? Start it with <code>--allow 192.168.1.0/24</code> (several, separated by commas).</li>
  <li>Lost the PC, or someone left? <b>Delete</b> the connector, or make a new key for it — the old copy stops working at once.</li>
</ul>
${tip('Leaving the connector running all day? Use a PC that stays on, such as an office desktop, rather than a laptop that goes to sleep.')}`,
  },
  {
    slug: 'server-page',
    category: 'Servers',
    title: 'The server page and its tabs',
    summary: 'What each tab on a server shows, and what you can do from it.',
    body: `
<p>Click a server to open it. <b>Fetch system details</b> reads it again; <b>Test connection</b> checks the SSH login;
<b>Reboot</b> restarts the machine after you confirm — see <a href="/docs/reboot-a-server">Reboot a server</a>.</p>
<table class="doc-table">
  <tr><th>Tab</th><th>What it is for</th></tr>
  <tr><td>Overview</td><td>Operating system, CPU, memory, disks, a count of everything on it, and the <b>Statistics</b> chart — CPU, memory and disk over the last day, week or month. See <a href="/docs/monitoring">Monitor servers and apps</a>.</td></tr>
  <tr><td>Live</td><td>CPU, memory, load, network, disks, containers and the busiest processes, updating every 5 seconds — with a warning when something is close to its limit.</td></tr>
  <tr><td>Storage</td><td>A file manager: browse folders with their sizes, upload, download, edit, rename, copy, move, extract and change permissions.</td></tr>
  <tr><td>Network</td><td>Interfaces, addresses and every listening port with the program behind it.</td></tr>
  <tr><td>Processes</td><td>The busiest processes right now.</td></tr>
  <tr><td>System</td><td>Updates waiting, firewall, SSH settings and other details.</td></tr>
  <tr><td>Apps</td><td>The apps deployed on this server.</td></tr>
  <tr><td>Docker</td><td>Containers, images, networks and volumes — details, logs, start, stop, restart, remove.</td></tr>
  <tr><td>Nginx</td><td>Sites, upstreams and SSL certificates. See <a href="/docs/nginx-and-ssl">Nginx sites &amp; SSL</a>.</td></tr>
  <tr><td>Nginx Logs</td><td>Your website traffic, analysed: errors, slow pages, attackers — and how to fix each one. See <a href="/docs/nginx-logs">Nginx logs &amp; blocking attackers</a>.</td></tr>
  <tr><td>Cron</td><td>Scheduled jobs. See <a href="/docs/cron-jobs">Scheduled jobs</a>.</td></tr>
  <tr><td>Users</td><td>Ubuntu logins, passwords, sudo and SSH keys. See <a href="/docs/server-users">Server users &amp; SSH keys</a>.</td></tr>
  <tr><td>Services</td><td>systemd services. See <a href="/docs/create-a-service">Create a service</a>.</td></tr>
  <tr><td>Runners</td><td>CI runners installed on this server. See <a href="/docs/ci-runners">CI runners</a>.</td></tr>
  <tr><td>Terminal</td><td>A command line on the server, right in your browser. See <a href="/docs/terminal">Terminal</a>.</td></tr>
</table>
<p>The dot next to a server's name in the list shows whether it is <b>online</b>: the panel checks every few seconds that the
server answers, and every few minutes that it can still sign in. <b>Cannot sign in</b> means the server is up but its saved
password or key no longer works — edit the server and enter it again.</p>`,
  },
  {
    slug: 'monitoring',
    category: 'Servers',
    title: 'Monitor servers and apps',
    summary: 'See how much CPU, memory, disk and network your servers and apps use — right now and over the last month.',
    body: `
<p>AJ Pilot shows how hard your servers and apps are working in four places:</p>
<table class="doc-table">
  <tr><th>Where</th><th>What you see</th><th>How fresh</th></tr>
  <tr><td>A server's <b>Live</b> tab</td><td>The whole machine: CPU, memory, load, network, disks, every container and the busiest processes.</td><td>Every 5 seconds</td></tr>
  <tr><td><b>Statistics</b> on a server's or app's <b>Overview</b></td><td>CPU, memory (and disk for a server) over the last 24 hours, 7 days or 30 days, with how often it was normal, warning or critical.</td><td>A sample every 5 minutes</td></tr>
  <tr><td>Each app card on <b>Apps</b></td><td>The app's CPU, memory and network at a glance.</td><td>Every 20 seconds</td></tr>
  <tr><td>An app's <b>Live stats</b> tab</td><td>That app only: CPU, memory, network, disk activity and each of its containers.</td><td>Every 5 seconds</td></tr>
</table>

<h2>A server, live</h2>
<p>Open a server and click <b>Live</b>. The four tiles at the top show <b>CPU</b>, <b>Memory</b>, <b>Load average</b> and
<b>Network</b>, each with a small line of the last five minutes. Below them: each processor core, each disk and how full it
is, the containers on the server with what each one uses, and the processes using the most CPU and memory.</p>
<p>When something needs attention, a red or amber box at the top says what and why — for example <i>"/ is 93% full"</i> or
<i>"shop-api is restarting in a loop"</i>.</p>

<h2>An app, live</h2>
<p>Open an app (<b>View details</b>) and click the <b>Live stats</b> tab.</p>
<ul>
  <li><b>CPU</b> — how much processor time the app uses. Docker counts each core as 100%, so <b>150%</b> means one and a half
    cores are busy. The line under it shows the same as a share of the whole server.</li>
  <li><b>Memory</b> — how much memory the app holds, and its share of the server's memory. If you set a memory limit, it
    shows how close the app is to it.</li>
  <li><b>Network</b> — data in (↓) and out (↑) per second, and the totals since the app last started.</li>
  <li><b>Disk I/O</b> — how fast the app writes and reads its files, its number of processes and how many times it has restarted.</li>
  <li><b>Containers</b> — one row per container: running or not, how long it has been up, and its own CPU, memory, network and disk figures.</li>
</ul>
<p>A message appears above the tiles if a container is stopped, missing, restarting over and over, was stopped for using too
much memory, or is failing its health check.</p>
${tip('The first reading of network and disk shows <i>measuring…</i> — a speed needs two readings, so it fills in 5 seconds later.')}

<h2>History: the Statistics chart</h2>
<p>The <b>Overview</b> tab of every server and app ends with a <b>Statistics</b> chart. Choose <b>Daily</b>, <b>Weekly</b>
or <b>Monthly</b>. The coloured strip under the lines shows the worst moment of each hour or day:</p>
<table class="doc-table">
  <tr><th>Level</th><th>A server is…</th><th>An app is…</th></tr>
  <tr><td><span class="badge ok">Normal</span></td><td>Below every limit below.</td><td>All containers running, using less than 75% of the server's CPU and 80% of its memory.</td></tr>
  <tr><td><span class="badge warn">Warning</span></td><td>CPU from 75%, memory from 80%, a disk from 80% full, or a high load.</td><td>From 75% of the server's CPU or 80% of its memory.</td></tr>
  <tr><td><span class="badge err">Critical</span></td><td>CPU from 90%, memory from 92%, a disk from 90% full, a very high load, or Docker stopped.</td><td>A container down, restarting or unhealthy — or from 90% CPU / 92% memory of the server.</td></tr>
</table>
<p>Samples are only taken while the server is online, so a gap in the chart means the server could not be reached then.
History is kept for 35 days.</p>

<h2>Good to know</h2>
<ul>
  <li>A live view stops by itself after 15 minutes and reconnects — leave it open as long as you like.</li>
  <li>Leaving the tab or page closes its connection to the server, so nothing keeps running in the background.</li>
  <li>An app that is deploying, being removed or not deployed yet shows no usage until it is running.</li>
</ul>
${warn('An app using a lot of CPU or memory slows down <b>everything</b> on the same server. If one app is always near the top, give it its own server, or add a memory limit to keep it in check.')}`,
  },
  {
    slug: 'create-a-service',
    category: 'Servers',
    title: 'Create and manage a service (systemd)',
    summary: 'Keep a program running on your server, start it on boot, and read its logs.',
    body: `
<p>A <b>service</b> keeps a program running in the background, restarts it if it stops, and starts it again when the
server reboots. (For apps from a git repository, <a href="/docs/deploy-an-app">Deploy an app</a> is usually easier —
it runs them in Docker for you.)</p>
<h2>Create a service</h2>
<ol class="doc-steps">
  <li>Open the server and go to the <b>Services</b> tab.</li>
  <li>Click <b>+ Add service</b>.</li>
  <li><b>What to run</b>: a name (letters, numbers and dashes), a short description and the start command. Click a template —
    <b>Node script</b>, <b>npm start</b>, <b>Python</b> or <b>Shell script</b> — to fill it in, then change the path. The form warns you if the command is not a full path.</li>
  <li><b>Where and as whom</b>: the working directory and the user it runs as.</li>
  <li><b>Environment</b>: any variables, an environment file, or one of your saved environments.</li>
  <li><b>Keep it running</b>: <i>Restart if it crashes</i> is right for most programs. Leave <b>Start on boot</b> and <b>Start now</b> on.</li>
  <li>Click <b>Create service</b> — it is written, enabled on boot and started.</li>
</ol>
<h2>Manage services</h2>
<ul>
  <li>The counters at the top — <b>Running</b>, <b>Failed</b>, <b>Stopped</b>… — are also filters: click one to see just those.</li>
  <li>A red banner lists anything that has failed, with <b>Restart</b> and <b>Logs</b> right there.</li>
  <li>Each row has <b>Start</b>, <b>Stop</b> or <b>Restart</b>, and an <b>On boot</b> switch.</li>
  <li>Click a service's name for its details and last journal lines — the first place to look when something fails.</li>
</ul>
${tip('Only services AJ Pilot created can be deleted from here, so a system service can never be removed by accident.')}`,
  },
  {
    slug: 'cron-jobs',
    category: 'Servers',
    title: 'Scheduled jobs (cron)',
    summary: 'Run a command on a schedule — backups, clean-ups, reports.',
    body: `
<ol class="doc-steps">
  <li>Open the server and go to the <b>Cron</b> tab.</li>
  <li>Click <b>+ Add a job</b>, enter the command and when it should run. (If cron is missing, <b>Install cron on this server</b> first.)</li>
  <li>The schedule is shown in plain words, so you can check it before saving.</li>
</ol>
<p>Edit or remove jobs from the same list.</p>
${tip('Send a job\'s output to a file (<code>&gt;&gt; /var/log/myjob.log 2&gt;&amp;1</code>) so you can read what happened later in the <b>Storage</b> tab.')}`,
  },
  {
    slug: 'server-users',
    category: 'Servers',
    title: 'Server users & SSH keys',
    summary: 'Add, edit, lock and delete Ubuntu users, set passwords and sudo, and generate SSH keys — without a terminal.',
    body: `
<p>The <b>Users</b> tab of a server lists its Ubuntu accounts and lets you manage them: give a developer, a CI job or a
client their own login, and take it away again when they no longer need it.</p>

<h2>Who can use it</h2>
<p>Two checks happen before anything is shown. If either fails, the tab says <b>“You are not permitted”</b> and why:</p>
<ul>
  <li><b>Your role</b> — admins and editors can open the tab and add or change users; only admins can delete them or
    remove a key. View-only members are not permitted, because a Linux account can be given root. See
    <a href="/docs/team-and-roles">Team &amp; roles</a>.</li>
  <li><b>The server's SSH login</b> — the account the panel connects with must be able to become root: be
    <code>root</code>, have passwordless sudo, or have its sudo password stored on the server
    (<b>Edit server → Sudo password</b>). Fix that, then click <b>Check again</b>.</li>
</ul>

<h2>What the list shows</h2>
<p>Each user with its UID, whether it has <b>sudo</b>, how it logs in (<b>password</b>, <b>no password</b>, number of
<b>SSH keys</b>, <b>locked</b>), its groups, shell and last login. The account the panel logs in with is marked
<b>panel login</b>. Tick <b>Show system accounts</b> to see the accounts that belong to packages
(<code>www-data</code>, <code>mysql</code>…) — they are read-only.</p>

<h2>Add a user</h2>
<ol class="doc-steps">
  <li>Open the server, go to the <b>Users</b> tab and click <b>+ Add user</b>.</li>
  <li><b>Username</b> — lowercase letters, digits, <code>-</code> and <code>_</code>, e.g. <code>deploy</code>.
    <b>Full name</b> is optional.</li>
  <li><b>Password</b> — type one twice, or click <b>Generate a strong password</b> (it is copied for you). Leave it
    empty for a key-only login.</li>
  <li><b>SSH keys</b> — tick <b>Generate a new key pair</b>, and/or paste public keys, one per line
    (<code>ssh-ed25519 AAAA… you@laptop</code>).</li>
  <li><b>Access</b> — tick <b>Administrator (sudo)</b> to let the user run commands as root, and
    <b>Without asking for the password</b> for automation or key-only users. Choose the <b>Login shell</b> and any
    <b>Extra groups</b> — <code>docker</code> to run containers, <code>www-data</code> for web files.</li>
  <li>Click <b>Add the user</b>.</li>
</ol>
${tip('A user needs a password, an SSH key, or both — otherwise nobody could log in as them, and the panel will not create it.')}

<h2>New SSH key — save the private key</h2>
<p>When you generate a key, a fresh <code>ed25519</code> key pair is made on the server. Its public half goes into the
user's <code>~/.ssh/authorized_keys</code>; the private half is shown to you <b>once</b>:</p>
<ol class="doc-steps">
  <li>Click <b>Download</b> (or <b>Copy</b>) and keep the file safe — e.g. <code>~/.ssh/deploy_203.0.113.10</code>.</li>
  <li>On macOS or Linux, run <code>chmod 600</code> on it.</li>
  <li>Connect with <code>ssh -i ~/.ssh/deploy_203.0.113.10 deploy@203.0.113.10</code>.</li>
</ol>
${warn('The private key is not kept by the panel and is deleted from the server. If you close the window without saving it, generate a new key and remove the old one.')}

<h2>Change a user</h2>
<p>Open the row's <b>Actions</b> menu:</p>
<table class="doc-table">
  <tr><th>Action</th><th>What it does</th></tr>
  <tr><td>Edit</td><td>Full name, new password (leave empty to keep the old one), shell, groups and sudo.</td></tr>
  <tr><td>SSH keys</td><td>Lists the user's keys with their label and fingerprint. <b>Generate a new key</b> or
    <b>Paste a public key</b>, and <b>Remove</b> a key someone should no longer use.</td></tr>
  <tr><td>Lock login</td><td>Refuses password and SSH key logins until you <b>Unlock</b> it. Files and running jobs
    are left alone — the safe choice when someone leaves for a while.</td></tr>
  <tr><td>Delete</td><td>Stops the user's processes and removes the account. Choose <b>Delete, keep files</b> or
    <b>Delete with home folder</b>.</td></tr>
  <tr><td>Change password</td><td>For <code>root</code> only — root's password and SSH keys are the only things the panel
    changes on it.</td></tr>
</table>

<h2>What the panel will never do</h2>
<ul>
  <li>Delete, lock or rename <b>root</b>.</li>
  <li>Delete or lock the <b>panel login</b>, take its sudo away or remove its shell — the panel would lose access to the server.</li>
  <li>Change <b>system accounts</b> — they belong to packages.</li>
</ul>
${tip('Re-creating a user whose home folder was kept? Its files are handed to the new account, but the old <code>authorized_keys</code> is disabled, so the previous owner cannot log in with their old key.')}
${warn('Removing an SSH key from the panel login can lock the panel out if it is the key the panel uses. The panel warns you before removing a key from that account.')}
<p>Every change is written to the <b>Activity</b> log.</p>`,
  },
  {
    slug: 'reboot-a-server',
    category: 'Servers',
    title: 'Reboot a server',
    summary: 'Restart a server safely from its page, after a confirmation, and watch it come back.',
    body: `
<p>Reboot after kernel or security updates (the <b>System</b> tab shows when one is needed), or when a machine has stopped
responding properly.</p>
<ol class="doc-steps">
  <li>Open the server and click <b>Reboot</b> at the top of its page.</li>
  <li>Read the confirmation: every app, database and service on the server stops answering until it is back, and anyone
    signed in to it is disconnected.</li>
  <li>Click <b>Reboot now</b> to go ahead. <b>Cancel</b>, <kbd>Esc</kbd> or clicking outside changes nothing.</li>
  <li>The status turns <b>rebooting</b> and the page waits for the server. You are told when it is <b>back online</b> —
    usually within a minute or two.</li>
</ol>

<h2>Who can reboot</h2>
<ul>
  <li><b>Admins and editors</b> see the <b>Reboot</b> button; view-only members do not.</li>
  <li>The server's SSH login must be able to become root. If it cannot, you see <b>“You are not permitted to reboot this
    server”</b> — connect as root, give the login sudo, or store its sudo password with <b>Edit server</b>.</li>
</ul>
${tip('Apps deployed with AJ Pilot start again on their own after a reboot (their restart setting is <b>unless-stopped</b> unless you changed it), and so do services that are enabled on boot. The <b>System</b> tab shows <b>Reboot required</b> when updates are waiting for one.')}
${warn('If the server has not answered after five minutes, the page tells you. Check it in your cloud provider\'s console — a machine can hang while shutting down, or a disk check can make the start slow.')}
<p>Every reboot is written to the <b>Activity</b> log with who started it.</p>`,
  },
  {
    slug: 'file-manager',
    category: 'Servers',
    title: 'Files on your server',
    summary: 'Browse, upload, edit and manage files without an SFTP client.',
    body: `
<p>The <b>Storage</b> tab of a server is a file manager. Folders show their sizes, so you can see what fills a disk.</p>
<ul>
  <li><b>Upload</b> files (up to 50 MB each) and <b>download</b> any file.</li>
  <li><b>Edit</b> text files in the browser.</li>
  <li>Create folders and files, <b>rename</b>, <b>copy</b>, <b>move</b>, <b>extract</b> archives and change <b>permissions</b>.</li>
</ul>
${warn('Deleting is permanent. Key system folders are protected from accidental changes.')}`,
  },
  {
    slug: 'terminal',
    category: 'Servers',
    title: 'Terminal',
    summary: 'Type commands on your server in the browser — no SSH program needed.',
    body: `
<p>The <b>Terminal</b> tab of a server is a real command line on that server, signed in with the server's saved login.
Use it for anything the other tabs do not cover.</p>
<ol class="doc-steps">
  <li>Open the server and click the <b>Terminal</b> tab.</li>
  <li>Wait for the prompt, then type as you would in any SSH session. Copy and paste work as usual.</li>
  <li>Type <code>exit</code> or leave the tab when you are done.</li>
</ol>
<h2>Good to know</h2>
<ul>
  <li>Only <b>Admins</b> and <b>Editors</b> can open a terminal; <b>View only</b> members do not see the tab.</li>
  <li>A terminal nobody has typed into for <b>30 minutes</b> closes by itself.</li>
  <li>You can have up to <b>5</b> terminals open at once, across all your browser tabs.</li>
  <li>The <b>Activity</b> log records who opened and closed a terminal on which server — never what was typed.</li>
</ul>
${warn('Commands run for real, with the permissions of the server\'s login. A wrong <code>rm</code> or <code>reboot</code> cannot be undone from here.')}`,
  },
  {
    slug: 'nginx-and-ssl',
    category: 'Domains & SSL',
    title: 'Nginx sites & SSL certificates',
    summary: 'Install nginx, create sites and upstreams, and get free SSL certificates.',
    body: `
<p>Most people never need this page: <a href="/docs/app-domains">adding a domain to an app</a> sets nginx and SSL up
automatically. Use the <b>Nginx</b> tab of a server when you want to do it by hand.</p>
<ol class="doc-steps">
  <li>Open the server's <b>Nginx</b> tab. If nginx is not there yet, click <b>Install nginx on this server</b>.</li>
  <li>Click <b>+ Add domain</b> and pick what the domain should open: <b>AJ Pilot app</b>, <b>Port on this server</b> or <b>Static folder</b>.</li>
  <li>Type the domain, and at your DNS provider point its <b>A record</b> at the address the dialog shows.</li>
  <li>Leave <b>SSL required</b> ticked for a free Let's Encrypt certificate (installed for you; it renews on its own).</li>
</ol>
<p>The <b>SSL certificates</b> section shows each certificate's <b>days left</b> and which domains use it. If <b>Automatic renewal</b> says
<i>off</i>, click <b>Turn on</b>; if a certificate is expiring or expired, click <b>Renew everything due</b>.</p>
<p>Each domain is a card: 🔒 means it is secure, ⚠ means it is not — its <b>Add SSL</b> button fixes that. Use the search box and the
<b>Secure / Not secure / Disabled</b> filters when there are many. Load balancing across several servers is under <b>Load balancing</b> at the bottom of the tab:
<b>+ Add upstream</b>, give it a name, click the apps or ports that should share the traffic, and choose how it is shared
(<b>Take turns</b> is right for most apps). Each card shows which servers answer and what share of the traffic each one gets.</p>
${tip('Every change is checked with <code>nginx -t</code> before nginx reloads, so a mistake cannot take your sites down.')}`,
  },
  {
    slug: 'nginx-logs',
    category: 'Domains & SSL',
    title: 'Nginx logs & blocking attackers',
    summary: 'See what is going wrong on your websites, who is attacking them, and fix it — without reading raw log files.',
    body: `
<p>The <b>Nginx Logs</b> tab of a server reads nginx's access and error logs and turns them into plain answers: which pages
fail, which are slow, who is scanning or attacking the server — and, for each problem, how to fix it.</p>
<h2>Read the report</h2>
<ol class="doc-steps">
  <li>Open the server and click <b>Nginx Logs</b>. The latest requests are analysed straight away.</li>
  <li>Choose how many log lines to read — 5,000 up to 100,000. More lines go further back in time but take longer. Click <b>Analyse again</b> whenever you want a fresh look.</li>
</ol>
<p>The report shows:</p>
<ul>
  <li><b>Top findings</b> — each problem with its evidence and the fix, often with the exact nginx setting to use. For example:
    pages failing with server errors (5xx), an app that is too slow or refuses connections, uploads that are too large,
    pages that keep answering 404, certificates or TLS settings that are out of date, and logs that are never cleaned up.</li>
  <li><b>Top threats</b> — addresses guessing passwords on login pages, scanning for weak spots, or sending far more requests than normal.</li>
  <li><b>Requests over time</b>, the <b>status mix</b> (successes, redirects, errors) and the <b>busiest paths</b>.</li>
</ul>
<h2>Get more detail: install the analyzer</h2>
<p>With nginx's standard logs, the report already works. Click <b>Install analyzer</b> to also get <b>response times</b> and
figures per website: it adds a richer log format to nginx (checked before nginx reloads). <b>Remove analyzer</b> takes it out again.</p>
<h2>Block an attacker</h2>
<ul>
  <li>Click <b>Block</b> next to an address in the threats list — or <b>Block all</b> to block every one listed. You can also
    block a whole range, such as <code>203.0.113.0/24</code>.</li>
  <li>Blocked addresses get an error from nginx for every website on that server. See them under <b>Blocked addresses</b>
    and click <b>Unblock</b> to let one back in.</li>
  <li>For protection while nobody is watching, use <b>Install fail2ban with nginx jails</b>: it bans addresses that keep
    attacking, automatically.</li>
</ul>
${warn('Is your site behind Cloudflare\'s orange cloud? Then every visitor arrives from a Cloudflare address — the report tells you so. Blocking those would block real visitors, so block attackers in Cloudflare instead.')}
${tip('AJ Pilot keeps no copy of your logs: each analysis reads them on the server and shows the result.')}`,
  },

  /* ------------------------------------------------------ apps & deployments */
  {
    slug: 'deploy-an-app',
    category: 'Apps & deployments',
    title: 'Deploy an app',
    summary: 'Deploy Next.js, NestJS, Node.js, React, Angular, Nuxt or a static site from GitHub or GitLab.',
    body: `
<p>Before you start, connect your git account (<a href="/docs/connect-github-gitlab">how</a>) and add a server with
Docker installed (<a href="/docs/one-click-installs">how</a>).</p>
<ol class="doc-steps">
  <li>Open <b>Apps</b> and click <b>+ Custom service</b>.</li>
  <li>Choose the <b>Git account</b>, the <b>Repository</b> and the <b>Branch</b>.</li>
  <li><b>Project folder</b> — if the repository holds several projects (a monorepo), pick the folder to deploy.
    Otherwise leave it at the top.</li>
  <li><b>App name</b> and <b>Deploy onto</b> — the server it runs on.</li>
  <li><b>Project type</b> is detected for you (Next.js, NestJS, Nuxt, Angular, React/Vite/Vue, Node.js or static site).
    Check the <b>Install</b>, <b>Build</b> and <b>Start</b> commands, and the <b>Node version</b>.</li>
  <li>Add <b>Environment</b> variables if your app needs them (database URLs, API keys…).</li>
  <li>Optionally tick <b>Add a domain</b> — see <a href="/docs/app-domains">Put an app on your domain</a>.</li>
  <li>Deploy. Click <b>Check progress</b> to watch every step — clone, install, build, start — with its log.</li>
</ol>
<h2>After it is live</h2>
<p>The app's card shows its address, its status and how much <b>CPU</b>, <b>memory</b> and <b>network</b> it uses. Click
<b>View details</b> for everything else — <a href="/docs/manage-an-app">Manage a running app</a> walks through it.</p>
${warn('If a deploy fails, click <b>Check progress</b>: the step that failed shows the exact error from the build.')}`,
  },
  {
    slug: 'manage-an-app',
    category: 'Apps & deployments',
    title: 'Manage a running app',
    summary: 'Everything on an app\'s page: live usage, logs, settings, containers, environment, domains and removing it.',
    body: `
<p>Open <b>Apps</b> (or a server's <b>Apps</b> tab) and click <b>View details</b> on an app. The buttons along the top work
on the whole app; the tabs on the side show one part of it each.</p>
<h2>The buttons</h2>
<table class="doc-table">
  <tr><th>Button</th><th>What it does</th></tr>
  <tr><td>Deploy log / Check progress</td><td>The last deploy step by step, with its log — or the one running now.</td></tr>
  <tr><td>Container logs</td><td>What your app itself prints (errors, requests…). With several containers, choose which one.</td></tr>
  <tr><td>Edit settings</td><td>Branch, project type, Node version, install / build / start commands, port, restart policy, Docker network and Docker Hub. <b>Redeploy now</b> is ticked, so the change goes live straight away; untick it to wait for the next deploy.</td></tr>
  <tr><td>Environment</td><td>See and change the app's variables. The containers restart with the new values in seconds — no rebuild — or untick the option to wait for the next deploy.</td></tr>
  <tr><td>Containers</td><td>How many copies of the app run and which port each one uses on the server.</td></tr>
  <tr><td>+ Domain</td><td>Put the app on another domain — see <a href="/docs/app-domains">Put an app on your domain</a>.</td></tr>
  <tr><td>Redeploy</td><td>Fetch the branch again, rebuild and restart. Use it after pushing new code (or turn on <a href="/docs/auto-deploy">auto deploy</a>).</td></tr>
  <tr><td>Start / Stop / Restart</td><td>Run or halt the app's containers without rebuilding.</td></tr>
  <tr><td>Remove</td><td>Take the app off the server — see below.</td></tr>
</table>
<p><b>View only</b> team members see the app but not the buttons that change it.</p>
<h2>The tabs</h2>
<table class="doc-table">
  <tr><th>Tab</th><th>What it shows</th></tr>
  <tr><td>Overview</td><td>Status, containers running, live domains, image size, last deploy, where it runs, the commit that is live, and the <b>Statistics</b> chart of the last day, week or month.</td></tr>
  <tr><td>Live stats</td><td>CPU, memory, network and disk use, every 5 seconds, for the app and each of its containers. See <a href="/docs/monitoring">Monitor servers and apps</a>.</td></tr>
  <tr><td>Settings</td><td>How the app is built and run.</td></tr>
  <tr><td>Auto deploy</td><td>Whether a push or a merge deploys it by itself.</td></tr>
  <tr><td>Deploy history</td><td>Every deploy: who or what started it, the commit, whether it worked, and its log.</td></tr>
  <tr><td>Domains</td><td>Each domain with its status; <b>Setup log</b>, <b>Retry</b> or <b>Remove</b> one.</td></tr>
  <tr><td>Containers</td><td>Each container, the port it answers on, and whether it is running.</td></tr>
  <tr><td>Environment &amp; volumes</td><td>The names of its variables (values stay hidden) and the volumes that keep its data.</td></tr>
  <tr><td>Activity</td><td>Everything done to this app, by whom and when.</td></tr>
</table>
<h2>Keep data between deploys: volumes</h2>
<p>Each deploy starts the app in a fresh container, so files it writes (uploads, a SQLite database…) are lost — unless
they are in a <b>volume</b>. Add one when creating the app, giving the folder inside the app to keep (for example
<code>/app/uploads</code>). The same volume is mounted again at every deploy.</p>
<h2>Run several copies</h2>
<p>Open <b>Containers</b> and add more. Each copy gets its own port on the server, and each domain is pointed at the port
you choose when adding it. Extra copies keep the app answering while one restarts — but each one uses its own memory.</p>
<h2>Remove an app</h2>
<p><b>Remove</b> stops and deletes its containers, and takes down each of its domains — DNS record or tunnel, nginx site and
certificate. You choose whether to keep its <b>volumes</b> (its saved data). It takes a minute or two; the card shows each step.</p>
${warn('Removing cannot be undone. Unless you keep the volumes, anything the app saved on the server is deleted with it.')}`,
  },
  {
    slug: 'auto-deploy',
    category: 'Apps & deployments',
    title: 'Auto deploy on merge or push',
    summary: 'Let an app rebuild itself when its branch changes — on every push, or only on merged pull / merge requests.',
    body: `
<p>With auto deploy on, an app follows its branch: when <code>main</code> (or <code>master</code>, <code>dev</code>, any branch)
changes, the panel rebuilds and restarts it by itself, and records exactly which change went live.</p>
<h2>Turn it on</h2>
<ol class="doc-steps">
  <li>When you create the app (<b>Apps → + Custom service</b>) pick the <b>branch</b>, and tick
    <b>Auto deploy when <i>branch</i> changes</b>. For an existing app, open it and use its <b>Auto deploy</b> tab.</li>
  <li>Choose what deploys it:
    <ul>
      <li><b>Every push or commit</b> — any new commit on the branch, direct pushes and merges. Good for a dev or staging server.</li>
      <li><b>Only merged pull / merge requests</b> — a reviewed change merged into the branch, e.g. <code>dev → main</code>.
        Direct pushes are left alone. Good for production.</li>
    </ul>
  </li>
  <li>Save. The panel adds a <b>webhook</b> to the repository on GitHub, GitLab or Bitbucket, so a change starts a deploy
    within seconds.</li>
</ol>
${tip('If the panel cannot be reached from the internet (a server at home or behind a firewall), the webhook cannot call it — the branch is then checked every minute instead, and the deploy starts at the next check.')}
<h2>Watch a deploy</h2>
<ul>
  <li>The app's card shows a <b>progress bar</b> with the step it is on while an auto deploy runs.</li>
  <li>Open it for the <b>live log</b>, step by step.</li>
</ul>
<h2>Deploy history</h2>
<p>The <b>Deploy history</b> tab of an app keeps every deploy: the <b>branch</b>, whether it came from a <b>merge</b> (with the
pull / merge request number and title) or a <b>commit</b>, the commit and its author, <b>when</b> it happened,
whether it worked — and its full <b>log</b>.</p>
${warn('Auto deploy needs the git account that owns the repository to be connected (see <a href="/docs/connect-github-gitlab">Connect GitHub or GitLab</a>) so the webhook can be added. If adding it fails, the minute-by-minute check is used instead.')}`,
  },
  {
    slug: 'environments',
    category: 'Apps & deployments',
    title: 'Environments',
    summary: 'Keep database URLs, API keys and secrets once — encrypted — and use them for any app, install or service.',
    body: `
<p>An <b>environment</b> is a named set of variables — <code>shop-production</code>, <code>shop-staging</code> — kept once in
the panel instead of pasted into every app. Values are encrypted with AES-256.</p>
<h2>Create one</h2>
<ol class="doc-steps">
  <li>Open <b>Environments</b> in the main menu and click <b>+ New environment</b>.</li>
  <li>Give it a <b>name</b> (and a description if you like).</li>
  <li>Click <b>Import a .env file</b> to read an existing file — comments are skipped and quoted values keep their
    spaces — and/or <b>+ Add variable</b> to type them. Switch to <b>.env text</b> to edit it as plain text.</li>
  <li>Click <b>Save environment</b>.</li>
</ol>
${tip('<b>Import .env file</b> at the top of the Environments page creates a new environment straight from a file.')}
<h2>Use it</h2>
<p>When you create an <b>app</b>, a <b>one-click install</b> or a <b>systemd service</b>, the <b>Environment</b> box offers:</p>
<ul>
  <li><b>Use an existing one</b> — pick it, and its variables fill the form.</li>
  <li><b>Create a new environment</b> — the variables you type are saved under the name you give, ready for next time.</li>
  <li><b>None</b> — the variables are kept only with that app or service.</li>
</ul>
<h2>Manage them</h2>
<p>Each environment's <b>Actions</b> menu has <b>View</b>, <b>Edit</b>, <b>Download .env</b>, <b>Duplicate</b> (a staging
copy of production, say) and <b>Delete</b>. The list shows which apps and services use each one.</p>
<ul>
  <li><b>View</b> hides the values until you click <b>Show values</b>.</li>
  <li>When you edit an environment that apps were made from, you can copy the change to them; their own extra values are kept.</li>
  <li><b>View-only</b> team members see the variable names, never the values.</li>
</ul>`,
  },
  {
    slug: 'app-domains',
    category: 'Domains & SSL',
    title: 'Put an app on your domain',
    summary: 'DNS + nginx + free SSL, a Cloudflare Zero Trust tunnel, or direct nginx with your own DNS — set up for you.',
    body: `
<p>For the two Cloudflare options, connect Cloudflare first (<a href="/docs/connect-cloudflare">how</a>) — your domain must be in that Cloudflare account.
Domain somewhere else? Use <b>Direct — nginx</b>, below.</p>
<h2>While creating an app</h2>
<ol class="doc-steps">
  <li>Tick <b>Add a domain</b>.</li>
  <li>Choose the Cloudflare account and the <b>Main domain</b> (e.g. <code>example.com</code>).</li>
  <li>Type the <b>Subdomain</b> (e.g. <code>shop</code> for <code>shop.example.com</code>), or leave it empty for the main domain itself.</li>
  <li>Choose how it is published:
    <ul>
      <li><b>DNS — nginx + free SSL certificate</b>: a DNS record pointing at the server's public IP, an nginx site and a Let's Encrypt certificate. The server needs ports 80 and 443 open.</li>
      <li><b>Zero Trust</b>: a Cloudflare Tunnel — no open ports needed, ideal for servers behind a firewall or at home.</li>
      <li><b>Direct — nginx (your own DNS)</b>: no Cloudflare needed. Type the full hostname, then at your DNS provider add an
        <b>A record</b> pointing it at the server's public IP. Tick <b>SSL required</b> for a free HTTPS certificate (the A record must be in place);
        leave it off to serve plain HTTP.</li>
    </ul></li>
</ol>
<h2>Later, or more than one domain</h2>
<p>Open the app's page and click <b>+ Add domain</b>. An app can have as many domains as it needs; each one shows its own status
and log, and can be retried or removed.</p>
<h2>From the Nginx tab</h2>
<p>On a server's <b>Nginx</b> tab, click <b>+ Add domain</b> and choose <b>A custom app on AJ Pilot</b> under <i>What it serves</i>.
Pick the server, then the app (and its container, if it runs several), type the domain and choose whether <b>SSL is required</b>.
The domain then appears on the app's page like any other.</p>
${warn('The app works on the IP address but not on the domain? DNS can take a few minutes. Then check that ports 80/443 are open (DNS mode), and open the domain\'s log on the app page — it shows which step failed.')}`,
  },

  /* ------------------------------------------------------- docker & installs */
  {
    slug: 'one-click-installs',
    category: 'Docker & installs',
    title: 'One-click installs: Docker, databases and more',
    summary: 'Install Docker, then MySQL, PostgreSQL, MongoDB, Redis, EMQX or Elasticsearch as containers.',
    body: `
<ol class="doc-steps">
  <li>Open <b>Installations</b>.</li>
  <li>Install <b>Docker Engine</b> (and <b>Docker Compose</b>) on the server first — everything else runs on it.</li>
  <li>Then install what you need: <b>MySQL</b>, <b>PostgreSQL</b>, <b>MongoDB</b>, <b>Redis</b>, <b>EMQX</b> or <b>Elasticsearch</b>.
    Choose the server, the port and a password where asked.</li>
</ol>
<p>Each one runs as a container with a named volume, so its data survives upgrades and restarts. You can
<b>change its port</b>, read its <b>logs</b>, restart it, or remove it — removing keeps the data volume unless you say otherwise.</p>
${tip('After installing a database, add it under <b>Databases</b> to manage it — see <a href="/docs/databases">Manage databases</a>.')}`,
  },
  {
    slug: 'docker-containers',
    category: 'Docker & installs',
    title: 'Docker containers',
    summary: 'See every container, its live logs and stats; start, stop, restart, back up or remove it.',
    body: `
<p>The <b>Docker</b> tab of a server shows every container as a card: green when it is running, red when it has stopped or crashed.
🚀 marks your apps, 📦 services the panel installed, 🐳 anything else.</p>
<ul>
  <li>Each running container shows its <b>CPU</b>, <b>memory</b>, <b>network</b> and <b>disk</b> use, refreshed every 15 seconds.
    The <b>Docker usage</b> strip adds them up and shows how much disk images, volumes and build cache take — and how much you could free.</li>
  <li>Use the search box and the <b>Running / Stopped / Apps / Installed</b> filters to find one quickly.</li>
  <li>Click a port chip such as <code>4200 → 80</code> to open it in the browser.</li>
  <li>Click a container's name or <b>Details</b> to open its own page. The back button takes you to the Docker tab again.</li>
  <li><b>Live stats</b> shows CPU, memory, network and disk every few seconds; <b>Logs</b> shows new lines as they are written — use <b>Pause</b>, the filter box or <b>Download .log</b>.</li>
  <li><b>Volumes</b> lists what the container stores its data in, with the size of each and a <b>Download</b> button.</li>
  <li>The <b>Download</b> menu saves a <b>Compose file (YAML)</b> to recreate the container, or a <b>Backup (.tar.gz)</b> with the compose file and a copy of every volume. Tick <b>Pause while copying</b> for databases.</li>
  <li><b>Start</b>, <b>stop</b>, <b>restart</b>, <b>pause</b> or <b>remove</b> it from the top of the page.</li>
  <li>Clean up unused <b>images</b>, <b>networks</b> and <b>volumes</b>, download any volume, and create Docker networks.</li>
  <li><b>Sign in to a registry</b> to pull private images.</li>
</ul>
${tip('Downloads need a role that can edit. Compose files and backups contain passwords and your data — keep them somewhere safe.')}`,
  },

  /* ---------------------------------------------------------------- databases */
  {
    slug: 'databases',
    category: 'Databases',
    title: 'Manage databases (MySQL, PostgreSQL, MongoDB, Redis, Elasticsearch)',
    summary: 'Connect a database, browse it, manage users and privileges, and run queries.',
    body: `
<ol class="doc-steps">
  <li>Open <b>Databases</b> and click <b>+ Add database connection</b>.</li>
  <li>Choose the type — MySQL, PostgreSQL, MongoDB, Redis or Elasticsearch — and enter its host, port, user and password.</li>
  <li>Pick a <b>server</b> to connect through if the database only listens on <code>localhost</code>: AJ Pilot reaches it
    over that server's SSH, so you never have to open the database port to the internet.</li>
  <li><b>Test connection</b>, then save.</li>
</ol>
<h2>What you can do</h2>
<ul>
  <li>See statistics: size, connections, the largest tables or collections.</li>
  <li>Browse databases, tables, columns, indexes, collections and keys.</li>
  <li>Create and drop databases; create <b>users</b> and give them exactly the <b>privileges</b> they need.</li>
  <li>Read and change server <b>settings</b>.</li>
  <li><b>Run query</b> for anything the screens do not answer.</li>
</ul>
<h2>Elasticsearch</h2>
<ul>
  <li>Connect on port <code>9200</code> as <code>elastic</code> (or another superuser), or with no username and password if
    security is off. Tick <b>TLS</b> if the cluster uses <code>https://</code>.</li>
  <li><b>Overview</b> shows cluster health (green, yellow or red), nodes, memory, disk and shards.</li>
  <li><b>Indices</b> takes the place of databases: create an index with its shards and replicas, delete one, and open
    it to see its fields, sample documents, aliases and settings. Click a field to see its most common values.</li>
  <li><b>Users</b>: create users and give them a role, or read / write / full access to an index pattern such as
    <code>logs-*</code>.</li>
  <li><b>Run query</b> uses the same syntax as Kibana Dev Tools, for example <code>GET /_cat/indices</code> or
    <code>POST /orders/_search</code> with a JSON body. Only reads are allowed.</li>
</ul>
${tip('On a single server, create indices with 0 replicas — otherwise the copies have nowhere to go and the index shows yellow.')}
${warn('Queries run against your real data — double-check anything that changes or deletes rows.')}`,
  },

  /* ---------------------------------------------------- accounts & integrations */
  {
    slug: 'connect-github-gitlab',
    category: 'Accounts & integrations',
    title: 'Connect GitHub, GitLab or Bitbucket',
    summary: 'Give AJ Pilot access to your repositories to deploy them.',
    body: `
<ol class="doc-steps">
  <li>Open <b>Account management</b> and click <b>+ Add git account</b>.</li>
  <li>Choose <b>GitHub</b>, <b>GitLab</b> or <b>Bitbucket</b>. Your company runs its own GitHub Enterprise or GitLab?
    Choose it and enter its address.</li>
  <li>Sign in in the window that opens and approve access. (Or paste a personal access token instead.)</li>
  <li>Your repositories, branches and recent commits now appear when you deploy an app.</li>
</ol>
<p>The access token is stored encrypted and refreshed automatically when the provider expires it. If access is ever
revoked, open the account and click <b>Re-authenticate</b>.</p>
${tip('A personal access token needs read access to your repositories (<code>repo</code> on GitHub, <code>read_repository</code> + <code>read_api</code> on GitLab). To add CI runners it also needs admin rights on the repository or organisation.')}`,
  },
  {
    slug: 'connect-cloudflare',
    category: 'Accounts & integrations',
    title: 'Connect Cloudflare (API token)',
    summary: 'Create the Cloudflare API token AJ Pilot needs for DNS, SSL and tunnels.',
    body: `
<ol class="doc-steps">
  <li>Open <b>Account management</b> and click <b>+ Connect Cloudflare</b>.</li>
  <li>Click <b>Sign in with Cloudflare ↗</b>. The token page opens with the right settings filled in.</li>
  <li>Check the permissions, create the token and copy it.</li>
  <li>Paste it back into AJ Pilot and click <b>Connect</b>.</li>
</ol>
<h2>The permissions the token needs</h2>
<ul>
  <li>Zone: Edit · Zone Settings: Read · DNS: Edit</li>
  <li>Account Settings: Read · User Details: Read</li>
  <li>Cloudflare Tunnel: Edit · Zero Trust: Edit <span class="muted">(only for Zero Trust domains)</span></li>
</ul>
<p>Once connected, the account page shows your domains and their DNS records, which you can add, edit and delete, and
your Zero Trust tunnels.</p>`,
  },
  {
    slug: 'connect-docker-hub',
    category: 'Accounts & integrations',
    title: 'Connect Docker Hub',
    summary: 'Browse your Docker Hub repositories and use private images.',
    body: `
<ol class="doc-steps">
  <li>Open <b>Account management</b> and click <b>+ Connect Docker Hub</b>.</li>
  <li>Click <b>Sign in with Docker Hub ↗</b> and create an access token with <b>Read, Write, Delete</b> permissions.</li>
  <li>Paste your Docker Hub username and the token, then click <b>Connect</b>.</li>
</ol>
<p>You can then browse repositories and tags, and apps can push their images to your Docker Hub.</p>`,
  },
  {
    slug: 'ci-runners',
    category: 'Accounts & integrations',
    title: 'CI runners (GitHub Actions & GitLab)',
    summary: 'Install a self-hosted runner on your server in two minutes.',
    body: `
<ol class="doc-steps">
  <li>Open your git account in <b>Account management</b>.</li>
  <li>Click <b>+ Add runner</b>, choose the repository or organisation and the server.</li>
  <li>AJ Pilot registers the runner, installs it and keeps it running under systemd.</li>
</ol>
<p>The runner's live status appears on the account page and on the server's <b>Runners</b> tab. Your pipelines can now
build and deploy on your own server.</p>`,
  },

  /* ------------------------------------------------------------ team & plan */
  {
    slug: 'team-and-roles',
    category: 'Team & plan',
    title: 'Your team, roles and profile',
    summary: 'Add people with the right role, and manage your own account.',
    body: `
<h2>Roles</h2>
<table class="doc-table">
  <tr><th>Role</th><th>Can do</th></tr>
  <tr><td>Admin</td><td>Everything in the organisation, including its team and its plan.</td></tr>
  <tr><td>Editor</td><td>Add and change servers, apps, domains and databases, and open a server's Terminal — but not the team.</td></tr>
  <tr><td>View only</td><td>Look at everything; change nothing.</td></tr>
</table>
<h2>Add a person</h2>
<ol class="doc-steps">
  <li>Open the menu at the top right → <b>Settings</b> → <b>Team</b>.</li>
  <li>Click <b>+ Add person</b>: name, email, role and a password for them. Admins need a <b>mobile number</b>.</li>
  <li>Give them the email and password; they can change the password once signed in.</li>
</ol>
<p>Changing someone's role or password, or disabling them, signs them out everywhere. Your plan decides how many people
you can add.</p>
<h2>Your own account</h2>
<p>From the menu at the top right: <b>Edit profile</b> (name, email, mobile number) and <b>Change password</b>.
<b>Activity</b> shows who changed what.</p>
<h2>Signing in</h2>
<p>After your email and password, AJ Pilot sends a <b>6-digit code</b> to your mobile number (or your email, if no number is
saved). Type it in within 10 minutes. Did not get it? Wait 30 seconds and ask for a new one.</p>
<h2>More than one organisation</h2>
<p>If you belong to several organisations — your company and a client's, say — open <b>Settings → Organisations</b> and
click <b>Work in it</b> to switch. Servers, apps and accounts are never shared between organisations, so you only see the
ones of the organisation you are working in.</p>`,
  },
  {
    slug: 'plans-and-billing',
    category: 'Team & plan',
    title: 'Plans & billing',
    summary: 'Choose or change your plan, and see how much of it you use.',
    body: `
<p>Open <b>Plan &amp; billing</b> in the side menu. It shows your plan, when it renews, and how much of each limit you use:
servers, apps, team members, database connections and domains.</p>
<h2>Choose or change a plan</h2>
<ol class="doc-steps">
  <li>Pick <b>Monthly</b> or <b>Yearly</b> and click the plan you want.</li>
  <li>The <b>Free</b> plan starts immediately.</li>
  <li>A paid plan is sent as a <b>request</b>: it switches on as soon as your payment is confirmed. Your current plan keeps working until then, and you can withdraw the request.</li>
</ol>
<p>Only an <b>admin</b> of your organisation can change the plan. When a limit is reached, AJ Pilot tells you which one —
upgrade to add more.</p>`,
  },

  /* -------------------------------------------------------------------- help */
  {
    slug: 'troubleshooting',
    category: 'Help',
    title: 'Troubleshooting',
    summary: 'The problems people run into most, and how to fix them.',
    body: `
<h2>"Connection timed out" when adding a server</h2>
<p>The server could not be reached. Check the IP address and port, and that SSH (port 22) is allowed in the server's
firewall (<code>ufw</code>) and in your cloud provider's security group or firewall.</p>
<h2>"Authentication failed"</h2>
<p>The username, password or key is wrong. For keys, paste the whole private key including its first and last lines.</p>
<h2>A deploy failed</h2>
<p>Open the app and click <b>Check progress</b> — the failed step shows the build's own error. Common causes: a missing
environment variable, the wrong Node version, or the wrong project folder in a monorepo.</p>
<h2>The app works on its IP address but not on its domain</h2>
<ul>
  <li>Give DNS a few minutes after adding the domain.</li>
  <li>In DNS mode the server needs ports 80 and 443 open.</li>
  <li>Open the domain's log on the app page; use <b>Retry</b> after fixing the cause.</li>
  <li>Behind a firewall? Use a <b>Zero Trust</b> domain instead — it needs no open ports.</li>
</ul>
<h2>A server shows "offline" or "cannot sign in"</h2>
<ul>
  <li><b>Offline</b>: the panel cannot reach the server at all. Check it is switched on and that port 22 is open. If it is
    only reachable on your office network or VPN, use a <a href="/docs/connectors">connector</a>.</li>
  <li><b>Cannot sign in</b>: the server answers but its saved password or key was changed. Edit the server and enter the new one.</li>
</ul>
<h2>An app card says "Usage unavailable"</h2>
<p>The panel could not read the app's containers. The reason follows on the card: usually the server is offline, or
<b>Docker is not running</b> on it — open the server's <b>Docker</b> tab, or restart Docker from its <b>Terminal</b>
with <code>sudo systemctl start docker</code>.</p>
<h2>The app's CPU shows more than 100%</h2>
<p>That is normal: each processor core counts as 100%, so 250% means two and a half cores are busy. The line underneath
shows the same as a share of the whole server.</p>
<h2>"Too many live views are open at once"</h2>
<p>Each live view keeps a connection to a server open. Close the Live or Live stats tabs you are not watching — in other
browser tabs too — and try again.</p>
<h2>The Statistics chart is empty</h2>
<p>A sample is taken every 5 minutes while the server is online, so a server or app added a moment ago has nothing to
show yet. Check back in a few minutes.</p>
<h2>"Your plan allows …"</h2>
<p>You have reached a limit of your plan. See <a href="/docs/plans-and-billing">Plans &amp; billing</a> to upgrade.</p>
<h2>"Your organisation has no active plan"</h2>
<p>Choose a plan on <b>Plan &amp; billing</b>, or ask your organisation's admin to.</p>
<h2>Still stuck?</h2>
<p>Use the <b>Get started</b> form on the <a href="/#contact">home page</a> — tell us what you were doing and the exact message you saw.</p>`,
  },
  {
    slug: 'security',
    category: 'Help',
    title: 'Security & your data',
    summary: 'How AJ Pilot keeps your servers, passwords and keys safe.',
    body: `
<ul>
  <li><b>No agents:</b> AJ Pilot talks to your servers over SSH only. Nothing is installed on them behind your back.</li>
  <li><b>Encrypted secrets:</b> SSH passwords and keys, provider tokens and database passwords are encrypted with AES-256-GCM before they are stored. No page or API ever shows them again.</li>
  <li><b>Hashed passwords:</b> sign-in passwords are hashed with scrypt.</li>
  <li><b>Roles checked on the server</b> for every change, whatever the browser sends.</li>
  <li><b>Sessions you can end:</b> a new password or role signs that person out everywhere.</li>
  <li><b>Organisations are separate:</b> nothing is shared between them, not even by guessing an id.</li>
  <li><b>Activity log:</b> every change is recorded with who made it.</li>
  <li><b>A code at every sign-in:</b> a password alone is not enough — each sign-in also needs a one-time code sent to you.</li>
  <li><b>Terminal privacy:</b> the browser terminal records only who opened it and when — never what was typed.</li>
  <li><b>Connectors open nothing:</b> a connector on your PC only makes an outgoing connection to the panel, and stops the moment you delete it.</li>
  <li><b>No copies of your logs:</b> nginx logs are read on your server for each analysis and are not stored by AJ Pilot.</li>
</ul>`,
  },

  /* ---------------------------------------------------------- platform admin */
  {
    slug: 'admin-platform',
    category: 'Platform admin',
    audience: 'admin',
    title: 'Running the platform',
    summary: 'The super admin: dashboard, organisations, clients and opening an organisation.',
    body: `
<p>Super admins run the platform and belong to no organisation. The side menu shows the platform pages only.</p>
<ul>
  <li><b>Dashboard</b> — revenue (MRR, ARR), organisations, clients, plan requests, renewals and everything under management.</li>
  <li><b>Organisations</b> — every client organisation. <b>View</b> opens its page: plan, usage, clients, plan history and payments.
    <b>Open</b> takes you inside it to work on its servers and apps; the yellow banner has <b>Back to super admin</b>.</li>
  <li><b>Clients</b> — everyone in every organisation. Add, edit, move or remove people.</li>
  <li><b>Super admins</b> — the people who run the platform. Mobile numbers are required.</li>
</ul>
${tip('A suspended organisation keeps all its data, but its people cannot use the panel until it is reactivated.')}`,
  },
  {
    slug: 'admin-plans-payments',
    category: 'Platform admin',
    audience: 'admin',
    title: 'Plans, requests & payments',
    summary: 'Create plans, activate plan requests and record payments.',
    body: `
<h2>Plans</h2>
<p><b>Plans → + Plan</b>: name, monthly and yearly price, limits (empty = unlimited), features and whether it is public.
Public, active plans appear on the home page's pricing and on clients' <b>Plan &amp; billing</b>.</p>
<h2>Plan requests</h2>
<p>When a client chooses a paid plan it arrives as a request — on the dashboard and on the organisation. Record the payment,
then click <b>Activate</b>. <b>Decline</b> keeps them on their current plan.</p>
<h2>Payments</h2>
<p><b>+ Record payment</b> on an organisation or on <b>Payments</b>. Ticking "move the renewal date on" marks the subscription active for another cycle.</p>`,
  },
  {
    slug: 'admin-leads',
    category: 'Platform admin',
    audience: 'admin',
    title: 'Leads from the website',
    summary: 'Follow up every enquiry from the Get started form until it becomes a client.',
    body: `
<p>Every <b>Get started</b> and pricing enquiry on the home page arrives in <b>Leads</b>, with where it came from, the
visitor's location, computer and whether they enquired before.</p>
<ol class="doc-steps">
  <li>Open a lead; call, email or WhatsApp them from its page.</li>
  <li>Log each <b>call</b>, <b>email</b> or <b>meeting</b> on its timeline, and move it along: New → Contacted → Qualified → Proposal sent → Won / Lost.</li>
  <li><b>Convert to client</b> creates their organisation and admin account in one step.</li>
</ol>
<p><b>Lead analysis</b> shows where leads come from, how fast they are answered and how many become clients. Add
<code>?utm_source=…&amp;utm_campaign=…</code> to the links in your ads to see which campaigns work.</p>`,
  },
  {
    slug: 'admin-settings',
    category: 'Platform admin',
    audience: 'admin',
    title: 'Settings in .env',
    summary: 'The super admin account, the site address, location lookups, statistics history and live views.',
    body: `
<table class="doc-table">
  <tr><th>Setting</th><th>What it does</th></tr>
  <tr><td><code>SUPER_ADMIN_EMAIL</code>, <code>SUPER_ADMIN_PASSWORD</code></td><td>On every start, this account exists as an active super admin with exactly this password (10+ characters, letters and numbers).</td></tr>
  <tr><td><code>SUPER_ADMIN_NAME</code>, <code>SUPER_ADMIN_PHONE</code></td><td>Its name and mobile number.</td></tr>
  <tr><td><code>SITE_URL</code></td><td>The public address (e.g. <code>https://ajpilot.com</code>) used in search-engine tags and the sitemap.</td></tr>
  <tr><td><code>GEOIP</code></td><td><code>ipwho.is</code> (default) looks up where a lead's IP address is; <code>off</code> turns it off.</td></tr>
  <tr><td><code>METRICS_ENABLED</code></td><td><code>false</code> stops recording the Statistics history for servers and apps (on by default).</td></tr>
  <tr><td><code>METRICS_EVERY_MINUTES</code>, <code>METRICS_KEEP_DAYS</code></td><td>How often a sample is taken (default 5 minutes) and how long it is kept (default 35 days, at least 7).</td></tr>
  <tr><td><code>METRICS_CONCURRENCY</code></td><td>How many servers are sampled at the same time (default 4).</td></tr>
  <tr><td><code>STATS_MAX_STREAMS</code>, <code>STATS_MAX_STREAMS_PER_ORG</code></td><td>How many server <b>Live</b> tabs may be open at once in total (default 8) and per organisation (default 4).</td></tr>
  <tr><td><code>APP_STATS_STREAMS_PER_ORG</code></td><td>How many app <b>Live stats</b> tabs one organisation may have open at once (default 4).</td></tr>
  <tr><td><code>STATS_STREAM_MINUTES</code></td><td>How long one live view runs before it reconnects (default 15).</td></tr>
</table>
<p>Restart the server after changing <code>.env</code>.</p>`,
  },
];

/** The guides a visitor may see: everything except super-admin guides, unless asked for. */
/*
 * Video walkthroughs. A guide gets a player at the top as soon as its video is
 * in public/docs/videos, named after the guide: <slug>.webm or <slug>.mp4.
 * Optional next to it: <slug>.jpg (the still shown before it plays) and
 * <slug>.json — { "duration": 74, "chapters": [{ "t": 0, "label": "…" }] } —
 * which lists the steps under the player, each one a jump into the video.
 */
const VIDEO_DIR = path.join(ROOT, 'public', 'docs', 'videos');
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function videoFor(slug) {
  const ext = ['webm', 'mp4'].find((e) => fs.existsSync(path.join(VIDEO_DIR, `${slug}.${e}`)));
  if (!ext) return null;
  const stamp = Math.floor(fs.statSync(path.join(VIDEO_DIR, `${slug}.${ext}`)).mtimeMs / 1000);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(VIDEO_DIR, `${slug}.json`), 'utf8')); } catch { /* no chapters */ }
  return {
    src: `/docs/videos/${slug}.${ext}?v=${stamp}`,
    type: `video/${ext}`,
    poster: fs.existsSync(path.join(VIDEO_DIR, `${slug}.jpg`)) ? `/docs/videos/${slug}.jpg?v=${stamp}` : null,
    duration: Number(meta.duration) || null,
    chapters: Array.isArray(meta.chapters) ? meta.chapters.filter((c) => Number.isFinite(c.t) && c.label) : [],
  };
}

function videoHtml(title, v) {
  return `<figure class="doc-video">
  <div class="doc-video-frame"><video controls preload="none" playsinline${v.poster ? ` poster="${v.poster}"` : ''} aria-label="${escHtml(`Video: ${title}`)}">
    <source src="${v.src}" type="${v.type}" />
  </video></div>
  <figcaption><span class="doc-video-badge">▶ Video walkthrough</span>${v.duration ? ` <span>${clock(v.duration)}</span>` : ''}<span class="doc-video-note">no sound — the steps are captioned</span></figcaption>
  ${v.chapters.length ? `<ol class="doc-chapters">${v.chapters.map((c) => `<li><button type="button" data-seek="${c.t}"><time>${clock(c.t)}</time>${escHtml(c.label)}</button></li>`).join('')}</ol>` : ''}
</figure>`;
}

export function docsFor({ admin = false } = {}) {
  // In menu order — by category, then as written — so Previous / Next follow the menu.
  const rank = (d) => DOC_CATEGORIES.indexOf(d.category);
  return DOCS.filter((d) => admin || d.audience !== 'admin')
    .map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map(({ d }) => d)
    .map((d) => {
      const video = videoFor(d.slug);
      return video ? { ...d, video, body: videoHtml(d.title, video) + d.body } : d;
    });
}

export const findDoc = (slug, opts) => docsFor(opts).find((d) => d.slug === slug) || null;
