import { useMemo, useState } from 'react';
import { ExternalLink, Star } from 'lucide-react';
import {
  ABSENT,
  Avatar,
  Badge,
  Button,
  DefinitionList,
  ErrorState,
  Separator,
  Skeleton,
  Textarea,
  TagInput,
  cn,
  formatDateTime,
  formatNumber,
  formatRelative,
  toast,
} from '../../ui';
import { useLeadAnnotations } from '../leads/useLeadAnnotations';
import type { VisitorProfile } from './visitorProfile';

const BANT_LABEL: Record<keyof NonNullable<VisitorProfile['bant']>, string> = {
  budget: 'Budget',
  authority: 'Authority',
  need: 'Need',
  timeline: 'Timeline',
};

function Rating({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`Rated ${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((step) => (
        <Star
          key={step}
          aria-hidden
          className={cn('h-3.5 w-3.5', step <= value ? 'fill-warning text-warning' : 'text-border-strong')}
        />
      ))}
    </span>
  );
}

/**
 * Private notes and tags for this visitor.
 *
 * There is no server API for either, so they live in this browser under the
 * session id — the same store the Leads surface reads, which is what makes a
 * note written mid-conversation still there when the lead is followed up a week
 * later. It says so on screen rather than implying the team can see it.
 */
function PrivateNotes({ sessionId }: { sessionId: string }) {
  const store = useLeadAnnotations();
  const controller = store.controllerFor(sessionId);
  const [note, setNote] = useState(() => controller?.note?.text ?? '');
  const [tags, setTags] = useState<string[]>(() => [...(controller?.tags ?? [])]);

  if (!controller) return null;
  const dirty = note.trim() !== (controller.note?.text ?? '');

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-eyebrow text-text-tertiary">Private notes</h3>
        <span className="text-2xs text-text-tertiary">Only in this browser</span>
      </div>
      <Textarea
        rows={3}
        aria-label="Private note about this visitor"
        placeholder="Context for later — what they need, who to loop in…"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs text-text-tertiary">
          {controller.note ? `Edited ${formatRelative(controller.note.ts)}` : 'Not saved yet'}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty}
          onClick={() => {
            controller.saveNote(note);
            toast.success('Note saved');
          }}
        >
          Save note
        </Button>
      </div>
      <TagInput
        label="Tags"
        values={tags}
        onValuesChange={(next) => {
          setTags(next);
          controller.saveTags(next.join(', '));
        }}
        placeholder="Add a tag…"
      />
    </div>
  );
}

export interface VisitorPanelProps {
  profile: VisitorProfile | null;
  sessionId: string | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
}

/**
 * Who you are talking to.
 *
 * One pane rather than the four scattered places this used to live: the row, a
 * tooltip, a modal and a separate details tab. Everything here is read-only fact
 * about the visitor, so it never competes with the conversation's own actions —
 * those stay in the conversation header, where the thing they act on is.
 */
export function VisitorPanel({
  profile,
  sessionId,
  loading = false,
  error = null,
  onRetry,
  className,
}: VisitorPanelProps) {
  const identity = useMemo(
    () =>
      profile
        ? [
            { label: 'Email', value: profile.email ?? ABSENT },
            { label: 'Phone', value: profile.phone ?? ABSENT },
            { label: 'Company', value: profile.company ?? ABSENT },
            { label: 'Location', value: profile.location ?? ABSENT },
            { label: 'Device', value: profile.device ?? ABSENT },
          ]
        : [],
    [profile],
  );

  const context = useMemo(
    () =>
      profile
        ? [
            { label: 'Chatbot', value: profile.botName ?? ABSENT },
            { label: 'Department', value: profile.departmentName ?? ABSENT },
            { label: 'Assigned to', value: profile.operatorName ?? ABSENT },
            { label: 'Started', value: profile.startedAt ? formatDateTime(profile.startedAt) : ABSENT },
            { label: 'Last active', value: profile.lastActiveAt ? formatRelative(profile.lastActiveAt) : ABSENT },
            {
              label: 'Messages',
              value: profile.messageCount != null ? formatNumber(profile.messageCount) : ABSENT,
            },
          ]
        : [],
    [profile],
  );

  return (
    <aside
      aria-label="Visitor details"
      className={cn('flex h-full min-h-0 flex-col overflow-y-auto border-l border-border bg-surface', className)}
    >
      {loading && !profile ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-10 w-10 rounded-full" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ) : error && !profile ? (
        <ErrorState compact description={error} onRetry={onRetry} />
      ) : !profile ? (
        <p className="p-4 text-xs text-text-tertiary">Select a conversation to see who is on the other end.</p>
      ) : (
        <div className="space-y-5 p-4">
          <div className="flex items-center gap-3">
            <Avatar size="lg" name={profile.name} />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-text-primary">{profile.name}</p>
              {profile.email ? (
                <a
                  href={`mailto:${profile.email}`}
                  className="truncate text-xs text-accent-600 underline-offset-2 hover:underline"
                >
                  {profile.email}
                </a>
              ) : (
                <p className="text-xs text-text-tertiary">No contact details captured</p>
              )}
            </div>
          </div>

          {profile.rating != null ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-tertiary">Rated this chat</span>
              <Rating value={profile.rating} />
            </div>
          ) : null}

          {profile.handoffReason ? (
            <div className="rounded-md border-l-[3px] border-l-ink bg-surface-sunken px-3 py-2">
              <p className="text-2xs uppercase tracking-eyebrow text-text-tertiary">Why they wanted a person</p>
              <p className="mt-0.5 text-xs text-text-primary">{profile.handoffReason}</p>
            </div>
          ) : null}

          <DefinitionList items={identity} />

          {profile.pageUrl || profile.referrer ? (
            <>
              <Separator />
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-eyebrow text-text-tertiary">
                  Where they came from
                </h3>
                {profile.pageUrl ? (
                  <a
                    href={profile.pageUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center gap-1.5 break-all text-xs text-accent-600 underline-offset-2 hover:underline"
                  >
                    <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
                    {profile.pageUrl}
                  </a>
                ) : null}
                {profile.referrer ? (
                  <p className="break-all text-2xs text-text-secondary">Referred by {profile.referrer}</p>
                ) : null}
              </div>
            </>
          ) : null}

          <Separator />
          <DefinitionList items={context} />

          {profile.bant ? (
            <>
              <Separator />
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-eyebrow text-text-tertiary">
                  What the AI learned
                </h3>
                <div className="space-y-2">
                  {(Object.keys(BANT_LABEL) as Array<keyof typeof BANT_LABEL>).map((key) => {
                    const value = profile.bant?.[key];
                    return (
                      <div key={key} className="flex items-start gap-2">
                        <Badge tone={value ? 'success' : 'neutral'} className="mt-0.5 shrink-0">
                          {BANT_LABEL[key]}
                        </Badge>
                        <p className="min-w-0 flex-1 text-xs leading-relaxed text-text-secondary">
                          {value ?? 'Not established yet'}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : null}

          {sessionId ? (
            <>
              <Separator />
              <PrivateNotes key={sessionId} sessionId={sessionId} />
            </>
          ) : null}
        </div>
      )}
    </aside>
  );
}
