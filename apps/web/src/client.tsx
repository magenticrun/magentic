import { Api, type AgentInfo, type Conversation, type TranscriptEntry } from "@magentic/protocol";
import { Clock, Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";

class DeviceUnpaired extends Schema.TaggedError<DeviceUnpaired>()("DeviceUnpaired", {}) {}
/** What `/pair` answers with: the device's name and when the link stops working. */
const Paired = Schema.Struct({ name: Schema.String, expiresAt: Schema.Finite });
class RemoteUnavailable extends Schema.TaggedError<RemoteUnavailable>()("RemoteUnavailable", {
  message: Schema.String,
}) {}

function App() {
  const [status, setStatus] = createSignal("Connecting…");
  const [error, setError] = createSignal("");
  const [authenticated, setAuthenticated] = createSignal(false);
  const [conversations, setConversations] = createSignal<ReadonlyArray<Conversation>>([]);
  const [agents, setAgents] = createSignal<ReadonlyArray<AgentInfo>>([]);
  const [agent, setAgent] = createSignal("assistant");
  const [current, setCurrent] = createSignal<Conversation>();
  const [entries, setEntries] = createSignal<ReadonlyArray<TranscriptEntry>>([]);
  const [draft, setDraft] = createSignal("");
  const [running, setRunning] = createSignal(false);
  const lifetime = new AbortController();
  let runController: AbortController | undefined;
  let sendMessage = () => {};
  let newConversation = () => {};
  let selectConversation = (_id: string) => {};

  const fail = (cause: Error) => setError(cause.message);
  const session = Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() => fetch("/session"));
    if (response.status === 401) return yield* new DeviceUnpaired();
    if (!response.ok)
      return yield* new RemoteUnavailable({ message: "Gateway unavailable. Reconnecting…" });
  });
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(Api);
    const refresh = Effect.gen(function* () {
      yield* session;
      const all = yield* client.listConversations({});
      setConversations(all);
      const selected = current();
      if (selected === undefined) {
        const deepLink = new URLSearchParams(location.hash.slice(1)).get("conversation");
        setCurrent(all.find((conversation) => conversation.id === deepLink) ?? all[0]);
      } else {
        setCurrent(all.find((conversation) => conversation.id === selected.id));
      }
      const conversation = current();
      if (!running()) {
        setEntries(
          conversation === undefined ? [] : yield* client.transcript({ id: conversation.id }),
        );
        setStatus("Connected");
      }
    });
    const runUi = (task: Effect.Effect<void, Error>) => {
      void Effect.runPromise(task, { signal: lifetime.signal }).catch(fail);
    };
    setAgents(yield* client.listAgents());
    setAgent(agents()[0]?.name ?? "assistant");
    selectConversation = (id) => {
      setCurrent(conversations().find((conversation) => conversation.id === id));
      setEntries([]);
      history.replaceState(null, "", `/#conversation=${encodeURIComponent(id)}`);
      runUi(refresh);
    };
    newConversation = () =>
      runUi(
        Effect.gen(function* () {
          setCurrent(yield* client.openConversation({ agent: agent() }));
          setEntries([]);
          setError("");
          yield* refresh;
        }),
      );
    sendMessage = () => {
      const input = draft().trim();
      if (!input || running()) return;
      setRunning(true);
      setStatus("Working…");
      setError("");
      runController = new AbortController();
      const requestController = runController;
      const task = Effect.gen(function* () {
        let conversation = current();
        if (conversation === undefined) {
          conversation = yield* client.openConversation({ agent: agent() });
          setCurrent(conversation);
        }
        const before = yield* client.transcript({ id: conversation.id });
        setDraft("");
        const transcript: Array<TranscriptEntry> = [...before, { _tag: "User", text: input }];
        setEntries([...transcript]);
        yield* client
          .run({
            agent: conversation.agent,
            conversationId: conversation.id,
            model: conversation.model,
            input,
          })
          .pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event._tag === "TextDelta") {
                  const last = transcript.at(-1);
                  if (last?._tag === "Assistant")
                    transcript[transcript.length - 1] = { ...last, text: last.text + event.text };
                  else transcript.push({ _tag: "Assistant", text: event.text });
                } else if (event._tag === "ToolCall") {
                  transcript.push({
                    _tag: "Tool",
                    id: event.id,
                    name: event.name,
                    params: event.params,
                    isFailure: false,
                  });
                  setStatus(`Using ${event.name}…`);
                } else if (event._tag === "ToolResult") {
                  const index = transcript.findIndex(
                    (entry) => entry._tag === "Tool" && entry.id === event.id,
                  );
                  const call = transcript[index];
                  if (call?._tag === "Tool")
                    transcript[index] = {
                      ...call,
                      result: event.result,
                      isFailure: event.isFailure,
                    };
                } else if (event._tag === "RunFailed") setError(event.message);
                setEntries([...transcript]);
              }),
            ),
          );
      }).pipe(Effect.ensuring(Effect.sync(() => setRunning(false))));
      void Effect.runPromise(task, { signal: requestController.signal }).then(
        () => runUi(refresh),
        (cause: Error) => {
          if (requestController.signal.aborted) {
            setStatus("Stopped");
            runUi(refresh);
          } else fail(cause);
        },
      );
    };
    yield* refresh;
    setAuthenticated(true);
    return yield* Effect.forever(
      Effect.sleep("3 seconds").pipe(
        Effect.andThen(refresh),
        Effect.catch((cause) =>
          cause._tag === "DeviceUnpaired"
            ? Effect.fail(cause)
            : Effect.sync(() => setStatus("Gateway unreachable. Reconnecting…")),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `${location.origin}/rpc` }).pipe(
        Layer.provide([RpcSerialization.layerNdjson, FetchHttpClient.layer]),
      ),
    ),
    Effect.catchTag("DeviceUnpaired", () =>
      Effect.sync(() => {
        setAuthenticated(false);
        setEntries([]);
        setConversations([]);
        runController?.abort();
        setStatus("This browser is no longer paired. Run /rc pair in your terminal.");
      }),
    ),
  );

  const start = async () => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const pairing = fragment.get("pair");
    const conversation = fragment.get("conversation");
    const forget = () =>
      history.replaceState(
        null,
        "",
        conversation === null ? "/" : `/#conversation=${encodeURIComponent(conversation)}`,
      );
    if (pairing === null) forget();
    let response = await fetch("/session");
    if (response.status === 401 && pairing !== null) {
      setStatus("Pairing this browser…");
      response = await fetch("/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: pairing, name: navigator.userAgent.slice(0, 80) }),
      });
      if (!response.ok) {
        forget();
        setStatus("That pairing link has expired. Run /rc pair in your terminal for a new one.");
        return;
      }
      // A scanned link often opens in a phone's in-app view rather than the
      // browser the person actually wants. The link pairs any browser until it
      // expires, so it stays in the address bar for reopening elsewhere, and
      // the secret leaves the URL once it is dead.
      const linger = await Effect.runPromise(
        Effect.tryPromise(() => response.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Paired)),
          Effect.flatMap((paired) =>
            Effect.map(Clock.currentTimeMillis, (now) => Math.max(0, paired.expiresAt - now)),
          ),
          Effect.orElseSucceed(() => 0),
        ),
      );
      const timer = setTimeout(forget, linger);
      lifetime.signal.addEventListener("abort", () => clearTimeout(timer));
    } else if (response.status === 401) {
      setStatus("Run /rc in your terminal and scan the QR code to pair this browser.");
      return;
    } else if (pairing !== null) forget();
    if (!response.ok) {
      setStatus("Gateway unavailable. Reload when it is back online.");
      return;
    }
    await Effect.runPromise(program, { signal: lifetime.signal });
  };
  const logout = async () => {
    const response = await fetch("/logout", { method: "POST" });
    if (response.ok) location.reload();
    else setError("Could not sign out. Try again when connected.");
  };
  onMount(() => {
    void start().catch(fail);
  });
  onCleanup(() => {
    lifetime.abort();
    runController?.abort();
  });

  return (
    <>
      <header>
        <h1>magentic</h1>
        <p role="status">{status()}</p>
      </header>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={authenticated()}>
        <nav>
          <select
            aria-label="Conversation"
            value={current()?.id ?? ""}
            disabled={running()}
            onChange={(event) => selectConversation(event.currentTarget.value)}
          >
            <For each={conversations()}>
              {(conversation) => (
                <option value={conversation.id}>
                  {conversation.title || "Untitled conversation"}
                </option>
              )}
            </For>
          </select>
          <select
            aria-label="Agent"
            value={agent()}
            onChange={(event) => setAgent(event.currentTarget.value)}
          >
            <For each={agents()}>{(entry) => <option value={entry.name}>{entry.name}</option>}</For>
          </select>
          <button disabled={running()} onClick={() => newConversation()}>
            New chat
          </button>
          <button
            onClick={() => {
              void logout().catch(fail);
            }}
          >
            Sign out
          </button>
        </nav>
        <article>
          <Show when={entries().length === 0}>
            <p class="empty">Start a conversation. Your agent runs on your computer.</p>
          </Show>
          <For each={entries()}>
            {(entry) => (
              <section class={`message ${entry._tag.toLowerCase()}`}>
                <h2>
                  {entry._tag === "User"
                    ? "You"
                    : entry._tag === "Assistant"
                      ? "magentic"
                      : entry._tag}
                </h2>
                {entry._tag === "Tool" ? (
                  <details>
                    <summary>
                      {entry.name}
                      {entry.isFailure ? " · failed" : ""}
                    </summary>
                    <pre>
                      {JSON.stringify(entry.params, null, 2)}
                      {"\n"}
                      {entry.result === undefined
                        ? "Working…"
                        : JSON.stringify(entry.result, null, 2)}
                    </pre>
                  </details>
                ) : (
                  <pre>{entry.text}</pre>
                )}
              </section>
            )}
          </For>
        </article>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <textarea
            aria-label="Message"
            placeholder="Send a message…"
            rows={3}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <button type="submit" disabled={running() || !draft().trim()}>
            Send
          </button>
          <Show when={running()}>
            <button type="button" onClick={() => runController?.abort()}>
              Stop
            </button>
          </Show>
        </form>
      </Show>
    </>
  );
}
const root = document.getElementById("app");
if (root !== null) render(() => <App />, root);
