# pi-claude-bridge

A [Pi](https://github.com/earendil-works/pi-mono) extension for local cross-session messaging with Claude Code. Pi gets `list_claude_sessions`, `send_to_claude`, and `/peers`; compatible Claude Code sessions can discover Pi with `ListAgents` and send messages with `SendMessage`.

This is an unofficial integration with an undocumented Claude Code 2.1.x protocol. Protocol compatibility can change between releases. The implementation targets macOS (including its `darwin` process domain); Windows is unsupported and Linux interoperability is not established. Development types are pinned to Pi 0.84.4.

## Install

Requires Node.js 22.19 or newer, Pi, and a Claude Code release exposing cross-session messaging. Install with:

```sh
pi install git:github.com/beaugunderson/pi-claude-bridge
```

Restart Pi after installing. Add `-l` for a project-local installation. To remove:

```sh
pi remove git:github.com/beaugunderson/pi-claude-bridge
```

For a local checkout:

```sh
git clone https://github.com/beaugunderson/pi-claude-bridge.git
cd pi-claude-bridge
pnpm install --frozen-lockfile --ignore-scripts
pi install .
```

The `pi.extensions` manifest points to `src/index.ts`; no compilation is needed. Pi and TypeBox are declared as peer dependencies, as prescribed by Pi's [package documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md). Pi supplies their runtime modules through its extension loader. Development copies provide types and fixture testing; runtime loading does not depend on dev dependencies surviving Pi's production git install.

## Use

Start Pi and the intended Claude Code peers with the same `CLAUDE_CONFIG_DIR`. The default is `~/.claude`; sessions in different config directories do not discover one another.

1. Name the Pi session with `/name demo`. Its peer name becomes `pi-demo`.
2. Run `/peers` to see reachable sessions, or ask Pi to call `list_claude_sessions`.
3. Ask Pi to call `send_to_claude` with a listed peer name and a message. If names overlap, use `name [ref]` from the listing.
4. In a compatible Claude Code session, use `ListAgents` to find `pi-demo`, then `SendMessage` to address it.

A raw `uds:/absolute/path.sock` target is also accepted. Registry matching is needed to find a peer's auth token; an unregistered direct target is sent no token and may reject delivery.

Without a session name, the address is `pi-<cwd basename>-<2 hex>`. Renames update registration immediately; clearing the name restores the derived address. The registry also tracks the current model as `provider/id`.

## Configuration and authority

| Variable | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` | Config directory whose `sessions/` registry to join; default `~/.claude` |
| `PI_PEER_NAME` | Override the registered name |
| `PI_PEER_MODE` | `unattested` (default), `prompting`, or `bypass`; see below |
| `PI_CLAUDE_BRIDGE_SOCKET_DIR` | Override socket directory; otherwise `$CLAUDE_CODE_TMPDIR/cc-socks` if set, then `/tmp/cc-socks` |
| `PI_CLAUDE_BRIDGE_LOG` | Optional file for appended diagnostic logs |

The default omits `from-mode` from outgoing messages. The bridge cannot infer the permissions enforced by your host or other extensions. Set `prompting` or `bypass` only when it accurately describes the sending session; these values attest a mode, they do not enable permissions. Invalid values (including an empty string) prevent startup. Do not change the attestation merely to avoid a receiver's approval hold. A Claude Code receiver may hold unattested or mismatched messages for user approval.

Inbound connections require the token generated for this bridge session. Socket and key files use mode 0600, with containing directories set to 0700. Tokens protect local transport access; sender names, addresses, and mode claims are not proof of user authorization. Messages enter Pi as custom peer messages with explicit peer-versus-user guidance. They can trigger an agent turn and must remain subject to the receiving session's permissions. Never ask a peer to perform an action denied locally. This bridge does not implement Claude Code's approval-hold UI on inbound messages.

Registry records expose the working directory, session name/ID, and model to local peers sharing the config directory. Debug logs can contain message excerpts and paths; keep logs and live registry data private.

## Protocol and troubleshooting

The transport is newline-delimited JSON over Unix domain sockets:

- Registry: `<config dir>/sessions/<pid>.json`, plus a `<pid>.<sha256 of resolved socket path>.key` containing a peer token. Liveness checks compare the process start stamp with `LC_ALL=C TZ=UTC ps -o lstart=`.
- Send: an auth frame followed by a version-1 user frame whose body uses a `<cross-session-message>` wrapper. `from-mode` is optional.
- Close: the sender half-closes after 150 ms. The receiver closes without writing a reply. Connection closure is transport completion, not proof of authentication success, user approval, or execution.
- Control: delivery receipts are logged and ignored.

If no peers appear, check config-directory scoping and compatible messaging support. If messages appear held, inspect the receiver's approval UI. If startup fails, check Pi's notification or opt into a private debug log. The full socket path must fit within 103 bytes. Claude Code may require reply sockets in its own socket directory; a custom directory can affect receipts. Never remove a socket belonging to a running process.

## Development

Use pnpm 10.30.1:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm typecheck
```

Tests use synthetic messages, temporary registries and sockets, and mocked extension lifecycle calls. They do not launch agents or use live registries, credentials, or model APIs. CI runs the same fixture suite and typecheck on macOS. Fixture success does not establish compatibility with a live Claude Code release.

Source layout: `protocol.ts` handles framing; `registry.ts` handles discovery; `inbox.ts` and `outbox.ts` implement transport; `index.ts` connects these to Pi. Keep new tests synthetic and isolated.

## License

[MIT](LICENSE), copyright Beau Gunderson.
