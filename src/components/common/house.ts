/**
 * The house's colours, and the two tiers within them.
 *
 * A colour on this screen carries two things at once, and they have to stay
 * distinguishable. The hue says whose book it is — Patrimonium blue, EBG green,
 * Una Terra amber — and the shade says which tier a figure belongs to: the
 * deeper one is what the investor holds, the lighter one what the portfolio is
 * worth. Somebody who has both open should be able to tell at a glance that
 * they are looking at two different questions about the same fund, without
 * reading a heading.
 *
 * The shades are mixed against the theme's own foreground and background rather
 * than against black and white. Deepening a colour with black is right in a
 * light theme and invisible in a dark one, and a palette that only works in one
 * of them is a palette that will be read wrong in the other. Mixed this way,
 * `net` moves toward the text and `gross` toward the surface whichever theme is
 * on — so the relationship holds and nothing disappears.
 */

export interface House {
  /** The house's own colour, as the book records it. */
  base: string;
  /** What the investor holds: the emphatic shade. */
  net: string;
  /** What the portfolio is worth: the receding one. */
  gross: string;
  /** A wash of the house colour, for a surface rather than a line. */
  wash: string;
}

/** The application's own accent, for a book that records no house colour. */
const DEFAULT_ACCENT = 'var(--series-1)';

export function houseOf(accent?: string): House {
  const base = accent ?? DEFAULT_ACCENT;
  return {
    base,
    net: `color-mix(in srgb, ${base} 86%, var(--text-primary))`,
    gross: `color-mix(in srgb, ${base} 42%, var(--surface-1))`,
    wash: `color-mix(in srgb, ${base} 8%, var(--surface-1))`,
  };
}

/** Which of the two tiers a page or a card is about. */
export type Tier = 'net' | 'gross';

export function tierColour(house: House, tier?: Tier): string | undefined {
  if (!tier) return undefined;
  return tier === 'net' ? house.net : house.gross;
}
