/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useCallback } from 'react';
import { Toaster, toast as sonnerToast } from 'sonner';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const showToast = useCallback((type, message) => {
    switch (type) {
      case 'success':
        sonnerToast.success(message);
        break;
      case 'error':
        sonnerToast.error(message);
        break;
      case 'warning':
        sonnerToast.warning(message);
        break;
      case 'info':
        sonnerToast.info(message);
        break;
      default:
        sonnerToast(message);
    }
  }, []);

  const dismissToast = useCallback(() => {
    sonnerToast.dismiss();
  }, []);

  return (
    <ToastContext.Provider value={{ toast: null, showToast, dismissToast }}>
      {children}
      <Toaster
        position="top-right"
        toastOptions={{
          className: 'font-sans',
          style: {
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
          },
        }}
        richColors
        closeButton
        offset={16}
        gap={8}
      />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
