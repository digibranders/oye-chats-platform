import { motion } from 'framer-motion';
import { Bot, Plus, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from './Button';

export default function EmptyState({
  // eslint-disable-next-line no-unused-vars
  icon: Icon = Bot,
  title = 'Nothing here yet',
  description = 'Get started by creating your first chatbot.',
  actionLabel,
  actionTo,
  onAction,
  compact = false,
}) {
  const navigate = useNavigate();

  const handleAction = () => {
    if (onAction) return onAction();
    if (actionTo) navigate(actionTo);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className={`flex flex-col items-center justify-center text-center ${compact ? 'py-10' : 'py-20'}`}
    >
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        className={`${compact ? 'w-16 h-16' : 'w-20 h-20'} rounded-2xl bg-gradient-to-br from-primary-100 to-primary-50 dark:from-primary-900/30 dark:to-primary-800/20 flex items-center justify-center mb-6 relative`}
      >
        <div className="absolute inset-0 rounded-2xl bg-primary-500/5 animate-pulse-soft" />
        <Icon size={compact ? 26 : 34} className="text-primary-500 dark:text-primary-400 relative z-10" />
      </motion.div>

      <motion.h3
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.2 }}
        className={`${compact ? 'text-lg' : 'text-xl'} font-semibold text-surface-900 dark:text-surface-50 mb-2`}
      >
        {title}
      </motion.h3>

      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.3 }}
        className="text-surface-500 dark:text-surface-400 max-w-sm mb-8 leading-relaxed text-sm"
      >
        {description}
      </motion.p>

      {(actionLabel && (actionTo || onAction)) && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.4 }}
        >
          <Button onClick={handleAction} size="lg">
            <Plus size={16} />
            {actionLabel}
            <ArrowRight size={14} />
          </Button>
        </motion.div>
      )}
    </motion.div>
  );
}
