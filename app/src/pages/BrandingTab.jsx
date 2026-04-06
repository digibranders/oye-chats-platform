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
            <div className="border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold mb-4">Branding Text</h3>
                <p className="text-sm text-gray-600 mb-4">Customize the branding text displayed at the bottom of the widget</p>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Branding Text
                        </label>
                        <input
                            type="text"
                            value={settings.branding_text || 'Powered by OyeChats'}
                            onChange={(e) => handleChange('branding_text', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="Powered by OyeChats"
                            maxLength="255"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                            Text displayed as branding footer (default: "Powered by OyeChats")
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Branding URL
                        </label>
                        <input
                            type="url"
                            value={settings.branding_url || 'https://oyechats.com'}
                            onChange={(e) => handleChange('branding_url', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="https://oyechats.com"
                            maxLength="255"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                            URL that branding text links to (default: https://oyechats.com)
                        </p>
                    </div>
                </div>
            </div>

            {/* Note */}

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-blue-800">
                    💡 <strong>Note:</strong> Branding changes take effect immediately. Color changes require widget reload to apply.
                </p>
            </div>
        </div>
    );
};

export default BrandingTab;
