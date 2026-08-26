import { getLocale } from './i18n.js';

/**
 * Format a time string according to the active or specified locale.
 * Example: 4:30 PM (en-US) or 04:30 अपराह्न (hi-IN)
 */
export function formatTime(dateInput, locale = getLocale(), options = {}) {
    if (!dateInput) return '';
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (Number.isNaN(date.getTime())) return '';

    try {
        return new Intl.DateTimeFormat(locale, {
            hour: '2-digit',
            minute: '2-digit',
            ...options,
        }).format(date);
    } catch {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}

/**
 * Format a date string according to the active or specified locale.
 * Example: Sat, Aug 22 (en-US) or शनि, 22 अग (hi-IN)
 */
export function formatDate(dateInput, locale = getLocale(), options = {}) {
    if (!dateInput) return '';
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (Number.isNaN(date.getTime())) return '';

    try {
        return new Intl.DateTimeFormat(locale, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            ...options,
        }).format(date);
    } catch {
        return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    }
}

/**
 * Format date and time for header chrome.
 * Example: "Sat, Aug 22 · 4:30 PM"
 */
export function formatHeaderDateTime(dateInput, locale = getLocale()) {
    const formattedDate = formatDate(dateInput, locale);
    const formattedTime = formatTime(dateInput, locale);
    if (!formattedDate || !formattedTime) return '';
    return `${formattedDate} · ${formattedTime}`;
}
