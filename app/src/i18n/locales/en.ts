/**
 * Canonical English source for the dashboard UI.
 *
 * NOT LOADED AT RUNTIME. Every call site carries its own inline English
 * default (`t('common.save') || 'Save'`), so English is already present in the
 * component that renders it. This file exists so translators have one place to
 * work from and so the parity guards have something to assert other
 * dictionaries against.
 *
 * `api/tests/test_admin_ui_languages_contract.py` fails if a runtime loader is
 * ever added for English.
 */

const en = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    close: 'Close',
    retry: 'Retry',
    loading: 'Loading…',
    search: 'Search',
  },
  nav: {
    home: 'Home',
    homeHint: 'Daily overview',
    agents: 'Chatbots',
    agentsHint: 'Create, train and manage chatbots',
    inbox: 'Support',
    inboxHint: 'Live chat and messages',
    leads: 'Leads',
    leadsHint: 'Captured leads and qualification',
    journey: 'Journey',
    journeyHint: 'Visitor journey flow',
    analytics: 'Analytics',
    analyticsHint: 'Performance across chatbots',
    workspace: 'Workspace',
    workspaceHint: 'Members, billing and usage',
    settings: 'Settings',
    settingsHint: 'Profile, workspace and preferences',
    lockedUpgrade: '{label} - upgrade to unlock',
  },
  shell: {
    theme: {
      switchToLight: 'Switch to light theme',
      switchToDark: 'Switch to dark theme',
    },
    topbar: {
      openNavigation: 'Open navigation',
      toggleSidebar: 'Toggle sidebar',
      openCommandPalette: 'Open command palette',
    },
    breadcrumb: {
      label: 'Breadcrumb',
    },
    feedback: {
      send: 'Send feedback',
      label: 'Feedback',
    },
    workspaceSwitcher: {
      title: 'Switch workspace',
      current: 'Current workspace: {name}. Switch workspace',
    },
    commandPalette: {
      label: 'Command palette',
      placeholder: 'Go to…',
      empty: 'No results. Full search arrives in a later phase.',
      navigate: 'Navigate',
    },
  },
  settings: {
    appearance: {
      title: 'Appearance',
      description: 'Choose how OyeChats looks on this device.',
      descriptionSystem: 'Match your device appearance - currently {theme}.',
      theme: {
        legend: 'Theme',
        light: 'Light',
        lightDesc: 'Bright, paper-white surfaces.',
        dark: 'Dark',
        darkDesc: 'Dimmed surfaces for low-light work.',
        system: 'System',
        systemDesc: 'Match your device appearance.',
      },
      contrast: {
        legend: 'Contrast',
        default: 'Default',
        defaultDesc: 'Standard color and depth.',
        high: 'High contrast',
        highDesc: 'Stronger text and borders (WCAG AAA).',
      },
      language: {
        legend: 'Language',
      },
    },
  },
} as const;

export default en;
