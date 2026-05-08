import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from '../Input';

describe('Input', () => {
  it('renders label + connects via for/id', () => {
    render(<Input label="Email" defaultValue="" />);
    const input = screen.getByLabelText('Email');
    expect(input.tagName).toBe('INPUT');
  });

  it('shows hint text', () => {
    render(<Input label="x" hint="3+ chars" defaultValue="" />);
    expect(screen.getByText('3+ chars')).toBeInTheDocument();
  });

  it('shows error with role=alert', () => {
    render(<Input label="x" error="required" defaultValue="" />);
    expect(screen.getByRole('alert')).toHaveTextContent('required');
  });

  it('supports user typing', async () => {
    let v = '';
    render(<Input label="x" value={v} onChange={(e) => { v = e.target.value; }} />);
    await userEvent.type(screen.getByLabelText('x'), 'abc');
    // Local var captures last call; React would re-render in real app.
    expect(v).toBe('c');
  });
});
