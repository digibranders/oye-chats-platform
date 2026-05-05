import React from 'react';
import { Tag } from 'lucide-react';

const SECTION_HEADER_BASE = "text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2";
const SECTION_SUBTITLE = "text-[13px] text-surface-500 dark:text-surface-400 mt-0.5";
const CARD = "bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm space-y-4";
const FIELD_LABEL = "text-[13px] font-bold text-surface-700 dark:text-surface-300";
const FIELD_INPUT = "w-full h-10 px-3 text-sm text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:placeholder:text-surface-500";
const FIELD_HELP = "text-[11px] text-surface-400";

const BrandingTab = ({ settings, onSettingsChange }) => {
    const handleChange = (key, value) => {
        onSettingsChange({
            [key]: value,
        });
    };

    return (
        <div className="space-y-6 animate-fade-in">
            {/* Branding Text */}
            <div>
                <h3 className={SECTION_HEADER_BASE}>
                    <Tag className="w-4 h-4 text-primary-500" />
                    Branding Text
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Customize the branding text displayed at the bottom of the widget.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Branding Text</label>
                    <input
                        type="text"
                        value={settings.branding_text || 'Powered by OyeChats'}
                        onChange={(e) => handleChange('branding_text', e.target.value)}
                        className={FIELD_INPUT}
                        placeholder="Powered by OyeChats"
                        maxLength="255"
                    />
                    <p className={FIELD_HELP}>
                        Text displayed as branding footer (default: &quot;Powered by OyeChats&quot;).
                    </p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Branding URL</label>
                    <input
                        type="url"
                        value={settings.branding_url || 'https://oyechats.com'}
                        onChange={(e) => handleChange('branding_url', e.target.value)}
                        className={FIELD_INPUT}
                        placeholder="https://oyechats.com"
                        maxLength="255"
                    />
                    <p className={FIELD_HELP}>
                        URL that branding text links to (default: https://oyechats.com).
                    </p>
                </div>
            </div>

            <div className="bg-sky-50 dark:bg-sky-500/10 border border-sky-200 dark:border-sky-500/20 rounded-lg p-4">
                <p className="text-sm text-sky-800 dark:text-sky-300">
                    💡 <strong>Note:</strong> Branding changes take effect immediately. Color changes require widget reload to apply.
                </p>
            </div>
        </div>
    );
};

export default BrandingTab;
