<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Switch to web models. Stay in OpenCode. Your ChatGPT plan. Your workflow. Maximum capabilities.">
</p>

<p align="center">
  <a href="https://github.com/phishbacon/opencode-chatgpt-web/releases/download/v6.1.18-rc1/codex-web-gpt-6.1.18-rc1-win-x64.exe"><img src="assets/readme/download-windows.svg" width="224" height="64" alt="Windows · x64"></a>&nbsp;
  <a href="https://github.com/phishbacon/opencode-chatgpt-web/releases/download/v6.1.18-rc1/codex-web-gpt-6.1.18-rc1-mac-arm64.dmg"><img src="assets/readme/download-macos.svg" width="224" height="64" alt="macOS · Apple silicon"></a>&nbsp;
  <a href="https://github.com/phishbacon/opencode-chatgpt-web/releases/download/v6.1.18-rc1/codex-web-gpt-6.1.18-rc1-linux-x64.AppImage"><img src="assets/readme/download-linux.svg" width="224" height="64" alt="Linux · x64"></a>
</p>

<p align="center">
  <a href="https://github.com/phishbacon/opencode-chatgpt-web/releases/download/v6.1.18-rc1/codex-web-gpt-6.1.18-rc1-mac-x64.dmg">macOS Intel</a> · <a href="https://github.com/phishbacon/opencode-chatgpt-web/releases/latest">All releases</a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="A live ChatGPT Web turn using the OpenCode harness">
</p>

<p align="center">
  <a href="#get-started">Get started</a> · <a href="https://github.com/phishbacon/opencode-chatgpt-web/releases">What’s new</a> · <a href="#architecture">Architecture</a> · <a href="TROUBLESHOOTING.md">Troubleshooting</a>
</p>

Use the ChatGPT Web models available on your account, including Pro, from OpenCode’s native model picker. Messages run through your signed-in ChatGPT Web session and are subject to the limits applied to that account. Keep the same interface, tasks, images, and streaming.

Full harness mode connects ChatGPT to the current task’s files, terminal, tools, and approvals through MCP. Conversations stay tied to your OpenCode session, so you can keep working as the context grows.

## Architecture

An OpenCode session starts a ChatGPT Web model turn. OpenCode remains the source of truth for
history, instructions, tool inventory, context, and permissions.

1. The **OpenCode integration plugin** (loaded from `~/.config/opencode/plugins/`) listens to
   trusted V2 hooks — `prompt`, `context`, `compaction`, and provider-scoped `model.request` —
   and signs every turn with an HMAC claim: session, message, turn nonce, compaction epoch,
   model, tool-inventory hash, and workspace owner. The signing key is read by reference from
   the dev-host key file and is never copied into a second location.
2. The `opencode-chatgpt-web` provider in `opencode.json` sends the request to the local
   **Responses bridge** on loopback. The bridge verifies the signature, the owner, the tool
   inventory, and bridge-issued tool receipts before anything reaches a browser; native Codex
   turn metadata is rejected on OpenCode requests.
3. The bridge drives a retained **ChatGPT browser tab** bound to the OpenCode session and its
   compaction epoch. ChatGPT Web initiates tool calls through the **`opencode-chatgpt-web`
   website connector** and the official outbound OpenAI tunnel; the website MCP relays each call
   through the turn broker back to the originating turn.
4. **OpenCode executes the tools** under its own permissions, rules, and approvals. Browser-side
   metadata can never grant tool or workspace authority, and unknown or cross-session tool
   history fails closed.
5. **Compaction** follows trusted OpenCode events: the summary request is signed with
   `purpose: "compaction"` under the same turn identity, the pre-compaction browser tab is
   retired, and epochs advance only from `session.compaction.ended`. Epochs persist beside the
   signing key and are published on the bridge's `/healthz`, so plugin reloads and container
   restarts cannot desync them; the same endpoint publishes measured context windows so
   `limit.context` follows the Bigger Context toggle automatically.

The shared browser, tunnel, and packaging machinery is documented in
[docs/architecture.md](docs/architecture.md).

## How this differs from codex-chatgpt-web

