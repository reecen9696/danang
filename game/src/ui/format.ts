/**
 * Kills, wave clears and bonuses all pay out in the same currency the merchants
 * price in, so it is written as money everywhere it appears — the HUD corner,
 * the stall header and every price tag.
 */
export function money(amount: number): string {
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
