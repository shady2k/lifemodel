/**
 * The environment boundary between the container and lifemodel's user
 * (finding 6 residual, stage-3 finding D).
 *
 * The container's whole environment used to be SPREAD into lifemodel's
 * process (supervisor.ts) and into the instance build's (repo.ts), so a
 * container started with `-e OPENROUTER_API_KEY=...` - or one that inherited
 * `AGENT_VAULT_MASTER_PASSWORD` - handed the secret to uid 1000 even though
 * the model key is now injected by Agent Vault ON THE WAY OUT and the vault's
 * credentials are the loader's own. The stage's clause is "no key in
 * lifemodel's process", so the boundary is explicit: lifemodel's process gets
 * the variables the product's own code reads, BY NAME, and nothing else.
 *
 * Every name below is read somewhere in the product - the reading place is
 * named beside it. When the product starts reading another container
 * variable, THIS list is the one place to name it. The model-key and the
 * trusted/admin credential variables are stripped by name besides that, so a
 * name that ever joins the pass-through list cannot carry a secret through.
 */

/**
 * The container's variables lifemodel's process is given, when the container
 * was started with them. The proxy environment (built in
 * `lifemodelEnvironment()` in loader/src/agent-vault.ts) is appended over
 * these, so it always wins.
 */
const LIFEMODEL_ENVIRONMENT_VARIABLES: readonly string[] = [
  // The shell and tooling basics the runtime passes on to the children of its
  // own Motor Cortex (src/runtime/container/tool-server.ts INHERITED_KEYS is
  // the list the runtime itself inherits): docker, npm, pip and the shells.
  'PATH',
  'USER',
  'LANG',
  'TERM',
  'TZ',
  'NODE_VERSION',
  'NODE_PATH',
  'PYTHONPATH',
  'NPM_CONFIG_CACHE',
  'PIP_USER',
  'PYTHONUSERBASE',
  'PIP_CACHE_DIR',
  'PIP_BREAK_SYSTEM_PACKAGES',
  'XDG_CACHE_HOME',
  // The product's configuration inputs (src/config/config-loader.ts reads
  // these; the settings interface names the same set as the variables that
  // would override a save - src/settings/server.ts OVERRIDING_VARIABLES):
  'LOG_LEVEL',
  'PLUGINS_DIR',
  'PLUGINS_ENABLED',
  'PLUGINS_DISABLED',
  'LLM_ENDPOINT_BASE_URL',
  'LLM_ENDPOINT_FAST_MODEL',
  'LLM_ENDPOINT_SMART_MODEL',
  'LLM_ENDPOINT_MOTOR_MODEL',
  'PRIMARY_USER_CHAT_ID',
  'TELEGRAM_BOT_TOKEN',
  // The web-search providers' credentials and priority
  // (src/plugins/web-search/providers/).
  'SERPER_API_KEY',
  'TAVILY_API_KEY',
  'BRAVE_API_KEY',
  'SEARCH_PROVIDER_PRIORITY',
  // The log format (src/core/logger.ts): the image runs as "production",
  // a developer's run does not.
  'NODE_ENV',
];

/**
 * The variables that are NEVER handed to lifemodel's process, even if one of
 * the names above ever carried the same value: the model key (the provider no
 * longer reads one - Agent Vault injects it on the way out) and the trusted
 * layer's own admin credential.
 */
const SECRET_VARIABLES: readonly string[] = [
  'OPENROUTER_API_KEY',
  'AGENT_VAULT_MASTER_PASSWORD',
];

/** The one boundary: the container's named variables, then the proxy's. */
export function lifemodelEnvironment(
  container: NodeJS.ProcessEnv,
  proxy: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of LIFEMODEL_ENVIRONMENT_VARIABLES) {
    const value = container[name];
    if (value !== undefined) env[name] = value;
  }
  const built = { ...env, ...proxy };
  for (const name of SECRET_VARIABLES) delete built[name];
  return built;
}
