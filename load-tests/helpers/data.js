// Deterministic test-data helpers. Session ids are unique per VU-iteration so
// concurrent chats don't collide, but the QUESTION set is fixed so runs are
// repeatable (same retrieval work each time under the mock).
export const QUESTIONS = [
  'What are your pricing plans?',
  'Do you offer a free trial?',
  'How does the integration work?',
  'Can I export my data?',
  'What support options are available?',
  'Is there an API?',
  'How do I embed the widget?',
  'What languages are supported?',
];

export function sessionId(prefix = 'lt') {
  // __VU and __ITER are k6 globals; Date.now() disambiguates across runs.
  return `session_${prefix}_${__VU}_${__ITER}_${Date.now()}`;
}

export function pickQuestion() {
  return QUESTIONS[(__ITER + __VU) % QUESTIONS.length];
}
