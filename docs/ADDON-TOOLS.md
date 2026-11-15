# Add-on tools for the AI link

The editor's AI link (MCP, **Preferences ▸ General ▸ AI link (MCP)**) offers the editor's own tools. An installed add-on can add its own tools to it through a versioned hook. The editor lists them next to the built-in tools, checks every call, asks the user before any tool that changes something, and keeps a log of the session's calls.

The hook is the host module `js/mcp/addon-tools.js`. An add-on reaches it through the [plug-in interface](ADDONS.md) (`js/plugin/host.js`) like any other host module.

## Registering tools

```js
import { ADDON_TOOLS_API_VERSION, registerAddonTools } from '../../mcp/addon-tools.js';

const { names, unregister } = registerAddonTools('acme', [{
  name: 'count_pages',
  title: 'Count pages',
  description: 'Counts the pages of the drawing on screen.',
  writes: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (args, { documentText }) => ({ pages: 3 }),
}], { apiVersion: ADDON_TOOLS_API_VERSION });
// names: ['addon_acme_count_pages']
```

| Field | Meaning |
| --- | --- |
| `name` | Lowercase letters, digits and `_`, not ending in `_`. |
| `title` | 1-80 characters, shown to the user on approval cards and in the log. |
| `description` | 1-4000 characters, for the model. |
| `inputSchema` | JSON schema of the arguments, `type: "object"`. Only the subset below is accepted. |
| `writes` | `true` when the tool changes a document, the app's state or a file. Required. |
| `handler(args, ctx)` | Runs the tool and returns a JSON value. `ctx.documentText` marks document text, `ctx.image` adds an image (below). |
| `summarize(args)` | Optional: one line for the approval card, such as "Write the report to C:\out\report.xlsx". |

- **Namespace.** The first argument is the add-on's tool namespace: 2-24 lowercase letters and digits. Each tool is listed as `addon_<namespace>_<name>`, at most 64 characters, which fits the tool-name rules of common model APIs (letters, digits, `_` and `-`).
- **Version.** `apiVersion` is `ADDON_TOOLS_API_VERSION` (currently 1). Another version is refused.
- **Collisions.** A name another add-on already registered is refused, and so is a name twice in one list. A built-in tool can never be replaced: built-in names do not start with `addon_`, and the native server checks again.
- **All or nothing.** One invalid tool refuses the whole list. Registering again with the same namespace replaces that add-on's tools; `unregister()` removes them.
- **Supported schema keywords:** `type` (`object`, `string`, `number`, `integer`, `boolean`, `array`, `null`, or a list of these), `properties`, `required`, `additionalProperties` (true or false), `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `items`, `minItems`, `maxItems`, `uniqueItems`, `description`, `title`, `default`, `examples`. Any other keyword is refused when the tool registers, so the schema a client sees is exactly what the editor enforces.

The registered descriptors (without handlers) are sent to the native MCP server (`src-tauri/src/mcp_addon_tools.rs`) whenever the set changes. The server checks them again, lists them in `tools/list` for both the public and the development profile, with `readOnlyHint` and `destructiveHint` set from `writes`, and sends each call back to the WebView as the `mcp:addon-call` bridge event.

## What the editor does on every call

1. **Arguments.** The arguments are checked against the schema. A call with invalid arguments is refused and the handler does not run.
2. **Approval for changes.** For a tool with `writes: true` the app shows a small non-modal card at the bottom of the window: the tool, its summary and its arguments, with **Approve**, **Deny** and **Always for this session**. The user can keep working while it is open. A card that gets no answer within five minutes counts as Deny. **Always for this session** applies to that one tool until the app closes or the user withdraws it in the log. Tools without `writes` run without asking.
3. **One undo step.** An approved change runs inside one undo transaction, so a single Undo takes back everything the call changed. Changing tools run one at a time. If the handler fails, the changes it already made are undone.
4. **What goes back to the model.** The answer is `{ ok, tool, result }` or `{ ok: false, error }`, at most 120,000 characters of JSON. A larger result is refused with a request to ask for less.
5. **Images.** A handler can put `ctx.image(base64, { mimeType })` anywhere in its result (PNG, JPEG or WebP, base64 without a `data:` prefix, at most 5 MB decoded, at most 4 per answer; anything else fails the call). The image is taken out of the JSON answer, which keeps a reference `{ image: n, mimeType, bytes }` in its place, and goes to the client as MCP image content after the text, on `/mcp`, `/mcp/ask` and `mcp_local_call` alike. In the WebView the answer carries the images as `images: [{ mimeType, data }]`. Images do not count toward the 120,000 characters.
6. **Document text is data.** Text that comes from a document (page text, markup comments, file names) must be passed through `ctx.documentText(text, { source, maxChars })`. It is clipped (4,000 characters by default, 20,000 at most) and marked `"untrusted": true`, and the answer then carries a notice telling the model to treat that text as data and not to follow instructions in it.
7. **Log.** Every call is logged for the session: time, tool, an argument summary, the number of images, the decision (read, approved, always, approved for the session, declined, no answer, invalid, unknown) and the outcome. **Preferences ▸ General ▸ AI link (MCP) ▸ View tool log...** shows it, and the approval card links to it. The log stays in memory and is not written to disk.

## Rules for add-on tools

- Mark every tool that changes a document, the app's state or a file with `writes: true`. Changing the view counts.
- Record document changes through the editor's undo manager, as the editor's own commands do, so the call is one undo step.
- Keep tools local. A tool that uses the network must say so in its description and must not run without the user's consent.
- Return document text only through `documentText`, and keep results small: offer `limit` and page arguments.
- Do not ask the model for file paths silently: show the path in `summarize`, or let the user pick it in a save dialog after approval.

The tests in `js/mcp/addon-tools.test.mjs`, `js/mcp/addon-tools-undo.test.mjs` and `src-tauri/src/mcp_addon_tools.rs` cover registration, schemas, approval, undo grouping, results, images and listing.

## Asking before the editor's own tools change something

The AI link also answers on **`/mcp/ask`** (`http://127.0.0.1:<port>/mcp/ask`): the same tools, but every editor tool that is not read-only (its `readOnlyHint` is false) shows the same approval card first, and add-on calls carry the card's owner (below). Read-only tools run without asking. A client the user wants to confirm each change points there.

