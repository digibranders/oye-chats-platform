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
    security: {
      title: 'Account security',
      password: 'Password',
      passwordDescription:
        'Update your sign-in password. Use at least 8 characters with a letter and a number.',
      hidePassword: 'Hide password',
      showPassword: 'Show password',
      currentPassword: 'Current password',
      currentPasswordPlaceholder: 'Your current password',
      newPassword: 'New password',
      newPasswordPlaceholder: 'At least 8 characters, a letter and a number',
      confirmNewPassword: 'Confirm new password',
      confirmPlaceholder: 'Repeat your new password',
      passwordRule: 'New password must be at least 8 characters and include a letter and a number.',
      passwordRuleHint: 'Must be at least 8 characters and include a letter and a number.',
      passwordsDoNotMatch: 'Passwords do not match.',
      passwordChanged: 'Your password has been changed.',
      passwordChangeFailed: 'We couldn’t change your password. Please try again.',
      changePassword: 'Change password',
      forgotPassword: 'Forgot your password?',
      forgotHintPrefix: 'Don’t remember your current password? Use',
      forgotHintSuffix: 'to reset it with a code sent to your email.',
      emailAddress: 'Email address',
      currentEmail: 'Current email',
      newEmail: 'New email',
      change: 'Change',
      confirmItsYou: "Confirm it's you",
      sendCode: 'Send verification code',
      verificationCode: 'Verification code',
      codePlaceholder: '6-digit code',
      verificationPendingFor: 'Verification pending for',
      resendCode: 'Didn’t receive a code? Resend',
      confirmChange: 'Confirm change',
      cancelChange: 'Cancel change',
      emailInvalid: 'Enter a valid email address.',
      emailSame: 'That’s already your current email address.',
      emailNeedPassword: 'Enter your current password to confirm this change.',
      emailNeedCode: 'Enter the verification code.',
      emailStartFailed: 'Failed to start the email change.',
      emailCancelFailed: 'Failed to cancel the email change.',
      emailConfirmFailed: 'Failed to confirm the email change.',
      emailUpdated: 'Email address updated.',
      operatorEmailNote:
        'Contact your workspace owner to change your email - operator accounts don’t have a self-serve email change.',
      notAvailable: 'Not available',
    },
    install: {
      title: 'Install as app',
      description:
        'Add OyeChats to your dock or home screen so incoming chats reach you even when the browser is closed.',
      installed: 'You’re running OyeChats as an installed app on this device.',
      install: 'Install OyeChats',
      installing: 'Installing…',
      iosHint: 'To install, tap the Share icon in Safari, then choose Add to Home Screen.',
      genericHint:
        'Your browser doesn’t offer a one-click install here. Open the browser menu and look for Install app or Add to Home Screen.',
    },
    page: {
      nameEmpty: 'Your name can’t be empty.',
      nameUpdated: 'Your name has been updated.',
      nameUpdateFailed: 'Failed to update your name.',
      avatarUpdated: 'Your profile picture has been updated.',
      avatarUploadFailed: 'Failed to upload profile picture.',
      avatarRemoved: 'Your profile picture has been removed.',
      avatarRemoveFailed: 'Failed to remove profile picture.',
      uploadImage: 'Upload image',
      remove: 'Remove',
      emailAddress: 'Email address',
      notAvailable: 'Not available',
      title: 'Settings',
      description: 'Your account, profile and sign-in security.',
      loadFailed: 'We couldn’t load your account settings. Please try again.',
      errorTitle: 'Couldn’t load your settings',
      tryAgain: 'Try again',
      profileTitle: 'Your profile',
      profileDescription: 'Your identity, sign-in email, and password.',
      editName: 'Edit name',
      yourName: 'Your name',
      namePlaceholder: 'e.g. Priya Sharma',
      saving: 'Saving…',
      saveChanges: 'Save changes',
      name: 'Name',
      profilePicture: 'Profile picture',
      profilePictureHint:
        'Optional - shown to teammates and to visitors in live chat. Without one, your initials are shown instead.',
    },
    contact: {
      title: 'Need something custom?',
      description: 'Bespoke integrations, custom pricing, or a feature built for your workspace.',
      body: 'Our team handles these directly rather than through the standard support queue. Reach out and we’ll get back to you.',
      copy: 'Copy',
      copiedShort: 'Copied',
      copied: 'Email address copied',
      copyAddress: 'Copy {email}',
      copyFailed: 'Couldn’t copy - select the address above and copy it manually.',
      emailUs: 'Email us',
    },
    sessions: {
      title: 'Active sessions',
      description: 'Where you’re currently signed in to the dashboard.',
      thisDevice: 'This device',
      current: 'Current',
      signOut: 'Sign out',
      impersonationEnded: 'Impersonation session ended. You can close this tab.',
    },
    notifications: {
      sectionTitle: 'Notifications',
      sectionDescription: 'Choose how OyeChats reaches you on this device.',
      title: 'Browser notifications',
      description:
        'Get alerted the moment a visitor wants to chat, even when this tab is in the background.',
      checking: 'Checking notification status…',
      unsupported:
        'This browser doesn’t support web push notifications. Try a recent version of Chrome, Edge, or Firefox on desktop.',
      blockedTitle: 'Notifications are blocked in your browser',
      blockedBody:
        'Click the lock icon next to the address bar → Notifications → Allow, then re-check below.',
      recheck: 'Re-check permission',
      subscribed: 'You’re subscribed on this device.',
      turnOff: 'Turn off',
      enable: 'Enable notifications',
      allowedTitle: 'Notifications are allowed in your browser',
      allowedBody:
        'But web push isn’t fully set up for this dashboard yet - delivering alerts needs the push service key enabled on the server, which isn’t available to the app here. There’s nothing more to do on this device until that’s switched on.',
      disabledTitle: 'Push notifications aren’t enabled yet',
      disabledBody:
        'Your browser is ready, but web push is currently turned off on the server, so alerts can’t be delivered. It’ll start working here automatically once it’s switched on - nothing more to do on this device.',
    },
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
