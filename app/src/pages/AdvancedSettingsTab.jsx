import React from 'react';

/**
 * AdvancedSettingsTab - Phase 2: Timing & Advanced Settings
 * Customize timeouts, thresholds, and other advanced configuration
 */
const AdvancedSettingsTab = ({ settings, onSettingsChange }) => {
    const config = settings?.widget_config || {};

    const handleConfigChange = (key, value) => {
        onSettingsChange({
            widget_config: {
                ...config,
                [key]: value,
            },
        });
    };

    const msToSeconds = (ms) => ms / 1000;
    const secondsToMs = (seconds) => seconds * 1000;

    return (
        <div className="space-y-8">
            {/* Welcome Animation Section */}
            <div className="border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold mb-4">Welcome Screen Animation</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Exit Animation Duration (seconds)
                        </label>
                        <input
                            type="number"
                            value={msToSeconds(config.welcome_exit_duration_ms || 350)}
                            onChange={(e) => handleConfigChange('welcome_exit_duration_ms', secondsToMs(parseFloat(e.target.value)))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="0.35"
                            step="0.1"
                        />
                        <p className="text-xs text-gray-500 mt-1">How long the welcome screen takes to fade out (0.35 seconds default)</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Greeting Delay (seconds)
                        </label>
                        <input
                            type="number"
                            value={msToSeconds(config.greeting_delay_ms || 3000)}
                            onChange={(e) => handleConfigChange('greeting_delay_ms', secondsToMs(parseFloat(e.target.value)))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="3"
                            step="0.1"
                        />
                        <p className="text-xs text-gray-500 mt-1">Delay before greeting bubble appears (3 seconds default)</p>
                    </div>
                </div>
            </div>

            {/* Interaction Timeouts Section */}
            <div className="border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold mb-4">Interaction Timeouts</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Typing Indicator Timeout (seconds)
                        </label>
                        <input
                            type="number"
                            value={msToSeconds(config.typing_timeout_ms || 2000)}
                            onChange={(e) => handleConfigChange('typing_timeout_ms', secondsToMs(parseFloat(e.target.value)))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="2"
                            step="0.1"
                        />
                        <p className="text-xs text-gray-500 mt-1">How long before typing indicator clears (2 seconds default)</p>
                    </div>
                </div>
            </div>

            {/* Frustration Detection Section */}
            <div className="border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold mb-4">Frustration Detection</h3>
                <p className="text-sm text-gray-600 mb-4">Detect when visitors are frustrated based on message patterns</p>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Detection Window (seconds)
                        </label>
                        <input
                            type="number"
                            value={msToSeconds(config.frustration_window_ms || 30000)}
                            onChange={(e) => handleConfigChange('frustration_window_ms', secondsToMs(parseFloat(e.target.value)))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="30"
                            step="1"
                        />
                        <p className="text-xs text-gray-500 mt-1">Time window to check for rapid messages (30 seconds default)</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Frustration Threshold (messages)
                        </label>
                        <input
                            type="number"
                            value={config.frustration_threshold_messages || 3}
                            onChange={(e) => handleConfigChange('frustration_threshold_messages', parseInt(e.target.value))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="3"
                            step="1"
                            min="1"
                        />
                        <p className="text-xs text-gray-500 mt-1">Number of messages in window to trigger frustration flag (3 messages default)</p>
                    </div>
                </div>
            </div>

            {/* Reconnection Settings Section */}
            <div className="border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold mb-4">Connection & Reconnection</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Max Reconnection Attempts
                        </label>
                        <input
                            type="number"
                            value={config.max_reconnect_attempts || 15}
                            onChange={(e) => handleConfigChange('max_reconnect_attempts', parseInt(e.target.value))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="15"
                            step="1"
                            min="1"
                        />
                        <p className="text-xs text-gray-500 mt-1">Maximum number of reconnection attempts before giving up</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Max Reconnection Delay (seconds)
                        </label>
                        <input
                            type="number"
                            value={msToSeconds(config.max_reconnect_delay_ms || 30000)}
                            onChange={(e) => handleConfigChange('max_reconnect_delay_ms', secondsToMs(parseFloat(e.target.value)))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="30"
                            step="1"
                        />
                        <p className="text-xs text-gray-500 mt-1">Maximum delay between reconnection attempts using exponential backoff (30 seconds default)</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Heartbeat Interval - When Visible (seconds)
                        </label>
                        <input
                            type="number"
                            value={msToSeconds(config.heartbeat_visible_ms || 25000)}
                            onChange={(e) => handleConfigChange('heartbeat_visible_ms', secondsToMs(parseFloat(e.target.value)))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="25"
                            step="1"
                        />
                        <p className="text-xs text-gray-500 mt-1">How often to ping server when widget is visible (25 seconds default)</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Heartbeat Interval - When Hidden (seconds)
                        </label>
                        <input
                            type="number"
                            value={msToSeconds(config.heartbeat_hidden_ms || 50000)}
                            onChange={(e) => handleConfigChange('heartbeat_hidden_ms', secondsToMs(parseFloat(e.target.value)))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="50"
                            step="1"
                        />
                        <p className="text-xs text-gray-500 mt-1">How often to ping server when widget is hidden (50 seconds default)</p>
                    </div>
                </div>
            </div>

            {/* Handoff Section */}
            <div className="border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold mb-4">Handoff Behavior</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                            Auto-Submit Form Delay (milliseconds)
                        </label>
                        <input
                            type="number"
                            value={config.handoff_auto_submit_delay_ms || 300}
                            onChange={(e) => handleConfigChange('handoff_auto_submit_delay_ms', parseInt(e.target.value))}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="300"
                            step="50"
                            min="0"
                        />
                        <p className="text-xs text-gray-500 mt-1">Delay before auto-submitting handoff form if all fields are filled (300ms default)</p>
                    </div>
                </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-blue-800">
                    💡 <strong>Note:</strong> These are advanced settings affecting performance and user experience. Modify with caution.
                </p>
            </div>
        </div>
    );
};

export default AdvancedSettingsTab;
