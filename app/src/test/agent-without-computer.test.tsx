import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';

describe('Agent without a computer', () => {
  it('renders in the workspace group with no computer line or harness tag and shows session status rows', () => {
    render(
      <MemoryRouter initialEntries={['/agents/triage']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    const workspaceGroup = screen.getByRole('group', { name: 'Northwind' });
    expect(workspaceGroup).toBeInTheDocument();

    const triageLink = within(workspaceGroup).getByRole('link', {
      name: /Triage/,
    });
    expect(triageLink).toBeInTheDocument();
    expect(triageLink).not.toHaveTextContent(/claude|codex|agy|grok/i);
    expect(workspaceGroup.querySelector('.bg-working')).toBeNull();
    expect(workspaceGroup.querySelector('.bg-offline')).toBeNull();

    expect(screen.queryByTestId('session-header-meta')).not.toBeInTheDocument();

    const statusRow = screen.getByTestId('session-status-evt-triage-2');
    expect(statusRow).toHaveTextContent(
      'Turn interrupted · Runner reconnected before reply completed',
    );
  });
});
