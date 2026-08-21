import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Bot as BotIcon, Send } from 'lucide-react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  Field,
  Input,
  Measure,
  Page,
  PageHeader,
  Progress,
  Spinner,
  buttonClass,
  cn,
  formatNumber,
} from '../ui';
import { getSeedQuestions, previewChatStream } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { agentPath } from '../shell/nav';
import { crawlFraction, domainOf } from './firstRun';
import { useCrawlWatch } from './useCrawlWatch';

interface Turn {
  id: number;
  role: 'you' | 'bot';
  text: string;
  /** True while the answer is still arriving. */
  streaming?: boolean;
}

const GENERIC_STARTERS = [
  'What do you do?',
  'How much does it cost?',
  'How do I get in touch?',
];

/**
 * The first answer.
 *
 * This is the moment the product is sold, so it is the moment the first run
 * ends on — not a progress bar, and not a dashboard of zeros. The chatbot
 * answers from whatever has been indexed so far, and the header says plainly
 * that more is still arriving, because an answer that is thin because the crawl
 * is nine pages in is a completely different thing from one that is thin because
 * the product does not work, and the customer cannot tell the two apart unless
 * we tell them.
 */
export function FirstChatPage() {
  const { agentId } = useParams();
  const botId = Number(agentId);
  const { bots, refreshBots } = useBotContext();
  const bot = bots.find((candidate) => candidate.id === botId) ?? null;

  const indexed = Number(bot?.indexed_chunk_count ?? 0);
  const { progress, pending } = useCrawlWatch(Number.isFinite(botId) && botId > 0);
  const status = progress?.status ?? 'idle';
  const running = status === 'running' || pending;
  const failed = status === 'failed';

  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starters, setStarters] = useState<string[]>(GENERIC_STARTERS);
  const sessionRef = useRef<string>(`first-run-${Date.now()}`);
  const nextId = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Once the crawl lands, the chatbot has real seed questions and real
  // knowledge — pull both rather than leaving the generic starters up.
  useEffect(() => {
    if (status !== 'completed' || !botId) return;
    let active = true;
    void refreshBots();
    getSeedQuestions(botId)
      .then((questions) => {
        if (active && questions.length > 0) setStarters(questions.slice(0, 3));
      })
      .catch(() => {
        // Keeping the generic starters is a fine outcome; there is nothing to say.
      });
    return () => {
      active = false;
    };
  }, [status, botId, refreshBots]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns]);

  const ask = useCallback(
    async (question: string): Promise<void> => {
      const text = question.trim();
      if (!text || sending || !botId) return;
      setError(null);
      setSending(true);
      setDraft('');

      const answerId = (nextId.current += 2);
      setTurns((current) => [
        ...current,
        { id: answerId - 1, role: 'you', text },
        { id: answerId, role: 'bot', text: '', streaming: true },
      ]);

      try {
        await previewChatStream(botId, text, sessionRef.current, {
          onChunk: (chunk) => {
            setTurns((current) =>
              current.map((turn) =>
                turn.id === answerId ? { ...turn, text: turn.text + chunk } : turn,
              ),
            );
          },
          onFinal: () => {
            setTurns((current) =>
              current.map((turn) => (turn.id === answerId ? { ...turn, streaming: false } : turn)),
            );
          },
          onError: (err: unknown) => {
            setTurns((current) => current.filter((turn) => turn.id !== answerId));
            setError(
              err instanceof Error
                ? err.message
                : 'That answer did not come back. Try asking again.',
            );
          },
        });
      } catch (err) {
        setTurns((current) => current.filter((turn) => turn.id !== answerId));
        setError(err instanceof Error ? err.message : 'That answer did not come back.');
      } finally {
        setSending(false);
      }
    },
    [botId, sending],
  );

  const site = bot?.website ? domainOf(bot.website) : '';
  const crawled = progress?.pages_crawled ?? 0;
  const fraction = crawlFraction(crawled, progress?.max_pages ?? progress?.urls?.length);

  return (
    <Page className="flex h-full min-h-0 flex-col">
      {/* `Page` and `PageHeader`, not a hand-built copy of both. The gutter was
          `px-4 md:px-8` against the system's `px-6 md:px-8`, so this screen sat
          16px from the edge of a phone where every other page sits 24 — and the
          eyebrow/title/description trio duplicated `PageHeader`'s, including the
          `mt-1` / `mt-1.5` offsets, which is how they drift. */}
      <Measure width="form" className="flex h-full min-h-0 flex-col gap-4">
        <PageHeader
          className="mb-0"
          eyebrow="First run"
          title={bot?.name ? `Say hello to ${bot.name}` : 'Say hello to your chatbot'}
          description="Exactly what a visitor will get."
        />

        {running ? (
          <Card>
            <CardBody className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-base font-medium text-text-primary">
                  Still reading {site || 'your site'}
                </p>
                <p className="figure text-xs text-text-tertiary">
                  {crawled > 0 ? `${formatNumber(crawled)} pages so far` : 'Getting started'}
                </p>
              </div>
              {/* Indeterminate until the total is actually known: a bar that
                  jumps 0 → 100 because the denominator arrived late is worse
                  than one that simply says it is working.

                  `hideLabel`, because the line above already reads "Still
                  reading <site>" with the page count beside it — the bar is the
                  picture of a fact the heading has stated. */}
              <Progress value={fraction} label="Reading your website" hideLabel />
              <p className="text-xs text-text-secondary">
                Answers improve as it reads. No need to wait.
              </p>
            </CardBody>
          </Card>
        ) : null}

        {failed ? (
          <Alert
            tone="warning"
            title="We could not read your site"
            action={
              <Link
                to={bot ? `${agentPath(bot.id, 'knowledge')}?add=upload` : '/chatbots'}
                className={buttonClass('secondary', 'sm')}
              >
                Add content another way
              </Link>
            }
          >
            {progress?.error ??
              'Some sites block readers or need JavaScript mode. Try that, a sitemap, or upload documents.'}
          </Alert>
        ) : null}

        {!running && !failed && indexed === 0 ? (
          <Alert tone="neutral" title="Your chatbot has nothing to read yet">
            Add a site, documents, or pasted text.
          </Alert>
        ) : null}

        <Card className="flex min-h-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-5">
            {turns.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-surface-sunken">
                  <BotIcon aria-hidden className="h-icon-lg w-icon-lg text-text-tertiary" />
                </span>
                <p className="max-w-sm text-xs text-text-secondary">Try one of these</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {starters.map((question) => (
                    <Button key={question} size="sm" variant="secondary" onClick={() => void ask(question)}>
                      {question}
                    </Button>
                  ))}
                </div>
              </div>
            ) : (
              <ol className="flex flex-col gap-3">
                {turns.map((turn) => (
                  <li
                    key={turn.id}
                    className={cn('flex items-end gap-2', turn.role === 'you' && 'flex-row-reverse')}
                  >
                    {turn.role === 'bot' ? (
                      <Avatar size="xs" name={bot?.name ?? 'Chatbot'} shape="rounded" className="shrink-0" />
                    ) : null}
                    <div className={cn('flex min-w-0 max-w-[80%] flex-col', turn.role === 'you' && 'items-end')}>
                      {/* One radius and one ground per speaker, matching the lead
                          drawer's transcript: the two used different radii, tails
                          and grounds for the same two roles, in one product. */}
                      <div
                        className={cn(
                          'rounded-md px-3 py-2 text-prose text-text-primary',
                          turn.role === 'you'
                            ? 'bg-surface-sunken'
                            : 'border border-border bg-surface',
                        )}
                      >
                        {turn.text ? (
                          <p className="whitespace-pre-wrap break-words">{turn.text}</p>
                        ) : (
                          <span className="flex items-center gap-1" aria-label="Thinking">
                            {[0, 1, 2].map((dot) => (
                              <span
                                key={dot}
                                aria-hidden
                                className="typing-dot h-1.5 w-1.5 rounded-full bg-text-tertiary"
                              />
                            ))}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 px-0.5 text-xs text-text-tertiary">
                        {turn.role === 'you' ? 'You' : (bot?.name ?? 'Your chatbot')}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {error ? (
            <Alert tone="danger" live className="mx-5 mb-3">
              {error}
            </Alert>
          ) : null}

          <form
            className="flex shrink-0 items-end gap-2 border-t border-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void ask(draft);
            }}
          >
            {/* The system's `Input`, not a hand-rolled one: the copy carried its
                own `focus:outline` inset by a pixel and firing on `:focus` rather
                than `:focus-visible`, which is a second focus ring in a system
                that has exactly one. */}
            <Field label="Ask your chatbot a question" hideLabel className="min-w-0 flex-1">
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Ask your chatbot something…"
                autoComplete="off"
              />
            </Field>
            <Button type="submit" size="icon-md" aria-label="Ask" disabled={sending || !draft.trim()}>
              {sending ? <Spinner className="h-4 w-4" /> : <Send aria-hidden className="h-4 w-4" />}
            </Button>
          </form>
        </Card>

        <footer className="flex flex-wrap items-center justify-between gap-3 pb-2">
          <div className="flex items-center gap-2">
            {indexed > 0 ? (
              <Badge tone="success" dot>
                <span className="figure">{formatNumber(indexed)}</span> passages learned
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/setup" className={buttonClass('ghost', 'md')}>
              See what’s left
            </Link>
            <Link
              to={bot ? agentPath(bot.id, 'deploy') : '/chatbots'}
              className={buttonClass('primary', 'md')}
            >
              Put it on my website
              <ArrowRight aria-hidden className="h-4 w-4" />
            </Link>
          </div>
        </footer>
      </Measure>
    </Page>
  );
}
