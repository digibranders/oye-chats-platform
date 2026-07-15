/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback } from 'react';

// Holds the contextual app-bar state (breadcrumbs + title + page actions)
// so a routed page can push its header into the shared TopBar. Pages publish
// via the headless <PageHeader/> component; TopBar consumes with usePageHeader.
const PageHeaderContext = createContext(null);

export function PageHeaderProvider({ children }) {
  const [header, setHeader] = useState({ crumbs: [], title: '', actions: null, hint: '' });
  // Shallow-merge so a page can update a subset (e.g. only `actions`) without
  // clobbering the crumbs/title it published on mount.
  const setPageHeader = useCallback((cfg) => setHeader((h) => ({ ...h, ...cfg })), []);
  return (
    <PageHeaderContext.Provider value={{ ...header, setPageHeader }}>
      {children}
    </PageHeaderContext.Provider>
  );
}

export const usePageHeader = () => {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) throw new Error('usePageHeader must be used within PageHeaderProvider');
  return ctx;
};
