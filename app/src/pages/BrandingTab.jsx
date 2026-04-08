import React from 'react';

/**
 * BrandingTab - Phase 3: Branding & Colors
 * Customize branding text, URLs, and color scheme
 */
const BrandingTab = ({ settings, onSettingsChange }) => {
    const handleChange = (key, value) => {
        onSettingsChange({
            [key]: value,
        });
    };

    return (
        <div className="space-y-8">
            {/* Branding Text Section */}
            <div className="border border-surface-200 dark:border-surface-700 rounded-lg p-6 bg-white dark:bg-surface-900">
                <h3 className="text-lg font-semibold mb-4 text-surface-900 dark:text-surface-100">Branding Text</h3>
                <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">Customize the branding text displayed at the bottom of the widget</p>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                            Branding Text
                        </label>
                        <input
                            type="text"
                            value={settings.branding_text || 'Powered by OyeChats'}
                            onChange={(e) => handleChange('branding_text', e.target.value)}
                            className="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            placeholder="Powered by OyeChats"
                            maxLength="255"
                        />
                        <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                            Text displayed as branding footer (default: "Powered by OyeChats")
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                            Branding URL
                        </label>
                        <input
                            type="url"
                            value={settings.branding_url || 'https://oyechats.com'}
                            onChange={(e) => handleChange('branding_url', e.target.value)}
                            className="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            placeholder="https://oyechats.com"
                            maxLength="255"
                        />
                        <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                            URL that branding text links to (default: https://oyechats.com)
                        </p>
                    </div>
                </div>
            </div>

            {/* Note */}

            <div className="bg-sky-50 dark:bg-sky-500/10 border border-sky-200 dark:border-sky-500/20 rounded-lg p-4">
                <p className="text-sm text-sky-800 dark:text-sky-300">
                    💡 <strong>Note:</strong> Branding changes take effect immediately. Color changes require widget reload to apply.
                </p>
            </div>
        </div>
    );
};

export default BrandingTab;
