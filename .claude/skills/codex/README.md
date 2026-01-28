# Codex Skill

Get AI-powered code analysis, refactoring suggestions, and automated editing using OpenAI's Codex CLI.

## Usage

The skill is automatically activated when you:
- Explicitly ask to run Codex CLI commands
- Request code analysis, refactoring, or reviews
- Ask for a "second opinion" on code
- Say "codex resume" to continue a previous session

## Examples

### Basic Analysis
```
"Use Codex to review the authentication module for security issues"
```

### Multi-Scale Analysis
```
"Get a comprehensive Codex review of the payment integration with scale 5"
```

### Resume Previous Session
```
"Codex resume and check for edge cases"
```

### Code Refactoring
```
"Use Codex to refactor the user service to use dependency injection"
```

## Features

- **Model Selection**: Choose between `gpt-5-codex` and `gpt-5`
- **Reasoning Effort**: Configure `high`, `medium`, or `low` reasoning
- **Sandbox Modes**:
  - `read-only`: Safe analysis (default)
  - `workspace-write`: Apply edits locally
  - `danger-full-access`: Full system access
- **Scale Support**: Run multiple parallel analyses (1-5+)
- **Session Resume**: Continue previous Codex sessions with new prompts

## Safety

- Defaults to read-only mode
- Asks permission before making edits
- Suppresses thinking tokens by default (cleaner output)
- Always uses `--skip-git-repo-check` for flexibility

## Requirements

- Codex CLI must be installed and available in PATH
- OpenAI API key configured for Codex access

## Migration from Agent

This skill replaces the previous `/ask-codex` agent with:
- Better error handling
- More configuration options
- Session resume capability
- Clearer permission model
- Standardized output handling
