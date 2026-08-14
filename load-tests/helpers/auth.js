// Auth helpers. OyeChats uses static, opaque keys (no login/refresh flow) passed
// as headers — there is nothing to rotate at runtime, so "auth" here is just
// asserting the right key is present for the scenario's persona. Keys are read
// from env in config/environments.js and never logged.
import { env } from '../config/environments.js';

export function requireBotKey() {
  if (!env.BOT_KEY) throw new Error('BOT_KEY is required for this scenario (seed a test bot; see datasets/README.md).');
}

export function requireApiKey() {
  if (!env.API_KEY) throw new Error('API_KEY is required for this scenario (seed a test admin; see datasets/README.md).');
}

export function requireOperatorKey() {
  if (!env.OPERATOR_KEY) throw new Error('OPERATOR_KEY is required for this scenario (seed a test operator).');
}
