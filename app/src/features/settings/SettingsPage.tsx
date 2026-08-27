import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Card,
  CardBody,
  ErrorState,
  Grid,
  LoadingRows,
  Measure,
  Page,
  PageHeader,
  SettingGroup,
  SettingRow,
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
import { LanguageSection } from './LanguageSection';

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

  const header = <PageHeader title="Your account" />;

  if (me.isPending) {
    return (
      <Page>
        {header}
        <Measure width="form">
          <Card>
            <CardBody>
              <LoadingRows rows={4} />
            </CardBody>
          </Card>
        </Measure>
      </Page>
    );
  }

  if (me.isError || !user) {
    return (
      <Page>
        {header}
        <Measure width="form">
          <Card>
            <ErrorState
              title="We could not load your account"
              description={me.error instanceof Error ? me.error.message : undefined}
              onRetry={() => void me.refetch()}
            />
          </Card>
        </Measure>
      </Page>
    );
  }

  const isOperator = user.kind === 'operator';

  return (
    <Page>
      {header}
      {/* Two columns of groups, not one column of seven.
          Every group here is a form measure wide — a label, a 256px control and
          a hairline — so stacking all seven made `/account` the tallest page in
          the console at 1,773px (2.1 screenfuls) while leaving 500px of the
          content area empty down its entire right-hand side. That is a magazine
          column, not a settings page; Linear's account settings are a 2-up grid
          of exactly these groups.

          Two `Stack`s rather than seven grid children, because a grid row is as
          tall as its tallest cell: seven groups of very different heights laid
          out row-major would open a hole under every short one. Each column
          flows on its own and they meet at roughly the same bottom edge.

          The split is by subject, not by height: column one is who you are and
          how you get in — your name, your address, your password and the device
          holding the session — and column two is what the account does once you
          are in. It collapses to one column below `@3xl/page`, which is where
          two form measures stop fitting side by side. */}
      <Grid cols={2} gap="section" align="start">
        <Stack>
          <ProfileSection user={user} onSaved={applyPatch} />

          {isOperator ? (
            // A direct child of the `Stack`. Wrapped in a `Card` + `CardBody`
            // this was a `rounded-md` bordered box inside a `rounded-lg` one
            // with a 20px dead ring between them — the card-in-card DESIGN.md §4
            // bans.
            <Alert tone="neutral" title="This is a team seat">
              The workspace's chatbots, plan and billing belong to its owner.
            </Alert>
          ) : (
            <ChangeEmailCard user={user} onEmailChange={applyPatch} />
          )}

          <ChangePasswordCard isOperator={isOperator} />

          <AccountSessionsSection email={user.email ?? ''} />
        </Stack>

        <Stack>
          {/* Second column, at the top: it is the setting that changes every
              other word on this page, so it belongs where a reader looking for
              it would start. */}
          <LanguageSection />

          <NotificationsSection />

          <ContactSection />

          {!isOperator ? (
            <SettingGroup>
              <SettingRow label="Workspace settings" description="Company, team and the API key.">
                <Link to="/settings/workspace" className={buttonClass('secondary', 'sm')}>
                  Open
                </Link>
              </SettingRow>
            </SettingGroup>
          ) : null}
        </Stack>
      </Grid>
    </Page>
  );
}
