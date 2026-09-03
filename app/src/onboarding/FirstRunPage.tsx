import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardFooter,
  Field,
  Input,
  Measure,
  Page,
  PageHeader,
  RadioCards,
  Spinner,
  buttonClass,
  normalizeUrl,
} from '../ui';
import { createBot } from '../services/api';
import { useBotContext } from '../context/BotContext';
import { useWorkspace } from '../context/WorkspaceContext';
import { agentPath } from '../shell/nav';
import {
  hasErrors,
  skipFirstRun,
  suggestName,
  validateFirstRun,
  type FirstRunErrors,
  type FirstRunSource,
} from './firstRun';
import { useTranslation } from '../i18n/useTranslation';
import { t as translateNow } from '../i18n/i18n';

/**
 * The three ways in.
 *
 * No icons. A globe beside the words "My website" labels nothing, and
 * DESIGN.md §6.4 says an icon names a distinct concept or it does not ship.
 */
// @i18n-exempt: fallbacks, read through sourceLabel/sourceDescription below.
// `value` is what gets stored and is never translated.
const SOURCES: readonly { value: FirstRunSource; label: string; description: string }[] = [
  { value: 'website', label: 'My website', description: 'Reads your public pages' },
  { value: 'documents', label: 'Documents', description: 'PDF, Word or plain text' },
  { value: 'text', label: 'Text I paste in', description: 'Paste what you would tell a customer' },
];

const sourceLabel = (s: (typeof SOURCES)[number]) =>
  translateNow(`app.firstRunSource.${s.value}`) || s.label;
