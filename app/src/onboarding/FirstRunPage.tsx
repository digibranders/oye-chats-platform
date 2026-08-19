import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { FileText, Globe, Type } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  Field,
  Input,
  Page,
  PageHeader,
  Spinner,
  buttonClass,
  cn,
  normalizeUrl,
} from '../ui';
import { createBot, crawlWebsite } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { agentPath } from '../shell/nav';
import {
  hasErrors,
  suggestName,
  validateFirstRun,
  type FirstRunErrors,
  type FirstRunSource,
} from './firstRun';

interface SourceOption {
  value: FirstRunSource;
  label: string;
  blurb: string;
  icon: typeof Globe;
}

const SOURCES: SourceOption[] = [
  {
    value: 'website',
    label: 'My website',
    blurb: 'We read your pages and your chatbot answers from them.',
    icon: Globe,
  },
  {
    value: 'documents',
    label: 'Documents',
    blurb: 'PDFs, Word files or plain text — a handbook, a price list, an FAQ.',
    icon: FileText,
  },
  {
    value: 'text',
    label: 'Text I paste in',
    blurb: 'No site and no files yet? Paste what you would tell a customer.',
    icon: Type,
  },
];

/**
 * The first run.
 *
 * One screen, two fields, and the crawl starts in the background while the user
 * goes straight to talking to their chatbot. The flow this replaces was seven
 * full-screen steps outside the shell, each one a degraded copy of a page that
 * already existed, ending on a step that hard-blocked on a third-party ping with
 * no way past — so a customer who could not satisfy it never finished onboarding
 * and carried a permanent "Resume setup" button for the life of the account.
 *
 * Three things are deliberate here. There is no progress screen: the best moment
 * in this product is the first answer, and waiting on a bar is not it. There is
 * no website requirement, because a business with no site, or a site behind a
 * login, is a real customer. And there is no step counter, because there is only
 * one step.
 */
export function FirstRunPage() {
  const navigate = useNavigate();
  const { bots, loading, refreshBots } = useBotContext();
  const { currentWorkspaceName } = useWorkspace();

  const [source, setSource] = useState<FirstRunSource>('website');
  const [website, setWebsite] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [errors, setErrors] = useState<FirstRunErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const fallbackName = currentWorkspaceName?.trim() || 'My chatbot';

  // The name follows the website until the user types their own. Watching the
  // field fill itself as they paste a domain is also the clearest possible
  // signal that the two are related.
  const suggested = useMemo(() => suggestName(website, fallbackName), [website, fallbackName]);
  useEffect(() => {
    if (nameTouched) return;
    setName(suggested);
  }, [suggested, nameTouched]);

  // A workspace that already has a chatbot is past this screen by definition.
  if (!loading && bots.length > 0) {
    return <Navigate to="/" replace />;
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const draft = { name, source, website };
    const found = validateFirstRun(draft);
    setErrors(found);
    if (hasErrors(found) || submitting) return;

    setSubmitting(true);
    setFailure(null);
    try {
      const bot = await createBot({
        name: name.trim(),
        ...(source === 'website' ? { website: normalizeUrl(website) } : {}),
      });
      await refreshBots();

      if (source === 'website') {
        // Deliberately not awaited. The crawl takes minutes; the customer takes
        // seconds. `getCrawlProgress` on the next screen is how they follow it.
        void crawlWebsite(normalizeUrl(website), bot.id).catch(() => {
          // A failure here surfaces through the progress poll, which can
          // explain it and offer the ways out. Swallowing it silently would be
          // wrong; re-throwing into an unhandled rejection helps nobody.
        });
        navigate(`/welcome/${bot.id}`, { replace: true });
        return;
      }

      navigate(`${agentPath(bot.id, 'knowledge')}?add=${source === 'documents' ? 'upload' : 'text'}`, {
        replace: true,
      });
    } catch (err) {
      setFailure(
        err instanceof Error
          ? err.message
          : 'We could not create your chatbot. Please try again in a moment.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  return (
    <Page width="default">
      <PageHeader
        eyebrow="First run"
        title="Let’s give your chatbot something to know"
        description="Two answers and it is live. You can change all of it afterwards, and nothing here is a step you can get stuck on."
      />

      {failure ? (
        <Alert
          tone="danger"
          live
          className="mb-5"
          title="We could not create your chatbot"
          action={
            <Link to="/billing" className={buttonClass('secondary', 'sm')}>
              Check your plan
            </Link>
          }
        >
          {failure}
        </Alert>
      ) : null}

      <form onSubmit={submit} noValidate>
        <Card>
          <CardBody className="space-y-6">
            <fieldset>
              <legend className="text-base font-medium text-text-primary">
                Where should it learn from?
              </legend>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {SOURCES.map((option) => {
                  const Icon = option.icon;
                  const selected = source === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setSource(option.value)}
                      className={cn(
                        'flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left',
                        'transition-colors duration-[var(--dur-fast)]',
                        selected
                          ? 'border-accent-500 bg-accent-50'
                          : 'border-border bg-surface hover:bg-surface-hover',
                      )}
                    >
                      <Icon aria-hidden className="h-4 w-4 text-text-tertiary" />
                      <span className="text-base font-medium text-text-primary">{option.label}</span>
                      <span className="text-2xs leading-relaxed text-text-secondary">{option.blurb}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {source === 'website' ? (
              <Field
                label="Your website"
                hint="We read the pages a visitor can see. Pages behind a login are not included."
                error={errors.website}
              >
                <Input
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                  placeholder="example.com"
                  inputMode="url"
                  autoComplete="url"
                  autoFocus
                />
              </Field>
            ) : null}

            <Field
              label="What is it called?"
              hint="Visitors see this at the top of the chat."
              error={errors.name}
            >
              <Input
                value={name}
                onChange={(event) => {
                  setNameTouched(true);
                  setName(event.target.value);
                }}
                placeholder="Support"
                maxLength={80}
              />
            </Field>
          </CardBody>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-sunken px-5 py-3">
            <p className="text-2xs text-text-tertiary">
              {source === 'website'
                ? 'Reading your site takes a few minutes. You can talk to your chatbot while it works.'
                : 'You will add your content on the next screen.'}
            </p>
            <Button type="submit" loading={submitting} disabled={submitting}>
              {source === 'website' ? 'Start reading my site' : 'Create my chatbot'}
            </Button>
          </div>
        </Card>
      </form>
    </Page>
  );
}
