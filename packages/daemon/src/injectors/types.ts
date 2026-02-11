export interface InjectionResult {
  ok: boolean;
  transport?: "nvim" | "tmux";
  error?: string;
}

export interface NvimSessionTransport {
  kind: "nvim";
  nvimSocket: string;
  instanceName: string;
  tmuxPaneId?: string | null;
  tmuxSession?: string | null;
}

export interface TmuxSessionTransport {
  kind: "tmux";
  paneId?: string | null;
  sessionName?: string | null;
}

export type SessionTransport = NvimSessionTransport | TmuxSessionTransport;

export interface CommandInjector {
  inject(command: string): Promise<InjectionResult>;
}

export interface CommandRunner {
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}
