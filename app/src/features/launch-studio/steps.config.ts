import {
  PartyPopper,
  Bot,
  Globe,
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
 * Launch Studio - the 8-step onboarding. Rebuilt from first principles; the
 * legacy 4-milestone Build Studio is a logic reference only. Opens with a
 * Welcome intro + explicit "Create Agent"; "Knowledge" is one state-driven step
 * that shows live training progress then becomes the source/page review. Users
 * complete this once, then it's gone - never navigation.
 */
export const LAUNCH_STEPS: LaunchStep[] = [
  { key: 'welcome', path: 'welcome', label: 'Welcome', hint: "Let's get you set up", icon: PartyPopper },
  { key: 'create', path: 'create', label: 'Create Agent', hint: 'Name your AI Chatbot', icon: Bot },
  { key: 'connect', path: 'connect', label: 'Connect Website', hint: 'Point us at your site', icon: Globe },
  { key: 'knowledge', path: 'knowledge', label: 'Knowledge', hint: 'Train & review', icon: BookOpenCheck },
  { key: 'test', path: 'test', label: 'Test Agent', hint: 'Try it yourself', icon: MessagesSquare },
  { key: 'customize', path: 'customize', label: 'Customize Widget', hint: 'Make it yours', icon: Palette },
  { key: 'deploy', path: 'deploy', label: 'Deploy', hint: 'Add it to your site', icon: Rocket },
  { key: 'verify', path: 'verify', label: 'Verification', hint: "Confirm it's live", icon: BadgeCheck },
];

export const LAUNCH_PROGRESS_KEY = 'oc_launch_max_step';

export function stepIndexByPath(path: string | undefined): number {
  if (!path) return -1;
  return LAUNCH_STEPS.findIndex((step) => step.path === path);
}
