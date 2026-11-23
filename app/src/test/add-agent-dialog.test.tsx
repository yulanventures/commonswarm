import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';

describe('Add an agent dialog', () => {
  it('selects computer, harness, and mode and closes on Escape', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: '+ Add' }));

    const dialog = screen.getByRole('dialog', { name: 'Add an agent' });
    expect(dialog).toBeInTheDocument();

    const macbookButton = within(dialog).getByRole('button', {
      name: /Maya's MacBook/,
    });
    const codexButton = within(dialog).getByRole('button', { name: /Codex/ });
    const autonomousButton = within(dialog).getByRole('button', {
      name: 'Work on its own',
    });

    await user.click(macbookButton);
    await user.click(codexButton);
    await user.click(autonomousButton);

    expect(macbookButton).toHaveAttribute('aria-pressed', 'true');
    expect(codexButton).toHaveAttribute('aria-pressed', 'true');
    expect(autonomousButton).toHaveAttribute('aria-pressed', 'true');

    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('dialog', { name: 'Add an agent' }),
    ).not.toBeInTheDocument();
  });
});
