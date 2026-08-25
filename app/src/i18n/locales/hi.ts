/**
 * Hindi dictionary for the dashboard UI.
 *
 * Lazily imported by `i18n.ts` the first time Hindi is selected, so an English
 * user never downloads it. Key and placeholder parity with `en.ts` is enforced
 * by `src/i18n/dictionary-parity.test.ts`.
 *
 * Product nouns that users say in English ("OyeChats") stay in English on
 * purpose; translating a brand name is not localization.
 */

const hi = {
  common: {
    save: 'सहेजें',
    cancel: 'रद्द करें',
    close: 'बंद करें',
    retry: 'पुनः प्रयास करें',
    loading: 'लोड हो रहा है…',
    search: 'खोजें',
  },
  nav: {
    home: 'होम',
    homeHint: 'दैनिक अवलोकन',
    agents: 'चैटबॉट',
    agentsHint: 'चैटबॉट बनाएँ, प्रशिक्षित करें और प्रबंधित करें',
    inbox: 'सहायता',
    inboxHint: 'लाइव चैट और संदेश',
    leads: 'लीड',
    leadsHint: 'कैप्चर की गई लीड और योग्यता',
    journey: 'यात्रा',
    journeyHint: 'विज़िटर यात्रा प्रवाह',
    analytics: 'विश्लेषण',
    analyticsHint: 'सभी चैटबॉट का प्रदर्शन',
    workspace: 'वर्कस्पेस',
    workspaceHint: 'सदस्य, बिलिंग और उपयोग',
    settings: 'सेटिंग्स',
    settingsHint: 'प्रोफ़ाइल, वर्कस्पेस और प्राथमिकताएँ',
    lockedUpgrade: '{label} - अनलॉक करने के लिए अपग्रेड करें',
  },
  shell: {
    theme: {
      switchToLight: 'हल्की थीम पर जाएँ',
      switchToDark: 'गहरी थीम पर जाएँ',
    },
    topbar: {
      openNavigation: 'नेविगेशन खोलें',
      toggleSidebar: 'साइडबार टॉगल करें',
      openCommandPalette: 'कमांड पैलेट खोलें',
    },
    breadcrumb: {
      label: 'ब्रेडक्रम्ब',
    },
    feedback: {
      send: 'प्रतिक्रिया भेजें',
      label: 'प्रतिक्रिया',
    },
    workspaceSwitcher: {
      title: 'वर्कस्पेस बदलें',
      current: 'वर्तमान वर्कस्पेस: {name}। वर्कस्पेस बदलें',
    },
    commandPalette: {
      label: 'कमांड पैलेट',
      placeholder: 'यहाँ जाएँ…',
      empty: 'कोई परिणाम नहीं। पूर्ण खोज बाद के चरण में आएगी।',
      navigate: 'नेविगेट करें',
    },
  },
  settings: {
    appearance: {
      title: 'रूप',
      description: 'चुनें कि इस डिवाइस पर OyeChats कैसा दिखे।',
      descriptionSystem: 'अपने डिवाइस के रूप से मेल खाएँ - अभी {theme}।',
      theme: {
        legend: 'थीम',
        light: 'हल्का',
        lightDesc: 'चमकदार, कागज़-सफ़ेद सतहें।',
        dark: 'गहरा',
        darkDesc: 'कम रोशनी में काम के लिए मंद सतहें।',
        system: 'सिस्टम',
        systemDesc: 'अपने डिवाइस के रूप से मेल खाएँ।',
      },
      contrast: {
        legend: 'कंट्रास्ट',
        default: 'डिफ़ॉल्ट',
        defaultDesc: 'मानक रंग और गहराई।',
        high: 'उच्च कंट्रास्ट',
        highDesc: 'अधिक स्पष्ट टेक्स्ट और किनारे (WCAG AAA)।',
      },
      language: {
        legend: 'भाषा',
      },
    },
  },
} as const;

export default hi;
