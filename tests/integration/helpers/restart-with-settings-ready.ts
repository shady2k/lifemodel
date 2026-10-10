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
  const vault = /"msg":"Agent Vault is up:/;
  const vaultBefore = adapter.logCount(vault);
  adapter.restart();
  adapter.refreshPort();
  await adapter.waitForLogLines(vault, vaultBefore + 1, 60_000);
  await adapter.waitForLogLines(settings, settingsBefore + 1, 120_000);
}
