import { useEffect, useState, type ComponentType } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { completeOnboarding } from '../../services/api';
import { useBotContext } from '../../context/BotContext';
import { useWorkspace } from '../../context/WorkspaceContext';
import { LaunchStudioLayout } from './LaunchStudioLayout';
import { PreviewProvider } from './preview/PreviewProvider';
import { clearLaunchProgress, readLaunchProgress, writeLaunchProgress } from './resume';
import {
  LAUNCH_STEPS,
  stepIndexByPath,
  type StepProps,
} from './steps.config';
import { WelcomeStep } from './steps/WelcomeStep';
import { CreateAgentStep } from './steps/CreateAgentStep';
import { ConnectStep } from './steps/ConnectStep';
import { KnowledgeStep } from './steps/KnowledgeStep';
import { TestStep } from './steps/TestStep';
import { CustomizeStep } from './steps/CustomizeStep';
import { DeployStep } from './steps/DeployStep';
import { VerifyStep } from './steps/VerifyStep';

const STEP_COMPONENTS: Record<string, ComponentType<StepProps>> = {
  welcome: WelcomeStep,
  create: CreateAgentStep,
  connect: ConnectStep,
  knowledge: KnowledgeStep,
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

  return (
    <PreviewProvider>
      <LaunchStudioLayout
        steps={STEPPER_ITEMS}
        currentIndex={currentIndex}
        maxReachedIndex={maxReached}
        onStepClick={goToStep}
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
