interface RestartAdapter {
  logCount(pattern: RegExp): number;
  waitForLogLines(
    pattern: RegExp,
    count: number,
    timeoutMs: number
  ): Promise<string[]>;
  restart(): void;
  refreshPort(): void;
}

/** Appended logs must establish settings readiness for the new run. */
export async function restartWithSettingsReady(adapter: RestartAdapter): Promise<void> {
  const settings = /settings interface is up/;
  // Capture before restart: the new listener may start during the command.
  const settingsBefore = adapter.logCount(settings);
  adapter.restart();
  adapter.refreshPort();
  await adapter.waitForLogLines(/"msg":"Agent Vault is up:/, 2, 60_000);
  await adapter.waitForLogLines(settings, settingsBefore + 1, 120_000);
}
