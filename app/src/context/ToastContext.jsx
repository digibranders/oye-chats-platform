import { createContext, useContext, useState, useRef, useCallback } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
    const [toast, setToast] = useState(null);
    const timerRef = useRef(null);

    const showToast = useCallback((type, message, duration = 4000) => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setToast({ type, message });
        timerRef.current = setTimeout(() => setToast(null), duration);
    }, []);

    const dismissToast = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setToast(null);
    }, []);

    return (
        <ToastContext.Provider value={{ toast, showToast, dismissToast }}>
            {children}
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used within a ToastProvider');
    return ctx;
}
