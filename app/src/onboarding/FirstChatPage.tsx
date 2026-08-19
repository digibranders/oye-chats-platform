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
    <div className="mx-auto flex h-full min-h-0 w-full max-w-reading flex-col gap-4 px-4 py-6 md:px-8">
      <header>
        <p className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">First run</p>
        <h1 className="mt-1 text-xl font-semibold text-text-primary">
          {bot?.name ? `Say hello to ${bot.name}` : 'Say hello to your chatbot'}
        </h1>
        <p className="mt-1.5 text-base leading-relaxed text-text-secondary">
          Ask it something a customer would ask. This is exactly what a visitor to your site will get.
        </p>
      </header>

      {running ? (
        <Card>
          <CardBody className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-base font-medium text-text-primary">
                Still reading {site || 'your site'}
              </p>
              <p className="figure text-2xs text-text-tertiary">
                {crawled > 0 ? `${formatNumber(crawled)} pages so far` : 'Getting started'}
              </p>
            </div>
            {/* Indeterminate until the total is actually known: a bar that
                jumps 0 → 100 because the denominator arrived late is worse
                than one that simply says it is working. */}
            <Progress value={fraction} label="Reading your website" />
            <p className="text-2xs leading-relaxed text-text-secondary">
              Answers will get better as this finishes — it does not need you to wait here.
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
            'Some sites block automated readers, or render their pages with JavaScript. You can turn on JavaScript mode, point us at a sitemap, upload documents, or paste the text in — all on the Knowledge page.'}
        </Alert>
      ) : null}

      {!running && !failed && indexed === 0 ? (
        <Alert tone="neutral" title="Your chatbot has nothing to read yet">
          Add a website, some documents, or paste in what you would tell a customer, and it will start
          answering from that.
        </Alert>
      ) : null}

      <Card className="flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-5">
          {turns.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-surface-sunken">
                <BotIcon aria-hidden className="h-4.5 w-4.5 text-text-tertiary" />
              </span>
              <p className="max-w-sm text-xs leading-relaxed text-text-secondary">
                Try one of these, or ask anything else.
              </p>
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
                    <Avatar size="xs" name={bot?.name ?? 'Chatbot'} shape="rounded" className="mb-4 shrink-0" />
                  ) : null}
                  <div className={cn('flex min-w-0 max-w-[80%] flex-col', turn.role === 'you' && 'items-end')}>
                    <div
                      className={cn(
                        'rounded-lg px-3 py-2 text-prose',
                        turn.role === 'you'
                          ? 'rounded-br-xs bg-ink text-rail-text'
                          : 'rounded-bl-xs bg-surface-sunken text-text-primary',
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
                    <p className="mt-1 px-0.5 text-2xs text-text-tertiary">
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
          <label className="sr-only" htmlFor="first-chat-input">
            Ask your chatbot a question
          </label>
          <input
            id="first-chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask your chatbot something…"
            autoComplete="off"
            className={cn(
              'h-control-md min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3',
              'text-base text-text-primary placeholder:text-text-tertiary',
              'focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-accent-500',
            )}
          />
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
    </div>
  );
}
