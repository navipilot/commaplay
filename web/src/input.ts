import type { ClientMessage, KnobState, TouchContact } from './protocol';

const MAX_CONTACTS = 2;
const KNOB_FLICK = 127;

interface ActivePointer {
  slot: number;
  x: number;
  y: number;
  down: boolean;
  sentX: number;
  sentY: number;
}

const emptyKnob = (overrides: Partial<KnobState> = {}): KnobState => ({
  select: false,
  home: false,
  back: false,
  x: 0,
  y: 0,
  wheel: 0,
  ...overrides,
});

/** Maps browser pointer/keyboard input to CarPlay touch and knob HID messages. */
export class InputController {
  private readonly pointers = new Map<number, ActivePointer>();
  private pendingFlush = 0;

  constructor(
    private readonly surface: HTMLElement,
    private readonly send: (message: ClientMessage) => void,
  ) {}

  attach(): void {
    const surface = this.surface;
    surface.style.touchAction = 'none';
    surface.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    surface.addEventListener('pointermove', this.onPointerMove, { passive: false });
    surface.addEventListener('pointerup', this.onPointerUp, { passive: false });
    surface.addEventListener('pointercancel', this.onPointerUp, { passive: false });
    surface.addEventListener('lostpointercapture', this.onLostCapture);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('blur', this.release);
    window.addEventListener('pagehide', this.release);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
  }

  detach(): void {
    const surface = this.surface;
    surface.removeEventListener('pointerdown', this.onPointerDown);
    surface.removeEventListener('pointermove', this.onPointerMove);
    surface.removeEventListener('pointerup', this.onPointerUp);
    surface.removeEventListener('pointercancel', this.onPointerUp);
    surface.removeEventListener('lostpointercapture', this.onLostCapture);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('blur', this.release);
    window.removeEventListener('pagehide', this.release);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.release();
  }

  reset(): void {
    this.release();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.surface.inert || this.pointers.has(event.pointerId)) return;
    event.preventDefault();
    if (this.pointers.size >= MAX_CONTACTS) return;
    this.surface.focus({ preventScroll: true });
    this.surface.setPointerCapture(event.pointerId);
    const x = this.normalizeX(event.clientX);
    const y = this.normalizeY(event.clientY);
    this.pointers.set(event.pointerId, {
      slot: this.nextSlot(),
      x, y, sentX: x, sentY: y,
      down: true,
    });
    this.flushTouches();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    pointer.x = this.normalizeX(event.clientX);
    pointer.y = this.normalizeY(event.clientY);
    this.scheduleFlush();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    const rect = this.surface.getBoundingClientRect();
    if (event.type === 'pointerup' && event.clientX >= rect.left && event.clientX <= rect.left + rect.width &&
        event.clientY >= rect.top && event.clientY <= rect.top + rect.height) {
      pointer.x = this.normalizeX(event.clientX);
      pointer.y = this.normalizeY(event.clientY);
    }
    // Preserve a queued swipe endpoint before releasing, even if video starves animation frames.
    if (pointer.x !== pointer.sentX || pointer.y !== pointer.sentY) this.flushTouches();
    pointer.down = false;
    this.flushTouches();
    this.pointers.delete(event.pointerId);
  };

  private readonly onLostCapture = (event: PointerEvent): void => {
    // Some car browsers lose capture mid-swipe; release only when the button is no longer held.
    if (event.buttons === 0) this.onPointerUp(event);
  };

  private readonly release = (): void => {
    if (!this.pointers.size) return;
    for (const pointer of this.pointers.values()) pointer.down = false;
    this.flushTouches();
    this.pointers.clear();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.surface.inert || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.target instanceof Element && (event.target.closest('input, select, textarea, [contenteditable="true"]') || ((event.key === 'Enter' || event.key === ' ') && event.target.closest('button, a')))) return;
    const knob = (overrides: Partial<KnobState>) => {
      event.preventDefault();
      this.send({ type: 'knob', knob: emptyKnob(overrides) });
    };
    switch (event.key) {
      case 'ArrowUp':
        knob({ y: -KNOB_FLICK });
        break;
      case 'ArrowDown':
        knob({ y: KNOB_FLICK });
        break;
      case 'ArrowLeft':
        knob({ x: -KNOB_FLICK });
        break;
      case 'ArrowRight':
        knob({ x: KNOB_FLICK });
        break;
      case 'Enter':
        knob({ select: true });
        break;
      case 'Escape':
      case 'Backspace':
        knob({ back: true });
        break;
      case 'Home':
        knob({ home: true });
        break;
      case 's':
        event.preventDefault();
        this.send({ type: 'siri' });
        break;
      case ' ':
        event.preventDefault();
        this.send({ type: 'media', media: 3 });
        break;
      case 'MediaPlayPause':
        event.preventDefault();
        this.send({ type: 'media', media: 3 });
        break;
      case 'MediaTrackNext':
        event.preventDefault();
        this.send({ type: 'media', media: 4 });
        break;
      case 'MediaTrackPrevious':
        event.preventDefault();
        this.send({ type: 'media', media: 5 });
        break;
      default:
        break;
    }
  };

  private nextSlot(): number {
    const used = new Set(Array.from(this.pointers.values(), (pointer) => pointer.slot));
    for (let slot = 0; slot < MAX_CONTACTS; slot += 1) {
      if (!used.has(slot)) return slot;
    }
    return 0;
  }

  private scheduleFlush(): void {
    if (this.pendingFlush !== 0) return;
    this.pendingFlush = window.requestAnimationFrame(() => {
      this.pendingFlush = 0;
      this.flushTouches();
    });
  }

  private flushTouches(): void {
    if (this.pendingFlush) {
      window.cancelAnimationFrame(this.pendingFlush);
      this.pendingFlush = 0;
    }
    const contacts: TouchContact[] = Array.from(this.pointers.values()).map((pointer) => ({
      id: pointer.slot,
      x: pointer.x,
      y: pointer.y,
      down: pointer.down,
    }));
    this.send({ type: 'touch', contacts });
    for (const pointer of this.pointers.values()) {
      pointer.sentX = pointer.x;
      pointer.sentY = pointer.y;
    }
  }

  private normalizeX(clientX: number): number {
    const rect = this.surface.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  }

  private normalizeY(clientY: number): number {
    const rect = this.surface.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    return clamp01((clientY - rect.top) / rect.height);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
