import { connect } from "node:net";

import { buildAuthFrame, buildUserFrame, serializeFrame, wrapMessage, type Frame, type PeerMode } from "./protocol.ts";

/** Claude Code half-closes this long after writing and counts the send as done when the peer closes. */
const END_DELAY_MS = 150;
const SEND_TIMEOUT_MS = 5000;

/**
 * Deliver frames to a peer socket: optional auth line first, then the frames, then half-close.
 * Resolves when the peer closes the connection, which is the only acknowledgment the protocol has.
 */
export async function deliver(socketPath: string, frames: Frame[], token?: string): Promise<void> {
  const payload = (token !== undefined ? serializeFrame(buildAuthFrame(token)) : "") + frames.map(serializeFrame).join("");
  await new Promise<void>((resolvePromise, reject) => {
    const conn = connect({ path: socketPath });
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(error);
    };
    conn.setTimeout(SEND_TIMEOUT_MS, () => fail(new Error(`timed out sending to ${socketPath}`)));
    conn.on("error", fail);
    conn.on("connect", () => {
      conn.write(payload);
      setTimeout(() => {
        if (!conn.destroyed) conn.end();
      }, END_DELAY_MS);
    });
    conn.on("close", () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    });
  });
}

export interface SendUserMessageOptions {
  socketPath: string;
  token?: string;
  body: string;
  /** This session's own `uds:` address, which the receiver uses to reply. */
  from: string;
  fromName: string;
  /** Attested permission-mode class; without it a bypass-mode receiver holds the message for approval. */
  fromMode?: PeerMode;
}

/** Send one wrapped user message to a Claude Code (or pi) peer and return its msg_id. */
export async function sendUserMessage(opts: SendUserMessageOptions): Promise<string> {
  const frame = buildUserFrame({
    content: wrapMessage(opts.body, { from: opts.from, fromName: opts.fromName, fromMode: opts.fromMode }),
    from: opts.from,
  });
  await deliver(opts.socketPath, [frame], opts.token);
  return frame.msg_id;
}
