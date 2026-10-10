# codex-harness-adapter

[简体中文](README.md) | **English**

## What it solves

**Control Claude Code, Pi, and other harnesses through the mature Codex desktop UI.** Manage projects, conversations, file changes, and approvals in one place while keeping each harness's own models and login.

Currently supports Claude Code and Pi on macOS, Linux, and Windows; DeepSeek Harness support is experimental ([details](docs/guide/configuration.md#deepseek-harness实验性)).

## Install and run

### macOS: Homebrew (background service)

Install and sign in to Claude Code or Pi (at least one). Claude needs the standalone `claude` CLI signed in (`claude auth status` reports logged in); Pi must be installed with npm (`npm install -g @earendil-works/pi-coding-agent`), and the adapter uses that install directly. Then:

```sh
brew install slovx2/tap/codex-harness-adapter
brew services start codex-harness-adapter
codex-harness-adapter ssh-config
```

The service starts at login and restarts if it exits unexpectedly. It uses Homebrew's `node@24`. Logs go to `$(brew --prefix)/var/log/codex-harness-adapter.log`; stop it with `brew services stop codex-harness-adapter`. Prebuilt packages are currently Apple Silicon only.

### Run from source

Install Node.js **24**, Go **≥ 1.26.6**, and at least one configured harness: [Claude Code **≥ 2.1.282**](https://code.claude.com/docs/en/setup) or [Pi **≥ 0.99.1**](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#getting-started) (installed with npm). Newer stable versions are accepted; exact versions are not required. [Platform dependencies](docs/guide/getting-started.md#系统依赖)

```sh
git clone https://github.com/slovx2/codex-harness-adapter.git
cd codex-harness-adapter
npm run setup
npm start
```

Available harnesses start automatically. A missing or failed harness only produces a warning; others keep running. Keep the terminal open after “SSH 就绪” (SSH ready). Ctrl-C stops the service. For later launches, just run `npm start`.

## Configure Codex Desktop

1. **Optional: set an alias.** Add the printed `Host` block to `~/.ssh/config` (Windows: `%USERPROFILE%\.ssh\config`). Rename the alias if you like.
2. **Add a connection.** Open **Settings → Connections → SSH → Add**. Select the alias or **Add manually**, using the host, port, user, and private key path from the startup output.
3. **Add a project.** From the main screen, choose **Add project → Remote devices dropdown → your device → project directory**.

Use this SSH device even for projects on your local machine. [Connection guide](docs/guide/gui.md)

## How it works, advanced usage, and troubleshooting

```text
Codex Desktop → local SSH → adapter → Claude Code / Pi
```

SSH listens only on `127.0.0.1`: **7331** for Claude, **7332** for Pi. Each harness runs independently. Your global Codex CLI is unchanged.

```sh
# Start one harness (replace claude-code with pi as needed)
npm start -- --harness claude-code

# Change both SSH ports
npm start -- --claude-port 7441 --pi-port 7442

# Use a custom port for one harness
npm start -- --harness pi --port 7442

# Check a harness / display its SSH configuration
npm run doctor -- --harness pi
npm run ssh-config -- --harness pi --port 7442
```

With Homebrew, use `codex-harness-adapter start|doctor|ssh-config` instead of `npm start`, `npm run doctor`, and `npm run ssh-config`; the options are the same.

Pass custom ports on every launch and update the desktop connection accordingly. Use `--home <directory>` to change the state directory; pass it to diagnostics and configuration commands too.

Put adapter and harness environment variables (such as `CHA_CLAUDE_*`, `PI_CLI`, or proxies) in `~/.codex-harness-adapter/env`, one `KEY=VALUE` per line. Both foreground runs and the background service read it; restart the service after changes.

- **Startup fails:** Run `doctor` for that harness and follow its guidance. Detailed logs are in `~/.codex-harness-adapter/<harness>/`.
- **Connection fails:** Check that the service is running and the port and private key match its output.
- **Model unavailable:** Check login and model settings in native Claude Code / Pi first.

[More configuration](docs/guide/configuration.md) · [Development](CONTRIBUTING.md)

---

Based on [fuergaosi233/claude-codex](https://github.com/fuergaosi233/claude-codex), with generic SSH code from Tyrs Hand. [MIT](LICENSE) · [Third-party licenses](THIRD_PARTY_NOTICES.md)
