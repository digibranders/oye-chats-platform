// HTTP header builders. Secrets come from env only (config/environments.js) and
// are never logged. k6 does not print request headers by default; we also never
// echo the key values anywhere.
import { env } from '../config/environments.js';

export function botHeaders(extra = {}) {
  return { headers: { 'Content-Type': 'application/json', 'X-Bot-Key': env.BOT_KEY }, ...extra };
}

export function adminHeaders(extra = {}) {
  return { headers: { 'Content-Type': 'application/json', 'X-API-Key': env.API_KEY }, ...extra };
}

export function operatorHeaders(extra = {}) {
  return { headers: { 'Content-Type': 'application/json', 'X-Operator-Key': env.OPERATOR_KEY }, ...extra };
}

export function url(path) {
  return `${env.BASE_URL}${path}`;
}
