import { CurrencyProvider } from '../../context/CurrencyContext';
import { CrawlProvider } from '../../context/CrawlContext';
import { WorkspaceProvider } from '../../context/WorkspaceContext';
import { BotProvider } from '../../context/BotContext';

/**
 * The Build Studio is a full-screen route that lives OUTSIDE AdminLayout (no
 * sidebar/topbar), so it must re-declare the context providers its milestone
 * steps rely on:
 *   - CurrencyProvider — pricing on the Create milestone (paid bots)
 *   - CrawlProvider    — live crawl progress on the Train milestone
 *   - WorkspaceProvider — active workspace resolution
 *   - BotProvider      — the bot list + selected bot (reused across milestones)
 *
 * ToastProvider / ConfirmProvider / UpgradeModalProvider already wrap the whole
 * app in App.jsx, so they are available here without re-declaring.
 */
export default function StudioProviders({ children }) {
    return (
        <CurrencyProvider>
            <CrawlProvider>
                <WorkspaceProvider>
                    <BotProvider>{children}</BotProvider>
                </WorkspaceProvider>
            </CrawlProvider>
        </CurrencyProvider>
    );
}
