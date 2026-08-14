// CHAT STREAM — low-concurrency detail run focused on per-stream timing quality
// (Phase 13 chat/AI test): one visitor journey (bootstrap -> message -> stream ->
// follow-up), a few VUs, so you can eyeball TTFB and full-stream distribution
// without pool contention. Use chat-concurrency.js to find the saturation knee.
import http from 'k6/http';
import { sleep, group } from 'k6';
import { env } from '../config/environments.js';
import { chatThresholds } from '../config/thresholds.js';
import { ok } from '../helpers/checks.js';
import { botHeaders, url } from '../helpers/http.js';
import { requireBotKey } from '../helpers/auth.js';
import { chatTTFB, chatTotal } from '../helpers/metrics.js';
import { sessionId, pickQuestion } from '../helpers/data.js';

export const options = {
  vus: parseInt(__ENV.VUS || '3', 10),
  duration: __ENV.DURATION || '1m',
  thresholds: chatThresholds,
};

export function setup() {
  requireBotKey();
  env.assertSafe({ llm: true });
}

function turn(sid) {
  const body = JSON.stringify({ question: pickQuestion(), session_id: sid });
  const res = http.post(url('/chat/stream'), body, botHeaders({ tags: { kind: 'chat' }, timeout: '120s' }));
  ok(res, 'chat/stream');
  chatTTFB.add(res.timings.waiting);
  chatTotal.add(res.timings.duration);
}

export default function () {
  const sid = sessionId('stream');
  group('bootstrap', () => ok(http.get(url('/bots/settings/public'), botHeaders({ tags: { kind: 'api' } })), 'widget-config'));
  group('turn-1', () => turn(sid));
  sleep(Math.random() * 5 + 3); // read the answer
  group('turn-2', () => turn(sid)); // follow-up in the same session
  sleep(Math.random() * 5 + 3);
}
