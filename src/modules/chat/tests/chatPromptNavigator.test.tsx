import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import ChatPromptNavigator from '@/modules/chat/transcript/ChatPromptNavigator';
import type { PromptNavigatorItem } from '@/modules/chat/transcript/ChatPromptNavigator';

/**
 * GOLDJAXE fork (реестр §17). A mouse aims at one bar; a finger cannot hit a
 * 10px bar, so a tap opens the prompts as a readable list. Which one a click
 * is comes from the pointer that started it.
 */

// jsdom has no PointerEvent, and without one `pointerType` never reaches the handler.
beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventStub extends MouseEvent {
      pointerType: string;

      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? '';
      }
    }
    window.PointerEvent = PointerEventStub as unknown as typeof PointerEvent;
  }
});

const items: PromptNavigatorItem[] = [
  { key: 'a', text: 'what can you do', attachmentCount: 0 },
  { key: 'b', text: 'write a short note', attachmentCount: 0 },
  { key: 'c', text: '', attachmentCount: 2 },
];

function renderNavigator(overrides: Partial<Parameters<typeof ChatPromptNavigator>[0]> = {}) {
  const props = {
    items,
    activeIndex: 1,
    canStepBack: true,
    canStepForward: true,
    isBusy: false,
    placement: { right: 4, top: 0, bottom: 0 },
    onSelect: vi.fn(),
    onStep: vi.fn(),
    onWheelTranscript: vi.fn(),
    ...overrides,
  };
  render(<ChatPromptNavigator {...props} />);
  return props;
}

describe('ChatPromptNavigator', () => {
  it('draws nothing for a single prompt', () => {
    const { container } = render(
      <ChatPromptNavigator
        items={items.slice(0, 1)}
        activeIndex={0}
        canStepBack={false}
        canStepForward={false}
        isBusy={false}
        placement={{ right: 4, top: 0, bottom: 0 }}
        onSelect={vi.fn()}
        onStep={vi.fn()}
        onWheelTranscript={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('a mouse click on a bar jumps to its prompt; the current one is marked', () => {
    const props = renderNavigator();
    const bar = screen.getByRole('button', { name: 'write a short note' });

    expect(bar.getAttribute('aria-current')).toBe('location');
    fireEvent.pointerDown(bar, { pointerType: 'mouse' });
    fireEvent.click(bar);

    expect(props.onSelect).toHaveBeenCalledWith(1);
  });

  it('hovering a bar names its prompt', () => {
    renderNavigator();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'what can you do' }));

    expect(screen.getByRole('tooltip').textContent).toBe('what can you do');
  });

  it('a tap opens the list instead, and a row in it jumps and closes it', () => {
    const props = renderNavigator();
    const bar = screen.getByRole('button', { name: 'what can you do' });

    fireEvent.pointerDown(bar, { pointerType: 'touch' });
    fireEvent.click(bar);
    expect(props.onSelect).not.toHaveBeenCalled();

    const list = screen.getByRole('dialog');
    const rows = list.querySelectorAll('button');
    expect(rows).toHaveLength(3);
    fireEvent.click(rows[2]);

    expect(props.onSelect).toHaveBeenCalledWith(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the chevrons step, and are disabled at the ends', () => {
    const props = renderNavigator({ canStepForward: false });

    fireEvent.click(screen.getByRole('button', { name: 'Previous prompt' }));
    expect(props.onStep).toHaveBeenCalledWith(-1);
    expect((screen.getByRole('button', { name: 'Next prompt' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a wheel over the column scrolls the transcript beneath it', () => {
    const props = renderNavigator();
    fireEvent.wheel(screen.getByRole('navigation'), { deltaY: 120, deltaMode: 0 });

    expect(props.onWheelTranscript).toHaveBeenCalledWith(120);
  });
});
