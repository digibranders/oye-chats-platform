import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardSection,
  ConfirmDialog,
  LockedState,
  Skeleton,
  Switch,
  toast,
} from '../../../ui';
import { getBot, updateBot } from '../../../services/api';
import { keys } from '../../../query/keys';
import type { Bot } from '../../../types/domain';

export interface FollowUpSectionProps {
  agentId: number;
}

/**
 * The manual lead follow-up kill switch — `Bot.followup_sending_paused`.
 *
 * `POST /leads/{id}/follow-up` refuses with a 423 while this is true, with no
 * override of any kind (`lead_routes.send_manual_follow_up`, Gate 4). It is the
 * one control in the product that stops an outbound email to a visitor, so it
 * gets three things the rest of this page does not need.
 *
 * It is **immediate**, not part of the page's draft. A kill switch that only
 * takes effect after a separate Save is a kill switch somebody will believe
 * they have already pulled.
 *
 * It **confirms in the pausing direction only**. Pausing silently stops
 * something the team may be relying on, and silence is the failure mode a
 * confirmation exists to prevent; un-pausing merely allows a send that is
 * itself confirmed, one address at a time, on the Leads page.
 *
 * And it is **never optimistic**. The switch renders the server's value. A
 * rejected write leaves it exactly where it was, with the reason beside it,
 * because a switch that flips and then quietly flips back is indistinguishable
 * from one that worked.
 */
export function FollowUpSection({ agentId }: FollowUpSectionProps) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const bot = useQuery<Bot>({
    queryKey: keys.agents.detail(agentId),
    queryFn: () => getBot(agentId) as Promise<Bot>,
    staleTime: 30_000,
    retry: false,
  });

  const save = useMutation({
    mutationFn: async (paused: boolean) => {
      await updateBot(agentId, { followup_sending_paused: paused });
      return paused;
    },
    onSuccess: (paused) => {
      // Re-read rather than patch the cache: this record is shared with Deploy
      // and the agent header, and a hand-patched field is how one surface ends
      // up disagreeing with another about the same row.
      void queryClient.invalidateQueries({ queryKey: keys.agents.detail(agentId) });
      toast.success(paused ? 'Follow-up emails paused' : 'Follow-up emails can be sent again');
    },
  });

  const paused = bot.data?.followup_sending_paused === true;
  // A 403/404 is a statement about whose chatbot this is, not a failure to
  // load one — retrying it forever is the wrong offer.
  const forbidden = [403, 404].includes(
    (bot.error as { status?: number } | null)?.status ?? 0,
  );

  async function pause(): Promise<void> {
    await save.mutateAsync(true);
    setConfirming(false);
  }

  return (
    <Card>
      <CardHeader
        title="Lead follow-up emails"
        titleAs="h2"
        description="Whether anyone on your team can send the manual follow-up email to a lead this chatbot captured."
      />
      <CardBody className="space-y-4">
        {bot.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-3 w-full max-w-md" />
          </div>
        ) : bot.isError && forbidden ? (
          <LockedState
            compact
            title="This chatbot is not yours to change"
            description="Follow-up sending can only be paused by somebody whose workspace owns this chatbot. Nothing here has been changed."
          />
        ) : bot.isError ? (
          <Alert
            tone="danger"
            title="We could not read this setting"
            action={
              <Button size="sm" variant="secondary" onClick={() => void bot.refetch()}>
                Try again
              </Button>
            }
          >
            {bot.error instanceof Error
              ? bot.error.message
              : 'Something went wrong while loading this chatbot.'}
          </Alert>
        ) : (
          <>
            <Switch
              label="Pause follow-up emails"
              description="While this is on, the Send a follow-up button on every lead from this chatbot is refused by the server. Nothing is queued and nothing is sent later."
              checked={paused}
              disabled={save.isPending}
              onCheckedChange={(next) => {
                if (next) setConfirming(true);
                else save.mutate(false);
              }}
            />

            {/* Only the un-pause failure lands here. A refused *pause* is
                already shown inside the confirmation that asked for it, and
                printing the same sentence twice makes a reader hunt for the
                second problem. `variables` is the direction of the write that
                failed. */}
            {save.isError && save.variables === false ? (
              <Alert tone="danger" live title="That did not go through">
                {save.error instanceof Error
                  ? save.error.message
                  : 'Something went wrong. The setting is unchanged.'}
              </Alert>
            ) : null}

            {paused ? (
              <Alert tone="warning" title="Follow-ups are paused">
                Anyone who tries to send one is told this chatbot is paused. Automatic sending does
                not exist in this product — every follow-up is a person pressing a button — so this
                only ever affects your own team.
              </Alert>
            ) : null}
          </>
        )}
      </CardBody>
      <CardSection className="bg-surface-sunken">
        <p className="text-xs leading-relaxed text-text-secondary">
          Separate from unsubscribes. An address that opted out is refused whatever this says, and
          that list is on the Leads page.
        </p>
      </CardSection>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Pause follow-up emails?"
        description={
          <>
            Nobody on your team will be able to send a follow-up to a lead from this chatbot until
            you turn it back on. Attempts are refused outright — no queue, no retry, nothing sent
            later. Leads keep arriving and everything else about the chatbot carries on.
          </>
        }
        confirmLabel="Pause follow-ups"
        onConfirm={pause}
      />
    </Card>
  );
}