| | codex-chatgpt-web (Codex) | this project (OpenCode) | Why |
| --- | --- | --- | --- |
| Turn identity | Native Codex rollout metadata (`x-codex-turn-metadata`) and Codex CLI authority | HMAC-signed V2 hook claims; OpenCode requests **reject** native Codex turn metadata | OpenCode has no Codex rollout to authenticate against, and accepting foreign turn metadata would let a browser session impersonate a native one — so the bridge verifies claims it issued itself |
| Session authority | The Codex task and its rollout | The OpenCode session is canonical; the bridge routes by signed session, message, turn, and epoch | The bridge must pick a browser tab without trusting caller-authored IDs; a signed session/turn/epoch tuple makes cross-session or replayed routing impossible |
| Website connector | `Codex Native2` with the native MCP contract | `opencode-chatgpt-web` (and `opencode-chatgpt-web DEV` for the dev harness) with the `opencode` website MCP contract | Distinct connector names and contracts namespace the two harnesses, so a Codex tab can never drive an OpenCode session and the dev harness can't touch production |
| Tool inventory | Codex's registered tool set | The exact inventory of the originating OpenCode turn, hashed into the signature; every website call needs a bridge-issued receipt | The model only sees tools that turn actually declared, and receipts prove the bridge — not the browser — issued each call, closing injection and cross-turn replay |
| Tool execution | Codex approvals and sandbox | OpenCode's native harness, permissions, and rules — no privilege from browser-authored metadata | The browser is an untrusted display surface; keeping execution in OpenCode means a compromised tab gains no tool or workspace authority |
| Compaction | Native rollout compaction marker | Trusted `session.compaction.*` events, a signed `purpose: "compaction"` summary, browser retirement, and persisted epochs published on `/healthz` | Compaction is the one turn without prior tool results; signing it explicitly allows that shape while persisted, published epochs keep plugin reloads and restarts from desyncing |
| Model limits | Static catalog limits | The bridge publishes measured windows and pre-compaction budgets on `/healthz`; the plugin syncs them into `opencode.json` when Bigger Context changes | Measured windows differ per account and toggle; static values drift and trigger compaction at the wrong threshold, so limits follow live measurements automatically |
| Routing | `openai_base_url` route in `~/.codex/config.toml` | `providers["opencode-chatgpt-web"]` in `opencode.json`, pointing at the loopback Responses bridge | OpenCode never reads Codex config; its provider map is the native extension point, and loopback keeps the signing boundary inside the machine |
| Deployment | A single launcher process (Electron + daemon + tunnel) | OpenCode stays on the host with filesystem and tool authority; the browser side (Electron, bridge, broker, tunnel, MCP) can run in a container with no host workspace and no Docker socket; `dev serve-opencode` powers development | Splits the trust boundary: the container handles untrusted web content but has no workspace or Docker access, while OpenCode keeps tool authority where the filesystem already is |
| Session lifecycle | Codex task lifecycle | Retained tabs bound to epochs with configurable idle retirement, signed session-deletion notices, `configuration_update` items with validated effort, and `dev status` health output | Tabs are bridge resources, not tasks — their lifetime must follow bridge policy and signed notices so a stale or foreign session can't keep a tab alive |

<div id="get-started"><a id="quick-start"></a></div>

## Get started

**Available models:** Free/Go → **Luna / Think**. Paid accounts → **GPT-6 Sol** and **GPT-5.6 Sol**, with **Instant–High**, plus **Extra High** and **Pro** when available. Each version has its own entry; existing GPT-5.6 chats keep GPT-5.6. Availability depends on your account and workspace.

1. **Install the launcher** using the download for your system above.
2. **Sign in to ChatGPT** in the embedded browser and run the browser smoke test.
3. **Install models** and restart OpenCode once. In automatic mode, choose a model ending in **(Web)**. Pro versions have separate entries; Sol reasoning is selected through Effort. Zero Risk keeps its dedicated entry.
4. **For coding with tools**, open **MCP** in the launcher and complete the Full harness setup below.

The app includes its browser and runtime. No separate Chrome, Node, or Bun installation is needed.

<details>
<summary><strong>Terminal install, updates & repair</strong></summary>

Quit the launcher before updating. These installers select the platform and architecture, verify the published checksums, and preserve your ChatGPT profile and launcher settings.

**macOS / Linux**

```bash
curl -fsSL https://github.com/phishbacon/opencode-chatgpt-web/releases/latest/download/install-launcher.sh | sh
```

**Windows PowerShell**

```powershell
irm https://github.com/phishbacon/opencode-chatgpt-web/releases/latest/download/install-launcher.ps1 | iex
```

</details>

<details>
<summary><strong>Models, modes & MCP setup</strong></summary>

<a id="modes"></a>

Automatic modes offer Luna/Think when the account has no reasoning selector; otherwise Instant–High, with Extra High and Pro available independently when exposed by the account.

| Mode | Sending messages | Local OpenCode tools |
| --- | --- | --- |
| **Browser-only** | Automatic | No |
| **Full harness (With Automation)** | Automatic | Yes, through MCP |
| **Zero Risk** | Paste and send manually | Yes, through a separate MCP connector |

Zero Risk does not read or operate the ChatGPT page. Choose the model and `OpenCode Zero Risk` connector yourself, paste and send the prepared prompt, then confirm **Sent** in the launcher. Automatic models ending in **(Web)** expose their supported Effort choices in OpenCode. Instant and each Pro version have separate entries to preserve their context budgets; older saved model entries keep their original fixed mode.

<a id="full-harness"></a>

### Full harness

Full mode connects ChatGPT's tool calls back to the current OpenCode session through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

