import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';

describe('Composer slash menu keyboard navigation', () => {
  it('opens on /, moves active option with arrow keys, and closes on Escape', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/channels/launch']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    const input = screen.getByRole('combobox', { name: 'Message # launch' });
    await user.click(input);
    await user.type(input, '/');

    const listbox = screen.getByRole('listbox', { name: 'Slash commands' });
    expect(listbox).toBeInTheDocument();

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(4);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowUp}');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('listbox', { name: 'Slash commands' }),
    ).not.toBeInTheDocument();
  });
});
