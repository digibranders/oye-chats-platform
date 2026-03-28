/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect } from 'react';

const ThemeContext = createContext();

export function ThemeProvider({ children }) {
    useEffect(() => {
        // Always light mode — remove dark class if present
        window.document.documentElement.classList.remove('dark');
        localStorage.setItem('admin_theme', 'light');
    }, []);

    return (
        <ThemeContext.Provider value={{ theme: 'light', setTheme: () => {} }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error("useTheme must be used within a ThemeProvider");
    }
    return context;
}
