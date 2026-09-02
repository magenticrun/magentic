import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { withStreamOnlyBackend } from "./CodexStreamShim.ts";
import { fakeHttp } from "./testing.ts";

const sse = (events: ReadonlyArray<object>) =>
  events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");

const completed = { id: "resp_1", output: [], usage: { input_tokens: 1 } };
const item = { type: "message", id: "msg_1", content: [{ type: "output_text", text: "hi" }] };

describe("codex stream shim", () => {
  it.effect(
    "turns a non-streaming /responses call into a stream and returns the final response",
    () =>
      Effect.gen(function* () {
        const http = yield* fakeHttp([
          {
            status: 200,
            body: sse([
              { type: "response.created", response: { id: "resp_1" } },
              { type: "response.output_text.delta", delta: "hi" },
              { type: "response.output_item.done", item },
              { type: "response.completed", response: completed },
            ]),
          },
        ]);
        const client = yield* Effect.map(HttpClient.HttpClient, (base) =>
          base.pipe(HttpClient.filterStatusOk, withStreamOnlyBackend),
        ).pipe(Effect.provide(http.layer));
        const response = yield* client.execute(
          HttpClientRequest.post("https://x/backend-api/codex/responses", {
            body: HttpBody.jsonUnsafe({ model: "gpt-5.5", input: [] }),
          }),
        );
        const [request] = yield* http.requests;
        assert.deepStrictEqual(JSON.parse(request?.body ?? "{}"), {
          stream: true,
          model: "gpt-5.5",
          input: [],
        });
        assert.deepStrictEqual(yield* response.json, { ...completed, output: [item] });
      }),
  );

  it.effect("leaves streaming calls alone", () =>
    Effect.gen(function* () {
      const http = yield* fakeHttp([{ status: 200, body: "data: raw\n\n" }]);
      const client = yield* Effect.map(HttpClient.HttpClient, (base) =>
        base.pipe(HttpClient.filterStatusOk, withStreamOnlyBackend),
      ).pipe(Effect.provide(http.layer));
      const response = yield* client.execute(
        HttpClientRequest.post("https://x/responses", {
          body: HttpBody.jsonUnsafe({ model: "gpt-5.5", stream: true }),
        }),
      );
      assert.strictEqual(yield* response.text, "data: raw\n\n");
    }),
  );

  it.effect("surfaces response.failed as an error", () =>
    Effect.gen(function* () {
      const http = yield* fakeHttp([
        {
          status: 200,
          body: sse([
            { type: "response.failed", response: { error: { code: "usage_limit_reached" } } },
          ]),
        },
      ]);
      const client = yield* Effect.map(HttpClient.HttpClient, (base) =>
        base.pipe(HttpClient.filterStatusOk, withStreamOnlyBackend),
      ).pipe(Effect.provide(http.layer));
      const error = yield* client
        .execute(HttpClientRequest.post("https://x/responses", { body: HttpBody.jsonUnsafe({}) }))
        .pipe(Effect.flip);
      assert.match(error.message, /usage_limit_reached/);
    }),
  );
});
