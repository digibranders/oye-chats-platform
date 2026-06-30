import Interface from './Interface';

/**
 * BotSettings — the per-bot editor shell.
 *
 * Introduced as a pass-through wrapper over the legacy `Interface` editor so
 * routing and navigation can switch to the new "Bot Settings" name first, then
 * the monolith is drained into focused tab components behind this entry point
 * (see docs/superpowers/plans/2026-06-30-bot-settings-editor.md). The build
 * stays green at every step because this component renders the same editor
 * until the extraction is complete.
 */
export default function BotSettings(props) {
    return <Interface {...props} />;
}
