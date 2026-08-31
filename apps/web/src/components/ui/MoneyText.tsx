import { formatLKR } from "../../lib/money";
import { cn } from "../../lib/cn";

export type MoneyTone = "default" | "muted" | "positive" | "negative";

export interface MoneyTextProps {
  amountMinor: number;
  /**
   * Colour is opt-in, and never derived from the sign. A negative figure is bad
   * news on a balance and good news on a "vs last month" delta — only the call
   * site knows which, so only the call site colours it.
   */
  tone?: MoneyTone;
  /** Renders at the surrounding size but heavier — for totals rows. */
  strong?: boolean;
  className?: string;
}

const tones: Record<MoneyTone, string> = {
  default: "text-text",
  muted: "text-muted",
  positive: "text-success",
  negative: "text-danger",
};

/**
 * The only way money reaches the screen. Every amount is tabular so figures
 * line up digit-for-digit down a column, which is the entire reason a spend
 * table is scannable.
 */
export function MoneyText({
  amountMinor,
  tone = "default",
  strong = false,
  className,
}: MoneyTextProps) {
  return (
    <span
      className={cn(
        "tabular",
        tones[tone],
        strong && "font-semibold",
        className,
      )}
    >
      {formatLKR(amountMinor)}
    </span>
  );
}
