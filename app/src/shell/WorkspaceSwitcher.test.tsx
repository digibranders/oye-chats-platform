import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { pickOption } from '../test/select';
import { toast } from '../ui';
import type { Workspace } from '../types/domain';

/**
 * The control that went missing in the rebuild.
 *
 * The old shell's switcher was the only way into a workspace someone had been
 * invited to, and the redesign dropped it with the menu it lived in. These
 * cases pin the two halves of the decision that brought it back: it is absent
 * for the solo account the removal was argued for, and present, complete and
 * actually wired for the accounts that have somewhere to switch to.
 */

const switchWorkspace = vi.fn<(id: number, opts?: unknown) => Promise<Workspace | null>>();
let workspaces: Workspace[] = [];
let currentWorkspaceId: number | null = null;

vi.mock('../context/WorkspaceContext', () => ({
  useWorkspace: () => ({
    workspaces,
    currentWorkspaceId,
    hasMultipleWorkspaces: workspaces.length > 1,
    switchWorkspace,
  }),
}));

const OWN: Workspace = { id: 1, name: 'Priya Sharma', role: 'owner' };
const LINKED: Workspace = { id: 2, name: 'Acme Corp', role: 'operator', operator_role: 'admin' };
const SEAT: Workspace = { id: 3, name: 'Globex', role: 'operator', operator_role: 'operator' };

function renderSwitcher() {
  return render(
    <MemoryRouter>
      <WorkspaceSwitcher />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  switchWorkspace.mockReset();
  switchWorkspace.mockResolvedValue(OWN);
  workspaces = [OWN, LINKED];
  currentWorkspaceId = 1;
});

describe('the workspace switcher', () => {
  it('stays out of the chrome when there is nothing to switch between', () => {
    // The whole argument for removing the old menu: on a solo account the
    // workspace name is the person's own name, already printed in the account
    // menu below. That case must still see no second statement of it.
    workspaces = [OWN];
    const { container } = renderSwitcher();
    expect(container).toBeEmptyDOMElement();
  });

  it('appears as soon as there is a choice', () => {
    renderSwitcher();
    expect(screen.getByRole('combobox', { name: 'Switch workspace' })).toBeInTheDocument();
  });

  it('names the seat held in each workspace, not only the workspace', async () => {
    // Which workspace is yours and which you were invited into changes what
    // you can do there, and it must not be carried by the glyph alone.
    workspaces = [OWN, LINKED, SEAT];
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('combobox', { name: 'Switch workspace' }));

    expect(await screen.findByRole('option', { name: /Priya Sharma.*Owner/s })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Acme Corp.*Admin/s })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Globex.*Operator/s })).toBeInTheDocument();
  });

  it('switches to the workspace that was chosen', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await pickOption(user, screen.getByRole('combobox', { name: 'Switch workspace' }), /Acme Corp/);

    expect(switchWorkspace).toHaveBeenCalledTimes(1);
    // The id as a number, not the option's string value: `switchWorkspace`
    // looks the workspace up by identity and would find nothing for '2'.
    expect(switchWorkspace.mock.calls[0]?.[0]).toBe(2);
  });

  it('does not re-enter the workspace it is already in', async () => {
    // A no-op switch is not free: it aborts every in-flight scoped request and
    // navigates, so choosing the current workspace has to stop here.
    const user = userEvent.setup();
    renderSwitcher();

    await pickOption(user, screen.getByRole('combobox', { name: 'Switch workspace' }), /Priya Sharma/);

    expect(switchWorkspace).not.toHaveBeenCalled();
  });

  it('says so when the switch fails, rather than looking like it worked', async () => {
    // The context leaves the current workspace in place when it throws, so a
    // silent rejection would leave someone reading one workspace's data while
    // believing they had moved to another.
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    switchWorkspace.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderSwitcher();

    await pickOption(user, screen.getByRole('combobox', { name: 'Switch workspace' }), /Acme Corp/);

    expect(error).toHaveBeenCalledWith('Could not switch workspace');
    error.mockRestore();
  });
});
