import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import PlatformIcon from './icons/PlatformIcons';
import { categoryLabels, categoryOrder } from '../data/platformIntegrations';

/**
 * Renders a responsive grid of platform cards grouped by category.
 * Includes a search input to filter platforms by name.
 *
 * @param {Object}   props
 * @param {Array}    props.platforms   - Full list of platform config objects
 * @param {string|null} props.selectedId - Currently selected platform id
 * @param {Function} props.onSelect    - Callback when a platform is clicked
 */
export default function PlatformSelector({ platforms, selectedId, onSelect }) {
    const [search, setSearch] = useState('');

    const filtered = useMemo(() => {
        if (!search.trim()) return platforms;
        const q = search.toLowerCase();
        return platforms.filter(
            (p) =>
                p.name.toLowerCase().includes(q) ||
                p.description.toLowerCase().includes(q),
        );
    }, [platforms, search]);

    /** Group filtered platforms by category in display order. */
    const grouped = useMemo(() => {
        const groups = [];
        for (const cat of categoryOrder) {
            const items = filtered.filter((p) => p.category === cat);
            if (items.length > 0) {
                groups.push({ category: cat, label: categoryLabels[cat], items });
            }
        }
        return groups;
    }, [filtered]);

    return (
        <div className="space-y-4">
            {/* Search */}
            <div className="relative">
                <Search
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary-400"
                />
                <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search platforms..."
                    className="w-full h-9 pl-9 pr-3 rounded-lg border border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-950 text-secondary-900 dark:text-white text-xs focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all"
                />
            </div>

            {/* Platform grid grouped by category */}
            {grouped.length === 0 ? (
                <p className="text-xs text-secondary-400 text-center py-4">
                    No platforms match &ldquo;{search}&rdquo;
                </p>
            ) : (
                grouped.map(({ category, label, items }) => (
                    <div key={category}>
                        <h4 className="text-[10px] font-bold uppercase tracking-wider text-secondary-400 mb-2">
                            {label}
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {items.map((platform) => {
                                const isActive = selectedId === platform.id;
                                return (
                                    <button
                                        key={platform.id}
                                        type="button"
                                        onClick={() => onSelect(platform.id)}
                                        className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-all ${
                                            isActive
                                                ? 'border-primary-300 dark:border-primary-700 bg-primary-50 dark:bg-primary-500/10 ring-1 ring-primary-200/50 dark:ring-primary-800/50'
                                                : 'border-secondary-200 dark:border-secondary-800 bg-white dark:bg-secondary-900 hover:border-secondary-300 dark:hover:border-secondary-700 hover:bg-secondary-50 dark:hover:bg-secondary-800'
                                        }`}
                                    >
                                        <div className="w-8 h-8 rounded-lg bg-secondary-100 dark:bg-secondary-800 flex items-center justify-center flex-shrink-0">
                                            <PlatformIcon
                                                id={platform.id}
                                                size={20}
                                            />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-xs font-semibold text-secondary-900 dark:text-white truncate">
                                                {platform.name}
                                            </p>
                                            <p className="text-[10px] text-secondary-400 truncate">
                                                {platform.description}
                                            </p>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))
            )}
        </div>
    );
}
