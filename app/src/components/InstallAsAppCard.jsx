import { useState } from 'react';
import { Loader2, Check, Download, MonitorSmartphone } from 'lucide-react';
import { useToast } from '../context/ToastContext';
import useInstallPrompt from '../hooks/useInstallPrompt';
import InstallInstructionsModal from './InstallInstructionsModal';

/**
 * InstallAsAppCard - permanent "Install as app" affordance for Settings.
 *
 * Complements the floating InstallBanner (which only shows on /support and
 * to operators). Rendering it inside a Settings tab means someone who
 * dismissed the banner - or who never triggered its audience filter - still
 * has an obvious, always-on path to install the PWA.
 *
 * A single "Install OyeChats" CTA is shown at all times (unless the app is
 * already installed). Click behaviour depends on browser capability:
 *
 *   Condition                            | Click action
 *   ─────────────────────────────────────┼──────────────────────────────────
 *   ``beforeinstallprompt`` captured     | Fire the native install prompt
 *   iOS Safari                           | Open the iOS Add-to-Home-Screen modal
 *   Otherwise                            | Open the desktop browser-menu modal
 *
 * We never show a bare "here are the manual steps" hint block - every state
 * gets an actual button the user can press.
 */
export default function InstallAsAppCard() {
    const { canInstall, isInstalled, isIOS, install } = useInstallPrompt();
    const { showToast } = useToast();
    const [installing, setInstalling] = useState(false);
    const [modalMode, setModalMode] = useState(null);

    const handleClick = async () => {
        if (canInstall) {
            setInstalling(true);
            try {
                const { outcome } = await install();
                if (outcome === 'accepted') {
                    showToast('success', 'OyeChats installed. Look for the app icon on your device.');
                } else if (outcome === 'dismissed') {
                    showToast('info', 'Install dismissed - you can try again anytime.');
                } else {
                    // Rare: browser was ready when we rendered but the event
                    // had already been consumed by the time the click fired.
                    // Fall back to the how-to modal so the CTA still leads
                    // the user somewhere useful.
                    setModalMode(isIOS ? 'ios' : 'desktop');
                }
            } finally {
                setInstalling(false);
            }
            return;
        }
        setModalMode(isIOS ? 'ios' : 'desktop');
    };

    return (
        <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
            <div className="flex items-start justify-between gap-4 mb-1">
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <MonitorSmartphone size={16} className="text-primary-600 dark:text-primary-400" />
                    Install as app
                </h2>
            </div>
            <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">
                Add OyeChats to your dock or home screen so incoming chats reach you even when the browser is closed.
            </p>

            {isInstalled ? (
                <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                    <Check size={15} />
                    You&apos;re running OyeChats as an installed app on this device.
                </div>
            ) : (
                <button
                    type="button"
                    onClick={handleClick}
                    disabled={installing}
                    className="inline-flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {installing ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                    {installing ? 'Installing…' : 'Install OyeChats'}
                </button>
            )}

            <InstallInstructionsModal
                open={modalMode !== null}
                mode={modalMode || 'desktop'}
                onClose={() => setModalMode(null)}
            />
        </div>
    );
}