The launcher uses your system proxy for the tunnel. Explicitly configured proxy
environment variables take priority; local connections stay local.

The launcher's **MCP** page guides the complete setup. For the exact clicks, see the
[video walkthroughs](TROUBLESHOOTING.md).

> **Limits**
>
> See [Limits](https://github.com/miuuyy/codex-chatgpt-web/discussions/309) for the current
> ChatGPT message allowances for **GPT-5.6 Sol Pro** and **GPT-6 Astra**. Context limits depend on
> the account type and selected effort. Plus Medium/High uses a measured 90,000-token window.
> GPT-5.6 supports up to 270,000 tokens with experimental **3× context** enabled, with native
> OpenCode compaction supported throughout.
>
> GPT-6 Sol supports Bigger Context at Medium, High and available Extra High: **120,000 tokens
> on Plus**, with compaction at **110,000**, and **240,000 on Pro**, with compaction at **220,000**.
> GPT-6 Instant uses standard context.
> GPT-5.6 and GPT-6 Pro keep their existing Bigger Context limits.

1. Finish the required setup, open **MCP**, create the Tunnel and regular API key, then press
   **Connect harness**.
2. Enable ChatGPT **Developer Mode** and create a new Tunnel connector named exactly
   **opencode-chatgpt-web**, with **Authentication: None** and **Allow all actions**.
3. Run **Verify runtime** to confirm that **opencode-chatgpt-web** is attached and available.

Write/modify actions also require the ChatGPT workspace and its administrator policy to permit
them. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

</details>

<details>
<summary><strong>Diagnostics & subagents</strong></summary>

<a id="operations"></a>

Use **Activity** for safe local diagnostics and **Settings → Run doctor** for end-to-end health.
Settings can also cancel a retained browser turn or remove the OpenCode integration before uninstall.
**Settings → Temporary Chat** is on by default and keeps new task conversations out of ChatGPT
history. Turn it off to use ordinary saved chats or if your connector is unavailable in that mode.
ChatGPT memory and custom instructions may apply in either mode. **New browser chat for each turn**
separately controls conversation reuse. An explicit choice to disable Temporary Chat is preserved when updating.
Set `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` only when every browser checkpoint needs a screenshot.

New installs use **Compatibility V1** for cross-backend subagents. **Native** preserves the harness's own
feature settings and enables plaintext Web-to-Web V2 delegation. Restart the app and start a new task
after changing the protocol:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Requirements & security</strong></summary>

<a id="limitations-and-security"></a>

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- Browser state is a sensitive login artifact, and the loopback listener is reachable by processes
  running as the same local user. Never share the launcher profile; use a trusted workstation.
- Release packages currently target macOS 13+ (arm64/x64), Windows x64, and Linux x64. Runtime,
  tests, and packaging are gated on all three in CI; account-bound browser and MCP flows use the
  separate [release validation](docs/release-validation.md).
- Builds are not yet platform-signed, so Gatekeeper or SmartScreen may warn. The installers verify
  the published SHA-256 manifest before installation.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

Task prompts are processed by OpenAI and conversations remain in your ChatGPT history.

Validation coverage: [release validation](docs/release-validation.md).

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.

</details>

<details>
<summary><strong>Run from source & develop</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/phishbacon/opencode-chatgpt-web.git && \
cd opencode-chatgpt-web && \
bun run app
```

This source path requires Bun 1.4.0. The command installs locked dependencies and opens the app.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` uses a separate profile and account under `~/.codex-chatgpt-web-dev`. `dev:chat` exercises the real browser and compaction paths with explicit simulated tool results, without changing your normal browser route. See the [DEV chat harness](docs/dev-chat.md) for setup and commands.

</details>

## Star History

<a href="https://www.star-history.com/?repos=phishbacon%2Fopencode-chatgpt-web&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=phishbacon/opencode-chatgpt-web&type=date&theme=dark&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=phishbacon/opencode-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=phishbacon/opencode-chatgpt-web&type=date&legend=top-left&sealed_token=hBVvg_eOjfMFDrfyeo5FPQkIwcvBEmXc6F7ZoOKnfFE4KPCs67o34w4XwVuM-bHGnKR-SKCAN_TSTWrzuqSBNU-RjNZCLT4f-xNs9qcDhciQtemxHKuuFj0N5YNqZIihdaQfakrh2ANhOrvP0K2LmLXX2zbsYyVaYZknyTnlYeIS_mOGvMcO32ZmPCHK">
  </picture>
</a>

---

[Troubleshooting](TROUBLESHOOTING.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE) · [CI](https://github.com/phishbacon/opencode-chatgpt-web/actions/workflows/ci.yml)

Also by me: <img src="assets/readme/persona-voice.svg" width="20" height="20" alt=""> [ChatGPT Persona Voice](https://github.com/miuuyy/ChatGPT-Persona-Voice) — local, near-real-time custom voices for ChatGPT and Codex.