const sourceDescription = (s: (typeof SOURCES)[number]) =>
  translateNow(`app.firstRunSourceHelp.${s.value}`) || s.description;

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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { bots, loading, refreshBots } = useBotContext();
  const { currentWorkspaceName } = useWorkspace();

  const [source, setSource] = useState<FirstRunSource>('website');
  const [website, setWebsite] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [errors, setErrors] = useState<FirstRunErrors>({});
  const [submitting, setSubmitting] = useState(false);
  // Latched, not derived from `submitting`: the guard must stay down through the
  // render that clears `submitting`, which happens after the navigate.
  const [handedOff, setHandedOff] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const fallbackName = currentWorkspaceName?.trim() || t('onboarding.myChatbot') || 'My chatbot';

  // The name follows the website until the user types their own. Watching the
  // field fill itself as they paste a domain is also the clearest possible
  // signal that the two are related.
  const suggested = useMemo(() => suggestName(website, fallbackName), [website, fallbackName]);
  useEffect(() => {
    if (nameTouched) return;
    setName(suggested);
  }, [suggested, nameTouched]);

  // A workspace that already has a chatbot is past this screen by definition —
  // UNLESS this screen is the one that just created it.
  //
  // `submit` awaits `refreshBots()` so the destination has the new chatbot, and
  // the `finally` clears `submitting` after navigating. Both re-render with a
  // chatbot now present, and a render-level redirect beats an imperative one,
  // so this guard fired on the way out and sent every website signup to Home.
  // The customer saw the form vanish and the dashboard appear, which is
  // indistinguishable from nothing having happened.
  if (!loading && bots.length > 0 && !handedOff) {
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
      // Before the refresh, because the refresh is what trips the guard above.
      setHandedOff(true);
      await refreshBots();

      if (source === 'website') {
        // The crawl is NOT started here. It used to fire on submit, so a
        // customer who typed an address was committed to a full read of it
        // before ever being shown how big it was — no page count, no chance to
        // narrow it, and on a large site a long wait they did not choose.
        //
        // The chatbot's Knowledge page already asks the question properly: it
        // pre-fills this address, reports how many pages were found, states the
        // plan's crawl ceiling, and only then offers to train. Handing over
        // with the address saved and nothing spent is the same two clicks for a
        // small site and the difference between a decision and a surprise for a
        // large one.
        // The chatbot's own Knowledge page, which is where the crawl it just
        // started actually reports itself: pages found, pages indexed, and the
        // failures worth acting on. The first run used to end on a standalone
        // first-chat screen instead, which answered from a corpus that was
        // usually seconds old and left the customer with nowhere obvious to go
        // next. Landing on the real surface keeps them inside the console, with
        // the setup journey above the page telling them what follows.
        navigate(agentPath(bot.id, 'knowledge'), { replace: true });
        return;
      }

      navigate(`${agentPath(bot.id, 'knowledge')}?add=${source === 'documents' ? 'upload' : 'text'}`, {
        replace: true,
      });
    } catch (err) {
      setFailure(
        err instanceof Error
          ? err.message
          : t('onboarding.weCouldNotCreateYour2') || 'We could not create your chatbot. Please try again in a moment.',
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
    <Page>
      <Measure width="form">
        <PageHeader
          eyebrow="First run"
          title={t('onboarding.letsGiveYourChatbotSomething') || 'Let’s give your chatbot something to know'}
          description={t('onboarding.changeAnyOfThisLater') || 'Change any of this later.'}
        />

        {failure ? (
          <Alert
            tone="danger"
            live
            className="mb-5"
            title={t('onboarding.weCouldNotCreateYour') || 'We could not create your chatbot'}
            action={
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                {t('onboarding.checkYourPlan') || 'Check your plan'}
              </Link>
            }
          >
            {failure}
          </Alert>
        ) : null}

        <form onSubmit={submit} noValidate>
          <Card>
            <CardBody className="space-y-6">
              {/* `RadioCards`, not three loose `role="radio"` buttons in a
                  `fieldset`: those had no owning radiogroup, all three sat in the
                  tab order, arrow keys did nothing, and each blurb folded into
                  its button's accessible name. */}
              <Field label={t('onboarding.whereShouldItLearnFrom') || 'Where should it learn from?'}>
                <RadioCards
                  label={t('onboarding.whereShouldItLearnFrom') || 'Where should it learn from?'}
                  columns={3}
                  value={source}
                  onChange={setSource}
                  items={SOURCES.map((o) => ({
                    ...o,
                    label: sourceLabel(o),
                    description: sourceDescription(o),
                  }))}
                />
              </Field>

              {source === 'website' ? (
                <Field
                  label={t('onboarding.yourWebsite') || 'Your website'}
                  hint={t('onboarding.publicPagesOnly') || 'Public pages only.'}
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
                label={t('onboarding.whatIsItCalled') || 'What is it called?'}
                hint={t('onboarding.visitorsSeeThisAtThe') || 'Visitors see this at the top of the chat.'}
                error={errors.name}
              >
                <Input
                  value={name}
                  onChange={(event) => {
                    setNameTouched(true);
                    setName(event.target.value);
                  }}
                  placeholder={t('onboarding.support') || 'Support'}
                  maxLength={80}
                />
              </Field>
            </CardBody>

            {/* `CardFooter`, not a hand-rolled copy of it: the copy was identical
                except for the rounded bottom corners, so the sunken bar painted
                square corners inside a `rounded-lg` card and left a crescent of
                canvas at both bottom edges. */}
            <CardFooter className="justify-between">
              <p className="text-xs text-text-tertiary">
                {source === 'website' ? t('onboarding.weWillCheckYourSite') || 'Next you will see how many pages it found.' : null}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {/* Skippable, like every step of Linear's onboarding and none of
                    this one's. Without it `/welcome` was a forced redirect with no
                    way out, and Home's own empty state was unreachable code. */}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    skipFirstRun();
                    navigate('/', { replace: true });
                  }}
                >
                  {t('onboarding.skipForNow') || 'Skip for now'}
                </Button>
                <Button type="submit" loading={submitting} disabled={submitting}>
                  {source === 'website' ? t('onboarding.checkMySite') || 'Check my site' : t('onboarding.createMyChatbot') || 'Create my chatbot'}
                </Button>
              </div>
            </CardFooter>
          </Card>
        </form>
      </Measure>
    </Page>
  );
}
