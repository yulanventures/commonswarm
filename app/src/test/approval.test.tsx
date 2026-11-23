import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../App';

describe('Agent session approval', () => {
  it('answering the approval settles the card and changes the session state pill to Working', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/agents/atlas']}>
        <AppRoutes />
      </MemoryRouter>,
    );

    const pill = screen.getByTestId('session-state-pill');
    expect(pill).toHaveTextContent('Waiting on you');

    await user.click(screen.getByRole('button', { name: 'Allow once' }));

    expect(
      screen.queryByRole('button', { name: 'Allow once' }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('approval-settled-badge')).toHaveTextContent(
      'Allowed once',
    );
    expect(screen.getByTestId('session-state-pill')).toHaveTextContent(
      'Working',
    );
  });
});
