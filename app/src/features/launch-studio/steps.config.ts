import {
  Globe,
  ScanSearch,
  GraduationCap,
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
 * Launch Studio — the mandated 8-step onboarding. Rebuilt from first
 * principles (the legacy 4-milestone Build Studio is a logic reference only).
 * Notable additions vs. legacy: an explicit "Review Knowledge" step (legacy had
 * none) and a standalone "Verify Installation" step (legacy merged it into
 * deploy). Users complete this once, then it's gone — never navigation.
 */
export const LAUNCH_STEPS: LaunchStep[] = [
  { key: 'connect', path: 'connect', label: 'Connect Website', hint: 'Point us at your site', icon: Globe },
  { key: 'analyze', path: 'analyze', label: 'Analyze Website', hint: 'Discover your pages', icon: ScanSearch },
  { key: 'train', path: 'train', label: 'Train AI', hint: 'Learn your content', icon: GraduationCap },
  { key: 'review', path: 'review', label: 'Review Knowledge', hint: 'Check what it learned', icon: BookOpenCheck },
  { key: 'test', path: 'test', label: 'Test AI', hint: 'Try it yourself', icon: MessagesSquare },
  { key: 'customize', path: 'customize', label: 'Customize Widget', hint: 'Make it yours', icon: Palette },
  { key: 'deploy', path: 'deploy', label: 'Deploy', hint: 'Add it to your site', icon: Rocket },
  { key: 'verify', path: 'verify', label: 'Verify Installation', hint: "Confirm it's live", icon: BadgeCheck },
];

export const LAUNCH_PROGRESS_KEY = 'oc_launch_max_step';

export function stepIndexByPath(path: string | undefined): number {
  if (!path) return -1;
  return LAUNCH_STEPS.findIndex((step) => step.path === path);
}
