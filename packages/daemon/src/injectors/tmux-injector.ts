import type { CommandInjector, CommandRunner, InjectionResult, TmuxSessionTransport } from "./types";
import { defaultTmuxRunner } from "./command-runner";

function resolveTarget(transport: TmuxSessionTransport): string | null {
  if (transport.paneId) return transport.paneId;
  if (transport.sessionName) return transport.sessionName;
  return null;
}

export class TmuxInjector implements CommandInjector {
  constructor(
    private readonly transport: TmuxSessionTransport,
    private readonly runner: CommandRunner = defaultTmuxRunner,
  ) {}

  async inject(command: string): Promise<InjectionResult> {
    const target = resolveTarget(this.transport);
    if (!target) {
      return { ok: false, error: "No tmux target (pane/session) provided" };
    }

    try {
      const hasSession = await this.runner.run(["has-session", "-t", target]);
      if (hasSession.code !== 0) {
        return { ok: false, error: `tmux target '${target}' not found` };
      }

      const clear = await this.runner.run(["send-keys", "-t", target, "C-u"]);
      if (clear.code !== 0) {
        return { ok: false, error: clear.stderr || "tmux clear failed" };
      }

      const literal = await this.runner.run(["send-keys", "-l", "-t", target, command]);
      if (literal.code !== 0) {
        return { ok: false, error: literal.stderr || "tmux literal send failed" };
      }

      const enter = await this.runner.run(["send-keys", "-t", target, "C-m"]);
      if (enter.code !== 0) {
        return { ok: false, error: enter.stderr || "tmux enter failed" };
      }

      return { ok: true, transport: "tmux" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
