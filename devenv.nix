{ pkgs, ... }:
{
  packages = [
    pkgs.bun
    pkgs.nodejs_22
    pkgs._1password-cli
  ];

  # Load secrets from .env for local development
  dotenv.enable = true;

  scripts.dev-daemon.exec = ''
    op run --account my.1password.com --env-file=.env.1password -- \
      bun run --filter '@pigeon/daemon' dev "$@"
  '';

  scripts.dev-worker.exec = ''
    bun run --filter '@pigeon/worker' dev "$@"
  '';

  enterShell = ''
    echo ""
    echo "Pigeon dev environment"
    echo "  Bun:  $(bun --version)"
    echo "  Node: $(node --version)"
    if command -v op &>/dev/null && op whoami &>/dev/null 2>&1; then
      echo "  1Password: connected"
    else
      echo "  1Password: not connected (run 'op signin' if needed)"
    fi
    echo ""
    echo "Commands:"
    echo "  bun install       - Install dependencies"
    echo "  bun run test      - Run all tests"
    echo "  bun run typecheck - Run typechecks"
    echo "  dev-daemon        - Start daemon (with 1Password secrets)"
    echo "  dev-worker        - Start worker dev server"
    echo ""
  '';
}
