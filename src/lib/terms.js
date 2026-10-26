/**
 * The Terms & Conditions page (/terms).
 *
 * TERMS_VERSION is stored on each account when it agrees at sign-up, so it is
 * always known which wording someone accepted. Change it whenever the wording
 * changes in substance.
 *
 * This is a starting point written around how the product actually works —
 * have it reviewed by a lawyer before relying on it.
 */

import { page } from './docsPage.js';
import { siteUrl } from './landing.js';
import { FREE_TRIAL_DAYS } from './plans.js';

export const TERMS_VERSION = '2026-10-26';
const UPDATED = '26 October 2026';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jurisdiction = () => String(process.env.LEGAL_JURISDICTION || 'India').trim();

const SECTIONS = [
  ['acceptance', 'Accepting these terms', `
    <p>These Terms &amp; Conditions ("terms") are an agreement between you and AJ Pilot ("AJ Pilot", "we", "us") for your use of
    the AJ Pilot control panel, website and related services (the "Service"). By creating an account, ticking "I agree" at sign-up,
    or using the Service, you accept these terms. If you use the Service for a company or organisation, you confirm you are
    authorised to accept them on its behalf.</p>
    <p>If you do not agree, do not create an account or use the Service.</p>`],

  ['service', 'What AJ Pilot is — and is not', `
    <p>AJ Pilot is a control panel that connects to <b>servers you own or are authorised to manage</b> over SSH, and runs commands
    on them when you ask it to: deploying apps, installing software, configuring nginx and SSL, managing databases, users, files,
    cron jobs and more.</p>
    <ul>
      <li>We do <b>not</b> host, rent or operate your servers. Your servers, their data and everything running on them remain yours and your responsibility.</li>
      <li>We do <b>not</b> keep backups of your servers, applications or databases.</li>
      <li>Features may change, be improved or be removed over time.</li>
    </ul>`],

  ['account', 'Your account', `
    <ul>
      <li>You must be at least 18 years old and give accurate details — your name, email address and mobile number.</li>
      <li>Your email address must be verified, and signing in needs a one-time code sent to your mobile number.</li>
      <li>Keep your password and one-time codes secret. Do not share an account between people — add team members with their own accounts instead.</li>
      <li>You are responsible for everything done through your account and by the people you invite to your organisation.</li>
      <li>Tell us straight away through the <a href="/#contact">contact form</a> if you think your account has been used without your permission.</li>
    </ul>`],

  ['servers', 'Your servers and what you connect', `
    <p>When you add a server, you give the Service access to it — often with root or sudo rights. You confirm that:</p>
    <ul>
      <li>you own the server, or have the owner's permission to manage it this way;</li>
      <li>you understand that actions you start in the panel (deleting files, removing containers or databases, changing nginx,
        firewall or user settings, rebooting, deploying code) are carried out on the real server and may not be reversible;</li>
      <li>you are responsible for keeping your servers secure and updated: operating system patches, firewall rules, SSH
        configuration, strong passwords and keys, and the security of the software and applications you run on them;</li>
      <li>you keep your own <b>regular, tested backups</b> of every server, application and database;</li>
      <li>you comply with the terms of your hosting provider and of any third-party service you connect (for example GitHub,
        GitLab, Bitbucket, Docker Hub, Cloudflare).</li>
    </ul>`],

  ['rules', 'Server and acceptable-use rules', `
    <p>You must not use the Service, or any server managed through it, to:</p>
    <ul>
      <li>host, store or distribute anything illegal, including pirated software, films, music or IPTV streams, and material that infringes copyright or trademarks;</li>
      <li>create or spread malware, ransomware, phishing pages, spam or scams;</li>
      <li>attack, scan, probe or flood other systems or networks — including denial-of-service attacks, brute-force login attempts and unauthorised vulnerability scanning;</li>
      <li>gain or attempt to gain unauthorised access to any server, account or data, including other customers of AJ Pilot;</li>
      <li>mine cryptocurrency on servers you do not own or are not allowed to use for that purpose;</li>
      <li>harass, threaten or abuse anyone, or collect personal data unlawfully;</li>
      <li>interfere with the Service itself: probing or attacking the panel, reverse-engineering it, bypassing plan limits,
        payment or security checks, or placing unreasonable load on it;</li>
      <li>resell, rent or sublicense the Service without our written permission.</li>
    </ul>
    <p>If we reasonably believe these rules are being broken, we may suspend or close the account without notice and, where
    required, report the activity to the relevant authorities.</p>`],

  ['security', 'Security: what we do and what you must do', `
    <p>We take security seriously and build the Service with care. Among other things:</p>
    <ul>
      <li>server passwords, SSH keys, tokens and other secrets are encrypted (AES-256) before they are stored;</li>
      <li>account passwords are stored only as salted hashes, and sign-in needs a one-time code;</li>
      <li>SSH host keys are checked, so a server that changes unexpectedly is flagged;</li>
      <li>every change to nginx is tested before it is applied.</li>
    </ul>
    <p>No system connected to the internet can be made completely secure. You are responsible for: choosing strong, unique
    passwords; protecting your email, mobile number and devices; giving team members only the access they need; removing
    access promptly when someone leaves; and rotating credentials if you suspect they have been exposed.</p>`],

  ['breach', 'Hacking, unauthorised access and data breaches', `
    <div class="terms-key">To the maximum extent permitted by law, AJ Pilot is <b>not responsible</b> for loss, damage, theft,
    exposure or misuse of data, or for any compromise of your servers, applications or accounts, caused by hacking,
    unauthorised access or any other attack — whether it happens on your servers, in your applications, through third-party
    software or services, or through the Service.</div>
    <p>This applies in particular where the cause is outside our reasonable control, for example:</p>
    <ul>
      <li>weak, reused, shared or leaked passwords, SSH keys, tokens or one-time codes;</li>
      <li>vulnerabilities or misconfiguration in your servers, operating systems, applications, databases or plugins;</li>
      <li>actions of people you gave access to, or of anyone using your devices, email or mobile number;</li>
      <li>security failures at your hosting provider or at third-party services you connect;</li>
      <li>malware on your own computer or network.</li>
    </ul>
    <p>If we become aware of a security incident affecting data held by the Service itself, we will take reasonable steps to
    contain it and will notify affected users where the law requires us to.</p>`],

  ['technical', 'Technical problems, outages and data loss', `
    <p>The Service is provided <b>"as is" and "as available"</b>. We work to keep it reliable, but we do not promise that it
    will be uninterrupted, error-free or always available, or that it will work with every server, distribution or piece of
    software.</p>
    <div class="terms-key">To the maximum extent permitted by law, AJ Pilot is <b>not responsible</b> for any loss of data,
    downtime, failed or partial deployments, broken configurations, lost revenue or other harm caused by technical glitches,
    bugs, errors, outages, network or connection problems, interrupted commands, or changes made on your servers through
    the Service — whether started by you, your team, an automated deploy, or a scheduled task.</div>
    <p>This includes problems caused by third-party services the Service depends on (for example GitHub, GitLab, Bitbucket,
    Docker Hub, Cloudflare, Let's Encrypt, Razorpay, email and SMS providers) and by maintenance or updates to the Service.</p>
    <p><b>Keep your own backups.</b> They are the only reliable protection against data loss, and restoring data is your responsibility.</p>`],

  ['third-party', 'Third-party services', `
    <p>Parts of the Service connect to services run by others. Your use of them is governed by their own terms and privacy
    policies, and we are not responsible for their availability, security or actions. Payments are processed by Razorpay;
    we never see or store your full card details.</p>`],

  ['payments', 'Plans, payments and refunds', `
    <ul>
      <li>Prices are shown on the pricing page in the currency stated there. Taxes may apply as required by law.</li>
      <li>The free plan runs for ${FREE_TRIAL_DAYS} days and can be used once per organisation.</li>
      <li>A paid plan starts as soon as its payment is confirmed. Each payment covers the period shown (one month or one year)
        and does not renew automatically — you pay again to continue.</li>
      <li>Changing to another plan starts a new period on the new plan at its full price; unused time on the previous plan is not credited.</li>
      <li>When a plan ends or expires, your organisation becomes view-only until it is renewed. We do not delete your data
        because a plan expired, but see "Suspension and closing" below.</li>
      <li>Payments are non-refundable, except where the law requires a refund or we agree to one in writing. If you were
        charged but the plan did not start, <a href="/#contact">contact us</a> and we will fix it or refund the payment.</li>
      <li>We may change prices for future periods; a change never affects a period you have already paid for.</li>
    </ul>`],

  ['termination', 'Suspension and closing', `
    <ul>
      <li>You can stop using the Service at any time. Removing a server from the panel does not change anything on the server itself.</li>
      <li>We may suspend or close an account that breaks these terms, is used for abuse, has payment problems, or puts the
        Service or other customers at risk.</li>
      <li>After an account is closed, data held by the Service (such as stored server details and settings) may be deleted.
        Your servers and the data on them are not affected.</li>
    </ul>`],

  ['liability', 'Limitation of liability', `
    <p>To the maximum extent permitted by law:</p>
    <ul>
      <li>AJ Pilot is not liable for any indirect, incidental, special or consequential loss, including loss of profits,
        revenue, business, goodwill or data;</li>
      <li>AJ Pilot's total liability for any claim relating to the Service is limited to the amount you paid us in the three
        months before the event that caused the claim.</li>
    </ul>
    <p>Nothing in these terms limits liability that cannot be limited under applicable law.</p>`],

  ['indemnity', 'Your responsibility to us', `
    <p>You agree to compensate AJ Pilot for claims, losses and costs (including reasonable legal fees) arising from your
    breach of these terms, your use of the Service in breach of the law, or content and software you run on servers
    managed through the Service.</p>`],

  ['changes', 'Changes to these terms', `
    <p>We may update these terms from time to time. The date at the top shows the latest version. For significant changes we
    will give notice in the panel or by email before they apply. Continuing to use the Service after changes apply means you
    accept them.</p>`],

  ['law', 'Governing law', `
    <p>These terms are governed by the laws of ${esc(jurisdiction())}. Any dispute will be handled by the competent courts of ${esc(jurisdiction())},
    unless the law where you live gives you the right to bring it elsewhere.</p>`],

  ['contact', 'Contact', `
    <p>Questions about these terms? Use the <a href="/#contact">contact form</a> and we will get back to you.</p>`],
];

