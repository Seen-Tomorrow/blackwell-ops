# Local transcript fetch — design for the next slice

Status: design only, not implemented  
Decision: [DECISIONS.md](DECISIONS.md) D-016 — local transcripts are local-only by
default; the owner may fetch a chosen session from the Blackwell dashboard on
demand. No automatic upload.  
Related: [LOCAL-MODE-SPEC.md](LOCAL-MODE-SPEC.md),
[LOCAL-MODE-REPORT.md](LOCAL-MODE-REPORT.md)

## Why this shape

Local Power Mode writes Pi sessions to `<data-dir>/pi-sessions/` and never sends
them anywhere. "Fetch them home for review" means the **home dashboard pulls a
session from the remote machine**, which is the opposite direction from an
upload job on the target: the owner chooses the session, the target answers, and
nothing leaves the machine otherwise.

The WSS connection is already authenticated (device token), already outbound
(NAT-friendly), and local mode already opens it as a routes-only socket. Adding
two request/response pairs to that socket needs no inbound port, no new service,
and no background agent.

## Current state (after the local-mode slice)

- Local Pi: `<data-dir>/pi-sessions/`, shared with remote Power Mode.
- Session files: `<ISO-8601>_<uuid>.jsonl`; the first JSON line is
  `{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}`, then events.
- Nothing is uploaded; the gateway stores only remote Power Mode forensic logs
  under `<app-root>/config/remote/sessions/<device-id>/`.

## Proposed protocol (additive, v1-compatible)

`remote/src/protocol.rs`:

```rust
// ClientMessage
SessionListRequest { request_id: String },
SessionFetchRequest { request_id: String, session: String },

// ServerMessage
SessionList { request_id: String, sessions: Vec<LocalSession> },
SessionChunk {
    request_id: String,
    session: String,
    offset: u64,
    total: u64,
    data: String, // base64
    done: bool,
},
SessionError { request_id: String, message: String },
```

```rust
struct LocalSession {
    session: String,      // file name only
    started_at: String,   // first line timestamp (or file mtime if unreadable)
    cwd: String,
    bytes: u64,
    modified_unix: u64,
}
```

Wire shape follows the existing `#[serde(tag = "type", rename_all = "snake_case")]`
convention. The base64 chunk cap (256 KiB) keeps every frame far below
`MAX_WS_MESSAGE_BYTES` (16 MiB).

## Flow

1. Operator opens REMOTE → DEVICES and selects a paired device that is currently
   in local Power Mode (routes-only socket online).
2. Dashboard calls `remote_local_sessions(device_id)`; the gateway sends
   `SessionListRequest` over that device's socket and waits (15 s timeout).
3. The client lists at most the newest 200 `*.jsonl` files in
   `<data-dir>/pi-sessions`, reads the first line of each for timestamp/cwd, and
   answers `SessionList`.
4. Dashboard shows the list; the owner picks one and clicks FETCH.
5. `remote_fetch_session(device_id, session)` sends `SessionFetchRequest`; the
   client validates the name, reads the file, and streams
   `SessionChunk` frames (256 KiB each). The gateway streams the chunks to the
   Tauri command, which writes
   `<app-root>/config/remote/transcripts/<device-id>/<session>` and returns the
   path.
6. The local console prints one line, e.g.
   `Dashboard fetched session 2026-10-30T00-58-57….jsonl (4 KiB)`, so the person
   at the machine can see that a transcript left it.

## Security and privacy rules

- **Explicit only:** no scheduler, no "sync all", no upload on exit. One request
  → one file.
- **Name allow-list:** the requested name must be a single file name
  (`Path::file_name` equals the input), end in `.jsonl`, and resolve inside
  `<data-dir>/pi-sessions` after canonicalization. Reject `..`, separators,
  symlinks that escape the directory, and anything not a regular file.
- **Size cap:** refuse files larger than 64 MiB; stream below that.
- **Socket:** only a paired device (`Authorization: Bearer <device token>`) may
  answer; the gateway only routes a response to the request that asked for it,
  keyed by `request_id` and device id.
- **No key material:** session files contain prompts/tool output, not the cloud
  key; the client still never logs the key.
- **Storage on the gateway:** owner data under `config/remote/transcripts/`,
  never auto-deleted in the trial; a REVIEW/OPEN action and a manual delete are
  enough for the first build.
- **Local visibility:** the console line above is the consent signal for the
  person at the machine. If the product later allows non-owner local users, add
  an explicit confirm in the local UI.

## Gateway state changes

`RemoteState` needs a pending-request map (like the model-request heads):

```text
request_id -> oneshot::Sender<Vec<LocalSession>> / chunk sink
```

- `request_sessions(device_id)` and `fetch_session(device_id, session)` send the
  frame, await the oneshot, and time out after 15 s.
- The connection reader fills the pending entry from `SessionList` /
  `SessionChunk` / `SessionError`; a disconnect fails every pending request for
  that device.
- Nothing is written to the session log for a fetch (it is not an operator PTY
  session); optionally add one `transcript_fetch` forensic event if the product
  wants an audit trail.

## App surface

- Tauri: `remote_local_sessions(device_id) -> Vec<LocalSession>`,
  `remote_fetch_session(device_id, session) -> String` (saved path).
- REMOTE → DEVICES: in the device panel, a **LOCAL SESSIONS** section (visible
  when the device is in local mode), list rows with started/cwd/size, and a
  FETCH button; fetched files appear under a small "FETCHED" list with
  open-in-explorer.
- Keep the existing remote Power Mode terminal and session controls untouched.

## Limits of this phase

- A fetch needs the target's link to be online, and local mode is online while
  Pi runs. If the owner wants to fetch after the fact, the link needs a
  background/tray mode (start with the service agent later, or run the link
  without Pi). Do not silently add a background uploader.
- The same messages can later serve remote Power Mode sessions; the client-side
  handler is shared, the only difference is which socket is up.
- No resumable transfer in phase 1: a dropped socket fails the fetch, and the
  operator retries.

## Test plan

1. Unit: session-name validation (traversal, separators, non-`.jsonl`, symlink
   escape), chunk offsets/total/done, size cap.
2. Integration (`remote-client/tests`): a fake gateway requests the list and one
   file; assert chunks reassemble byte-identical and a traversal request is
   rejected with `SessionError`.
3. E2E: standalone gateway on a spare port, paired client in local mode, real Pi
   `-p` creates a session, operator lists and fetches it, compare sha256 with the
   file on disk.
4. App: after the owner restarts DEV, fetch a session in REMOTE → DEVICES and open
   the saved file.
