/* eslint-disable react-refresh/only-export-components */
/**
 * PushContext — lifts the single `usePushNotifications` instance into a shared
 * provider so every consumer reads and mutates one source of truth.
 *
 * The hook owns a real side-effectful subscription lifecycle (service-worker
 * registration, permission state, backend subscribe/unsubscribe). Calling it
 * twice — once in AdminLayout for the PushPermissionBanner and once in the
 * Settings → Notifications tab — would create two independent state copies that
 * drift apart: toggling in the tab would not update the banner, and vice versa.
 * Mounting it once here and fanning the result out via context keeps the banner
 * and the Notifications tab perfectly in sync.
 */

import { createContext, useContext } from 'react';
import usePushNotifications from '../hooks/usePushNotifications';

const PushContext = createContext(null);

export function PushProvider({ children }) {
  const push = usePushNotifications();
  return <PushContext.Provider value={push}>{children}</PushContext.Provider>;
}

export function usePush() {
  const ctx = useContext(PushContext);
  if (ctx === null) {
    throw new Error('usePush must be used within a <PushProvider>');
  }
  return ctx;
}
