// Waits that double from base up to max, each shaken by ±jitter so that
// many browsers do not come back at the same moment (spec §3 #126, #131).
export class Backoff {
  private tries = 0

  constructor(
    private readonly base = 500,
    private readonly max = 10_000,
    private readonly jitter = 0.2,
    private readonly random: () => number = Math.random,
  ) {}

  /** The wait before the next try, in ms. */
  next(): number {
    const d = Math.min(this.max, this.base * 2 ** Math.min(this.tries, 20))
    this.tries++
    return Math.round(d * (1 + this.jitter * (2 * this.random() - 1)))
  }

  reset(): void {
    this.tries = 0
  }
}
