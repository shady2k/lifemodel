/** Tracks store-writing work that must settle before durable stores close. */
export class DurableEffectRegistry {
  private readonly effects = new Map<Promise<void>, string>();

  track(name: string, effect: Promise<unknown>): void {
    const settled = effect.then(
      () => undefined,
      () => undefined
    );
    this.effects.set(settled, name);
    void settled.then(() => {
      this.effects.delete(settled);
    });
  }

  async drain(
    deadline: number,
    logger: { error(context: Record<string, unknown>, message: string): void }
  ): Promise<void> {
    while (this.effects.size > 0) {
      const pending = [...this.effects.keys()];
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        Promise.all(pending).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            resolve(false);
          }, remainingMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!completed) break;
    }
    for (const name of this.effects.values()) {
      logger.error({ effect: name }, 'Durable effect abandoned at stop deadline');
    }
  }
}
