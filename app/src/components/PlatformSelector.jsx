import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import PlatformIcon from './icons/PlatformIcons';
import { categoryLabels, categoryOrder } from '../data/platformIntegrations';
import { cn } from '../lib/utils';

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
      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search platforms..."
          className="w-full h-9 pl-9 pr-3 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-surface-900 dark:text-white text-xs focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400 outline-none transition-all placeholder:text-surface-400 dark:placeholder:text-surface-500"
        />
      </div>

      {grouped.length === 0 ? (
        <p className="text-xs text-surface-400 text-center py-4">
          No platforms match &ldquo;{search}&rdquo;
        </p>
      ) : (
        grouped.map(({ category, label, items }) => (
          <div key={category}>
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-surface-400 dark:text-surface-500 mb-2">
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
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-all',
                      isActive
                        ? 'border-primary-300 dark:border-primary-600 bg-primary-50 dark:bg-primary-500/10 ring-1 ring-primary-200/50 dark:ring-primary-500/30'
                        : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 hover:border-surface-300 dark:hover:border-surface-600 hover:bg-surface-50 dark:hover:bg-surface-700'
                    )}
                  >
                    <div className="w-8 h-8 rounded-lg bg-surface-100 dark:bg-surface-700 flex items-center justify-center flex-shrink-0">
                      <PlatformIcon id={platform.id} size={20} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-surface-900 dark:text-white truncate">
                        {platform.name}
                      </p>
                      <p className="text-[10px] text-surface-400 truncate">
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
