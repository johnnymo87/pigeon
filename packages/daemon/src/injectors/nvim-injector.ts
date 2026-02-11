import type { CommandInjector, CommandRunner, InjectionResult, NvimSessionTransport } from "./types";
import { defaultNvimRunner } from "./command-runner";

export class NvimInjector implements CommandInjector {
  constructor(
    private readonly transport: NvimSessionTransport,
    private readonly runner: CommandRunner = defaultNvimRunner,
  ) {}

  async inject(command: string): Promise<InjectionResult> {
    if (!this.transport.instanceName) {
      return { ok: false, error: "instanceName is required for nvim injection" };
    }

    const payload = {
      type: "send",
      name: this.transport.instanceName,
      command,
    };
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const expr = `luaeval('require("ccremote").dispatch(_A)', '${b64}')`;

    try {
      const result = await this.runner.run([
        "--server",
        this.transport.nvimSocket,
        "--remote-expr",
        expr,
      ]);

      if (result.code !== 0) {
        return {
          ok: false,
          error: result.stderr || `nvim exited with code ${result.code}`,
        };
      }

      const output = result.stdout.trim();
      if (!output) {
        return { ok: false, error: "No response from nvim injection" };
      }

      const decoded = Buffer.from(output, "base64").toString("utf8");
      const parsed = JSON.parse(decoded) as { ok?: boolean; error?: string };
      if (!parsed.ok) {
        return { ok: false, error: parsed.error || "nvim injection failed" };
      }

      return { ok: true, transport: "nvim" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
