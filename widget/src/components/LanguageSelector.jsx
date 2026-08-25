import React from 'react';
import { Check, Globe, X } from 'lucide-react';
import { t } from '../i18n/i18n.js';
// Display names come from the shared catalog rather than a list maintained
// here. The local copy had drifted: it offered languages the backend did not
// recognise and no dictionary existed for.
import { normalizeLocale } from '../i18n/localeCatalog.js';
import { getLocaleDisplay } from '../i18n/localeNames.js';

const LanguageSelector = ({
    supportedLocales = ['en-IN'],
    activeLocale = 'en-IN',
    onSelectLocale,
    onClose,
    isOpen = false,
}) => {
    if (!isOpen) return null;

    const locales = supportedLocales && supportedLocales.length > 0 ? supportedLocales : ['en-IN'];

    return (
        <div
            className="absolute inset-0 bg-white/95 backdrop-blur-sm z-50 flex flex-col p-4 animate-fade-in"
            style={{ animation: 'fadeUp 0.2s ease-out' }}
        >
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 mb-3">
                <div className="flex items-center gap-2 text-[#16202C]">
                    <Globe className="w-4 h-4 text-blue-600" />
                    <h3 className="font-semibold text-sm">
                        {t('language.select_title') || 'Choose Language'}
                    </h3>
                </div>
                <button
                    onClick={onClose}
                    className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                    title={t('header.close') || 'Close'}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 pr-1">
                {locales.map((loc) => {
                    const info = getLocaleDisplay(loc);
                    // Exact tag only. A base-language comparison marked both
                    // en-US and en-GB as current when a bot supported both.
                    const isSelected = normalizeLocale(activeLocale) === normalizeLocale(loc);

                    return (
                        <button
                            key={loc}
                            onClick={() => {
                                onSelectLocale(loc);
                                onClose();
                            }}
                            className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-left transition-all ${
                                isSelected
                                    ? 'bg-blue-50/80 border border-blue-200/80 text-blue-900 font-medium'
                                    : 'hover:bg-gray-50 border border-transparent text-gray-700'
                            }`}
                        >
                            <div className="flex flex-col">
                                <span className="text-[13px] font-medium leading-tight">
                                    {info.native}
                                </span>
                                {info.name !== info.native && (
                                    <span className="text-[11px] text-gray-400 leading-tight mt-0.5">
                                        {info.name}
                                    </span>
                                )}
                            </div>
                            {isSelected && (
                                <Check className="w-4 h-4 text-blue-600 flex-shrink-0" />
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

export default LanguageSelector;
