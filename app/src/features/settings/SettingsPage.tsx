import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Card,
  CardBody,
  ErrorState,
  LoadingRows,
  Page,
  PageHeader,
  Stack,
  buttonClass,
} from '../../ui';
import { getCurrentUser } from '../../services/api';
import { keys } from '../../query/keys';
import type { CurrentUser } from '../../types/domain';
import { ProfileSection } from './ProfileSection';
import { ChangeEmailCard, ChangePasswordCard } from './AccountSecuritySection';
import { NotificationsSection } from './NotificationsSection';
import { AccountSessionsSection } from './AccountSessionsSection';
import { ContactSection } from './ContactSection';

/**
 * `/account` — your account, not the workspace's.
 *
 * These are two different objects and the console this replaces gave them the
 * same name: one page called Settings held your password, another called
 * Workspace ▸ General held the company's. For a team member the word "settings"
 * means this page and nothing else, which is why it is not inside `/settings`
 * and is reached from the account menu instead.
 *
 * There is no Appearance section. The console is light mode only, deliberately
 * (DESIGN.md §1: one theme done properly, and the reason every contrast ratio
 * in that document can be stated as a number). The section that used to be
 * here offered light / dark / system and a high-contrast switch against a token
 * layer that no longer has a dark scale — it would have rendered a control that
 * changed nothing, so it is deleted rather than shipped inert.
 */
export function SettingsPage() {
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    staleTime: 60_000,
  });

  // Held locally so the email-change flow can move the address on screen the
  // moment the server confirms it, without waiting for a refetch to land.
  const [patch, setPatch] = useState<Partial<CurrentUser>>({});
  const user: CurrentUser | null = me.data ? { ...me.data, ...patch } : null;

  function applyPatch(next: Partial<CurrentUser>): void {
    setPatch((current) => ({ ...current, ...next }));
    void queryClient.invalidateQueries({ queryKey: keys.session.me() });
  }

  const header = (
    <PageHeader
      title="Your account"
      description="Your name, how you sign in, and what we are allowed to interrupt you for."
    />
  );

  if (me.isPending) {
    return (
      <Page width="default">
        {header}
        <Card>
          <CardBody>
            <LoadingRows rows={4} />
          </CardBody>
        </Card>
      </Page>
    );
  }

  if (me.isError || !user) {
    return (
      <Page width="default">
        {header}
        <Card>
          <ErrorState
            title="We could not load your account"
            description={me.error instanceof Error ? me.error.message : undefined}
            onRetry={() => void me.refetch()}
          />
        </Card>
      </Page>
    );
  }

  const isOperator = user.kind === 'operator';

  return (
    <Page width="default">
      {header}
      <Stack>
        <ProfileSection user={user} onSaved={applyPatch} />

        {isOperator ? (
          <Card>
            <CardBody>
              <Alert tone="neutral" title="This is a team seat">
                You are a member of someone else's workspace. The chatbots, plan and billing belong
                to them — what you can change is on this page.
              </Alert>
            </CardBody>
          </Card>
        ) : (
          <ChangeEmailCard user={user} onEmailChange={applyPatch} />
        )}

        <ChangePasswordCard isOperator={isOperator} />

        <NotificationsSection />

        <AccountSessionsSection email={user.email ?? ''} />

        <ContactSection />

        {!isOperator ? (
          <Card>
            <CardBody>
              <Alert
                tone="neutral"
                action={
                  <Link to="/settings/workspace" className={buttonClass('secondary', 'sm')}>
                    Workspace settings
                  </Link>
                }
              >
                Looking for the company name, your team, integrations or the API key? Those belong
                to the workspace rather than to you.
              </Alert>
            </CardBody>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
