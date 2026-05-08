import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../Button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire when disabled', async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>X</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders aria-busy when loading', () => {
    render(<Button loading>X</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('does not fire onClick when loading', async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>X</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies variant + size classes', () => {
    const { rerender } = render(<Button variant="danger" size="lg">X</Button>);
    const b = screen.getByRole('button');
    expect(b.className).toMatch(/v_danger/);
    expect(b.className).toMatch(/s_lg/);
    rerender(<Button variant="ghost" size="sm">X</Button>);
    expect(screen.getByRole('button').className).toMatch(/v_ghost/);
    expect(screen.getByRole('button').className).toMatch(/s_sm/);
  });
});
