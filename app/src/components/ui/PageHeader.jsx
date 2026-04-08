import { motion } from 'framer-motion';

export default function PageHeader({ title, subtitle, children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col sm:flex-row sm:items-end justify-between gap-4"
    >
      <div>
        <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-50 tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-surface-500 dark:text-surface-400 mt-1 text-sm">
            {subtitle}
          </p>
        )}
      </div>
      {children && (
        <div className="flex items-center gap-3 shrink-0">
          {children}
        </div>
      )}
    </motion.div>
  );
}
