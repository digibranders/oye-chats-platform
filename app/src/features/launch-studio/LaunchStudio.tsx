import { useEffect, useState, type ComponentType } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { completeOnboarding, getCurrentSubscription } from '../../services/api';
import { useBotContext } from '../../context/BotContext';
import { useWorkspace } from '../../context/WorkspaceContext';
import { LaunchStudioLayout } from './LaunchStudioLayout';
import { PreviewProvider } from './preview/PreviewProvider';
import { clearLaunchProgress, readLaunchProgress, writeLaunchProgress } from './resume';
import {
  LAUNCH_STEPS,
  PLAN_STEP_INDEX,
  PLAN_STEP_PATH,
  stepIndexByPath,
  type StepProps,
} from './steps.config';
import { WelcomePlanStep } from './steps/WelcomePlanStep';
import { CreateAgentStep } from './steps/CreateAgentStep';
import { TrainStep } from './steps/TrainStep';
import { TestStep } from './steps/TestStep';
import { CustomizeStep } from './steps/CustomizeStep';
import { DeployStep } from './steps/DeployStep';
import { VerifyStep } from './steps/VerifyStep';

const STEP_COMPONENTS: Record<string, ComponentType<StepProps>> = {
  welcome: WelcomePlanStep,
  create: CreateAgentStep,
  train: TrainStep,
  test: TestStep,
  customize: CustomizeStep,
  deploy: DeployStep,
  verify: VerifyStep,
};

const LAST_INDEX = LAUNCH_STEPS.length - 1;

// Static - the step list never changes, so build the stepper items once.
const STEPPER_ITEMS = LAUNCH_STEPS.map((s) => ({ key: s.key, label: s.label, description: s.hint }));

function readProgress(): number {
  return readLaunchProgress()?.step ?? 0;
}

/**
 * LaunchStudio - the onboarding state machine. Reads the current step from the
 * URL (`/launch/:step`), enforces forward-gating (you can revisit reached steps
 * but not skip ahead), and persists progress so the flow resumes after a reload.
 * On completion it calls `completeOnboarding()`, clears local progress and
 * redirects to the dashboard.
 *
 * Entry points: the Home empty-state CTA, and the post-signup redirect for a
 * brand-new account (`OAuthCallback` / `VerifyEmail`), which is gated on
 * `!onboarding_complete && bot_count === 0` - so a user who created an agent
 * here is never sent back through onboarding even if the completion call above
 * fails to land.
 */
export function LaunchStudio() {
  const { step } = useParams();
  const navigate = useNavigate();
  const currentIndex = stepIndexByPath(step);
  const [maxReached, setMaxReached] = useState(readProgress);
  const { currentWorkspaceId } = useWorkspace();
  const { bots, selectedBot, selectBot } = useBotContext();

  // Bind the studio to the agent this onboarding is FOR. Every step writes
  // through `selectedBot` (the shell switcher's scope, deliberately not synced
  // to the URL), so without this a resume would rename and re-crawl whichever
  // agent the switcher last held - a healthy production agent, from a button
  // rendered on a different agent's page.
  useEffect(() => {
    const savedBotId = readLaunchProgress()?.botId ?? null;
    if (savedBotId === null || selectedBot?.id === savedBotId) return;
    const savedBot = bots.find((bot) => bot.id === savedBotId);
    if (savedBot) selectBot(savedBot);
  }, [bots, selectedBot, selectBot]);

  // Skip-on-resume: if the user already has a PAID or trialing subscription
  // (e.g. they paid during a previous onboarding session that was interrupted),
  // bump maxReached past the plan step so they are never sent back to re-select
  // a plan they already chose.
  useEffect(() => {
    void getCurrentSubscription(undefined)
      .then((raw) => {
        const envelope = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const sub = envelope.subscription as Record<string, unknown> | undefined;
        const plan = envelope.plan as Record<string, unknown> | undefined;
        const status = typeof sub?.status === 'string' ? sub.status : '';
        const planSlug = typeof plan?.slug === 'string' ? plan.slug : '';
        // Only skip if user is on a PAID plan or active trial — default Free plan does NOT skip!
        const alreadyHasPaidPlan = (status === 'active' && planSlug !== 'free' && planSlug !== '') || status === 'trialing';
        if (alreadyHasPaidPlan) {
          setMaxReached((max) => Math.max(max, PLAN_STEP_INDEX + 1));
        } else if (!readLaunchProgress()?.botId && bots.length === 0) {
          // Brand new user without any created bot and on default Free plan:
          // Clamp maxReached to 0 so steps 2..7 stay locked until step 1 is completed.
          setMaxReached(PLAN_STEP_INDEX);
        }
      })
      .catch(() => {
        // Non-blocking: if the check fails the user sees the plan step.
      });
  }, [bots.length]); // re-evaluate when bots list resolves

  useEffect(() => {
    writeLaunchProgress(currentWorkspaceId, selectedBot?.id ?? null, maxReached);
  }, [maxReached, currentWorkspaceId, selectedBot?.id]);

  // Unknown step → start at the beginning.
  if (currentIndex === -1) {
    return <Navigate to={`/launch/${LAUNCH_STEPS[0].path}`} replace />;
  }
  // Forward-gating: can't deep-link past the furthest reached step.
  if (currentIndex > maxReached) {
    return <Navigate to={`/launch/${LAUNCH_STEPS[maxReached].path}`} replace />;
  }

  const goToStep = (index: number) => navigate(`/launch/${LAUNCH_STEPS[index].path}`);

  const handleContinue = () => {
    if (currentIndex === LAST_INDEX) {
      // Onboarding complete → mark it server-side, clear local progress, go home.
      void completeOnboarding().catch(() => {
        /* non-blocking - the dashboard still loads if this fails */
      });
      clearLaunchProgress();
      navigate('/');
      return;
    }
    const next = currentIndex + 1;
    setMaxReached((max) => Math.max(max, next));
    goToStep(next);
  };

  const handleBack = () => {
    if (currentIndex > 0) goToStep(currentIndex - 1);
  };

  const StepComponent = STEP_COMPONENTS[LAUNCH_STEPS[currentIndex].path];
  const isPlanStep = LAUNCH_STEPS[currentIndex].path === PLAN_STEP_PATH;

  return (
    <PreviewProvider>
      <LaunchStudioLayout
        steps={STEPPER_ITEMS}
        currentIndex={currentIndex}
        maxReachedIndex={maxReached}
        onStepClick={goToStep}
        hidePreview={isPlanStep}
      >
        <StepComponent
          onBack={handleBack}
          onContinue={handleContinue}
          isFirst={currentIndex === 0}
          isLast={currentIndex === LAST_INDEX}
        />
      </LaunchStudioLayout>
    </PreviewProvider>
  );
}
