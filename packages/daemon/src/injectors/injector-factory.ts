import type { SessionRecord } from "../storage/types";
import { NvimInjector } from "./nvim-injector";
import { TmuxInjector } from "./tmux-injector";
import type { CommandInjector, CommandRunner, InjectionResult, NvimSessionTransport, TmuxSessionTransport } from "./types";

interface InjectorFactoryOptions {
  nvimRunner?: CommandRunner;
  tmuxRunner?: CommandRunner;
}

function nvimTransport(session: SessionRecord): NvimSessionTransport | null {
  if (session.transportKind !== "nvim" || !session.nvimSocket || !session.instanceName) {
    return null;
  }

  return {
    kind: "nvim",
    nvimSocket: session.nvimSocket,
    instanceName: session.instanceName,
    tmuxPaneId: session.tmuxPaneId,
    tmuxSession: session.tmuxSession,
  };
}

function tmuxTransport(session: SessionRecord): TmuxSessionTransport | null {
  const paneId = session.tmuxPaneId ?? session.paneId;
  const sessionName = session.tmuxSession ?? session.sessionName;
  if (!paneId && !sessionName) {
    return null;
  }

  return {
    kind: "tmux",
    paneId,
    sessionName,
  };
}

export function createInjectorForSession(
  session: SessionRecord,
  options: InjectorFactoryOptions = {},
): CommandInjector | null {
  const nvim = nvimTransport(session);
  if (nvim) {
    return new NvimInjector(nvim, options.nvimRunner);
  }

  const tmux = tmuxTransport(session);
  if (tmux) {
    return new TmuxInjector(tmux, options.tmuxRunner);
  }

  return null;
}

export async function injectWithFallback(
  session: SessionRecord,
  command: string,
  options: InjectorFactoryOptions = {},
): Promise<InjectionResult> {
  const nvim = nvimTransport(session);
  if (nvim) {
    const primary = await new NvimInjector(nvim, options.nvimRunner).inject(command);
    if (primary.ok) {
      return primary;
    }

    const tmux = tmuxTransport(session);
    if (tmux) {
      return new TmuxInjector(tmux, options.tmuxRunner).inject(command);
    }

    return primary;
  }

  const tmux = tmuxTransport(session);
  if (tmux) {
    return new TmuxInjector(tmux, options.tmuxRunner).inject(command);
  }

  return {
    ok: false,
    error: `No injection method available (transport: ${session.transportKind ?? "unknown"})`,
  };
}