export function renderTerms(req) {
  const url = siteUrl(req);
  const body = `
    <nav class="docs-crumbs"><a href="/">Home</a> › Terms &amp; Conditions</nav>
    <h1>Terms &amp; Conditions</h1>
    <p class="docs-lead">Last updated ${UPDATED}. Please read these terms carefully — they explain the rules for using AJ Pilot
      and the limits of our responsibility for your servers and data.</p>

    <div class="terms-summary">
      <b>In short</b>
      <ul>
        <li>Your servers and their data are yours — and so is keeping them secure and backed up.</li>
        <li>Only manage servers you are allowed to, and never use them for anything illegal or abusive.</li>
        <li>We protect the panel carefully, but we are not responsible for hacking, data breaches, technical glitches or data loss.</li>
        <li>Paid plans start when payment is confirmed and are non-refundable except where the law says otherwise.</li>
      </ul>
      <small>This summary is for convenience; the full terms below are what apply.</small>
    </div>

    <nav class="terms-toc" aria-label="Contents">
      <b>Contents</b>
      <ol>${SECTIONS.map(([id, title]) => `<li><a href="#${id}">${esc(title)}</a></li>`).join('')}</ol>
    </nav>

    <article class="doc terms">
      ${SECTIONS.map(([id, title, html], i) => `<section id="${id}"><h2>${i + 1}. ${esc(title)}</h2>${html}</section>`).join('')}
    </article>`;

  return page({
    req, path: '/terms', body, side: false, active: 'terms', ogType: 'website',
    title: 'Terms & Conditions — AJ Pilot',
    description: 'The rules for using AJ Pilot: your account, the servers you connect, acceptable use, security, payments, and the limits of our responsibility for data loss, hacking and technical problems.',
    ld: {
      '@context': 'https://schema.org', '@type': 'WebPage', name: 'Terms & Conditions', url: `${url}/terms`,
      dateModified: TERMS_VERSION, publisher: { '@type': 'Organization', name: 'AJ Pilot', url: `${url}/` },
    },
  });
}
