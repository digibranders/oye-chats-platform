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
} as const;

export default en;
