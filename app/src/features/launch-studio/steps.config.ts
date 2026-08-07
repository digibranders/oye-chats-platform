import {
  PartyPopper,
  Bot,
  BookOpenCheck,
  MessagesSquare,
  Palette,
  Rocket,
  BadgeCheck,
  type LucideIcon,
} from 'lucide-react';

/** Props every Launch Studio step receives from the container. */
export interface StepProps {
  onBack: () => void;
  onContinue: () => void;
  isFirst: boolean;
  isLast: boolean;
}

export interface LaunchStep {
  key: string;
  /** URL segment: `/launch/<path>`. */
  path: string;
  /** Short label shown in the stepper. */
  label: string;
  /** One-line description shown under the stepper label. */
  hint: string;
  icon: LucideIcon;
}

/**
 * Launch Studio - 7-step onboarding.
 *
 * Step merges vs. previous 9-step build:
 *   Welcome + Plan Selection  → 'welcome'  (choose plan before building)
 *   Connect Website + Knowledge → 'train'  (one URL-to-trained surface)
 */
export const LAUNCH_STEPS: LaunchStep[] = [
  { key: 'welcome',  path: 'welcome',  label: 'Welcome',        hint: 'Get started & pick a plan', icon: PartyPopper   },
  { key: 'create',   path: 'create',   label: 'Create Agent',   hint: 'Name your AI Chatbot',     icon: Bot           },
  { key: 'train',    path: 'train',    label: 'Setup & Train',  hint: 'Connect website & teach AI',icon: BookOpenCheck  },
  { key: 'test',     path: 'test',     label: 'Test Agent',     hint: 'Try it yourself',          icon: MessagesSquare},
  { key: 'customize',path: 'customize',label: 'Customize Widget',hint: 'Make it yours',           icon: Palette       },
  { key: 'deploy',   path: 'deploy',   label: 'Deploy',         hint: 'Add it to your site',     icon: Rocket        },
  { key: 'verify',   path: 'verify',   label: 'Verification',   hint: "Confirm it's live",       icon: BadgeCheck    },
];

/**
 * The welcome step IS the plan-selection step (index 0).
 * Used by LaunchStudio to know when to hide the live preview panel.
 */
export const PLAN_STEP_PATH = 'welcome';
export const PLAN_STEP_INDEX = 0;

export const LAUNCH_PROGRESS_KEY = 'oc_launch_max_step';

export function stepIndexByPath(path: string | undefined): number {
  if (!path) return -1;
  return LAUNCH_STEPS.findIndex((step) => step.path === path);
}
