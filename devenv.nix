{ pkgs, ... }:
{
  packages = [
    pkgs.nodejs_22
    pkgs._1password-cli
  ];

  # Load secrets from .env for local development
  dotenv.enable = true;

  scripts.dev-daemon.exec = ''
    op run --account my.1password.com --env-file=.env.1password -- \
      npm run --workspace @pigeon/daemon dev -- "$@"
  '';

  scripts.dev-worker.exec = ''
    npm run --workspace @pigeon/worker dev -- "$@"
  '';

  enterShell = ''
    echo ""
    echo "Pigeon dev environment"
    echo "  Node: $(node --version)"
    if command -v op &>/dev/null && op whoami &>/dev/null 2>&1; then
      echo "  1Password: connected"
    else
      echo "  1Password: not connected (run 'op signin' if needed)"
    fi
    echo ""
    echo "Commands:"
    echo "  npm install       - Install dependencies"
    echo "  npm run test      - Run all tests"
    echo "  npm run typecheck - Run typechecks"
    echo "  dev-daemon        - Start daemon (with 1Password secrets)"
    echo "  dev-worker        - Start worker dev server"
    echo ""
  '';
}
