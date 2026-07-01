import React from 'react';
import { Shield, Wand2, Timer, AlertTriangle, Wifi, ArrowRightLeft } from 'lucide-react';

const SECTION_HEADER_BASE = "text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2";
const SECTION_SUBTITLE = "text-[13px] text-surface-500 dark:text-surface-400 mt-0.5";
const CARD = "bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm space-y-4";
const FIELD_LABEL = "text-[13px] font-bold text-surface-700 dark:text-surface-300";
const FIELD_INPUT = "w-full h-10 px-3 text-sm text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:placeholder:text-surface-500";
const FIELD_HELP = "text-[11px] text-surface-400";

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

    const handleBotFieldChange = (key, value) => {
        onSettingsChange({ [key]: value });
    };

    const msToSeconds = (ms) => ms / 1000;
    const secondsToMs = (seconds) => seconds * 1000;

    const STRICTNESS_LEVELS = [
        { value: 0.45, label: 'Lenient', help: 'Answer more questions, even when retrieval is weak. Best when your KB has gaps.' },
        { value: 0.55, label: 'Balanced (default)', help: 'Reasonable mix of helpfulness and scope enforcement.' },
        { value: 0.65, label: 'Strict', help: 'Refuse anything not clearly answered by your KB. Best for regulated content.' },
    ];

    const currentThreshold = settings?.relevance_threshold;

    return (
        <div className="space-y-6 animate-fade-in">
            {/* Scope Strictness */}
            <div>
                <h3 className={SECTION_HEADER_BASE}>
                    <Shield className="w-4 h-4 text-primary-500" />
                    Scope Strictness
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Controls how strictly the bot refuses questions outside your knowledge base. Lower it if legitimate questions are being refused; raise it to lock the bot down tighter.
                </p>
            </div>
            <div className={CARD}>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {STRICTNESS_LEVELS.map((level) => {
                        const selected = currentThreshold !== null && currentThreshold !== undefined
                            && Math.abs(currentThreshold - level.value) < 0.01;
                        const isDefault = currentThreshold === null || currentThreshold === undefined;
                        const showAsSelected = selected || (isDefault && level.value === 0.55);
                        return (
                            <button
                                key={level.value}
                                type="button"
                                onClick={() => handleBotFieldChange('relevance_threshold', level.value)}
                                className={`text-left border rounded-lg p-4 transition focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 ${
                                    showAsSelected
                                        ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10 dark:border-primary-400'
                                        : 'border-surface-200 dark:border-surface-700 hover:border-surface-300 dark:hover:border-surface-600 bg-white dark:bg-surface-800'
                                }`}
                            >
                                <div className="font-semibold text-[14px] text-surface-900 dark:text-surface-100">{level.label}</div>
                                <div className="text-[12px] text-surface-500 dark:text-surface-400 mt-1">{level.help}</div>
                                <div className="text-[11px] text-surface-400 dark:text-surface-500 mt-2 font-mono">threshold = {level.value}</div>
                            </button>
                        );
                    })}
                </div>

                {currentThreshold !== null && currentThreshold !== undefined && (
                    <button
                        type="button"
                        onClick={() => handleBotFieldChange('relevance_threshold', null)}
                        className="text-[11px] text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 underline underline-offset-2"
                    >
                        Reset to platform default
                    </button>
                )}
            </div>

            {/* Welcome Animation */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <Wand2 className="w-4 h-4 text-primary-500" />
                    Welcome Screen Animation
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Tune the timing of the welcome screen and greeting bubble.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Exit Animation Duration (seconds)</label>
                    <input
                        type="number"
                        value={msToSeconds(config.welcome_exit_duration_ms || 350)}
                        onChange={(e) => handleConfigChange('welcome_exit_duration_ms', secondsToMs(parseFloat(e.target.value)))}
                        className={FIELD_INPUT}
                        placeholder="0.35"
                        step="0.1"
                    />
                    <p className={FIELD_HELP}>How long the welcome screen takes to fade out (0.35 seconds default).</p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Greeting Delay (seconds)</label>
                    <input
                        type="number"
                        value={msToSeconds(config.greeting_delay_ms || 3000)}
                        onChange={(e) => handleConfigChange('greeting_delay_ms', secondsToMs(parseFloat(e.target.value)))}
                        className={FIELD_INPUT}
                        placeholder="3"
                        step="0.1"
                    />
                    <p className={FIELD_HELP}>Delay before greeting bubble appears (3 seconds default).</p>
                </div>
            </div>

            {/* Interaction Timeouts */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <Timer className="w-4 h-4 text-primary-500" />
                    Interaction Timeouts
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Limits for transient UI states like the typing indicator.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Typing Indicator Timeout (seconds)</label>
                    <input
                        type="number"
                        value={msToSeconds(config.typing_timeout_ms || 2000)}
                        onChange={(e) => handleConfigChange('typing_timeout_ms', secondsToMs(parseFloat(e.target.value)))}
                        className={FIELD_INPUT}
                        placeholder="2"
                        step="0.1"
                    />
                    <p className={FIELD_HELP}>How long before typing indicator clears (2 seconds default).</p>
                </div>
            </div>

            {/* Frustration Detection */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <AlertTriangle className="w-4 h-4 text-primary-500" />
                    Frustration Detection
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Detect when visitors are frustrated based on message patterns.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Detection Window (seconds)</label>
                    <input
                        type="number"
                        value={msToSeconds(config.frustration_window_ms || 30000)}
                        onChange={(e) => handleConfigChange('frustration_window_ms', secondsToMs(parseFloat(e.target.value)))}
                        className={FIELD_INPUT}
                        placeholder="30"
                        step="1"
                    />
                    <p className={FIELD_HELP}>Time window to check for rapid messages (30 seconds default).</p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Frustration Threshold (messages)</label>
                    <input
                        type="number"
                        value={config.frustration_threshold_messages || 3}
                        onChange={(e) => handleConfigChange('frustration_threshold_messages', parseInt(e.target.value))}
                        className={FIELD_INPUT}
                        placeholder="3"
                        step="1"
                        min="1"
                    />
                    <p className={FIELD_HELP}>Number of messages in window to trigger frustration flag (3 messages default).</p>
                </div>
            </div>

            {/* Connection & Reconnection */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <Wifi className="w-4 h-4 text-primary-500" />
                    Connection &amp; Reconnection
                </h3>
                <p className={SECTION_SUBTITLE}>
                    WebSocket retry behaviour and heartbeat cadence.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Max Reconnection Attempts</label>
                    <input
                        type="number"
                        value={config.max_reconnect_attempts || 15}
                        onChange={(e) => handleConfigChange('max_reconnect_attempts', parseInt(e.target.value))}
                        className={FIELD_INPUT}
                        placeholder="15"
                        step="1"
                        min="1"
                    />
                    <p className={FIELD_HELP}>Maximum number of reconnection attempts before giving up.</p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Max Reconnection Delay (seconds)</label>
                    <input
                        type="number"
                        value={msToSeconds(config.max_reconnect_delay_ms || 30000)}
                        onChange={(e) => handleConfigChange('max_reconnect_delay_ms', secondsToMs(parseFloat(e.target.value)))}
                        className={FIELD_INPUT}
                        placeholder="30"
                        step="1"
                    />
                    <p className={FIELD_HELP}>Maximum delay between reconnection attempts using exponential backoff (30 seconds default).</p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Heartbeat Interval — When Visible (seconds)</label>
                    <input
                        type="number"
                        value={msToSeconds(config.heartbeat_visible_ms || 25000)}
                        onChange={(e) => handleConfigChange('heartbeat_visible_ms', secondsToMs(parseFloat(e.target.value)))}
                        className={FIELD_INPUT}
                        placeholder="25"
                        step="1"
                    />
                    <p className={FIELD_HELP}>How often to ping server when widget is visible (25 seconds default).</p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Heartbeat Interval — When Hidden (seconds)</label>
                    <input
                        type="number"
                        value={msToSeconds(config.heartbeat_hidden_ms || 50000)}
                        onChange={(e) => handleConfigChange('heartbeat_hidden_ms', secondsToMs(parseFloat(e.target.value)))}
                        className={FIELD_INPUT}
                        placeholder="50"
                        step="1"
                    />
                    <p className={FIELD_HELP}>How often to ping server when widget is hidden (50 seconds default).</p>
                </div>
            </div>

            {/* Handoff Behavior */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <ArrowRightLeft className="w-4 h-4 text-primary-500" />
                    Handoff Behavior
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Fine-tuning for the bot-to-operator handoff form.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Auto-Submit Form Delay (milliseconds)</label>
                    <input
                        type="number"
                        value={config.handoff_auto_submit_delay_ms || 300}
                        onChange={(e) => handleConfigChange('handoff_auto_submit_delay_ms', parseInt(e.target.value))}
                        className={FIELD_INPUT}
                        placeholder="300"
                        step="50"
                        min="0"
                    />
                    <p className={FIELD_HELP}>Delay before auto-submitting handoff form if all fields are filled (300ms default).</p>
                </div>
            </div>

            <div className="bg-sky-50 dark:bg-sky-500/10 border border-sky-200 dark:border-sky-500/20 rounded-lg p-4">
                <p className="text-sm text-sky-800 dark:text-sky-300">
                    💡 <strong>Note:</strong> These are advanced settings. Click <strong>Save Configuration</strong> to apply your changes.
                </p>
            </div>
        </div>
    );
};

export default AdvancedSettingsTab;
