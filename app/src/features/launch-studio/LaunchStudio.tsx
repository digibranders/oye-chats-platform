import { useEffect, useState, type ComponentType } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { LaunchStudioLayout } from './LaunchStudioLayout';
import {
  LAUNCH_STEPS,
  LAUNCH_PROGRESS_KEY,
  stepIndexByPath,
  type StepProps,
} from './steps.config';
import { WelcomeStep } from './steps/WelcomeStep';
import { CreateAgentStep } from './steps/CreateAgentStep';
import { ConnectStep } from './steps/ConnectStep';
import { TrainStep } from './steps/TrainStep';
import { ReviewStep } from './steps/ReviewStep';
import { TestStep } from './steps/TestStep';
import { CustomizeStep } from './steps/CustomizeStep';
import { DeployStep } from './steps/DeployStep';
import { VerifyStep } from './steps/VerifyStep';

const STEP_COMPONENTS: Record<string, ComponentType<StepProps>> = {
  welcome: WelcomeStep,
  create: CreateAgentStep,
  connect: ConnectStep,
  train: TrainStep,
  review: ReviewStep,
  test: TestStep,
  customize: CustomizeStep,
  deploy: DeployStep,
  verify: VerifyStep,
};

const LAST_INDEX = LAUNCH_STEPS.length - 1;

// Static — the step list never changes, so build the stepper items once.
const STEPPER_ITEMS = LAUNCH_STEPS.map((s) => ({ key: s.key, label: s.label, description: s.hint }));

function readProgress(): number {
  if (typeof localStorage === 'undefined') return 0;
  const stored = Math.floor(Number(localStorage.getItem(LAUNCH_PROGRESS_KEY) ?? 0));
  return Number.isFinite(stored) ? Math.max(0, Math.min(stored, LAST_INDEX)) : 0;
}

/**
 * LaunchStudio — the onboarding state machine. Reads the current step from the
 * URL (`/launch/:step`), enforces forward-gating (you can revisit reached steps
 * but not skip ahead), and persists progress so the flow resumes after a reload.
 * On completion it redirects to the dashboard and never returns.
 * TODO(phase-2b): call completeOnboarding() on finish once auth/data is wired.
 */
export function LaunchStudio() {
  const { step } = useParams();
  const navigate = useNavigate();
  const currentIndex = stepIndexByPath(step);
  const [maxReached, setMaxReached] = useState(readProgress);

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LAUNCH_PROGRESS_KEY, String(maxReached));
    }
  }, [maxReached]);

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
      navigate('/'); // onboarding complete → dashboard
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
  );
}
