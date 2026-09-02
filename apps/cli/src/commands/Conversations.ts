import { CommandError, type CommandInput, define, type PickItem } from "@magentic/plugin";
import type { Conversation } from "@magentic/protocol";
import { DateTime, Effect, Option } from "effect";

const RESUME = "resume";
const NEW = "new";

/** `just now`, `5m ago`, `3h ago`, `2d ago`: enough to tell conversations apart. */
export const ago = (at: DateTime.Utc, now: DateTime.Utc): string => {
  const seconds = Math.max(0, DateTime.toEpochMillis(now) - DateTime.toEpochMillis(at)) / 1000;
  if (seconds < 60) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86_400)}d ago`;
};

const toItem = (conversation: Conversation, now: DateTime.Utc): PickItem => ({
  id: conversation.id,
  label: conversation.title.length === 0 ? "(untitled)" : conversation.title,
  detail: `${ago(conversation.updatedAt, now)} · ${conversation.messages} msgs`,
});

const resume = Effect.fn("resume.run")(function* ({ ui, session, args }: CommandInput) {
  if (args.length > 0) {
    return yield* session.resume(args);
  }
  const all = yield* session.conversations;
  const current = Option.map(yield* session.conversation, (c) => c.id);
  const others = all.filter((c) => !Option.contains(current, c.id));
  if (others.length === 0) {
    return yield* ui.notify(
      Option.isSome(current)
        ? "No other conversations with this agent."
        : "No earlier conversations with this agent.",
    );
  }
  const now = yield* DateTime.now;
  const picked = yield* ui.pick({
    title: "Resume a conversation",
    sections: [{ title: session.agent, items: others.map((c) => toItem(c, now)) }],
  });
  if (Option.isSome(picked)) {
    yield* session.resume(picked.value.id);
  }
});

/**
 * `/resume`: pick one of this agent's earlier conversations and carry on
 * from it, the transcript restored; `/resume <id>` names one outright.
 * `/new` puts the current one aside and starts fresh.
 */
export const conversationCommandsPlugin = define({
  id: "conversation-commands",
  description: "The /resume and /new commands: pick up an earlier conversation, or start one.",
  setup: Effect.fn("conversationCommandsPlugin.setup")(function* (ctx) {
    yield* ctx.command.register({
      name: RESUME,
      description: "Continue an earlier conversation with this agent",
      run: (input) =>
        resume(input).pipe(
          Effect.mapError((error) =>
            error._tag === "CommandError"
              ? error
              : new CommandError({ command: RESUME, message: String(error) }),
          ),
        ),
    });
    yield* ctx.command.register({
      name: NEW,
      description: "Start a new conversation",
      run: ({ session }) => session.startNew,
    });
  }),
});
