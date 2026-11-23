import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';
import { getSnapshot } from '../store/appStore';

describe('Waiting on you dismiss and undo', () => {
  it('dismissing removes the card, keeps only kind and id in the Dismissed row, updates the sidebar count, and Undo restores it', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/waiting']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('sidebar-waiting-count')).toHaveTextContent('3');

    const junoCard = screen.getByRole('article', {
      name: 'Which version number for this release?',
    });
    await user.click(within(junoCard).getByRole('button', { name: 'Dismiss' }));

    expect(
      screen.queryByRole('article', {
        name: 'Which version number for this release?',
      }),
    ).not.toBeInTheDocument();

    const dismissedRow = screen.getByTestId('dismissed-row-wait-juno-version');
    expect(dismissedRow).toHaveAttribute('data-dismissed-kind', 'choice');
    expect(dismissedRow).toHaveTextContent('Dismissed');
    expect(dismissedRow).not.toHaveTextContent(
      'Which version number for this release?',
    );
    expect(screen.getByTestId('sidebar-waiting-count')).toHaveTextContent('2');

    const storedItem = getSnapshot().waitingItems.find(
      (item) => item.id === 'wait-juno-version',
    );
    expect(storedItem).toEqual({
      id: 'wait-juno-version',
      kind: 'choice',
      status: 'dismissed',
    });

    await user.click(within(dismissedRow).getByRole('button', { name: 'Undo' }));

    expect(
      screen.getByRole('article', {
        name: 'Which version number for this release?',
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-waiting-count')).toHaveTextContent('3');
  });
});
