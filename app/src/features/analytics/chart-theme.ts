import { useTheme } from '../../design-system';

/**
 * Concrete colors for Recharts, which can't read CSS custom properties. Values
 * mirror the design-system tokens (`tokens.css`) for each theme so the chart
 * stays consistent with the rest of the surface — volt-violet accent, warm
 * neutral grid/axis.
 */
export interface ChartPalette {
  accent: string;
  accentFill: string;
  grid: string;
  axis: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
}

const LIGHT: ChartPalette = {
  accent: '#7C3AED',
  accentFill: 'rgba(124, 58, 237, 0.14)',
  grid: '#e7e5de',
  axis: '#a1a1aa',
  surface: '#ffffff',
  border: '#e7e5de',
  text: '#18181b',
  muted: '#52525b',
};

const DARK: ChartPalette = {
  accent: '#8B5CF6',
  accentFill: 'rgba(139, 92, 246, 0.20)',
  grid: '#27272a',
  axis: '#71717a',
  surface: '#18181b',
  border: '#27272a',
  text: '#fafafa',
  muted: '#a1a1aa',
};

/** Theme-aware chart palette that flips with the active DS theme. */
export function useChartPalette(): ChartPalette {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === 'dark' ? DARK : LIGHT;
}