Two native commands give an add-on the same list and calls in process, without the AI link being on: `mcp_local_tools` (the public `tools/list`, add-on tools included) and `mcp_local_call { name, arguments }` (one call, on the asking path: the user approves every change first, add-on tools included, on a card owned by `assistant`; the result is the MCP result `{ content, isError }`, with an add-on tool's images as image content). An in-app chat that an add-on brings uses these, so its model gets exactly the AI link's tools, with the same checks, approvals and log.

The approval card and its rules are the hook's:

- `requestToolApproval({ tool, title, args, owner })` shows the card for one of the editor's tools and resolves to `{ approved, decision }`; the decision goes in the session log like an add-on call, and **Always for this session** applies as well. The editor's bridge calls it for the asking path (`mcp:approve`); an add-on does not need to.
- `callAddonTool(name, args, { owner })`: a card can name its `owner` (a short string). The asking path names `assistant`.
- `setInlineApprovals(predicate)`: a panel that shows some cards itself (an add-on's chat panel, next to the step that asked) claims them with `predicate(card)`; the floating cards leave those out, and the panel answers them with `answerApproval(id, decision)`. Pass `null` to give them back, and call `notifyApprovals()` when the panel is shown or hidden. A predicate that throws claims nothing.

## Sections in the AI connections panel

An add-on can also add its own section to **Help ▸ AI connections** (the panel that links AI clients to the AI link) through the host module `js/mcp/ai-connections-sections.js`:

```js
import { AI_CONNECTIONS_SECTIONS_API_VERSION, registerAiConnectionsSection } from '../../mcp/ai-connections-sections.js';

registerAiConnectionsSection({ id: 'acme.extra', order: 10, load: () => import('./ExtraSection.jsx') },
  { apiVersion: AI_CONNECTIONS_SECTIONS_API_VERSION });
```

The section's component loads when the panel opens and receives `api`: `scanOf(clientId)` (a client's settings file as the panel read it), `propose(plan, label, note)` (show a change as a diff for the user to apply), `busy()` and `port()`. Plan a change with `planEdit(clientId, scan, edit)` from `js/mcp/ai-connections.js`, with its JSON-with-comments and TOML helpers; the panel then applies the same refusals and safe write as for its own rows. The editor's panel itself only edits the clients' settings files and asks the app's own AI link; it contacts nothing else.
