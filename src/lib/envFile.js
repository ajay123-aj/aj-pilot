import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const ENV_PATH = process.env.ENV_FILE || path.join(ROOT, '.env');

/**
 * Set keys in the .env file, keeping comments, ordering and unrelated lines.
 * An existing key is rewritten in place; a new one is appended.
 */
export function setEnvValues(values) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  }

  for (const [key, raw] of Object.entries(values)) {
    const value = String(raw ?? '');
    // A line break in a value would write a second, attacker-chosen setting.
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`"${key}" is not a valid setting name`);
    if (/[\r\n\0]/.test(value)) throw new Error(`The value for ${key} cannot contain line breaks`);
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    const index = lines.findIndex((l) => pattern.test(l));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
    process.env[key] = value;
  }

  const body = lines.join('\n').replace(/\n{3,}$/, '\n');
  fs.writeFileSync(ENV_PATH, body.endsWith('\n') ? body : `${body}\n`, { mode: 0o600 });
  return ENV_PATH;
}

export const envFilePath = () => ENV_PATH;
